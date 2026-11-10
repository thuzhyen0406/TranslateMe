import assert from 'node:assert/strict';

import { describe, it } from 'node:test';

import {
  WebsiteApiError,
  createHttpWebsiteApi,
  createMockWebsiteApi,
  isPrewarmActive,
  parseSelectors,
  prewarmJobFromJson,
  translationUrl,
  validateCreateWebsite,
  validateHomeUrlInput,
  verificationFileUrl,
  verificationMetaTag,
  websiteErrorMessage,
  websiteFromJson,
  isWebsiteApiEnabled,
} from '../services/websiteApi.js';
import type { CreateWebsiteInput } from '../types/website.js';
import { errorToUiPayload } from '../services/errorMapping.js';

const form = (o: Partial<CreateWebsiteInput> = {}): CreateWebsiteInput => ({
  homeUrl: 'https://homestay-abc.example',
  displayName: 'Homestay ABC Hội An',
  sourceLang: 'vi',
  targetLangs: ['en', 'ko'],
  noTranslateSelectors: [],
  ...o,
});

describe('Q2 – kiểm tra khi nhập (Task 4.6)', () => {
  it('chỉ nhận http/https với tên miền công khai', () => {
    assert.deepEqual(validateHomeUrlInput(' https://homestay-abc.example/vi#top '), { ok: true, url: 'https://homestay-abc.example/vi' });
    assert.equal(validateHomeUrlInput('http://homestay-abc.example').ok, true);
    for (const bad of ['', 'homestay-abc', 'ftp://a.example', 'http://localhost/', 'http://intranet/', 'http://printer.local', 'http://10.0.0.5', 'http://127.0.0.1', 'http://8.8.8.8', 'http://[::1]/', 'http://u:p@a.example', 'http://a.example:8080']) {
      assert.equal(validateHomeUrlInput(bad).ok, false, bad);
    }
  });

  it('kiểm tra từng trường của bước 1', () => {
    assert.deepEqual(validateCreateWebsite(form()), {});
    const e = validateCreateWebsite(form({ homeUrl: 'http://localhost', displayName: ' ', targetLangs: ['vi'], noTranslateSelectors: ['<script>'] }));
    assert.deepEqual(Object.keys(e).sort(), ['displayName', 'homeUrl', 'noTranslateSelectors', 'targetLangs']);
    assert.ok(validateCreateWebsite(form({ sourceLang: 'xx' })).sourceLang);
  });

  it('bộ chọn CSS, đường dẫn bản dịch, thẻ meta và tệp xác minh', () => {
    assert.deepEqual(parseSelectors('.no-translate, #booking-widget\n.no-translate ,'), ['.no-translate', '#booking-widget']);
    assert.equal(translationUrl('https://d1abc.cloudfront.net/', 'homestay-abc', 'en'), 'https://d1abc.cloudfront.net/homestay-abc/en/');
    assert.equal(verificationMetaTag('ts-7f3a9c2e41'), '<meta name="translateme-site-verification" content="ts-7f3a9c2e41">');
    assert.equal(verificationFileUrl('https://homestay-abc.example/vi/'), 'https://homestay-abc.example/translateme-verification.txt');
  });

  it('thông báo lỗi tiếng Việt theo Bảng 2.10, kể cả mã hiện tại của siteManager', () => {
    const msg = (code: string, reason?: string) => websiteErrorMessage(new WebsiteApiError(code, '', reason));
    assert.match(msg('VERIFICATION_FAILED', 'UNREACHABLE'), /Không truy cập được/);
    assert.match(msg('VERIFICATION_FAILED', 'TAG_OR_FILE_NOT_FOUND'), /Không tìm thấy thẻ meta/);
    assert.match(msg('VERIFICATION_FAILED', 'TOO_MANY_REDIRECTS'), /chuyển hướng/);
    assert.match(msg('VERIFICATION_CODE_MISMATCH'), /không khớp/);
    assert.match(msg('SITE_UNREACHABLE'), /Không truy cập được/);
    assert.match(msg('DUPLICATE_SLUG'), /đã được thêm/);
    assert.match(msg('PERMISSION_DENIED'), /Tenant Admin/);
    assert.match(websiteErrorMessage(new Error('x')), /lỗi tạm thời/);

    const prewarm500 = errorToUiPayload(
      new WebsiteApiError('INTERNAL_ERROR', 'StartExecution failed', undefined, 'req-pw-500', 500),
      { scope: 'website', operation: 'write', formatMessage: websiteErrorMessage },
    );
    assert.ok(prewarm500);
    assert.equal(prewarm500.retryable, false);
    assert.equal(prewarm500.requiresStatusCheck, true);
    assert.match(prewarm500.message, /kiểm tra trạng thái hiện tại trước khi gửi lại/i);

    const getPrewarm500 = errorToUiPayload(
      new WebsiteApiError('INTERNAL_ERROR', 'Get failed', undefined, 'req-pw-get', 500),
      { scope: 'website', operation: 'read', formatMessage: websiteErrorMessage },
    );
    assert.ok(getPrewarm500);
    assert.equal(getPrewarm500.retryable, true);
    assert.equal(getPrewarm500.requiresStatusCheck, undefined);
  });
});

describe('websiteFromJson / prewarmJobFromJson', () => {
  it('đổi JSON snake_case của API (và camelCase của siteManager) sang kiểu của console', () => {
    const w = websiteFromJson({ slug: 'a', display_name: 'A', home_url: 'https://a.example/', source_lang: 'vi', target_langs: ['en'], status: 'ACTIVE', verification_code: 'c', no_translate_selectors: ['#x'], created_at: 't' });
    assert.deepEqual(w, { slug: 'a', displayName: 'A', homeUrl: 'https://a.example/', sourceLang: 'vi', targetLangs: ['en'], status: 'ACTIVE', verificationCode: 'c', noTranslateSelectors: ['#x'], createdAt: 't' });
    assert.equal(websiteFromJson({ slug: 'b', displayName: 'B', homeUrl: 'h', status: 'LẠ' }).status, 'PENDING');
    assert.equal(prewarmJobFromJson(null), null);
    const j = prewarmJobFromJson({ job_id: 'job-1', status: 'RUNNING', progress: 140, total: 4, done: 2, failed: 0, warnings: [], reason: 'X' })!;
    assert.deepEqual([j.progress, j.reason], [100, 'X']);
    assert.equal(isPrewarmActive(j), true);
    assert.equal(isPrewarmActive({ ...j, status: 'SUCCEEDED' }), false);
  });
});

describe('isWebsiteApiEnabled (cờ bật màn Website ở chế độ Cognito)', () => {
  it('demo luôn bật; Cognito chỉ bật khi VITE_WEBSITE_API_ENABLED=true', () => {
    assert.equal(isWebsiteApiEnabled({ demoMode: true }), true);
    assert.equal(isWebsiteApiEnabled({ demoMode: true, flag: 'false' }), true);
    assert.equal(isWebsiteApiEnabled({ demoMode: false }), false);
    for (const flag of ['', 'false', '0', 'yes', '1']) assert.equal(isWebsiteApiEnabled({ demoMode: false, flag }), false, flag);
    for (const flag of ['true', ' TRUE ', 'True']) assert.equal(isWebsiteApiEnabled({ demoMode: false, flag }), true, flag);
  });
});

describe('createHttpWebsiteApi', () => {
  function fakeFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown }) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const r = handler(url, init);
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    return { fn, calls };
  }

  it('gọi đúng route /console/hosts với JWT, body snake_case', async () => {
    const f = fakeFetch((url, init) => {
      if (url.endsWith('/console/hosts') && init.method === 'POST') return { status: 201, body: { host: { slug: 'homestay-abc-example', status: 'PENDING', verification_code: 'ts-1' } } };
      if (url.endsWith('/verify')) return { status: 200, body: { host: { slug: 'homestay-abc-example', status: 'ACTIVE' } } };
      if (url.endsWith('/prewarm') && init.method === 'POST') return { status: 202, body: { job: { job_id: 'job-1', status: 'QUEUED', progress: 0 }, existing: false } };
      if (url.endsWith('/prewarm')) return { status: 200, body: { job: null } };
      return { status: 200, body: { hosts: [{ slug: 'a', status: 'ACTIVE' }] } };
    });
    const api = createHttpWebsiteApi({ baseUrl: 'https://api.example/prod/', getToken: () => 'jwt-1', fetchFn: f.fn });
    const created = await api.createWebsite(form({ noTranslateSelectors: ['#booking-widget'] }));
    assert.equal(created.verificationCode, 'ts-1');
    assert.equal(f.calls[0].url, 'https://api.example/prod/console/hosts');
    assert.equal((f.calls[0].init.headers as Record<string, string>).authorization, 'Bearer jwt-1');
    assert.deepEqual(JSON.parse(String(f.calls[0].init.body)), {
      home_url: 'https://homestay-abc.example',
      display_name: 'Homestay ABC Hội An',
      source_lang: 'vi',
      target_langs: ['en', 'ko'],
      no_translate_selectors: ['#booking-widget'],
    });
    assert.equal((await api.verifyWebsite('homestay-abc-example', 'FILE')).status, 'ACTIVE');
    assert.equal(f.calls[1].url, 'https://api.example/prod/console/hosts/homestay-abc-example/verify');
    assert.deepEqual(JSON.parse(String(f.calls[1].init.body)), { method: 'FILE' });
    assert.deepEqual((await api.startPrewarm('homestay-abc-example')).existing, false);
    assert.equal(await api.getPrewarm('homestay-abc-example'), null);
    assert.equal((await api.listWebsites())[0].slug, 'a');
  });

  it('lỗi API thành WebsiteApiError giữ code và reason; lỗi mạng thành NETWORK_ERROR', async () => {
    const f = fakeFetch(() => ({ status: 400, body: { request_id: 'r', error: { code: 'VERIFICATION_FAILED', message: 'x', reason: 'CODE_MISMATCH' } } }));
    const api = createHttpWebsiteApi({ baseUrl: 'https://api.example', getToken: () => 't', fetchFn: f.fn });
    await assert.rejects(api.verifyWebsite('a', 'META'), (e: unknown) => e instanceof WebsiteApiError && e.code === 'VERIFICATION_FAILED' && e.reason === 'CODE_MISMATCH');
    const down = createHttpWebsiteApi({ baseUrl: 'https://api.example', getToken: () => 't', fetchFn: (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch });
    await assert.rejects(down.listWebsites(), (e: unknown) => e instanceof WebsiteApiError && e.code === 'NETWORK_ERROR');
  });
});

describe('createMockWebsiteApi (chế độ demo)', () => {
  it('thêm website -> PENDING kèm mã; xác minh -> ACTIVE; slug sinh từ tên miền như siteManager', async () => {
    const api = createMockWebsiteApi({ codeFor: () => 'ts-demo' });
    const w = await api.createWebsite(form());
    assert.deepEqual([w.slug, w.status, w.verificationCode], ['homestay-abc-example', 'PENDING', 'ts-demo']);
    await assert.rejects(api.createWebsite(form()), (e: unknown) => e instanceof WebsiteApiError && e.code === 'DUPLICATE_SLUG');
    assert.equal((await api.verifyWebsite(w.slug, 'META')).status, 'ACTIVE');
    assert.equal((await api.listWebsites()).length, 1);
  });

  it('địa chỉ demo chứa "sai-ma" hoặc "khong-truy-cap" để thử thông báo lỗi', async () => {
    const api = createMockWebsiteApi();
    const a = await api.createWebsite(form({ homeUrl: 'https://sai-ma.example' }));
    await assert.rejects(api.verifyWebsite(a.slug, 'META'), (e: unknown) => e instanceof WebsiteApiError && e.reason === 'CODE_MISMATCH');
    const b = await api.createWebsite(form({ homeUrl: 'https://khong-truy-cap.example' }));
    await assert.rejects(api.verifyWebsite(b.slug, 'FILE'), (e: unknown) => e instanceof WebsiteApiError && e.reason === 'UNREACHABLE');
  });

  it('dịch trước: chỉ khi ACTIVE; bấm lại khi đang chạy trả job cũ; tiến độ tăng tới SUCCEEDED', async () => {
    const api = createMockWebsiteApi({ prewarmStep: 50 });
    const w = await api.createWebsite(form());
    await assert.rejects(api.startPrewarm(w.slug), (e: unknown) => e instanceof WebsiteApiError && e.code === 'INVALID_REQUEST');
    await api.verifyWebsite(w.slug, 'META');
    assert.equal(await api.getPrewarm(w.slug), null);
    const s = await api.startPrewarm(w.slug);
    assert.equal(s.existing, false);
    assert.equal((await api.startPrewarm(w.slug)).existing, true);
    assert.deepEqual([(await api.getPrewarm(w.slug))!.progress, (await api.getPrewarm(w.slug))!.status], [50, 'SUCCEEDED']);
    await assert.rejects(api.getWebsite('khong-co'), (e: unknown) => e instanceof WebsiteApiError && e.code === 'NOT_FOUND');
  });
});
