import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createConsoleHandler, CONSOLE_ROUTE_MODULES, type ConsoleEvent, type ConsoleRouteModule } from '../handler.js';

const claims = { 'custom:tenant_id': 't_a', 'custom:role': 'reviewer', sub: 'u_1' };
const event = (path: string, c: Record<string, unknown> = claims): ConsoleEvent => ({
  httpMethod: 'GET',
  path,
  requestContext: { requestId: 'req-console', authorizer: { claims: c } },
});

describe('Console Lambda router (/console/{proxy+})', () => {
  it('chuyển route cho mô-đun khớp kèm Ctx chuẩn hóa từ claim role chữ thường', async () => {
    const seen: Array<{ role?: string; tenantId: string }> = [];
    const mod: ConsoleRouteModule = async (e, ctx) => {
      if (!(e.path ?? '').includes('/console/translations')) return null;
      seen.push({ role: ctx.role, tenantId: ctx.tenantId });
      return { statusCode: 200, headers: {}, body: '{"ok":true}' };
    };
    const handler = createConsoleHandler([mod]);
    const res = await handler(event('/dev/console/translations'));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(seen, [{ role: 'REVIEWER', tenantId: 't_a' }]);
  });

  it('route không thuộc mô-đun nào -> 404; thiếu claim -> 401', async () => {
    const handler = createConsoleHandler([async () => null]);
    assert.equal((await handler(event('/console/unknown'))).statusCode, 404);
    assert.equal((await handler(event('/console/translations', {}))).statusCode, 401);
  });

  it('mặc định đã đăng ký nhóm Duyệt bản dịch F5', () => {
    assert.ok(CONSOLE_ROUTE_MODULES.length >= 1);
  });
});
