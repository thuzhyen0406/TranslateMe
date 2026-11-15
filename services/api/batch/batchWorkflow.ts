/** Batch state machine tasks (F10): parse to bounded lots, translate idempotently and assemble results. */
import { ComprehendClient, DetectDominantLanguageCommand } from '@aws-sdk/client-comprehend';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { TranslateClient } from '@aws-sdk/client-translate';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createTenantDocumentClientRouter, createTenantS3Client } from '../../../libs/common/tenantAws.js';
import { createDynamoGlossaryReader, postCheckGlossary, machineGlossaryVersion, type GlossaryState } from '../../../libs/common/glossary.js';
import { createJobStore, JOB_ID_RE, JOB_TTL_DAYS, jobKey, type JobDb, type JobWarning } from '../../../libs/common/jobs.js';
import { countChars, parse, rebuild, translatedFileName, type DocFormat } from '../../../libs/common/parsers.js';
import { normalize_hash } from '../../../libs/common/text-utils.js';
import { createDynamoTmDb, createTM, type SentenceWithHash, type TmEntry } from '../../../libs/common/tm.js';
import type { Ctx } from '../../../libs/common/types.js';
import type { db } from '../../../libs/common/db.js';
import { UsageService, type UsageReservation, type UsageSource } from '../../../libs/common/usage/usage.js';
import { createTranslator, TRANSLATE_MAX_BYTES } from '../../../libs/common/translator.js';
import { escapeHtmlText, markersToSpanHtml, serializeMarkers, tokenizeMarkers } from '../../../libs/common/markers.js';

export const BATCH_BLOCK_BYTES = 10_000;
export const BATCH_LOT_BLOCKS = 20;
export const BATCH_RETRY_LIMIT = 3;
const DISTRIBUTED_LOT_BLOCKS = 256;
const DISTRIBUTED_LOT_BYTES = 40_000;
const OBJECT_IO_CONCURRENCY = 16;
const BATCH_LANGUAGE_CONFIDENCE_THRESHOLD = 0.70;
const BATCH_SUPPORTED_LANGUAGES = new Set(['ar', 'de', 'en', 'es', 'fr', 'hi', 'id', 'it', 'ja', 'ko', 'nl', 'pl', 'pt', 'ru', 'sv', 'th', 'tr', 'vi', 'zh']);

export interface BatchBlock { id: number; text: string; sourceId?: number; partIndex?: number; verbatim?: boolean }
export interface BatchManifest {
  format: DocFormat;
  fileName: string;
  skeleton: unknown;
  warnings: JobWarning[];
  lots: string[];
  targetLangs: string[];
}
export interface BatchTaskEvent {
  mode: 'PARSE_AND_CHUNK' | 'TRANSLATE_LOT' | 'MERGE_AND_WRITE' | 'MARK_FAILED' | 'SET_NOTIFICATION_STATUS';
  tenant_id: string;
  job_id: string;
  distributed?: boolean;
  lot_key?: string;
  target_lang?: string;
  attempt?: number;
  notification_status?: 'SUBMITTED' | 'FAILED';
  notification_error?: { Error?: string; Cause?: string };
  error?: { Error?: string; Cause?: string };
}
export interface BatchWorkflowDeps {
  jobs: JobDb & Partial<Pick<typeof db, 'transact'>>;
  objects: {
    get(tenantId: string, key: string, versionId?: string): Promise<Uint8Array | null>;
    put(tenantId: string, key: string, bytes: Uint8Array, contentType: string): Promise<void>;
    signGet(tenantId: string, key: string, expiresIn: number): Promise<string>;
  };
  usage: Pick<UsageService, 'reserve' | 'settle' | 'refund'>;
  tm: ReturnType<typeof createTM>;
  getGlossaryState(ctx: Ctx): Promise<GlossaryState>;
  translate: (input: Parameters<ReturnType<typeof createTranslator>>[0]) => ReturnType<ReturnType<typeof createTranslator>>;
  detectLanguage(text: string): Promise<{ language?: string; confidence?: number }>;
  now?: () => Date;
}

interface BatchLotResult {
  checkpointVersion: 1;
  translations: Record<string, string>;
  sources: Record<string, { sourceId: number; partIndex: number }>;
  machineChars: number;
  memoryChars: number;
  warnings: JobWarning[];
  sourceLang: string;
  targetLang: string;
  tmEntries: TmEntry[];
  reservation: UsageReservation;
  usage: {
    machineChars: number;
    memoryChars: number;
    tmHits: number;
    tmMisses: number;
  };
}

const ctxOf = (tenantId: string, jobId: string): Ctx => ({ tenantId, via: 'KEYMAP', requestId: `batch-${jobId}` });
const prefixOf = (tenantId: string, jobId: string) => `batch/${tenantId}/results/${jobId}/`;
const manifestKey = (tenantId: string, jobId: string) => `${prefixOf(tenantId, jobId)}manifest.json`;
const lotKey = (tenantId: string, jobId: string, lotNo: number) => `${prefixOf(tenantId, jobId)}lots/lot-${String(lotNo).padStart(4, '0')}.json`;
const lotResultKey = (tenantId: string, jobId: string, lang: string, lotNo: number) => `${prefixOf(tenantId, jobId)}translated/${lang}/lot-${String(lotNo).padStart(4, '0')}.json`;
const resultKey = (tenantId: string, jobId: string, name: string) => `${prefixOf(tenantId, jobId)}${name}`;
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const jsonValue = <T>(bytes: Uint8Array): T => JSON.parse(new TextDecoder().decode(bytes)) as T;

export function splitBatchBlocks(blocks: readonly BatchBlock[], options: { maxBytes?: number; lotBlocks?: number; lotBytes?: number } = {}): BatchBlock[][] {
  const maxBytes = options.maxBytes ?? BATCH_BLOCK_BYTES;
  const lotBlocks = options.lotBlocks ?? BATCH_LOT_BLOCKS;
  const lots: BatchBlock[][] = [];
  let current: BatchBlock[] = [];
  let size = 0;
  for (const block of blocks) {
    const bytes = Buffer.byteLength(block.text, 'utf8');
    if (!Number.isSafeInteger(block.id) || block.id < 0 || typeof block.text !== 'string') throw new TypeError('Invalid batch block.');
    if (bytes > maxBytes) throw Object.assign(new Error(`Block ${block.id} exceeds ${maxBytes} UTF-8 bytes.`), { name: 'BlockTooLarge' });
    if (current.length && (current.length >= lotBlocks || size + bytes > (options.lotBytes ?? Infinity))) {
      lots.push(current);
      current = [];
      size = 0;
    }
    current.push(block);
    size += bytes;
  }
  if (current.length) lots.push(current);
  return lots;
}

/** Split by the encoded TranslateText size and leave inline structure out of split requests. */
export function splitOversizedBatchBlocks(blocks: readonly BatchBlock[], maxBytes = BATCH_BLOCK_BYTES): BatchBlock[] {
  const limit = Math.min(maxBytes, TRANSLATE_MAX_BYTES - 64); // Space for the sentence wrapper.
  const expanded: BatchBlock[] = [];
  for (const block of blocks) {
    let partIndex = 0;
    const append = (text: string, verbatim = false) => expanded.push({
      id: expanded.length, text, sourceId: block.id, partIndex: partIndex++, ...(verbatim ? { verbatim: true } : {}),
    });
    if (Buffer.byteLength(block.text, 'utf8') <= maxBytes &&
        Buffer.byteLength(markersToSpanHtml(block.text.normalize('NFC')), 'utf8') <= limit) {
      append(block.text);
      continue;
    }

    for (const token of tokenizeMarkers(block.text)) {
      if (token.type !== 'text') {
        append(serializeMarkers([token]), true);
        continue;
      }
      let chunk = '';
      let size = 0;
      const flush = () => {
        if (chunk) append(serializeMarkers([{ type: 'text', value: chunk }]), !chunk.trim());
        chunk = '';
        size = 0;
      };
      for (const match of token.value.matchAll(/\s+|\S+/gu)) {
        const word = match[0];
        const bytes = Math.max(Buffer.byteLength(serializeMarkers([{ type: 'text', value: word }]), 'utf8'), Buffer.byteLength(escapeHtmlText(word.normalize('NFC')), 'utf8'));
        if (bytes <= limit) {
          if (size + bytes > limit) flush();
          chunk += word;
          size += bytes;
          continue;
        }
        for (const point of word) {
          const pointBytes = Math.max(Buffer.byteLength(serializeMarkers([{ type: 'text', value: point }]), 'utf8'), Buffer.byteLength(escapeHtmlText(point.normalize('NFC')), 'utf8'));
          if (pointBytes > limit) throw Object.assign(new Error('Batch block byte limit is too small.'), { name: 'BlockTooLarge' });
          if (size + pointBytes > limit) flush();
          chunk += point;
          size += pointBytes;
        }
      }
      flush();
    }
  }
  return expanded;
}

async function processObjectPages<T, R>(
  items: readonly T[],
  process: (item: T, index: number) => Promise<R>,
  consume?: (result: R, index: number) => void,
): Promise<void> {
  for (let start = 0; start < items.length; start += OBJECT_IO_CONCURRENCY) {
    const page = items.slice(start, start + OBJECT_IO_CONCURRENCY);
    const results = await Promise.all(page.map((item, index) => process(item, start + index)));
    results.forEach((result, index) => consume?.(result, start + index));
  }
}

function assertTaskEvent(event: BatchTaskEvent): void {
  if (!event || !event.tenant_id || event.tenant_id === 'PLATFORM' || !JOB_ID_RE.test(event.job_id)) {
    throw Object.assign(new Error('Invalid batch task identity.'), { name: 'InvalidEvent' });
  }
}

export function createBatchWorkflowHandler(deps: BatchWorkflowDeps) {
  const now = deps.now ?? (() => new Date());
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
    // Jobs accepted before version pinning stored only the key.
    const versionId = typeof job.fileVersionId === 'string' ? job.fileVersionId : undefined;
    const bytes = await deps.objects.get(ctx.tenantId, fileKey, versionId);
    if (!bytes) throw Object.assign(new Error('Uploaded batch file is missing.'), { name: 'FileNotFound' });
    const parsed = parse(String(fileFormat).toUpperCase(), bytes);
    const blocks = splitOversizedBatchBlocks(parsed.blocks);
    const grouped = splitBatchBlocks(blocks, event.distributed
      ? { lotBlocks: DISTRIBUTED_LOT_BLOCKS, lotBytes: DISTRIBUTED_LOT_BYTES }
      : {});
    const lots = grouped.map((_, index) => lotKey(ctx.tenantId, event.job_id, index));
    const manifest: BatchManifest = {
      format: String(fileFormat).toUpperCase() as DocFormat,
      fileName: String(job.fileName),
      skeleton: parsed.skeleton,
      warnings: parsed.warnings,
      lots,
      targetLangs: Array.isArray(job.targetLangs) ? job.targetLangs.map(String) : [],
    };
    const result = {
      job_id: event.job_id,
      tenant_id: ctx.tenantId,
      manifest_key: manifestKey(ctx.tenantId, event.job_id),
      target_langs: manifest.targetLangs,
    };
    const total = lots.length * manifest.targetLangs.length;
    const lotIndex = `${prefixOf(ctx.tenantId, event.job_id)}lot-index.json`;
    // Old state-machine executions can still call the new Lambda during rollout.
    const output = event.distributed ? { ...result, lot_index_key: lotIndex, lot_count: lots.length }
      : { ...result, lot_keys: lots, send_email: job.sendEmail === true, notification_email: job.notificationEmail };
    if (!event.distributed && (total > 800 || jsonBytes(output).length > 200_000)) {
      throw Object.assign(new Error('Batch exceeds legacy workflow limits. Submit the file to the updated workflow.'), { name: 'LegacyBatchWorkflowLimit' });
    }

    await processObjectPages(grouped, (group, index) =>
      deps.objects.put(ctx.tenantId, lots[index], jsonBytes(group), 'application/json'));
    await deps.objects.put(ctx.tenantId, result.manifest_key, jsonBytes(manifest), 'application/json');
    if (event.distributed) {
      await deps.objects.put(ctx.tenantId, lotIndex, jsonBytes(lots.map((key) => ({ key }))), 'application/json');
    }
    await jobs.markRunning(ctx, event.job_id, total, { warnings: parsed.warnings });
    return output;
  }

  async function recordProgress(ctx: Ctx, event: BatchTaskEvent, job: Record<string, unknown>, progressId: string) {
    if (!event.distributed) {
      await jobs.addProgress(ctx, event.job_id, 1, 0, progressId);
      return;
    }
    if (!deps.jobs.transact) throw new Error('Distributed batch requires transactional job progress.');
    const jobRecord = jobKey(ctx, event.job_id);
    // Store each completed lot as a separate item to keep JOB below DynamoDB's 400 KiB limit.
    const marker = { PK: jobRecord.PK, SK: `LOT#${event.job_id}#${progressId}` };
    const ttl = Number(job.ttl) || Math.floor(now().getTime() / 1_000) + JOB_TTL_DAYS * 86_400;
    try {
      await deps.jobs.transact(ctx, [
        { Put: { TableName: tableName, Item: { ...marker, ttl }, ConditionExpression: 'attribute_not_exists(PK)' } },
        {
          Update: {
            TableName: tableName,
            Key: jobRecord,
            UpdateExpression: 'SET #updatedAt = :at ADD #done :one',
            ConditionExpression: '#status = :running',
            ExpressionAttributeNames: { '#status': 'status', '#updatedAt': 'updatedAt', '#done': 'done' },
            ExpressionAttributeValues: { ':at': now().toISOString(), ':one': 1, ':running': 'RUNNING' },
          },
        },
      ]);
    } catch (error) {
      if ((error as { name?: string })?.name !== 'TransactionCanceledException' ||
          !(await deps.jobs.get(ctx, marker, { consistent: true }))) throw error;
    }
  }

  async function translateLot(event: BatchTaskEvent) {
    const ctx = ctxOf(event.tenant_id, event.job_id);
    const job = await loadJob(ctx, event.job_id);
    if (typeof event.lot_key !== 'string' || !event.lot_key.startsWith(`${prefixOf(ctx.tenantId, event.job_id)}lots/`) || typeof event.target_lang !== 'string') {
      throw Object.assign(new Error('Invalid batch lot key or language.'), { name: 'InvalidEvent' });
    }
    const matched = /\/lot-(\d{4,})\.json$/u.exec(event.lot_key);
    if (!matched) throw Object.assign(new Error('Invalid batch lot identifier.'), { name: 'InvalidEvent' });
    const lotNo = Number(matched[1]);
    const outputKey = lotResultKey(ctx.tenantId, event.job_id, event.target_lang, lotNo);
    const previousOutput = await deps.objects.get(ctx.tenantId, outputKey);
    const progressId = `lot_${String(lotNo).padStart(4, '0')}_${event.target_lang}`;
    if (previousOutput) {
      const result = jsonValue<Partial<BatchLotResult>>(previousOutput);
      if (result.checkpointVersion === undefined) {
        // Previous workflow versions wrote this object only after usage settlement succeeded.
        if (!result.translations || typeof result.translations !== 'object' || Array.isArray(result.translations) ||
            !result.sources || typeof result.sources !== 'object' || Array.isArray(result.sources) ||
            typeof result.machineChars !== 'number' || !Number.isFinite(result.machineChars) ||
            typeof result.memoryChars !== 'number' || !Number.isFinite(result.memoryChars) || !Array.isArray(result.warnings)) {
          throw Object.assign(new Error('Legacy batch lot result is invalid.'), { name: 'InvalidBatchCheckpoint' });
        }
        await recordProgress(ctx, event, job, progressId);
        return { lot_key: event.lot_key, target_lang: event.target_lang, result_key: outputKey };
      }
      if (result.checkpointVersion !== 1 || !result.reservation || !result.usage || !Array.isArray(result.tmEntries) || !Array.isArray(result.warnings) ||
          typeof result.sourceLang !== 'string' || result.targetLang !== event.target_lang) {
        throw Object.assign(new Error('Batch lot checkpoint is invalid.'), { name: 'InvalidBatchCheckpoint' });
      }
      const writes = await deps.tm.putMachineTM(ctx, result.sourceLang, result.targetLang, result.tmEntries);
      if (writes.failed.length) {
        const warning = result.warnings.find((item) => item.code === 'TM_WRITE_FAILED' && item.where === `lot-${lotNo}`);
        if (warning) warning.count = writes.failed.length;
        else result.warnings.push({ code: 'TM_WRITE_FAILED', where: `lot-${lotNo}`, count: writes.failed.length, message: 'Một số câu dịch chưa ghi được vào TM.' });
        await deps.objects.put(ctx.tenantId, outputKey, jsonBytes(result), 'application/json');
      }
      await deps.usage.settle(result.reservation, result.usage);
      await recordProgress(ctx, event, job, progressId);
      return { lot_key: event.lot_key, target_lang: event.target_lang, result_key: outputKey };
    }
    const blocks = jsonValue<BatchBlock[]>(await deps.objects.get(ctx.tenantId, event.lot_key) ?? new Uint8Array());
    const file = job;
    const source = job.usageSource as UsageSource | undefined;
    if (!source) throw Object.assign(new Error('Job is missing usage source.'), { name: 'InvalidJob' });
    const translatable = blocks.filter((block) => !block.verbatim && block.text.trim());
    let sourceLang = typeof file.sourceLang === 'string' ? file.sourceLang : undefined;
    if (!sourceLang && translatable.length) {
      const detected = await deps.detectLanguage(translatable.map((b) => b.text).join('\n').slice(0, 5000));
      if (!detected.language || !BATCH_SUPPORTED_LANGUAGES.has(detected.language) ||
          (detected.confidence ?? 0) < BATCH_LANGUAGE_CONFIDENCE_THRESHOLD) {
        throw Object.assign(new Error('Source language could not be detected with confidence of at least 0.70.'), { name: 'LanguageNotDetected' });
      }
      sourceLang = detected.language;
    }
    sourceLang ??= 'und'; // A lot containing only verbatim pieces has no language to detect.
    const glossary = await deps.getGlossaryState(ctx);
    const sentences: SentenceWithHash[] = translatable.map(({ id, text }) => {
      const normalized = normalize_hash(text);
      return { id, text: normalized.normalizedText, hash: normalized.hash };
    });
    const lookup = await deps.tm.getTM(ctx, sourceLang, event.target_lang, sentences, glossary);
    if (lookup.reviewFlags.length) {
      await deps.tm.markHumanNeedsReview(ctx, sourceLang, event.target_lang, lookup.reviewFlags.map((hash) => ({ hash, tgt: lookup.hits.get(hash)!.tgt })));
    }
    const translations: Record<string, string> = {};
    const outputTranslations = () => Object.fromEntries(blocks.map(({ id, text, verbatim }) => {
      const translated = translations[id];
      if (verbatim || !text.trim()) return [id, text];
      if (translated === undefined) {
        throw Object.assign(new Error('Translation lot was incomplete.'), { name: 'BatchTranslationIncomplete' });
      }
      const leading = /^\s*/u.exec(text)![0];
      const trailing = /\s*$/u.exec(text)![0];
      return [id, leading + translated.trim() + trailing];
    }));
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
    let checkpointPersisted = false;
    try {
      const attempt = Math.max(0, Number(event.attempt ?? 0));
      reservation = await deps.usage.reserve({ tenantId: ctx.tenantId, requestId: `${event.job_id}-${event.target_lang}-${lotNo}-${attempt}`, n: missChars, source, now: now() });
      if (missChars > 0) {
        const translated = await deps.translate({
          src: sourceLang, tgt: event.target_lang, sentences: lookup.misses.map(({ id, text }) => ({ id, text })),
          terminologyName: glossary.terminologyName, deadlineAt: now().getTime() + 240_000, concurrency: 4,
        });
        if (translated.failed.length || translated.pending.length || translated.translated.length !== lookup.misses.length) {
          throw Object.assign(new Error('Translation lot was incomplete.'), { name: 'BatchTranslationIncomplete' });
        }
        const byId = new Map(lookup.misses.map((s) => [s.id, s]));
        const tmEntries = translated.translated.map((t) => ({
          hash: byId.get(t.id)!.hash, sourceText: byId.get(t.id)!.text, tgt: t.tgt,
          glossaryVersion: machineGlossaryVersion(glossary), needsReview: t.needsReview || postCheckGlossary(byId.get(t.id)!.text, t.tgt, event.target_lang!, glossary).needsReview,
        }));
        for (const item of translated.translated) translations[String(item.id)] = item.tgt;
        machineChars = translated.translated.reduce((total, t) => total + countChars(byId.get(t.id)!.text), 0);
        const result: BatchLotResult = {
          checkpointVersion: 1,
          translations: outputTranslations(),
          sources: Object.fromEntries(blocks.map((block) => [String(block.id), { sourceId: block.sourceId ?? block.id, partIndex: block.partIndex ?? 0 }])),
          machineChars,
          memoryChars,
          warnings,
          sourceLang,
          targetLang: event.target_lang,
          tmEntries,
          reservation,
          usage: { machineChars, memoryChars, tmHits: lookup.hits.size, tmMisses: lookup.misses.length },
        };
        await deps.objects.put(ctx.tenantId, outputKey, jsonBytes(result), 'application/json');
        checkpointPersisted = true;
        const writes = await deps.tm.putMachineTM(ctx, sourceLang, event.target_lang, tmEntries);
        if (writes.failed.length) {
          result.warnings.push({ code: 'TM_WRITE_FAILED', where: `lot-${lotNo}`, count: writes.failed.length, message: 'Một số câu dịch chưa ghi được vào TM.' });
          await deps.objects.put(ctx.tenantId, outputKey, jsonBytes(result), 'application/json');
        }
        await deps.usage.settle(reservation, result.usage);
        reservation = undefined;
        await recordProgress(ctx, event, job, progressId);
        return { lot_key: event.lot_key, target_lang: event.target_lang, result_key: outputKey };
      }

      const result: BatchLotResult = {
        checkpointVersion: 1,
        translations: outputTranslations(),
        sources: Object.fromEntries(blocks.map((block) => [String(block.id), { sourceId: block.sourceId ?? block.id, partIndex: block.partIndex ?? 0 }])),
        machineChars,
        memoryChars,
        warnings,
        sourceLang,
        targetLang: event.target_lang,
        tmEntries: [],
        reservation,
        usage: { machineChars, memoryChars, tmHits: lookup.hits.size, tmMisses: lookup.misses.length },
      };
      await deps.objects.put(ctx.tenantId, outputKey, jsonBytes(result), 'application/json');
      checkpointPersisted = true;
      await deps.usage.settle(reservation, result.usage);
      reservation = undefined;
      await recordProgress(ctx, event, job, progressId);
      return { lot_key: event.lot_key, target_lang: event.target_lang, result_key: outputKey };
    } catch (error) {
      if (reservation && !checkpointPersisted) {
        try {
          checkpointPersisted = Boolean(await deps.objects.get(ctx.tenantId, outputKey));
        } catch (verifyError) {
          throw new AggregateError([error, verifyError], 'Unable to verify batch lot checkpoint after result write failure.');
        }
        if (!checkpointPersisted) await deps.usage.refund(reservation);
      }
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
    const groupedWarnings = new Map<string, JobWarning>();
    for (const lang of manifest.targetLangs) {
      const translations: Array<string | undefined> = [];
      const pieces = new Map<number, Array<{ partIndex: number; text: string }>>();
      await processObjectPages(manifest.lots, async (_, index) => {
        const bytes = await deps.objects.get(ctx.tenantId, lotResultKey(ctx.tenantId, event.job_id, lang, index));
        if (!bytes) throw Object.assign(new Error(`Missing translated lot ${index} (${lang}).`), { name: 'MissingTranslatedLot' });
        return jsonValue<{ translations: Record<string, string>; sources?: Record<string, { sourceId: number; partIndex: number }>; warnings?: JobWarning[] }>(bytes);
      }, (value) => {
        for (const [id, text] of Object.entries(value.translations)) {
          const source = value.sources?.[id];
          if (!source) translations[Number(id)] = text;
          else {
            const sourcePieces = pieces.get(source.sourceId) ?? [];
            sourcePieces.push({ partIndex: source.partIndex, text });
            pieces.set(source.sourceId, sourcePieces);
          }
        }
        if (Array.isArray(value.warnings)) {
          for (const warning of value.warnings) {
            if (!event.distributed) {
              warnings.push(warning);
              continue;
            }
            const current = groupedWarnings.get(warning.code);
            if (current) current.count += warning.count;
            else groupedWarnings.set(warning.code, { ...warning, where: 'batch-lots' });
          }
        }
      });
      for (const [sourceId, sourcePieces] of pieces) {
        translations[sourceId] = sourcePieces.sort((a, b) => a.partIndex - b.partIndex).map(({ text }) => text).join('');
      }
      const rebuilt = rebuild(manifest.skeleton as any, translations, { targetLang: lang });
      const name = translatedFileName(manifest.fileName, lang);
      const key = resultKey(ctx.tenantId, event.job_id, name);
      await deps.objects.put(ctx.tenantId, key, rebuilt, manifest.format === 'TXT' ? 'text/plain; charset=utf-8' : manifest.format === 'HTML' ? 'text/html; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      resultFiles[lang] = key;
    }
    warnings.push(...groupedWarnings.values());
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

  async function setNotificationStatus(event: BatchTaskEvent) {
    const ctx = ctxOf(event.tenant_id, event.job_id);
    const job = await loadJob(ctx, event.job_id);
    const notificationStatus = event.notification_status === 'FAILED' ? 'FAILED' : 'SUBMITTED';
    const message = typeof event.notification_error?.Cause === 'string' && event.notification_error.Cause.trim()
      ? event.notification_error.Cause.trim()
      : typeof event.notification_error?.Error === 'string' && event.notification_error.Error.trim()
        ? event.notification_error.Error.trim()
        : notificationStatus === 'FAILED'
          ? 'NOTIFICATION_FAILED'
          : 'NOTIFICATION_SUBMITTED';
    const warnings = Array.isArray(job.warnings) ? [...(job.warnings as JobWarning[])] : [];
    if (notificationStatus === 'FAILED') {
      const exists = warnings.some((warning) => warning.code === 'NOTIFICATION_FAILED');
      if (!exists) warnings.push({ code: 'NOTIFICATION_FAILED', where: 'batch-notify', count: 1, message });
    }
    await deps.jobs.update(ctx, {
      Key: jobKey(ctx, event.job_id),
      UpdateExpression: 'SET #notificationStatus = :notificationStatus, #updatedAt = :at' + (notificationStatus === 'FAILED' ? ', #warnings = :warnings' : '') + (message && notificationStatus === 'FAILED' ? ', #notificationError = :notificationError' : ''),
      ConditionExpression: '#status IN (:queued, :running, :succeeded, :failed)',
      ExpressionAttributeNames: {
        '#notificationStatus': 'notificationStatus',
        '#updatedAt': 'updatedAt',
        '#status': 'status',
        ...(notificationStatus === 'FAILED' ? { '#warnings': 'warnings', '#notificationError': 'notificationError' } : {}),
      },
      ExpressionAttributeValues: {
        ':notificationStatus': notificationStatus,
        ':at': now().toISOString(),
        ':queued': 'QUEUED',
        ':running': 'RUNNING',
        ':succeeded': 'SUCCEEDED',
        ':failed': 'FAILED',
        ...(notificationStatus === 'FAILED' ? { ':warnings': warnings, ':notificationError': message } : {}),
      },
    });
    return { job_id: event.job_id, tenant_id: ctx.tenantId, status: job.status, notification_status: notificationStatus, ...(notificationStatus === 'FAILED' ? { notification_error: message } : {}) };
  }

  async function markFailed(event: BatchTaskEvent) {
    const ctx = ctxOf(event.tenant_id, event.job_id);
    let job = await loadJob(ctx, event.job_id);
    let reason = typeof job.reason === 'string' ? job.reason : String(event.error?.Error ?? 'BATCH_FAILED').slice(0, 128);
    if (job.status !== 'FAILED' && job.status !== 'SUCCEEDED') {
      try {
        await jobs.finish(ctx, event.job_id, { status: 'FAILED', reason, markUnfinishedFailed: true });
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
      case 'SET_NOTIFICATION_STATUS': return setNotificationStatus(event);
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
  const cachedClient = clientCache.get(tenantId);
  if (cachedClient) return cachedClient;

  const client = createTenantS3Client(
    tenantRoleArn,
    tenantId,
    batchBucketArn,
    'batch',
    'batch-workflow',
    batchKmsKeyArn,
  ) as unknown as S3Client;
  clientCache.set(tenantId, client);
  return client;
}

interface ExecutionStatusEvent {
  source: 'aws.states';
  'detail-type': 'Step Functions Execution Status Change';
  detail: { status?: string; input?: string; executionArn?: string };
}

export function failedExecutionTask(event: ExecutionStatusEvent): BatchTaskEvent | null {
  const { detail } = event;
  if (event.source !== 'aws.states' || event['detail-type'] !== 'Step Functions Execution Status Change' ||
      !detail || !['FAILED', 'TIMED_OUT', 'ABORTED'].includes(detail.status ?? '') || !detail.input) return null;
  let input: { tenant_id?: unknown; job_id?: unknown } | null;
  try { input = JSON.parse(detail.input); }
  catch { return null; }
  if (!input) return null;
  const { tenant_id, job_id } = input;
  if (typeof tenant_id !== 'string' || !/^t_[A-Za-z0-9_-]{1,64}$/.test(tenant_id) ||
      typeof job_id !== 'string' || !JOB_ID_RE.test(job_id) ||
      !detail.executionArn?.endsWith(`:${job_id}`)) return null;
  return { mode: 'MARK_FAILED', tenant_id, job_id, error: { Error: `WORKFLOW_${detail.status}` } };
}

export const handler = async (event: BatchTaskEvent | ExecutionStatusEvent) => {
  const task = 'detail-type' in event ? failedExecutionTask(event) : event;
  if (!task) return;
  const workflow = createBatchWorkflowHandler({
    jobs: {
      get: (ctx, key, opts) => import('../../../libs/common/db.js').then(({ db }) => db.get(ctx, key, opts)),
      put: (ctx, item, condition) => import('../../../libs/common/db.js').then(({ db }) => db.put(ctx, item, condition)),
      update: (ctx, input) => import('../../../libs/common/db.js').then(({ db }) => db.update(ctx, input)),
      transact: (ctx, ops) => import('../../../libs/common/db.js').then(({ db }) => db.transact(ctx, ops)),
    },
    objects: {
      async get(tenantId, key, versionId) {
        try {
          const res = await tenantS3(tenantId).send(new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }));
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
      const top = result.Languages?.sort((a, b) => (b.Score ?? 0) - (a.Score ?? 0))[0];
      return { language: top?.LanguageCode, confidence: top?.Score };
    },
  });
  return workflow(task);
};
