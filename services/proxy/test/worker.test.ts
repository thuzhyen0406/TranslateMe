/**
 * Worker C13 (FINISH_PAGE) và cách proxy đóng gói sự kiện gửi worker (B.10, 2.5 & 3.9).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { InvokeCommand } from '@aws-sdk/client-lambda';
import type { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createTM, tmKey, type SentenceWithHash } from '../../../libs/common/tm.js';
import { createTranslator } from '../../../libs/common/translator.js';
import type { Ctx } from '../../../libs/common/types.js';
import { lambdaWorkerInvoker, s3PayloadStore, workerDepsFromEnv } from '../handler.js';
import { staticSiteResolver, type SiteConfig } from '../sites.js';
import { hashSentenceStub } from '../stubs.js';
import { createWorkerHandler, type WorkerDeps } from '../worker.js';
import { buildWorkerEvents, workerKeyPrefix, type PayloadStore, type WorkerEvent } from '../workerEvents.js';
import { SITE, fakeLogger, fakeQuota, fakeTranslate, memoryTmDb } from './helpers.js';

const ctx: Ctx = { tenantId: SITE.tenantId, via: 'SLUG', requestId: 'x', slug: SITE.slug };
const withHash = (texts: string[]): SentenceWithHash[] => texts.map((text, id) => ({ id, text, hash: hashSentenceStub(text) }));
const BASE = {
  type: 'FINISH_PAGE' as const,
  tenantId: SITE.tenantId,
  slug: SITE.slug,
  src: 'vi',
  tgt: 'en',
  path: 'phong-nghi/',
  glossaryVersion: 2,
  terminologyName: null,
};

function memoryStore() {
  const files = new Map<string, string>();
  const store: PayloadStore & { files: typeof files } = {
    files,
    async put(k, b) {
      files.set(k, b);
    },
    async get(k) {
      const v = files.get(k);
      if (v === undefined) throw Object.assign(new Error('x'), { name: 'NoSuchKey' });
      return v;
    },
  };
  return store;
}

function setup(o: Partial<WorkerDeps> & { sites?: SiteConfig[]; db?: ReturnType<typeof memoryTmDb>; client?: ReturnType<typeof fakeTranslate> } = {}) {
  const db = o.db ?? memoryTmDb();
  const client = o.client ?? fakeTranslate();
  const quota = fakeQuota();
  const logger = fakeLogger();
  const worker = createWorkerHandler({
    resolveSite: staticSiteResolver(o.sites ?? [SITE]),
    tm: createTM({ db, writer: 'worker' }),
    translate: createTranslator(client),
    quota,
    logger,
    ...o,
  });
  return { worker, db, client, quota, logger };
}

describe('buildWorkerEvents', () => {
  it('không có câu -> không có sự kiện; ít câu -> một sự kiện kèm câu', async () => {
    assert.deepEqual(await buildWorkerEvents(BASE, []), { events: [], dropped: [] });
    const s = withHash(['Một', 'Hai']);
    assert.deepEqual(await buildWorkerEvents(BASE, s), { events: [{ ...BASE, sentences: s }], dropped: [] });
  });

  it('chia theo kích thước JSON, mỗi sự kiện ≤ maxBytes, giữ đủ câu theo thứ tự', async () => {
    const s = withHash(Array.from({ length: 50 }, (_, i) => `Câu số ${i} khá dài để chia sự kiện.`));
    const { events } = await buildWorkerEvents(BASE, s, { maxBytes: 2_000, maxInlineEvents: 100 });
    assert.ok(events.length > 1);
    for (const e of events) assert.ok(Buffer.byteLength(JSON.stringify(e), 'utf8') <= 2_000);
    assert.deepEqual(events.flatMap((e) => e.sentences ?? []), s);
  });

  it('quá nhiều sự kiện và có kho S3 -> ghi câu ra S3 dưới worker/<tenantId>/', async () => {
    const s = withHash(Array.from({ length: 50 }, (_, i) => `Câu số ${i} khá dài để chia sự kiện.`));
    const store = memoryStore();
    const { events } = await buildWorkerEvents(BASE, s, { maxBytes: 2_000, maxInlineEvents: 2, store, uniqueId: () => 'u1' });
    assert.equal(events.length, 1);
    assert.equal(events[0].sentences, undefined);
    assert.equal(events[0].sentencesS3Key, `worker/${SITE.tenantId}/u1-0.json`);
    assert.deepEqual(JSON.parse(store.files.get(events[0].sentencesS3Key!)!), s);
  });

  it('quá nhiều sự kiện nhưng không có kho S3 -> vẫn gửi kèm câu', async () => {
    const s = withHash(Array.from({ length: 50 }, (_, i) => `Câu số ${i} khá dài để chia sự kiện.`));
    const { events, dropped } = await buildWorkerEvents(BASE, s, { maxBytes: 2_000, maxInlineEvents: 2 });
    assert.ok(events.length > 2);
    assert.ok(events.every((e) => e.sentences && !e.sentencesS3Key));
    assert.deepEqual(dropped, []);
  });

  it('một câu riêng lẻ vượt maxBytes, chỉ một nhóm -> vẫn chuyển qua S3, không có sự kiện nào vượt giới hạn', async () => {
    const big = withHash(['Một câu rất dài '.repeat(200)]);
    const store = memoryStore();
    const { events, dropped } = await buildWorkerEvents(BASE, big, { maxBytes: 2_000, store, uniqueId: () => 'u2' });
    assert.deepEqual(dropped, []);
    assert.equal(events.length, 1);
    assert.equal(events[0].sentences, undefined);
    assert.equal(events[0].sentencesS3Key, `worker/${SITE.tenantId}/u2-0.json`);
    assert.deepEqual(JSON.parse(store.files.get(events[0].sentencesS3Key!)!), big);
    for (const e of events) assert.ok(Buffer.byteLength(JSON.stringify(e), 'utf8') <= 2_000);
  });

  it('câu quá lớn lẫn với câu thường, có S3 -> giữ đủ câu theo thứ tự trong các tệp S3', async () => {
    const s = withHash(['Câu đầu.', 'Một câu rất dài '.repeat(200), 'Câu cuối.']);
    const store = memoryStore();
    const { events, dropped } = await buildWorkerEvents(BASE, s, { maxBytes: 2_000, store, uniqueId: () => 'u3' });
    assert.deepEqual(dropped, []);
    assert.ok(events.every((e) => e.sentencesS3Key && !e.sentences));
    const all = events.flatMap((e) => JSON.parse(store.files.get(e.sentencesS3Key!)!) as unknown[]);
    assert.deepEqual(all, s);
  });

  it('câu quá lớn và không có kho S3 -> bỏ câu đó (báo trong dropped), vẫn gửi các câu còn lại', async () => {
    const s = withHash(['Câu đầu.', 'Một câu rất dài '.repeat(200), 'Câu cuối.']);
    const { events, dropped } = await buildWorkerEvents(BASE, s, { maxBytes: 2_000 });
    assert.deepEqual(dropped, [s[1]]);
    assert.deepEqual(events.flatMap((e) => e.sentences ?? []), [s[0], s[2]]);
    for (const e of events) assert.ok(Buffer.byteLength(JSON.stringify(e), 'utf8') <= 2_000);
  });
});

describe('worker C13 – FINISH_PAGE', () => {
  it('chỉ dịch câu còn trượt TM, ghi MACHINE, đặt trước và đếm theo website', async () => {
    const db = memoryTmDb();
    const key = tmKey(ctx, 'vi', 'en', hashSentenceStub('Chào mừng'));
    db.store.set(`${key.PK}|${key.SK}`, { ...key, src: 'Chào mừng', tgt: 'Welcome', label: 'HUMAN', glossaryVersion: 1 });
    const { worker, client, quota } = setup({ db });
    const s = withHash(['Chào mừng', 'Xem {1}bảng giá{/1} nhé.', 'Liên hệ']);
    const r = await worker({ ...BASE, sentences: s });
    assert.deepEqual(r, { status: 'DONE', received: 3, translated: 2, pending: 0, failed: 0 });
    assert.equal(client.calls.length, 1);
    assert.ok(!client.calls[0].Text.includes('Chào mừng'));
    assert.equal(quota.reserves[0].n, 'Xem bảng giá nhé.'.length + 'Liên hệ'.length);
    assert.deepEqual(quota.settles[0].source, { kind: 'WEB', slug: SITE.slug });
    assert.equal(quota.settles[0].u.machineChars, quota.reserves[0].n);
    assert.equal(quota.settles[0].u.requests, 0, 'lượt truy cập đã được proxy đếm');
    const written = [...db.store.values()].filter((v) => v.label === 'MACHINE').map((v) => v.tgt);
    assert.deepEqual(written.sort(), ['LIÊN HỆ', 'XEM {1}BẢNG GIÁ{/1} NHÉ.']);
  });

  it('mọi câu đã có trong TM -> NOTHING_TO_DO, không đặt trước, không gọi Translate', async () => {
    const db = memoryTmDb();
    const first = setup({ db });
    await first.worker({ ...BASE, sentences: withHash(['Một', 'Hai']) });
    const second = setup({ db });
    const r = await second.worker({ ...BASE, sentences: withHash(['Một', 'Hai']) });
    assert.equal(r.status, 'NOTHING_TO_DO');
    assert.equal(second.client.calls.length, 0);
    assert.equal(second.quota.reserves.length, 0);
  });

  it('dùng thuật ngữ hiện hành từ getGlossaryState, gắn cờ HUMAN lỗi thời và hậu kiểm câu MACHINE mới (3.9)', async () => {
    const db = memoryTmDb();
    const humanHash = hashSentenceStub('Ở phố cổ Hội An');
    const humanKey = tmKey(ctx, 'vi', 'en', humanHash);
    db.store.set(`${humanKey.PK}|${humanKey.SK}`, {
      ...humanKey,
      src: 'Ở phố cổ Hội An',
      tgt: 'In the old town',
      label: 'HUMAN',
      glossaryVersion: 1,
      GSI3PK: `TENANT#${SITE.tenantId}#TM#HUMAN`,
    });

    const { worker, client, logger } = setup({
      db,
      getGlossaryState: async () => ({
        version: 5,
        terminologyName: 'tm-t_new',
        terms: [
          {
            normalized: 'phố cổ hội an',
            sourceTerm: 'phố cổ Hội An',
            type: 'FIXED',
            translations: { en: 'Hoi An Ancient Town' },
            sinceVersion: 4,
          },
        ],
      }),
    });
    await worker({ ...BASE, sentences: withHash(['Ở phố cổ Hội An', 'Đường đi phố cổ Hội An']) });
    assert.deepEqual(client.calls[0].TerminologyNames, ['tm-t_new']);

    // Bản HUMAN lỗi thời được gắn cờ Cần xem lại
    const updatedHuman = db.store.get(`${humanKey.PK}|${humanKey.SK}`)!;
    assert.equal(updatedHuman.needsReview, true);
    assert.equal(updatedHuman.GSI3PK, `TENANT#${SITE.tenantId}#TM#REVIEW`);

    // Bản MACHINE mới dịch thiếu "Hoi An Ancient Town" bị hậu kiểm gắn cờ Cần xem lại
    const machineHash = hashSentenceStub('Đường đi phố cổ Hội An');
    const machineKey = tmKey(ctx, 'vi', 'en', machineHash);
    const machineItem = db.store.get(`${machineKey.PK}|${machineKey.SK}`)!;
    assert.equal(machineItem.needsReview, true);
    assert.equal(machineItem.GSI3PK, `TENANT#${SITE.tenantId}#TM#REVIEW`);
    assert.equal(logger.infos[0].glossaryPostCheckFlagged, 1);
  });

  it('đọc Glossary lỗi -> dừng ERROR, không tra/ghi TM, không đặt hạn mức, không gọi Translate (3.9)', async () => {
    const db = memoryTmDb();
    const { worker, client, quota, logger } = setup({
      db,
      getGlossaryState: async () => {
        throw Object.assign(new Error('down'), { name: 'ProvisionedThroughputExceededException' });
      },
    });
    const r = await worker({ ...BASE, sentences: withHash(['Một', 'Hai']) });
    assert.equal(r.status, 'ERROR');
    assert.equal(r.reason, 'GLOSSARY_READ_ERROR');
    assert.equal(r.pending, 2);
    assert.equal(client.calls.length, 0);
    assert.equal(quota.reserves.length, 0);
    assert.equal(db.store.size, 0);
    assert.equal(logger.errors[0].action, 'WORKER_GLOSSARY_ERROR');
  });

  it('hết hạn mức -> QUOTA_EXCEEDED, không gọi Translate', async () => {
    const { worker, client } = setup({ quota: fakeQuota({ limit: 1 }) });
    const r = await worker({ ...BASE, sentences: withHash(['Một câu dài']) });
    assert.equal(r.status, 'QUOTA_EXCEEDED');
    assert.equal(r.pending, 1);
    assert.equal(client.calls.length, 0);
  });

  it('đọc câu từ S3 dưới tiền tố của tenant', async () => {
    const store = memoryStore();
    const key = `${workerKeyPrefix(SITE.tenantId)}abc-0.json`;
    store.files.set(key, JSON.stringify(withHash(['Một', 'Hai'])));
    const { worker } = setup({ store });
    const r = await worker({ ...BASE, sentencesS3Key: key });
    assert.equal(r.status, 'DONE');
    assert.equal(r.translated, 2);
  });

  it('kiểm tra lại tenant và sự kiện (B.1.1) -> REJECTED, không dịch', async () => {
    const store = memoryStore();
    const cases: [unknown, string, SiteConfig[]?][] = [
      [null, 'INVALID_EVENT'],
      [{ ...BASE, type: 'OTHER', sentences: [] }, 'INVALID_EVENT'],
      [{ ...BASE, tenantId: 'PLATFORM', sentences: [] }, 'INVALID_EVENT'],
      [{ ...BASE, slug: 'Bad Slug', sentences: [] }, 'INVALID_EVENT'],
      [{ ...BASE }, 'INVALID_EVENT'],
      [{ ...BASE, tenantId: 't_other', sentences: withHash(['Một']) }, 'TENANT_MISMATCH'],
      [{ ...BASE, slug: 'khong-co', sentences: withHash(['Một']) }, 'TENANT_MISMATCH'],
      [{ ...BASE, sentences: withHash(['Một']) }, 'TENANT_LOCKED', [{ ...SITE, tenantStatus: 'LOCKED' }]],
      [{ ...BASE, sentences: withHash(['Một']) }, 'SITE_NOT_ACTIVE', [{ ...SITE, status: 'PAUSED' }]],
      [{ ...BASE, tgt: 'ja', sentences: withHash(['Một']) }, 'LANG_NOT_ENABLED'],
      [{ ...BASE, sentencesS3Key: 'worker/t_other/a.json' }, 'S3_KEY_OUTSIDE_TENANT'],
      [{ ...BASE, sentencesS3Key: `worker/${SITE.tenantId}/../t_other/a.json` }, 'S3_KEY_OUTSIDE_TENANT'],
      [{ ...BASE, sentences: [{ id: 0, text: 'Một', hash: 'abc' }] }, 'INVALID_SENTENCES'],
    ];
    for (const [event, reason, sites] of cases) {
      const { worker, client, quota } = setup({ sites, store });
      const r = await worker(event);
      assert.equal(r.status, 'REJECTED', reason);
      assert.equal(r.reason, reason);
      assert.equal(client.calls.length, 0);
      assert.equal(quota.reserves.length, 0);
    }
  });

  it('lỗi bất ngờ -> trả ERROR, không throw (tránh Lambda tự gọi lại); bộ dịch lỗi thì hoàn lại hạn mức', async () => {
    const quota = fakeQuota();
    const { worker, logger } = setup({ quota, translate: async () => Promise.reject(new Error('boom')) });
    const r = await worker({ ...BASE, sentences: withHash(['Một']) });
    assert.equal(r.status, 'ERROR');
    assert.equal(quota.releases.length, 1);
    assert.equal(logger.errors[0].action, 'WORKER_ERROR');
  });
});

describe('worker – kết nối AWS', () => {
  it('lambdaWorkerInvoker gọi bất đồng bộ (Event) với JSON của sự kiện', async () => {
    const sent: InvokeCommand[] = [];
    const invoke = lambdaWorkerInvoker({ send: async (c: InvokeCommand) => (sent.push(c), { StatusCode: 202 }) } as never, 'translateme-dev-worker');
    const e: WorkerEvent = { ...BASE, sentences: withHash(['Một']) };
    await invoke(e);
    assert.equal(sent[0].input.FunctionName, 'translateme-dev-worker');
    assert.equal(sent[0].input.InvocationType, 'Event');
    assert.deepEqual(JSON.parse(Buffer.from(sent[0].input.Payload as Uint8Array).toString('utf8')), e);

    const bad = lambdaWorkerInvoker({ send: async () => ({ StatusCode: 500 }) } as never, 'w');
    await assert.rejects(bad(e), { name: 'WorkerInvokeError' });
  });

  it('s3PayloadStore ghi và đọc đúng bucket/khoá', async () => {
    const objects = new Map<string, string>();
    const routedTenants: string[] = [];
    const s3 = {
      async send(c: PutObjectCommand | GetObjectCommand) {
        const { Bucket, Key } = c.input;
        if ('Body' in c.input) {
          objects.set(`${Bucket}/${Key}`, String(c.input.Body));
          return {};
        }
        const v = objects.get(`${Bucket}/${Key}`);
        return { Body: { transformToString: async () => v } };
      },
    };
    const store = s3PayloadStore(s3 as never, 'payload-bucket', (tenantId) => {
      routedTenants.push(tenantId);
      return s3 as never;
    });
    await store.put('worker/t_1/a.json', '[1]');
    assert.equal(objects.get('payload-bucket/worker/t_1/a.json'), '[1]');
    assert.equal(await store.get('worker/t_1/a.json'), '[1]');
    assert.deepEqual(routedTenants, ['t_1']);
    await assert.rejects(store.get('worker/t_2/../secret.json'), /outside a tenant prefix/);
  });

  it('workerDepsFromEnv cần TABLE_NAME; đọc WORKER_BUDGET_MS', () => {
    assert.throws(() => workerDepsFromEnv({}, fakeLogger()));
    const d = workerDepsFromEnv({ TABLE_NAME: 'translate-data', WORKER_BUDGET_MS: '120000', WORKER_PAYLOAD_BUCKET: 'b' }, fakeLogger());
    assert.equal(d.budgetMs, 120_000);
    assert.ok(d.store);
  });
});
