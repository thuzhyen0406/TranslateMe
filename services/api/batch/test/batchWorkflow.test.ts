import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDocxPackage } from '../../../../libs/common/docx.js';
import { validateMarkers } from '../../../../libs/common/markers.js';
import { parse } from '../../../../libs/common/parsers.js';
import { jobKey, type JobDb } from '../../../../libs/common/jobs.js';
import { createBatchWorkflowHandler, failedExecutionTask, splitBatchBlocks, splitOversizedBatchBlocks, type BatchWorkflowDeps } from '../batchWorkflow.js';
import type { Ctx } from '../../../../libs/common/types.js';

const ctx: Ctx = { tenantId: 't_batch', via: 'KEYMAP', requestId: 'batch-test', keyId: 'key-test' };
const jobId = 'job-20261108-012345abcdef';

describe('batch workflow', () => {
  it('stores lots in S3 and emits bounded state for a document that exceeded the old Step Functions limit', async () => {
    const text = 'Hello world.\n'.repeat(100_000);
    const objects = new Map<string, Uint8Array>();
    let total = 0;
    const source = `batch/${ctx.tenantId}/input/source.txt`;
    const run = createBatchWorkflowHandler({
      jobs: {
        async get() {
          return { entityType: 'JOB', type: 'FILE', tenantId: ctx.tenantId, fileKey: source,
            fileVersionId: 'validated-version', format: 'txt', fileName: 'source.txt', targetLangs: ['fr', 'vi'] };
        },
        async update(_ctx, input) { total = Number(input.ExpressionAttributeValues?.[':total']); },
        async put() {},
      },
      objects: {
        async get(_tenant, key, versionId) {
          assert.equal(key, source);
          assert.equal(versionId, 'validated-version');
          return Buffer.from(text);
        },
        async put(_tenant, key, bytes) { objects.set(key, bytes); },
        async signGet() { throw new Error('Unexpected output'); },
      },
      usage: {} as BatchWorkflowDeps['usage'],
      tm: {} as BatchWorkflowDeps['tm'],
      async getGlossaryState() { throw new Error('Unexpected translation'); },
      async translate() { throw new Error('Unexpected translation'); },
      async detectLanguage() { throw new Error('Unexpected translation'); },
    });
    const input = { mode: 'PARSE_AND_CHUNK' as const, tenant_id: ctx.tenantId, job_id: jobId };
    await assert.rejects(run(input), { name: 'LegacyBatchWorkflowLimit' });
    const output = await run({ ...input, distributed: true }) as { lot_index_key: string; lot_count: number };
    assert.ok(Buffer.byteLength(JSON.stringify(output)) < 1_024);
    assert.ok(!('lot_keys' in output));
    const items = JSON.parse(Buffer.from(objects.get(output.lot_index_key)!).toString('utf8')) as Array<{ key: string }>;
    assert.equal(items.length, Math.ceil(100_000 / 256));
    assert.equal(items.length, output.lot_count);
    assert.equal(total, items.length * 2);
    assert.ok(items.every(({ key }) => objects.has(key)));
  });

  it('maps only terminal parent executions to a job reconciliation task', () => {
    const event = {
      source: 'aws.states' as const,
      'detail-type': 'Step Functions Execution Status Change' as const,
      detail: { status: 'TIMED_OUT', executionArn: `arn:aws:states:region:account:execution:batch:${jobId}`,
        input: JSON.stringify({ job_id: jobId, tenant_id: ctx.tenantId }) },
    };
    assert.deepEqual(failedExecutionTask(event), {
      mode: 'MARK_FAILED', job_id: jobId, tenant_id: ctx.tenantId, error: { Error: 'WORKFLOW_TIMED_OUT' },
    });
    assert.equal(failedExecutionTask({ ...event, detail: { ...event.detail, status: 'RUNNING' } }), null);
    assert.equal(failedExecutionTask({ ...event, detail: { ...event.detail, executionArn: 'child-run' } }), null);
  });

  it('splits at the byte and lot limits without splitting blocks', () => {
    const blocks = [
      { id: 0, text: 'a'.repeat(6) },
      { id: 1, text: '😀'.repeat(2) },
      { id: 2, text: 'b'.repeat(5) },
    ];
    assert.deepEqual(splitBatchBlocks(blocks, { maxBytes: 10, lotBlocks: 20 }), [blocks]);
    assert.deepEqual(splitBatchBlocks(blocks, { maxBytes: 100, lotBlocks: 2 }), [blocks.slice(0, 2), blocks.slice(2)]);
    assert.throws(() => splitBatchBlocks([{ id: 0, text: '😀'.repeat(3) }], { maxBytes: 10 }), { name: 'BlockTooLarge' });
  });

  it('splits oversized UTF-8 blocks safely while preserving their reconstruction order', () => {
    const text = 'xin chào 🌏 '.repeat(4);
    const pieces = splitOversizedBatchBlocks([{ id: 7, text }], 10);
    assert.ok(pieces.length > 1);
    assert.ok(pieces.every((piece) => Buffer.byteLength(piece.text, 'utf8') <= 10));
    assert.equal(pieces.map((piece) => piece.text).join(''), text);
    assert.ok(pieces.every((piece) => piece.sourceId === 7));
    assert.deepEqual(pieces.map((piece) => piece.partIndex), pieces.map((_, i) => i));
  });

  const longPhrase = 'good morning '.repeat(1_300).trimEnd();
  const batchFiles = [
    {
      format: 'TXT',
      extension: 'txt',
      input: Buffer.from('Hello.\n' + longPhrase + '.'),
      verify(result: Uint8Array) {
        assert.equal(new TextDecoder().decode(result), 'HELLO.\n' + longPhrase.toUpperCase() + '.');
      },
    },
    {
      format: 'HTML',
      extension: 'html',
      input: Buffer.from('<p>See <strong>' + longPhrase + '</strong> <span translate="no">Keep Case</span> today.</p>'),
      verify(result: Uint8Array) {
        assert.ok(new TextDecoder().decode(result).includes(
          '<p>SEE <strong>' + longPhrase.toUpperCase() + '</strong> <span translate="no">Keep Case</span> TODAY.</p>',
        ));
      },
    },
    {
      format: 'DOCX',
      extension: 'docx',
      input: createDocxPackage({
        'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p>' +
          '<w:r><w:t xml:space="preserve">See </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>' + longPhrase + '</w:t></w:r>' +
          '<w:r><w:t xml:space="preserve"> today.</w:t></w:r></w:p></w:body></w:document>',
      }),
      verify(result: Uint8Array) {
        const doc = parse('DOCX', result);
        assert.deepEqual(doc.blocks.map(({ text }) => text), ['{1}SEE {/1}' + longPhrase.toUpperCase() + '{2} TODAY.{/2}']);
      },
    },
  ] as const;

  for (const fixture of batchFiles) it(`translates oversized ${fixture.format} with spacing and markers, and ignores duplicate lot completion`, async () => {
    const key = jobKey(ctx, jobId);
    const item: Record<string, any> = {
      ...key, entityType: 'JOB', tenantId: ctx.tenantId, jobId, type: 'FILE', status: 'QUEUED',
      targetLangs: ['fr'], total: 0, done: 0, failed: 0, warnings: [], lots: {},
      fileKey: `batch/${ctx.tenantId}/input/source.${fixture.extension}`, fileName: `source.${fixture.extension}`, format: fixture.extension, sourceLang: 'en',
      usageSource: { kind: 'API', keyId: 'key-test' }, sendEmail: false,
    };
    const markers = new Map<string, Record<string, unknown>>();
    const db: BatchWorkflowDeps['jobs'] = {
      async get(_ctx, lookup) {
        if (lookup.PK !== key.PK) return null;
        return lookup.SK === key.SK ? item : markers.get(lookup.SK) ?? null;
      },
      async transact(_ctx, operations) {
        const [marker, progress] = operations;
        const entry = marker.Put.Item as { PK: string; SK: string; ttl: number };
        assert.equal(entry.PK, key.PK);
        assert.match(entry.SK, /^LOT#/);
        assert.ok(entry.ttl > 0);
        assert.equal(progress.Update.ConditionExpression, '#status = :running');
        if (markers.has(entry.SK)) throw Object.assign(new Error('Duplicate lot'), { name: 'TransactionCanceledException' });
        markers.set(entry.SK, entry);
        item.done += Number(progress.Update.ExpressionAttributeValues[':one']);
      },
      async put(_ctx, value) { Object.assign(item, value); },
      async update(_ctx, update) {
        const values = update.ExpressionAttributeValues ?? {};
        const lotId = update.ExpressionAttributeNames?.['#lot'];
        if (lotId && update.ConditionExpression?.includes('attribute_not_exists(#lots.#lot)') && item.lots[lotId] === true) {
          throw Object.assign(new Error('Conditional check failed'), { name: 'ConditionalCheckFailedException' });
        }
        if (values[':total'] !== undefined) item.total = values[':total'];
        if (values[':status'] !== undefined) item.status = values[':status'];
        if (values[':running'] !== undefined && update.UpdateExpression.includes('#status = :running')) item.status = values[':running'];
        if (values[':done'] !== undefined) item.done += Number(values[':done']);
        if (values[':failed'] !== undefined) item.failed += Number(values[':failed']);
        if (update.UpdateExpression.includes('#failed = #total - #done')) item.failed = item.total - item.done;
        if (values[':warnings'] !== undefined) item.warnings = values[':warnings'];
        if (values[':reason'] !== undefined) item.reason = values[':reason'];
        if (values[':resultFiles'] !== undefined) item.resultFiles = values[':resultFiles'];
        if (values[':notificationStatus'] !== undefined) item.notificationStatus = values[':notificationStatus'];
        if (values[':notificationError'] !== undefined) item.notificationError = values[':notificationError'];
        if (values[':at'] !== undefined) item.updatedAt = values[':at'];
        if (values[':finishedAt'] !== undefined) item.finishedAt = values[':finishedAt'];
        if (lotId && values[':true'] === true) item.lots[lotId] = true;
      },
    };
    const objects = new Map<string, Uint8Array>([[item.fileKey, fixture.input]]);
    const reservations: number[] = [];
    const settlements: number[] = [];
    const settledRequests = new Map<string, string>();
    let refunds = 0;
    let failOutputWrite = true;
    let translateCalls = 0;
    const deps: BatchWorkflowDeps = {
      jobs: db,
      objects: {
        async get(_tenantId, objectKey) { return objects.get(objectKey) ?? null; },
        async put(_tenantId, objectKey, bytes) {
          if (objectKey.includes('/translated/') && failOutputWrite) {
            failOutputWrite = false;
            throw new Error('Temporary S3 result write failure');
          }
          objects.set(objectKey, bytes);
        },
        async signGet(_tenantId, objectKey) { return `https://download.example/${objectKey}`; },
      },
      usage: {
        async reserve(input: Parameters<BatchWorkflowDeps['usage']['reserve']>[0]) {
          reservations.push(input.n);
          return { tenantId: input.tenantId, requestId: input.requestId, month: '2026-11', reservedChars: input.n, limit: 1000, source: input.source, createdAt: input.now!.toISOString() };
        },
        async settle(ticket: Parameters<BatchWorkflowDeps['usage']['settle']>[0], actual: Parameters<BatchWorkflowDeps['usage']['settle']>[1]) {
          const serialized = JSON.stringify(actual);
          const prior = settledRequests.get(ticket.requestId);
          if (prior) {
            assert.equal(prior, serialized);
            return;
          }
          settledRequests.set(ticket.requestId, serialized);
          settlements.push(actual.machineChars);
        },
        async refund() { refunds++; },
      } as unknown as BatchWorkflowDeps['usage'],
      tm: {
        async getTM(_ctx: Ctx, _src: string, _tgt: string, sentences: Array<{ id: number; text: string; hash: string }>) { return { hits: new Map(), misses: [...sentences], reviewFlags: [] }; },
        async markHumanNeedsReview() { return { marked: 0, skipped: 0, failed: [] }; },
        async putMachineTM() { return { written: 2, skippedHuman: 0, failed: [] }; },
      } as unknown as BatchWorkflowDeps['tm'],
      async getGlossaryState() { return { version: 0, terminologyName: null, terms: [] }; },
      async translate(input) {
        translateCalls++;
        assert.ok(input.sentences.every(({ text }) => validateMarkers(text).ok));
        return { translated: input.sentences.map((sentence) => ({ id: sentence.id, tgt: sentence.text.trim().toUpperCase(), needsReview: false })), pending: [], failed: [], stats: { uniqueSentences: input.sentences.length, calls: 1, charsSent: 0, splits: 0, plainFallbacks: 0 } };
      },
      async detectLanguage() { return { language: 'en', confidence: 0.99 }; },
      now: () => new Date('2026-11-08T00:00:00.000Z'),
    };
    const handler = createBatchWorkflowHandler(deps);
    const parsed = await handler({ mode: 'PARSE_AND_CHUNK', tenant_id: ctx.tenantId, job_id: jobId, distributed: true }) as { lot_index_key: string };
    assert.equal(item.status, 'RUNNING');
    assert.equal(item.total, 1);
    const [{ key: lotKey }] = JSON.parse(new TextDecoder().decode(objects.get(parsed.lot_index_key)!));
    const task = { mode: 'TRANSLATE_LOT' as const, tenant_id: ctx.tenantId, job_id: jobId, target_lang: 'fr', lot_key: lotKey, distributed: true };
    await assert.rejects(handler({ ...task, attempt: 0 }), /Temporary S3 result write failure/u);
    assert.equal(settlements.length, 0);
    await handler({ ...task, attempt: 1 });
    await handler({ ...task, attempt: 1 });
    assert.equal(translateCalls, 2);
    assert.equal(reservations.length, 2);
    assert.equal(refunds, 1);
    assert.equal(item.done, 1);
    assert.equal(markers.size, 1);
    assert.deepEqual(item.lots, {});

    const merged = await handler({ mode: 'MERGE_AND_WRITE', tenant_id: ctx.tenantId, job_id: jobId, distributed: true }) as { status: string };
    assert.equal(merged.status, 'SUCCEEDED');
    assert.equal(item.status, 'SUCCEEDED');
    assert.equal(item.done, item.total);
    assert.equal(settlements.length, 1);
    const result = objects.get(`batch/${ctx.tenantId}/results/${jobId}/source.fr.${fixture.extension}`)!;
    fixture.verify(result);

    item.status = 'RUNNING';
    item.total = 3;
    item.done = 1;
    item.failed = 0;
    const failedTask = { mode: 'MARK_FAILED' as const, tenant_id: ctx.tenantId, job_id: jobId, error: { Error: 'BatchTranslationIncomplete' } };
    const failed = await handler(failedTask) as { status: string; reason: string };
    await handler(failedTask);
    assert.equal(failed.status, 'FAILED');
    assert.equal(failed.reason, 'BatchTranslationIncomplete');
    assert.equal(item.failed, 2);
    assert.equal(item.status, 'FAILED');
  });

  it('replays a persisted lot checkpoint after settlement fails without translating or settling twice', async () => {
    const retryJobId = 'job-20261108-abcdef012345';
    const key = jobKey(ctx, retryJobId);
    const lotKey = `batch/${ctx.tenantId}/results/${retryJobId}/lots/lot-0000.json`;
    const outputKey = `batch/${ctx.tenantId}/results/${retryJobId}/translated/fr/lot-0000.json`;
    const item: Record<string, any> = {
      ...key, entityType: 'JOB', tenantId: ctx.tenantId, jobId: retryJobId, type: 'FILE', status: 'RUNNING',
      targetLangs: ['fr'], total: 1, done: 0, failed: 0, warnings: [], lots: {},
      fileKey: `batch/${ctx.tenantId}/input/source.txt`, fileName: 'source.txt', format: 'txt', sourceLang: 'en',
      usageSource: { kind: 'API', keyId: 'key-test' }, sendEmail: false,
    };
    const objects = new Map<string, Uint8Array>([
      [lotKey, new TextEncoder().encode(JSON.stringify([{ id: 0, text: 'Hello.' }]))],
    ]);
    const reservations: string[] = [];
    const settledRequests = new Map<string, string>();
    let settleCalls = 0;
    let translateCalls = 0;
    const db: JobDb = {
      async get(_ctx, lookup) { return lookup.PK === key.PK && lookup.SK === key.SK ? item : null; },
      async put(_ctx, value) { Object.assign(item, value); },
      async update(_ctx, update) {
        const values = update.ExpressionAttributeValues ?? {};
        const lotId = update.ExpressionAttributeNames?.['#lot'];
        if (lotId && item.lots[lotId] === true) {
          throw Object.assign(new Error('Conditional check failed'), { name: 'ConditionalCheckFailedException' });
        }
        if (values[':done'] !== undefined) item.done += Number(values[':done']);
        if (values[':failed'] !== undefined) item.failed += Number(values[':failed']);
        if (lotId && values[':true'] === true) item.lots[lotId] = true;
      },
    };
    const deps: BatchWorkflowDeps = {
      jobs: db,
      objects: {
        async get(_tenantId, objectKey) { return objects.get(objectKey) ?? null; },
        async put(_tenantId, objectKey, bytes) { objects.set(objectKey, bytes); },
        async signGet() { return 'https://download.example'; },
      },
      usage: {
        async reserve(input: Parameters<BatchWorkflowDeps['usage']['reserve']>[0]) {
          reservations.push(input.requestId);
          return { tenantId: input.tenantId, requestId: input.requestId, month: '2026-11', reservedChars: input.n, limit: 1000, source: input.source, createdAt: input.now!.toISOString() };
        },
        async settle(
          ticket: Parameters<BatchWorkflowDeps['usage']['settle']>[0],
          actual: Parameters<BatchWorkflowDeps['usage']['settle']>[1],
        ) {
          settleCalls++;
          const serialized = JSON.stringify(actual);
          const prior = settledRequests.get(ticket.requestId);
          if (prior) {
            assert.equal(prior, serialized);
            return;
          }
          if (settleCalls === 1) throw new Error('Temporary usage settlement failure');
          settledRequests.set(ticket.requestId, serialized);
        },
        async refund() { assert.fail('A persisted checkpoint must not be refunded'); },
      } as unknown as BatchWorkflowDeps['usage'],
      tm: {
        async getTM(_ctx: Ctx, _src: string, _tgt: string, sentences: Array<{ id: number; text: string; hash: string }>) {
          return { hits: new Map(), misses: [...sentences], reviewFlags: [] };
        },
        async markHumanNeedsReview() { return { marked: 0, skipped: 0, failed: [] }; },
        async putMachineTM() { return { written: 1, skippedHuman: 0, failed: [] }; },
      } as unknown as BatchWorkflowDeps['tm'],
      async getGlossaryState() { return { version: 0, terminologyName: null, terms: [] }; },
      async translate(input) {
        translateCalls++;
        return { translated: input.sentences.map((sentence) => ({ id: sentence.id, tgt: `FR:${sentence.text}`, needsReview: false })), pending: [], failed: [], stats: { uniqueSentences: input.sentences.length, calls: 1, charsSent: 0, splits: 0, plainFallbacks: 0 } };
      },
      async detectLanguage() { return { language: 'en', confidence: 0.99 }; },
      now: () => new Date('2026-11-08T00:00:00.000Z'),
    };
    const handler = createBatchWorkflowHandler(deps);
    const task = { mode: 'TRANSLATE_LOT' as const, tenant_id: ctx.tenantId, job_id: retryJobId, target_lang: 'fr', lot_key: lotKey };

    await assert.rejects(handler(task), /Temporary usage settlement failure/u);
    assert.ok(objects.has(outputKey));
    await handler(task);

    assert.equal(translateCalls, 1);
    assert.equal(reservations.length, 1);
    assert.equal(settleCalls, 2);
    assert.equal(settledRequests.size, 1);
    assert.equal(item.done, 1);
  });

  it('requires at least 0.70 confidence when detecting the source language', async () => {
    const detectedJobId = 'job-20261108-123456abcdef';
    const key = jobKey(ctx, detectedJobId);
    const lotKey = `batch/${ctx.tenantId}/results/${detectedJobId}/lots/lot-0000.json`;
    const item: Record<string, any> = {
      ...key, entityType: 'JOB', tenantId: ctx.tenantId, jobId: detectedJobId, type: 'FILE', status: 'RUNNING',
      targetLangs: ['fr'], total: 1, done: 0, failed: 0, warnings: [], lots: {},
      fileKey: `batch/${ctx.tenantId}/input/source.txt`, fileName: 'source.txt', format: 'txt',
      usageSource: { kind: 'API', keyId: 'key-test' }, sendEmail: false,
    };
    const objects = new Map<string, Uint8Array>([[lotKey, new TextEncoder().encode(JSON.stringify([{ id: 0, text: 'Hello.' }]))]]);
    const db: JobDb = {
      async get(_ctx, lookup) { return lookup.PK === key.PK && lookup.SK === key.SK ? item : null; },
      async put(_ctx, value) { Object.assign(item, value); },
      async update(_ctx, update) {
        const values = update.ExpressionAttributeValues ?? {};
        if (values[':done'] !== undefined) item.done += Number(values[':done']);
        if (values[':failed'] !== undefined) item.failed += Number(values[':failed']);
        if (values[':true'] === true) item.lots[update.ExpressionAttributeNames?.['#lot'] ?? ''] = true;
      },
    };
    const createHandler = (confidence: number) => createBatchWorkflowHandler({
      jobs: db,
      objects: {
        async get(_tenantId, objectKey) { return objects.get(objectKey) ?? null; },
        async put(_tenantId, objectKey, bytes) { objects.set(objectKey, bytes); },
        async signGet() { return 'https://download.example'; },
      },
      usage: {
        async reserve(input: Parameters<BatchWorkflowDeps['usage']['reserve']>[0]) {
          return { tenantId: input.tenantId, requestId: input.requestId, month: '2026-11', reservedChars: input.n, limit: 1000, source: input.source, createdAt: input.now!.toISOString() };
        },
        async settle() {},
        async refund() {},
      } as unknown as BatchWorkflowDeps['usage'],
      tm: {
        async getTM(_ctx: Ctx, _src: string, _tgt: string, sentences: Array<{ id: number; text: string; hash: string }>) { return { hits: new Map(), misses: sentences, reviewFlags: [] }; },
        async markHumanNeedsReview() { return { marked: 0, skipped: 0, failed: [] }; },
        async putMachineTM() { return { written: 0, skippedHuman: 0, failed: [] }; },
      } as unknown as BatchWorkflowDeps['tm'],
      async getGlossaryState() { return { version: 0, terminologyName: null, terms: [] }; },
      async translate() { return { translated: [{ id: 0, tgt: 'Bonjour.', needsReview: false }], pending: [], failed: [], stats: { uniqueSentences: 1, calls: 1, charsSent: 6, splits: 0, plainFallbacks: 0 } }; },
      async detectLanguage() { return { language: 'en', confidence }; },
      now: () => new Date('2026-11-08T00:00:00.000Z'),
    });
    const task = { mode: 'TRANSLATE_LOT' as const, tenant_id: ctx.tenantId, job_id: detectedJobId, target_lang: 'fr', lot_key: lotKey };

    await assert.rejects(createHandler(0.69)(task), { name: 'LanguageNotDetected' });
    const result = await createHandler(0.70)(task) as { result_key: string };
    assert.equal(result.result_key, `batch/${ctx.tenantId}/results/${detectedJobId}/translated/fr/lot-0000.json`);
  });

  it('records notification failures without overwriting the job status', async () => {
    const key = jobKey(ctx, 'job-20261108-abcdef012345');
    const item: Record<string, any> = {
      ...key, entityType: 'JOB', tenantId: ctx.tenantId, jobId: 'job-20261108-abcdef012345', type: 'FILE', status: 'SUCCEEDED',
      targetLangs: ['fr'], total: 1, done: 1, failed: 0, warnings: [], lots: {},
      fileKey: 'batch/t_batch/input/source.txt', fileName: 'source.txt', format: 'txt', sourceLang: 'en',
      usageSource: { kind: 'API', keyId: 'key-test' }, sendEmail: true, notificationEmail: 'owner@example.com',
    };
    const db: JobDb = {
      async get(_ctx, lookup) { return lookup.PK === key.PK && lookup.SK === key.SK ? item : null; },
      async put(_ctx, value) { Object.assign(item, value); },
      async update(_ctx, update) {
        const values = update.ExpressionAttributeValues ?? {};
        if (values[':notificationStatus'] !== undefined) item.notificationStatus = values[':notificationStatus'];
        if (values[':notificationError'] !== undefined) item.notificationError = values[':notificationError'];
        if (values[':warnings'] !== undefined) item.warnings = values[':warnings'];
        if (values[':at'] !== undefined) item.updatedAt = values[':at'];
      },
    };
    const deps: BatchWorkflowDeps = {
      jobs: db,
      objects: {
        async get() { return null; },
        async put() {},
        async signGet() { return 'https://download.example'; },
      },
      usage: {
        async reserve() { throw new Error('unused'); },
        async settle() {},
        async refund() {},
      } as any,
      tm: {} as any,
      getGlossaryState: async () => ({ version: 0, terminologyName: null, terms: [] }),
      translate: async () => ({ translated: [], pending: [], failed: [], stats: { uniqueSentences: 0, calls: 0, charsSent: 0, splits: 0, plainFallbacks: 0 } }),
      detectLanguage: async () => ({ language: 'en', confidence: 0.99 }),
      now: () => new Date('2026-11-08T00:00:00.000Z'),
    };
    const handler = createBatchWorkflowHandler(deps);
    const result = await handler({
      mode: 'SET_NOTIFICATION_STATUS',
      tenant_id: ctx.tenantId,
      job_id: 'job-20261108-abcdef012345',
      notification_status: 'FAILED',
      notification_error: { Error: 'SubscriptionFailed', Cause: 'EMAIL_NOT_CONFIRMED' },
    }) as { notification_status?: string };
    assert.equal(result.notification_status, 'FAILED');
    assert.equal(item.status, 'SUCCEEDED');
    assert.equal(item.notificationStatus, 'FAILED');
    assert.equal(item.notificationError, 'EMAIL_NOT_CONFIRMED');
    assert.equal(item.warnings.at(-1).code, 'NOTIFICATION_FAILED');
  });
});
