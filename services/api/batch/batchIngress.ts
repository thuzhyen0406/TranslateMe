/**
 * Nhận tệp đầu vào cho API dịch batch F10.
 * Cấp presigned PUT 15 phút dưới prefix riêng tenant, xác nhận object thật bằng HeadObject,
 * kiểm tra định dạng/kích thước/hạn mức rồi tạo JOB QUEUED làm đầu vào cho workflow batch.
 * S3 giữ tệp đầu vào tối đa 7 ngày theo lifecycle; file_key và JOB không nhận tenant_id từ body.
 */
import { randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { db } from '../../../libs/common/db.js';
import { AppError, keys, type Ctx } from '../../../libs/common/types.js';
import { monthUtc, usageKeys } from '../../../libs/common/usage/usage.js';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const UPLOAD_URL_TTL_SECONDS = 900;
const RETENTION_DAYS = 7;
const SUPPORTED_LANGUAGES = new Set(['ar', 'de', 'en', 'es', 'fr', 'hi', 'id', 'it', 'ja', 'ko', 'nl', 'pl', 'pt', 'ru', 'sv', 'th', 'tr', 'vi', 'zh']);
const FORMAT_CONTENT_TYPES = {
  txt: 'text/plain',
  html: 'text/html',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
} as const;

type BatchFormat = keyof typeof FORMAT_CONTENT_TYPES;
type BatchDb = Pick<typeof db, 'get' | 'put'>;

/** S3 adapter tối thiểu giúp kiểm tra luồng bằng mock, không phụ thuộc mạng trong unit test. */
export interface BatchObjectStore {
  signPut(input: { bucket: string; key: string; contentType: string; expiresIn: number }): Promise<string>;
  head(input: { bucket: string; key: string }): Promise<{ contentLength?: number; contentType?: string }>;
  get(input: { bucket: string; key: string }): Promise<Uint8Array>;
}

/** Phụ thuộc có thể thay thế trong kiểm thử; DB mặc định vẫn dùng lớp truy cập chung theo tenant. */
export interface BatchIngressDependencies {
  db: BatchDb;
  s3: BatchObjectStore;
  bucket: string;
  resolveTenant(event: BatchIngressEvent, requestId: string): Promise<Ctx | null>;
  now(): Date;
}

/** Các trường API Gateway cần cho route upload-url và tạo JOB. */
export interface BatchIngressEvent {
  httpMethod?: string;
  path?: string;
  rawPath?: string;
  body?: string | null;
  requestContext?: {
    requestId?: string;
    identity?: { apiKeyId?: string };
    authorizer?: {
      keyId?: string;
      tenantId?: string;
      /** Claims do REST API Cognito User Pools Authorizer xác thực và chuyển tiếp. */
      claims?: Record<string, unknown>;
    };
  };
}

/** Chuyển Cognito claims và MEMBER hiện hành thành Ctx; input là claims/DB row, output là Ctx JWT tin cậy. */
export function createBatchSessionContext(
  claims: Record<string, unknown>,
  member: Record<string, any> | null,
  requestId: string,
): Ctx {
  const sub = claims.sub;
  const tenantId = claims['custom:tenant_id'];
  if (typeof sub !== 'string' || !sub || typeof tenantId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(tenantId)) {
    throw new AppError('UNAUTHORIZED', 'Phiên đăng nhập thiếu thông tin tenant hoặc người dùng hợp lệ.');
  }
  if (!member || member.status !== 'ACTIVE' || member.tenantId !== tenantId || member.userSub !== sub) {
    throw new AppError('PERMISSION_DENIED', 'Tài khoản không còn là thành viên đang hoạt động của tenant.');
  }
  const role = member.role;
  return {
    tenantId,
    via: 'JWT',
    requestId,
    sub,
    ...(role === 'TENANT_ADMIN' || role === 'DEVELOPER' || role === 'REVIEWER' ? { role } : {}),
  };
}

/** Lấy đuôi tệp và từ chối tên đường dẫn thay vì tên tệp đơn; input là tên, output là format chuẩn. */
export function validateFileName(fileName: unknown): { fileName: string; format: BatchFormat } {
  if (typeof fileName !== 'string' || !fileName.trim() || fileName.length > 255 || /[\\/\0]/u.test(fileName)) {
    throw new AppError('INVALID_REQUEST', 'file_name phải là tên tệp hợp lệ, không chứa đường dẫn.');
  }
  const clean = fileName.trim();
  const extension = clean.split('.').at(-1)?.toLowerCase();
  if (extension !== 'txt' && extension !== 'html' && extension !== 'docx') {
    throw new AppError('INVALID_REQUEST', 'Chỉ hỗ trợ tệp TXT, HTML hoặc DOCX.');
  }
  return { fileName: clean, format: extension };
}

/** Xác nhận nội dung thật theo format khai báo và ước tính ký tự nguồn; input là bytes/format, output là count. */
export function inspectBatchFile(bytes: Uint8Array, format: BatchFormat): number {
  if (!bytes.length || bytes.length > MAX_FILE_BYTES) {
    throw new AppError('INVALID_REQUEST', 'Tệp rỗng hoặc vượt quá giới hạn 10 MB.');
  }
  if (format === 'docx') return inspectDocx(bytes);

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new AppError('INVALID_REQUEST', 'Tệp văn bản phải được mã hóa UTF-8 hợp lệ.');
  }
  if (text.includes('\0')) throw new AppError('INVALID_REQUEST', 'Tệp văn bản chứa dữ liệu nhị phân.');
  const looksLikeHtml = /<!doctype\s+html|<(?:html|head|body|title|div|span|p|a|img|ul|ol|li|table|h[1-6])(?:\s|\/?>)/iu.test(text);
  if (format === 'html' && !looksLikeHtml) throw new AppError('INVALID_REQUEST', 'Nội dung tệp không phải HTML hợp lệ.');
  if (format === 'txt' && looksLikeHtml) throw new AppError('INVALID_REQUEST', 'Phần mở rộng TXT không khớp nội dung HTML.');
  const sourceText = format === 'html'
    ? decodeHtmlText(text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, ' ').replace(/<[^>]*>/gu, ' '))
    : text;
  return Array.from(sourceText).length;
}

/** Kiểm tra DOCX ZIP an toàn và đếm text node ở document.xml; từ chối DTD, zip bomb và gói giả. */
function inspectDocx(bytes: Uint8Array): number {
  const data = Buffer.from(bytes);
  if (data.length < 22) throw new AppError('INVALID_REQUEST', 'Tệp DOCX không phải gói ZIP hợp lệ.');
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65_557); i--) {
    if (data.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new AppError('INVALID_REQUEST', 'Tệp DOCX không phải gói ZIP hợp lệ.');
  const entries = data.readUInt16LE(eocd + 10);
  let cursor = data.readUInt32LE(eocd + 16);
  if (!entries || entries > 2000) throw new AppError('INVALID_REQUEST', 'Gói DOCX có số mục không hợp lệ.');
  let uncompressedTotal = 0;
  let contentTypes = false;
  let documentXml: Buffer | undefined;
  for (let i = 0; i < entries; i++) {
    if (cursor + 46 > data.length || data.readUInt32LE(cursor) !== 0x02014b50) throw new AppError('INVALID_REQUEST', 'Cấu trúc DOCX bị hỏng.');
    const method = data.readUInt16LE(cursor + 10);
    const compressedSize = data.readUInt32LE(cursor + 20);
    const uncompressedSize = data.readUInt32LE(cursor + 24);
    const nameLength = data.readUInt16LE(cursor + 28);
    const extraLength = data.readUInt16LE(cursor + 30);
    const commentLength = data.readUInt16LE(cursor + 32);
    const localOffset = data.readUInt32LE(cursor + 42);
    const name = data.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    cursor += 46 + nameLength + extraLength + commentLength;
    uncompressedTotal += uncompressedSize;
    if (uncompressedTotal > 50 * 1024 * 1024 || uncompressedSize > Math.max(1, compressedSize) * 100) {
      throw new AppError('INVALID_REQUEST', 'Gói DOCX vượt giới hạn giải nén an toàn.');
    }
    if (name === '[Content_Types].xml') contentTypes = true;
    if (name !== 'word/document.xml') continue;
    if (localOffset + 30 > data.length || data.readUInt32LE(localOffset) !== 0x04034b50) throw new AppError('INVALID_REQUEST', 'Gói DOCX bị hỏng.');
    const localNameLength = data.readUInt16LE(localOffset + 26);
    const localExtraLength = data.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = data.subarray(start, start + compressedSize);
    try {
      documentXml = method === 0 ? Buffer.from(compressed) : method === 8 ? inflateRawSync(compressed, { maxOutputLength: 50 * 1024 * 1024 }) : undefined;
    } catch {
      throw new AppError('INVALID_REQUEST', 'Phần nội dung DOCX bị hỏng.');
    }
    if (!documentXml) throw new AppError('INVALID_REQUEST', 'DOCX sử dụng kiểu nén không hỗ trợ.');
  }
  if (!contentTypes || !documentXml) throw new AppError('INVALID_REQUEST', 'Tệp không có cấu trúc DOCX hợp lệ.');
  const xml = documentXml.toString('utf8');
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) throw new AppError('INVALID_REQUEST', 'DOCX chứa khai báo XML không an toàn.');
  const text = [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/gu)].map((match) => decodeXmlText(match[1])).join('');
  return Array.from(text).length;
}

/** Giải mã entity văn bản XML để phép đếm DOCX không tính độ dài ký hiệu entity. */
function decodeXmlText(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/giu, (_, entity: string) => {
    if (entity[0] === '#') {
      const value = entity[1]?.toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : '';
    }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[entity.toLowerCase()] ?? '';
  });
}

/** Phân tích body JSON object; input là body API Gateway, output là object hoặc lỗi INVALID_REQUEST. */
function parseBody(body: string | null | undefined): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(body ?? '');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid object');
    return value as Record<string, unknown>;
  } catch {
    throw new AppError('INVALID_REQUEST', 'Nội dung JSON không hợp lệ.');
  }
}

/** Tạo bộ xử lý upload-url và POST batch; output là handler API Gateway chuẩn JSON. */
export function createBatchIngressHandler(deps: BatchIngressDependencies) {
  /** Xử lý request batch sau khi xác thực phiên Cognito hoặc API key và phân giải tenant tin cậy. */
  return async (event: BatchIngressEvent): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> => {
    const requestId = event.requestContext?.requestId ?? `req-${randomUUID()}`;
    const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
    const respond = (statusCode: number, payload: Record<string, unknown>) => ({ statusCode, headers, body: JSON.stringify({ request_id: requestId, ...payload }) });
    try {
      const ctx = await deps.resolveTenant(event, requestId);
      if (!ctx) throw new AppError('UNAUTHORIZED', 'Cần phiên đăng nhập hợp lệ hoặc API key hợp lệ.');
      if (ctx.via === 'KEYMAP' && !ctx.keyId) throw new AppError('UNAUTHORIZED', 'API batch yêu cầu API key hợp lệ.');
      if (ctx.via === 'JWT' && !ctx.sub) throw new AppError('UNAUTHORIZED', 'Phiên đăng nhập không có mã người dùng hợp lệ.');
      const config = await deps.db.get(ctx, keys.config(ctx), { consistent: true });
      if (!config || config.status !== 'ACTIVE') throw new AppError('TENANT_SUSPENDED', 'Tenant đang bị tạm khóa.');
      const method = (event.httpMethod ?? 'GET').toUpperCase();
      const path = event.path ?? event.rawPath ?? '';
      const body = parseBody(event.body);

      if (method === 'POST' && /\/translate\/batch\/(?:session\/)?upload-url\/?$/u.test(path)) {
        const file = validateFileName(body.file_name);
        const declaredSize = body.size_bytes;
        if (!Number.isSafeInteger(declaredSize) || Number(declaredSize) < 1 || Number(declaredSize) > MAX_FILE_BYTES) {
          throw new AppError('INVALID_REQUEST', 'size_bytes phải từ 1 byte đến 10 MB.');
        }
        const uploadId = randomUUID();
        const fileKey = `tenant/${ctx.tenantId}/batch/input/${uploadId}.${file.format}`;
        const contentType = FORMAT_CONTENT_TYPES[file.format];
        const expiresAt = new Date(deps.now().getTime() + UPLOAD_URL_TTL_SECONDS * 1000);
        await deps.db.put(ctx, {
          ...keys.batchUpload(ctx, uploadId),
          entityType: 'BATCH_UPLOAD', tenantId: ctx.tenantId, uploadId, fileKey,
          fileName: file.fileName, format: file.format, contentType, declaredSize: Number(declaredSize),
          expiresAt: expiresAt.toISOString(), createdAt: deps.now().toISOString(),
          ttl: Math.floor(expiresAt.getTime() / 1000),
        }, 'attribute_not_exists(PK) AND attribute_not_exists(SK)');
        const uploadUrl = await deps.s3.signPut({ bucket: deps.bucket, key: fileKey, contentType, expiresIn: UPLOAD_URL_TTL_SECONDS });
        return respond(200, {
          file_key: fileKey,
          upload_url: uploadUrl,
          expires_in: UPLOAD_URL_TTL_SECONDS,
          required_headers: { 'Content-Type': contentType },
        });
      }

      if (method === 'POST' && /\/translate\/batch(?:\/session)?\/?$/u.test(path)) {
        const fileKey = typeof body.file_key === 'string' ? body.file_key : '';
        const prefix = `tenant/${ctx.tenantId}/batch/input/`;
        const match = /^tenant\/([A-Za-z0-9_-]{1,128})\/batch\/input\/([0-9a-f-]{36})\.(txt|html|docx)$/u.exec(fileKey);
        if (!match || match[1] !== ctx.tenantId || !fileKey.startsWith(prefix)) throw new AppError('FILE_NOT_UPLOADED', 'Tệp chưa được cấp phát cho tenant hoặc chưa tải lên.');
        const uploadId = match[2];
        const upload = await deps.db.get(ctx, keys.batchUpload(ctx, uploadId), { consistent: true });
        if (!upload || upload.fileKey !== fileKey || new Date(String(upload.expiresAt)).getTime() < deps.now().getTime()) {
          throw new AppError('FILE_NOT_UPLOADED', 'Tệp chưa được tải lên hoặc địa chỉ tải lên đã hết hạn.');
        }
        let head: { contentLength?: number; contentType?: string };
        try {
          head = await deps.s3.head({ bucket: deps.bucket, key: fileKey });
        } catch (error) {
          if (['NotFound', 'NoSuchKey', 'NotFoundException'].includes((error as { name?: string })?.name ?? '') || (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404) {
            throw new AppError('FILE_NOT_UPLOADED', 'Tệp chưa được tải lên hoặc địa chỉ tải lên đã hết hạn.');
          }
          throw error;
        }
        const actualSize = Number(head.contentLength ?? 0);
        if (!actualSize || actualSize > MAX_FILE_BYTES || actualSize !== Number(upload.declaredSize)) {
          throw new AppError('INVALID_REQUEST', 'Kích thước thật của tệp không hợp lệ hoặc vượt quá 10 MB.');
        }
        const format = upload.format as BatchFormat;
        if (head.contentType !== upload.contentType || !Object.hasOwn(FORMAT_CONTENT_TYPES, format)) {
          throw new AppError('INVALID_REQUEST', 'Định dạng tệp không khớp phần mở rộng.');
        }
        const bytes = await deps.s3.get({ bucket: deps.bucket, key: fileKey });
        if (bytes.length !== actualSize || bytes.length > MAX_FILE_BYTES) {
          throw new AppError('INVALID_REQUEST', 'Kích thước tệp đã thay đổi sau khi kiểm tra.');
        }
        const sourceCharacters = inspectBatchFile(bytes, format);
        const targetLangs = body.target_langs;
        if (!Array.isArray(targetLangs) || !targetLangs.length || targetLangs.length > SUPPORTED_LANGUAGES.size ||
            targetLangs.some((lang) => typeof lang !== 'string' || !SUPPORTED_LANGUAGES.has(lang)) ||
            new Set(targetLangs).size !== targetLangs.length) {
          throw new AppError('INVALID_REQUEST', 'target_langs phải là danh sách mã ngôn ngữ hợp lệ, không trùng.');
        }
        if (body.source_lang !== undefined && (typeof body.source_lang !== 'string' || !SUPPORTED_LANGUAGES.has(body.source_lang))) {
          throw new AppError('INVALID_REQUEST', 'source_lang không được hỗ trợ.');
        }
        if (body.send_email !== undefined && typeof body.send_email !== 'boolean') throw new AppError('INVALID_REQUEST', 'send_email phải là boolean.');
        const estimatedCharacters = sourceCharacters * targetLangs.length;
        const limit = Number(config.characterLimit ?? config.charLimit);
        const source = ctx.via === 'JWT' ? { kind: 'CONSOLE' as const } : { kind: 'API' as const, keyId: ctx.keyId! };
        const month = monthUtc(deps.now());
        const usage = await deps.db.get(ctx, usageKeys(ctx.tenantId, month, source).total, { consistent: true });
        if (!Number.isSafeInteger(limit) || limit < 0) throw new AppError('INTERNAL_ERROR', 'Cấu hình hạn mức ký tự của tenant không hợp lệ.');
        const usedCharacters = Number(usage?.machineChars ?? 0);
        if (!Number.isSafeInteger(usedCharacters) || usedCharacters < 0) throw new AppError('INTERNAL_ERROR', 'Bộ đếm sử dụng ký tự của tenant không hợp lệ.');
        if (usedCharacters + estimatedCharacters > limit) {
          throw new AppError('CHAR_QUOTA_EXCEEDED', 'Số ký tự ước tính vượt hạn mức còn lại của tenant.');
        }
        const jobId = `job-${randomUUID()}`;
        const createdAt = deps.now();
        const job = {
          ...keys.job(ctx, jobId), entityType: 'JOB', tenantId: ctx.tenantId,
          jobId, type: 'FILE', status: 'QUEUED', progress: 0,
          fileKey, fileName: upload.fileName, format,
          ...(typeof body.source_lang === 'string' ? { sourceLang: body.source_lang } : {}),
          targetLangs, sendEmail: body.send_email === true, estimatedCharacters, actualCharacters: 0,
          results: [], warnings: [],
          usageSource: ctx.via === 'JWT' ? { type: 'CONSOLE' } : { type: 'API', keyId: ctx.keyId },
          createdAt: createdAt.toISOString(), updatedAt: createdAt.toISOString(),
          ttl: Math.floor(createdAt.getTime() / 1000) + RETENTION_DAYS * 86400,
        };
        await deps.db.put(ctx, job, 'attribute_not_exists(PK) AND attribute_not_exists(SK)');
        return respond(202, { job_id: jobId, status: 'QUEUED', estimated_characters: estimatedCharacters });
      }

      throw new AppError('NOT_FOUND', 'Không tìm thấy endpoint batch.');
    } catch (error) {
      if (error instanceof AppError) {
        const status = error.code === 'UNAUTHORIZED' ? 401 : error.code === 'TENANT_SUSPENDED' || error.code === 'PERMISSION_DENIED' ? 403 : error.code === 'CHAR_QUOTA_EXCEEDED' ? 429 : error.code === 'FILE_NOT_UPLOADED' ? 400 : error.code === 'INVALID_REQUEST' ? 400 : error.code === 'NOT_FOUND' ? 404 : 500;
        return respond(status, { error: { code: error.code, message: error.message } });
      }
      return respond(500, { error: { code: 'INTERNAL_ERROR', message: 'Lỗi tạm thời khi nhận tệp batch.' } });
    }
  };
}

/** Giải mã entity HTML phổ biến để ước tính số ký tự hiển thị thay vì đếm mã entity. */
function decodeHtmlText(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|nbsp|amp|lt|gt|quot|apos);/giu, (_, entity: string) => {
    if (entity[0] === '#') {
      const value = entity[1]?.toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : '';
    }
    return ({ nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[entity.toLowerCase()] ?? '';
  });
}

/** Khởi tạo S3 client AWS SDK v3 dùng lại giữa các lần gọi Lambda. */
const s3Client = new S3Client({});
const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });

/** Phân giải Ctx từ Cognito claims/MEMBER đang hiệu lực hoặc API Gateway API key/KEYMAP. */
async function resolveTenant(event: BatchIngressEvent, requestId: string): Promise<Ctx | null> {
  const claims = event.requestContext?.authorizer?.claims;
  if (claims) {
    const sub = claims.sub;
    const tenantId = claims['custom:tenant_id'];
    if (typeof sub !== 'string' || !sub || typeof tenantId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(tenantId)) {
      throw new AppError('UNAUTHORIZED', 'Phiên đăng nhập thiếu thông tin tenant hoặc người dùng hợp lệ.');
    }
    const sessionCtx: Ctx = { tenantId, via: 'JWT', requestId, sub };
    const member = await db.get(sessionCtx, keys.member(sessionCtx, sub), { consistent: true });
    return createBatchSessionContext(claims, member, requestId);
  }
  const keyId = event.requestContext?.authorizer?.keyId ?? event.requestContext?.identity?.apiKeyId;
  if (!keyId) return null;
  const tableName = process.env.TABLE_NAME;
  if (!tableName) throw new Error('TABLE_NAME is not configured');
  const result = await ddbClient.send(new GetCommand({
    TableName: tableName,
    Key: keys.keymap(keyId), ConsistentRead: true,
  }));
  const tenantId = result.Item?.tenantId;
  return typeof tenantId === 'string' ? { tenantId, via: 'KEYMAP', requestId, keyId } : null;
}

/** Lambda entry point cho upload-url và tạo JOB; cấu hình bucket qua BATCH_BUCKET. */
export async function handler(event: BatchIngressEvent) {
  const bucket = process.env.BATCH_BUCKET;
  if (!bucket || !process.env.TABLE_NAME) {
    return { statusCode: 500, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ request_id: event.requestContext?.requestId ?? 'unknown', error: { code: 'INTERNAL_ERROR', message: 'Thiếu cấu hình batch storage.' } }) };
  }
  return createBatchIngressHandler({
    db,
    bucket,
    now: () => new Date(),
    resolveTenant,
    s3: {
      signPut: ({ bucket: targetBucket, key, contentType, expiresIn }) => getSignedUrl(
        s3Client,
        new PutObjectCommand({ Bucket: targetBucket, Key: key, ContentType: contentType }),
        { expiresIn, signableHeaders: new Set(['content-type']) },
      ),
      async head({ bucket: targetBucket, key }) {
        const result = await s3Client.send(new HeadObjectCommand({ Bucket: targetBucket, Key: key }));
        return { contentLength: result.ContentLength, contentType: result.ContentType };
      },
      async get({ bucket: targetBucket, key }) {
        const result = await s3Client.send(new GetObjectCommand({ Bucket: targetBucket, Key: key }));
        if (!result.Body) throw new Error('S3 object body is empty');
        return result.Body.transformToByteArray();
      },
    },
  })(event);
}
