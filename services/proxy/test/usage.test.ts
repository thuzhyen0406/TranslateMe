/**
 * QC-7: proxy, worker và prewarm (countRequests = false) đếm hạn mức qua UsageService thật (libs/common/usage)
 * bằng usageServiceQuota, trên DynamoDB giả tôn trọng ProjectionExpression và điều kiện giao dịch.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createTM } from '../../../libs/common/tm.js';
import { createTranslator } from '../../../libs/common/translator.js';
import type { Ctx } from '../../../libs/common/types.js';
import { UsageConfigError, UsageService, monthUtc } from '../../../libs/common/usage/usage.js';
import { createProxyHandler, type FunctionUrlEvent, type ProxyDeps } from '../handler.js';
import { staticSiteResolver } from '../sites.js';
import { countCharsStub } from '../stubs.js';
import { emptyReservation, isCharQuotaExceeded, usageServiceQuota } from '../usage.js';
import { createWorkerHandler } from '../worker.js';
import type { WorkerEvent } from '../workerEvents.js';
import { SAMPLE_PAGE, SITE, fakeFetch, fakeLogger, fakeTranslate, memoryTmDb, okHtml } from './helpers.js';
import { memoryUsageDb } from './usageDb.js';

const T = SITE.tenantId;
const USAGE_PK = `TENANT#${T}#USAGE`;
const GLOSSARY = { version: 1, terminologyName: null, terms: [] };
const ctx: Ctx = { tenantId: T, via: 'SLUG', requestId: 'req-1', slug: SITE.slug };
const ev = (rawPath: string, requestId = 'req-1'): FunctionUrlEvent => ({ rawPath, requestContext: { requestId, http: { method: 'GET' } } });

/** CONFIG đúng như PostConfirmation ghi: hạn mức nằm ở charLimit (không có characterLimit). */
function usageSetup(charLimit: number | null = 50_000) {
  const ddb = memoryUsageDb();
  if (charLimit !== null) ddb.seed({ PK: `TENANT#${T}`, SK: 'CONFIG', plan: 'Free', charLimit, status: 'ACTIVE' });
  const service = new UsageService(ddb as unknown as DynamoDBDocumentClient, { tableName: 'translate-data', maxTransactionAttempts: 1 });
  let seq = 0;
  const quota = usageServiceQuota(service, { newId: () => `id${++seq}` });
  const month = monthUtc();
  return {
    ddb,
    service,
    quota,
    total: () => ddb.get(USAGE_PK, `MONTH#${month}`) ?? {},
    web: () => ddb.get(USAGE_PK, `MONTH#${month}#WEB#${SITE.slug}`) ?? {},
    reservations: () => [...ddb.items.values()].filter((i) => String(i.SK).startsWith('RESERVATION#')),
  };
}

function proxySetup(u: ReturnType<typeof usageSetup>, o: Partial<ProxyDeps> & { tmDb?: ReturnType<typeof memoryTmDb> } = {}) {
  const tmDb = o.tmDb ?? memoryTmDb();
  const translateClient = fakeTranslate();
  const logger = fakeLogger();
  const events: WorkerEvent[] = [];
  const handler = createProxyHandler({
    resolveSite: staticSiteResolver([SITE]),
    fetchPage: fakeFetch((url) => okHtml(SAMPLE_PAGE, url)),
    translateClient,
    publicBaseUrl: 'https://d1abc.cloudfront.net',
    logger,
    quota: u.quota,
    tm: createTM({ db: tmDb, writer: 'proxy' }),
    getGlossaryState: async () => GLOSSARY,
    invokeWorker: async (e) => void events.push(e),
    ...o,
  });
  return { handler, tmDb, translateClient, logger, events };
}

describe('usageServiceQuota – proxy F2 trên UsageService thật (QC-7)', () => {
  it('trang có câu trượt: đặt trước rồi quyết toán đúng tháng UTC, ghi cả dòng tổng lẫn WEB#slug', async () => {
    const u = usageSetup();
    const { handler, translateClient, logger } = proxySetup(u);
    const res = await handler(ev('/homestay-abc/en/'));
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['x-translateme-partial'], undefined);
    assert.equal(logger.infos[0].usageError, undefined);
    assert.ok(translateClient.calls.length > 0);

    const total = u.total();
    const n = Number(total.machineChars);
    assert.ok(n > 0);
    assert.deepEqual(
      { memoryChars: total.memoryChars, requests: total.requests, pagesServed: total.pagesServed, tmHits: total.tmHits },
      { memoryChars: 0, requests: 1, pagesServed: 1, tmHits: 0 },
    );
    assert.equal(u.web().machineChars, n, 'nguồn WEB#slug nhận số thực tế');
    const [r] = u.reservations();
    assert.equal(r.status, 'SETTLED');
    assert.equal(r.reservedChars, n);
    assert.equal(r.requestId, 'req-1:id1');
    assert.deepEqual(r.source, { kind: 'WEB', slug: SITE.slug });
  });

  it('lượt sau trúng TM hết: không tốn ký tự, vẫn đếm memoryChars, requests và pagesServed', async () => {
    const u = usageSetup();
    const { handler, tmDb } = proxySetup(u);
    await handler(ev('/homestay-abc/en/', 'req-1'));
    const before = u.total();
    const second = proxySetup(u, { tmDb });
    const res = await second.handler(ev('/homestay-abc/en/', 'req-2'));
    assert.equal(res.statusCode, 200);
    assert.equal(second.translateClient.calls.length, 0);
    const after = u.total();
    assert.equal(after.machineChars, before.machineChars);
    assert.equal(after.memoryChars, before.machineChars, 'ký tự lần trước dịch máy, lần này lấy từ TM');
    assert.equal(after.requests, 2);
    assert.equal(after.pagesServed, 2);
    assert.equal(after.tmHits, Number(before.tmMisses));
    assert.equal(u.reservations().length, 2);
    assert.ok(u.reservations().every((r) => r.status === 'SETTLED'));
  });

  it('hạn mức đọc từ CONFIG.charLimit (PostConfirmation) – UsageService không được bỏ sót trường này', async () => {
    const u = usageSetup(10_000);
    const r = await u.quota.reserveChars(ctx, 120);
    assert.equal(r.reserved, 120);
    assert.equal(r.ticket?.limit, 10_000);
  });

  it('hết hạn mức: không gọi Translate, trả trang quota, ký tự không đổi nhưng lượt truy cập vẫn được đếm', async () => {
    const u = usageSetup(5);
    const { handler, translateClient, logger } = proxySetup(u);
    const res = await handler(ev('/homestay-abc/en/'));
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['x-translateme-partial'], 'quota');
    assert.equal(translateClient.calls.length, 0);
    assert.equal(logger.infos[0].usageError, undefined);
    const total = u.total();
    assert.equal(total.machineChars, 0);
    assert.equal(total.requests, 1);
    assert.equal(Number(total.tmMisses) > 0, true);
    const [r] = u.reservations();
    assert.equal(r.reservedChars, 0, 'chỉ có phiếu 0 ký tự để quyết toán lượt truy cập');
  });

  it('bộ dịch lỗi: hoàn lại phiếu (REFUNDED), dòng tổng về 0, Visitor nhận 302', async () => {
    const u = usageSetup();
    const { handler } = proxySetup(u, { translate: async () => Promise.reject(new Error('boom')) });
    const res = await handler(ev('/homestay-abc/en/'));
    assert.equal(res.statusCode, 302);
    assert.equal(u.total().machineChars, 0);
    assert.equal(u.reservations()[0].status, 'REFUNDED');
  });

  it('tenant thiếu CONFIG: lỗi cấu hình không bị coi là hết hạn mức -> 302 về trang gốc, không dịch', async () => {
    const u = usageSetup(null);
    await assert.rejects(u.quota.reserveChars(ctx, 10), (e: unknown) => e instanceof UsageConfigError && !isCharQuotaExceeded(e));
    const { handler, translateClient } = proxySetup(u);
    const res = await handler(ev('/homestay-abc/en/'));
    assert.equal(res.statusCode, 302);
    assert.equal(translateClient.calls.length, 0);
  });

  it('dịch trước (countRequests = false, mọi trang chung requestId prewarm-<jobId>): mỗi trang một phiếu, requests = pagesServed = 0', async () => {
    const u = usageSetup();
    const { handler } = proxySetup(u, { countRequests: false, invokeWorker: undefined });
    const a = await handler(ev('/homestay-abc/en/', 'prewarm-job-20261114-0123456789ab'));
    const b = await handler(ev('/homestay-abc/ko/', 'prewarm-job-20261114-0123456789ab'));
    assert.equal(a.statusCode, 200);
    assert.equal(b.statusCode, 200);
    const total = u.total();
    assert.ok(Number(total.machineChars) > 0);
    assert.equal(total.requests, 0);
    assert.equal(total.pagesServed, 0);
    const ids = u.reservations().map((r) => r.requestId);
    assert.equal(new Set(ids).size, 2);
    assert.ok(ids.every((id) => String(id).startsWith('prewarm-job-20261114-0123456789ab:')));
  });
});

describe('usageServiceQuota – worker C13 (QC-7)', () => {
  it('proxy hết giờ -> worker dịch nốt với requestId của proxy: phiếu riêng, cộng ký tự, không cộng lượt truy cập', async () => {
    const u = usageSetup();
    const tmDb = memoryTmDb();
    // Proxy: dịch xong một phần rồi hết ngân sách -> gửi phần còn lại cho worker
    const translate = createTranslator(fakeTranslate());
    const proxy = proxySetup(u, {
      tmDb,
      translate: async (req) => {
        const half = await translate({ ...req, sentences: req.sentences.slice(0, 1) });
        return { ...half, pending: req.sentences.slice(1).map((s) => s.id) };
      },
    });
    const res = await proxy.handler(ev('/homestay-abc/en/', 'req-partial'));
    assert.equal(res.headers['x-translateme-partial'], '1');
    assert.equal(proxy.events.length, 1);
    const afterProxy = u.total();

    const worker = createWorkerHandler({
      resolveSite: staticSiteResolver([SITE]),
      tm: createTM({ db: tmDb, writer: 'worker' }),
      translate: createTranslator(fakeTranslate()),
      quota: u.quota,
      getGlossaryState: async () => GLOSSARY,
      logger: fakeLogger(),
    });
    const r = await worker(proxy.events[0]);
    assert.equal(r.status, 'DONE');
    assert.ok(r.translated > 0);

    const total = u.total();
    const workerChars = proxy.events[0].sentences!.reduce((n, s) => n + countCharsStub(s.text), 0);
    assert.equal(Number(total.machineChars), Number(afterProxy.machineChars) + workerChars);
    assert.equal(total.requests, 1, 'chỉ lượt của proxy');
    assert.equal(total.pagesServed, 1);
    assert.equal(total.tmMisses, afterProxy.tmMisses, 'câu trượt đã được proxy đếm');
    const reservations = u.reservations();
    assert.equal(reservations.length, 2);
    assert.ok(reservations.every((x) => x.status === 'SETTLED' && String(x.requestId).startsWith('req-partial:')));
  });
});

describe('usageServiceQuota – kiểm tra đầu vào', () => {
  it('releaseChars với phiếu rỗng không gọi UsageService', async () => {
    const u = usageSetup();
    await u.quota.releaseChars(ctx, emptyReservation());
    assert.deepEqual(u.ddb.calls, []);
  });

  it('không có phiếu mà có ký tự dịch máy, hoặc nguồn khác nguồn đặt trước -> TypeError, không ghi gì', async () => {
    const u = usageSetup();
    await assert.rejects(
      u.quota.settleUsage(ctx, emptyReservation(), { kind: 'WEB', slug: SITE.slug }, { machineChars: 3, memoryChars: 0, sentTotal: 1, sentFromTM: 0, requests: 1 }),
      TypeError,
    );
    const r = await u.quota.reserveChars(ctx, 4);
    await assert.rejects(
      u.quota.settleUsage(ctx, r, { kind: 'WEB', slug: 'khac' }, { machineChars: 4, memoryChars: 0, sentTotal: 1, sentFromTM: 0, requests: 1 }),
      TypeError,
    );
    assert.equal(u.reservations()[0].status, 'RESERVED');
  });

  it('ctx thiếu slug -> TypeError (proxy chỉ tính nguồn WEB)', async () => {
    const u = usageSetup();
    await assert.rejects(u.quota.reserveChars({ ...ctx, slug: undefined }, 1), TypeError);
  });

  it('requestId gốc rỗng hoặc quá dài vẫn cho khoá hợp lệ', async () => {
    const u = usageSetup();
    await u.quota.reserveChars({ ...ctx, requestId: '' }, 1);
    await u.quota.reserveChars({ ...ctx, requestId: 'x'.repeat(500) }, 1);
    const ids = u.reservations().map((r) => String(r.requestId)).sort();
    assert.deepEqual(ids, ['web:id1', `${'x'.repeat(100)}:id2`]);
  });
});
