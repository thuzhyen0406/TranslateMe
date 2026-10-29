import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  callerReferencePrefix,
  cloudFrontCdn,
  cloudFrontPath,
  createInvalidator,
  createMemoryCdn,
  invalidationConfigFromEnv,
  type CdnClient,
} from '../invalidation.js';
import { createSEG, segPath, type SegDb, type SegItem } from '../seg.js';
import { AppError, type Ctx } from '../types.js';

const ctxA: Ctx = { tenantId: 't_aaaaaaaaaaaaaaaaaaaaaaaa', via: 'JWT', requestId: 'r1', role: 'REVIEWER' };
const ctxB: Ctx = { tenantId: 't_bbbbbbbbbbbbbbbbbbbbbbbb', via: 'JWT', requestId: 'r2', role: 'TENANT_ADMIN' };
const h = (s: string) => createHash('sha256').update(s).digest('hex');

function memorySegDb(o: { failQuery?: string } = {}) {
  const store = new Map<string, SegItem>();
  const db: SegDb = {
    async batchWrite(_c, items) {
      for (const it of items) store.set(`${it.PK}|${it.SK}`, { ...it });
    },
    async query(c, pk, skPrefix) {
      if (o.failQuery) throw Object.assign(new Error('x'), { name: o.failQuery });
      if (!pk.startsWith(`TENANT#${c.tenantId}#`)) throw new Error('tenant');
      return [...store.values()].filter((i) => i.PK === pk && i.SK.startsWith(skPrefix)).map((i) => ({ ...i }));
    },
    async queryGsi2(_c, gsi2pk) {
      return [...store.values()].filter((i) => i.GSI2PK === gsi2pk).map((i) => ({ ...i }));
    },
  };
  return db;
}

/** Website mẫu 3 trang (kịch bản nghiệm thu 8): câu X ở 2 trang, có bản en và ko. */
async function scenario(o: { cdn?: CdnClient; failQuery?: string; threshold?: number; batchSize?: number } = {}) {
  const db = memorySegDb({ failQuery: o.failQuery });
  const seg = createSEG({ db });
  const X = h('Phòng có ban công nhìn ra sông.');
  const Y = h('Liên hệ');
  for (const lang of ['en', 'ko']) {
    await seg.writePageSegments(ctxA, lang, segPath('homestay-abc', ''), [X, Y]);
    await seg.writePageSegments(ctxA, lang, segPath('homestay-abc', 'phong-nghi/'), [X]);
    await seg.writePageSegments(ctxA, lang, segPath('homestay-abc', 'lien-he/'), [Y]);
  }
  await seg.writePageSegments(ctxB, 'en', segPath('shop-b', ''), [X]);
  const cdn = o.cdn ?? createMemoryCdn();
  const metrics: Array<[string, number, Record<string, string>]> = [];
  let n = 0;
  const inv = createInvalidator({
    seg,
    cdn,
    uuid: () => `u${++n}`,
    wildcardThreshold: o.threshold,
    batchSize: o.batchSize,
    metric: (name, value, dims) => void metrics.push([name, value, dims]),
  });
  return { seg, inv, cdn, X, Y, metrics };
}

describe('cloudFrontPath', () => {
  it('<path> SEG -> /<slug>/<lang>/<phần còn lại>', () => {
    assert.deepEqual(cloudFrontPath('/homestay-abc/phong-nghi/', 'en'), { slug: 'homestay-abc', path: '/homestay-abc/en/phong-nghi/' });
    assert.deepEqual(cloudFrontPath('/homestay-abc/', 'ko'), { slug: 'homestay-abc', path: '/homestay-abc/ko/' });
    assert.deepEqual(cloudFrontPath('/homestay-abc/ph%C3%B2ng', 'en'), { slug: 'homestay-abc', path: '/homestay-abc/en/ph%C3%B2ng' });
  });

  it('path sai dạng hoặc chứa ký tự đặc biệt của CloudFront -> null', () => {
    assert.equal(cloudFrontPath('homestay-abc/x', 'en'), null);
    assert.equal(cloudFrontPath('/Bad_Slug/x', 'en'), null);
    assert.equal(cloudFrontPath('/homestay-abc/a*', 'en'), null);
    assert.equal(cloudFrontPath('/homestay-abc/a?b', 'en'), null);
  });
});

describe('invalidateForSentences (mục 2.6.4)', () => {
  it('kịch bản 8: sửa câu X ở en -> một CreateInvalidation chứa đúng 2 đường dẫn của en', async () => {
    const { inv, cdn, X, metrics } = await scenario();
    const r = await inv.invalidateForSentences(ctxA, { src: 'vi', tgt: 'en', hashes: [X] });
    assert.deepEqual(r.paths, ['/homestay-abc/en/', '/homestay-abc/en/phong-nghi/']);
    assert.equal(r.mode, 'PATHS');
    assert.equal(r.status, 'SUBMITTED');
    assert.equal(r.invalidationIds.length, 1);
    assert.equal(r.invalidationId, r.invalidationIds[0]);
    assert.deepEqual(r.failedPaths, []);
    const created = [...(cdn as ReturnType<typeof createMemoryCdn>).items.values()];
    assert.equal(created.length, 1);
    assert.deepEqual(created[0].paths, ['/homestay-abc/en/', '/homestay-abc/en/phong-nghi/']);
    assert.equal(created[0].callerReference, `t:${ctxA.tenantId}:u1`);
    assert.deepEqual(metrics, [['invalidation.paths', 2, { mode: 'paths' }]]);
  });

  it('nhiều câu: gộp và loại trùng đường dẫn; ngôn ngữ khác và tenant khác không bị đụng', async () => {
    const { inv, cdn, X, Y } = await scenario();
    const r = await inv.invalidateForSentences(ctxA, { src: 'vi', tgt: 'ko', hashes: [X, Y, X] });
    assert.deepEqual(r.paths, ['/homestay-abc/ko/', '/homestay-abc/ko/lien-he/', '/homestay-abc/ko/phong-nghi/']);
    const all = [...(cdn as ReturnType<typeof createMemoryCdn>).items.values()].flatMap((i) => i.paths);
    assert.ok(all.every((p) => p.startsWith('/homestay-abc/ko/')), 'không có /en/ hay /shop-b/');
  });

  it('câu không còn trên trang nào -> không gọi CloudFront, NOTHING_TO_DO', async () => {
    const { inv, cdn } = await scenario();
    const r = await inv.invalidateForSentences(ctxA, { src: 'vi', tgt: 'en', hashes: [h('không có')] });
    assert.deepEqual(r, { paths: [], mode: 'PATHS', status: 'NOTHING_TO_DO', invalidationIds: [], failedPaths: [] });
    assert.equal((cdn as ReturnType<typeof createMemoryCdn>).items.size, 0);
  });

  it('một website vượt ngưỡng -> wildcard /<slug>/<lang>/* cho riêng website đó', async () => {
    const db = memorySegDb();
    const seg = createSEG({ db });
    const X = h('Chân trang');
    for (let i = 0; i < 6; i++) await seg.writePageSegments(ctxA, 'en', segPath('blog-lon', `bai-${i}/`), [X]);
    await seg.writePageSegments(ctxA, 'en', segPath('homestay-abc', ''), [X]);
    const cdn = createMemoryCdn();
    const metrics: unknown[] = [];
    const inv = createInvalidator({ seg, cdn, wildcardThreshold: 5, metric: (...a) => void metrics.push(a) });
    const r = await inv.invalidateForSentences(ctxA, { src: 'vi', tgt: 'en', hashes: [X] });
    assert.equal(r.mode, 'WILDCARD');
    assert.deepEqual(r.paths, ['/blog-lon/en/*', '/homestay-abc/en/']);
    assert.deepEqual(metrics, [['invalidation.paths', 2, { mode: 'wildcard' }]]);
  });

  it('chia lô theo batchSize, mỗi lô một CallerReference riêng', async () => {
    const { inv, cdn, X, Y } = await scenario({ batchSize: 2 });
    const r = await inv.invalidateForSentences(ctxA, { src: 'vi', tgt: 'en', hashes: [X, Y] });
    assert.equal(r.paths.length, 3);
    assert.equal(r.invalidationIds.length, 2);
    const refs = [...(cdn as ReturnType<typeof createMemoryCdn>).items.values()].map((i) => i.callerReference);
    assert.deepEqual(refs, [`t:${ctxA.tenantId}:u1`, `t:${ctxA.tenantId}:u2`]);
  });

  it('CloudFront lỗi -> không ném lỗi, FAILED kèm đường dẫn chưa gửi (bản sửa vẫn giữ, QC-8)', async () => {
    const { inv, X, metrics } = await scenario({ cdn: createMemoryCdn({ failWith: 'TooManyInvalidationsInProgress' }) });
    const r = await inv.invalidateForSentences(ctxA, { src: 'vi', tgt: 'en', hashes: [X] });
    assert.equal(r.status, 'FAILED');
    assert.equal(r.error, 'TooManyInvalidationsInProgress');
    assert.equal(r.invalidationId, undefined);
    assert.deepEqual(r.failedPaths, r.paths);
    assert.deepEqual(metrics, [['invalidation.paths', 0, { mode: 'paths' }]]);
  });

  it('lô đầu được, lô sau lỗi -> PARTIAL; gọi lại cùng hashes thì gửi lại được', async () => {
    const mem = createMemoryCdn();
    let calls = 0;
    const flaky: CdnClient = {
      createInvalidation: async (i) => {
        if (++calls === 2) throw Object.assign(new Error('x'), { name: 'ThrottlingException' });
        return mem.createInvalidation(i);
      },
      getInvalidation: (id) => mem.getInvalidation(id),
    };
    const { inv, X, Y } = await scenario({ cdn: flaky as never, batchSize: 2 });
    const r = await inv.invalidateForSentences(ctxA, { src: 'vi', tgt: 'en', hashes: [X, Y] });
    assert.equal(r.status, 'PARTIAL');
    assert.equal(r.invalidationIds.length, 1);
    assert.equal(r.failedPaths.length, 1);
    const again = await inv.invalidateForSentences(ctxA, { src: 'vi', tgt: 'en', hashes: [X, Y] });
    assert.equal(again.status, 'SUBMITTED');
  });

  it('tra SEG lỗi -> FAILED, không gọi CloudFront', async () => {
    const { inv, cdn, X } = await scenario({ failQuery: 'ProvisionedThroughputExceededException' });
    const r = await inv.invalidateForSentences(ctxA, { src: 'vi', tgt: 'en', hashes: [X] });
    assert.equal(r.status, 'FAILED');
    assert.equal(r.error, 'SEG_QUERY_FAILED:ProvisionedThroughputExceededException');
    assert.equal((cdn as ReturnType<typeof createMemoryCdn>).items.size, 0);
  });

  it('đầu vào sai -> INVALID_REQUEST', async () => {
    const { inv, X } = await scenario();
    await assert.rejects(inv.invalidateForSentences(ctxA, { src: 'vi', tgt: 'en#x', hashes: [X] }), (e: unknown) => e instanceof AppError && e.code === 'INVALID_REQUEST');
    await assert.rejects(inv.invalidateForSentences(ctxA, { src: 'vi', tgt: 'en', hashes: ['ABC'] }), (e: unknown) => e instanceof AppError && e.code === 'INVALID_REQUEST');
  });

  it('metric lỗi không làm hỏng yêu cầu', async () => {
    const { seg, X } = await scenario();
    const inv = createInvalidator({ seg, cdn: createMemoryCdn(), metric: () => { throw new Error('obs down'); } });
    assert.equal((await inv.invalidateForSentences(ctxA, { src: 'vi', tgt: 'en', hashes: [X] })).status, 'SUBMITTED');
  });
});

describe('getInvalidationStatus (mục 2.6.4 bước 6)', () => {
  it('InProgress -> Completed với lần xóa của chính tenant', async () => {
    const { inv, X } = await scenario();
    const r = await inv.invalidateForSentences(ctxA, { src: 'vi', tgt: 'en', hashes: [X] });
    const s1 = await inv.getInvalidationStatus(ctxA, r.invalidationId!);
    assert.equal(s1.status, 'IN_PROGRESS');
    assert.deepEqual(s1.paths, r.paths);
    assert.equal((await inv.getInvalidationStatus(ctxA, r.invalidationId!)).status, 'COMPLETED');
  });

  it('tenant khác, id không tồn tại hoặc sai dạng -> NOT_FOUND giống nhau', async () => {
    const { inv, X } = await scenario();
    const r = await inv.invalidateForSentences(ctxA, { src: 'vi', tgt: 'en', hashes: [X] });
    const isNotFound = (e: unknown) => e instanceof AppError && e.code === 'NOT_FOUND';
    await assert.rejects(inv.getInvalidationStatus(ctxB, r.invalidationId!), isNotFound);
    await assert.rejects(inv.getInvalidationStatus(ctxA, 'I999999999999'), isNotFound);
    await assert.rejects(inv.getInvalidationStatus(ctxA, '../x'), isNotFound);
  });

  it('tiền tố CallerReference không nhầm t_1 với t_10', () => {
    assert.ok(!`${callerReferencePrefix('t_10')}u`.startsWith(callerReferencePrefix('t_1')));
  });
});

describe('cloudFrontCdn (adapter SDK)', () => {
  class CreateInvalidationCommand {
    constructor(public input: unknown) {}
  }
  class GetInvalidationCommand {
    constructor(public input: unknown) {}
  }

  it('CreateInvalidation đúng DistributionId, CallerReference, Paths', async () => {
    const sent: unknown[] = [];
    const cdn = cloudFrontCdn(
      { send: async (c: unknown) => (sent.push(c), { Invalidation: { Id: 'I1' } }) },
      { CreateInvalidationCommand, GetInvalidationCommand },
      'E123',
    );
    assert.deepEqual(await cdn.createInvalidation({ callerReference: 't:x:1', paths: ['/a/en/', '/a/en/b'] }), { id: 'I1' });
    assert.ok(sent[0] instanceof CreateInvalidationCommand);
    assert.deepEqual((sent[0] as CreateInvalidationCommand).input, {
      DistributionId: 'E123',
      InvalidationBatch: { CallerReference: 't:x:1', Paths: { Quantity: 2, Items: ['/a/en/', '/a/en/b'] } },
    });
  });

  it('GetInvalidation: đọc trạng thái; NoSuchInvalidation -> null; lỗi khác ném ra', async () => {
    let mode = 'ok';
    const cdn = cloudFrontCdn(
      {
        send: async () => {
          if (mode === 'missing') throw Object.assign(new Error('x'), { name: 'NoSuchInvalidation' });
          if (mode === 'down') throw Object.assign(new Error('x'), { name: 'ServiceUnavailable' });
          return { Invalidation: { Id: 'I1', Status: 'Completed', CreateTime: new Date('2026-10-30T00:00:00Z'), InvalidationBatch: { CallerReference: 't:x:1', Paths: { Items: ['/a/en/'] } } } };
        },
      },
      { CreateInvalidationCommand, GetInvalidationCommand },
      'E123',
    );
    assert.deepEqual(await cdn.getInvalidation('I1'), { id: 'I1', status: 'Completed', callerReference: 't:x:1', paths: ['/a/en/'], createdAt: '2026-10-30T00:00:00.000Z' });
    mode = 'missing';
    assert.equal(await cdn.getInvalidation('I1'), null);
    mode = 'down';
    await assert.rejects(cdn.getInvalidation('I1'), { name: 'ServiceUnavailable' });
  });
});

describe('invalidationConfigFromEnv', () => {
  it('mặc định 500/500; batch không quá 3.000', () => {
    assert.deepEqual(invalidationConfigFromEnv({}), { distributionId: undefined, wildcardThreshold: 500, batchSize: 500 });
    assert.deepEqual(invalidationConfigFromEnv({ CLOUDFRONT_DISTRIBUTION_ID: ' E1 ', INVALIDATION_WILDCARD_THRESHOLD: '200', INVALIDATION_BATCH_SIZE: '9000' }), {
      distributionId: 'E1',
      wildcardThreshold: 200,
      batchSize: 3000,
    });
    assert.equal(invalidationConfigFromEnv({ INVALIDATION_WILDCARD_THRESHOLD: 'abc' }).wildcardThreshold, 500);
  });
});
