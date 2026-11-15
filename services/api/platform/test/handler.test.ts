import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPlatformHandler } from '../handler.js';

test('Platform routes return tenant summaries only and require PlatformAdmins', async () => {
  const config = {
    GSI1SK: 't_fixture', status: 'ACTIVE', plan: 'Free', charLimit: 50000,
    ownerSub: 'private-sub', sourceText: 'private source', organizationName: 'private name',
  };
  let detailReads = 0;
  let lists = 0;
  const handler = createPlatformHandler({
    db: {
      async get(ctx, key) {
        detailReads++;
        assert.deepEqual(key, { PK: 'TENANT#t_fixture', SK: 'CONFIG' });
        assert.equal(ctx.tenantId, 't_fixture');
        return config;
      },
      async update() { throw new Error('unexpected'); },
    },
    async setStatus() { throw new Error('unexpected'); },
    async list(cursor) {
      lists++;
      assert.equal(cursor, 't_previous');
      return { items: [config], next: 't_fixture' };
    },
  });
  const requestContext = { requestId: 'req-1', authorizer: { claims: { 'cognito:groups': 'PlatformAdmins' } } };
  const detail = {
    requestContext, httpMethod: 'GET', resource: '/platform/tenants/{tenantId}', pathParameters: { tenantId: 't_fixture' },
  };
  const list = { requestContext, httpMethod: 'GET', resource: '/platform/tenants', queryStringParameters: { cursor: 't_previous' } };
  const expected = { tenant_id: 't_fixture', status: 'ACTIVE', plan: 'Free', character_limit: 50000 };
  assert.deepEqual(JSON.parse((await handler(detail)).body), { ...expected, request_id: 'req-1' });
  assert.deepEqual(JSON.parse((await handler(list)).body), { items: [expected], next_cursor: 't_fixture', request_id: 'req-1' });
  assert.equal((await handler({ ...detail, requestContext: { authorizer: { claims: { 'custom:role': 'tenant_admin' } } } })).statusCode, 403);
  assert.equal((await handler({ ...list, requestContext: { authorizer: { claims: {} } } })).statusCode, 403);
  assert.equal((await handler({ ...list, requestContext: {} })).statusCode, 401);
  assert.equal(detailReads, 1);
  assert.equal(lists, 1);
});

test('Platform quota update targets only the tenant in the route', async () => {
  const updates: unknown[] = [];
  const handler = createPlatformHandler({
    db: {
      async get() { throw new Error('unexpected'); },
      async update(ctx, input) { updates.push({ ctx, input }); },
    },
    async setStatus() { throw new Error('unexpected'); },
    async list() { throw new Error('unexpected'); },
  });
  const event = {
    httpMethod: 'PATCH', resource: '/platform/tenants/{tenantId}/limits', pathParameters: { tenantId: 't_fixture' },
    requestContext: { authorizer: { claims: { 'cognito:groups': ['PlatformAdmins'] } } },
  };
  assert.equal((await handler({ ...event, body: '{"character_limit":10,"tenant_id":"t_other"}' })).statusCode, 400);
  assert.equal((await handler({ ...event, body: '{"character_limit":-1}' })).statusCode, 400);
  const result = await handler({ ...event, body: '{"character_limit":0}' });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(updates, [{
    ctx: { tenantId: 't_fixture', via: 'JWT', requestId: 'platform-admin' },
    input: {
      Key: { PK: 'TENANT#t_fixture', SK: 'CONFIG' },
      UpdateExpression: 'SET characterLimit = :limit',
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeValues: { ':limit': 0 },
    },
  }]);
});
