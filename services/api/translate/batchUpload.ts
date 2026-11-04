import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AppError, type Ctx } from '../../../libs/common/types.js';
import { assertTenantWritable } from '../../../libs/common/tenant.js';

export interface BatchUploadEvent {
  body?: string | null;
  requestContext?: {
    requestId?: string;
    identity?: { apiKeyId?: string };
    authorizer?: { keyId?: string; tenantId?: string };
  };
}

export interface BatchUploadDeps {
  tableName: string;
  batchBucket: string;
  ddb: Pick<DynamoDBDocumentClient, 'send'>;
  s3: Pick<S3Client, 'send'>;
  expiresIn?: number;
  now?: () => Date;
  signUrl?: (client: S3Client, command: PutObjectCommand, options: { expiresIn: number }) => Promise<string>;
  tenantS3Client?: (tenantId: string) => S3Client;
}

export interface BatchUploadResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

function json(statusCode: number, payload: Record<string, unknown>): BatchUploadResponse {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    body: JSON.stringify(payload),
  };
}

function error(statusCode: number, requestId: string, code: string, message: string): BatchUploadResponse {
  return json(statusCode, { request_id: requestId, error: { code, message } });
}

export function createBatchUploadUrlHandler(deps: BatchUploadDeps) {
  return async (event: BatchUploadEvent): Promise<BatchUploadResponse> => {
    const requestId = event.requestContext?.requestId ?? `req-${randomUUID()}`;
    const authorizer = event.requestContext?.authorizer;
    const keyId = authorizer?.keyId ?? event.requestContext?.identity?.apiKeyId;

    try {
      if (!keyId) {
        return error(401, requestId, 'UNAUTHORIZED', 'API key không hợp lệ hoặc không được cung cấp.');
      }

      let tenantId = authorizer?.tenantId;
      if (!tenantId) {
        const key = await deps.ddb.send(new GetCommand({
          TableName: deps.tableName,
          Key: { PK: `TENANT#PLATFORM#KEY#${keyId}`, SK: 'META' },
          ConsistentRead: true,
        }));
        tenantId = typeof key.Item?.tenantId === 'string' ? key.Item.tenantId : undefined;
      }
      if (!tenantId) {
        return error(401, requestId, 'UNAUTHORIZED', 'API key không hợp lệ hoặc không được cung cấp.');
      }

      const ctx: Ctx = { tenantId, via: 'KEYMAP', requestId, keyId };
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

      const body = typeof event.body === 'string' ? JSON.parse(event.body) : null;
      const fileName = typeof body?.fileName === 'string' ? body.fileName.trim() : '';
      const contentType = typeof body?.contentType === 'string' ? body.contentType.trim() : '';
      const extension = fileName.match(/\.([^.]+)$/)?.[1]?.toLowerCase();

      if (!fileName || !/^[a-z0-9_.-]+$/i.test(fileName) || !extension || !['txt', 'csv', 'json', 'xlsx'].includes(extension)) {
        return error(400, requestId, 'INVALID_REQUEST', 'fileName không hợp lệ hoặc định dạng không được hỗ trợ.');
      }
      if (!/^(text\/plain|text\/csv|application\/json|application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet)$/i.test(contentType)) {
        return error(400, requestId, 'INVALID_REQUEST', 'contentType không hợp lệ.');
      }

      const uploadId = randomUUID();
      const objectKey = `batch/${tenantId}/${uploadId}/${fileName}`;
      const command = new PutObjectCommand({
        Bucket: deps.batchBucket,
        Key: objectKey,
        ContentType: contentType,
        Metadata: { tenantId, uploadId },
      });
      const expiresIn = deps.expiresIn ?? 900;
      const signingClient = deps.tenantS3Client?.(tenantId) ?? deps.s3 as S3Client;
      const url = deps.signUrl
        ? await deps.signUrl(signingClient, command, { expiresIn })
        : await getSignedUrl(signingClient, command, { expiresIn });

      return json(200, {
        request_id: requestId,
        uploadId,
        bucket: deps.batchBucket,
        key: objectKey,
        method: 'PUT',
        expiresIn,
        url,
      });
    } catch (caught) {
      if (caught instanceof SyntaxError) {
        return error(400, requestId, 'INVALID_REQUEST', 'JSON không hợp lệ.');
      }
      if (caught instanceof AppError) {
        const statusCode = caught.code === 'UNAUTHORIZED' ? 401
          : caught.code === 'PERMISSION_DENIED' || caught.code === 'TENANT_SUSPENDED' ? 403
          : caught.code === 'NOT_FOUND' ? 404
          : 400;
        return error(statusCode, requestId, caught.code, caught.message);
      }
      return error(500, requestId, 'INTERNAL_ERROR', 'Không thể tạo presigned URL.');
    }
  };
}
