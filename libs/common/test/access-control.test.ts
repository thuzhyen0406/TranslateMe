import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { requireRole } from '../db.js';
import { assertTenantWritable } from '../tenant.js';
import { AppError, type Ctx, type Role } from '../types.js';

const ctxFor = (role: Role): Ctx => ({
  tenantId: 'tenant-a',
  via: 'JWT',
  requestId: `test-${role}`,
  role,
});

function assertPermissionDenied(action: () => void): void {
  assert.throws(
    action,
    (error: unknown) =>
      error instanceof AppError && error.code === 'PERMISSION_DENIED',
  );
}

describe('QC role matrix server guard', () => {
  const roles: readonly Role[] = ['TENANT_ADMIN', 'DEVELOPER', 'REVIEWER'];

  it('cho phép đúng vai trò cho glossary read, review và website', () => {
    for (const role of roles) requireRole(ctxFor(role), roles);
    requireRole(ctxFor('TENANT_ADMIN'), ['TENANT_ADMIN']);
    requireRole(ctxFor('TENANT_ADMIN'), ['TENANT_ADMIN', 'REVIEWER']);
    requireRole(ctxFor('REVIEWER'), ['TENANT_ADMIN', 'REVIEWER']);
  });

  it('trả PERMISSION_DENIED khi vai trò gọi API ngoài quyền', () => {
    assertPermissionDenied(() => requireRole(ctxFor('DEVELOPER'), ['TENANT_ADMIN']));
    assertPermissionDenied(() => requireRole(ctxFor('REVIEWER'), ['TENANT_ADMIN', 'DEVELOPER']));
    assertPermissionDenied(() => requireRole(ctxFor('REVIEWER'), ['TENANT_ADMIN']));

    assertPermissionDenied(() => requireRole(ctxFor('DEVELOPER'), ['TENANT_ADMIN', 'REVIEWER']));
    assertPermissionDenied(() => requireRole(ctxFor('DEVELOPER'), ['TENANT_ADMIN']));
  });

  it('không ánh xạ permission sai sang lookup tài nguyên hoặc 404', () => {
    try {
      requireRole(ctxFor('DEVELOPER'), ['TENANT_ADMIN']);
      assert.fail('requireRole phải ném lỗi');
    } catch (error) {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'PERMISSION_DENIED');
      assert.equal(error.details, undefined);
    }
  });
});

describe('tenant lock guard', () => {
  it('mọi vai trò nhận TENANT_SUSPENDED cho thao tác ghi khi tenant LOCKED', async () => {
    for (const role of ['TENANT_ADMIN', 'DEVELOPER', 'REVIEWER'] as const) {
      await assert.rejects(
        assertTenantWritable(ctxFor(role), {
          async get() {
            return { status: 'LOCKED' };
          },
        }),
        (error: unknown) =>
          error instanceof AppError && error.code === 'TENANT_SUSPENDED',
      );
    }
  });

  it('cho phép giao dịch ghi tiếp tục khi tenant ACTIVE', async () => {
    for (const role of ['TENANT_ADMIN', 'DEVELOPER', 'REVIEWER'] as const) {
      await assertTenantWritable(ctxFor(role), {
        async get() {
          return { status: 'ACTIVE' };
        },
      });
    }
  });
});
