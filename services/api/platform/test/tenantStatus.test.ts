import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError } from '../../../../libs/common/types.js';
import {
  isPlatformAdmin,
  setTenantStatus,
  validateTenantId,
} from '../tenantStatus.js';

describe('platform tenant status', () => {
  it('nhận PlatformAdmins từ array, JSON hoặc danh sách Cognito', () => {
    assert.equal(isPlatformAdmin(['PlatformAdmins']), true);
    assert.equal(isPlatformAdmin('["PlatformAdmins"]'), true);
    assert.equal(isPlatformAdmin('Users, PlatformAdmins'), true);
    assert.equal(isPlatformAdmin(['Users']), false);
  });

  it('xác thực tenantId từ path', () => {
    assert.equal(validateTenantId('t_tenant-1'), 't_tenant-1');
    assert.throws(
      () => validateTenantId(''),
      (error: unknown) => error instanceof AppError && error.code === 'INVALID_REQUEST',
    );
  });

  it('cập nhật CONFIG rồi tạo wildcard invalidation cho từng website', async () => {
    const invalidated: string[] = [];
    let updated: unknown;

    const result = await setTenantStatus('t_tenant-1', 'LOCKED', {
      db: {
        async updateTenantStatus(ctx, tenantId, status) {
          assert.equal(ctx.tenantId, tenantId);
          updated = { tenantId, status };
        },
        async listTenantSites() {
          return [{ slug: 'site-a' }, { slug: 'site-b' }, { slug: 'site-a' }];
        },
      },
      async invalidateSites(_ctx, { slugs }) {
        invalidated.push(...slugs.map((slug) => `/${slug}/*`));
        return { paths: invalidated, mode: 'WILDCARD' as const };
      },
    });

    assert.deepEqual(updated, { tenantId: 't_tenant-1', status: 'LOCKED' });
    assert.deepEqual(invalidated, ['/site-a/*', '/site-b/*']);
    assert.deepEqual(result.invalidation.paths, ['/site-a/*', '/site-b/*']);
  });
});
