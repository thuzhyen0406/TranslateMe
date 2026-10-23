import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SafeFetchOutcome } from '../../../libs/common/safeFetch.js';
import {
  MAX_RESPONSE_BYTES,
  buildOriginUrl,
  createProxyHandler,
  depsFromEnv,
  parseProxyPath,
  type FunctionUrlEvent,
  type ProxyDeps,
} from '../handler.js';
import { staticSiteResolver, type SiteConfig } from '../sites.js';
import { SAMPLE_PAGE, SITE, fakeFetch, fakeLogger, fakeTranslate, okHtml, throttlingError } from './helpers.js';

const CF = 'https://d1abc.cloudfront.net';

function ev(rawPath: string, method = 'GET', rawQueryString = ''): FunctionUrlEvent {
  return { rawPath, rawQueryString, requestContext: { requestId: 'req-1', http: { method } } };
}

function setup(o: Partial<ProxyDeps> & { sites?: SiteConfig[]; outcome?: (url: string) => SafeFetchOutcome } = {}) {
  const fetchPage = fakeFetch(o.outcome ?? ((url) => okHtml(SAMPLE_PAGE, url)));
  const translateClient = o.translateClient ?? fakeTranslate();
  const logger = fakeLogger();
  const handler = createProxyHandler({
    resolveSite: staticSiteResolver(o.sites ?? [SITE]),
    fetchPage,
    translateClient,
    publicBaseUrl: CF,
    logger,
    ...o,
  });
  return { handler, fetchPage, translateClient, logger };
}

describe('parseProxyPath / buildOriginUrl', () => {
  it('tách /{slug}/{lang}/{path}', () => {
    assert.deepEqual(parseProxyPath('/homestay-abc/en/phong-nghi/deluxe'), { slug: 'homestay-abc', lang: 'en', rest: 'phong-nghi/deluxe' });
    assert.deepEqual(parseProxyPath('/homestay-abc/en'), { slug: 'homestay-abc', lang: 'en', rest: '' });
    assert.deepEqual(parseProxyPath('/homestay-abc/zh-TW/'), { slug: 'homestay-abc', lang: 'zh-TW', rest: '' });
    for (const bad of ['/', '/homestay-abc', '/Homestay/en/', '/abc/english/', '/abc_x/en/', 'abc/en/']) {
      assert.equal(parseProxyPath(bad), null, bad);
    }
  });

  it('ghép URL trang gốc, giữ query, không thoát ra ngoài website', () => {
    const home = 'https://homestay-abc.vn/blog/';
    assert.equal(buildOriginUrl(home, 'bai-1/', 'a=1&b=2'), 'https://homestay-abc.vn/blog/bai-1/?a=1&b=2');
    assert.equal(buildOriginUrl(home, ''), 'https://homestay-abc.vn/blog/');
    assert.equal(buildOriginUrl(home, '%E1%BA%A1'), 'https://homestay-abc.vn/blog/%E1%BA%A1');
    assert.equal(buildOriginUrl(home, '/evil.com/x'), 'https://homestay-abc.vn/blog//evil.com/x', 'không đổi host');
    assert.equal(buildOriginUrl(home, '../shop/'), null, 'ra khỏi thư mục trang chủ');
    assert.equal(buildOriginUrl(home, '..%2F..%2Fshop'), 'https://homestay-abc.vn/blog/..%2F..%2Fshop');
    assert.equal(buildOriginUrl('https://a.vn/', '@evil.com/x'), 'https://a.vn/@evil.com/x');
  });
});

describe('proxy – luồng thành công', () => {
  it('tải, dịch, ráp HTML và trả cache dài', async () => {
    const { handler, fetchPage, logger } = setup();
    const res = await handler(ev('/homestay-abc/en/phong-nghi/', 'GET', 'ref=fb'));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(fetchPage.urls, ['https://homestay-abc.vn/phong-nghi/?ref=fb']);
    assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(res.headers['cache-control'], 'public, max-age=0, s-maxage=86400');
    assert.equal(res.headers['content-language'], 'en');
    assert.equal(res.headers['x-translateme-partial'], undefined);

    const html = res.body;
    assert.ok(html.includes('<html lang="en">'));
    assert.ok(html.includes('<title>HOMESTAY ABC</title>'));
    assert.ok(html.includes('<a href="/homestay-abc/en/">TRANG CHỦ</a>'));
    assert.ok(html.includes('PHÒNG CÓ <strong>BAN CÔNG</strong> NHÌN RA SÔNG. XEM <a href="/homestay-abc/en/bang-gia">BẢNG GIÁ</a> NHÉ.'));
    assert.ok(html.includes('<div id="booking-widget">Đặt phòng ngay</div>'), 'vùng không dịch của website');
    assert.ok(html.includes('alt="SÂN VƯỜN"'));
    assert.ok(html.includes('src="https://homestay-abc.vn/img/a.jpg"'));
    assert.ok(html.includes('href="https://homestay-abc.vn/css/site.css"'));
    assert.ok(html.includes(`<link rel="canonical" href="${CF}/homestay-abc/en/phong-nghi/?ref=fb">`));
    assert.ok(html.includes(`<link rel="alternate" hreflang="ko" href="${CF}/homestay-abc/ko/phong-nghi/?ref=fb">`));
    assert.ok(html.includes('id="tm-lang"'));

    const entry = logger.infos[0];
    assert.equal(entry.outcome, 'OK');
    assert.equal(entry.slug, 'homestay-abc');
    assert.ok(Number(entry.charsSent) > 0);
    assert.ok(!JSON.stringify(entry).includes('BAN CÔNG'), 'log không chứa nội dung trang');
  });

  it('BASE_MODE=host: liên kết /{lang}/…, canonical theo tên miền con', async () => {
    const { handler } = setup({ baseMode: 'host', publicBaseUrl: 'https://translateme.example' });
    const res = await handler(ev('/homestay-abc/ko/'));
    assert.ok(res.body.includes('<a href="/ko/bang-gia">'));
    assert.ok(res.body.includes('<link rel="canonical" href="https://homestay-abc.translateme.example/ko/">'));
  });

  it('HEAD: cùng header, không có body', async () => {
    const { handler } = setup();
    const res = await handler(ev('/homestay-abc/en/', 'HEAD'));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, '');
    assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
  });

  it('origin chuyển hướng trong website: dùng URL cuối để ráp', async () => {
    const { handler } = setup({ outcome: () => okHtml(SAMPLE_PAGE, 'https://homestay-abc.vn/phong-nghi/') });
    const res = await handler(ev('/homestay-abc/en/phong-nghi'));
    assert.ok(res.body.includes(`<link rel="canonical" href="${CF}/homestay-abc/en/phong-nghi/">`));
  });
});

describe('proxy – trang dịch dở', () => {
  it('Translate lỗi -> vẫn trả 200, câu chưa dịch giữ gốc, cache ngắn + X-TranslateMe-Partial', async () => {
    const { handler, logger } = setup({ translateClient: fakeTranslate(() => Promise.reject(throttlingError())) });
    const res = await handler(ev('/homestay-abc/en/'));
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['x-translateme-partial'], '1');
    assert.equal(res.headers['cache-control'], 'public, max-age=0, s-maxage=60');
    assert.ok(res.body.includes('<h1>Chào mừng</h1>'));
    assert.equal(logger.infos[0].outcome, 'PARTIAL');
    assert.deepEqual(logger.infos[0].translateErrors, ['ThrottlingException']);
  });

  it('hết ngân sách thời gian -> trả trang dịch dở', async () => {
    let t = 0;
    const { handler, translateClient } = setup({ now: () => (t += 5_000), budgetMs: 4_000 });
    const res = await handler(ev('/homestay-abc/en/'));
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['x-translateme-partial'], '1');
    assert.equal((translateClient as ReturnType<typeof fakeTranslate>).calls.length, 0);
  });
});

describe('proxy – từ chối và chuyển hướng', () => {
  it('phương thức khác GET/HEAD -> 405', async () => {
    const res = await setup().handler(ev('/homestay-abc/en/', 'POST'));
    assert.equal(res.statusCode, 405);
    assert.equal(res.headers.allow, 'GET, HEAD');
  });

  it('đường dẫn sai, slug lạ, ngôn ngữ chưa bật hoặc là ngôn ngữ gốc -> 404, không tải trang', async () => {
    const { handler, fetchPage } = setup();
    for (const p of ['/', '/homestay-abc', '/khong-co/en/', '/homestay-abc/ja/', '/homestay-abc/vi/', '/HOMESTAY-ABC/en/']) {
      assert.equal((await handler(ev(p))).statusCode, 404, p);
    }
    assert.equal(fetchPage.urls.length, 0);
  });

  it('website tạm dừng hoặc tenant bị khoá -> 302 về trang tương ứng trên website gốc', async () => {
    for (const patch of [{ status: 'PAUSED' }, { status: 'PENDING' }, { tenantStatus: 'LOCKED' }] as Partial<SiteConfig>[]) {
      const { handler, fetchPage } = setup({ sites: [{ ...SITE, ...patch }] });
      const res = await handler(ev('/homestay-abc/en/lien-he', 'GET', 'x=1'));
      assert.equal(res.statusCode, 302, JSON.stringify(patch));
      assert.equal(res.headers.location, 'https://homestay-abc.vn/lien-he?x=1');
      assert.equal(fetchPage.urls.length, 0);
    }
  });

  it('ánh xạ kết quả safe_fetch theo Quy ước mục 3.1', async () => {
    const cases: Array<[SafeFetchOutcome, number, string?]> = [
      [{ kind: 'NOT_HTML', finalUrl: 'https://homestay-abc.vn/a.pdf', contentType: 'application/pdf', status: 200, headers: {} }, 302, 'https://homestay-abc.vn/a.pdf'],
      [{ kind: 'BLOCKED', reason: 'PRIVATE_IP', url: 'https://homestay-abc.vn/', detail: '' }, 403],
      [{ kind: 'TOO_LARGE', finalUrl: 'https://homestay-abc.vn/', limitBytes: 1, detail: '' }, 302, 'https://homestay-abc.vn/'],
      [{ kind: 'TOO_MANY_REDIRECTS', finalUrl: 'https://homestay-abc.vn/', maxRedirects: 5 }, 502],
      [{ kind: 'TIMEOUT', finalUrl: 'https://homestay-abc.vn/', phase: 'total', timeoutMs: 10_000 }, 504],
      [{ kind: 'NETWORK_ERROR', finalUrl: 'https://homestay-abc.vn/', code: 'ECONNRESET', detail: '' }, 502],
    ];
    for (const [outcome, status, location] of cases) {
      const res = await setup({ outcome: () => outcome }).handler(ev('/homestay-abc/en/'));
      assert.equal(res.statusCode, status, outcome.kind);
      if (location) assert.equal(res.headers.location, location, outcome.kind);
    }
  });

  it('origin trả mã khác 2xx -> 302 về trang gốc, không cache', async () => {
    const res = await setup({ outcome: (u) => okHtml('<p>Không tìm thấy</p>', u, 404) }).handler(ev('/homestay-abc/en/x'));
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, 'https://homestay-abc.vn/x');
    assert.equal(res.headers['cache-control'], 'no-store');
  });

  it('origin chuyển hướng sang tên miền khác -> không dịch, chuyển Visitor tới đó', async () => {
    const res = await setup({ outcome: () => okHtml(SAMPLE_PAGE, 'https://login.other.vn/') }).handler(ev('/homestay-abc/en/'));
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, 'https://login.other.vn/');
  });

  it('lỗi không lường trước (HTML lồng quá sâu) -> 302 về trang gốc, ghi log lỗi', async () => {
    const deep = `${'<div>'.repeat(4000)}Sâu${'</div>'.repeat(4000)}`;
    const { handler, logger } = setup({ outcome: (u) => okHtml(deep, u) });
    const res = await handler(ev('/homestay-abc/en/'));
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, 'https://homestay-abc.vn/');
    assert.equal(logger.errors[0].action, 'PROXY_UNEXPECTED_ERROR');
  });

  it('trang dịch vượt giới hạn phản hồi 6 MB của Lambda -> 302 về trang gốc', async () => {
    const big = `<html><body><p>Xin chào</p><pre>${'x'.repeat(MAX_RESPONSE_BYTES)}</pre></body></html>`;
    const res = await setup({ outcome: (u) => okHtml(big, u) }).handler(ev('/homestay-abc/en/'));
    assert.equal(res.statusCode, 302);
  });
});

describe('depsFromEnv', () => {
  it('đọc PROXY_SITES_JSON, BASE_MODE, PUBLIC_BASE_URL, ngân sách thời gian', async () => {
    const logger = fakeLogger();
    const d = depsFromEnv(
      { PROXY_SITES_JSON: JSON.stringify([SITE]), BASE_MODE: 'host', PUBLIC_BASE_URL: CF, TRANSLATE_BUDGET_MS: '15000' },
      logger,
    );
    assert.equal(d.baseMode, 'host');
    assert.equal(d.publicBaseUrl, CF);
    assert.equal(d.budgetMs, 15_000);
    assert.equal((await d.resolveSite('homestay-abc'))?.tenantId, SITE.tenantId);
    assert.deepEqual(logger.errors, []);
  });

  it('JSON hỏng hoặc thiếu PUBLIC_BASE_URL -> ghi log lỗi, mặc định path, không có website nào', async () => {
    const logger = fakeLogger();
    const d = depsFromEnv({ PROXY_SITES_JSON: '[{', BASE_MODE: 'abc' }, logger);
    assert.equal(d.baseMode, 'path');
    assert.equal(await d.resolveSite('homestay-abc'), null);
    assert.deepEqual(logger.errors.map((e) => e.action), ['INVALID_PROXY_SITES_JSON', 'MISSING_PUBLIC_BASE_URL']);
  });

  it('USE_FETCH_STUB=1 -> dùng safe_fetch stub (trang mẫu cố định, không gọi mạng)', async () => {
    const d = depsFromEnv({ USE_FETCH_STUB: '1', PUBLIC_BASE_URL: CF }, fakeLogger());
    const r = await d.fetchPage('https://homestay-abc.vn/');
    assert.equal(r.outcome.kind, 'OK');
    assert.equal(r.headers['x-translateme-stub'], '1');
  });
});
