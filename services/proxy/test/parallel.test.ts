/**
 * Proxy 2.5: dịch song song, ngân sách 20 giây, trang dịch dở, hạn mức ký tự (B.11) và gửi phần còn lại cho worker (B.10).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTM, tmKey } from '../../../libs/common/tm.js';
import { createTranslator, type TranslateResult } from '../../../libs/common/translator.js';
import type { Ctx } from '../../../libs/common/types.js';
import { createProxyHandler, type FunctionUrlEvent, type ProxyDeps } from '../handler.js';
import { staticSiteResolver } from '../sites.js';
import { countCharsStub, hashSentenceStub } from '../stubs.js';
import { createWorkerHandler } from '../worker.js';
import type { WorkerEvent } from '../workerEvents.js';
import { SAMPLE_PAGE, SITE, fakeFetch, fakeLogger, fakeQuota, fakeTranslate, memoryTmDb, okHtml, throttlingError, upperCaseOutsideTags } from './helpers.js';

const ev = (rawPath: string): FunctionUrlEvent => ({ rawPath, requestContext: { requestId: 'req-25', http: { method: 'GET' } } });
const ctx: Ctx = { tenantId: SITE.tenantId, via: 'SLUG', requestId: 'x', slug: SITE.slug };
const GLOSSARY = { version: 2, terminologyName: 'tm-t_8f3a', terms: [] };

function setup(o: Partial<ProxyDeps> & { page?: string; withTm?: boolean; db?: ReturnType<typeof memoryTmDb> } = {}) {
  const db = o.db ?? memoryTmDb();
  const translateClient = (o.translateClient as ReturnType<typeof fakeTranslate>) ?? fakeTranslate();
  const quota = fakeQuota();
  const logger = fakeLogger();
  const events: WorkerEvent[] = [];
  const handler = createProxyHandler({
    resolveSite: staticSiteResolver([SITE]),
    fetchPage: fakeFetch((u) => okHtml(o.page ?? SAMPLE_PAGE, u)),
    translateClient,
    publicBaseUrl: 'https://d1abc.cloudfront.net',
    logger,
    quota,
    invokeWorker: async (e) => void events.push(e),
    ...(o.withTm === false ? {} : { tm: createTM({ db, writer: 'proxy' }), getGlossaryState: async () => GLOSSARY }),
    ...o,
  });
  return { handler, db, translateClient, quota, logger, events };
}

/** Trang có n đoạn văn, mỗi đoạn một câu khác nhau. */
const bigPage = (n: number) =>
  `<html><body>${Array.from({ length: n }, (_, i) => `<p>Đoạn số ${i} giới thiệu <b>phòng nghỉ</b> và dịch vụ của homestay.</p>`).join('\n')}</body></html>`;

describe('proxy 2.5 – dịch song song', () => {
  it('chia nhiều khối, gọi song song có giới hạn, ráp đúng thứ tự câu', async () => {
    const { handler, translateClient, logger } = setup({ page: bigPage(400), concurrency: 3 });
    const res = await handler(ev('/homestay-abc/en/'));
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['x-translateme-partial'], undefined);
    assert.ok(translateClient.calls.length > 3, 'nhiều khối');
    assert.ok(translateClient.maxInFlight <= 3 && translateClient.maxInFlight > 1, 'song song, tối đa 3');
    for (let i = 0; i < 400; i += 57) {
      assert.ok(res.body.includes(`<p>ĐOẠN SỐ ${i} GIỚI THIỆU <b>PHÒNG NGHỈ</b> VÀ DỊCH VỤ CỦA HOMESTAY.</p>`), `đoạn ${i}`);
    }
    assert.equal(logger.infos[0].translated, 400);
    assert.equal(logger.infos[0].pending, 0);
  });
});

describe('proxy 2.5 – hạn mức ký tự (B.11)', () => {
  it('đặt trước đúng số ký tự câu trượt TM, settleUsage theo website; lần 2 trúng TM không đặt trước', async () => {
    const { handler, quota, logger } = setup();
    await handler(ev('/homestay-abc/en/'));
    const total = logger.infos[0].sentences as number;
    assert.equal(quota.reserves.length, 1);
    assert.equal(quota.reserves[0].ctx.tenantId, SITE.tenantId);
    const n = quota.reserves[0].n;
    assert.ok(n > 0);
    assert.deepEqual(quota.settles[0].source, { kind: 'WEB', slug: 'homestay-abc' });
    assert.deepEqual(quota.settles[0].r, { month: '2026-10', reserved: n });
    assert.deepEqual(quota.settles[0].u, { machineChars: n, memoryChars: 0, sentTotal: total, sentFromTM: 0, requests: 1, pagesServed: 1 });

    await handler(ev('/homestay-abc/en/'));
    assert.equal(quota.reserves.length, 1, 'không có câu trượt -> không gọi reserveChars');
    assert.equal(quota.settles[1].r.reserved, 0);
    assert.deepEqual(quota.settles[1].u, { machineChars: 0, memoryChars: n, sentTotal: total, sentFromTM: total, requests: 1, pagesServed: 1 });
  });

  it('countChars không tính ký hiệu {n}', async () => {
    assert.equal(countCharsStub('Xem {1}bảng  giá{/1} nhé.'), 'Xem bảng giá nhé.'.length);
  });

  it('hết hạn mức -> không gọi Translate, câu trong TM vẫn dịch, s-maxage=300 + X-TranslateMe-Partial: quota', async () => {
    const db = memoryTmDb();
    const key = tmKey(ctx, 'vi', 'en', hashSentenceStub('Chào mừng'));
    db.store.set(`${key.PK}|${key.SK}`, { ...key, src: 'Chào mừng', tgt: 'Welcome', label: 'HUMAN', glossaryVersion: 1 });
    const quota = fakeQuota({ limit: 0 });
    const { handler, translateClient, logger, events } = setup({ db, quota });
    const res = await handler(ev('/homestay-abc/en/'));
    assert.equal(res.statusCode, 200);
    assert.equal(translateClient.calls.length, 0);
    assert.equal(res.headers['x-translateme-partial'], 'quota');
    assert.equal(res.headers['cache-control'], 'public, max-age=0, s-maxage=300');
    assert.ok(res.body.includes('<h1>Welcome</h1>'), 'câu trúng TM vẫn hiển thị bản dịch');
    assert.ok(res.body.includes('<a href="/homestay-abc/en/">Trang chủ</a>'), 'câu trượt giữ ngôn ngữ gốc');
    assert.equal(logger.infos[0].outcome, 'PARTIAL_QUOTA');
    assert.equal(quota.settles[0].u.machineChars, 0);
    assert.equal(quota.settles[0].u.memoryChars, 'Chào mừng'.length);
    assert.equal(events.length, 0, 'hết hạn mức thì không gửi worker');
  });

  it('reserveChars lỗi khác (DynamoDB) -> 302 về trang gốc', async () => {
    const quota = fakeQuota({ reserveError: Object.assign(new Error('x'), { name: 'ProvisionedThroughputExceededException' }) });
    const { handler, translateClient, logger } = setup({ quota });
    const res = await handler(ev('/homestay-abc/en/'));
    assert.equal(res.statusCode, 302);
    assert.equal(translateClient.calls.length, 0);
    assert.equal(logger.errors[0].action, 'PROXY_UNEXPECTED_ERROR');
  });

  it('bộ dịch ném lỗi -> hoàn lại phần đặt trước rồi 302', async () => {
    const quota = fakeQuota();
    const { handler } = setup({ quota, translate: async () => Promise.reject(new Error('boom')) });
    const res = await handler(ev('/homestay-abc/en/'));
    assert.equal(res.statusCode, 302);
    assert.equal(quota.releases.length, 1);
    assert.equal(quota.releases[0].reserved, quota.reserves[0].n);
  });

  it('settleUsage lỗi -> trang vẫn trả 200, chỉ ghi log', async () => {
    const quota = fakeQuota({ settleError: Object.assign(new Error('x'), { name: 'TransactionCanceledException' }) });
    const { handler, logger } = setup({ quota });
    const res = await handler(ev('/homestay-abc/en/'));
    assert.equal(res.statusCode, 200);
    assert.equal(logger.infos[0].usageError, 'TransactionCanceledException');
  });
});

describe('proxy 2.5 – hết ngân sách thời gian và worker (B.10)', () => {
  it('hết giờ -> trang dịch dở (s-maxage=60), gửi FINISH_PAGE; worker dịch nốt; lần sau trúng TM, cache dài', async () => {
    let t = 0;
    const db = memoryTmDb();
    const slow = setup({ db, now: () => (t += 5_000), budgetMs: 4_000 });
    const res = await slow.handler(ev('/homestay-abc/en/phong-nghi/'));
    assert.equal(res.headers['x-translateme-partial'], '1');
    assert.equal(res.headers['cache-control'], 'public, max-age=0, s-maxage=60');
    assert.equal(slow.translateClient.calls.length, 0);
    assert.equal(slow.events.length, 1);
    const e = slow.events[0];
    const total = slow.logger.infos[0].sentences as number;
    assert.equal(slow.logger.infos[0].workerEvents, 1);
    assert.equal(slow.logger.infos[0].pending, total);
    assert.deepEqual(
      { type: e.type, tenantId: e.tenantId, slug: e.slug, src: e.src, tgt: e.tgt, path: e.path, gv: e.glossaryVersion, term: e.terminologyName },
      { type: 'FINISH_PAGE', tenantId: SITE.tenantId, slug: 'homestay-abc', src: 'vi', tgt: 'en', path: 'phong-nghi/', gv: 2, term: 'tm-t_8f3a' },
    );
    assert.equal(e.sentences?.length, total);
    for (const s of e.sentences ?? []) assert.equal(s.hash, hashSentenceStub(s.text));

    // Worker C13 xử lý sự kiện (cùng bảng TM)
    const quota = fakeQuota();
    const worker = createWorkerHandler({
      resolveSite: staticSiteResolver([SITE]),
      tm: createTM({ db, writer: 'worker' }),
      translate: createTranslator(fakeTranslate()),
      quota,
      logger: fakeLogger(),
    });
    const wr = await worker(JSON.parse(JSON.stringify(e)));
    assert.equal(wr.status, 'DONE');
    assert.equal(wr.translated, total);

    // Visitor tải lại: trúng TM toàn bộ
    const fast = setup({ db });
    const again = await fast.handler(ev('/homestay-abc/en/phong-nghi/'));
    assert.equal(fast.translateClient.calls.length, 0);
    assert.equal(again.headers['x-translateme-partial'], undefined);
    assert.equal(again.headers['cache-control'], 'public, max-age=0, s-maxage=86400');
    assert.ok(again.body.includes('<h1>CHÀO MỪNG</h1>'));
  });

  it('Translate lỗi tạm thời -> câu lỗi cũng gửi worker; SENTENCE_TOO_LARGE thì không', async () => {
    const result: TranslateResult = {
      translated: [{ id: 0, tgt: 'HOMESTAY ABC', needsReview: false }],
      pending: [3],
      failed: [
        { id: 1, reason: 'SENTENCE_TOO_LARGE' },
        { id: 2, reason: 'ThrottlingException' },
      ],
      stats: { uniqueSentences: 4, calls: 1, charsSent: 20, splits: 0, plainFallbacks: 0 },
    };
    const { handler, events, logger } = setup({ translate: async () => result });
    const res = await handler(ev('/homestay-abc/en/'));
    assert.equal(res.headers['x-translateme-partial'], '1');
    assert.deepEqual(events[0].sentences?.map((s) => s.id), [2, 3]);
    assert.deepEqual(logger.infos[0].failedReasons, ['SENTENCE_TOO_LARGE', 'ThrottlingException']);
  });

  it('gọi worker lỗi -> trang vẫn trả 200, ghi log', async () => {
    const { handler, logger } = setup({
      translateClient: fakeTranslate(() => Promise.reject(throttlingError())),
      invokeWorker: async () => Promise.reject(Object.assign(new Error('x'), { name: 'TooManyRequestsException' })),
    });
    const res = await handler(ev('/homestay-abc/en/'));
    assert.equal(res.statusCode, 200);
    assert.equal(logger.infos[0].workerError, 'TooManyRequestsException');
    assert.equal(logger.infos[0].workerEvents, 0);
  });

  it('không có TM -> không gửi worker (worker chỉ ghi được vào TM)', async () => {
    let t = 0;
    const { handler, events } = setup({ withTm: false, now: () => (t += 5_000), budgetMs: 4_000 });
    const res = await handler(ev('/homestay-abc/en/'));
    assert.equal(res.headers['x-translateme-partial'], '1');
    assert.equal(events.length, 0);
  });

  it('dịch đủ -> không gửi worker', async () => {
    const { handler, events } = setup({ translateClient: fakeTranslate(upperCaseOutsideTags) });
    await handler(ev('/homestay-abc/en/'));
    assert.equal(events.length, 0);
  });
});
