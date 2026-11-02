import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSEG, segPath } from '../../../libs/common/seg.js';
import { createTM } from '../../../libs/common/tm.js';
import type { Ctx } from '../../../libs/common/types.js';
import { createProxyHandler, type FunctionUrlEvent, type ProxyDeps } from '../handler.js';
import { staticSiteResolver, type SiteConfig } from '../sites.js';
import { hashSentenceStub } from '../stubs.js';
import { SAMPLE_PAGE, SITE, fakeFetch, fakeLogger, fakeQuota, fakeTranslate, memorySegDb, memoryTmDb, okHtml } from './helpers.js';

const ev = (rawPath: string): FunctionUrlEvent => ({ rawPath, requestContext: { requestId: 'req-seg', http: { method: 'GET' } } });
const ctx: Ctx = { tenantId: SITE.tenantId, via: 'SLUG', requestId: 'x', slug: SITE.slug };
const SITE_B = { ...SITE, slug: 'homestay-abc-2', homeUrl: 'https://homestay-abc-2.vn/' } as SiteConfig;

function setup(o: Partial<ProxyDeps> & { segDb?: ReturnType<typeof memorySegDb>; withSeg?: boolean } = {}) {
  const segDb = o.segDb ?? memorySegDb();
  const logger = fakeLogger();
  const translateClient = fakeTranslate();
  const handler = createProxyHandler({
    resolveSite: staticSiteResolver([SITE, SITE_B]),
    fetchPage: fakeFetch((u) => okHtml(SAMPLE_PAGE, u)),
    translateClient,
    publicBaseUrl: 'https://d1abc.cloudfront.net',
    logger,
    quota: fakeQuota(),
    tm: createTM({ db: memoryTmDb(), writer: 'proxy' }),
    getGlossaryState: async () => ({ version: 1, terminologyName: null, terms: [] }),
    ...(o.withSeg === false ? {} : { seg: createSEG({ db: segDb }) }),
    ...o,
  });
  return { handler, segDb, logger, seg: createSEG({ db: segDb }), translateClient };
}

describe('proxy + chỉ mục câu–trang SEG (3.4)', () => {
  it('ghi SEG cho mọi câu của trang; <path> gồm slug; GSI2 trả đúng các câu của trang', async () => {
    const { handler, seg, logger } = setup();
    const res = await handler(ev('/homestay-abc/en/phong-nghi/'));
    assert.equal(res.statusCode, 200);
    const n = logger.infos[0].sentences as number;
    assert.ok(n > 0);
    assert.equal(logger.infos[0].segWritten, n);
    assert.equal(res.headers['cache-control'], 'public, max-age=0, s-maxage=86400');

    const path = segPath('homestay-abc', 'phong-nghi/');
    assert.equal(path, '/homestay-abc/phong-nghi/');
    const hashes = await seg.sentencesOfPage(ctx, 'en', path);
    assert.equal(hashes.length, n);
    assert.ok(hashes.includes(hashSentenceStub('Chào mừng')));
    assert.deepEqual(await seg.pagesOfSentence(ctx, hashSentenceStub('Chào mừng'), 'en'), [path]);
    assert.deepEqual(await seg.sentencesOfPage(ctx, 'ko', path), [], 'ngôn ngữ khác chưa có');
  });

  it('trang chủ và trang con, hai website cùng tenant: mỗi trang một <path> riêng', async () => {
    const { handler, seg } = setup();
    await handler(ev('/homestay-abc/en/'));
    await handler(ev('/homestay-abc/en/phong-nghi/'));
    await handler(ev('/homestay-abc-2/en/phong-nghi/'));
    const pages = (await seg.pagesOfSentence(ctx, hashSentenceStub('Chào mừng'), 'en')).sort();
    assert.deepEqual(pages, ['/homestay-abc-2/phong-nghi/', '/homestay-abc/', '/homestay-abc/phong-nghi/']);
  });

  it('trang dịch dở (hết giờ) vẫn ghi SEG cho cả câu chưa dịch', async () => {
    let t = 0;
    const { handler, seg, logger } = setup({ now: () => (t += 5_000), budgetMs: 4_000 });
    const res = await handler(ev('/homestay-abc/en/'));
    assert.equal(res.headers['x-translateme-partial'], '1');
    assert.equal(logger.infos[0].translated, 0);
    assert.equal((await seg.sentencesOfPage(ctx, 'en', '/homestay-abc/')).length, logger.infos[0].sentences);
  });

  it('ghi SEG lỗi -> trang vẫn 200, không gắn partial, nhưng cache ngắn và ghi log', async () => {
    const { handler, logger } = setup({ segDb: memorySegDb({ failWith: 'ProvisionedThroughputExceededException' }) });
    const res = await handler(ev('/homestay-abc/en/'));
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['x-translateme-partial'], undefined);
    assert.equal(res.headers['cache-control'], 'public, max-age=0, s-maxage=60');
    assert.equal(logger.infos[0].outcome, 'OK');
    assert.equal(logger.infos[0].segWriteFailed, logger.infos[0].sentences);
    assert.deepEqual(logger.infos[0].segWriteErrors, ['ProvisionedThroughputExceededException']);
  });

  it('không cấu hình SEG -> không ghi, cache bình thường', async () => {
    const { handler, segDb, logger } = setup({ withSeg: false });
    const res = await handler(ev('/homestay-abc/en/'));
    assert.equal(res.headers['cache-control'], 'public, max-age=0, s-maxage=86400');
    assert.equal(segDb.store.size, 0);
    assert.equal(logger.infos[0].segWritten, undefined);
  });

  it('cacheSeconds vượt 7 ngày (SiteResolver không qua xác thực) -> s-maxage bị chặn ở 7 ngày, ngắn hơn TTL SEG', async () => {
    const longCache = { ...SITE, cacheSeconds: 100 * 86_400 } as SiteConfig;
    const { handler } = setup({ resolveSite: staticSiteResolver([longCache]) });
    const res = await handler(ev('/homestay-abc/en/'));
    assert.equal(res.headers['cache-control'], `public, max-age=0, s-maxage=${7 * 86_400}`);
  });

  it('câu lặp lại trên trang chỉ có một bản ghi SEG', async () => {
    const page = `<!doctype html><html lang="vi"><head><title>T</title></head><body><p>Xin chào.</p><p>Xin chào.</p><p>Tạm biệt.</p></body></html>`;
    const { handler, segDb, logger } = setup({ fetchPage: fakeFetch((u) => okHtml(page, u)) });
    await handler(ev('/homestay-abc/en/lap/'));
    const total = logger.infos[0].sentences as number;
    assert.ok(total >= 3);
    assert.equal(segDb.store.size, total - 1);
  });
});
