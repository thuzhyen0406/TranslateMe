import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import { AppError, keys, type Ctx } from '../types.js';

type AttributeValue = { S?: string; N?: string };
type DynamoRequest = {
  Key?: Record<string, AttributeValue>;
  Item?: Record<string, AttributeValue>;
  ConsistentRead?: boolean;
  KeyConditionExpression?: string;
  UpdateExpression?: string;
  ExpressionAttributeValues?: Record<string, AttributeValue>;
  ExpressionAttributeNames?: Record<string, string>;
  ConditionExpression?: string;
  TransactItems?: Array<Record<string, unknown>>;
};

const requests: Array<{ target: string; body: DynamoRequest }> = [];
let server: Server;
let dbApi: typeof import('../db.js');
let slugExists = true;
let configStatus = 'ACTIVE';
const previousEnvironment = {
  AWS_ENDPOINT_URL: process.env.AWS_ENDPOINT_URL,
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
  AWS_REGION: process.env.AWS_REGION,
};

const ctx: Ctx = {
  tenantId: 'tenant-1',
  via: 'JWT',
  requestId: 'test-request',
};

before(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as DynamoRequest;
      const target = request.headers['x-amz-target'];
      if (typeof target !== 'string') {
        response.writeHead(400);
        response.end();
        return;
      }
      requests.push({ target, body });

      let result: Record<string, unknown> = {};
      if (target.endsWith('.GetItem')) {
        const pk = body.Key?.PK?.S;
        const sk = body.Key?.SK?.S;
        if (pk?.startsWith('TENANT#PLATFORM#SLUG#')) {
          result = slugExists ? { Item: { tenantId: { S: 'tenant-1' } } } : {};
        } else if (sk?.startsWith('HOST#')) {
          result = { Item: { PK: { S: 'TENANT#tenant-1' }, SK: { S: sk }, hostname: { S: 'example.test' } } };
        } else if (sk === 'CONFIG') {
          result = { Item: { PK: { S: 'TENANT#tenant-1' }, SK: { S: 'CONFIG' }, status: { S: configStatus } } };
        } else if (sk === 'GET') {
          result = { Item: { PK: { S: 'TENANT#tenant-1' }, SK: { S: 'GET' }, value: { S: 'found' } } };
        }
      } else if (target.endsWith('.Query')) {
        result = { Items: [{ PK: { S: 'TENANT#tenant-1' }, SK: { S: 'HOST#one' } }] };
      }

      response.writeHead(200, { 'content-type': 'application/x-amz-json-1.0' });
      response.end(JSON.stringify(result));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  process.env.AWS_ENDPOINT_URL = `http://127.0.0.1:${address.port}`;
  process.env.AWS_ACCESS_KEY_ID = 'test-access-key';
  process.env.AWS_SECRET_ACCESS_KEY = 'test-secret-key';
  process.env.AWS_REGION = 'us-east-1';

  dbApi = await import('../db.js');
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  for (const [name, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

beforeEach(() => {
  requests.length = 0;
  slugExists = true;
  configStatus = 'ACTIVE';
});

describe('types.ts', () => {
  it('AppError giữ code, message, details và tên lỗi', () => {
    const error = new AppError('FORBIDDEN', 'Không được phép', { tenantId: 'tenant-1' });

    assert.ok(error instanceof Error);
    assert.equal(error.name, 'AppError');
    assert.equal(error.code, 'FORBIDDEN');
    assert.equal(error.message, 'Không được phép');
    assert.deepEqual(error.details, { tenantId: 'tenant-1' });
  });

  it('tạo đúng partition key và sort key cho các loại bản ghi', () => {
    assert.deepEqual(keys.config(ctx), { PK: 'TENANT#tenant-1', SK: 'CONFIG' });
    assert.deepEqual(keys.host(ctx, 'demo'), { PK: 'TENANT#tenant-1', SK: 'HOST#demo' });
    assert.deepEqual(keys.slug('demo'), { PK: 'TENANT#PLATFORM#SLUG#demo', SK: 'META' });
    assert.deepEqual(keys.keymap('key-1'), { PK: 'TENANT#PLATFORM#KEY#key-1', SK: 'META' });
  });
});

describe('db.ts', () => {
  it('get trả bản ghi nếu tìm thấy và null nếu không tìm thấy', async () => {
    assert.deepEqual(await dbApi.db.get(ctx, { PK: 'TENANT#tenant-1', SK: 'GET' }), {
      PK: 'TENANT#tenant-1',
      SK: 'GET',
      value: 'found',
    });
    assert.equal(await dbApi.db.get(ctx, { PK: 'TENANT#tenant-1', SK: 'MISSING' }), null);
    assert.equal(requests.length, 2);
  });

  it('put gửi bản ghi và điều kiện tùy chọn tới DynamoDB', async () => {
    await dbApi.db.put(
      ctx,
      { PK: 'TENANT#tenant-1', SK: 'CONFIG', status: 'ACTIVE' },
      'attribute_not_exists(PK)',
    );

    assert.equal(requests[0].target.endsWith('.PutItem'), true);
    assert.equal(requests[0].body.Item?.status.S, 'ACTIVE');
    assert.equal(requests[0].body.ConditionExpression, 'attribute_not_exists(PK)');
  });

  it('updateSiteStatus chỉ đổi trạng thái nếu trạng thái hiện tại khớp', async () => {
    await dbApi.db.updateSiteStatus(ctx, 'demo', 'PAUSED', 'ACTIVE');

    const request = requests[0];
    assert.equal(request.target.endsWith('.UpdateItem'), true);
    assert.deepEqual(request.body.Key, {
      PK: { S: 'TENANT#tenant-1' },
      SK: { S: 'HOST#demo' },
    });
    assert.equal(request.body.UpdateExpression, 'SET #status = :next, updatedAt = :updatedAt');
    assert.equal(request.body.ConditionExpression, 'attribute_exists(PK) AND #status = :expected');
    assert.deepEqual(request.body.ExpressionAttributeNames, { '#status': 'status' });
    assert.deepEqual({
      ':expected': request.body.ExpressionAttributeValues?.[':expected'],
      ':next': request.body.ExpressionAttributeValues?.[':next'],
    }, {
      ':expected': { S: 'PAUSED' },
      ':next': { S: 'ACTIVE' },
    });
    assert.equal(typeof request.body.ExpressionAttributeValues?.[':updatedAt']?.S, 'string');
  });

  it('query gửi partition key và tùy chọn sort-key prefix', async () => {
    const items = await dbApi.db.query(ctx, 'TENANT#tenant-1', 'HOST#');

    assert.deepEqual(items, [{ PK: 'TENANT#tenant-1', SK: 'HOST#one' }]);
    assert.equal(requests[0].body.KeyConditionExpression, 'PK = :pk AND begins_with(SK, :skPrefix)');
    assert.deepEqual(requests[0].body.ExpressionAttributeValues, {
      ':pk': { S: 'TENANT#tenant-1' },
      ':skPrefix': { S: 'HOST#' },
    });

    await dbApi.db.query(ctx, 'TENANT#tenant-1');
    assert.equal(requests[1].body.KeyConditionExpression, 'PK = :pk');
  });

  it('từ chối đọc, ghi và query partition key thuộc tenant khác', async () => {
    await assert.rejects(
      dbApi.db.get(ctx, { PK: 'TENANT#other-tenant', SK: 'CONFIG' }),
      (error: unknown) => error instanceof AppError && error.code === 'NOT_FOUND',
    );
    await assert.rejects(
      dbApi.db.put(ctx, { PK: 'TENANT#other-tenant', SK: 'CONFIG' }),
      (error: unknown) => error instanceof AppError && error.code === 'NOT_FOUND',
    );
    await assert.rejects(
      dbApi.db.query(ctx, 'TENANT#other-tenant'),
      (error: unknown) => error instanceof AppError && error.code === 'NOT_FOUND',
    );
    assert.equal(requests.length, 0);
  });

  it('từ chối tenant có ID chỉ khác phần hậu tố của ID hiện tại', async () => {
    await assert.rejects(
      dbApi.db.get(ctx, { PK: 'TENANT#tenant-10', SK: 'CONFIG' }),
      (error: unknown) => error instanceof AppError && error.code === 'NOT_FOUND',
    );
    assert.equal(requests.length, 0);
  });

  it('trả NOT_FOUND khi tenant rỗng hoặc dùng namespace nền tảng', async () => {
    for (const tenantId of ['', 'PLATFORM']) {
      await assert.rejects(
        dbApi.db.get({ ...ctx, tenantId }, { PK: `TENANT#${tenantId}`, SK: 'CONFIG' }),
        (error: unknown) => error instanceof AppError && error.code === 'NOT_FOUND',
      );
    }
    assert.equal(requests.length, 0);
  });

  it('transact cho phép thao tác cùng tenant nhưng từ chối thao tác tenant khác', async () => {
    const operation = {
      Put: {
        TableName: 'translate-data',
        Item: { PK: 'TENANT#tenant-1', SK: 'CONFIG', status: 'ACTIVE' },
      },
    };
    await dbApi.db.transact(ctx, [operation]);
    assert.equal(requests[0].target.endsWith('.TransactWriteItems'), true);

    await dbApi.db.transact(ctx, [{
      Put: {
        TableName: 'translate-data',
        Item: { PK: 'TENANT#PLATFORM#SLUG#demo', SK: 'META', tenantId: ctx.tenantId },
      },
    }], { platformSlugReservation: true });
    assert.equal(requests[1].target.endsWith('.TransactWriteItems'), true);

    await assert.rejects(
      dbApi.db.transact(ctx, [{
        Put: {
          TableName: 'translate-data',
          Item: { PK: 'TENANT#other-tenant', SK: 'CONFIG' },
        },
      }]),
      (error: unknown) => error instanceof AppError && error.code === 'NOT_FOUND',
    );
    assert.equal(requests.length, 2);
  });

  it('resolveFromSlug trả null khi slug chưa tồn tại', async () => {
    slugExists = false;

    assert.equal(await dbApi.resolveFromSlug('unknown'), null);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.ConsistentRead, true);
  });

  it('resolveFromSlug trả context, host và config khi tenant hoạt động', async () => {
    const result = await dbApi.resolveFromSlug('demo');

    assert.deepEqual(result, {
      ctx: { tenantId: 'tenant-1', via: 'SLUG', requestId: 'internal', slug: 'demo' },
      host: { PK: 'TENANT#tenant-1', SK: 'HOST#demo', hostname: 'example.test' },
      config: { PK: 'TENANT#tenant-1', SK: 'CONFIG', status: 'ACTIVE' },
    });
    assert.equal(requests.length, 3);
    assert.equal(requests[0].body.ConsistentRead, true);
  });

  it('resolveFromSlug báo TENANT_SUSPENDED khi tenant bị khóa', async () => {
    configStatus = 'LOCKED';

    await assert.rejects(
      dbApi.resolveFromSlug('demo'),
      (error: unknown) => error instanceof AppError && error.code === 'TENANT_SUSPENDED',
    );
    assert.equal(requests.length, 3);
  });
});
