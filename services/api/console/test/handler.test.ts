import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createConsoleHandler,
  handleGlossaryApiGatewayRoute,
  handleSitesApiGatewayRoute,
  handleMembersApiGatewayRoute,
  CONSOLE_ROUTE_MODULES,
  type ConsoleEvent,
  type ConsoleRouteModule,
} from '../handler.js';
import type { Ctx } from '../../../../libs/common/types.js';

const claims = { 'custom:tenant_id': 't_a', 'custom:role': 'tenant_admin', sub: 'u_1' };
const event = (path: string, c: Record<string, unknown> = claims, method = 'GET', body?: unknown): ConsoleEvent => ({
  httpMethod: method,
  path,
  body: body ? JSON.stringify(body) : undefined,
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
    assert.deepEqual(seen, [{ role: 'TENANT_ADMIN', tenantId: 't_a' }]);
  });

  it('route không thuộc mô-đun nào -> 404; thiếu claim sub -> 401', async () => {
    const handler = createConsoleHandler([async () => null]);
    assert.equal((await handler(event('/console/unknown'))).statusCode, 404);
    assert.equal((await handler(event('/console/translations', {}))).statusCode, 401);
  });

  it('CONSOLE_ROUTE_MODULES mặc định đăng ký đầy đủ 4 nhóm route Console hiện có (Review, Glossary, Sites, Members)', async () => {
    assert.equal(CONSOLE_ROUTE_MODULES.length, 4, 'Router phải đăng ký đủ 4 module Console');

    const adminCtx: Ctx = { tenantId: 't_a', via: 'JWT', requestId: 'r1', role: 'TENANT_ADMIN', sub: 'u_1' };

    // 1. Module Thuật ngữ (F4)
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
      adminCtx,
      fakeGlossaryDeps as any,
    );
    assert.ok(glossaryRes);
    assert.equal(glossaryRes.statusCode, 200);
    const parsedGlossary = JSON.parse(glossaryRes.body);
    assert.equal(parsedGlossary.request_id, 'req-console');
    assert.equal(parsedGlossary.version, 0);

    // 2. Module Website (F3/Q2) - GET /console/hosts và POST /console/hosts/:slug/pause
    const fakeSiteDeps = {
      db: {
        transact: async () => {},
        get: async () => ({ PK: 'TENANT#t_a', SK: 'HOST#test-slug', status: 'ACTIVE' }),
        put: async () => {},
        updateSiteStatus: async () => {},
      },
      resolver: async () => [{ address: '93.184.216.34', family: 4 }],
      safeFetch: async () => ({ ok: true, text: async () => '' } as any),
      invalidateSites: async () => ({ status: 'SUBMITTED', invalidationIds: ['inv-1'] } as any),
      assertTenantWritable: async () => {},
    };
    const sitesRes = await handleSitesApiGatewayRoute(
      event('/console/hosts/test-slug/pause', claims, 'POST'),
      adminCtx,
      fakeSiteDeps as any,
    );
    assert.ok(sitesRes);
    assert.equal(sitesRes.statusCode, 200);

    // 3. Module Thành viên (E.5) - GET /console/members (TENANT_ADMIN) & POST /console/members/invite
    const fakeMemberDeps = {
      cognitoClient: {
        send: async () => ({ User: { Username: 'developer@example.com', Attributes: [{ Name: 'sub', Value: 'sub-dev-1' }] } }),
      },
      userPoolId: 'us-east-1_mock',
      db: {
        query: async () => [{ PK: 'TENANT#t_a', SK: 'MEMBER#u_1', role: 'TENANT_ADMIN' }],
      },
    };
    const memberListRes = await handleMembersApiGatewayRoute(
      event('/console/members', claims, 'GET'),
      adminCtx,
      fakeMemberDeps as any,
    );
    assert.ok(memberListRes);
    assert.equal(memberListRes.statusCode, 200);
    const parsedMemberList = JSON.parse(memberListRes.body);
    assert.equal(parsedMemberList.items.length, 1);
    assert.equal(parsedMemberList.items[0].SK, 'MEMBER#u_1');

    const memberRes = await handleMembersApiGatewayRoute(
      event('/console/members/invite', claims, 'POST', { email: 'developer@example.com', role: 'DEVELOPER' }),
      adminCtx,
      fakeMemberDeps as any,
    );
    assert.ok(memberRes);
    assert.equal(memberRes.statusCode, 200);
    const parsedMember = JSON.parse(memberRes.body);
    assert.equal(parsedMember.username, 'developer@example.com');
  });

  it('GET /console/members chỉ cho phép TENANT_ADMIN; từ chối REVIEWER và DEVELOPER với 403 PERMISSION_DENIED', async () => {
    const reviewerCtx: Ctx = { tenantId: 't_a', via: 'JWT', requestId: 'req-rev', role: 'REVIEWER', sub: 'u_rev' };
    const developerCtx: Ctx = { tenantId: 't_a', via: 'JWT', requestId: 'req-dev', role: 'DEVELOPER', sub: 'u_dev' };

    // 1. Kiểm tra trực tiếp qua handleMembersApiGatewayRoute
    const revRes = await handleMembersApiGatewayRoute(event('/console/members'), reviewerCtx);
    assert.ok(revRes);
    assert.equal(revRes.statusCode, 403);
    assert.equal(JSON.parse(revRes.body).error?.code, 'PERMISSION_DENIED');

    const devRes = await handleMembersApiGatewayRoute(event('/console/members'), developerCtx);
    assert.ok(devRes);
    assert.equal(devRes.statusCode, 403);
    assert.equal(JSON.parse(devRes.body).error?.code, 'PERMISSION_DENIED');

    // 2. Kiểm tra thông qua toàn bộ router Lambda mặc định (createConsoleHandler)
    const handler = createConsoleHandler();

    const routerRevRes = await handler(
      event('/console/members', { 'custom:tenant_id': 't_a', 'custom:role': 'reviewer', sub: 'u_rev' }, 'GET'),
    );
    assert.equal(routerRevRes.statusCode, 403);
    assert.equal(JSON.parse(routerRevRes.body).error?.code, 'PERMISSION_DENIED');

    const routerDevRes = await handler(
      event('/console/members', { 'custom:tenant_id': 't_a', 'custom:role': 'developer', sub: 'u_dev' }, 'GET'),
    );
    assert.equal(routerDevRes.statusCode, 403);
    assert.equal(JSON.parse(routerDevRes.body).error?.code, 'PERMISSION_DENIED');
  });

  it('POST /console/hosts và /console/websites tạo website: trả 200 khi thành công, trả 409 DUPLICATE_SLUG khi trùng slug', async () => {
    const adminCtx: Ctx = { tenantId: 't_a', via: 'JWT', requestId: 'req-admin', role: 'TENANT_ADMIN', sub: 'u_admin' };
    const validBody = {
      homeUrl: 'https://mysite.example.com/',
      displayName: 'My Website',
      sourceLang: 'vi',
      targetLangs: ['en'],
    };

    // 1. Tạo website thành công -> HTTP 200
    const successSiteDeps = {
      assertTenantWritable: async () => {},
      resolver: async () => [{ address: '93.184.216.34', family: 4 }],
      db: {
        transact: async () => {},
        get: async () => ({ PK: 'TENANT#t_a', SK: 'CONFIG', status: 'ACTIVE' }),
        put: async () => {},
        updateSiteStatus: async () => {},
      },
      safeFetch: async () => ({ ok: true, text: async () => '' } as any),
      invalidateSites: async () => ({ status: 'SUBMITTED', invalidationIds: ['inv-1'] } as any),
    };

    const createSuccessRes = await handleSitesApiGatewayRoute(
      event('/console/hosts', claims, 'POST', validBody),
      adminCtx,
      successSiteDeps as any,
    );
    assert.ok(createSuccessRes);
    assert.equal(createSuccessRes.statusCode, 200);
    const successBody = JSON.parse(createSuccessRes.body);
    assert.equal(successBody.slug, 'mysite-example-com');
    assert.equal(successBody.status, 'PENDING');
    assert.ok(successBody.verificationCode);

    // 2. Trùng slug -> createSite ném AppError('DUPLICATE_SLUG') -> HTTP 409 DUPLICATE_SLUG
    const duplicateSiteDeps = {
      ...successSiteDeps,
      db: {
        ...successSiteDeps.db,
        transact: async () => {
          throw Object.assign(new Error('Conditional transaction failed'), {
            name: 'TransactionCanceledException',
            CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }, { Code: 'None' }],
          });
        },
      },
    };

    const duplicateRes = await handleSitesApiGatewayRoute(
      event('/console/hosts', claims, 'POST', validBody),
      adminCtx,
      duplicateSiteDeps as any,
    );
    assert.ok(duplicateRes);
    assert.equal(duplicateRes.statusCode, 409, 'Xung đột trùng slug phải trả mã HTTP 409');
    const duplicateBody = JSON.parse(duplicateRes.body);
    assert.equal(duplicateBody.error?.code, 'DUPLICATE_SLUG');
    assert.match(duplicateBody.error?.message, /Slug đã tồn tại/);

    // 3. Kiểm tra qua toàn bộ router (createConsoleHandler) với alias route /console/websites
    const siteModuleWithDeps: ConsoleRouteModule = (e, ctx) =>
      handleSitesApiGatewayRoute(e, ctx, duplicateSiteDeps as any);
    const handler = createConsoleHandler([siteModuleWithDeps]);

    const routerDuplicateRes = await handler(
      event('/console/websites', claims, 'POST', validBody),
    );
    assert.equal(routerDuplicateRes.statusCode, 409);
    assert.equal(JSON.parse(routerDuplicateRes.body).error?.code, 'DUPLICATE_SLUG');
  });
});
