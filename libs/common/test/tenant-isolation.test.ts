import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import { AppError, type Ctx } from '../types.js';

type AttributeValue = { S?: string };
type DynamoRequest = {
  Key?: Record<string, AttributeValue>;
  Item?: Record<string, AttributeValue>;
  KeyConditionExpression?: string;
  ExpressionAttributeValues?: Record<string, AttributeValue>;
  TransactItems?: Array<Record<string, any>>;
};

const TENANT_A = 't_aaaaaaaaaaaaaaaaaaaaaaaa';
const TENANT_B = 't_bbbbbbbbbbbbbbbbbbbbbbbb';
const calls: Array<{ target: string; body: DynamoRequest }> = [];
const oldEnv = {
  AWS_ENDPOINT_URL: process.env.AWS_ENDPOINT_URL,
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
  AWS_REGION: process.env.AWS_REGION,
  TABLE_NAME: process.env.TABLE_NAME,
};

let server: Server;
let dbApi: typeof import('../db.js');

beforeEach(() => {
  calls.length = 0;
});

function context(tenantId: string, via: Ctx['via']): Ctx {
  return { tenantId, via, requestId: `isolation-${via}-${tenantId}` };
}

function assertTenantError(error: unknown): boolean {
  return error instanceof AppError && error.code === 'NOT_FOUND';
}

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
      calls.push({ target, body });
      response.writeHead(200, { 'content-type': 'application/x-amz-json-1.0' });
      response.end('{}');
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address() as AddressInfo;
  process.env.AWS_ENDPOINT_URL = `http://127.0.0.1:${address.port}`;
  process.env.AWS_ACCESS_KEY_ID = 'tenant-isolation-test';
  process.env.AWS_SECRET_ACCESS_KEY = 'tenant-isolation-test';
  process.env.AWS_REGION = 'ap-southeast-1';
  process.env.TABLE_NAME = 'TranslateMe-Isolation-Test';
  dbApi = await import('../db.js');
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  for (const [name, value] of Object.entries(oldEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('QC-11 tenant isolation: 8 positive cases', () => {
  it('01 JWT tenant A reads its CONFIG', async () => {
    await dbApi.db.get(context(TENANT_A, 'JWT'), { PK: `TENANT#${TENANT_A}`, SK: 'CONFIG' });
    assert.match(calls.at(-1)!.target, /\.GetItem$/);
    assert.equal(calls.at(-1)!.body.Key?.PK?.S, `TENANT#${TENANT_A}`);
  });

  it('02 JWT tenant A writes its HOST', async () => {
    await dbApi.db.put(context(TENANT_A, 'JWT'), { PK: `TENANT#${TENANT_A}`, SK: 'HOST#site-a' });
    assert.match(calls.at(-1)!.target, /\.PutItem$/);
    assert.equal(calls.at(-1)!.body.Item?.PK?.S, `TENANT#${TENANT_A}`);
  });

  it('03 JWT tenant A updates its CONFIG', async () => {
    await dbApi.db.update(context(TENANT_A, 'JWT'), {
      Key: { PK: `TENANT#${TENANT_A}`, SK: 'CONFIG' },
      UpdateExpression: 'SET #status = :status',
    });
    assert.match(calls.at(-1)!.target, /\.UpdateItem$/);
    assert.equal(calls.at(-1)!.body.Key?.PK?.S, `TENANT#${TENANT_A}`);
  });

  it('04 JWT tenant A queries its HOST records', async () => {
    await dbApi.db.query(context(TENANT_A, 'JWT'), `TENANT#${TENANT_A}`, 'HOST#');
    assert.match(calls.at(-1)!.target, /\.Query$/);
    assert.equal(calls.at(-1)!.body.ExpressionAttributeValues?.[':pk']?.S, `TENANT#${TENANT_A}`);
  });

  it('05 JWT tenant A writes a same-tenant transaction', async () => {
    await dbApi.db.transact(context(TENANT_A, 'JWT'), [{
      Put: { TableName: 'TranslateMe-Isolation-Test', Item: { PK: `TENANT#${TENANT_A}`, SK: 'HOST#site-a' } },
    }]);
    assert.match(calls.at(-1)!.target, /\.TransactWriteItems$/);
  });

  it('06 KEYMAP tenant A reads its glossary partition', async () => {
    await dbApi.db.get(context(TENANT_A, 'KEYMAP'), { PK: `TENANT#${TENANT_A}#GLOSS`, SK: 'TERM#brand' });
    assert.equal(calls.at(-1)!.body.Key?.PK?.S, `TENANT#${TENANT_A}#GLOSS`);
  });

  it('07 SLUG tenant A reads its website record', async () => {
    await dbApi.db.get(context(TENANT_A, 'SLUG'), { PK: `TENANT#${TENANT_A}`, SK: 'HOST#site-a' });
    assert.equal(calls.at(-1)!.body.Key?.PK?.S, `TENANT#${TENANT_A}`);
  });

  it('08 tenant B remains able to access its own data', async () => {
    await dbApi.db.get(context(TENANT_B, 'JWT'), { PK: `TENANT#${TENANT_B}`, SK: 'CONFIG' });
    assert.equal(calls.at(-1)!.body.Key?.PK?.S, `TENANT#${TENANT_B}`);
  });
});

describe('QC-11 tenant isolation: 8 cross-tenant cases', () => {
  it('01 JWT tenant A cannot read tenant B CONFIG', async () => {
    await assert.rejects(dbApi.db.get(context(TENANT_A, 'JWT'), { PK: `TENANT#${TENANT_B}`, SK: 'CONFIG' }), assertTenantError);
    assert.equal(calls.length, 0);
  });

  it('02 JWT tenant A cannot write tenant B HOST', async () => {
    await assert.rejects(dbApi.db.put(context(TENANT_A, 'JWT'), { PK: `TENANT#${TENANT_B}`, SK: 'HOST#site-b' }), assertTenantError);
    assert.equal(calls.length, 0);
  });

  it('03 JWT tenant A cannot update tenant B CONFIG', async () => {
    await assert.rejects(dbApi.db.update(context(TENANT_A, 'JWT'), {
      Key: { PK: `TENANT#${TENANT_B}`, SK: 'CONFIG' },
      UpdateExpression: 'SET #status = :status',
    }), assertTenantError);
    assert.equal(calls.length, 0);
  });

  it('04 KEYMAP tenant A cannot query tenant B HOST records', async () => {
    await assert.rejects(dbApi.db.query(context(TENANT_A, 'KEYMAP'), `TENANT#${TENANT_B}`, 'HOST#'), assertTenantError);
    assert.equal(calls.length, 0);
  });

  it('05 SLUG tenant A cannot read tenant B website data', async () => {
    await assert.rejects(dbApi.db.get(context(TENANT_A, 'SLUG'), { PK: `TENANT#${TENANT_B}`, SK: 'HOST#site-b' }), assertTenantError);
    assert.equal(calls.length, 0);
  });

  it('06 tenant A cannot transact against tenant B even when mixed with A data', async () => {
    await assert.rejects(dbApi.db.transact(context(TENANT_A, 'JWT'), [
      { Put: { TableName: 'TranslateMe-Isolation-Test', Item: { PK: `TENANT#${TENANT_A}`, SK: 'HOST#site-a' } } },
      { Put: { TableName: 'TranslateMe-Isolation-Test', Item: { PK: `TENANT#${TENANT_B}`, SK: 'HOST#site-b' } } },
    ]), assertTenantError);
    assert.equal(calls.length, 0);
  });

  it('07 tenant A cannot access platform mapping partitions through tenant db methods', async () => {
    await assert.rejects(dbApi.db.get(context(TENANT_A, 'KEYMAP'), { PK: 'TENANT#PLATFORM#KEY#secret', SK: 'META' }), assertTenantError);
    assert.equal(calls.length, 0);
  });

  it('08 a tenant ID that is a textual prefix of another tenant cannot cross the PK boundary', async () => {
    const shortTenant = 't_abc';
    const longerTenant = 't_abc-other';
    await assert.rejects(dbApi.db.get(context(shortTenant, 'JWT'), { PK: `TENANT#${longerTenant}`, SK: 'CONFIG' }), assertTenantError);
    assert.equal(calls.length, 0);
  });
});
