import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertTenantKey, createTM, tmKey, type GlossaryState, type TmDb, type TmKey } from '../../../libs/common/tm.js';
import type { Ctx } from '../../../libs/common/types.js';
import { createProxyHandler, type FunctionUrlEvent } from '../handler.js';
import { staticSiteResolver } from '../sites.js';
import { hashSentenceStub } from '../stubs.js';
import { SAMPLE_PAGE, SITE, fakeFetch, fakeLogger, fakeTranslate, okHtml, upperCaseOutsideTags } from './helpers.js';

const ev = (rawPath: string): FunctionUrlEvent => ({ rawPath, requestContext: { requestId: 'req-tm', http: { method: 'GET' } } });
const ctx: Ctx = { tenantId: SITE.tenantId, via: 'SLUG', requestId: 'x', slug: SITE.slug };

/** DynamoDB giả cho TM: điều kiện "không đè HUMAN" đánh giá nguyên tử như DynamoDB. */
function memoryTmDb() {
  const store = new Map<string, Record<string, unknown>>();
  const id = (k: TmKey) => `${k.PK}|${k.SK}`;
  const db: TmDb & { store: typeof store } = {
    store,
    async batchGet(c, keys) {
      keys.forEach((k) => assertTenantKey(c, k));
      return keys.map((k) => store.get(id(k))).filter((x): x is Record<string, unknown> => !!x);
    },
    async update(c, key, expr) {
      assertTenantKey(c, key);
      const v = expr.ExpressionAttributeValues ?? {};
      const cur = store.get(id(key));
      if (v[':human'] !== undefined) {
        // markHumanNeedsReview
        if (!cur || cur.label !== 'HUMAN' || cur.tgt !== v[':tgt'] || cur.needsReview === true) {
          throw Object.assign(new Error('x'), { name: 'ConditionalCheckFailedException' });
        }
        store.set(id(key), { ...cur, needsReview: true, GSI3PK: v[':g3pk'] });
        return {};
      }
      if (cur && cur.label !== 'MACHINE') throw Object.assign(new Error('x'), { name: 'ConditionalCheckFailedException' });
      store.set(id(key), { ...key, src: v[':src'], tgt: v[':tgt'], label: 'MACHINE', glossaryVersion: v[':gv'], needsReview: v[':nr'], GSI3PK: v[':g3pk'] });
      return {};
    },
  };
  return db;
}

function setup(
  o: { db?: ReturnType<typeof memoryTmDb>; glossary?: GlossaryState; translate?: ReturnType<typeof fakeTranslate>; getGlossaryState?: () => Promise<GlossaryState> } = {},
) {
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
    getGlossaryState: o.getGlossaryState ?? (async () => o.glossary ?? { version: 3, terminologyName: null, terms: [] }),
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

  it('bản HUMAN lỗi thời theo thuật ngữ vẫn được dùng và được ghi cờ Cần xem lại (một lần)', async () => {
    const db = memoryTmDb();
    const hash = hashSentenceStub('Chào mừng');
    const key = tmKey(ctx, 'vi', 'en', hash);
    db.store.set(`${key.PK}|${key.SK}`, { ...key, src: 'Chào mừng', tgt: 'Warm welcome', label: 'HUMAN', glossaryVersion: 1, GSI3PK: `TENANT#${SITE.tenantId}#TM#HUMAN` });
    const glossary: GlossaryState = { version: 2, terminologyName: `tenant-${SITE.tenantId}`, terms: [{ normalized: 'chào mừng', type: 'FIXED', sinceVersion: 2 }] };
    const { handler, logger } = setup({ db, glossary });
    const res = await handler(ev('/homestay-abc/en/'));
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes('<h1>Warm welcome</h1>'), 'vẫn dùng bản HUMAN');
    const item = db.store.get(`${key.PK}|${key.SK}`)!;
    assert.equal(item.needsReview, true);
    assert.equal(item.GSI3PK, `TENANT#${SITE.tenantId}#TM#REVIEW`);
    assert.equal(item.label, 'HUMAN');
    assert.equal(logger.infos[0].tmReviewFlagged, 1);
    assert.equal(logger.infos[0].tmHumanNeedsReview, 1);

    await handler(ev('/homestay-abc/en/'));
    assert.equal(logger.infos[1].tmReviewFlagged, undefined, 'đã có cờ thì lần sau không ghi lại');
    assert.equal(logger.infos[1].tmHumanNeedsReview, 1);
  });

  it('ghi cờ Cần xem lại lỗi -> trang vẫn 200, chỉ ghi log', async () => {
    const db = memoryTmDb();
    const hash = hashSentenceStub('Chào mừng');
    const key = tmKey(ctx, 'vi', 'en', hash);
    db.store.set(`${key.PK}|${key.SK}`, { ...key, src: 'Chào mừng', tgt: 'Warm welcome', label: 'HUMAN', glossaryVersion: 1 });
    const update = db.update.bind(db);
    db.update = async (c, k, expr) => {
      if (expr.ExpressionAttributeValues?.[':human'] !== undefined) throw Object.assign(new Error('x'), { name: 'ThrottlingException' });
      return update(c, k, expr);
    };
    const glossary: GlossaryState = { version: 2, terminologyName: null, terms: [{ normalized: 'chào mừng', type: 'FIXED', sinceVersion: 2 }] };
    const { handler, logger } = setup({ db, glossary });
    const res = await handler(ev('/homestay-abc/en/'));
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes('<h1>Warm welcome</h1>'));
    assert.equal(logger.infos[0].tmReviewFlagFailed, 1);
  });

  it('đọc thuật ngữ lỗi -> không hỏng trang: bỏ qua TM, dịch không kèm terminology, cache ngắn', async () => {
    const { handler, db, translateClient, logger } = setup({
      getGlossaryState: async () => {
        throw Object.assign(new Error('down'), { name: 'ProvisionedThroughputExceededException' });
      },
    });
    const res = await handler(ev('/homestay-abc/en/'));
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes('<h1>CHÀO MỪNG</h1>'));
    assert.ok(translateClient.calls.length > 0);
    assert.ok(translateClient.calls.every((c) => c.TerminologyNames === undefined));
    assert.equal(res.headers['cache-control'], 'public, max-age=0, s-maxage=60');
    assert.equal(res.headers['x-translateme-partial'], undefined);
    assert.equal(logger.infos[0].outcome, 'OK');
    assert.equal(logger.infos[0].glossaryError, 'ProvisionedThroughputExceededException');
    assert.equal(db.store.size, 0, 'không ghi TM khi không biết thuật ngữ');
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
