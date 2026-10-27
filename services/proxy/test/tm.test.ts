import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTM, tmKey, type GlossaryState } from '../../../libs/common/tm.js';
import type { Ctx } from '../../../libs/common/types.js';
import { createProxyHandler, type FunctionUrlEvent } from '../handler.js';
import { staticSiteResolver } from '../sites.js';
import { hashSentenceStub } from '../stubs.js';
import { SAMPLE_PAGE, SITE, fakeFetch, fakeLogger, fakeTranslate, memoryTmDb, okHtml, upperCaseOutsideTags } from './helpers.js';

const ev = (rawPath: string): FunctionUrlEvent => ({ rawPath, requestContext: { requestId: 'req-tm', http: { method: 'GET' } } });
const ctx: Ctx = { tenantId: SITE.tenantId, via: 'SLUG', requestId: 'x', slug: SITE.slug };

function setup(o: { db?: ReturnType<typeof memoryTmDb>; glossary?: GlossaryState; translate?: ReturnType<typeof fakeTranslate> } = {}) {
  const db = o.db ?? memoryTmDb();
  const translateClient = o.translate ?? fakeTranslate();
  const logger = fakeLogger();
  const handler = createProxyHandler({
    resolveSite: staticSiteResolver([SITE]),
    fetchPage: fakeFetch((u) => okHtml(SAMPLE_PAGE, u)),
    translateClient,
    publicBaseUrl: 'https://d1abc.cloudfront.net',
    logger,
    tm: createTM({ db, writer: 'proxy' }),
    getGlossaryState: async () => o.glossary ?? { version: 3, terminologyName: null, terms: [] },
  });
  return { handler, db, translateClient, logger };
}

describe('proxy + Translation Memory (2.4)', () => {
  it('lần 1 trượt TM, dịch và ghi MACHINE; lần 2 cùng trang trúng TM hoàn toàn, không gọi Translate', async () => {
    const { handler, db, translateClient, logger } = setup();
    const first = await handler(ev('/homestay-abc/en/'));
    assert.equal(first.statusCode, 200);
    const callsAfterFirst = translateClient.calls.length;
    assert.ok(callsAfterFirst > 0);
    const l1 = logger.infos[0];
    assert.equal(l1.tmHitSentences, 0);
    assert.equal(l1.tmWritten, l1.uniqueSentences);
    assert.ok(db.store.size > 0);
    for (const item of db.store.values()) {
      assert.equal(item.label, 'MACHINE');
      assert.equal(item.glossaryVersion, 3);
      assert.ok(String(item.PK).startsWith(`TENANT#${SITE.tenantId}#TM#vi#en`));
    }

    const second = await handler(ev('/homestay-abc/en/'));
    assert.equal(translateClient.calls.length, callsAfterFirst, 'lần hai không gọi Translate');
    assert.equal(second.body, first.body);
    assert.equal(second.headers['cache-control'], 'public, max-age=0, s-maxage=86400');
    assert.equal(logger.infos[1].tmMissSentences, 0);
    assert.equal(logger.infos[1].charsSent, 0);
  });

  it('bản HUMAN của Reviewer được dùng thay bản máy', async () => {
    const db = memoryTmDb();
    const hash = hashSentenceStub('Chào mừng');
    const key = tmKey(ctx, 'vi', 'en', hash);
    db.store.set(`${key.PK}|${key.SK}`, { ...key, src: 'Chào mừng', tgt: 'Warm welcome', label: 'HUMAN', glossaryVersion: 1 });
    const { handler } = setup({ db });
    const res = await handler(ev('/homestay-abc/en/'));
    assert.ok(res.body.includes('<h1>Warm welcome</h1>'));
    assert.equal(db.store.get(`${key.PK}|${key.SK}`)?.label, 'HUMAN', 'không bị ghi đè');
  });

  it('bản MACHINE lỗi thời theo thuật ngữ bị dịch lại; truyền tên terminology cho Translate', async () => {
    const db = memoryTmDb();
    const hash = hashSentenceStub('Chào mừng');
    const key = tmKey(ctx, 'vi', 'en', hash);
    db.store.set(`${key.PK}|${key.SK}`, { ...key, src: 'Chào mừng', tgt: 'Old welcome', label: 'MACHINE', glossaryVersion: 1 });
    const glossary: GlossaryState = { version: 2, terminologyName: `tenant-${SITE.tenantId}`, terms: [{ normalized: 'chào mừng', type: 'FIXED', sinceVersion: 2 }] };
    const { handler, translateClient } = setup({ db, glossary });
    const res = await handler(ev('/homestay-abc/en/'));
    assert.ok(res.body.includes('<h1>CHÀO MỪNG</h1>'));
    assert.deepEqual(translateClient.calls[0].TerminologyNames, [`tenant-${SITE.tenantId}`]);
    assert.equal(db.store.get(`${key.PK}|${key.SK}`)?.glossaryVersion, 2);
  });

  it('câu dịch lại không kèm thẻ được ghi kèm cờ Cần xem lại', async () => {
    const translate = fakeTranslate((text) => upperCaseOutsideTags(text).replace('</span>', ''));
    const { handler, db } = setup({ translate });
    await handler(ev('/homestay-abc/en/'));
    const review = [...db.store.values()].filter((i) => i.needsReview === true);
    assert.ok(review.length >= 1);
    assert.ok(review.every((i) => String(i.GSI3PK).endsWith('#TM#REVIEW')));
  });

  it('tra TM lỗi -> vẫn dịch máy và trả 200; ghi TM lỗi -> chỉ ghi log', async () => {
    const db = memoryTmDb();
    db.batchGet = async () => {
      throw Object.assign(new Error('down'), { name: 'ProvisionedThroughputExceededException' });
    };
    db.update = async () => {
      throw Object.assign(new Error('down'), { name: 'InternalServerError' });
    };
    const { handler, translateClient, logger } = setup({ db });
    const res = await handler(ev('/homestay-abc/en/'));
    assert.equal(res.statusCode, 200);
    assert.ok(translateClient.calls.length > 0);
    assert.equal(logger.infos[0].tmReadError, 'ProvisionedThroughputExceededException');
    assert.ok(Number(logger.infos[0].tmWriteFailed) > 0);
    assert.equal(res.headers['x-translateme-partial'], undefined);
  });
});
