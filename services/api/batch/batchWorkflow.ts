/** Batch state machine tasks (F10): parse to bounded lots, translate idempotently and assemble results. */
import { randomUUID } from 'node:crypto';
import { ComprehendClient, DetectDominantLanguageCommand } from '@aws-sdk/client-comprehend';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { TranslateClient } from '@aws-sdk/client-translate';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createTenantDocumentClientRouter, createTenantS3Client } from '../../../libs/common/tenantAws.js';
import { createDynamoGlossaryReader, postCheckGlossary, type GlossaryState } from '../../../libs/common/glossary.js';
import { createJobStore, JOB_ID_RE, jobKey, type JobDb, type JobWarning } from '../../../libs/common/jobs.js';
import { countChars, parse, rebuild, translatedFileName, type DocFormat } from '../../../libs/common/parsers.js';
import { normalize_hash } from '../../../libs/common/text-utils.js';
import { createDynamoTmDb, createTM, type SentenceWithHash } from '../../../libs/common/tm.js';
import type { Ctx } from '../../../libs/common/types.js';
import { UsageService, type UsageReservation, type UsageSource } from '../../../libs/common/usage/usage.js';
import { createTranslator } from '../../../libs/common/translator.js';

export const BATCH_BLOCK_BYTES = 10_000;
export const BATCH_LOT_BLOCKS = 20;
export const BATCH_RETRY_LIMIT = 3;

export interface BatchBlock { id: number; text: string; sourceId?: number; partIndex?: number }
export interface BatchManifest {
  format: DocFormat;
  fileName: string;
  skeleton: unknown;
  warnings: JobWarning[];
  lots: string[];
  targetLangs: string[];
}
export interface BatchTaskEvent {
  mode: 'PARSE_AND_CHUNK' | 'TRANSLATE_LOT' | 'MERGE_AND_WRITE' | 'MARK_FAILED';
  tenant_id: string;
  job_id: string;
  lot_key?: string;
  target_lang?: string;
  attempt?: number;
  error?: { Error?: string; Cause?: string };
}
export interface BatchWorkflowDeps {
  jobs: JobDb;
  objects: {
    get(tenantId: string, key: string): Promise<Uint8Array | null>;
    put(tenantId: string, key: string, bytes: Uint8Array, contentType: string): Promise<void>;
    signGet(tenantId: string, key: string, expiresIn: number): Promise<string>;
  };
  usage: Pick<UsageService, 'reserve' | 'settle' | 'refund'>;
  tm: ReturnType<typeof createTM>;
  getGlossaryState(ctx: Ctx): Promise<GlossaryState>;
  translate: (input: Parameters<ReturnType<typeof createTranslator>>[0]) => ReturnType<ReturnType<typeof createTranslator>>;
  detectLanguage(text: string): Promise<string | undefined>;
  now?: () => Date;
  uuid?: () => string;
}

const ctxOf = (tenantId: string, jobId: string): Ctx => ({ tenantId, via: 'KEYMAP', requestId: `batch-${jobId}` });
const prefixOf = (tenantId: string, jobId: string) => `batch/${tenantId}/results/${jobId}/`;
const manifestKey = (tenantId: string, jobId: string) => `${prefixOf(tenantId, jobId)}manifest.json`;
const lotKey = (tenantId: string, jobId: string, lotNo: number) => `${prefixOf(tenantId, jobId)}lots/lot-${String(lotNo).padStart(4, '0')}.json`;
const lotResultKey = (tenantId: string, jobId: string, lang: string, lotNo: number) => `${prefixOf(tenantId, jobId)}translated/${lang}/lot-${String(lotNo).padStart(4, '0')}.json`;
const resultKey = (tenantId: string, jobId: string, name: string) => `${prefixOf(tenantId, jobId)}${name}`;
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const jsonValue = <T>(bytes: Uint8Array): T => JSON.parse(new TextDecoder().decode(bytes)) as T;

export function splitBatchBlocks(blocks: readonly BatchBlock[], options: { maxBytes?: number; lotBlocks?: number } = {}): BatchBlock[][] {
  const maxBytes = options.maxBytes ?? BATCH_BLOCK_BYTES;
  const lotBlocks = options.lotBlocks ?? BATCH_LOT_BLOCKS;
  const lots: BatchBlock[][] = [];
  let current: BatchBlock[] = [];
  for (const block of blocks) {
    const bytes = Buffer.byteLength(block.text, 'utf8');
    if (!Number.isSafeInteger(block.id) || block.id < 0 || typeof block.text !== 'string') throw new TypeError('Invalid batch block.');
    if (bytes > maxBytes) throw Object.assign(new Error(`Block ${block.id} exceeds ${maxBytes} UTF-8 bytes.`), { name: 'BlockTooLarge' });
    if (current.length >= lotBlocks) {
      lots.push(current);
      current = [];
    }
    current.push(block);
  }
  if (current.length) lots.push(current);
  return lots;
}

/** Keep parser sentence ids so pieces can be reassembled before rebuilding the document. */
export function splitOversizedBatchBlocks(blocks: readonly BatchBlock[], maxBytes = BATCH_BLOCK_BYTES): BatchBlock[] {
  const expanded: BatchBlock[] = [];
  let nextId = 0;
  for (const block of blocks) {
    if (Buffer.byteLength(block.text, 'utf8') <= maxBytes) {
      expanded.push({ id: nextId++, text: block.text, sourceId: block.id, partIndex: 0 });
      continue;
    }
    const tokens = block.text.match(/\{\/?\d+\}|\{\{|\}\}|[^{}]|\{[^{}]*\}/gu) ?? [];
    const pieces: string[] = [];
    let current = '';
    for (const token of tokens) {
      if (Buffer.byteLength(token, 'utf8') > maxBytes) {
        for (const point of Array.from(token)) {
          if (Buffer.byteLength(current + point, 'utf8') > maxBytes) { pieces.push(current); current = ''; }
          current += point;
        }
      } else if (Buffer.byteLength(current + token, 'utf8') > maxBytes) {
        pieces.push(current);
        current = token;
      } else current += token;
    }
    if (current) pieces.push(current);
    if (pieces.some((piece) => !piece || Buffer.byteLength(piece, 'utf8') > maxBytes) || pieces.join('') !== block.text) {
      throw Object.assign(new Error(`Block ${block.id} could not be safely split.`), { name: 'BlockTooLarge' });
    }
    pieces.forEach((text, partIndex) => expanded.push({ id: nextId++, text, sourceId: block.id, partIndex }));
  }
  return expanded;
}

function assertTaskEvent(event: BatchTaskEvent): void {
  if (!event || !event.tenant_id || event.tenant_id === 'PLATFORM' || !JOB_ID_RE.test(event.job_id)) {
    throw Object.assign(new Error('Invalid batch task identity.'), { name: 'InvalidEvent' });
  }
}

export function createBatchWorkflowHandler(deps: BatchWorkflowDeps) {
  const now = deps.now ?? (() => new Date());
  const random = deps.uuid ?? randomUUID;
  const jobs = createJobStore(deps.jobs, () => now().getTime());

  async function loadJob(ctx: Ctx, jobId: string): Promise<Record<string, any>> {
    const item = await deps.jobs.get(ctx, jobKey(ctx, jobId), { consistent: true });
    if (!item || item.entityType !== 'JOB' || item.type !== 'FILE' || item.tenantId !== ctx.tenantId) {
      throw Object.assign(new Error('Batch job not found.'), { name: 'JobNotFound' });
    }
    return item;
  }

  async function parseAndChunk(event: BatchTaskEvent) {
    const ctx = ctxOf(event.tenant_id, event.job_id);
    const job = await loadJob(ctx, event.job_id);
    const fileKey = job.fileKey;
    const fileFormat = job.format;
    if (typeof fileKey !== 'string' || !['txt', 'html', 'docx'].includes(String(fileFormat))) throw Object.assign(new Error('Invalid job file metadata.'), { name: 'InvalidJob' });
    const bytes = await deps.objects.get(ctx.tenantId, fileKey);
    if (!bytes) throw Object.assign(new Error('Uploaded batch file is missing.'), { name: 'FileNotFound' });
    const parsed = parse(String(fileFormat).toUpperCase(), bytes);
    const blocks = splitOversizedBatchBlocks(parsed.blocks);
    const grouped = splitBatchBlocks(blocks);
    const lots: string[] = [];
    for (let i = 0; i < grouped.length; i++) {
      const key = lotKey(ctx.tenantId, event.job_id, i);
      await deps.objects.put(ctx.tenantId, key, jsonBytes(grouped[i]), 'application/json');
      lots.push(key);
    }
    const manifest: BatchManifest = {
      format: String(fileFormat).toUpperCase() as DocFormat,
      fileName: String(job.fileName),
      skeleton: parsed.skeleton,
      warnings: parsed.warnings,
      lots,
      targetLangs: Array.isArray(job.targetLangs) ? job.targetLangs.map(String) : [],
    };
    await deps.objects.put(ctx.tenantId, manifestKey(ctx.tenantId, event.job_id), jsonBytes(manifest), 'application/json');
    await jobs.markRunning(ctx, event.job_id, lots.length * manifest.targetLangs.length, { warnings: parsed.warnings });
    return { job_id: event.job_id, tenant_id: ctx.tenantId, manifest_key: manifestKey(ctx.tenantId, event.job_id), lot_keys: lots, target_langs: manifest.targetLangs, send_email: job.sendEmail === true, notification_email: job.notificationEmail };
  }

  async function translateLot(event: BatchTaskEvent) {
    const ctx = ctxOf(event.tenant_id, event.job_id);
    const job = await loadJob(ctx, event.job_id);
    if (typeof event.lot_key !== 'string' || !event.lot_key.startsWith(`${prefixOf(ctx.tenantId, event.job_id)}lots/`) || typeof event.target_lang !== 'string') {
      throw Object.assign(new Error('Invalid batch lot key or language.'), { name: 'InvalidEvent' });
    }
    const matched = /\/lot-(\d{4})\.json$/u.exec(event.lot_key);
    if (!matched) throw Object.assign(new Error('Invalid batch lot identifier.'), { name: 'InvalidEvent' });
    const lotNo = Number(matched[1]);
    const outputKey = lotResultKey(ctx.tenantId, event.job_id, event.target_lang, lotNo);
    const previousOutput = await deps.objects.get(ctx.tenantId, outputKey);
    const progressId = `lot_${String(lotNo).padStart(4, '0')}_${event.target_lang}`;
    if (previousOutput) {
      const result = jsonValue<{ translations: Record<string, string>; machineChars: number; memoryChars: number; warnings: JobWarning[] }>(previousOutput);
      await jobs.addProgress(ctx, event.job_id, 1, 0, progressId);
      return { lot_key: event.lot_key, target_lang: event.target_lang, result_key: outputKey };
    }
    const blocks = jsonValue<BatchBlock[]>(await deps.objects.get(ctx.tenantId, event.lot_key) ?? new Uint8Array());
    const file = job;
    const source = job.usageSource as UsageSource | undefined;
    if (!source) throw Object.assign(new Error('Job is missing usage source.'), { name: 'InvalidJob' });
    const sourceLang = typeof file.sourceLang === 'string' ? file.sourceLang : await deps.detectLanguage(blocks.map((b) => b.text).join('\n').slice(0, 5000));
    if (!sourceLang) throw Object.assign(new Error('Source language could not be detected.'), { name: 'LanguageNotDetected' });
    const glossary = await deps.getGlossaryState(ctx);
    const sentences: SentenceWithHash[] = blocks.map(({ id, text }) => {
      const normalized = normalize_hash(text);
      return { id, text: normalized.normalizedText, hash: normalized.hash };
    });
    const lookup = await deps.tm.getTM(ctx, sourceLang, event.target_lang, sentences, glossary);
    if (lookup.reviewFlags.length) {
      await deps.tm.markHumanNeedsReview(ctx, sourceLang, event.target_lang, lookup.reviewFlags.map((hash) => ({ hash, tgt: lookup.hits.get(hash)!.tgt })));
    }
    const translations: Record<string, string> = {};
    let memoryChars = 0;
    for (const sentence of sentences) {
      const hit = lookup.hits.get(sentence.hash);
      if (hit) {
        translations[String(sentence.id)] = hit.tgt;
        memoryChars += countChars(sentence.text);
      }
    }
    const missChars = lookup.misses.reduce((total, sentence) => total + countChars(sentence.text), 0);
    let reservation: UsageReservation | undefined;
    let machineChars = 0;
    const warnings: JobWarning[] = [];
    try {
      const attempt = Math.max(0, Number(event.attempt ?? 0));
      reservation = await deps.usage.reserve({ tenantId: ctx.tenantId, requestId: `${event.job_id}-${event.target_lang}-${lotNo}-${attempt}-${random().slice(0, 8)}`, n: missChars, source, now: now() });
      if (missChars > 0) {
        const translated = await deps.translate({
          src: sourceLang, tgt: event.target_lang, sentences: lookup.misses.map(({ id, text }) => ({ id, text })),
          terminologyName: glossary.terminologyName, deadlineAt: now().getTime() + 240_000, concurrency: 4,
        });
        for (const item of translated.translated) translations[String(item.id)] = item.tgt;
        if (translated.failed.length || translated.pending.length) {
          const byId = new Map(lookup.misses.map((s) => [s.id, s]));
          const successful = translated.translated.map((t) => ({
            hash: byId.get(t.id)!.hash, sourceText: byId.get(t.id)!.text, tgt: t.tgt,
            glossaryVersion: glossary.version, needsReview: t.needsReview || postCheckGlossary(byId.get(t.id)!.text, t.tgt, event.target_lang!, glossary).needsReview,
          }));
          if (successful.length) await deps.tm.putMachineTM(ctx, sourceLang, event.target_lang, successful);
          machineChars = translated.translated.reduce((total, t) => total + countChars(byId.get(t.id)!.text), 0);
          await deps.usage.settle(reservation, { machineChars, memoryChars, tmHits: lookup.hits.size, tmMisses: translated.translated.length });
          reservation = undefined;
          throw Object.assign(new Error('Translation lot was incomplete.'), { name: 'BatchTranslationIncomplete' });
        }
        const byId = new Map(lookup.misses.map((s) => [s.id, s]));
        const writes = await deps.tm.putMachineTM(ctx, sourceLang, event.target_lang, translated.translated.map((t) => ({
          hash: byId.get(t.id)!.hash, sourceText: byId.get(t.id)!.text, tgt: t.tgt,
          glossaryVersion: glossary.version, needsReview: t.needsReview || postCheckGlossary(byId.get(t.id)!.text, t.tgt, event.target_lang!, glossary).needsReview,
        })));
        if (writes.failed.length) warnings.push({ code: 'TM_WRITE_FAILED', where: `lot-${lotNo}`, count: writes.failed.length, message: 'Một số câu dịch chưa ghi được vào TM.' });
        machineChars = translated.translated.reduce((total, t) => total + countChars(byId.get(t.id)!.text), 0);
      }
      await deps.usage.settle(reservation, { machineChars, memoryChars, tmHits: lookup.hits.size, tmMisses: lookup.misses.length });
      reservation = undefined;
      const sources = Object.fromEntries(blocks.map((block) => [String(block.id), { sourceId: block.sourceId ?? block.id, partIndex: block.partIndex ?? 0 }]));
      await deps.objects.put(ctx.tenantId, outputKey, jsonBytes({ translations, sources, machineChars, memoryChars, warnings }), 'application/json');
      await jobs.addProgress(ctx, event.job_id, 1, 0, progressId);
      return { lot_key: event.lot_key, target_lang: event.target_lang, result_key: outputKey };
    } catch (error) {
      if (reservation) await deps.usage.refund(reservation);
      throw error;
    }
  }

  async function mergeAndWrite(event: BatchTaskEvent) {
    const ctx = ctxOf(event.tenant_id, event.job_id);
    const job = await loadJob(ctx, event.job_id);
    const manifestBytes = await deps.objects.get(ctx.tenantId, manifestKey(ctx.tenantId, event.job_id));
    if (!manifestBytes) throw Object.assign(new Error('Batch manifest is missing.'), { name: 'ManifestNotFound' });
    const manifest = jsonValue<BatchManifest>(manifestBytes);
    const resultFiles: Record<string, string> = {};
    const warnings = [...manifest.warnings];
    for (const lang of manifest.targetLangs) {
      const translations: Array<string | undefined> = [];
      const pieces = new Map<number, Array<{ partIndex: number; text: string }>>();
      for (let i = 0; i < manifest.lots.length; i++) {
        const bytes = await deps.objects.get(ctx.tenantId, lotResultKey(ctx.tenantId, event.job_id, lang, i));
        if (!bytes) throw Object.assign(new Error(`Missing translated lot ${i} (${lang}).`), { name: 'MissingTranslatedLot' });
        const value = jsonValue<{ translations: Record<string, string>; sources?: Record<string, { sourceId: number; partIndex: number }>; warnings?: JobWarning[] }>(bytes);
        for (const [id, text] of Object.entries(value.translations)) {
          const source = value.sources?.[id];
          if (!source) translations[Number(id)] = text;
          else {
            const sourcePieces = pieces.get(source.sourceId) ?? [];
            sourcePieces.push({ partIndex: source.partIndex, text });
            pieces.set(source.sourceId, sourcePieces);
          }
        }
        if (Array.isArray(value.warnings)) warnings.push(...value.warnings);
      }
      for (const [sourceId, sourcePieces] of pieces) {
        translations[sourceId] = sourcePieces.sort((a, b) => a.partIndex - b.partIndex).map(({ text }) => text).join('');
      }
      const rebuilt = rebuild(manifest.skeleton as any, translations, { targetLang: lang });
      const name = translatedFileName(manifest.fileName, lang);
      const key = resultKey(ctx.tenantId, event.job_id, name);
      await deps.objects.put(ctx.tenantId, key, rebuilt, manifest.format === 'TXT' ? 'text/plain; charset=utf-8' : manifest.format === 'HTML' ? 'text/html; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      resultFiles[lang] = key;
    }
    await deps.jobs.update(ctx, {
      Key: jobKey(ctx, event.job_id),
      UpdateExpression: 'SET #resultFiles = :resultFiles, #warnings = :warnings, #updatedAt = :at',
      ConditionExpression: '#status = :running',
      ExpressionAttributeNames: { '#resultFiles': 'resultFiles', '#warnings': 'warnings', '#updatedAt': 'updatedAt', '#status': 'status' },
      ExpressionAttributeValues: { ':resultFiles': resultFiles, ':warnings': warnings, ':at': now().toISOString(), ':running': 'RUNNING' },
    });
    await jobs.finish(ctx, event.job_id, { status: 'SUCCEEDED', warnings });
    const links: Record<string, string> = {};
    for (const [lang, key] of Object.entries(resultFiles)) links[lang] = await deps.objects.signGet(ctx.tenantId, key, 900);
    return { job_id: event.job_id, tenant_id: ctx.tenantId, status: 'SUCCEEDED', send_email: job.sendEmail === true, notification_email: job.notificationEmail, result_files: Object.keys(resultFiles), links };
  }

  async function markFailed(event: BatchTaskEvent) {
    const ctx = ctxOf(event.tenant_id, event.job_id);
    let job = await loadJob(ctx, event.job_id);
    let reason = typeof job.reason === 'string' ? job.reason : String(event.error?.Error ?? 'BATCH_FAILED').slice(0, 128);
    if (job.status !== 'FAILED' && job.status !== 'SUCCEEDED') {
      const remaining = Math.max(0, Number(job.total ?? 0) - Number(job.done ?? 0) - Number(job.failed ?? 0));
      try {
        await jobs.finish(ctx, event.job_id, { status: 'FAILED', reason, failedRemaining: remaining });
      } catch (error) {
        // The state machine may retry after the JOB update succeeded but the Lambda response was lost.
        job = await loadJob(ctx, event.job_id);
        if (job.status !== 'FAILED' && job.status !== 'SUCCEEDED') throw error;
        if (typeof job.reason === 'string') reason = job.reason;
      }
    }
    return { job_id: event.job_id, tenant_id: ctx.tenantId, status: job.status === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED', send_email: job.sendEmail === true, notification_email: job.notificationEmail, reason };
  }

  return async (event: BatchTaskEvent) => {
    assertTaskEvent(event);
    switch (event.mode) {
      case 'PARSE_AND_CHUNK': return parseAndChunk(event);
      case 'TRANSLATE_LOT': return translateLot(event);
      case 'MERGE_AND_WRITE': return mergeAndWrite(event);
      case 'MARK_FAILED': return markFailed(event);
    }
  };
}

const baseDdb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const tenantRoleArn = process.env.TENANT_DATA_ACCESS_ROLE_ARN;
const batchBucketArn = process.env.TENANT_BATCH_UPLOAD_BUCKET_ARN;
const batchKmsKeyArn = process.env.TENANT_BATCH_UPLOAD_KMS_KEY_ARN;
const tableName = process.env.TABLE_NAME ?? 'translate-data';
const bucket = process.env.BATCH_UPLOAD_BUCKET ?? '';
  const routedDdb = createTenantDocumentClientRouter(baseDdb, { roleArn: tenantRoleArn, sessionName: 'batch-workflow' }) as DynamoDBDocumentClient;
const usage = new UsageService(routedDdb, { tableName });
const comprehend = new ComprehendClient({});
const translator = createTranslator(new TranslateClient({}));
const clientCache = new Map<string, S3Client>();

function tenantS3(tenantId: string): S3Client {
  if (!tenantRoleArn || !batchBucketArn || !batchKmsKeyArn) throw new Error('Tenant batch storage is not configured.');
  let client = clientCache.get(tenantId);
  if (!client) {
    client = createTenantS3Client(tenantRoleArn, tenantId, batchBucketArn, 'batch', 'batch-workflow', batchKmsKeyArn);
    clientCache.set(tenantId, client);
  }
  return client;
}

export const handler = async (event: BatchTaskEvent) => {
  const workflow = createBatchWorkflowHandler({
    jobs: {
      get: (ctx, key, opts) => import('../../../libs/common/db.js').then(({ db }) => db.get(ctx, key, opts)),
      put: (ctx, item, condition) => import('../../../libs/common/db.js').then(({ db }) => db.put(ctx, item, condition)),
      update: (ctx, input) => import('../../../libs/common/db.js').then(({ db }) => db.update(ctx, input)),
    },
    objects: {
      async get(tenantId, key) {
        try {
          const res = await tenantS3(tenantId).send(new GetObjectCommand({ Bucket: bucket, Key: key }));
          return res.Body ? res.Body.transformToByteArray() : null;
        } catch (error) {
          if ((error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404 || (error as { name?: string })?.name === 'NoSuchKey') return null;
          throw error;
        }
      },
      async put(tenantId, key, bytes, contentType) {
        await tenantS3(tenantId).send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: contentType }));
      },
      signGet: (tenantId, key, expiresIn) => getSignedUrl(tenantS3(tenantId), new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn }),
    },
    usage,
    tm: createTM({ db: createDynamoTmDb(routedDdb, tableName), writer: 'batch' }),
    getGlossaryState: createDynamoGlossaryReader(routedDdb, tableName),
    translate: translator,
    async detectLanguage(text) {
      const result = await comprehend.send(new DetectDominantLanguageCommand({ Text: text }));
      return result.Languages?.sort((a, b) => (b.Score ?? 0) - (a.Score ?? 0))[0]?.LanguageCode;
    },
  });
  return workflow(event);
};
