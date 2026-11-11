import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  buildNodeRequestOptions,
  createPinnedLookup,
  createSafeFetch,
  safeFetch,
  SAFE_FETCH_ERROR_CODES,
  type SafeFetchOutcome,
} from '../safeFetch.js';
import {
  PUBLIC_IP,
  PUBLIC_IP_2,
  bodyOf,
  contactedIps,
  fakeResolver,
  fakeTransport,
  hangingBody,
  html,
  infiniteBody,
  redirect,
  response,
} from './helpers.js';

/** Khẳng định kết quả BLOCKED và transport KHÔNG BAO GIỜ được phép chạm tới IP nội bộ. */
function assertBlocked(r: SafeFetchOutcome, reason?: string) {
  assert.equal(r.kind, 'BLOCKED', `mong đợi BLOCKED, nhận ${JSON.stringify(r)}`);
  if (reason && r.kind === 'BLOCKED') assert.equal(r.reason, reason);
}

// ============================================================================
// KỊCH BẢN 6: 9/9 ngăn kết nối IP nội bộ (8 bị chặn hoàn toàn + 1 ghim IP công khai)
// ============================================================================
let scenario6InternalPrevented = 0;
let scenario6Blocked = 0;
let scenario6AllowedPinnedPublic = 0;
const SCENARIO6_TOTAL = 9;

describe('Kịch bản 6 – 9 tình huống SSRF: 0 kết nối tới IP nội bộ (8 bị chặn + 1 ghim IP công khai)', () => {
  after(() => {
    console.log(
      `\n>>> Kịch bản 6: ${scenario6InternalPrevented}/${SCENARIO6_TOTAL} tình huống ngăn kết nối IP nội bộ (${scenario6Blocked}/${SCENARIO6_TOTAL} yêu cầu BLOCKED, ${scenario6AllowedPinnedPublic}/${SCENARIO6_TOTAL} ghim IP công khai an toàn)\n`,
    );
  });

  it('[6.1] http://169.254.169.254/latest/meta-data/ (IP metadata) -> BLOCKED PRIVATE_IP', async () => {
    const resolver = fakeResolver({});
    const transport = fakeTransport({});
    const r = await safeFetch('http://169.254.169.254/latest/meta-data/', {}, { resolver, transport });
    assertBlocked(r, 'PRIVATE_IP');
    assert.equal(transport.calls.length, 0);
    assert.equal(resolver.calls.length, 0, 'IP literal không cần DNS');
    scenario6Blocked++;
    scenario6InternalPrevented++;
  });

  it('[6.2] http://localhost/ (resolver giả -> 127.0.0.1) -> BLOCKED PRIVATE_IP', async () => {
    const resolver = fakeResolver({ localhost: ['127.0.0.1'] });
    const transport = fakeTransport({});
    const r = await safeFetch('http://localhost/', {}, { resolver, transport });
    assertBlocked(r, 'PRIVATE_IP');
    assert.deepEqual(resolver.calls, ['localhost']);
    assert.equal(transport.calls.length, 0);
    scenario6Blocked++;
    scenario6InternalPrevented++;
  });

  it('[6.3] http://127.0.0.1/ -> BLOCKED PRIVATE_IP', async () => {
    const transport = fakeTransport({});
    const r = await safeFetch('http://127.0.0.1/', {}, { resolver: fakeResolver({}), transport });
    assertBlocked(r, 'PRIVATE_IP');
    assert.equal(transport.calls.length, 0);
    scenario6Blocked++;
    scenario6InternalPrevented++;
  });

  it('[6.4] http://10.0.0.1/ -> BLOCKED PRIVATE_IP', async () => {
    const transport = fakeTransport({});
    const r = await safeFetch('http://10.0.0.1/', {}, { resolver: fakeResolver({}), transport });
    assertBlocked(r, 'PRIVATE_IP');
    assert.equal(transport.calls.length, 0);
    scenario6Blocked++;
    scenario6InternalPrevented++;
  });

  it('[6.5] http://[::1]/ -> BLOCKED PRIVATE_IP', async () => {
    const transport = fakeTransport({});
    const r = await safeFetch('http://[::1]/', {}, { resolver: fakeResolver({}), transport });
    assertBlocked(r, 'PRIVATE_IP');
    assert.equal(transport.calls.length, 0);
    scenario6Blocked++;
    scenario6InternalPrevented++;
  });

  it('[6.6] http://[fd00::1]/ -> BLOCKED PRIVATE_IP', async () => {
    const transport = fakeTransport({});
    const r = await safeFetch('http://[fd00::1]/', {}, { resolver: fakeResolver({}), transport });
    assertBlocked(r, 'PRIVATE_IP');
    assert.equal(transport.calls.length, 0);
    scenario6Blocked++;
    scenario6InternalPrevented++;
  });

  it('[6.7] DNS rebinding (lần 1 IP công khai, lần 2 127.0.0.1) -> không phân giải lại, không bao giờ chạm IP nội bộ', async () => {
    const resolver = fakeResolver({ 'rebind.test': (i) => (i === 0 ? [PUBLIC_IP] : ['127.0.0.1']) });
    const transport = fakeTransport({ 'http://rebind.test/': () => html('<p>public</p>') });
    const r = await safeFetch('http://rebind.test/', {}, { resolver, transport });

    // DNS chỉ được hỏi ĐÚNG 1 lần cho 1 lần nhảy; transport nhận đúng IP đã kiểm tra.
    assert.deepEqual(resolver.calls, ['rebind.test'], 'không được phân giải DNS lần 2');
    assert.equal(transport.calls.length, 1);
    assert.deepEqual(contactedIps(transport), [PUBLIC_IP]);
    assert.equal(transport.calls[0].headers.host, 'rebind.test', 'Host vẫn là tên miền gốc');

    // Lookup ghim của transport thật: trả IP đã kiểm tra, không hỏi DNS (dù DNS giờ trả 127.0.0.1).
    const opts = buildNodeRequestOptions(transport.calls[0]);
    const lookup = opts.lookup!;
    const viaLookup = await new Promise<string>((resolve, reject) =>
      lookup('rebind.test', {}, (err, address) => (err ? reject(err) : resolve(String(address)))),
    );
    assert.equal(viaLookup, PUBLIC_IP);
    assert.equal(resolver.calls.length, 1, 'lookup ghim không gọi resolver');
    assert.ok(!contactedIps(transport).includes('127.0.0.1'));
    assert.equal(r.kind, 'OK');
    // Yêu cầu kết nối an toàn tới IP công khai đã ghim (không tăng scenario6Blocked); đích nội bộ 127.0.0.1 không bao giờ được kết nối.
    scenario6AllowedPinnedPublic++;
    scenario6InternalPrevented++;
  });

  it('[6.8] Host công khai trả 302 Location http://10.0.0.1/ -> BLOCKED ở lần chuyển hướng', async () => {
    const resolver = fakeResolver({ 'public.test': [PUBLIC_IP] });
    const transport = fakeTransport({ 'http://public.test/': () => redirect(302, 'http://10.0.0.1/') });
    const r = await safeFetch('http://public.test/', {}, { resolver, transport });
    assertBlocked(r, 'PRIVATE_IP');
    assert.equal(transport.calls.length, 1, 'không được gửi request tới 10.0.0.1');
    assert.deepEqual(contactedIps(transport), [PUBLIC_IP]);
    scenario6Blocked++;
    scenario6InternalPrevented++;
  });

  it('[6.9] http://example.test:22/ (cổng 22) -> BLOCKED PORT, không phân giải DNS', async () => {
    const resolver = fakeResolver({ 'example.test': [PUBLIC_IP] });
    const transport = fakeTransport({});
    const r = await safeFetch('http://example.test:22/', {}, { resolver, transport });
    assertBlocked(r, 'PORT');
    assert.equal(resolver.calls.length, 0);
    assert.equal(transport.calls.length, 0);
    scenario6Blocked++;
    scenario6InternalPrevented++;
  });
});

// ============================================================================
// Test bổ sung – chặn
// ============================================================================
describe('Bổ sung – các dạng IP/URL nguy hiểm', () => {
  const deps = () => ({ resolver: fakeResolver({}), transport: fakeTransport({}) });

  for (const url of [
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:169.254.169.254]/',
    'http://[::ffff:7f00:1]/',
    'http://2130706433/',
    'http://0x7f.1/',
    'http://0x7f000001/',
    'http://0177.0.0.1/',
    'http://0.0.0.0/',
    'http://169.254.169.254./latest/',
    'http://[fd00:ec2::254]/latest/meta-data/',
    'http://[fe80::1]/',
    'http://[64:ff9b::a9fe:a9fe]/',
  ]) {
    it(`${url} -> BLOCKED PRIVATE_IP`, async () => {
      const d = deps();
      const r = await safeFetch(url, {}, d);
      assertBlocked(r, 'PRIVATE_IP');
      assert.equal(d.transport.calls.length, 0);
    });
  }

  it('host có CẢ IP công khai LẪN IP nội bộ -> BLOCKED', async () => {
    const transport = fakeTransport({ 'http://mixed.test/': () => html('x') });
    const r = await safeFetch('http://mixed.test/', {}, { resolver: fakeResolver({ 'mixed.test': [PUBLIC_IP, '10.0.0.5'] }), transport });
    assertBlocked(r, 'PRIVATE_IP');
    assert.equal(transport.calls.length, 0);
  });

  it('host có AAAA nội bộ (fd00::/8) bên cạnh A công khai -> BLOCKED', async () => {
    const transport = fakeTransport({});
    const r = await safeFetch('http://mixed6.test/', {}, { resolver: fakeResolver({ 'mixed6.test': [PUBLIC_IP, 'fd12::1'] }), transport });
    assertBlocked(r, 'PRIVATE_IP');
  });

  it('DNS trả IPv4-mapped nội bộ (::ffff:10.1.2.3) -> BLOCKED', async () => {
    const r = await safeFetch('http://mapped.test/', {}, { resolver: fakeResolver({ 'mapped.test': ['::ffff:10.1.2.3'] }), transport: fakeTransport({}) });
    assertBlocked(r, 'PRIVATE_IP');
  });

  it('DNS trả giá trị không phải IP -> BLOCKED (fail-closed)', async () => {
    const r = await safeFetch('http://garbage.test/', {}, { resolver: fakeResolver({ 'garbage.test': ['not-an-ip'] }), transport: fakeTransport({}) });
    assertBlocked(r, 'PRIVATE_IP');
  });

  for (const [url, reason] of [
    ['ftp://example.test/', 'SCHEME'],
    ['file:///etc/passwd', 'SCHEME'],
    ['http://user:pass@example.test/', 'CREDENTIALS'],
    ['https://example.test:8443/', 'PORT'],
    ['::not a url::', 'INVALID_URL'],
  ] as const) {
    it(`${url} -> BLOCKED ${reason}`, async () => {
      const d = deps();
      assertBlocked(await safeFetch(url, {}, d), reason);
      assert.equal(d.resolver.calls.length, 0);
    });
  }

  it('chuyển hướng tới 169.254.169.254 -> BLOCKED', async () => {
    const transport = fakeTransport({ 'http://public.test/': () => redirect(301, 'http://169.254.169.254/latest/meta-data/') });
    const r = await safeFetch('http://public.test/', {}, { resolver: fakeResolver({ 'public.test': [PUBLIC_IP] }), transport });
    assertBlocked(r, 'PRIVATE_IP');
    assert.equal(transport.calls.length, 1);
  });

  it('chuyển hướng tới tên miền phân giải ra nội bộ -> BLOCKED (kiểm tra lại DNS cho URL mới)', async () => {
    const resolver = fakeResolver({ 'public.test': [PUBLIC_IP], 'internal.test': ['192.168.1.10'] });
    const transport = fakeTransport({ 'http://public.test/': () => redirect(307, 'http://internal.test/admin') });
    assertBlocked(await safeFetch('http://public.test/', {}, { resolver, transport }), 'PRIVATE_IP');
    assert.deepEqual(resolver.calls, ['public.test', 'internal.test']);
  });

  it('chuyển hướng tới cổng 22 / scheme file: -> BLOCKED', async () => {
    const resolver = fakeResolver({ 'public.test': [PUBLIC_IP] });
    const t1 = fakeTransport({ 'http://public.test/': () => redirect(302, 'http://public.test:22/') });
    assertBlocked(await safeFetch('http://public.test/', {}, { resolver, transport: t1 }), 'PORT');
    const t2 = fakeTransport({ 'http://public.test/': () => redirect(302, 'file:///etc/passwd') });
    assertBlocked(await safeFetch('http://public.test/', {}, { resolver, transport: t2 }), 'SCHEME');
  });

  it('rebinding giữa các lần nhảy: chuyển hướng về chính host, lần phân giải mới ra 127.0.0.1 -> BLOCKED', async () => {
    const resolver = fakeResolver({ 'rebind.test': (i) => (i === 0 ? [PUBLIC_IP] : ['127.0.0.1']) });
    const transport = fakeTransport({ 'http://rebind.test/': () => redirect(302, '/step2') });
    assertBlocked(await safeFetch('http://rebind.test/', {}, { resolver, transport }), 'PRIVATE_IP');
    assert.deepEqual(contactedIps(transport), [PUBLIC_IP]);
  });
});

// ============================================================================
// Test bổ sung – ca hợp lệ & giới hạn
// ============================================================================
describe('Bổ sung – ca hợp lệ (không chặn nhầm)', () => {
  it('host công khai trả HTML -> OK', async () => {
    const transport = fakeTransport({ 'https://site.test/page?x=1': () => html('<html><body>Xin chào</body></html>') });
    const r = await safeFetch('https://site.test/page?x=1', {}, { resolver: fakeResolver({ 'site.test': [PUBLIC_IP, '2606:2800:220:1::1'] }), transport });
    assert.equal(r.kind, 'OK');
    if (r.kind === 'OK') {
      assert.equal(r.html, '<html><body>Xin chào</body></html>');
      assert.equal(r.status, 200);
      assert.equal(r.finalUrl, 'https://site.test/page?x=1');
    }
    assert.deepEqual(contactedIps(transport), [PUBLIC_IP, '2606:2800:220:1::1']);
  });

  it('chuyển hướng hợp lệ với Location tương đối -> OK, finalUrl là URL cuối', async () => {
    const resolver = fakeResolver({ 'site.test': [PUBLIC_IP], 'www.site.test': [PUBLIC_IP_2] });
    const transport = fakeTransport({
      'http://site.test/': () => redirect(301, 'https://www.site.test/'),
      'https://www.site.test/': () => redirect(302, '/vi/home'),
      'https://www.site.test/vi/home': () => html('<p>ok</p>'),
    });
    const r = await safeFetch('http://site.test/', {}, { resolver, transport });
    assert.equal(r.kind, 'OK');
    if (r.kind === 'OK') assert.equal(r.finalUrl, 'https://www.site.test/vi/home');
    assert.equal(transport.calls.length, 3);
  });

  it('body gzip được giải nén', async () => {
    const gz = gzipSync(Buffer.from('<p>nén gzip</p>'));
    const transport = fakeTransport({
      'http://site.test/': () => response(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' }, bodyOf([gz])),
    });
    const r = await safeFetch('http://site.test/', {}, { resolver: fakeResolver({ 'site.test': [PUBLIC_IP] }), transport });
    assert.equal(r.kind, 'OK');
    if (r.kind === 'OK') assert.equal(r.html, '<p>nén gzip</p>');
  });

  it('giải mã charset theo Content-Type (windows-1252)', async () => {
    const transport = fakeTransport({
      'http://site.test/': () => response(200, { 'content-type': 'text/html; charset=windows-1252' }, bodyOf([Buffer.from([0x63, 0x61, 0x66, 0xe9])])),
    });
    const r = await safeFetch('http://site.test/', {}, { resolver: fakeResolver({ 'site.test': [PUBLIC_IP] }), transport });
    assert.equal(r.kind === 'OK' && r.html, 'café');
  });

  it('không chuyển Set-Cookie của origin cho nơi gọi', async () => {
    const transport = fakeTransport({ 'http://site.test/': () => html('x', { 'set-cookie': 'sid=1' }) });
    const r = await safeFetch('http://site.test/', {}, { resolver: fakeResolver({ 'site.test': [PUBLIC_IP] }), transport });
    assert.equal(r.kind, 'OK');
    if (r.kind === 'OK') assert.equal(r.headers['set-cookie'], undefined);
  });
});

describe('Bổ sung – giới hạn chuyển hướng', () => {
  const loop = () =>
    fakeTransport({
      'http://loop.test/a': () => redirect(302, '/b'),
      'http://loop.test/b': () => redirect(302, '/a'),
    });

  it('vượt 5 lần chuyển hướng (mặc định) -> TOO_MANY_REDIRECTS', async () => {
    const transport = loop();
    const r = await safeFetch('http://loop.test/a', {}, { resolver: fakeResolver({ 'loop.test': [PUBLIC_IP] }), transport });
    assert.equal(r.kind, 'TOO_MANY_REDIRECTS');
    if (r.kind === 'TOO_MANY_REDIRECTS') assert.equal(r.maxRedirects, 5);
    assert.equal(transport.calls.length, 6, '1 request gốc + 5 lần theo chuyển hướng');
  });

  it('maxRedirects cấu hình được (0 -> không theo chuyển hướng nào)', async () => {
    const transport = loop();
    const r = await safeFetch('http://loop.test/a', { maxRedirects: 0 }, { resolver: fakeResolver({ 'loop.test': [PUBLIC_IP] }), transport });
    assert.equal(r.kind, 'TOO_MANY_REDIRECTS');
    assert.equal(transport.calls.length, 1);
  });

  it('3xx thiếu Location -> NETWORK_ERROR', async () => {
    const transport = fakeTransport({ 'http://site.test/': () => response(302, {}) });
    const r = await safeFetch('http://site.test/', {}, { resolver: fakeResolver({ 'site.test': [PUBLIC_IP] }), transport });
    assert.equal(r.kind, 'NETWORK_ERROR');
  });
});

describe('Bổ sung – giới hạn kích thước', () => {
  const resolver = () => fakeResolver({ 'big.test': [PUBLIC_IP] });

  it('Content-Length > 3 MB -> TOO_LARGE trước khi đọc body', async () => {
    const body = infiniteBody();
    const res = response(200, { 'content-type': 'text/html', 'content-length': String(3 * 1024 * 1024 + 1) }, body);
    const r = await safeFetch('http://big.test/', {}, { resolver: resolver(), transport: fakeTransport({ 'http://big.test/': () => res }) });
    assert.equal(r.kind, 'TOO_LARGE');
    assert.equal(body.pulled(), 0, 'không được đọc body');
    assert.equal(res.destroyed(), true);
  });

  it('body stream không có Content-Length vượt giới hạn -> TOO_LARGE, dừng đọc ngay', async () => {
    const body = infiniteBody(64 * 1024);
    const res = response(200, { 'content-type': 'text/html' }, body);
    const r = await safeFetch('http://big.test/', { maxSizeBytes: 256 * 1024 }, { resolver: resolver(), transport: fakeTransport({ 'http://big.test/': () => res }) });
    assert.equal(r.kind, 'TOO_LARGE');
    assert.ok(body.pulled() <= 6, `chỉ được kéo vài chunk, thực tế ${body.pulled()}`);
    assert.equal(res.destroyed(), true);
  });

  it('giới hạn mặc định 3 MB áp dụng cho stream', async () => {
    const body = infiniteBody(512 * 1024);
    const r = await safeFetch('http://big.test/', {}, { resolver: resolver(), transport: fakeTransport({ 'http://big.test/': () => response(200, { 'content-type': 'text/html' }, body) }) });
    assert.equal(r.kind, 'TOO_LARGE');
    if (r.kind === 'TOO_LARGE') assert.equal(r.limitBytes, 3 * 1024 * 1024);
    assert.ok(body.pulled() <= 8);
  });

  it('gzip bomb: nén nhỏ nhưng giải nén > 3 MB -> TOO_LARGE (tính sau giải nén)', async () => {
    const bomb = gzipSync(Buffer.alloc(8 * 1024 * 1024, 0));
    assert.ok(bomb.length < 64 * 1024, 'payload nén phải nhỏ');
    const res = response(200, { 'content-type': 'text/html', 'content-encoding': 'gzip', 'content-length': String(bomb.length) }, bodyOf([bomb]));
    const r = await safeFetch('http://big.test/', {}, { resolver: resolver(), transport: fakeTransport({ 'http://big.test/': () => res }) });
    assert.equal(r.kind, 'TOO_LARGE');
    if (r.kind === 'TOO_LARGE') assert.match(r.detail, /giải nén/);
  });
});

describe('Bổ sung – timeout', () => {
  it('transport treo -> TIMEOUT (total)', async () => {
    const transport = fakeTransport({ 'http://slow.test/': () => new Promise(() => {}) });
    const t0 = Date.now();
    const r = await safeFetch('http://slow.test/', { timeoutMs: 80 }, { resolver: fakeResolver({ 'slow.test': [PUBLIC_IP] }), transport });
    assert.equal(r.kind, 'TIMEOUT');
    if (r.kind === 'TIMEOUT') assert.equal(r.phase, 'total');
    assert.ok(Date.now() - t0 < 2000);
  });

  it('body treo giữa chừng -> TIMEOUT (total)', async () => {
    const res = response(200, { 'content-type': 'text/html' }, hangingBody());
    const r = await safeFetch('http://slow.test/', { timeoutMs: 80 }, { resolver: fakeResolver({ 'slow.test': [PUBLIC_IP] }), transport: fakeTransport({ 'http://slow.test/': () => res }) });
    assert.equal(r.kind, 'TIMEOUT');
    assert.equal(res.destroyed(), true);
  });

  it('DNS treo -> TIMEOUT (total)', async () => {
    const resolver = Object.assign(async () => new Promise<never>(() => {}), { calls: [] as string[] });
    const r = await safeFetch('http://slow.test/', { timeoutMs: 80 }, { resolver, transport: fakeTransport({}) });
    assert.equal(r.kind, 'TIMEOUT');
  });

  it('transport báo hết thời gian kết nối -> TIMEOUT (connect)', async () => {
    const transport = fakeTransport({
      'http://slow.test/': () => {
        throw Object.assign(new Error('connect timeout'), { code: SAFE_FETCH_ERROR_CODES.CONNECT_TIMEOUT });
      },
    });
    const r = await safeFetch('http://slow.test/', { connectTimeoutMs: 50 }, { resolver: fakeResolver({ 'slow.test': [PUBLIC_IP] }), transport });
    assert.equal(r.kind, 'TIMEOUT');
    if (r.kind === 'TIMEOUT') assert.equal(r.phase, 'connect');
  });
});

describe('Bổ sung – Content-Type', () => {
  it('application/json -> NOT_HTML kèm finalUrl, không đọc body', async () => {
    const body = infiniteBody();
    const res = response(200, { 'content-type': 'application/json' }, body);
    const r = await safeFetch('http://site.test/api', {}, { resolver: fakeResolver({ 'site.test': [PUBLIC_IP] }), transport: fakeTransport({ 'http://site.test/api': () => res }) });
    assert.equal(r.kind, 'NOT_HTML');
    if (r.kind === 'NOT_HTML') {
      assert.equal(r.finalUrl, 'http://site.test/api');
      assert.equal(r.contentType, 'application/json');
    }
    assert.equal(body.pulled(), 0);
    assert.equal(res.destroyed(), true);
  });

  it('ảnh sau chuyển hướng -> NOT_HTML với URL cuối cùng', async () => {
    const transport = fakeTransport({
      'http://site.test/logo': () => redirect(302, 'https://cdn.site.test/logo.png'),
      'https://cdn.site.test/logo.png': () => response(200, { 'content-type': 'image/png' }),
    });
    const r = await safeFetch('http://site.test/logo', {}, { resolver: fakeResolver({ 'site.test': [PUBLIC_IP], 'cdn.site.test': [PUBLIC_IP_2] }), transport });
    assert.equal(r.kind, 'NOT_HTML');
    if (r.kind === 'NOT_HTML') assert.equal(r.finalUrl, 'https://cdn.site.test/logo.png');
  });

  it('thiếu Content-Type -> NOT_HTML', async () => {
    const r = await safeFetch('http://site.test/', {}, { resolver: fakeResolver({ 'site.test': [PUBLIC_IP] }), transport: fakeTransport({ 'http://site.test/': () => response(200, {}) }) });
    assert.equal(r.kind, 'NOT_HTML');
  });

  it('allowedContentTypes cho F6 (sitemap XML) -> OK', async () => {
    const transport = fakeTransport({ 'http://site.test/sitemap.xml': () => response(200, { 'content-type': 'application/xml' }, bodyOf(['<urlset/>'])) });
    const r = await safeFetch('http://site.test/sitemap.xml', { allowedContentTypes: ['application/xml', 'text/xml'] }, { resolver: fakeResolver({ 'site.test': [PUBLIC_IP] }), transport });
    assert.equal(r.kind, 'OK');
  });
});

describe('Bổ sung – header gửi đi', () => {
  it('KHÔNG gửi Cookie/Authorization dù người gọi truyền vào', async () => {
    const transport = fakeTransport({ 'http://site.test/': () => html('x') });
    await safeFetch(
      'http://site.test/',
      {
        headers: {
          Cookie: 'session=secret',
          cookie: 'a=b',
          Authorization: 'Bearer secret',
          'proxy-authorization': 'Basic x',
          Host: 'evil.test',
          'X-Forwarded-For': '127.0.0.1',
          'Accept-Language': 'vi-VN',
        },
      },
      { resolver: fakeResolver({ 'site.test': [PUBLIC_IP] }), transport },
    );
    const sent = transport.calls[0].headers;
    const keys = Object.keys(sent).map((k) => k.toLowerCase());
    for (const forbidden of ['cookie', 'authorization', 'proxy-authorization', 'x-forwarded-for']) {
      assert.ok(!keys.includes(forbidden), `không được gửi ${forbidden}`);
    }
    assert.equal(sent.host, 'site.test');
    assert.equal(sent['accept-language'], 'vi-VN');
    // Transport thật cũng chỉ nhận header đã làm sạch, method GET.
    const nodeOpts = buildNodeRequestOptions(transport.calls[0]);
    assert.equal(nodeOpts.method, 'GET');
    assert.ok(!Object.keys(nodeOpts.headers ?? {}).some((k) => ['cookie', 'authorization'].includes(k.toLowerCase())));
  });

  it('header vẫn sạch ở các lần chuyển hướng', async () => {
    const transport = fakeTransport({
      'http://a.test/': () => redirect(302, 'http://b.test/'),
      'http://b.test/': () => html('x'),
    });
    await safeFetch('http://a.test/', { headers: { Authorization: 'x', Cookie: 'y' } }, { resolver: fakeResolver({ 'a.test': [PUBLIC_IP], 'b.test': [PUBLIC_IP_2] }), transport });
    assert.equal(transport.calls.length, 2);
    for (const c of transport.calls) {
      assert.equal(c.headers.cookie, undefined);
      assert.equal(c.headers.authorization, undefined);
    }
    assert.equal(transport.calls[1].headers.host, 'b.test');
  });
});

describe('Bổ sung – transport thật (không mở kết nối)', () => {
  const req = (url: string, addresses = [{ address: PUBLIC_IP, family: 4 as const }]) => ({
    url: new URL(url),
    addresses,
    headers: { host: new URL(url).host },
    connectTimeoutMs: 5000,
    signal: new AbortController().signal,
  });

  it('HTTPS: SNI = tên miền gốc, xác thực chứng chỉ bật, không dùng agent chung', () => {
    const o = buildNodeRequestOptions(req('https://site.test/a?b=1'));
    assert.equal(o.host, 'site.test');
    assert.equal(o.servername, 'site.test');
    assert.equal(o.rejectUnauthorized, true);
    assert.equal(o.agent, false);
    assert.equal(o.path, '/a?b=1');
    assert.equal(o.port, 443);
  });

  it('lookup ghim hỗ trợ all:true (autoSelectFamily của Node 20)', async () => {
    const lookup = createPinnedLookup([{ address: PUBLIC_IP, family: 4 }, { address: '2606:2800:220:1::1', family: 6 }]);
    const all = await new Promise<unknown>((resolve, reject) => lookup('x', { all: true }, (e, a) => (e ? reject(e) : resolve(a))));
    assert.deepEqual(all, [{ address: PUBLIC_IP, family: 4 }, { address: '2606:2800:220:1::1', family: 6 }]);
  });

  it('lookup ghim từ chối IP nội bộ tại điểm kết nối (phòng thủ chiều sâu)', async () => {
    const lookup = createPinnedLookup([{ address: '10.0.0.1', family: 4 }]);
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => lookup('x', {}, (e) => resolve(e)));
    assert.equal(err?.code, SAFE_FETCH_ERROR_CODES.BLOCKED_AT_CONNECT);
  });

  it('transport ném lỗi BLOCKED_AT_CONNECT -> BLOCKED PRIVATE_IP', async () => {
    const transport = fakeTransport({
      'http://site.test/': () => {
        throw Object.assign(new Error('blocked'), { code: SAFE_FETCH_ERROR_CODES.BLOCKED_AT_CONNECT });
      },
    });
    assertBlocked(await safeFetch('http://site.test/', {}, { resolver: fakeResolver({ 'site.test': [PUBLIC_IP] }), transport }), 'PRIVATE_IP');
  });
});

describe('Bổ sung – không bao giờ throw', () => {
  it('DNS lỗi -> NETWORK_ERROR', async () => {
    const r = await safeFetch('http://nxdomain.test/', {}, { resolver: fakeResolver({}), transport: fakeTransport({}) });
    assert.equal(r.kind, 'NETWORK_ERROR');
    if (r.kind === 'NETWORK_ERROR') assert.equal(r.code, 'ENOTFOUND');
  });

  it('DNS trả rỗng -> NETWORK_ERROR', async () => {
    const r = await safeFetch('http://empty.test/', {}, { resolver: fakeResolver({ 'empty.test': [] }), transport: fakeTransport({}) });
    assert.equal(r.kind, 'NETWORK_ERROR');
  });

  it('transport ECONNREFUSED -> NETWORK_ERROR', async () => {
    const transport = fakeTransport({
      'http://site.test/': () => {
        throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      },
    });
    const r = await safeFetch('http://site.test/', {}, { resolver: fakeResolver({ 'site.test': [PUBLIC_IP] }), transport });
    assert.equal(r.kind, 'NETWORK_ERROR');
  });

  it('transport ném giá trị không phải Error -> NETWORK_ERROR', async () => {
    const transport = fakeTransport({
      'http://site.test/': () => {
        throw 'boom';
      },
    });
    const r = await safeFetch('http://site.test/', {}, { resolver: fakeResolver({ 'site.test': [PUBLIC_IP] }), transport });
    assert.equal(r.kind, 'NETWORK_ERROR');
  });

  it('gzip hỏng -> NETWORK_ERROR', async () => {
    const transport = fakeTransport({
      'http://site.test/': () => response(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }, bodyOf([Buffer.from('not gzip')])),
    });
    const r = await safeFetch('http://site.test/', {}, { resolver: fakeResolver({ 'site.test': [PUBLIC_IP] }), transport });
    assert.equal(r.kind, 'NETWORK_ERROR');
  });
});

describe('safe_fetch – đúng chữ ký interfaces.d.ts', () => {
  it('OK -> FetchResult { status, headers, body, finalUrl, isHtml: true }', async () => {
    const fetcher = createSafeFetch({ resolver: fakeResolver({ 'site.test': [PUBLIC_IP] }), transport: fakeTransport({ 'http://site.test/': () => html('<p>hi</p>') }) });
    const r = await fetcher('http://site.test/', { timeoutMs: 1000, maxSizeBytes: 1024 });
    assert.equal(r.status, 200);
    assert.equal(r.body, '<p>hi</p>');
    assert.equal(r.isHtml, true);
    assert.equal(r.finalUrl, 'http://site.test/');
    assert.equal(r.outcome.kind, 'OK');
  });

  it('BLOCKED -> status 0, body rỗng, outcome.kind = BLOCKED (không throw)', async () => {
    const fetcher = createSafeFetch({ resolver: fakeResolver({}), transport: fakeTransport({}) });
    const r = await fetcher('http://169.254.169.254/');
    assert.equal(r.status, 0);
    assert.equal(r.body, '');
    assert.equal(r.isHtml, false);
    assert.equal(r.outcome.kind, 'BLOCKED');
  });

  it('NOT_HTML -> isHtml false, finalUrl = URL cuối', async () => {
    const fetcher = createSafeFetch({ resolver: fakeResolver({ 'site.test': [PUBLIC_IP] }), transport: fakeTransport({ 'http://site.test/a.pdf': () => response(200, { 'content-type': 'application/pdf' }) }) });
    const r = await fetcher('http://site.test/a.pdf');
    assert.equal(r.isHtml, false);
    assert.equal(r.status, 200);
    assert.equal(r.finalUrl, 'http://site.test/a.pdf');
    assert.equal(r.outcome.kind, 'NOT_HTML');
  });
});
