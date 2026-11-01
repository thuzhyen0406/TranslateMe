import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateApiKeyTransaction } from '../../../../libs/common/api-key-transaction.js';
import { AppError, keys, type Ctx } from '../../../../libs/common/types.js';

const ctx: Ctx = { tenantId: 'tenant-1', via: 'JWT', requestId: 'req-1', role: 'TENANT_ADMIN' };

/** Tạo giao dịch tạo key hợp lệ để từng test thay đổi đúng một điều kiện. */
function createOps(localKey = keys.apiKey(ctx, 'key-1'), mappingKey = keys.keymap('key-1')): unknown[] {
  return [
    { Put: { Item: { ...localKey, keyId: 'key-1' } } },
    { Put: { Item: { ...mappingKey, tenantId: ctx.tenantId } } },
  ];
}

/** Xác nhận validator từ chối giao dịch với mã lỗi mong đợi. */
function assertRejected(ops: unknown[], requestCtx: Ctx, code: string): void {
  assert.throws(() => validateApiKeyTransaction(requestCtx, ops), (error: unknown) =>
    error instanceof AppError && error.code === code,
  );
}

describe('validateApiKeyTransaction', () => {
  it('accepts a valid tenant APIKEY and matching platform KEYMAP create', () => {
    assert.doesNotThrow(() => validateApiKeyTransaction(ctx, createOps()));
  });

  it('rejects an APIKEY partition belonging to another tenant', () => {
    assertRejected(createOps(keys.apiKey({ ...ctx, tenantId: 'tenant-2' }, 'key-1')), ctx, 'FORBIDDEN');
  });

  it('rejects a KEYMAP whose keyId differs from the APIKEY', () => {
    assertRejected(createOps(undefined, keys.keymap('other-key')), ctx, 'FORBIDDEN');
  });

  it('rejects a KEYMAP that points to another tenant', () => {
    const ops = createOps();
    (ops[1] as { Put: { Item: Record<string, unknown> } }).Put.Item.tenantId = 'tenant-2';
    assertRejected(ops, ctx, 'FORBIDDEN');
  });

  it('rejects a context that is not authenticated through JWT', () => {
    assertRejected(createOps(), { ...ctx, via: 'KEYMAP' }, 'FORBIDDEN');
  });

  it('rejects unsupported operation combinations', () => {
    const ops = [
      { ConditionCheck: { Key: keys.apiKey(ctx, 'key-1') } },
      { Delete: { Key: keys.keymap('key-1') } },
    ];
    assertRejected(ops, ctx, 'INVALID_REQUEST');
  });
});
