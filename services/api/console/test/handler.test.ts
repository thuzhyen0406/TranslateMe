import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createConsoleHandler,
  handleGlossaryApiGatewayRoute,
  CONSOLE_ROUTE_MODULES,
  type ConsoleEvent,
  type ConsoleRouteModule,
} from '../handler.js';
import type { Ctx } from '../../../../libs/common/types.js';

const claims = { 'custom:tenant_id': 't_a', 'custom:role': 'reviewer', sub: 'u_1' };
const event = (path: string, c: Record<string, unknown> = claims, method = 'GET'): ConsoleEvent => ({
  httpMethod: method,
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

  it('route không thuộc mô-đun nào -> 404; thiếu claim sub -> 401', async () => {
    const handler = createConsoleHandler([async () => null]);
    assert.equal((await handler(event('/console/unknown'))).statusCode, 404);
    assert.equal((await handler(event('/console/translations', {}))).statusCode, 401);
  });

  it('CONSOLE_ROUTE_MODULES mặc định đăng ký cả nhóm F5 Duyệt bản dịch và F4 Thuật ngữ', async () => {
    assert.equal(CONSOLE_ROUTE_MODULES.length, 2, 'Router phải đăng ký đủ 2 module Console F5 và F4');

    // 1. Kiểm tra handleGlossaryApiGatewayRoute trả null nếu không phải route /console/glossary
    const nonGlossaryCtx: Ctx = { tenantId: 't_a', via: 'JWT', requestId: 'r1', role: 'REVIEWER', sub: 'u_1' };
    const nullRes = await handleGlossaryApiGatewayRoute(event('/console/translations'), nonGlossaryCtx);
    assert.equal(nullRes, null);

    // 2. Kiểm tra handleGlossaryApiGatewayRoute chuyển tiếp và trả về JSON cho route /console/glossary
    const fakeGlossaryDeps = {
      db: {
        get: async () => null,
        put: async () => {},
        update: async () => {},
        query: async () => [],
        transact: async () => {},
      },
      translateClient: { send: async () => ({}) },
      now: () => Date.now(),
    };
    const glossaryRes = await handleGlossaryApiGatewayRoute(
      event('/console/glossary'),
      nonGlossaryCtx,
      fakeGlossaryDeps as any,
    );
    assert.ok(glossaryRes);
    assert.equal(glossaryRes.statusCode, 200);
    const parsedBody = JSON.parse(glossaryRes.body);
    assert.equal(parsedBody.request_id, 'req-console');
    assert.equal(parsedBody.version, 0);
  });
});
