/**
 * Nhận tệp đầu vào cho API dịch batch F10.
 * Cấp presigned PUT 15 phút dưới prefix riêng tenant, xác nhận object thật bằng HeadObject,
 * kiểm tra định dạng/kích thước/hạn mức rồi tạo JOB QUEUED làm đầu vào cho workflow batch.
 * S3 giữ tệp đầu vào tối đa 7 ngày theo lifecycle; file_key và JOB không nhận tenant_id từ body.
 */
import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { db } from '../../../libs/common/db.js';
import { contextFromIdTokenClaims } from '../auth/context.js';
import { CorruptFile, countChars, FORMAT_PARSERS, parse, UnsupportedFormat } from '../../../libs/common/parsers.js';
import { createTenantDocumentClientRouter, createTenantS3Client } from '../../../libs/common/tenantAws.js';
import { AppError, keys, type Ctx } from '../../../libs/common/types.js';
import { CharacterQuotaExceededError, UsageService, type UsageReservation } from '../../../libs/common/usage/usage.js';
import { createJobStore, newJobId } from '../../../libs/common/jobs.js';

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
type BatchDb = Pick<typeof db, 'get' | 'put' | 'update'>;
type BatchUsage = Pick<UsageService, 'reserve' | 'refund'>;

/** S3 adapter tối thiểu giúp kiểm tra luồng bằng mock, không phụ thuộc mạng trong unit test. */
export interface BatchObjectStore {
  signPut(input: { tenantId: string; bucket: string; key: string; contentType: string; expiresIn: number }): Promise<string>;
  head(input: { tenantId: string; bucket: string; key: string }): Promise<{ contentLength?: number; contentType?: string }>;
  get(input: { tenantId: string; bucket: string; key: string }): Promise<Uint8Array>;
}

/** Phụ thuộc có thể thay thế trong kiểm thử; DB mặc định vẫn dùng lớp truy cập chung theo tenant. */
export interface BatchIngressDependencies {
  db: BatchDb;
  usage: BatchUsage;
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
  const docFormat = extension.toUpperCase() as 'TXT' | 'HTML' | 'DOCX';
  if (!FORMAT_PARSERS[docFormat]) {
    throw new AppError('INVALID_REQUEST', `Chưa có parser ${docFormat} dùng chung trong workflow.`);
  }
  return { fileName: clean, format: extension };
}

/** Dùng chung parser của workflow để xác nhận định dạng và ước tính ký tự các block cần dịch. */
export function inspectBatchFile(bytes: Uint8Array, format: BatchFormat): number {
  if (!bytes.length || bytes.length > MAX_FILE_BYTES) throw new AppError('INVALID_REQUEST', 'Tệp rỗng hoặc vượt quá giới hạn 10 MB.');
  const docFormat = format.toUpperCase() as 'TXT' | 'HTML' | 'DOCX';
  if (!FORMAT_PARSERS[docFormat]) throw new AppError('INVALID_REQUEST', `Parser ${docFormat} chưa được tích hợp vào workflow.`);
  try {
    const parsed = parse(docFormat, bytes, { maxBytes: MAX_FILE_BYTES });
    return parsed.blocks.reduce((total, block) => total + countChars(block.text), 0);
  } catch (error) {
    if (error instanceof CorruptFile || error instanceof UnsupportedFormat) {
      throw new AppError('INVALID_REQUEST', error.message);
    }
    throw error;
  }
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
    const headers = {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    };
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
        const fileKey = `batch/${ctx.tenantId}/input/${uploadId}.${file.format}`;
        const contentType = FORMAT_CONTENT_TYPES[file.format];
        const createdAt = deps.now();
        const uploadUrlExpiresAt = new Date(createdAt.getTime() + UPLOAD_URL_TTL_SECONDS * 1000);
        const retainedUntil = new Date(createdAt.getTime() + RETENTION_DAYS * 86400 * 1000);
        await deps.db.put(ctx, {
          ...keys.batchUpload(ctx, uploadId),
          entityType: 'BATCH_UPLOAD', tenantId: ctx.tenantId, uploadId, fileKey,
          fileName: file.fileName, format: file.format, contentType, declaredSize: Number(declaredSize),
          uploadUrlExpiresAt: uploadUrlExpiresAt.toISOString(),
          expiresAt: retainedUntil.toISOString(), createdAt: createdAt.toISOString(),
          ttl: Math.floor(retainedUntil.getTime() / 1000),
        }, 'attribute_not_exists(PK) AND attribute_not_exists(SK)');
        const uploadUrl = await deps.s3.signPut({ tenantId: ctx.tenantId, bucket: deps.bucket, key: fileKey, contentType, expiresIn: UPLOAD_URL_TTL_SECONDS });
        return respond(200, {
          file_key: fileKey,
          upload_url: uploadUrl,
          expires_in: UPLOAD_URL_TTL_SECONDS,
          required_headers: { 'Content-Type': contentType },
        });
      }

      if (method === 'POST' && /\/translate\/batch(?:\/session)?\/?$/u.test(path)) {
        const fileKey = typeof body.file_key === 'string' ? body.file_key : '';
        const prefix = `batch/${ctx.tenantId}/input/`;
        const match = /^batch\/([A-Za-z0-9_-]{1,128})\/input\/([0-9a-f-]{36})\.(txt|html|docx)$/u.exec(fileKey);
        if (!match || match[1] !== ctx.tenantId || !fileKey.startsWith(prefix)) throw new AppError('FILE_NOT_UPLOADED', 'Tệp chưa được cấp phát cho tenant hoặc chưa tải lên.');
        const uploadId = match[2];
        const upload = await deps.db.get(ctx, keys.batchUpload(ctx, uploadId), { consistent: true });
        if (!upload || upload.fileKey !== fileKey || new Date(String(upload.expiresAt)).getTime() < deps.now().getTime()) {
          throw new AppError('FILE_NOT_UPLOADED', 'Tệp chưa được tải lên hoặc địa chỉ tải lên đã hết hạn.');
        }
        let head: { contentLength?: number; contentType?: string };
        try {
          head = await deps.s3.head({ tenantId: ctx.tenantId, bucket: deps.bucket, key: fileKey });
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
        const bytes = await deps.s3.get({ tenantId: ctx.tenantId, bucket: deps.bucket, key: fileKey });
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
        const source = ctx.via === 'JWT' ? { kind: 'CONSOLE' as const } : { kind: 'API' as const, keyId: ctx.keyId! };
        const jobId = newJobId(deps.now().getTime());
        let reservation: UsageReservation;
        try {
          reservation = await deps.usage.reserve({
            tenantId: ctx.tenantId,
            requestId: jobId,
            n: estimatedCharacters,
            source,
            now: deps.now(),
          });
        } catch (error) {
          if (error instanceof CharacterQuotaExceededError) {
            throw new AppError('CHAR_QUOTA_EXCEEDED', 'Số ký tự ước tính vượt hạn mức còn lại của tenant.');
          }
          throw error;
        }

        try {
          await createJobStore(deps.db, () => deps.now().getTime()).create(ctx, {
            jobId,
            type: 'FILE',
            targetLangs,
            file: {
              fileKey,
              fileName: upload.fileName,
              format,
              ...(typeof body.source_lang === 'string' ? { sourceLang: body.source_lang } : {}),
              sendEmail: body.send_email === true,
              estimatedCharacters,
              usageReservation: reservation,
            },
          });
        } catch (error) {
          try {
            await deps.usage.refund(reservation);
          } catch (refundError) {
            console.error(JSON.stringify({
              level: 'ERROR',
              event: 'BATCH_USAGE_RESERVATION_REFUND_FAILED',
              tenantId: ctx.tenantId,
              jobId,
              request_id: requestId,
              errorName: refundError instanceof Error ? refundError.name : 'UnknownError',
            }));
          }
          throw error;
        }

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

const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const usageDdbClient = createTenantDocumentClientRouter(
  DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } }),
  { roleArn: process.env.TENANT_DATA_ACCESS_ROLE_ARN, sessionName: 'batch-usage' },
) as DynamoDBDocumentClient;
const usageService = new UsageService(usageDdbClient, { tableName: process.env.TABLE_NAME ?? 'translate-data' });
const tenantS3Clients = new Map<string, ReturnType<typeof createTenantS3Client>>();

/** Lấy client S3 STS theo tenant; mỗi client bị giới hạn trong prefix batch riêng của tenant. */
function s3ClientForTenant(tenantId: string): any {
  let client = tenantS3Clients.get(tenantId);
  if (!client) {
    const roleArn = process.env.TENANT_DATA_ACCESS_ROLE_ARN;
    const bucketArn = process.env.TENANT_BATCH_UPLOAD_BUCKET_ARN;
    const kmsKeyArn = process.env.TENANT_BATCH_UPLOAD_KMS_KEY_ARN;
    if (!roleArn || !bucketArn || !kmsKeyArn) throw new Error('Tenant S3 access is not configured');
    client = createTenantS3Client(roleArn, tenantId, bucketArn, 'batch', 'batch-ingress', kmsKeyArn);
    tenantS3Clients.set(tenantId, client);
  }
  return client;
}

/** Phân giải Ctx từ Cognito claims/MEMBER đang hiệu lực hoặc API Gateway API key/KEYMAP. */
async function resolveTenant(event: BatchIngressEvent, requestId: string): Promise<Ctx | null> {
  const claims = event.requestContext?.authorizer?.claims;
  if (claims) return contextFromIdTokenClaims(claims, requestId);
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

/** Lambda entry point cho upload-url và tạo JOB; cấu hình bucket qua BATCH_UPLOAD_BUCKET. */
export async function handler(event: BatchIngressEvent) {
  const bucket = process.env.BATCH_UPLOAD_BUCKET;
  if (!bucket || !process.env.TABLE_NAME || !process.env.TENANT_DATA_ACCESS_ROLE_ARN ||
      !process.env.TENANT_BATCH_UPLOAD_BUCKET_ARN || !process.env.TENANT_BATCH_UPLOAD_KMS_KEY_ARN) {
    return { statusCode: 500, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ request_id: event.requestContext?.requestId ?? 'unknown', error: { code: 'INTERNAL_ERROR', message: 'Thiếu cấu hình batch storage.' } }) };
  }
  return createBatchIngressHandler({
    db,
    usage: usageService,
    bucket,
    now: () => new Date(),
    resolveTenant,
    s3: {
      signPut: ({ tenantId, bucket: targetBucket, key, contentType, expiresIn }) => getSignedUrl(
        s3ClientForTenant(tenantId) as any,
        new PutObjectCommand({ Bucket: targetBucket, Key: key, ContentType: contentType }),
        { expiresIn, signableHeaders: new Set(['content-type']) },
      ),
      async head({ tenantId, bucket: targetBucket, key }) {
        const result = await s3ClientForTenant(tenantId).send(new HeadObjectCommand({ Bucket: targetBucket, Key: key }));
        return { contentLength: result.ContentLength, contentType: result.ContentType };
      },
      async get({ tenantId, bucket: targetBucket, key }) {
        const result = await s3ClientForTenant(tenantId).send(new GetObjectCommand({ Bucket: targetBucket, Key: key })) as any;
        if (!result.Body) throw new Error('S3 object body is empty');
        return result.Body.transformToByteArray();
      },
    },
  })(event);
}
