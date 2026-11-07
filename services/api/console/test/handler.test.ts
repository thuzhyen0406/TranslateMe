import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createConsoleHandler,
  createDefaultPrewarmStarter,
  defaultPrewarmDeps,
  handleGlossaryApiGatewayRoute,
  handleSitesApiGatewayRoute,
  handleMembersApiGatewayRoute,
  handleApiKeysApiGatewayRoute,
  toHostResponse,
  CONSOLE_ROUTE_MODULES,
  type ConsoleEvent,
  type ConsoleRouteModule,
} from '../handler.js';
import { StartExecutionCommand } from '@aws-sdk/client-sfn';
import { handlePrewarmRoute } from '../../prewarm/prewarmManager.js';
import { memoryDataDb } from '../../../../libs/common/test/memoryDataDb.js';
import { db } from '../../../../libs/common/db.js';
import { AppError, keys, type Ctx } from '../../../../libs/common/types.js';

const claims = { 'custom:tenant_id': 't_a', 'custom:role': 'tenant_admin', sub: 'u_1' };
const event = (path: string, c: Record<string, unknown> = claims, method = 'GET', body?: unknown): ConsoleEvent => ({
  httpMethod: method,
  path,
  body: body ? JSON.stringify(body) : undefined,
  requestContext: { requestId: 'req-console', authorizer: { claims: c } },
});

// Giả lập mặc định db.get trả MEMBER ACTIVE để router kiểm tra qua contextFromIdTokenClaims
const originalDbGet = db.get;
db.get = async (ctx: Ctx, key: { PK: string; SK: string }, opts?: { consistent?: boolean }) => {
  if (key?.SK?.startsWith('MEMBER#')) {
    const role = ctx.role ?? 'TENANT_ADMIN';
    return { PK: key.PK, SK: key.SK, status: 'ACTIVE', role } as any;
  }
  return originalDbGet(ctx, key, opts);
};

describe('Console Lambda router (/console/{proxy+})', () => {
  it('chuyển route cho mô-đun khớp kèm Ctx chuẩn hóa từ claim role chữ thường và ctx.sub', async () => {
    const seen: Array<{ role?: string; tenantId: string; sub?: string }> = [];
    const mod: ConsoleRouteModule = async (e, ctx) => {
      if (!(e.path ?? '').includes('/console/translations')) return null;
      seen.push({ role: ctx.role, tenantId: ctx.tenantId, sub: ctx.sub });
      return { statusCode: 200, headers: {}, body: '{"ok":true}' };
    };
    const handler = createConsoleHandler([mod]);
    const res = await handler(event('/dev/console/translations'));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(seen, [{ role: 'TENANT_ADMIN', tenantId: 't_a', sub: 'u_1' }]);
  });

  it('route không thuộc mô-đun nào -> 404; thiếu claim sub -> 401', async () => {
    const handler = createConsoleHandler([async () => null]);
    assert.equal((await handler(event('/console/unknown'))).statusCode, 404);
    assert.equal((await handler(event('/console/translations', {}))).statusCode, 401);
  });

  it('createConsoleHandler xác thực MEMBER ACTIVE trong DynamoDB: từ chối 403 khi MEMBER không tồn tại, bị DISABLED hoặc lệch vai trò', async () => {
    // 1. MEMBER không tồn tại trong DynamoDB -> 403 PERMISSION_DENIED
    const noMemberDeps = {
      db: {
        get: async () => null,
      },
    };
    const handlerNoMember = createConsoleHandler([async () => ({ statusCode: 200, headers: {}, body: '{}' })], noMemberDeps as any);
    const resNoMember = await handlerNoMember(event('/console/translations'));
    assert.equal(resNoMember.statusCode, 403);
    assert.equal(JSON.parse(resNoMember.body).error?.code, 'PERMISSION_DENIED');

    // 2. MEMBER bị DISABLED -> 403 PERMISSION_DENIED
    const disabledMemberDeps = {
      db: {
        get: async () => ({ status: 'DISABLED', role: 'TENANT_ADMIN' }),
      },
    };
    const handlerDisabled = createConsoleHandler([async () => ({ statusCode: 200, headers: {}, body: '{}' })], disabledMemberDeps as any);
    const resDisabled = await handlerDisabled(event('/console/translations'));
    assert.equal(resDisabled.statusCode, 403);
    assert.equal(JSON.parse(resDisabled.body).error?.code, 'PERMISSION_DENIED');

    // 3. MEMBER trong DB là REVIEWER nhưng claim là tenant_admin -> 403 PERMISSION_DENIED
    const mismatchRoleDeps = {
      db: {
        get: async () => ({ status: 'ACTIVE', role: 'REVIEWER' }),
      },
    };
    const handlerMismatch = createConsoleHandler([async () => ({ statusCode: 200, headers: {}, body: '{}' })], mismatchRoleDeps as any);
    const resMismatch = await handlerMismatch(event('/console/translations'));
    assert.equal(resMismatch.statusCode, 403);
    assert.equal(JSON.parse(resMismatch.body).error?.code, 'PERMISSION_DENIED');
  });

  it('CONSOLE_ROUTE_MODULES mặc định đăng ký đầy đủ 6 nhóm route Console hiện có (Review, Glossary, Sites, Prewarm/Job, Members, ApiKeys)', async () => {
    assert.equal(CONSOLE_ROUTE_MODULES.length, 6, 'Router phải đăng ký đủ 6 module Console');

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
        get: async () => ({ PK: 'TENANT#t_a', SK: 'HOST#test-slug', slug: 'test-slug', status: 'ACTIVE' }),
        put: async () => {},
        updateSiteStatus: async () => {},
        listTenantSites: async () => [{ PK: 'TENANT#t_a', SK: 'HOST#test-slug', slug: 'test-slug', status: 'ACTIVE' }],
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

    // 4. Đường dẫn /console/hosts/{slug}/prewarm không bị chặn bởi handleSitesApiGatewayRoute (trả null để module prewarm xử lý)
    const sitesPrewarmBypass = await handleSitesApiGatewayRoute(
      event('/console/hosts/test-slug/prewarm', claims, 'POST'),
      adminCtx,
      fakeSiteDeps as any,
    );
    assert.equal(sitesPrewarmBypass, null, 'handleSitesApiGatewayRoute phải trả null cho /prewarm để module sau xử lý');
  });

  it('Console router xử lý đầy đủ route dịch trước (POST/GET /console/hosts/{slug}/prewarm) và tra cứu job (GET /console/jobs/{jobId})', async () => {
    const memDb = memoryDataDb();
    const adminCtx: Ctx = { tenantId: 't_a', via: 'JWT', requestId: 'r1', role: 'TENANT_ADMIN', sub: 'u_1' };
    await memDb.put(adminCtx, { ...keys.config(adminCtx), status: 'ACTIVE', plan: 'Free' });
    await memDb.put(adminCtx, {
      ...keys.host(adminCtx, 'homestay-abc'),
      homeUrl: 'https://homestay-abc.vn/',
      sourceLang: 'vi',
      targetLangs: ['en', 'ko'],
      status: 'ACTIVE',
    });

    const executionStarts: Array<{ name: string; input: string }> = [];
    const prewarmDeps = {
      db: memDb,
      now: () => 1730000000000,
      uuid: () => '11111111-2222-3333-4444-555555555555',
      startExecution: async (input: { name: string; input: string }) => {
        executionStarts.push(input);
        return { executionArn: `arn:aws:states:x:execution:prewarm:${input.name}` };
      },
    };

    const handler = createConsoleHandler(undefined, {
      prewarmDeps,
      db: {
        get: async (_c, key) => {
          if (key.SK.startsWith('MEMBER#')) return { status: 'ACTIVE', role: 'TENANT_ADMIN' };
          return memDb.get(_c as any, key);
        },
      },
    });

    // 1. POST /console/hosts/homestay-abc/prewarm -> 202 { job }
    const postRes = await handler(
      event('/console/hosts/homestay-abc/prewarm', claims, 'POST', { target_langs: ['en'] }),
    );
    assert.equal(postRes.statusCode, 202);
    const postBody = JSON.parse(postRes.body);
    assert.ok(postBody.job);
    assert.equal(postBody.job.status, 'QUEUED');
    assert.equal(postBody.job.type, 'PREWARM');
    assert.equal(postBody.job.slug, 'homestay-abc');
    assert.deepEqual(postBody.job.target_langs, ['en']);
    assert.equal(executionStarts.length, 1);
    assert.equal(executionStarts[0].name, postBody.job.job_id);

    // 2. GET /console/hosts/homestay-abc/prewarm -> 200 { job }
    const getRes = await handler(
      event('/console/hosts/homestay-abc/prewarm', claims, 'GET'),
    );
    assert.equal(getRes.statusCode, 200);
    const getBody = JSON.parse(getRes.body);
    assert.ok(getBody.job);
    assert.equal(getBody.job.job_id, postBody.job.job_id);

    // 3. GET /console/jobs/{jobId} -> 200 { job }
    const getJobRes = await handler(
      event(`/console/jobs/${postBody.job.job_id}`, claims, 'GET'),
    );
    assert.equal(getJobRes.statusCode, 200);
    const getJobBody = JSON.parse(getJobRes.body);
    assert.ok(getJobBody.job);
    assert.equal(getJobBody.job.job_id, postBody.job.job_id);
    assert.equal(getJobBody.job.status, 'QUEUED');
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

  it('Route /console/hosts bám sát hợp đồng Console 4.6 (snake_case, POST 201 {host}, GET list {hosts}, detail {host}, verify {host}, strict method)', async () => {
    const adminCtx: Ctx = { tenantId: 't_a', via: 'JWT', requestId: 'req-admin', role: 'TENANT_ADMIN', sub: 'u_admin' };
    const reviewerCtx: Ctx = { tenantId: 't_a', via: 'JWT', requestId: 'req-rev', role: 'REVIEWER', sub: 'u_rev' };

    const hostDbRecord = {
      PK: 'TENANT#t_a',
      SK: 'HOST#site-example-com',
      slug: 'site-example-com',
      displayName: 'My Site',
      homeUrl: 'https://site.example.com/',
      sourceLang: 'vi',
      targetLangs: ['en', 'fr'],
      status: 'PENDING',
      verificationCode: 'verify-12345',
      noTranslateSelectors: ['.notranslate'],
      createdAt: '2026-11-06T10:00:00.000Z',
    };

    const siteDeps = {
      assertTenantWritable: async () => {},
      resolver: async () => [{ address: '93.184.216.34', family: 4 }],
      db: {
        transact: async () => {},
        get: async (_c: any, key: any) => {
          if (key.SK === 'CONFIG') return { PK: 'TENANT#t_a', SK: 'CONFIG', status: 'ACTIVE' };
          if (key.SK === 'HOST#site-example-com') return hostDbRecord;
          return null;
        },
        put: async () => {},
        updateSiteStatus: async () => {},
        listTenantSites: async () => [hostDbRecord],
      },
      safeFetch: async () => ({
        kind: 'OK' as const,
        html: '<html><head><meta name="translateme-site-verification" content="verify-12345"></head></html>',
        finalUrl: 'https://site.example.com/',
        status: 200,
        headers: {},
      }),
      invalidateSites: async () => ({ status: 'SUBMITTED', invalidationIds: ['inv-1'] } as any),
    };

    // 1. POST /console/hosts: nhận snake_case, trả 201 chỉ kèm { request_id, host }, không có trường thừa ở root
    const postSnakeCaseBody = {
      home_url: 'https://site.example.com/',
      display_name: 'My Site',
      source_lang: 'vi',
      target_langs: ['en', 'fr'],
      no_translate_selectors: ['.notranslate'],
    };
    const createRes = await handleSitesApiGatewayRoute(
      event('/console/hosts', claims, 'POST', postSnakeCaseBody),
      adminCtx,
      siteDeps as any,
    );
    assert.ok(createRes);
    assert.equal(createRes.statusCode, 201, 'POST /console/hosts phải trả mã HTTP 201 Created');
    const createdBody = JSON.parse(createRes.body);
    assert.ok(createdBody.host);
    assert.equal(createdBody.host.slug, 'site-example-com');
    assert.equal(createdBody.host.display_name, 'My Site');
    assert.equal(createdBody.host.home_url, 'https://site.example.com/');
    assert.equal(createdBody.host.source_lang, 'vi');
    assert.deepEqual(createdBody.host.target_langs, ['en', 'fr']);
    assert.equal(createdBody.host.status, 'PENDING');
    assert.ok(createdBody.host.verification_code);
    assert.equal(createdBody.slug, undefined, 'Response không được có slug ở root');
    assert.equal(createdBody.verificationCode, undefined, 'Response không được có verificationCode ở root');
    assert.equal(createdBody.status, undefined, 'Response không được có status ở root');

    // 2. GET /console/hosts: từ chối REVIEWER với 403; TENANT_ADMIN nhận đúng { request_id, hosts }, không có items/websites
    const listReviewerRes = await handleSitesApiGatewayRoute(
      event('/console/hosts'),
      reviewerCtx,
      siteDeps as any,
    );
    assert.equal(listReviewerRes?.statusCode, 403);
    assert.equal(JSON.parse(listReviewerRes!.body).error?.code, 'PERMISSION_DENIED');

    const listAdminRes = await handleSitesApiGatewayRoute(
      event('/console/hosts'),
      adminCtx,
      siteDeps as any,
    );
    assert.equal(listAdminRes?.statusCode, 200);
    const listBody = JSON.parse(listAdminRes!.body);
    assert.ok(Array.isArray(listBody.hosts), 'Response phải có trường hosts');
    assert.equal(listBody.hosts.length, 1);
    assert.equal(listBody.hosts[0].display_name, 'My Site');
    assert.equal(listBody.hosts[0].verification_code, 'verify-12345');
    assert.equal(listBody.items, undefined, 'Response không được có trường items');
    assert.equal(listBody.websites, undefined, 'Response không được có trường websites');

    // 3. GET /console/hosts/{slug}: chi tiết website (404 khi không tồn tại, 200 khi có)
    const detail404Res = await handleSitesApiGatewayRoute(
      event('/console/hosts/unknown-slug'),
      adminCtx,
      siteDeps as any,
    );
    assert.equal(detail404Res?.statusCode, 404);

    const detail200Res = await handleSitesApiGatewayRoute(
      event('/console/hosts/site-example-com'),
      adminCtx,
      siteDeps as any,
    );
    assert.equal(detail200Res?.statusCode, 200);
    const detailBody = JSON.parse(detail200Res!.body);
    assert.ok(detailBody.host);
    assert.equal(detailBody.host.slug, 'site-example-com');
    assert.equal(detailBody.host.display_name, 'My Site');

    // 4. POST /console/hosts/{slug}/verify: trả { host, status: 'ACTIVE' }
    const verifyRes = await handleSitesApiGatewayRoute(
      event('/console/hosts/site-example-com/verify', claims, 'POST', { method: 'META' }),
      adminCtx,
      siteDeps as any,
    );
    assert.equal(verifyRes?.statusCode, 200);
    const verifyBody = JSON.parse(verifyRes!.body);
    assert.equal(verifyBody.status, 'ACTIVE');
    assert.ok(verifyBody.host);

    // 5. POST /console/hosts/{slug}/verify với method không hợp lệ -> 400 INVALID_REQUEST
    const invalidMethodRes = await handleSitesApiGatewayRoute(
      event('/console/hosts/site-example-com/verify', claims, 'POST', { method: 'BAD_METHOD' }),
      adminCtx,
      siteDeps as any,
    );
    assert.equal(invalidMethodRes?.statusCode, 400);
    const invalidMethodBody = JSON.parse(invalidMethodRes!.body);
    assert.equal(invalidMethodBody.error?.code, 'INVALID_REQUEST');

    // 6. POST verify lỗi (ví dụ mã xác minh sai) -> 400 VERIFICATION_FAILED kèm reason
    const mismatchDeps = {
      ...siteDeps,
      safeFetch: async () => ({
        kind: 'OK' as const,
        html: '<html><head><meta name="translateme-site-verification" content="wrong-code"></head></html>',
        finalUrl: 'https://site.example.com/',
        status: 200,
        headers: {},
      }),
    };
    const failVerifyRes = await handleSitesApiGatewayRoute(
      event('/console/hosts/site-example-com/verify', claims, 'POST', { method: 'META' }),
      adminCtx,
      mismatchDeps as any,
    );
    assert.equal(failVerifyRes?.statusCode, 400);
    const failBody = JSON.parse(failVerifyRes!.body);
    assert.equal(failBody.error?.code, 'VERIFICATION_FAILED');
    assert.equal(failBody.error?.reason, 'VERIFICATION_CODE_MISMATCH');

    // 7. POST trùng slug -> 409 DUPLICATE_SLUG
    const duplicateSiteDeps = {
      ...siteDeps,
      db: {
        ...siteDeps.db,
        transact: async () => {
          throw Object.assign(new Error('Conditional transaction failed'), {
            name: 'TransactionCanceledException',
            CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }, { Code: 'None' }],
          });
        },
      },
    };
    const duplicateRes = await handleSitesApiGatewayRoute(
      event('/console/hosts', claims, 'POST', postSnakeCaseBody),
      adminCtx,
      duplicateSiteDeps as any,
    );
    assert.equal(duplicateRes?.statusCode, 409);
    assert.equal(JSON.parse(duplicateRes!.body).error?.code, 'DUPLICATE_SLUG');
  });

  it('defaultPrewarmDeps từ chối khởi chạy và đánh dấu JOB thất bại nếu chưa cấu hình PREWARM_STATE_MACHINE_ARN', async () => {
    // 1. Hàm createDefaultPrewarmStarter ném CONFIG_ERROR khi không có ARN
    const unconfiguredStarter = createDefaultPrewarmStarter('');
    await assert.rejects(
      () => unconfiguredStarter({ name: 'job-1', input: '{}' }),
      (err: unknown) => err instanceof AppError && err.code === 'INTERNAL_ERROR',
    );

    // 2. Router với prewarmDeps mặc định (chưa có env ARN): POST /prewarm trả lỗi 500 và đánh dấu JOB = FAILED
    const memDb = memoryDataDb();
    const adminCtx: Ctx = { tenantId: 't_a', via: 'JWT', requestId: 'r-fail', role: 'TENANT_ADMIN', sub: 'u_1' };
    await memDb.put(adminCtx, { ...keys.config(adminCtx), status: 'ACTIVE', plan: 'Free' });
    await memDb.put(adminCtx, {
      ...keys.host(adminCtx, 'homestay-abc'),
      homeUrl: 'https://homestay-abc.vn/',
      sourceLang: 'vi',
      targetLangs: ['en'],
      status: 'ACTIVE',
    });

    const handler = createConsoleHandler(undefined, {
      prewarmDeps: {
        db: memDb,
        startExecution: createDefaultPrewarmStarter(''), // Giả lập chưa cấu hình biến môi trường
      },
      db: {
        get: async (_c, key) => {
          if (key.SK.startsWith('MEMBER#')) return { status: 'ACTIVE', role: 'TENANT_ADMIN' };
          return memDb.get(_c as any, key);
        },
      },
    });

    const res = await handler(
      event('/console/hosts/homestay-abc/prewarm', claims, 'POST', { target_langs: ['en'] }),
    );
    assert.equal(res.statusCode, 500, 'Phải trả HTTP 500 khi chưa nối Step Functions thật');
    const body = JSON.parse(res.body);
    assert.equal(body.error?.code, 'INTERNAL_ERROR');

    // Kiểm tra JOB không bị kẹt ở QUEUED mà đã chuyển sang FAILED
    const hostWithPrewarm = (await memDb.get(adminCtx, keys.host(adminCtx, 'homestay-abc'))) as any;
    assert.ok(hostWithPrewarm?.prewarm?.jobId);
    const failedJob = (await memDb.get(adminCtx, { PK: 'TENANT#t_a#JOB', SK: `JOB#${hostWithPrewarm.prewarm.jobId}` })) as any;
    assert.equal(failedJob?.status, 'FAILED');
    assert.equal(failedJob?.reason, 'START_FAILED');
  });

  it('createDefaultPrewarmStarter gửi đúng StartExecutionCommand tới Step Functions khi có PREWARM_STATE_MACHINE_ARN', async () => {
    const sentCommands: unknown[] = [];
    const mockSfnClient = {
      send: async (cmd: unknown) => {
        sentCommands.push(cmd);
        return { executionArn: 'arn:aws:states:ap-southeast-1:123456789012:execution:translateme-dev-prewarm:exec-1' };
      },
    };

    const targetArn = 'arn:aws:states:ap-southeast-1:123456789012:stateMachine:translateme-dev-prewarm';
    const runtimeStarter = createDefaultPrewarmStarter(targetArn, mockSfnClient as any);

    const memDb = memoryDataDb();
    const adminCtx: Ctx = { tenantId: 't_a', via: 'JWT', requestId: 'r-ok', role: 'TENANT_ADMIN', sub: 'u_1' };
    await memDb.put(adminCtx, { ...keys.config(adminCtx), status: 'ACTIVE', plan: 'Free' });
    await memDb.put(adminCtx, {
      ...keys.host(adminCtx, 'homestay-abc'),
      homeUrl: 'https://homestay-abc.vn/',
      sourceLang: 'vi',
      targetLangs: ['en'],
      status: 'ACTIVE',
    });

    const handler = createConsoleHandler(undefined, {
      prewarmDeps: {
        db: memDb,
        startExecution: runtimeStarter,
      },
      db: {
        get: async (_c, key) => {
          if (key.SK.startsWith('MEMBER#')) return { status: 'ACTIVE', role: 'TENANT_ADMIN' };
          return memDb.get(_c as any, key);
        },
      },
    });

    const res = await handler(
      event('/console/hosts/homestay-abc/prewarm', claims, 'POST', { target_langs: ['en'] }),
    );
    assert.equal(res.statusCode, 202);
    const body = JSON.parse(res.body);
    assert.equal(body.job.status, 'QUEUED');

    // Chứng minh mockSfnClient nhận đúng StartExecutionCommand thật của AWS SDK
    assert.equal(sentCommands.length, 1);
    const sent = sentCommands[0] as StartExecutionCommand;
    assert.ok(sent instanceof StartExecutionCommand, 'Phải gửi đúng instance của StartExecutionCommand');
    assert.equal((sent as any).input.stateMachineArn, targetArn);
    assert.equal((sent as any).input.name, body.job.job_id);
    const inputPayload = JSON.parse((sent as any).input.input);
    assert.equal(inputPayload.job_id, body.job.job_id);
    assert.equal(inputPayload.tenant_id, 't_a');
    assert.equal(inputPayload.slug, 'homestay-abc');
    assert.deepEqual(inputPayload.target_langs, ['en']);
  });

  it('Console router điều phối các route /console/api-keys* qua handleApiKeyRoute với Ctx từ contextFromIdTokenClaims', async () => {
    const adminCtx: Ctx = { tenantId: 't_a', via: 'JWT', requestId: 'r-key', role: 'TENANT_ADMIN', sub: 'u_1' };
    const storedKeys: Array<Record<string, any>> = [
      {
        PK: 'TENANT#t_a#APIKEY',
        SK: 'KEY#key_01',
        keyId: 'key_01',
        name: 'Production Key',
        plan: 'Basic',
        status: 'ACTIVE',
        last4: '9a8b',
        createdAt: '2026-11-07T10:00:00.000Z',
      },
    ];

    const fakeApiKeyDeps = {
      db: {
        get: async (_c: Ctx, key: { PK: string; SK: string }) => {
          if (key.SK === 'CONFIG') return { PK: key.PK, SK: 'CONFIG', status: 'ACTIVE', plan: 'Standard' };
          if (key.SK.startsWith('MEMBER#')) return { PK: key.PK, SK: key.SK, tenantId: 't_a', userSub: 'u_1', role: 'TENANT_ADMIN', status: 'ACTIVE' };
          if (key.SK === 'KEY#key_01') return storedKeys[0];
          return null;
        },
        query: async () => storedKeys,
        update: async () => {},
        transactApiKey: async () => {},
      },
      apiGateway: {
        createApiKey: async () => ({ id: 'key_new_02', value: 'tm_live_secret_value_1234567890abcd' }),
        attachKey: async () => {},
        detachKey: async () => {},
        setKeyEnabled: async () => {},
        deleteApiKey: async () => {},
      },
      usagePlanIds: { Basic: 'plan-basic', Standard: 'plan-std' },
      now: () => new Date('2026-11-07T12:00:00.000Z'),
    };

    // 1. Đường dẫn không thuộc /console/api-keys trả null
    const nonApiKey = await handleApiKeysApiGatewayRoute(
      event('/console/glossary'),
      adminCtx,
      fakeApiKeyDeps as any,
    );
    assert.equal(nonApiKey, null);

    // 2. Dispatch qua createConsoleHandler (GET /console/api-keys & POST /console/api-keys)
    const handler = createConsoleHandler(undefined, {
      apiKeyDeps: fakeApiKeyDeps as any,
      db: {
        get: async (_c, key) => {
          if (key.SK.startsWith('MEMBER#')) {
            return { PK: key.PK, SK: key.SK, tenantId: 't_a', userSub: 'u_1', status: 'ACTIVE', role: 'TENANT_ADMIN' };
          }
          return null;
        },
      },
    });

    const listRes = await handler(event('/dev/console/api-keys', claims, 'GET'));
    assert.equal(listRes.statusCode, 200);
    const listBody = JSON.parse(listRes.body);
    assert.equal(listBody.request_id, 'req-console');
    assert.equal(listBody.api_keys.length, 1);
    assert.equal(listBody.api_keys[0].key_id, 'key_01');
    assert.equal(listBody.api_keys[0].last4, '9a8b');

    const createRes = await handler(
      event('/console/api-keys', claims, 'POST', { name: 'Mobile Key', plan: 'Basic' }),
    );
    assert.equal(createRes.statusCode, 201);
    const createBody = JSON.parse(createRes.body);
    assert.equal(createBody.api_key.key_id, 'key_new_02');
    assert.equal(createBody.api_key.value, 'tm_live_secret_value_1234567890abcd');

    // 3. Vai trò REVIEWER không được phép tạo/xem API key -> 403 PERMISSION_DENIED
    const reviewerHandler = createConsoleHandler(undefined, {
      apiKeyDeps: fakeApiKeyDeps as any,
      db: {
        get: async (_c, key) => {
          if (key.SK.startsWith('MEMBER#')) {
            return { PK: key.PK, SK: key.SK, tenantId: 't_a', userSub: 'u_rev', status: 'ACTIVE', role: 'REVIEWER' };
          }
          return null;
        },
      },
    });
    const revRes = await reviewerHandler(
      event('/console/api-keys', { 'custom:tenant_id': 't_a', 'custom:role': 'reviewer', sub: 'u_rev' }, 'GET'),
    );
    assert.equal(revRes.statusCode, 403);
    assert.equal(JSON.parse(revRes.body).error?.code, 'PERMISSION_DENIED');
  });
});
