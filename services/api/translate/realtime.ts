/**
 * Xử lý API dịch realtime: xác thực tenant, nhận diện ngôn ngữ, tra cứu Translation Memory,
 * kiểm tra lỗi thời thuật ngữ (sinceVersion), hậu kiểm thuật ngữ (postCheckGlossary),
 * dịch các câu chưa có trong bộ nhớ và hạch toán mức sử dụng trước khi trả JSON (Nhiệm vụ 2.6 – TV3; 3.9 – TV4).
 */
import { randomUUID } from 'node:crypto';
import { ComprehendClient, DetectDominantLanguageCommand } from '@aws-sdk/client-comprehend';
import { TranslateClient } from '@aws-sdk/client-translate';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { createDynamoGlossaryReader, postCheckGlossary, type GlossaryState } from '../../../libs/common/glossary.js';
import { createTenantDocumentClientRouter, createTenantS3Client } from '../../../libs/common/tenantAws.js';
import { segmentBlock } from '../../../libs/common/segmenter.js';
import { normalize_hash } from '../../../libs/common/text-utils.js';
import { createDynamoTmDb, createTM, EMPTY_GLOSSARY_STATE, type SentenceWithHash } from '../../../libs/common/tm.js';
import { AppError, type Ctx } from '../../../libs/common/types.js';
import { CharacterQuotaExceededError, UsageService, type UsageReservation } from '../../../libs/common/usage/usage.js';
import { createTranslator, type TranslateClientLike } from '../../../libs/common/translator.js';
import { assertTenantWritable } from '../../../libs/common/tenant.js';
import { createBatchUploadUrlHandler } from './batchUpload.js';

const MAX_TEXT_CHARS = 5000;
const MAX_TRANSLATE_BYTES = 10_000;
const CONFIDENCE_THRESHOLD = 0.70;
const SUPPORTED_LANGUAGES = new Set(['ar','de','en','es','fr','hi','id','it','ja','ko','nl','pl','pt','ru','sv','th','tr','vi','zh']);

export interface RealtimeEvent {
  body?: string | null;
  headers?: Record<string, string | undefined>;
  requestContext?: { requestId?: string; identity?: { apiKeyId?: string }; authorizer?: { keyId?: string; tenantId?: string } };
}
export interface RealtimeResponse { statusCode: number; headers: Record<string, string>; body: string }
export interface RealtimeDeps {
  tableName: string;
  ddb: Pick<DynamoDBDocumentClient, 'send'>;
  usage: Pick<UsageService, 'reserve' | 'settle' | 'refund'>;
  translate: TranslateClientLike;
  detectLanguage: (text: string) => Promise<{ language?: string; confidence?: number }>;
  getGlossaryState?: (ctx: Ctx) => Promise<GlossaryState>;
  now?: () => Date;
}
/**
 * Tạo phản hồi JSON thống nhất, thiết lập header nội dung và chính sách không lưu cache.
 * @param statusCode Mã trạng thái HTTP.
 * @param payload Dữ liệu cần mã hóa thành JSON trong thân phản hồi.
 * @returns Phản hồi HTTP gồm status, headers và body.
 */
export function realtimeJson(statusCode: number, payload: Record<string, unknown>): RealtimeResponse {
  return { statusCode, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: JSON.stringify(payload) };
}

/**
 * Tạo phản hồi lỗi theo schema API, kèm mã lỗi, thông báo và mã yêu cầu.
 * @param status Mã trạng thái HTTP.
 * @param code Mã lỗi ổn định của API.
 * @param message Thông báo lỗi hiển thị cho bên gọi.
 * @param requestId Mã định danh yêu cầu.
 * @returns Phản hồi JSON lỗi theo định dạng chung.
 */
function apiError(status: number, code: string, message: string, requestId: string): RealtimeResponse {
  return realtimeJson(status, { request_id: requestId, error: { code, message } });
}

/**
 * Cắt văn bản theo giới hạn byte UTF-8 mà không tách đôi ký tự Unicode.
 * @param text Văn bản cần cắt.
 * @param maxBytes Số byte UTF-8 tối đa được giữ lại.
 * @returns Phần đầu văn bản nằm trong giới hạn byte.
 */
function truncateUtf8(text: string, maxBytes: number): string {
  let result = '';
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > maxBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}

/**
 * Lấy thông tin xác thực từ authorizer hoặc tra cứu KEYMAP trong DynamoDB.
 * @param event Sự kiện API Gateway chứa thông tin authorizer hoặc API key.
 * @param deps Các phụ thuộc dịch vụ, bao gồm tên bảng và DynamoDB.
 * @returns Tenant ID và key ID đã xác thực; các trường không có nếu xác thực thất bại.
 */
async function resolveTenant(event: RealtimeEvent, deps: RealtimeDeps): Promise<{ tenantId?: string; keyId?: string }> {
  const context = event.requestContext?.authorizer;
  if (context?.tenantId && context.keyId) return { tenantId: context.tenantId, keyId: context.keyId };
  const keyId = context?.keyId ?? event.requestContext?.identity?.apiKeyId;
  if (!keyId) return {};
  const found = await deps.ddb.send(new GetCommand({ TableName: deps.tableName, Key: { PK: `TENANT#PLATFORM#KEY#${keyId}`, SK: 'META' }, ConsistentRead: true }));
  return found.Item?.tenantId ? { tenantId: String(found.Item.tenantId), keyId } : {};
}

/**
 * Đọc bảng thuật ngữ của tenant cho luồng dịch realtime (3.9).
 * Ưu tiên `deps.getGlossaryState` nếu có; ngược lại truy vấn phân trang các mục `TERM#` từ `TENANT#<t>#GLOSS`.
 * Chỉ trả `terminologyName` khi `CONFIG.terminologyName` đã được đồng bộ và có ít nhất 1 thuật ngữ hiệu lực;
 * nếu chưa đồng bộ hoặc chưa có thuật ngữ hiệu lực thì trả `null` để không gửi tên Custom Terminology chưa tồn tại.
 */
async function loadRealtimeGlossary(
  ctx: Ctx,
  configItem: Record<string, any>,
  deps: RealtimeDeps,
): Promise<GlossaryState> {
  if (deps.getGlossaryState) {
    return deps.getGlossaryState(ctx);
  }
  const version = Number(configItem.glossaryVersion ?? EMPTY_GLOSSARY_STATE.version);
  const syncedTerminologyName =
    typeof configItem.terminologyName === 'string' && configItem.terminologyName.trim() !== ''
      ? configItem.terminologyName.trim()
      : null;
  if (version <= 0) {
    return { version: 0, terminologyName: null, terms: [] };
  }
  try {
    const rawItems: Record<string, any>[] = [];
    let exclusiveStartKey: Record<string, any> | undefined;
    do {
      const glossRes = await deps.ddb.send(
        new QueryCommand({
          TableName: deps.tableName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
          ExpressionAttributeValues: {
            ':pk': `TENANT#${ctx.tenantId}#GLOSS`,
            ':skPrefix': 'TERM#',
          },
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        }),
      );
      if (glossRes.Items) {
        rawItems.push(...(glossRes.Items as Record<string, any>[]));
      }
      exclusiveStartKey = glossRes.LastEvaluatedKey as Record<string, any> | undefined;
    } while (exclusiveStartKey);

    const terms: GlossaryState['terms'] = rawItems.map((item) => ({
      normalized: String(item.normalized ?? String(item.SK ?? '').replace(/^TERM#/, '')),
      sourceTerm: typeof item.sourceTerm === 'string' ? item.sourceTerm : String(item.normalized ?? ''),
      sourceLang: typeof item.sourceLang === 'string' ? item.sourceLang : 'vi',
      type: item.type === 'KEEP' ? 'KEEP' : 'FIXED',
      translations: item.translations && typeof item.translations === 'object' ? { ...item.translations } : {},
      sinceVersion: Number(item.sinceVersion ?? 1),
      deleted: Boolean(item.deleted),
    }));
    const hasActiveTerms = terms.some((t) => !t.deleted);
    return {
      version,
      terminologyName: hasActiveTerms ? syncedTerminologyName : null,
      terms,
    };
  } catch {
    return {
      version,
      terminologyName: null,
      terms: [],
    };
  }
}

/**
 * Tạo bộ xử lý POST realtime gồm xác thực, nhận diện, tra TM, dịch, hậu kiểm thuật ngữ, hạch toán và trả JSON.
 * @param deps Các phụ thuộc DynamoDB, usage, dịch máy, nhận diện ngôn ngữ và đồng hồ tùy chọn.
 * @returns Hàm xử lý sự kiện realtime và trả về phản hồi HTTP chuẩn hóa.
 */
export function createRealtimeHandler(deps: RealtimeDeps) {
  /**
   * Xử lý một yêu cầu dịch realtime, bao gồm kiểm tra đầu vào và hạch toán sử dụng.
   * @param event Sự kiện API Gateway chứa body và ngữ cảnh yêu cầu.
   * @returns Phản hồi HTTP JSON chứa bản dịch hoặc thông tin lỗi.
   */
  return async (event: RealtimeEvent): Promise<RealtimeResponse> => {
    const requestId = event.requestContext?.requestId ?? `req-${randomUUID()}`;
    try {
      const auth = await resolveTenant(event, deps);
      if (!auth.tenantId || !auth.keyId) return apiError(401, 'UNAUTHORIZED', 'API key không hợp lệ hoặc không được cung cấp.', requestId);
      const ctx: Ctx = { tenantId: auth.tenantId, via: 'KEYMAP', requestId, keyId: auth.keyId };
      await assertTenantWritable(ctx, {
        async get(_ctx, key) {
          const result = await deps.ddb.send(new GetCommand({
            TableName: deps.tableName,
            Key: key,
            ConsistentRead: true,
          }));
          return result.Item ?? null;
        },
      });
      const config = await deps.ddb.send(new GetCommand({ TableName: deps.tableName, Key: { PK: `TENANT#${auth.tenantId}`, SK: 'CONFIG' }, ConsistentRead: true }));
      if (!config.Item) return apiError(404, 'NOT_FOUND', 'Không tìm thấy tài nguyên', requestId);
      const body = typeof event.body === 'string' ? JSON.parse(event.body) : null;
      if (!body || typeof body.text !== 'string' || !body.text.trim() || typeof body.target_lang !== 'string') return apiError(400, 'INVALID_REQUEST', 'Cần cung cấp text và target_lang trong JSON hợp lệ.', requestId);
      if (body.source_lang !== undefined && typeof body.source_lang !== 'string') return apiError(400, 'INVALID_REQUEST', 'source_lang phải là chuỗi mã ngôn ngữ.', requestId);
      if (body.use_terminology !== undefined && typeof body.use_terminology !== 'boolean') return apiError(400, 'INVALID_REQUEST', 'use_terminology phải là boolean.', requestId);
      if (!SUPPORTED_LANGUAGES.has(body.target_lang) || (body.source_lang && !SUPPORTED_LANGUAGES.has(body.source_lang))) return apiError(400, 'UNSUPPORTED_LANGUAGE', 'Mã ngôn ngữ không được hỗ trợ.', requestId);
      if (Array.from(body.text).length > MAX_TEXT_CHARS) return apiError(400, 'TEXT_TOO_LONG', 'Văn bản vượt quá 5.000 ký tự.', requestId);
      let sourceLang = typeof body.source_lang === 'string' ? body.source_lang : undefined;
      let detected = false;
      let confidence: number | undefined;
      if (!sourceLang) {
        const result = await deps.detectLanguage(body.text);
        sourceLang = result.language;
        confidence = result.confidence;
        detected = true;
        if (!sourceLang || !SUPPORTED_LANGUAGES.has(sourceLang) || (confidence ?? 0) < CONFIDENCE_THRESHOLD) return apiError(400, 'LANGUAGE_NOT_DETECTED', 'Không nhận diện được ngôn ngữ nguồn với độ tin cậy từ 0,70.', requestId);
      }
      const pieces = segmentBlock(body.text.normalize('NFC'));
      const sentences = pieces.filter((p) => p.kind === 'sentence').map((p) => p.text);
      const useTerminology = body.use_terminology !== false;
      const uniqueSentences = [...new Set(sentences)];
      const date = (deps.now ?? (() => new Date()))();
      const tm = createTM({
        db: createDynamoTmDb(deps.ddb, deps.tableName),
        now: () => date.toISOString(),
        writer: 'realtime',
      });
      const sentenceItems: SentenceWithHash[] = uniqueSentences.map((text, id) => {
        const normalized = normalize_hash(text);
        return { id, text: normalized.normalizedText, hash: normalized.hash };
      });
      const glossary: GlossaryState = useTerminology
        ? await loadRealtimeGlossary(ctx, config.Item, deps)
        : { ...EMPTY_GLOSSARY_STATE, version: Number(config.Item.glossaryVersion ?? 0) };
      const lookup = useTerminology
        ? await tm.getTM(ctx, sourceLang, body.target_lang, sentenceItems, glossary)
        : { hits: new Map(), misses: sentenceItems, reviewFlags: [] };
      const translationsById = new Map<number, { tgt: string; needsReview: boolean }>();
      let memoryChars = 0;
      let hits = 0;
      for (const item of sentenceItems) {
        const found = lookup.hits.get(item.hash);
        if (found) {
          translationsById.set(item.id, { tgt: found.tgt, needsReview: found.needsReview });
          memoryChars += Array.from(uniqueSentences[item.id]).length;
          hits++;
        }
      }
      const misses = lookup.misses;
      const reserved = misses.reduce((sum, sentence) => sum + Array.from(sentence.text).length, 0);
      let reservation: UsageReservation;
      try {
        reservation = await deps.usage.reserve({ tenantId: auth.tenantId, requestId, n: reserved, source: { kind: 'API', keyId: auth.keyId }, now: date });
      }
      catch (error) {
        if (error instanceof CharacterQuotaExceededError) return apiError(429, 'CHAR_QUOTA_EXCEEDED', 'Tenant đã dùng hết hạn mức ký tự của tháng.', requestId);
        throw error;
      }
      const translatedMisses = new Map<number, { tgt: string; needsReview: boolean }>();
      let machineChars = 0;
      if (misses.length) {
        try {
          const translated = await createTranslator(deps.translate, { maxBytes: MAX_TRANSLATE_BYTES })({
            src: sourceLang,
            tgt: body.target_lang,
            sentences: misses.map(({ id, text }) => ({ id, text })),
            terminologyName: useTerminology ? glossary.terminologyName : null,
            deadlineAt: Date.now() + 25_000,
            concurrency: 4,
          });
          if (translated.pending.length || translated.failed.length || translated.translated.length !== misses.length) {
            throw new Error('TRANSLATE_INCOMPLETE');
          }
          const resultsById = new Map(translated.translated.map((item) => [item.id, item]));
          misses.forEach((item) => {
            const result = resultsById.get(item.id);
            if (!result) throw new Error('TRANSLATE_INCOMPLETE');
            const postCheck = useTerminology
              ? postCheckGlossary(item.text, result.tgt, body.target_lang, glossary)
              : { passed: true, needsReview: false, missingTerms: [] };
            const needsReview = result.needsReview || postCheck.needsReview;
            translationsById.set(item.id, { tgt: result.tgt, needsReview });
            translatedMisses.set(item.id, { tgt: result.tgt, needsReview });
          });
          machineChars = reserved;
        } catch (error) {
          await deps.usage.refund(reservation);
          throw error;
        }
      }
      await deps.usage.settle(reservation, { machineChars, memoryChars, tmHits: hits, tmMisses: misses.length });
      const idBySentence = new Map(uniqueSentences.map((sentence, id) => [sentence, id]));
      const translatedText = pieces.map((piece) => {
        if (piece.kind === 'gap') return piece.text;
        const id = idBySentence.get(piece.text);
        return id === undefined ? piece.text : translationsById.get(id)?.tgt ?? piece.text;
      }).join('');
      const warnings: string[] = [];
      if (useTerminology && lookup.reviewFlags.length) {
        try {
          const flagReport = await tm.markHumanNeedsReview(
            ctx,
            sourceLang,
            body.target_lang,
            lookup.reviewFlags.map((hash) => ({ hash, tgt: lookup.hits.get(hash)!.tgt })),
          );
          if (flagReport.failed.length) warnings.push('TM_REVIEW_FLAG_FAILED');
        } catch {
          warnings.push('TM_REVIEW_FLAG_FAILED');
        }
      }
      if (useTerminology && misses.length) {
        try {
          const report = await tm.putMachineTM(ctx, sourceLang, body.target_lang, misses.map((item) => {
            const translated = translatedMisses.get(item.id);
            if (!translated) throw new Error('TRANSLATE_INCOMPLETE');
            return {
              hash: item.hash,
              sourceText: item.text,
              tgt: translated.tgt,
              glossaryVersion: glossary.version,
              needsReview: translated.needsReview,
            };
          }));
          if (report.failed.length) warnings.push('TM_WRITE_FAILED');
        } catch {
          warnings.push('TM_WRITE_FAILED');
        }
      }
      return realtimeJson(200, { request_id: requestId, source_lang: sourceLang, source_lang_detected: detected, ...(detected ? { detection_confidence: confidence } : {}), target_lang: body.target_lang, translated_text: translatedText, characters_machine_translated: machineChars, characters_from_memory: memoryChars, terminology_version: glossary.version, ...(warnings.length ? { warnings } : {}) });
    } catch (error) {
      if (error instanceof SyntaxError) return apiError(400, 'INVALID_REQUEST', 'JSON không hợp lệ.', requestId);
      if (error instanceof AppError) {
        const status = error.code === 'UNAUTHORIZED' ? 401
          : error.code === 'PERMISSION_DENIED' ? 403
          : error.code === 'TENANT_SUSPENDED' ? 403
          : error.code === 'NOT_FOUND' ? 404
          : 400;
        return apiError(status, error.code, error.message, requestId);
      }
      return apiError(500, 'INTERNAL_ERROR', 'Lỗi tạm thời phía hệ thống.', requestId);
    }
  };
}

/**
 * Khởi tạo các AWS client và chuyển sự kiện đến bộ xử lý realtime production.
 * @param event Sự kiện Lambda/API Gateway cần xử lý.
 * @returns Promise phản hồi HTTP JSON cho yêu cầu dịch.
 */
export const handler = (event: RealtimeEvent): Promise<RealtimeResponse> => {
  const rawPath = (event as RealtimeEvent & { rawPath?: string }).rawPath;
  const resourcePath = (event as RealtimeEvent & { resourcePath?: string }).resourcePath;
  if (rawPath === '/translate/batch/upload-url' || resourcePath === '/translate/batch/upload-url') {
    const tableName = process.env.TABLE_NAME;
    const batchBucket = process.env.BATCH_UPLOAD_BUCKET;
    if (!tableName || !batchBucket) {
      const requestId = event.requestContext?.requestId ?? 'unknown';
      return Promise.resolve(realtimeJson(500, { request_id: requestId, error: { code: 'INTERNAL_ERROR', message: 'Thiếu cấu hình upload batch.' } }));
    }
    const ddb = createTenantDocumentClientRouter(
      DynamoDBDocumentClient.from(new DynamoDBClient(), { marshallOptions: { removeUndefinedValues: true } }),
      { roleArn: process.env.TENANT_DATA_ACCESS_ROLE_ARN, sessionName: 'translate-api' },
    ) as DynamoDBDocumentClient;
    return createBatchUploadUrlHandler({
      tableName,
      batchBucket,
      ddb,
      s3: new S3Client({}),
      tenantS3Client: (tenantId) => createTenantS3Client(
        process.env.TENANT_DATA_ACCESS_ROLE_ARN ?? '',
        tenantId,
        process.env.TENANT_BATCH_UPLOAD_BUCKET_ARN ?? '',
        'batch',
        'batch-upload',
      ) as unknown as S3Client,
    })({
      body: event.body,
      requestContext: event.requestContext,
    }) as Promise<RealtimeResponse>;
  }
  const tableName = process.env.TABLE_NAME;
  if (!tableName) return Promise.resolve(apiError(500, 'INTERNAL_ERROR', 'Thiếu cấu hình bảng dữ liệu.', event.requestContext?.requestId ?? 'unknown'));
  const ddb = createTenantDocumentClientRouter(
    DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } }),
    { roleArn: process.env.TENANT_DATA_ACCESS_ROLE_ARN, sessionName: 'translate-api' },
  ) as DynamoDBDocumentClient;
  const comprehend = new ComprehendClient({});
  const translate = new TranslateClient({ maxAttempts: 3 });
  return createRealtimeHandler({
    tableName,
    ddb,
    usage: new UsageService(ddb, { tableName }),
    translate,
    getGlossaryState: createDynamoGlossaryReader(ddb, tableName),
    detectLanguage: async (text) => {
      const result = await comprehend.send(new DetectDominantLanguageCommand({ Text: truncateUtf8(text, 5000) }));
      const top = result.Languages?.sort((a, b) => (b.Score ?? 0) - (a.Score ?? 0))[0];
      return { language: top?.LanguageCode, confidence: top?.Score };
    },
  })(event);
};
