import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { createBatchUploadUrlHandler, type BatchUploadDeps } from '../batchUpload.js';

function setup(options: { locked?: boolean } = {}) {
  const ddb = {
    async send(command: any) {
      assert.ok(command instanceof GetCommand);
      const key = command.input.Key as { SK?: string };
      if (key.SK === 'CONFIG') {
        return { Item: { status: options.locked ? 'LOCKED' : 'ACTIVE' } };
      }
      return { Item: { tenantId: 'tenant-a' } };
    },
  };
  const deps: BatchUploadDeps = {
    tableName: 'TranslateMe',
    batchBucket: 'translateme-uploads',
    ddb: ddb as never,
    s3: {} as never,
    signUrl: async (_client, command, { expiresIn }) => {
      assert.equal(command.input.Bucket, 'translateme-uploads');
      assert.equal((command.input.Key as string).startsWith('batch/tenant-a/'), true);
      assert.equal(expiresIn, 900);
      return 'https://signed.example/upload';
    },
  };
  return deps;
}

describe('POST /translate/batch/upload-url', () => {
  it('tạo presigned URL được tenant xác thực sở hữu', async () => {
    const handler = await createBatchUploadUrlHandler(setup());
    const response = await handler({
      body: JSON.stringify({ fileName: 'documents.csv', contentType: 'text/csv' }),
      requestContext: { requestId: 'req-batch', authorizer: { tenantId: 'tenant-a', keyId: 'key-a' } },
    });
    const payload = JSON.parse(response.body);

    assert.equal(response.statusCode, 200);
    assert.equal(payload.method, 'PUT');
    assert.equal(payload.expiresIn, 900);
    assert.match(payload.key, /^batch\/tenant-a\/.+\/documents\.csv$/);
    assert.equal(payload.url, 'https://signed.example/upload');
  });

  it('yêu cầu API key hợp lệ', async () => {
    const handler = await createBatchUploadUrlHandler(setup());
    const response = await handler({
      body: JSON.stringify({ fileName: 'documents.csv', contentType: 'text/csv' }),
      requestContext: { requestId: 'req-batch' },
    });
    assert.equal(response.statusCode, 401);
    assert.equal(JSON.parse(response.body).error.code, 'UNAUTHORIZED');
  });

  it('chặn tenant LOCKED trước khi tạo URL', async () => {
    const handler = await createBatchUploadUrlHandler(setup({ locked: true }));
    const response = await handler({
      body: JSON.stringify({ fileName: 'documents.csv', contentType: 'text/csv' }),
      requestContext: { requestId: 'req-batch', authorizer: { tenantId: 'tenant-a', keyId: 'key-a' } },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(JSON.parse(response.body).error.code, 'TENANT_SUSPENDED');
  });

  it('từ chối tên file và MIME không được hỗ trợ', async () => {
    const handler = await createBatchUploadUrlHandler(setup());
    const invalid = await handler({
      body: JSON.stringify({ fileName: '../secret.txt', contentType: 'text/plain' }),
      requestContext: { requestId: 'req-batch', authorizer: { tenantId: 'tenant-a', keyId: 'key-a' } },
    });
    const wrongMime = await handler({
      body: JSON.stringify({ fileName: 'secret.txt', contentType: 'application/octet-stream' }),
      requestContext: { requestId: 'req-batch', authorizer: { tenantId: 'tenant-a', keyId: 'key-a' } },
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(wrongMime.statusCode, 400);
  });
});
