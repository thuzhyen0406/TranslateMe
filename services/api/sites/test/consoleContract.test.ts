/**
 * Hợp đồng màn Website (4.6): websiteApi.ts của console gọi đúng Lambda mà API Gateway gắn cho /console/hosts*
 * (WebsiteFunction = services/api/sites/handler.ts; riêng /prewarm đi ConsoleFunction). Test chạy client HTTP thật
 * của console trên handler thật (fetch giả chuyển request thành sự kiện API Gateway REST), để biết có thể bật
 * VITE_WEBSITE_API_ENABLED=true cho bản demo.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError, type Ctx } from '../../../../libs/common/types.js';
import { createWebsiteHandler, type WebsiteEvent, type WebsiteHandlerDependencies } from '../handler.js';
import { WebsiteApiError, createHttpWebsiteApi, websiteErrorMessage } from '../../../../console/src/services/websiteApi.js';

const T = 't_aaaaaaaaaaaaaaaaaaaaaaaa';
const tenantCtx: Ctx = { tenantId: T, via: 'JWT', requestId: 'req-1', role: 'TENANT_ADMIN', sub: 'sub-admin' };
const claims = { sub: 'sub-admin', 'custom:tenant_id': T, 'custom:role': 'TENANT_ADMIN' };

/** Bản ghi HOST đúng như siteManager.createSite ghi (camelCase, kèm PK/SK). */
const hostItem = (slug: string, status = 'PENDING') => ({
  PK: `TENANT#${T}`,
  SK: `HOST#${slug}`,
  slug,
  homeUrl: `https://${slug}.example/`,
  displayName: 'Homestay mẫu',
  sourceLang: 'vi',
  targetLangs: ['en', 'ko'],
  noTranslateSelectors: ['#booking-widget'],
  verificationCode: 'tm-verify-123',
  status,
  createdAt: '2026-11-14T00:00:00.000Z',
});

function setup(overrides: Partial<WebsiteHandlerDependencies> = {}) {
  const hosts = new Map<string, Record<string, unknown>>([['homestay-abc', hostItem('homestay-abc', 'ACTIVE')]]);
  const deps: WebsiteHandlerDependencies = {
    contextFromClaims: async () => tenantCtx,
    listTenantSites: async () => [...hosts.values()] as never,
    getHost: async (_ctx, slug) => hosts.get(slug) ?? null,
    create: async (_ctx, input) => {
      const slug = new URL((input as { homeUrl: string }).homeUrl).hostname.replace(/[^a-z0-9-]/gi, '-');
      hosts.set(slug, { ...hostItem(slug), homeUrl: (input as { homeUrl: string }).homeUrl });
      return { slug, status: 'PENDING', verificationCode: 'tm-verify-123' } as never;
    },
    pause: async () => ({ status: 'PAUSED' }) as never,
    resume: async () => ({ status: 'ACTIVE' }) as never,
    verify: async (_ctx, slug) => {
      const h = hosts.get(slug);
      if (!h) throw new AppError('NOT_FOUND', 'Không tìm thấy website');
      h.status = 'ACTIVE';
      return { status: 'ACTIVE' as const };
    },
    update: async () => ({}) as never,
    ...overrides,
  };
  const handler = createWebsiteHandler(deps);
  const BASE = 'https://api.example/prod';
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.ok(url.pathname.startsWith('/prod/'));
    const path = url.pathname.slice('/prod'.length);
    const parts = path.split('/').filter(Boolean); // console, hosts, {slug}, {action}
    const event: WebsiteEvent = {
      httpMethod: init?.method ?? 'GET',
      path,
      resource: parts.length > 3 ? '/console/hosts/{slug}/{proxy+}' : parts.length === 3 ? '/console/hosts/{slug}' : '/console/hosts',
      pathParameters: parts[2] ? { slug: decodeURIComponent(parts[2]), ...(parts[3] ? { proxy: parts.slice(3).join('/') } : {}) } : undefined,
      body: (init?.body as string | undefined) ?? null,
      requestContext: { requestId: 'req-contract', authorizer: { claims } },
    };
    assert.match(String((init?.headers as Record<string, string>).authorization), /^Bearer id-token$/);
    const res = await handler(event);
    return new Response(res.body, { status: res.statusCode, headers: res.headers });
  }) as typeof fetch;
  return { api: createHttpWebsiteApi({ baseUrl: BASE, getToken: () => 'id-token', fetchFn }), hosts };
}

describe('hợp đồng console websiteApi ↔ WebsiteFunction (/console/hosts)', () => {
  it('danh sách và chi tiết: đọc đủ trường từ bản ghi HOST camelCase', async () => {
    const { api } = setup();
    const [w] = await api.listWebsites();
    assert.deepEqual(w, {
      slug: 'homestay-abc',
      displayName: 'Homestay mẫu',
      homeUrl: 'https://homestay-abc.example/',
      sourceLang: 'vi',
      targetLangs: ['en', 'ko'],
      status: 'ACTIVE',
      verificationCode: 'tm-verify-123',
      noTranslateSelectors: ['#booking-widget'],
      createdAt: '2026-11-14T00:00:00.000Z',
    });
    assert.deepEqual(await api.getWebsite('homestay-abc'), w);
  });

  it('tạo website (201) trả host PENDING có mã xác minh; xác minh xong thành ACTIVE', async () => {
    const { api } = setup();
    const created = await api.createWebsite({
      homeUrl: 'https://site-moi.example/', displayName: 'Site mới', sourceLang: 'vi', targetLangs: ['en'], noTranslateSelectors: [],
    });
    assert.equal(created.slug, 'site-moi-example');
    assert.equal(created.status, 'PENDING');
    assert.equal(created.verificationCode, 'tm-verify-123');
    const verified = await api.verifyWebsite(created.slug, 'META');
    assert.equal(verified.status, 'ACTIVE');
  });

  it('lỗi xác minh của siteManager đến console đúng mã và có thông báo tiếng Việt riêng', async () => {
    for (const code of ['VERIFICATION_CODE_MISMATCH', 'SITE_UNREACHABLE'] as const) {
      const { api } = setup({ verify: async () => { throw new AppError(code, 'x', { reason: code }); } });
      const err = await api.verifyWebsite('homestay-abc', 'FILE').then(() => null, (e: unknown) => e);
      assert.ok(err instanceof WebsiteApiError, code);
      assert.equal(err.code, code);
      assert.equal(err.httpStatus, 422);
      const msg = websiteErrorMessage(err);
      assert.ok(msg && !/lỗi tạm thời|thử lại sau/i.test(msg), `${code}: ${msg}`);
    }
  });

  it('website không tồn tại hoặc thuộc tenant khác -> NOT_FOUND (QC-17)', async () => {
    const { api } = setup();
    const err = await api.getWebsite('khong-co').then(() => null, (e: unknown) => e);
    assert.ok(err instanceof WebsiteApiError);
    assert.equal(err.code, 'NOT_FOUND');
    assert.equal(websiteErrorMessage(err), 'Không tìm thấy website.');
  });
});
