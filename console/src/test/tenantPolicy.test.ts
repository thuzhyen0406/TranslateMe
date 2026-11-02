import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canConsoleRequest } from '../services/tenantPolicy.js';

describe('console tenant lock policy', () => {
  it('cho tất cả vai trò xem khi tenant LOCKED', () => {
    for (const method of ['GET', 'HEAD']) {
      assert.equal(canConsoleRequest({
        method,
        path: '/console/glossary',
        tenantStatus: 'LOCKED',
      }), true);
    }
  });

  it('chặn mọi thao tác ghi khi tenant LOCKED', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal(canConsoleRequest({
        method,
        path: '/console/glossary/terms/example',
        tenantStatus: 'LOCKED',
      }), false);
    }
  });

  it('chỉ cho preview glossary vượt ngoại lệ POST khi tenant LOCKED', () => {
    assert.equal(canConsoleRequest({
      method: 'POST',
      path: '/console/glossary/import/preview',
      tenantStatus: 'LOCKED',
    }), true);
    assert.equal(canConsoleRequest({
      method: 'POST',
      path: '/console/glossary/import',
      tenantStatus: 'LOCKED',
    }), false);
  });
});
