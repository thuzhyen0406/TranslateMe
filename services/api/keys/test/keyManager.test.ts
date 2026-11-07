import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError, keys, type Ctx } from '../../../../libs/common/types.js';
import {
  changeApiKeyPlan,
  createApiKey,
  handleApiKeyRoute,
  listApiKeys,
  revokeApiKey,
  rotateApiKey,
  type ApiGatewayKeyAdmin,
  type ApiKeyManagerDependencies,
} from '../keyManager.js';

const TABLE_CTX: Ctx = {
  tenantId: 't1',
  sub: 'user-1',
  role: 'TENANT_ADMIN',
  via: 'JWT',
  requestId: 'req-test',
};
const OTHER_TENANT_CTX: Ctx = { ...TABLE_CTX, tenantId: 't2' };
const NOW = new Date('2026-11-01T10:00:00.000Z');

type Item = Record<string, any>;
type Operation = Record<string, any>;
type StoredItem = Item & { PK: string; SK: string };

function createHarness(options: {
  tenantPlan?: string;
  configStatus?: string;
  memberStatus?: string;
  memberRole?: string;
  memberExists?: boolean;
  failDisable?: boolean;
  fail?: 'attach' | 'enable' | 'detach' | 'dbUpdate' | 'transaction';
  failCleanup?: boolean;
} = {}) {
  const store = new Map<string, Item>();
  const dbCalls: Array<{ operation: string; args: unknown[] }> = [];
  const gatewayCalls: Array<{ operation: string; args: unknown[] }> = [];
  const logErrors: Array<Record<string, unknown>> = [];
  let createdKeys = 0;
  let fail = options.fail;

  const id = (key: { PK: string; SK: string }) => `${key.PK}|${key.SK}`;
  const configKey = keys.config(TABLE_CTX);
  store.set(id(configKey), {
    ...configKey,
    tenantId: TABLE_CTX.tenantId,
    plan: options.tenantPlan ?? 'Pro',
    status: options.configStatus ?? 'ACTIVE',
  });
  if (options.memberExists !== false) {
    const memberKey = keys.member(TABLE_CTX, TABLE_CTX.sub!);
    store.set(id(memberKey), {
      ...memberKey,
      tenantId: TABLE_CTX.tenantId,
      userSub: TABLE_CTX.sub,
      role: options.memberRole ?? 'Tenant Admin',
      status: options.memberStatus ?? 'ACTIVE',
    });
  }

  const db = {
    async get(_ctx: Ctx, key: { PK: string; SK: string }) {
      dbCalls.push({ operation: 'get', args: [key] });
      const item = store.get(id(key));
      return item ? { ...item } : null;
    },
    async query(_ctx: Ctx, pk: string, skPrefix: string) {
      dbCalls.push({ operation: 'query', args: [pk, skPrefix] });
      return [...store.values()]
        .filter((item) => item.PK === pk && String(item.SK).startsWith(skPrefix))
        .map((item) => ({ ...item }));
    },
    async update(_ctx: Ctx, params: Item) {
      dbCalls.push({ operation: 'update', args: [params] });
      if (fail === 'dbUpdate') {
        fail = undefined;
        throw new Error('DynamoDB update failed');
      }
      const key = params.Key as { PK: string; SK: string };
      const item = store.get(id(key));
      if (!item) throw new Error('Item not found');
      const values = params.ExpressionAttributeValues ?? {};
      if (params.UpdateExpression.includes(':active')) item.status = values[':active'];
      if (params.UpdateExpression.includes(':newPlan')) item.plan = values[':newPlan'];
      if (values[':now']) item.updatedAt = values[':now'];
      store.set(id(key), item);
    },
    async transactApiKey(_ctx: Ctx, operations: Operation[]) {
      dbCalls.push({ operation: 'transactApiKey', args: [operations] });
      if (fail === 'transaction') {
        fail = undefined;
        throw new Error('DynamoDB transaction failed');
      }
      const staged = new Map<string, Item>();
      for (const [key, item] of store) staged.set(key, { ...item });
      for (const operation of operations) {
        if (operation.Put) {
          const item = operation.Put.Item as StoredItem;
          staged.set(id(item), { ...item });
        } else if (operation.Update) {
          const update = operation.Update;
          const key = update.Key as { PK: string; SK: string };
          const item = staged.get(id(key)) ?? { ...key };
          const values = update.ExpressionAttributeValues ?? {};
          if (update.UpdateExpression.includes(':revoked')) item.status = values[':revoked'];
          if (values[':now']) item.revokedAt = values[':now'];
          staged.set(id(key), item);
        } else if (operation.Delete) {
          staged.delete(id(operation.Delete.Key));
        }
      }
      store.clear();
      for (const [key, item] of staged) store.set(key, item);
    },
  };

  const apiGateway: ApiGatewayKeyAdmin = {
    async createApiKey(input) {
      gatewayCalls.push({ operation: 'createApiKey', args: [input] });
      createdKeys++;
      return { id: `gw-key-${createdKeys}`, value: `secret-value-${createdKeys}` };
    },
    async attachKey(keyId, planId) {
      gatewayCalls.push({ operation: 'attachKey', args: [keyId, planId] });
      if (fail === 'attach') throw new Error('Usage plan attach failed');
    },
    async detachKey(keyId, planId) {
      gatewayCalls.push({ operation: 'detachKey', args: [keyId, planId] });
      if (fail === 'detach') {
        fail = undefined;
        throw new Error('Usage plan detach failed');
      }
    },
    async setKeyEnabled(keyId, enabled) {
      gatewayCalls.push({ operation: 'setKeyEnabled', args: [keyId, enabled] });
      if (enabled && fail === 'enable') throw new Error('API key enable failed');
      if (!enabled && options.failDisable) throw new Error('API key revoke disable failed');
      if (!enabled && options.failCleanup) throw new Error('API key disable cleanup failed');
    },
    async deleteApiKey(keyId) {
      gatewayCalls.push({ operation: 'deleteApiKey', args: [keyId] });
    },
  };

  const deps: ApiKeyManagerDependencies = {
    db: db as unknown as ApiKeyManagerDependencies['db'],
    apiGateway,
    usagePlanIds: { Basic: 'plan-basic', Standard: 'plan-standard' },
    now: () => new Date(NOW),
    logger: { error: (entry) => logErrors.push(entry) },
  };

  function seedKey(keyId: string, overrides: Item = {}) {
    const key = {
      ...keys.apiKey(TABLE_CTX, keyId),
      entityType: 'APIKEY',
      tenantId: TABLE_CTX.tenantId,
      keyId,
      name: 'Production',
      plan: 'Basic',
      last4: '1234',
      status: 'ACTIVE',
      createdAt: NOW.toISOString(),
      ...overrides,
    };
    store.set(id(key), key);
    store.set(id(keys.keymap(keyId)), {
      ...keys.keymap(keyId),
      tenantId: TABLE_CTX.tenantId,
      createdAt: NOW.toISOString(),
    });
    return key;
  }

  return { deps, store, dbCalls, gatewayCalls, logErrors, seedKey, get createdKeys() { return createdKeys; } };
}

async function assertAppError(action: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(action, (error: unknown) =>
    error instanceof AppError && error.code === code,
  );
}

describe('API key manager', () => {
  it('creates an API key, persists only its suffix, and returns its secret once', async () => {
    const harness = createHarness();
    const result = await createApiKey(TABLE_CTX, { name: '  Server key  ', plan: 'Basic' }, harness.deps);

    assert.deepEqual(result, {
      key: {
        key_id: 'gw-key-1',
        name: 'Server key',
        plan: 'Basic',
        status: 'ACTIVE',
        last4: 'ue-1',
        created_at: NOW.toISOString(),
      },
      value: 'secret-value-1',
    });
    const local = harness.store.get(`${keys.apiKey(TABLE_CTX, 'gw-key-1').PK}|${keys.apiKey(TABLE_CTX, 'gw-key-1').SK}`);
    assert.equal(local?.status, 'ACTIVE');
    assert.equal(local?.last4, 'ue-1');
    assert.equal('value' in (local ?? {}), false);
    assert.deepEqual(harness.store.get(`${keys.keymap('gw-key-1').PK}|${keys.keymap('gw-key-1').SK}`)?.tenantId, TABLE_CTX.tenantId);
    assert.deepEqual(harness.gatewayCalls.map((call) => call.operation), [
      'createApiKey', 'attachKey', 'setKeyEnabled',
    ]);
  });

  it('rejects unauthorized roles, non-JWT contexts, inactive tenants, and invalid plans', async () => {
    const harness = createHarness();
    await assertAppError(
      () => createApiKey({ ...TABLE_CTX, via: 'KEYMAP' }, { name: 'key', plan: 'Basic' }, harness.deps),
      'UNAUTHORIZED',
    );
    await assertAppError(
      () => createApiKey({ ...TABLE_CTX, role: 'REVIEWER' }, { name: 'key', plan: 'Basic' }, harness.deps),
      'PERMISSION_DENIED',
    );
    await assertAppError(
      () => createApiKey(TABLE_CTX, { name: 'key', plan: 'Standard' }, createHarness({ tenantPlan: 'Free' }).deps),
      'INVALID_REQUEST',
    );
    await assertAppError(
      () => createApiKey(TABLE_CTX, { name: '  ', plan: 'Basic' }, harness.deps),
      'INVALID_REQUEST',
    );
    await assertAppError(
      () => createApiKey(TABLE_CTX, { name: 'key', plan: 'Basic' }, createHarness({ configStatus: 'LOCKED' }).deps),
      'TENANT_SUSPENDED',
    );
    assert.equal(harness.gatewayCalls.length, 0);
  });

  it('rejects create and rotate when the current MEMBER is missing, inactive, or has a changed role', async () => {
    const removedMember = createHarness({ memberExists: false });
    await assertAppError(
      () => createApiKey(TABLE_CTX, { name: 'key', plan: 'Basic' }, removedMember.deps),
      'PERMISSION_DENIED',
    );

    const inactiveMember = createHarness({ memberStatus: 'REVOKED' });
    inactiveMember.seedKey('key-to-rotate');
    await assertAppError(
      () => rotateApiKey(TABLE_CTX, 'key-to-rotate', inactiveMember.deps),
      'PERMISSION_DENIED',
    );

    const changedRole = createHarness({ memberRole: 'Reviewer' });
    await assertAppError(
      () => createApiKey(TABLE_CTX, { name: 'key', plan: 'Basic' }, changedRole.deps),
      'PERMISSION_DENIED',
    );
    await assertAppError(
      () => createApiKey({ ...TABLE_CTX, sub: undefined }, { name: 'key', plan: 'Basic' }, createHarness().deps),
      'PERMISSION_DENIED',
    );
    assert.equal(removedMember.gatewayCalls.length, 0);
    assert.equal(inactiveMember.gatewayCalls.length, 0);
    assert.equal(changedRole.gatewayCalls.length, 0);
  });

  it('requires configured Usage Plan IDs and compensates a failed provisioning operation', async () => {
    const missingPlan = createHarness();
    missingPlan.deps.usagePlanIds.Basic = '';
    await assertAppError(
      () => createApiKey(TABLE_CTX, { name: 'key', plan: 'Basic' }, missingPlan.deps),
      'INTERNAL_ERROR',
    );
    assert.equal(missingPlan.gatewayCalls.length, 0);

    const failedProvision = createHarness({ fail: 'enable' });
    await assertAppError(
      () => createApiKey(TABLE_CTX, { name: 'key', plan: 'Basic' }, failedProvision.deps),
      'INTERNAL_ERROR',
    );
    assert.equal(failedProvision.store.has(`${keys.apiKey(TABLE_CTX, 'gw-key-1').PK}|${keys.apiKey(TABLE_CTX, 'gw-key-1').SK}`), false);
    assert.equal(failedProvision.store.has(`${keys.keymap('gw-key-1').PK}|${keys.keymap('gw-key-1').SK}`), false);
    assert.ok(failedProvision.gatewayCalls.some((call) => call.operation === 'deleteApiKey'));
    assert.ok(failedProvision.logErrors.some((entry) =>
      entry.action === 'API_KEY_PROVISION_FAILED' && entry.keyId === 'gw-key-1' && entry.request_id === TABLE_CTX.requestId,
    ));
    assert.equal(JSON.stringify(failedProvision.logErrors).includes('secret-value'), false);
  });

  it('logs cleanup failures with key and request identifiers without logging the key value', async () => {
    const failedCleanup = createHarness({ fail: 'enable', failCleanup: true });
    await assertAppError(
      () => createApiKey(TABLE_CTX, { name: 'key', plan: 'Basic' }, failedCleanup.deps),
      'INTERNAL_ERROR',
    );
    assert.ok(failedCleanup.logErrors.some((entry) =>
      entry.action === 'API_KEY_CLEANUP_DISABLE_FAILED' && entry.errorName === 'Error' &&
      entry.keyId === 'gw-key-1' && entry.request_id === TABLE_CTX.requestId,
    ));
    assert.equal(JSON.stringify(failedCleanup.logErrors).includes('secret-value'), false);
  });

  it('lists safe summaries without exposing key secrets', async () => {
    const harness = createHarness();
    harness.seedKey('key-1', { value: 'must-not-leak' });
    const result = await listApiKeys(TABLE_CTX, harness.deps);

    assert.deepEqual(result, [{
      key_id: 'key-1',
      name: 'Production',
      plan: 'Basic',
      status: 'ACTIVE',
      last4: '1234',
      created_at: NOW.toISOString(),
    }]);
    assert.equal(JSON.stringify(result).includes('must-not-leak'), false);
  });

  it('rotates an active key and links the new key to the old key', async () => {
    const harness = createHarness();
    harness.seedKey('old-key');
    const result = await rotateApiKey(TABLE_CTX, 'old-key', harness.deps);

    assert.equal(result.key.rotated_from, 'old-key');
    assert.equal(result.key.key_id, 'gw-key-1');
    assert.equal(result.value, 'secret-value-1');
    assert.equal(harness.store.get(`${keys.apiKey(TABLE_CTX, 'old-key').PK}|${keys.apiKey(TABLE_CTX, 'old-key').SK}`)?.status, 'ACTIVE');
  });

  it('revokes an active key by disabling it, detaching its plan, and deleting KEYMAP', async () => {
    const harness = createHarness();
    harness.seedKey('key-1');
    const result = await revokeApiKey(TABLE_CTX, 'key-1', harness.deps);

    assert.equal(result.status, 'REVOKED');
    assert.equal(harness.store.get(`${keys.apiKey(TABLE_CTX, 'key-1').PK}|${keys.apiKey(TABLE_CTX, 'key-1').SK}`)?.status, 'REVOKED');
    assert.equal(harness.store.has(`${keys.keymap('key-1').PK}|${keys.keymap('key-1').SK}`), false);
    assert.deepEqual(harness.gatewayCalls.map((call) => call.operation), ['setKeyEnabled', 'detachKey']);
  });

  it('changes Usage Plans and restores the old plan if the database update fails', async () => {
    const success = createHarness();
    success.seedKey('key-1');
    const changed = await changeApiKeyPlan(TABLE_CTX, 'key-1', 'Standard', success.deps);
    assert.equal(changed.plan, 'Standard');
    assert.equal(success.store.get(`${keys.apiKey(TABLE_CTX, 'key-1').PK}|${keys.apiKey(TABLE_CTX, 'key-1').SK}`)?.plan, 'Standard');

    const failed = createHarness({ fail: 'dbUpdate' });
    failed.seedKey('key-2');
    await assertAppError(
      () => changeApiKeyPlan(TABLE_CTX, 'key-2', 'Standard', failed.deps),
      'INTERNAL_ERROR',
    );
    assert.equal(failed.store.get(`${keys.apiKey(TABLE_CTX, 'key-2').PK}|${keys.apiKey(TABLE_CTX, 'key-2').SK}`)?.plan, 'Basic');
    assert.deepEqual(failed.gatewayCalls.map((call) => call.operation), [
      'detachKey', 'attachKey', 'detachKey', 'attachKey',
    ]);
    assert.ok(failed.logErrors.some((entry) =>
      entry.action === 'API_KEY_PLAN_CHANGE_FAILED' && entry.keyId === 'key-2' && entry.request_id === TABLE_CTX.requestId,
    ));
  });

  it('does not disclose or mutate another tenant key', async () => {
    const harness = createHarness();
    await assertAppError(
      () => revokeApiKey(OTHER_TENANT_CTX, 'key-1', harness.deps),
      'NOT_FOUND',
    );
    assert.equal(harness.gatewayCalls.length, 0);
  });

  it('maps route responses and malformed requests to the documented status codes', async () => {
    const harness = createHarness();
    const invalidJson = await handleApiKeyRoute({
      httpMethod: 'POST',
      path: '/console/api-keys',
      body: '{',
      requestContext: { requestId: 'req-route' },
    }, TABLE_CTX, harness.deps);
    assert.equal(invalidJson.statusCode, 400);
    assert.equal(JSON.parse(invalidJson.body).request_id, 'req-route');

    const created = await handleApiKeyRoute({
      httpMethod: 'POST',
      path: '/console/api-keys',
      body: JSON.stringify({ name: 'Console key', plan: 'Basic' }),
    }, TABLE_CTX, harness.deps);
    assert.equal(created.statusCode, 201);
    assert.equal(JSON.parse(created.body).api_key.value, 'secret-value-1');

    const revoke = await handleApiKeyRoute({
      httpMethod: 'POST',
      path: '/console/api-keys/gw-key-1/revoke',
    }, TABLE_CTX, harness.deps);
    assert.equal(revoke.statusCode, 200);
    assert.equal(JSON.parse(revoke.body).api_key.status, 'REVOKED');

    harness.seedKey('route-plan-key');
    const changePlan = await handleApiKeyRoute({
      httpMethod: 'PATCH',
      path: '/console/api-keys/route-plan-key',
      body: JSON.stringify({ plan: 'Standard' }),
    }, TABLE_CTX, harness.deps);
    assert.equal(changePlan.statusCode, 200);
    assert.equal(JSON.parse(changePlan.body).api_key.plan, 'Standard');

    const missing = await handleApiKeyRoute({
      httpMethod: 'POST',
      path: '/console/api-keys/missing/revoke',
    }, TABLE_CTX, harness.deps);
    assert.equal(missing.statusCode, 404);
    assert.equal(JSON.parse(missing.body).error.code, 'NOT_FOUND');
  });

  it('logs revoke failures from API Gateway and DynamoDB with request and key identifiers', async () => {
    const scenarios = [
      { options: { failDisable: true }, action: 'API_KEY_REVOKE_DISABLE_FAILED' },
      { options: { fail: 'detach' as const }, action: 'API_KEY_REVOKE_DETACH_FAILED' },
      { options: { fail: 'transaction' as const }, action: 'API_KEY_REVOKE_DATABASE_FAILED' },
    ];
    for (const scenario of scenarios) {
      const harness = createHarness(scenario.options);
      harness.seedKey('key-revoke-fail');
      const response = await handleApiKeyRoute({
        httpMethod: 'POST',
        path: '/console/api-keys/key-revoke-fail/revoke',
      }, TABLE_CTX, harness.deps);
      assert.equal(response.statusCode, 500);
      assert.ok(harness.logErrors.some((entry) =>
        entry.action === scenario.action && entry.keyId === 'key-revoke-fail' &&
        entry.request_id === TABLE_CTX.requestId,
      ));
    }
  });
});
