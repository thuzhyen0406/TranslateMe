import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { jobKey, type JobDb } from '../../../../libs/common/jobs.js';
import { createBatchWorkflowHandler, splitBatchBlocks, splitOversizedBatchBlocks, type BatchWorkflowDeps } from '../batchWorkflow.js';
import type { Ctx } from '../../../../libs/common/types.js';

const ctx: Ctx = { tenantId: 't_batch', via: 'KEYMAP', requestId: 'batch-test', keyId: 'key-test' };
const jobId = 'job-20261108-012345abcdef';

describe('batch workflow', () => {
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

  it('parses TXT, translates lots, assembles a result, and ignores duplicate lot completion', async () => {
    const key = jobKey(ctx, jobId);
    const item: Record<string, any> = {
      ...key, entityType: 'JOB', tenantId: ctx.tenantId, jobId, type: 'FILE', status: 'QUEUED',
      targetLangs: ['fr'], total: 0, done: 0, failed: 0, warnings: [], lots: {},
      fileKey: `batch/${ctx.tenantId}/input/source.txt`, fileName: 'source.txt', format: 'txt', sourceLang: 'en',
      usageSource: { kind: 'API', keyId: 'key-test' }, sendEmail: false,
    };
    const db: JobDb = {
      async get(_ctx, lookup) { return lookup.PK === key.PK && lookup.SK === key.SK ? item : null; },
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
        if (values[':failedRemaining'] !== undefined) item.failed += Number(values[':failedRemaining']);
        if (values[':warnings'] !== undefined) item.warnings = values[':warnings'];
        if (values[':reason'] !== undefined) item.reason = values[':reason'];
        if (values[':resultFiles'] !== undefined) item.resultFiles = values[':resultFiles'];
        if (values[':at'] !== undefined) item.updatedAt = values[':at'];
        if (values[':finishedAt'] !== undefined) item.finishedAt = values[':finishedAt'];
        if (lotId && values[':true'] === true) item.lots[lotId] = true;
      },
    };
    const objects = new Map<string, Uint8Array>([[item.fileKey, new TextEncoder().encode('Hello.\nGood morning.')]]);
    const reservations: number[] = [];
    const settlements: number[] = [];
    let translateCalls = 0;
    const deps: BatchWorkflowDeps = {
      jobs: db,
      objects: {
        async get(_tenantId, objectKey) { return objects.get(objectKey) ?? null; },
        async put(_tenantId, objectKey, bytes) { objects.set(objectKey, bytes); },
        async signGet(_tenantId, objectKey) { return `https://download.example/${objectKey}`; },
      },
      usage: {
        async reserve(input: Parameters<BatchWorkflowDeps['usage']['reserve']>[0]) {
          reservations.push(input.n);
          return { tenantId: input.tenantId, requestId: input.requestId, month: '2026-11', reservedChars: input.n, limit: 1000, source: input.source, createdAt: input.now!.toISOString() };
        },
        async settle(ticket: Parameters<BatchWorkflowDeps['usage']['settle']>[0], actual: Parameters<BatchWorkflowDeps['usage']['settle']>[1]) { settlements.push(actual.machineChars); },
        async refund() {},
      } as unknown as BatchWorkflowDeps['usage'],
      tm: {
        async getTM(_ctx: Ctx, _src: string, _tgt: string, sentences: Array<{ id: number; text: string; hash: string }>) { return { hits: new Map(), misses: [...sentences], reviewFlags: [] }; },
        async markHumanNeedsReview() { return { marked: 0, skipped: 0, failed: [] }; },
        async putMachineTM() { return { written: 2, skippedHuman: 0, failed: [] }; },
      } as unknown as BatchWorkflowDeps['tm'],
      async getGlossaryState() { return { version: 0, terminologyName: null, terms: [] }; },
      async translate(input) {
        translateCalls++;
        return { translated: input.sentences.map((sentence) => ({ id: sentence.id, tgt: `FR:${sentence.text}`, needsReview: false })), pending: [], failed: [], stats: { uniqueSentences: input.sentences.length, calls: 1, charsSent: 0, splits: 0, plainFallbacks: 0 } };
      },
      async detectLanguage() { return 'en'; },
      now: () => new Date('2026-11-08T00:00:00.000Z'),
      uuid: () => 'attempt-uuid-1234',
    };
    const handler = createBatchWorkflowHandler(deps);
    const parsed = await handler({ mode: 'PARSE_AND_CHUNK', tenant_id: ctx.tenantId, job_id: jobId }) as { lot_keys: string[] };
    assert.equal(item.status, 'RUNNING');
    assert.equal(item.total, 1);
    const lotKey = parsed.lot_keys[0];
    const task = { mode: 'TRANSLATE_LOT' as const, tenant_id: ctx.tenantId, job_id: jobId, target_lang: 'fr', lot_key: lotKey };
    await handler(task);
    await handler(task);
    assert.equal(translateCalls, 1);
    assert.equal(reservations.length, 1);
    assert.equal(item.done, 1);

    const merged = await handler({ mode: 'MERGE_AND_WRITE', tenant_id: ctx.tenantId, job_id: jobId }) as { status: string };
    assert.equal(merged.status, 'SUCCEEDED');
    assert.equal(item.status, 'SUCCEEDED');
    assert.equal(item.done, item.total);
    assert.equal(settlements.length, 1);
    const result = objects.get(`batch/${ctx.tenantId}/results/${jobId}/source.fr.txt`)!;
    assert.equal(new TextDecoder().decode(result), 'FR:Hello.\nFR:Good morning.');

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
});
