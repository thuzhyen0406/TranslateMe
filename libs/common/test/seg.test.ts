import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { BatchWriteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  SEG_BATCH_SIZE,
  createDynamoSegDb,
  createSEG,
  pageGsiPk,
  segKey,
  segPath,
  type SegDb,
  type SegItem,
} from '../seg.js';
import type { Ctx } from '../types.js';

const ctxA: Ctx = { tenantId: 't_aaaaaaaaaaaaaaaaaaaaaaaa', via: 'SLUG', requestId: 'r1', slug: 'homestay-abc' };
const ctxB: Ctx = { tenantId: 't_bbbbbbbbbbbbbbbbbbbbbbbb', via: 'SLUG', requestId: 'r2', slug: 'shop-b' };
const h = (s: string) => createHash('sha256').update(s).digest('hex');

/** DynamoDB giả: bảng chính + GSI2 (KEYS_ONLY), kiểm tra tenant như lớp data. */
function memorySegDb() {
  const store = new Map<string, SegItem>();
  const calls = { batchWrite: [] as number[] };
  const tenantOf = (ctx: Ctx, pk: string) => {
    const base = `TENANT#${ctx.tenantId}`;
    if (pk !== base && !pk.startsWith(`${base}#`)) throw Object.assign(new Error('x'), { name: 'TenantKeyViolation' });
  };
  const db: SegDb & { store: typeof store; calls: typeof calls; failNext?: string } = {
    store,
    calls,
    async batchWrite(ctx, items) {
      calls.batchWrite.push(items.length);
      if (items.length > SEG_BATCH_SIZE) throw new Error('ValidationException: quá 25 yêu cầu');
      if (db.failNext) {
        const name = db.failNext;
        db.failNext = undefined;
        throw Object.assign(new Error('fail'), { name });
      }
      for (const it of items) {
        tenantOf(ctx, it.PK);
        tenantOf(ctx, it.GSI2PK);
        store.set(`${it.PK}|${it.SK}`, { ...it });
      }
    },
    async query(ctx, pk, skPrefix) {
      tenantOf(ctx, pk);
      return [...store.values()].filter((i) => i.PK === pk && i.SK.startsWith(skPrefix)).map((i) => ({ ...i }));
    },
    async queryGsi2(ctx, gsi2pk) {
      tenantOf(ctx, gsi2pk);
      return [...store.values()].filter((i) => i.GSI2PK === gsi2pk).map(({ PK, SK, GSI2PK, GSI2SK }) => ({ PK, SK, GSI2PK, GSI2SK }));
    },
  };
  return db;
}

describe('segPath / khóa SEG (QC-5)', () => {
  it('<path> luôn gồm slug, giữ nguyên mã hóa %', () => {
    assert.equal(segPath('homestay-abc', 'phong-nghi/'), '/homestay-abc/phong-nghi/');
    assert.equal(segPath('homestay-abc', ''), '/homestay-abc/');
    assert.equal(segPath('homestay-abc', '/phong-nghi'), '/homestay-abc/phong-nghi');
    assert.equal(segPath('homestay-abc', 'ph%C3%B2ng/'), '/homestay-abc/ph%C3%B2ng/');
  });

  it('từ chối slug sai, path có query hoặc #', () => {
    assert.throws(() => segPath('Bad/Slug', 'x'));
    assert.throws(() => segPath('homestay-abc', 'a?b=1'));
    assert.throws(() => segPath('homestay-abc', 'a#b'));
  });

  it('khóa bảng chính và GSI2 theo Bảng 2.5', () => {
    const k = segKey(ctxA, 'abc', 'en', '/homestay-abc/phong-nghi/');
    assert.deepEqual(k, { PK: `TENANT#${ctxA.tenantId}#SEG#abc`, SK: 'PAGE#en#/homestay-abc/phong-nghi/' });
    assert.equal(pageGsiPk(ctxA, 'en', '/homestay-abc/'), `TENANT#${ctxA.tenantId}#PAGE#en#/homestay-abc/`);
    assert.throws(() => segKey(ctxA, 'abc', 'en#x', '/homestay-abc/'));
    assert.throws(() => pageGsiPk(ctxA, 'en', 'homestay-abc/'), 'path phải bắt đầu bằng /');
  });

  it('hai website cùng tenant có cùng đường dẫn con không trùng khóa', () => {
    const a = segKey(ctxA, 'abc', 'en', segPath('site-a', 'gioi-thieu/'));
    const b = segKey(ctxA, 'abc', 'en', segPath('site-b', 'gioi-thieu/'));
    assert.notEqual(a.SK, b.SK);
  });
});

describe('writePageSegments', () => {
  it('ghi đủ trường, TTL 30 ngày, bỏ hash trùng', async () => {
    const db = memorySegDb();
    const seg = createSEG({ db, now: () => Date.UTC(2026, 9, 29) });
    const path = segPath('homestay-abc', 'phong-nghi/');
    const rep = await seg.writePageSegments(ctxA, 'en', path, [h('a'), h('b'), h('a')]);
    assert.deepEqual(rep, { written: 2, failed: 0, errors: [] });
    const item = db.store.get(`TENANT#${ctxA.tenantId}#SEG#${h('a')}|PAGE#en#${path}`)!;
    assert.deepEqual(item, {
      PK: `TENANT#${ctxA.tenantId}#SEG#${h('a')}`,
      SK: `PAGE#en#${path}`,
      GSI2PK: `TENANT#${ctxA.tenantId}#PAGE#en#${path}`,
      GSI2SK: `HASH#${h('a')}`,
      ttl: Date.UTC(2026, 9, 29) / 1000 + 30 * 86_400,
    });
  });

  it('nhiều câu -> chia lô 25 (60 câu = 25 + 25 + 10)', async () => {
    const db = memorySegDb();
    const seg = createSEG({ db, concurrency: 1 });
    const hashes = Array.from({ length: 60 }, (_, i) => h(`câu ${i}`));
    const rep = await seg.writePageSegments(ctxA, 'en', '/homestay-abc/', hashes);
    assert.deepEqual(db.calls.batchWrite, [25, 25, 10]);
    assert.equal(rep.written, 60);
    assert.equal(db.store.size, 60);
  });

  it('trang không có câu -> không gọi DynamoDB', async () => {
    const db = memorySegDb();
    const rep = await createSEG({ db }).writePageSegments(ctxA, 'en', '/homestay-abc/', []);
    assert.deepEqual(rep, { written: 0, failed: 0, errors: [] });
    assert.deepEqual(db.calls.batchWrite, []);
  });

  it('một lô lỗi không ném lỗi, báo số bản ghi lỗi', async () => {
    const db = memorySegDb();
    db.failNext = 'ProvisionedThroughputExceededException';
    const seg = createSEG({ db, concurrency: 1 });
    const hashes = Array.from({ length: 30 }, (_, i) => h(`x${i}`));
    const rep = await seg.writePageSegments(ctxA, 'en', '/homestay-abc/', hashes);
    assert.deepEqual(rep, { written: 5, failed: 25, errors: ['ProvisionedThroughputExceededException'] });
  });

  it('ghi lại cùng trang chỉ làm mới TTL, không tạo bản ghi trùng', async () => {
    const db = memorySegDb();
    let t = Date.UTC(2026, 9, 1);
    const seg = createSEG({ db, now: () => t });
    await seg.writePageSegments(ctxA, 'en', '/homestay-abc/', [h('a')]);
    t += 5 * 86_400_000;
    await seg.writePageSegments(ctxA, 'en', '/homestay-abc/', [h('a')]);
    assert.equal(db.store.size, 1);
    assert.equal([...db.store.values()][0].ttl, t / 1000 + 30 * 86_400);
  });
});

describe('sentencesOfPage / pagesOfSentence', () => {
  async function seeded() {
    const db = memorySegDb();
    const seg = createSEG({ db });
    const home = segPath('homestay-abc', '');
    const rooms = segPath('homestay-abc', 'phong-nghi/');
    const other = segPath('site-b', 'phong-nghi/');
    await seg.writePageSegments(ctxA, 'en', home, [h('chào'), h('liên hệ')]);
    await seg.writePageSegments(ctxA, 'en', rooms, [h('chào'), h('phòng đôi')]);
    await seg.writePageSegments(ctxA, 'ko', rooms, [h('chào')]);
    await seg.writePageSegments(ctxA, 'en', other, [h('chào')]);
    await seg.writePageSegments(ctxB, 'en', segPath('shop-b', ''), [h('chào')]);
    return { seg, home, rooms, other };
  }

  it('GSI2 trả đúng các câu của một trang', async () => {
    const { seg, home, rooms } = await seeded();
    assert.deepEqual((await seg.sentencesOfPage(ctxA, 'en', rooms)).sort(), [h('chào'), h('phòng đôi')].sort());
    assert.deepEqual((await seg.sentencesOfPage(ctxA, 'en', home)).sort(), [h('chào'), h('liên hệ')].sort());
    assert.deepEqual(await seg.sentencesOfPage(ctxA, 'ko', home), []);
  });

  it('một câu ra đúng các trang của ngôn ngữ đích, gồm cả website khác cùng tenant, không lẫn tenant khác', async () => {
    const { seg, home, rooms, other } = await seeded();
    assert.deepEqual((await seg.pagesOfSentence(ctxA, h('chào'), 'en')).sort(), [home, other, rooms].sort());
    assert.deepEqual(await seg.pagesOfSentence(ctxA, h('chào'), 'ko'), [rooms]);
    assert.deepEqual(await seg.pagesOfSentence(ctxA, h('phòng đôi'), 'ko'), []);
    assert.deepEqual(await seg.pagesOfSentence(ctxB, h('chào'), 'en'), ['/shop-b/']);
  });
});

describe('createDynamoSegDb', () => {
  const k = (i: number): SegItem => ({ ...segKey(ctxA, `h${i}`, 'en', '/homestay-abc/'), GSI2PK: pageGsiPk(ctxA, 'en', '/homestay-abc/'), GSI2SK: `HASH#h${i}`, ttl: 1 });

  it('BatchWriteItem dạng PutRequest, tự thử lại UnprocessedItems có chờ', async () => {
    const sent: unknown[][] = [];
    const sleeps: number[] = [];
    const doc = {
      send: async (cmd: unknown) => {
        const reqs = (cmd as BatchWriteCommand).input.RequestItems!.T as unknown[];
        sent.push(reqs);
        return sent.length === 1 ? { UnprocessedItems: { T: reqs.slice(1) } } : {};
      },
    };
    const db = createDynamoSegDb(doc as never, 'T', { sleep: async (ms) => void sleeps.push(ms) });
    await db.batchWrite(ctxA, [k(1), k(2), k(3)]);
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[0][0], { PutRequest: { Item: k(1) } });
    assert.equal(sent[1].length, 2);
    assert.equal(sleeps.length, 1);
  });

  it('UnprocessedItems mãi không hết -> ném lỗi sau số lần thử tối đa', async () => {
    const doc = { send: async (cmd: unknown) => ({ UnprocessedItems: { T: (cmd as BatchWriteCommand).input.RequestItems!.T } }) };
    const db = createDynamoSegDb(doc as never, 'T', { maxAttempts: 3, sleep: async () => {} });
    await assert.rejects(db.batchWrite(ctxA, [k(1)]), { name: 'UnprocessedItemsExhausted' });
  });

  it('chặn khóa (cả GSI2PK) của tenant khác và lô quá 25 trước khi gọi DynamoDB', async () => {
    let calls = 0;
    const db = createDynamoSegDb({ send: async () => void calls++ } as never, 'T');
    await assert.rejects(db.batchWrite(ctxB, [k(1)]), { name: 'TenantKeyViolation' });
    await assert.rejects(db.batchWrite(ctxA, [{ ...k(1), GSI2PK: pageGsiPk(ctxB, 'en', '/shop-b/') }]), { name: 'TenantKeyViolation' });
    await assert.rejects(db.batchWrite(ctxA, Array.from({ length: 26 }, (_, i) => k(i))));
    await assert.rejects(db.queryGsi2(ctxB, pageGsiPk(ctxA, 'en', '/homestay-abc/')), { name: 'TenantKeyViolation' });
    assert.equal(calls, 0);
  });

  it('Query GSI2 và bảng chính đúng tham số, tự lật trang', async () => {
    const inputs: Record<string, unknown>[] = [];
    const doc = {
      send: async (cmd: unknown) => {
        const input = (cmd as QueryCommand).input as Record<string, unknown>;
        inputs.push(input);
        return input.ExclusiveStartKey ? { Items: [{ n: 2 }] } : { Items: [{ n: 1 }], LastEvaluatedKey: { PK: 'x' } };
      },
    };
    const db = createDynamoSegDb(doc as never, 'T');
    const gpk = pageGsiPk(ctxA, 'en', '/homestay-abc/');
    assert.deepEqual(await db.queryGsi2(ctxA, gpk), [{ n: 1 }, { n: 2 }]);
    assert.equal(inputs[0].IndexName, 'GSI2');
    assert.deepEqual(inputs[0].ExpressionAttributeValues, { ':pk': gpk });
    assert.deepEqual(inputs[1].ExclusiveStartKey, { PK: 'x' });
    await db.query(ctxA, `TENANT#${ctxA.tenantId}#SEG#abc`, 'PAGE#en#');
    assert.equal(inputs[2].IndexName, undefined);
    assert.equal(inputs[2].KeyConditionExpression, '#pk = :pk AND begins_with(#sk, :sk)');
    assert.deepEqual(inputs[2].ExpressionAttributeValues, { ':pk': `TENANT#${ctxA.tenantId}#SEG#abc`, ':sk': 'PAGE#en#' });
  });
});
