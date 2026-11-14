// Tổng duyệt offline cho 5.4 (không cần AWS): chạy demo/proxyCheck.ts trên lõi proxy F2 THẬT (createProxyHandler,
// worker C13, TM/SEG trong bộ nhớ) với website mẫu A do tools/build-sites.ts sinh, Translate giả (bỏ dấu tiếng Việt,
// chậm theo độ dài để trang dài thành trang dịch dở) và CloudFront giả (cache theo s-maxage, header x-cache).
//
//   (cd ../services/proxy && npm run build) && npm run rehearsal:proxy
//
// Mọi kiểm tra phải ĐẠT; trên stack thật chạy `npm run demo:proxy-check`.
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const E2E = path.resolve(__dirname, '..');
const PROXY = pathToFileURL(path.resolve(E2E, '..', 'services', 'proxy', 'dist')).href;
const { runProxyCheck } = require(path.join(E2E, 'demo/proxyCheck.ts'));
const { buildSites } = require(path.join(E2E, 'tools/build-sites.ts'));

(async () => {
  const { createProxyHandler } = await import(`${PROXY}/services/proxy/handler.js`);
  const { createWorkerHandler } = await import(`${PROXY}/services/proxy/worker.js`);
  const { createTM } = await import(`${PROXY}/libs/common/tm.js`);
  const { createSEG } = await import(`${PROXY}/libs/common/seg.js`);
  const { createTranslator } = await import(`${PROXY}/libs/common/translator.js`);
  const { staticSiteResolver } = await import(`${PROXY}/services/proxy/sites.js`);
  const H = await import(`${PROXY}/services/proxy/test/helpers.js`);

  const ORIGIN = 'https://tm-mau-a.example.net/';
  const PUB = 'https://d123.cloudfront.net';
  const SLUG = 'tm-mau-a-example-net';
  const files = buildSites({ outDir: '/dev/null', origins: { A: ORIGIN }, verifyCodes: {} }).A;
  const site = { slug: SLUG, tenantId: 't_aaaaaaaaaaaaaaaaaaaaaaaa', homeUrl: ORIGIN, sourceLang: 'vi', targetLangs: ['en', 'ko'], exclusionSelectors: [], cacheSeconds: 86400, status: 'ACTIVE', tenantStatus: 'ACTIVE' };

  const fetchPage = H.fakeFetch((url) => {
    const rest = new URL(url).pathname.replace(/^\//, '');
    const f = files.get(`${rest}index.html`) ?? files.get(rest);
    if (f === undefined) return H.okHtml('<h1>404</h1>', url, 404);
    if (Buffer.byteLength(f) > 3_000_000) return { kind: 'TOO_LARGE', finalUrl: url, limitBytes: 3_000_000, detail: '' };
    return H.okHtml(f, url);
  });
  const deaccent = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
  // Translate giả: bỏ dấu ngoài thẻ, chậm 30 ms mỗi lời gọi để trang dài vượt ngân sách
  const client = H.fakeTranslate(async (text) => { await new Promise((r) => setTimeout(r, 20 + text.length / 20)); return text.replace(/(<[^>]+>)|([^<]+)/g, (_a, tag, plain) => tag ?? deaccent(plain)); });
  const tmDb = H.memoryTmDb();
  const segDb = H.memorySegDb();
  const glossary = async () => ({ version: 1, terminologyName: null, terms: [] });
  const tm = createTM({ db: tmDb, writer: 'proxy' });
  const worker = createWorkerHandler({ resolveSite: staticSiteResolver([site]), tm: createTM({ db: tmDb, writer: 'worker' }), translate: createTranslator(client), quota: H.fakeQuota(), getGlossaryState: glossary, logger: H.fakeLogger() });
  const pending = [];
  const proxy = createProxyHandler({
    resolveSite: staticSiteResolver([site]), fetchPage, translateClient: client, publicBaseUrl: PUB, budgetMs: 400, concurrency: 2,
    tm, seg: createSEG({ db: segDb }), getGlossaryState: glossary, quota: H.fakeQuota(), logger: H.fakeLogger(),
    invokeWorker: async (e) => { pending.push(worker(e)); },
  });

  // CloudFront giả: lưu theo URL khi s-maxage > 0
  const cache = new Map();
  const get = async (url, o = {}) => {
    const t0 = Date.now();
    const u = new URL(url);
    const method = o.method ?? 'GET';
    const key = `${method === 'HEAD' ? 'GET' : method} ${u.pathname}${u.search}`;
    const hit = cache.get(key);
    let res, xCache;
    if (hit && hit.until > Date.now()) { res = hit.res; xCache = 'Hit from cloudfront'; }
    else {
      res = await proxy({ rawPath: u.pathname, rawQueryString: u.search.slice(1), requestContext: { requestId: `r${Math.random()}`, http: { method } } });
      xCache = 'Miss from cloudfront';
      const sm = /s-maxage=(\d+)/.exec(res.headers['cache-control'] ?? '');
      if (sm && Number(sm[1]) > 0) cache.set(key, { res, until: Date.now() + Number(sm[1]) * 1000 });
    }
    await Promise.all(pending.splice(0));
    const body = method === 'HEAD' ? '' : res.body;
    return { url, status: res.statusCode, ms: Date.now() - t0, body, bytes: Buffer.byteLength(body), xCache, partial: res.headers['x-translateme-partial'] ?? '', cacheControl: res.headers['cache-control'] ?? '', location: res.headers.location ?? '', age: '' };
  };
  // Trang dịch dở có s-maxage=60: tổng duyệt không chờ 60 s, nên bỏ cache của trang dịch dở trước lượt hỏi lại
  const wait = async () => { for (const [k, v] of cache) if (v.res.headers['x-translateme-partial']) cache.delete(k); };
  const rows = await runProxyCheck({ publicBase: PUB, slug: SLUG, lang: 'en', origin: ORIGIN, get, wait });
  for (const r of rows) console.log(`${r.pass ? 'ĐẠT     ' : r.severity === 'fail' ? 'LỖI     ' : 'CẢNH BÁO'} ${r.page} ${r.id} – ${r.detail}`);
  const bad = rows.filter((r) => !r.pass);
  console.log(`${rows.length - bad.length}/${rows.length} đạt (tổng duyệt offline).`);
  if (bad.length) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exit(1); });
