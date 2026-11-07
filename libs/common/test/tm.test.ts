import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { BatchGetCommand, GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { clearGlossaryCache, createDynamoGlossaryReader } from '../glossary.js';
import {
  EMPTY_GLOSSARY_STATE,
  TM_BATCH_SIZE,
  assertTenantKey,
  createDynamoTmDb,
  createTM,
  isStaleDefault,
  tmKey,
  type GlossaryState,
  type SentenceWithHash,
  type TmDb,
  type TmKey,
  type UpdateExpr,
} from '../tm.js';
import type { Ctx } from '../types.js';

const ctxA: Ctx = { tenantId: 't_aaaaaaaaaaaaaaaaaaaaaaaa', via: 'SLUG', requestId: 'r1', slug: 'homestay-abc' };
const ctxB: Ctx = { tenantId: 't_bbbbbbbbbbbbbbbbbbbbbbbb', via: 'SLUG', requestId: 'r2', slug: 'shop-b' };
const h = (s: string) => createHash('sha256').update(s).digest('hex');
const sent = (id: number, text: string): SentenceWithHash => ({ id, text, hash: h(text) });

/**
 * DynamoDB giả trong bộ nhớ: BatchGet tối đa 100 khoá, UpdateItem đánh giá đúng điều kiện
 * "attribute_not_exists(label) OR label = :machine" một cách nguyên tử (như DynamoDB).
 */
function memoryDb() {
  const store = new Map<string, Record<string, unknown>>();
  const id = (k: TmKey) => `${k.PK}|${k.SK}`;
  const calls = { batchGet: [] as number[], update: 0 };
  const db: TmDb & { store: typeof store; calls: typeof calls; human(ctx: Ctx, key: TmKey, tgt: string): void } = {
    store,
    calls,
    async batchGet(ctx, keys) {
      calls.batchGet.push(keys.length);
      if (keys.length > TM_BATCH_SIZE) throw new Error('ValidationException: quá 100 khoá');
      keys.forEach((k) => assertTenantKey(ctx, k));
      await new Promise((r) => setImmediate(r));
      return keys.map((k) => store.get(id(k))).filter((x): x is Record<string, unknown> => x !== undefined);
    },
    async update(ctx, key, expr: UpdateExpr) {
      calls.update++;
      assertTenantKey(ctx, key);
      await new Promise((r) => setImmediate(r));
      const cur = store.get(id(key));
      const v = expr.ExpressionAttributeValues ?? {};
      if (v[':human'] !== undefined) {
        // markHumanNeedsReview: #label = :human AND #tgt = :tgt AND (attribute_not_exists(#nr) OR #nr <> :true)
        if (!cur || cur.label !== 'HUMAN' || cur.tgt !== v[':tgt'] || cur.needsReview === true) {
          throw Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });
        }
        store.set(id(key), { ...cur, needsReview: true, GSI3PK: v[':g3pk'], GSI3SK: cur.GSI3SK ?? v[':at'] });
        return {};
      }
      if (cur && cur.label !== undefined && cur.label !== v[':machine']) {
        throw Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });
      }
      store.set(id(key), {
        ...key,
        ...cur,
        src: v[':src'],
        tgt: v[':tgt'],
        label: v[':machine'],
        machineTgt: v[':tgt'],
        glossaryVersion: v[':gv'],
        needsReview: v[':nr'],
        updatedAt: v[':at'],
        updatedBy: v[':by'],
        GSI3PK: v[':g3pk'],
        GSI3SK: v[':at'],
        version: Number(cur?.version ?? 0) + 1,
      });
      return {};
    },
    /** Reviewer lưu bản HUMAN (F5) */
    human(ctx, key, tgt) {
      const cur = store.get(id(key));
      store.set(id(key), { ...key, ...cur, tgt, label: 'HUMAN', version: Number(cur?.version ?? 0) + 1 });
    },
  };
  return db;
}

const glossary = (version: number, terms: GlossaryState['terms']): GlossaryState => ({ version, terminologyName: 'tenant-x', terms });

describe('tmKey / assertTenantKey', () => {
  it('khoá theo B.3', () => {
    assert.deepEqual(tmKey(ctxA, 'vi', 'en', 'ab'), { PK: `TENANT#${ctxA.tenantId}#TM#vi#en`, SK: 'HASH#ab' });
  });

  it('chỉ cho khoá của chính tenant (theo tiền tố, không nhầm t_1 với t_10)', () => {
    assert.doesNotThrow(() => assertTenantKey(ctxA, tmKey(ctxA, 'vi', 'en', 'x')));
    assert.doesNotThrow(() => assertTenantKey(ctxA, { PK: `TENANT#${ctxA.tenantId}`, SK: 'CONFIG' }));
    assert.throws(() => assertTenantKey(ctxA, tmKey(ctxB, 'vi', 'en', 'x')), /không thuộc tenant/);
    assert.throws(() => assertTenantKey({ ...ctxA, tenantId: 't_1' }, { PK: 'TENANT#t_10#TM#vi#en', SK: 'HASH#x' }));
    assert.throws(() => assertTenantKey({ ...ctxA, tenantId: 'PLATFORM' }, { PK: 'TENANT#PLATFORM#SLUG#a', SK: 'META' }));
    assert.throws(() => assertTenantKey({ ...ctxA, tenantId: '' }, { PK: 'TENANT#', SK: 'x' }));
  });
});

describe('isStaleDefault', () => {
  const g = glossary(5, [
    { normalized: 'phố cổ hội an', type: 'FIXED', sinceVersion: 4 },
    { normalized: 'homestay abc', type: 'KEEP', sinceVersion: 2 },
  ]);
  it('lỗi thời khi câu chứa thuật ngữ đổi sau phiên bản của bản dịch', () => {
    assert.equal(isStaleDefault('Gần {1}Phố Cổ Hội An{/1}.', 3, g), true);
    assert.equal(isStaleDefault('Gần {1}Phố Cổ Hội An{/1}.', 4, g), false);
    assert.equal(isStaleDefault('Homestay ABC rất đẹp', 1, g), true);
    assert.equal(isStaleDefault('Không có thuật ngữ', 0, g), false);
  });
  it('khớp được chữ Việt viết dạng NFD', () => {
    assert.equal(isStaleDefault('Gần phố cổ Hội An'.normalize('NFD'), 3, g), true);
  });
  it('không có thuật ngữ -> không lỗi thời', () => {
    assert.equal(isStaleDefault('bất kỳ', 0, EMPTY_GLOSSARY_STATE), false);
  });
  it('kiểm tra đúng ranh giới từ Latin (không báo nhầm từ con như "an" trong "ban công") và hỗ trợ CJK (3.9)', () => {
    const gShort = glossary(3, [
      { normalized: 'an', type: 'FIXED', sinceVersion: 2 },
      { normalized: '東京', type: 'KEEP', sinceVersion: 3 },
    ]);
    assert.equal(isStaleDefault('Phòng có ban công thanh toán nhanh', 1, gShort), false);
    assert.equal(isStaleDefault('Chúc quý khách bình an', 1, gShort), true);
    assert.equal(isStaleDefault('Chuyến bay đi 東京タワー', 2, gShort), true);
  });
});

describe('getTM', () => {
  it('trúng HUMAN và MACHINE; không có thì trượt; câu trùng hash chỉ tra một lần', async () => {
    const db = memoryDb();
    const tm = createTM({ db, now: () => '2026-10-26T00:00:00.000Z' });
    const a = sent(0, 'Xin chào');
    const b = sent(1, 'Xem {1}bảng giá{/1}');
    const c = sent(2, 'Câu mới');
    await tm.putMachineTM(ctxA, 'vi', 'en', [
      { hash: a.hash, sourceText: a.text, tgt: 'Hello', glossaryVersion: 1 },
      { hash: b.hash, sourceText: b.text, tgt: 'See {1}prices{/1}', glossaryVersion: 1, needsReview: true },
    ]);
    db.human(ctxA, tmKey(ctxA, 'vi', 'en', a.hash), 'Hi there');

    const r = await tm.getTM(ctxA, 'vi', 'en', [a, b, c, { ...a, id: 3 }], EMPTY_GLOSSARY_STATE);
    assert.deepEqual(r.hits.get(a.hash), { tgt: 'Hi there', label: 'HUMAN', glossaryVersion: 1, needsReview: false });
    assert.deepEqual(r.hits.get(b.hash), { tgt: 'See {1}prices{/1}', label: 'MACHINE', glossaryVersion: 1, needsReview: true });
    assert.deepEqual(r.misses, [c]);
    assert.deepEqual(db.calls.batchGet, [3]);
  });

  it('cặp ngôn ngữ khác và tenant khác không lẫn vào nhau', async () => {
    const db = memoryDb();
    const tm = createTM({ db });
    const a = sent(0, 'Xin chào');
    await tm.putMachineTM(ctxA, 'vi', 'en', [{ hash: a.hash, sourceText: a.text, tgt: 'Hello', glossaryVersion: 1 }]);
    assert.equal((await tm.getTM(ctxA, 'vi', 'ko', [a], EMPTY_GLOSSARY_STATE)).misses.length, 1);
    assert.equal((await tm.getTM(ctxB, 'vi', 'en', [a], EMPTY_GLOSSARY_STATE)).misses.length, 1);
  });

  it('MACHINE lỗi thời theo thuật ngữ bị coi là trượt; HUMAN vẫn dùng nhưng gắn Cần xem lại', async () => {
    const db = memoryDb();
    const tm = createTM({ db });
    const m = sent(0, 'Gần phố cổ Hội An');
    const hu = sent(1, 'Ở phố cổ Hội An có cao lầu');
    await tm.putMachineTM(ctxA, 'vi', 'en', [
      { hash: m.hash, sourceText: m.text, tgt: 'Near the old town', glossaryVersion: 3 },
      { hash: hu.hash, sourceText: hu.text, tgt: 'x', glossaryVersion: 3 },
    ]);
    db.human(ctxA, tmKey(ctxA, 'vi', 'en', hu.hash), 'Hoi An Ancient Town has cao lau');
    const g = glossary(4, [{ normalized: 'phố cổ hội an', type: 'FIXED', sinceVersion: 4 }]);
    const r = await tm.getTM(ctxA, 'vi', 'en', [m, hu], g);
    assert.deepEqual(r.misses, [m]);
    assert.equal(r.hits.get(hu.hash)?.needsReview, true);
    assert.equal(r.hits.get(hu.hash)?.label, 'HUMAN');
    assert.deepEqual(r.reviewFlags, [hu.hash], 'HUMAN lỗi thời chưa có cờ -> nơi gọi phải ghi cờ');
  });

  it('HUMAN không lỗi thời hoặc đã có cờ thì không nằm trong reviewFlags', async () => {
    const db = memoryDb();
    const tm = createTM({ db });
    const ok = sent(0, 'Phòng có ban công');
    const flagged = sent(1, 'Gần phố cổ Hội An');
    for (const s of [ok, flagged]) {
      await tm.putMachineTM(ctxA, 'vi', 'en', [{ hash: s.hash, sourceText: s.text, tgt: 'x', glossaryVersion: 3 }]);
      db.human(ctxA, tmKey(ctxA, 'vi', 'en', s.hash), `human ${s.id}`);
    }
    const k = tmKey(ctxA, 'vi', 'en', flagged.hash);
    db.store.set(`${k.PK}|${k.SK}`, { ...db.store.get(`${k.PK}|${k.SK}`), needsReview: true });
    const g = glossary(4, [{ normalized: 'phố cổ hội an', type: 'FIXED', sinceVersion: 4 }]);
    const r = await tm.getTM(ctxA, 'vi', 'en', [ok, flagged], g);
    assert.equal(r.hits.size, 2);
    assert.equal(r.hits.get(flagged.hash)?.needsReview, true);
    assert.deepEqual(r.reviewFlags, []);
  });

  it('quá 100 hash -> chia lô 100 (250 câu = 100 + 100 + 50)', async () => {
    const db = memoryDb();
    const tm = createTM({ db });
    const items = Array.from({ length: 250 }, (_, i) => sent(i, `Câu ${i}`));
    const r = await tm.getTM(ctxA, 'vi', 'en', items, EMPTY_GLOSSARY_STATE);
    assert.deepEqual(db.calls.batchGet, [100, 100, 50]);
    assert.equal(r.misses.length, 250);
  });

  it('isStale tuỳ biến (bản của TV4) được dùng thay bản mặc định', async () => {
    const db = memoryDb();
    const tm = createTM({ db, isStale: () => true });
    const a = sent(0, 'Xin chào');
    await tm.putMachineTM(ctxA, 'vi', 'en', [{ hash: a.hash, sourceText: a.text, tgt: 'Hello', glossaryVersion: 1 }]);
    assert.equal((await tm.getTM(ctxA, 'vi', 'en', [a], EMPTY_GLOSSARY_STATE)).misses.length, 1);
  });
});

describe('putMachineTM', () => {
  it('ghi đủ trường của Bảng 2.5, tăng version, bỏ câu trùng và bản dịch rỗng', async () => {
    const db = memoryDb();
    const tm = createTM({ db, now: () => '2026-10-26T01:02:03.000Z', writer: 'proxy' });
    const a = sent(0, 'Xin chào');
    const r1 = await tm.putMachineTM(ctxA, 'vi', 'en', [
      { hash: a.hash, sourceText: a.text, tgt: 'Hello', glossaryVersion: 2 },
      { hash: a.hash, sourceText: a.text, tgt: 'Hello', glossaryVersion: 2 },
      { hash: h('x'), sourceText: 'x', tgt: '  ', glossaryVersion: 2 },
    ]);
    assert.deepEqual(r1, { written: 1, skippedHuman: 0, failed: [] });
    await tm.putMachineTM(ctxA, 'vi', 'en', [{ hash: a.hash, sourceText: a.text, tgt: 'Hi', glossaryVersion: 3 }]);
    const item = db.store.get(`TENANT#${ctxA.tenantId}#TM#vi#en|HASH#${a.hash}`);
    assert.deepEqual(item, {
      PK: `TENANT#${ctxA.tenantId}#TM#vi#en`,
      SK: `HASH#${a.hash}`,
      src: 'Xin chào',
      tgt: 'Hi',
      label: 'MACHINE',
      machineTgt: 'Hi',
      glossaryVersion: 3,
      needsReview: false,
      updatedAt: '2026-10-26T01:02:03.000Z',
      updatedBy: 'proxy',
      GSI3PK: `TENANT#${ctxA.tenantId}#TM#MACHINE`,
      GSI3SK: '2026-10-26T01:02:03.000Z',
      version: 2,
    });
  });

  it('câu cần xem lại vào nhóm REVIEW của GSI3', async () => {
    const db = memoryDb();
    const tm = createTM({ db });
    const a = sent(0, 'Xem {1}đây{/1}');
    await tm.putMachineTM(ctxA, 'vi', 'en', [{ hash: a.hash, sourceText: a.text, tgt: 'See here', glossaryVersion: 1, needsReview: true }]);
    assert.equal(db.store.get(`TENANT#${ctxA.tenantId}#TM#vi#en|HASH#${a.hash}`)?.GSI3PK, `TENANT#${ctxA.tenantId}#TM#REVIEW`);
  });

  it('HUMAN không bao giờ bị MACHINE ghi đè, kể cả khi ghi đồng thời', async () => {
    for (let round = 0; round < 50; round++) {
      const db = memoryDb();
      const tm = createTM({ db });
      const a = sent(0, 'Phòng có ban công');
      const key = tmKey(ctxA, 'vi', 'en', a.hash);
      const machine = tm.putMachineTM(ctxA, 'vi', 'en', [{ hash: a.hash, sourceText: a.text, tgt: 'MACHINE', glossaryVersion: 1 }]);
      const reviewer = new Promise<void>((resolve) => {
        const fire = () => {
          db.human(ctxA, key, 'HUMAN');
          resolve();
        };
        if (round % 2) setImmediate(fire);
        else fire();
      });
      const [report] = await Promise.all([machine, reviewer]);
      const again = await tm.putMachineTM(ctxA, 'vi', 'en', [{ hash: a.hash, sourceText: a.text, tgt: 'MACHINE 2', glossaryVersion: 1 }]);
      assert.equal(db.store.get(`${key.PK}|${key.SK}`)?.tgt, 'HUMAN', `vòng ${round}`);
      assert.equal(again.skippedHuman, 1);
      assert.equal(report.failed.length, 0);
    }
  });

  it('lỗi khác (throttling) không throw, ghi vào failed', async () => {
    const db = memoryDb();
    db.update = async () => {
      throw Object.assign(new Error('slow down'), { name: 'ProvisionedThroughputExceededException' });
    };
    const tm = createTM({ db });
    const r = await tm.putMachineTM(ctxA, 'vi', 'en', [{ hash: 'aa', sourceText: 'x', tgt: 'y', glossaryVersion: 1 }]);
    assert.deepEqual(r, { written: 0, skippedHuman: 0, failed: [{ hash: 'aa', error: 'ProvisionedThroughputExceededException' }] });
  });

  it('tenant lấy từ ctx: ghi bằng ctx của B chỉ vào khoá của B', async () => {
    const db = memoryDb();
    const tm = createTM({ db });
    const evil: Ctx = { ...ctxB };
    const r = await tm.putMachineTM(evil, 'vi', 'en', [{ hash: 'aa', sourceText: 'x', tgt: 'y', glossaryVersion: 1 }]);
    assert.equal(r.written, 1);
    assert.ok([...db.store.keys()].every((k) => k.startsWith(`TENANT#${ctxB.tenantId}#`)));
  });
});

describe('markHumanNeedsReview', () => {
  it('ghi cờ Cần xem lại cho HUMAN, chuyển sang nhóm REVIEW của GSI3, không tăng version, không đổi tgt', async () => {
    const db = memoryDb();
    const tm = createTM({ db, now: () => '2026-10-28T10:00:00.000Z' });
    const hu = sent(0, 'Gần phố cổ Hội An');
    const key = tmKey(ctxA, 'vi', 'en', hu.hash);
    await tm.putMachineTM(ctxA, 'vi', 'en', [{ hash: hu.hash, sourceText: hu.text, tgt: 'x', glossaryVersion: 3 }]);
    db.human(ctxA, key, 'Near Hoi An Ancient Town');
    const before = { ...db.store.get(`${key.PK}|${key.SK}`) };
    const rep = await tm.markHumanNeedsReview(ctxA, 'vi', 'en', [
      { hash: hu.hash, tgt: 'Near Hoi An Ancient Town' },
      { hash: hu.hash, tgt: 'Near Hoi An Ancient Town' },
    ]);
    assert.deepEqual(rep, { marked: 1, skipped: 0, failed: [] }, 'câu trùng chỉ ghi một lần');
    const after = db.store.get(`${key.PK}|${key.SK}`)!;
    assert.equal(after.needsReview, true);
    assert.equal(after.GSI3PK, `TENANT#${ctxA.tenantId}#TM#REVIEW`);
    assert.equal(after.label, 'HUMAN');
    assert.equal(after.tgt, 'Near Hoi An Ancient Town');
    assert.equal(after.version, before.version);
  });

  it('Reviewer vừa sửa câu (tgt khác lúc tra), đã có cờ hoặc không phải HUMAN -> bỏ qua, không ghi', async () => {
    const db = memoryDb();
    const tm = createTM({ db });
    const a = sent(0, 'Câu A');
    const b = sent(1, 'Câu B');
    const c = sent(2, 'Câu C');
    await tm.putMachineTM(ctxA, 'vi', 'en', [a, b, c].map((s) => ({ hash: s.hash, sourceText: s.text, tgt: 'm', glossaryVersion: 1 })));
    db.human(ctxA, tmKey(ctxA, 'vi', 'en', a.hash), 'new text');
    db.human(ctxA, tmKey(ctxA, 'vi', 'en', b.hash), 'B');
    await tm.markHumanNeedsReview(ctxA, 'vi', 'en', [{ hash: b.hash, tgt: 'B' }]);
    const rep = await tm.markHumanNeedsReview(ctxA, 'vi', 'en', [
      { hash: a.hash, tgt: 'old text' },
      { hash: b.hash, tgt: 'B' },
      { hash: c.hash, tgt: 'm' },
    ]);
    assert.deepEqual(rep, { marked: 0, skipped: 3, failed: [] });
  });

  it('gửi đúng điều kiện cho DynamoDB; lỗi khác không throw mà ghi vào failed', async () => {
    const exprs: UpdateExpr[] = [];
    const db: TmDb = {
      batchGet: async () => [],
      update: async (_c, _k, expr) => {
        exprs.push(expr);
        throw Object.assign(new Error('slow down'), { name: 'ThrottlingException' });
      },
    };
    const tm = createTM({ db });
    const a = sent(0, 'Câu A');
    const rep = await tm.markHumanNeedsReview(ctxA, 'vi', 'en', [{ hash: a.hash, tgt: 'A' }]);
    assert.deepEqual(rep, { marked: 0, skipped: 0, failed: [{ hash: a.hash, error: 'ThrottlingException' }] });
    assert.equal(exprs[0].ConditionExpression, '#label = :human AND #tgt = :tgt AND (attribute_not_exists(#nr) OR #nr <> :true)');
    assert.ok(!exprs[0].UpdateExpression.includes('#version'), 'không tăng version');
  });
});

describe('createDynamoTmDb', () => {
  it('BatchGetItem tự lặp UnprocessedKeys có chờ, trả đủ kết quả', async () => {
    const sent: unknown[] = [];
    const sleeps: number[] = [];
    const k = (i: number) => tmKey(ctxA, 'vi', 'en', `h${i}`);
    let call = 0;
    const doc = {
      async send(cmd: unknown) {
        sent.push(cmd);
        call++;
        const keys = (cmd as BatchGetCommand).input.RequestItems!.T.Keys as TmKey[];
        if (call === 1) return { Responses: { T: keys.slice(0, 2).map((x) => ({ ...x, tgt: 'a' })) }, UnprocessedKeys: { T: { Keys: keys.slice(2) } } };
        return { Responses: { T: keys.map((x) => ({ ...x, tgt: 'b' })) }, UnprocessedKeys: {} };
      },
    };
    const db = createDynamoTmDb(doc as never, 'T', { sleep: async (ms) => void sleeps.push(ms) });
    const items = await db.batchGet(ctxA, [k(1), k(2), k(3), k(4)]);
    assert.equal(items.length, 4);
    assert.equal(sent.length, 2);
    assert.ok(sent[0] instanceof BatchGetCommand);
    assert.deepEqual(((sent[1] as BatchGetCommand).input.RequestItems!.T.Keys as TmKey[]).map((x) => x.SK), ['HASH#h3', 'HASH#h4']);
    assert.equal(sleeps.length, 1);
  });

  it('UnprocessedKeys mãi không hết -> báo lỗi sau số lần thử tối đa', async () => {
    const k = tmKey(ctxA, 'vi', 'en', 'h');
    const doc = { send: async () => ({ Responses: { T: [] }, UnprocessedKeys: { T: { Keys: [k] } } }) };
    const db = createDynamoTmDb(doc as never, 'T', { maxAttempts: 3, sleep: async () => {} });
    await assert.rejects(db.batchGet(ctxA, [k]), { name: 'UnprocessedKeysExhausted' });
  });

  it('chặn khoá tenant khác và lô quá 100 trước khi gọi DynamoDB', async () => {
    let calls = 0;
    const db = createDynamoTmDb({ send: async () => void calls++ } as never, 'T');
    await assert.rejects(db.batchGet(ctxA, [tmKey(ctxB, 'vi', 'en', 'x')]), { name: 'TenantKeyViolation' });
    await assert.rejects(db.update(ctxA, tmKey(ctxB, 'vi', 'en', 'x'), { UpdateExpression: 'SET a = :a' }), { name: 'TenantKeyViolation' });
    await assert.rejects(db.batchGet(ctxA, Array.from({ length: 101 }, (_, i) => tmKey(ctxA, 'vi', 'en', `${i}`))), /tối đa 100/);
    assert.equal(calls, 0);
  });

  it('UpdateItem gửi đúng bảng, khoá và điều kiện', async () => {
    const sent: unknown[] = [];
    const db = createDynamoTmDb({ send: async (c: unknown) => void sent.push(c) } as never, 'translate-data');
    const tm = createTM({ db });
    await tm.putMachineTM(ctxA, 'vi', 'en', [{ hash: 'aa', sourceText: 'x', tgt: 'y', glossaryVersion: 1 }]);
    const cmd = sent[0] as UpdateCommand;
    assert.ok(cmd instanceof UpdateCommand);
    assert.equal(cmd.input.TableName, 'translate-data');
    assert.deepEqual(cmd.input.Key, tmKey(ctxA, 'vi', 'en', 'aa'));
    assert.equal(cmd.input.ConditionExpression, 'attribute_not_exists(#label) OR #label = :machine');
  });
});

describe('createDynamoGlossaryReader (3.9)', () => {
  it('đọc CONFIG và phân trang TERM# trên DynamoDBDocumentClient, lưu đệm 60 giây', async () => {
    clearGlossaryCache(ctxA.tenantId);
    let queryCalls = 0;
    let clock = 1_000_000;
    const doc = {
      async send(cmd: unknown) {
        if (cmd instanceof GetCommand) {
          return { Item: { PK: `TENANT#${ctxA.tenantId}`, SK: 'CONFIG', glossaryVersion: 4, terminologyName: `tm-${ctxA.tenantId}` } };
        }
        if (cmd instanceof QueryCommand) {
          queryCalls++;
          if (queryCalls === 1) {
            return {
              Items: [
                {
                  PK: `TENANT#${ctxA.tenantId}#GLOSS`,
                  SK: 'TERM#homestay abc',
                  normalized: 'homestay abc',
                  sourceTerm: 'Homestay ABC',
                  type: 'KEEP',
                  sinceVersion: 2,
                },
              ],
              LastEvaluatedKey: { PK: `TENANT#${ctxA.tenantId}#GLOSS`, SK: 'TERM#homestay abc' },
            };
          }
          return {
            Items: [
              {
                PK: `TENANT#${ctxA.tenantId}#GLOSS`,
                SK: 'TERM#phố cổ hội an',
                normalized: 'phố cổ hội an',
                sourceTerm: 'phố cổ Hội An',
                type: 'FIXED',
                translations: { en: 'Hoi An Ancient Town' },
                sinceVersion: 4,
              },
            ],
          };
        }
        throw new Error('Unexpected command');
      },
    };
    const readGlossary = createDynamoGlossaryReader(doc as never, 'translate-data', { now: () => clock });
    const g1 = await readGlossary(ctxA);
    assert.equal(g1.version, 4);
    assert.equal(g1.terminologyName, `tm-${ctxA.tenantId}`);
    assert.equal(g1.terms.length, 2);
    assert.equal(queryCalls, 2);

    // Trong 60s tiếp theo không cần gọi QueryCommand lại
    clock += 30_000;
    const g2 = await readGlossary(ctxA);
    assert.equal(g2.terms.length, 2);
    assert.equal(queryCalls, 2);
  });
});
