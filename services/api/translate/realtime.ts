import { createHash, randomUUID } from 'node:crypto';
import { ComprehendClient, DetectDominantLanguageCommand } from '@aws-sdk/client-comprehend';
import { TranslateClient } from '@aws-sdk/client-translate';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchGetCommand, DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { segmentBlock } from '../../../libs/common/segmenter.js';
import { CharacterQuotaExceededError, UsageService, type UsageReservation } from '../../../libs/common/usage/usage.js';
import { translateSentences, type TranslateClientLike } from '../../proxy/translator.js';

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
  now?: () => Date;
}
type Piece = { kind: 'sentence' | 'gap'; text: string };
type Memory = { translated: string; label?: string; glossaryVersion?: number };

/** Tách phần văn bản thành câu và khoảng trắng, giữ nguyên để ráp kết quả không đổi định dạng. */
export function splitPreservingWhitespace(text: string): Piece[] {
  const out: Piece[] = [];
  for (const block of text.split(/(\r?\n+)/)) {
    if (!block) continue;
    if (/^\r?\n+$/.test(block)) { out.push({ kind: 'gap', text: block }); continue; }
    for (const part of segmentBlock(block.normalize('NFC'))) out.push({ kind: part.kind, text: part.text });
  }
  return out;
}

/** Tạo khóa TM dùng chung: chuẩn hóa NFC, gộp khoảng trắng và băm SHA-256. */
export function translationMemoryKey(tenantId: string, sourceLang: string, targetLang: string, sentence: string) {
  const normalized = sentence.normalize('NFC').replace(/\s+/gu, ' ').trim();
  const hash = createHash('sha256').update(normalized, 'utf8').digest('hex');
  return { PK: `TENANT#${tenantId}#TM#${sourceLang}#${targetLang}#${hash.slice(0, 2)}`, SK: `HASH#${hash}` };
}

/** Tạo JSON API thống nhất cho thành công và lỗi, luôn kèm request_id. */
export function realtimeJson(statusCode: number, payload: Record<string, unknown>): RealtimeResponse {
  return { statusCode, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: JSON.stringify(payload) };
}

/** Tạo phản hồi lỗi theo schema Bảng 1.5 của đặc tả. */
function apiError(status: number, code: string, message: string, requestId: string): RealtimeResponse {
  return realtimeJson(status, { request_id: requestId, error: { code, message } });
}

/** Cắt văn bản theo giới hạn byte UTF-8 của Comprehend mà không tách đôi ký tự Unicode. */
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

/** Đọc keyId từ API Gateway authorizer hoặc KEYMAP, sau đó lấy tenantId đáng tin cậy. */
async function resolveTenant(event: RealtimeEvent, deps: RealtimeDeps): Promise<{ tenantId?: string; keyId?: string }> {
  const context = event.requestContext?.authorizer;
  if (context?.tenantId && context.keyId) return { tenantId: context.tenantId, keyId: context.keyId };
  const keyId = context?.keyId ?? event.requestContext?.identity?.apiKeyId;
  if (!keyId) return {};
  const found = await deps.ddb.send(new GetCommand({ TableName: deps.tableName, Key: { PK: `TENANT#PLATFORM#KEY#${keyId}`, SK: 'META' }, ConsistentRead: true }));
  return found.Item?.tenantId ? { tenantId: String(found.Item.tenantId), keyId } : {};
}

/** Tra cứu Translation Memory bằng BatchGetItem và chỉ nhận bản dịch MACHINE/HUMAN còn hiệu lực. */
async function readMemory(deps: RealtimeDeps, keys: Array<{ PK: string; SK: string }>): Promise<Map<string, Memory>> {
  const output = new Map<string, Memory>();
  for (let i = 0; i < keys.length; i += 100) {
    const batch = keys.slice(i, i + 100);
    let pending: Record<string, any> | undefined = { [deps.tableName]: { Keys: batch } };
    for (let attempt = 0; pending && attempt < 5; attempt++) {
      const response = await deps.ddb.send(new BatchGetCommand({ RequestItems: pending }));
      for (const row of response.Responses?.[deps.tableName] ?? []) {
        const key = `${row.PK}|${row.SK}`;
        const translation = row.tgt ?? row.translation;
        if (translation && ['MACHINE', 'HUMAN'].includes(String(row.label))) {
          output.set(key, { translated: String(translation), label: String(row.label), glossaryVersion: Number(row.glossaryVersion ?? 0) });
        }
      }
      pending = response.UnprocessedKeys && Object.keys(response.UnprocessedKeys).length ? response.UnprocessedKeys : undefined;
    }
    if (pending) throw new Error('TM_BATCH_GET_UNPROCESSED');
  }
  return output;
}

/** Ghi các câu dịch máy bằng batch write; không ghi đè nội dung đã được con người duyệt. */
async function writeMemory(deps: RealtimeDeps, rows: Array<Record<string, unknown>>): Promise<void> {
  for (const Item of rows) {
    try {
      await deps.ddb.send(new PutCommand({
        TableName: deps.tableName,
        Item: { ...Item, src: Item.source, tgt: Item.translation, GSI3PK: `TENANT#${String(Item.PK).split('#')[1]}#TM#${String(Item.PK).split('#')[4]}#MACHINE`, GSI3SK: Item.updatedAt },
        ConditionExpression: 'attribute_not_exists(PK) OR #label <> :human',
        ExpressionAttributeNames: { '#label': 'label' },
        ExpressionAttributeValues: { ':human': 'HUMAN' },
      }));
    } catch (error) {
      // Bản dịch do người duyệt trong lúc dịch API được giữ nguyên.
      if ((error as { name?: string }).name !== 'ConditionalCheckFailedException') throw error;
    }
  }
}

/** Xử lý POST realtime theo sáu bước F9: xác thực, nhận diện, TM, dịch, hạch toán và JSON. */
export function createRealtimeHandler(deps: RealtimeDeps) {
  return async (event: RealtimeEvent): Promise<RealtimeResponse> => {
    const requestId = event.requestContext?.requestId ?? `req-${randomUUID()}`;
    try {
      const auth = await resolveTenant(event, deps);
      if (!auth.tenantId || !auth.keyId) return apiError(401, 'UNAUTHORIZED', 'API key không hợp lệ hoặc không được cung cấp.', requestId);
      const config = await deps.ddb.send(new GetCommand({ TableName: deps.tableName, Key: { PK: `TENANT#${auth.tenantId}`, SK: 'CONFIG' }, ConsistentRead: true }));
      if (!config.Item || config.Item.status === 'LOCKED') return apiError(403, 'TENANT_SUSPENDED', 'Tenant đang bị tạm khóa.', requestId);
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
      const pieces = splitPreservingWhitespace(body.text);
      const sentences = pieces.filter((p) => p.kind === 'sentence').map((p) => p.text);
      const useTerminology = body.use_terminology !== false;
      const uniqueSentences = [...new Set(sentences)];
      const keys = uniqueSentences.map((sentence) => translationMemoryKey(auth.tenantId!, sourceLang!, body.target_lang, sentence));
      const keysBySentence = new Map(uniqueSentences.map((sentence, index) => [sentence, keys[index]]));
      const memory = useTerminology ? await readMemory(deps, keys) : new Map<string, Memory>();
      const keyString = (key: { PK: string; SK: string }) => `${key.PK}|${key.SK}`;
      const misses = uniqueSentences.filter((_, i) => !memory.has(keyString(keys[i])));
      const reserved = misses.reduce((sum, sentence) => sum + Array.from(sentence).length, 0);
      const date = (deps.now ?? (() => new Date()))();
      let reservation: UsageReservation;
      try {
        reservation = await deps.usage.reserve({ tenantId: auth.tenantId, requestId, n: reserved, source: { kind: 'API', keyId: auth.keyId }, now: date });
      }
      catch (error) {
        if (error instanceof CharacterQuotaExceededError) return apiError(429, 'CHAR_QUOTA_EXCEEDED', 'Tenant đã dùng hết hạn mức ký tự của tháng.', requestId);
        throw error;
      }
      let translatedMisses: string[] = [];
      let machineChars = 0;
      if (misses.length) {
        try {
          const translated = await translateSentences(deps.translate, misses, { sourceLang, targetLang: body.target_lang, deadline: Date.now() + 25_000, maxBytes: MAX_TRANSLATE_BYTES, terminologyNames: useTerminology ? [`tm-${auth.tenantId}`] : [] });
          if (translated.untranslated || translated.translations.some((item) => item === undefined)) throw new Error('TRANSLATE_INCOMPLETE');
          translatedMisses = translated.translations as string[];
          machineChars = reserved;
        } catch (error) {
          await deps.usage.refund(reservation);
          throw error;
        }
      }
      const translations = new Map<string, string>();
      const writes: Array<Record<string, unknown>> = [];
      let missIndex = new Map(misses.map((sentence, index) => [sentence, translatedMisses[index]]));
      let memoryChars = 0;
      let hits = 0;
      for (let i = 0; i < uniqueSentences.length; i++) {
        const key = keys[i];
        const found = memory.get(keyString(key));
        if (found) { translations.set(keyString(key), found.translated); memoryChars += Array.from(uniqueSentences[i]).length; hits++; }
        else {
          const translation = missIndex.get(uniqueSentences[i])!;
          translations.set(keyString(key), translation);
          if (useTerminology) writes.push({ ...key, source: uniqueSentences[i].normalize('NFC'), translation, label: 'MACHINE', glossaryVersion: Number(config.Item.glossaryVersion ?? 0), updatedAt: date.toISOString() });
        }
      }
      if (writes.length) await writeMemory(deps, writes);
      await deps.usage.settle(reservation, { machineChars, memoryChars, tmHits: hits, tmMisses: misses.length });
      const translatedText = pieces.map((piece) => piece.kind === 'gap' ? piece.text : translations.get(keyString(keysBySentence.get(piece.text)!)) ?? piece.text).join('');
      return realtimeJson(200, { request_id: requestId, source_lang: sourceLang, source_lang_detected: detected, ...(detected ? { detection_confidence: confidence } : {}), target_lang: body.target_lang, translated_text: translatedText, characters_machine_translated: machineChars, characters_from_memory: memoryChars, terminology_version: Number(config.Item.glossaryVersion ?? 0) });
    } catch (error) {
      if (error instanceof SyntaxError) return apiError(400, 'INVALID_REQUEST', 'JSON không hợp lệ.', requestId);
      return apiError(500, 'INTERNAL_ERROR', 'Lỗi tạm thời phía hệ thống.', requestId);
    }
  };
}

/** Tạo Lambda handler production với AWS SDK v3 và biến môi trường của dịch vụ API. */
export const handler = (event: RealtimeEvent): Promise<RealtimeResponse> => {
  const tableName = process.env.TABLE_NAME;
  if (!tableName) return Promise.resolve(apiError(500, 'INTERNAL_ERROR', 'Thiếu cấu hình bảng dữ liệu.', event.requestContext?.requestId ?? 'unknown'));
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  const comprehend = new ComprehendClient({});
  const translate = new TranslateClient({ maxAttempts: 3 });
  return createRealtimeHandler({ tableName, ddb, usage: new UsageService(ddb, { tableName }), translate, detectLanguage: async (text) => {
    const result = await comprehend.send(new DetectDominantLanguageCommand({ Text: truncateUtf8(text, 5000) }));
    const top = result.Languages?.sort((a, b) => (b.Score ?? 0) - (a.Score ?? 0))[0];
    return { language: top?.LanguageCode, confidence: top?.Score };
  } })(event);
};
