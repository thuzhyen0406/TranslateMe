import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createJobStore } from '../../../libs/common/jobs.js';
import type { SafeFetchOutcome } from '../../../libs/common/safeFetch.js';
import { createSEG, segPath } from '../../../libs/common/seg.js';
import { createTM } from '../../../libs/common/tm.js';
import type { Ctx } from '../../../libs/common/types.js';
import { memoryDataDb } from '../../../libs/common/test/memoryDataDb.js';
import { createProxyHandler, s3PayloadStore } from '../handler.js';
import {
  extractSitemapLocs,
  filterSitemapUrls,
  finishPrewarm,
  markPrewarmFailed,
  prewarmKeyPrefix,
  prewarmPages,
  readSitemap,
  restOfUrl,
  type PrewarmDeps,
  type PrewarmPagesEvent,
} from '../prewarm.js';
import { staticSiteResolver, type SiteConfig } from '../sites.js';
import { SAMPLE_PAGE, SITE, fakeFetch, fakeLogger, fakeQuota, fakeTranslate, memorySegDb, memoryTmDb, okHtml } from './helpers.js';
import type { PayloadStore } from '../workerEvents.js';

const JOB = 'job-20261101-0123456789ab';
const ctx: Ctx = { tenantId: SITE.tenantId, via: 'SLUG', requestId: 'x', slug: SITE.slug };

const xml = (body: string): SafeFetchOutcome => ({ kind: 'OK', html: body, finalUrl: 'x', status: 200, contentType: 'application/xml', headers: {} });
const notFound: SafeFetchOutcome = { kind: 'OK', html: 'not found', finalUrl: 'x', status: 404, contentType: 'application/xml', headers: {} };
const urlset = (locs: string[]) => `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs.map((l) => `<url><loc>${l}</loc></url>`).join('')}</urlset>`;

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

function setup(o: { sites?: SiteConfig[]; sitemaps?: Record<string, SafeFetchOutcome>; quotaLimit?: number; now?: () => number; page?: (url: string) => SafeFetchOutcome } = {}) {
  const jobDb = memoryDataDb();
  const store = memoryStore();
  const tmDb = memoryTmDb();
  const segDb = memorySegDb();
  const quota = fakeQuota({ limit: o.quotaLimit });
  const translateClient = fakeTranslate();
  const pageFetch = fakeFetch(o.page ?? ((u) => okHtml(SAMPLE_PAGE, u)));
  const sites = o.sites ?? [SITE];
  const fetched: string[] = [];
  const prewarmLogger = fakeLogger();
  const deps: PrewarmDeps = {
    resolveSite: staticSiteResolver(sites),
    jobDb,
    store,
    fetchSitemap: async (url) => {
      fetched.push(url);
      return o.sitemaps?.[url] ?? notFound;
    },
    renderPage: createProxyHandler({
      resolveSite: staticSiteResolver(sites),
      fetchPage: pageFetch,
      translateClient,
      publicBaseUrl: 'https://d1abc.cloudfront.net',
      logger: fakeLogger(),
      quota,
      tm: createTM({ db: tmDb, writer: 'prewarm' }),
      seg: createSEG({ db: segDb }),
      getGlossaryState: async () => ({ version: 1, terminologyName: null, terms: [] }),
      countRequests: false,
    }),
    now: o.now,
    logger: prewarmLogger,
  };
  const jobs = createJobStore(jobDb);
  return { deps, logger: prewarmLogger, jobDb, store, tmDb, segDb, quota, translateClient, pageFetch, fetched, jobs };
}

async function queued(s: ReturnType<typeof setup>, langs = ['en', 'ko']) {
  await s.jobs.create(ctx, { jobId: JOB, type: 'PREWARM', slug: SITE.slug, targetLangs: langs });
}

describe('sitemap – đọc <loc> và lọc URL (hàm thuần)', () => {
  it('urlset: CDATA, thực thể XML, tiền tố namespace, bỏ chú thích', () => {
    const r = extractSitemapLocs(`<?xml version="1.0"?><!-- <loc>https://x/bo</loc> --><s:urlset xmlns:s="x">
      <s:url><s:loc> https://homestay-abc.vn/a?x=1&amp;y=2 </s:loc></s:url>
      <url><loc><![CDATA[https://homestay-abc.vn/b]]></loc></url></s:urlset>`);
    assert.deepEqual(r, { kind: 'urlset', locs: ['https://homestay-abc.vn/a?x=1&y=2', 'https://homestay-abc.vn/b'] });
  });

  it('sitemap index; tài liệu không phải sitemap -> null', () => {
    assert.deepEqual(extractSitemapLocs('<sitemapindex><sitemap><loc>https://h.vn/s1.xml</loc></sitemap></sitemapindex>'), { kind: 'sitemapindex', locs: ['https://h.vn/s1.xml'] });
    assert.equal(extractSitemapLocs('<html><body>404</body></html>'), null);
  });

  it('chỉ giữ URL cùng website với trang chủ; bỏ miền khác, http khác https, ngoài thư mục trang chủ, tệp không phải HTML', () => {
    const home = 'https://homestay-abc.vn/vi/';
    assert.equal(restOfUrl('https://homestay-abc.vn/vi/phong-nghi/', home), 'phong-nghi/');
    assert.equal(restOfUrl('https://homestay-abc.vn/vi', home), '');
    assert.equal(restOfUrl('https://homestay-abc.vn/vi/tin?trang=2#top', home), 'tin?trang=2');
    assert.equal(restOfUrl('https://homestay-abc.vn/vi/ph%C3%B2ng', home), 'ph%C3%B2ng');
    for (const bad of ['https://evil.com/vi/', 'http://homestay-abc.vn/vi/a', 'https://homestay-abc.vn/en/a', 'https://homestay-abc.vn/vi/menu.pdf', 'https://u:p@homestay-abc.vn/vi/', 'ftp://homestay-abc.vn/vi/', 'not a url']) {
      assert.equal(restOfUrl(bad, home), null, bad);
    }
  });

  it('loại trùng và giới hạn số URL', () => {
    const locs = ['https://h.vn/a', 'https://h.vn/a', 'https://x.vn/a', 'https://h.vn/b', 'https://h.vn/c', 'https://h.vn/d'];
    assert.deepEqual(filterSitemapUrls(locs, 'https://h.vn/', 2), { rests: ['a', 'b'], offSite: 1, truncated: 2 });
  });
});

describe('ReadSitemap', () => {
  it('đọc sitemap của trang chủ, chia lô ghi S3 dưới tenant/<tenant>/worker/prewarm/<job>/, JOB -> RUNNING với tổng URL × ngôn ngữ', async () => {
    const locs = Array.from({ length: 9 }, (_, i) => `https://homestay-abc.vn/trang-${i}/`).concat(['https://evil.com/x', 'https://homestay-abc.vn/anh.jpg']);
    const s = setup({ sitemaps: { 'https://homestay-abc.vn/sitemap.xml': xml(urlset(locs)) } });
    await queued(s);
    const out = await readSitemap({ job_id: JOB, tenant_id: SITE.tenantId, slug: SITE.slug, target_langs: ['en', 'ko', 'ja'] }, s.deps);
    assert.deepEqual(out.target_langs, ['en', 'ko'], 'chỉ giữ ngôn ngữ đang bật');
    assert.equal(out.urls, 9);
    assert.equal(out.total_pages, 18);
    assert.equal(out.lots.length, 3, '8 trang mỗi lô / 2 ngôn ngữ = 4 URL mỗi lô');
    assert.ok(out.lots.every((k) => k.startsWith(prewarmKeyPrefix(SITE.tenantId, JOB))));
    assert.deepEqual(JSON.parse(s.store.files.get(out.lots[0])!), ['trang-0/', 'trang-1/', 'trang-2/', 'trang-3/']);
    assert.deepEqual(out.warnings.map((w) => [w.code, w.count]), [['URL_SKIPPED', 2]]);
    const job = (await s.jobs.get(ctx, JOB))!;
    assert.deepEqual([job.status, job.total], ['RUNNING', 18]);
  });

  it('trang chủ có thư mục: thử <home>/sitemap.xml rồi /sitemap.xml; sitemap index chỉ đọc sitemap con cùng miền', async () => {
    const site = { ...SITE, homeUrl: 'https://homestay-abc.vn/vi/' } as SiteConfig;
    const s = setup({
      sites: [site],
      sitemaps: {
        'https://homestay-abc.vn/sitemap.xml': xml('<sitemapindex><sitemap><loc>https://homestay-abc.vn/s-vi.xml</loc></sitemap><sitemap><loc>https://evil.com/s.xml</loc></sitemap></sitemapindex>'),
        'https://homestay-abc.vn/s-vi.xml': xml(urlset(['https://homestay-abc.vn/vi/', 'https://homestay-abc.vn/vi/lien-he', 'https://homestay-abc.vn/en/contact'])),
        'https://evil.com/s.xml': xml(urlset(['https://homestay-abc.vn/vi/bi-mat'])),
      },
    });
    await queued(s, ['en']);
    const out = await readSitemap({ job_id: JOB, tenant_id: SITE.tenantId, slug: SITE.slug, target_langs: ['en'] }, s.deps);
    assert.deepEqual(s.fetched, ['https://homestay-abc.vn/vi/sitemap.xml', 'https://homestay-abc.vn/sitemap.xml', 'https://homestay-abc.vn/s-vi.xml']);
    assert.equal(out.urls, 2);
    assert.deepEqual(JSON.parse(s.store.files.get(out.lots[0])!), ['', 'lien-he']);
  });

  it('lỗi có tên ổn định để MarkFailed ghi lý do', async () => {
    const run = async (o: Parameters<typeof setup>[0], input: Record<string, unknown> = {}) => {
      const s = setup(o);
      await queued(s);
      return readSitemap({ job_id: JOB, tenant_id: SITE.tenantId, slug: SITE.slug, target_langs: ['en'], ...input } as never, s.deps);
    };
    const ok = { 'https://homestay-abc.vn/sitemap.xml': xml(urlset(['https://homestay-abc.vn/a'])) };
    await assert.rejects(run({ sitemaps: ok }, { tenant_id: 't_khac' }), { name: 'SITE_NOT_FOUND' });
    await assert.rejects(run({ sitemaps: ok, sites: [{ ...SITE, status: 'PAUSED' } as SiteConfig] }), { name: 'SITE_NOT_ACTIVE' });
    await assert.rejects(run({ sitemaps: ok, sites: [{ ...SITE, tenantStatus: 'LOCKED' } as SiteConfig] }), { name: 'TENANT_SUSPENDED' });
    await assert.rejects(run({ sitemaps: ok }, { target_langs: ['ja'] }), { name: 'NO_TARGET_LANGS' });
    await assert.rejects(run({}), { name: 'SITEMAP_NOT_FOUND' });
    await assert.rejects(run({ sitemaps: { 'https://homestay-abc.vn/sitemap.xml': xml(urlset(['https://evil.com/a'])) } }), { name: 'SITEMAP_EMPTY' });
    await assert.rejects(run({ sitemaps: ok }, { job_id: '../x' }), { name: 'INVALID_EVENT' });
  });
});

describe('PrewarmPages (C13 chế độ trang)', () => {
  async function lot(s: ReturnType<typeof setup>, rests: string[], langs = ['en', 'ko']) {
    await queued(s, langs);
    await s.jobs.markRunning(ctx, JOB, rests.length * langs.length);
    const key = `${prewarmKeyPrefix(SITE.tenantId, JOB)}lot-0000.json`;
    await s.store.put(key, JSON.stringify(rests));
    const ev: PrewarmPagesEvent = { mode: 'PREWARM_PAGES', job_id: JOB, tenant_id: SITE.tenantId, slug: SITE.slug, target_langs: langs, urls_key: key };
    return ev;
  }

  it('mỗi URL × ngôn ngữ chạy bước 1–5 và 7 của F2: ghi TM và SEG, tính ký tự vào WEB#slug nhưng không tính lượt xem', async () => {
    const s = setup();
    const ev = await lot(s, ['', 'phong-nghi/?trang=2']);
    const r = await prewarmPages(ev, s.deps);
    assert.deepEqual(r, { pages_done: 4, pages_failed: 0, quota_exceeded: false, timed_out: false });
    assert.deepEqual(s.pageFetch.urls, ['https://homestay-abc.vn/', 'https://homestay-abc.vn/', 'https://homestay-abc.vn/phong-nghi/?trang=2', 'https://homestay-abc.vn/phong-nghi/?trang=2']);
    assert.ok(s.tmDb.store.size > 0);
    const seg = createSEG({ db: s.segDb });
    assert.ok((await seg.sentencesOfPage(ctx, 'ko', segPath(SITE.slug, 'phong-nghi/'))).length > 0);
    assert.ok(s.quota.settles.every((x) => x.source.kind === 'WEB' && x.u.requests === 0 && x.u.pagesServed === 0));
    assert.ok(s.quota.settles.some((x) => x.u.machineChars > 0));
    const job = (await s.jobs.get(ctx, JOB))!;
    assert.deepEqual([job.done, job.failed, job.progress], [4, 0, 100]);
  });

  it('lần dịch trước thứ hai trúng TM hoàn toàn, không gọi Translate', async () => {
    const s = setup();
    const ev = await lot(s, ['']);
    await prewarmPages(ev, s.deps);
    const calls = s.translateClient.calls.length;
    await prewarmPages(ev, s.deps);
    assert.equal(s.translateClient.calls.length, calls);
  });

  it('URL lỗi (origin 404) bị bỏ qua và tính là lỗi, không làm hỏng lô', async () => {
    const s = setup({ page: (u) => (u.includes('loi') ? okHtml('x', u, 404) : okHtml(SAMPLE_PAGE, u)) });
    const r = await prewarmPages(await lot(s, ['loi/', ''], ['en']), s.deps);
    assert.deepEqual([r.pages_done, r.pages_failed], [1, 1]);
  });

  it('thử lại trang dịch dở một lần và chỉ tính trang đã dịch đủ', async () => {
    const s = setup();
    const attempts = new Map<string, number>();
    s.deps.renderPage = async ({ rawPath }) => {
      const path = rawPath!;
      const calls = (attempts.get(path) ?? 0) + 1;
      attempts.set(path, calls);
      const complete = path.endsWith('/recovered/') && calls === 2;
      const headers: Record<string, string> = complete ? {} : { 'x-translateme-partial': '1' };
      return { statusCode: 200, headers, body: '' };
    };

    const result = await prewarmPages(await lot(s, ['recovered/', 'partial/'], ['en']), s.deps);
    assert.deepEqual([...attempts.values()], [2, 2]);
    assert.deepEqual(result, { pages_done: 1, pages_failed: 1, quota_exceeded: false, timed_out: false });
    const finished = await finishPrewarm({ job_id: JOB, tenant_id: SITE.tenantId, slug: SITE.slug, results: [result] }, s.deps);
    assert.deepEqual(finished.warnings.map(({ code, count }) => [code, count]), [['PAGES_FAILED', 1]]);
  });

  it('hết hạn mức ký tự -> dừng lô, trang còn lại tính là lỗi', async () => {
    const s = setup({ quotaLimit: 0 });
    const r = await prewarmPages(await lot(s, ['', 'a/', 'b/'], ['en']), s.deps);
    assert.deepEqual(r, { pages_done: 0, pages_failed: 3, quota_exceeded: true, timed_out: false });
    assert.equal(s.pageFetch.urls.length, 1, 'không tải thêm trang sau khi hết hạn mức');
  });

  it('gần hết thời gian của worker -> dừng, phần còn lại tính là lỗi', async () => {
    let t = 0;
    const s = setup({ now: () => (t += 150_000) });
    s.deps.workerBudgetMs = 240_000;
    const r = await prewarmPages(await lot(s, ['', 'a/'], ['en']), s.deps);
    assert.equal(r.timed_out, true);
    assert.equal(r.pages_done + r.pages_failed, 2);
  });

  it('Step Functions chạy lại một lô đã cộng tiến độ -> không cộng lần nữa, done + failed không vượt total', async () => {
    const s = setup();
    const ev = await lot(s, ['', 'phong-nghi/']);
    await prewarmPages(ev, s.deps);
    const again = await prewarmPages(ev, s.deps); // Retry sau khi lần trước đã cộng tiến độ
    assert.equal(again.pages_done + again.pages_failed, 4);
    const job = (await s.jobs.get(ctx, JOB))!;
    assert.deepEqual([job.total, job.done, job.failed, job.progress], [4, 4, 0, 100]);
    assert.ok(s.logger.infos.some((e) => e.action === 'PREWARM_LOT_ALREADY_COUNTED' && e.lot === 'lot-0000'));
  });

  it('urls_key không phải tệp lot-NNNN.json -> INVALID_EVENT', async () => {
    const s = setup();
    const ev = await lot(s, ['']);
    await assert.rejects(prewarmPages({ ...ev, urls_key: `${prewarmKeyPrefix(SITE.tenantId, JOB)}khac.json` }, s.deps), { name: 'INVALID_EVENT' });
  });

  it('urls_key ngoài tenant/<tenant>/worker/prewarm/<job>/ hoặc tenant không khớp -> từ chối', async () => {
    const s = setup();
    const ev = await lot(s, ['']);
    await assert.rejects(prewarmPages({ ...ev, urls_key: `tenant/t_khac/worker/prewarm/${JOB}/lot-0000.json` }, s.deps), { name: 'INVALID_EVENT' });
    await assert.rejects(prewarmPages({ ...ev, urls_key: `${prewarmKeyPrefix(SITE.tenantId, JOB)}../x.json` }, s.deps), { name: 'INVALID_EVENT' });
    await assert.rejects(prewarmPages({ ...ev, tenant_id: 't_khac', urls_key: `tenant/t_khac/worker/prewarm/${JOB}/lot-0000.json` }, s.deps), { name: 'SITE_NOT_FOUND' });
  });
});

describe('FinishPrewarm / MarkFailed / toàn luồng', () => {
  it('toàn luồng: ReadSitemap -> từng lô -> FinishPrewarm; JOB SUCCEEDED 100% kèm cảnh báo', async () => {
    const locs = ['https://homestay-abc.vn/', 'https://homestay-abc.vn/a/', 'https://homestay-abc.vn/loi/', 'https://evil.com/'];
    const s = setup({ sitemaps: { 'https://homestay-abc.vn/sitemap.xml': xml(urlset(locs)) }, page: (u) => (u.includes('loi') ? okHtml('x', u, 500) : okHtml(SAMPLE_PAGE, u)) });
    await queued(s);
    const out = await readSitemap({ job_id: JOB, tenant_id: SITE.tenantId, slug: SITE.slug, target_langs: ['en', 'ko'] }, s.deps);
    const results = [];
    for (const key of out.lots) results.push(await prewarmPages({ mode: 'PREWARM_PAGES', job_id: JOB, tenant_id: SITE.tenantId, slug: SITE.slug, target_langs: out.target_langs, urls_key: key }, s.deps));
    const fin = await finishPrewarm({ ...out, results }, s.deps);
    assert.equal(fin.status, 'SUCCEEDED');
    const job = (await s.jobs.get(ctx, JOB))!;
    assert.deepEqual([job.status, job.progress, job.total, job.done, job.failed], ['SUCCEEDED', 100, 6, 4, 2]);
    assert.deepEqual(job.warnings.map((w) => [w.code, w.count]), [['URL_SKIPPED', 1], ['PAGES_FAILED', 2]]);
  });

  it('hết hạn mức giữa chừng: vẫn SUCCEEDED kèm cảnh báo QUOTA (mục 2.4.2)', async () => {
    const s = setup();
    await queued(s);
    await s.jobs.markRunning(ctx, JOB, 4);
    await finishPrewarm({ job_id: JOB, tenant_id: SITE.tenantId, slug: SITE.slug, results: [{ pages_done: 1, pages_failed: 3, quota_exceeded: true, timed_out: false }] }, s.deps);
    const job = (await s.jobs.get(ctx, JOB))!;
    assert.equal(job.status, 'SUCCEEDED');
    assert.deepEqual(job.warnings.map((w) => w.code), ['QUOTA', 'PAGES_FAILED']);
  });

  it('MarkFailed: JOB FAILED với tên lỗi, không ghi Cause; tên lạ thành INTERNAL_ERROR', async () => {
    const s = setup();
    await queued(s);
    await markPrewarmFailed({ job_id: JOB, tenant_id: SITE.tenantId, error: { Error: 'SITEMAP_NOT_FOUND', Cause: '{"errorMessage":"chi tiết nội bộ"}' } }, s.deps);
    const job = (await s.jobs.get(ctx, JOB))!;
    assert.deepEqual([job.status, job.reason], ['FAILED', 'SITEMAP_NOT_FOUND']);
    const s2 = setup();
    await queued(s2);
    assert.equal((await markPrewarmFailed({ job_id: JOB, tenant_id: SITE.tenantId, error: { Error: 'bad name <script>' } }, s2.deps)).reason, 'INTERNAL_ERROR');
  });
});

describe('state machine PREWARM (ASL)', () => {
  const asl = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../../../infra/statemachines/prewarm.asl.json', import.meta.url)), 'utf8'));

  it('ReadSitemap -> Map(lots) -> FinishPrewarm; mọi Task (trừ MarkFailed) có Catch về MarkFailed giữ nguyên đầu vào', () => {
    assert.equal(asl.StartAt, 'ReadSitemap');
    assert.equal(asl.States.ReadSitemap.Next, 'PrewarmLots');
    assert.equal(asl.States.PrewarmLots.Type, 'Map');
    assert.equal(asl.States.PrewarmLots.ItemsPath, '$.lots');
    assert.equal(asl.States.PrewarmLots.ResultPath, '$.results');
    assert.equal(asl.States.PrewarmLots.Next, 'FinishPrewarm');
    for (const name of ['ReadSitemap', 'PrewarmLots', 'FinishPrewarm']) {
      assert.deepEqual(asl.States[name].Catch, [{ ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'MarkFailed' }], name);
    }
    assert.equal(asl.States.MarkFailed.Next, 'Failed');
  });

  it('Map gửi đúng thông điệp M4 cho worker', () => {
    assert.deepEqual(asl.States.PrewarmLots.ItemSelector, {
      mode: 'PREWARM_PAGES',
      'job_id.$': '$.job_id',
      'tenant_id.$': '$.tenant_id',
      'slug.$': '$.slug',
      'target_langs.$': '$.target_langs',
      'urls_key.$': '$$.Map.Item.Value',
    });
    const text = JSON.stringify(asl);
    for (const sub of ['ReadSitemapFunctionArn', 'PrewarmPagesFunctionArn', 'FinishPrewarmFunctionArn', 'MarkPrewarmFailedFunctionArn']) assert.ok(text.includes(`\${${sub}}`), sub);
  });

  it('khoá lô dùng được với kho S3 thật của proxy (tiền tố tenant/<tenant>/worker theo session policy tenant)', async () => {
    const objects = new Map<string, string>();
    const s3 = {
      async send(c: { input: { Key: string; Body?: string } }) {
        if (c.input.Body !== undefined) {
          objects.set(c.input.Key, String(c.input.Body));
          return {};
        }
        return { Body: { transformToString: async () => objects.get(c.input.Key) } };
      },
    };
    const key = `${prewarmKeyPrefix(SITE.tenantId, JOB)}lot-0000.json`;
    assert.ok(key.startsWith(`tenant/${SITE.tenantId}/worker/`));
    const store = s3PayloadStore(s3 as never, 'payload-bucket');
    await store.put(key, '["a/"]');
    assert.equal(await store.get(key), '["a/"]');
  });
});

describe('IaC PREWARM: Lambda trong infra/modules/lambdas.yaml, state machine trong infra/modules/workflow.yaml (F6)', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../../../../../${rel}`, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
  const templates = ['infra/modules/lambdas.yaml', 'infra/modules/workflow.yaml'].map((f) => read(f).split('\n'));

  /** Khối tài nguyên `  <name>:` tới tài nguyên kế tiếp (cùng thụt lề 2), tìm trong cả hai template. */
  const resource = (name: string): string[] => {
    for (const lines of templates) {
      const start = lines.indexOf(`  ${name}:`);
      if (start < 0) continue;
      const end = lines.findIndex((l, i) => i > start && /^ {2}[A-Za-z]\w*:$|^\S/.test(l));
      return lines.slice(start, end < 0 ? undefined : end);
    }
    assert.fail(`thiếu tài nguyên ${name}`);
  };
  const prop = (block: string[], key: string) => block.map((l) => new RegExp(`^ {6}${key}: (.+)$`).exec(l)?.[1]).find(Boolean);

  it('DefinitionString của PrewarmStateMachine giống hệt prewarm.asl.json, đủ 4 DefinitionSubstitutions', () => {
    const block = resource('PrewarmStateMachine');
    const at = block.indexOf('      DefinitionString: |-');
    assert.ok(at >= 0);
    const body = block.slice(at + 1).filter((l) => l.startsWith('        ') || l === '').map((l) => l.slice(8)).join('\n');
    assert.deepEqual(JSON.parse(body), JSON.parse(read('infra/statemachines/prewarm.asl.json')));
    for (const key of ['ReadSitemapFunctionArn', 'PrewarmPagesFunctionArn', 'FinishPrewarmFunctionArn', 'MarkPrewarmFailedFunctionArn']) {
      assert.ok(block.some((l) => l === `        ${key}: !Ref ${key}`), key);
      // stack workflow nhận ARN từ output của lambdas.yaml
      assert.ok(templates[0].some((l) => l === `  ${key}:`), `lambdas.yaml thiếu output ${key}`);
    }
    assert.equal(prop(block, 'StateMachineName'), "!Sub 'translateme-${StageName}-prewarm'", 'khớp PREWARM_STATE_MACHINE_ARN của Console');
  });

  it('bốn Lambda trỏ tới hàm export có thật trong prewarm.ts; timeout Lambda < TimeoutSeconds của bước ASL', async () => {
    const mod = await import('../prewarm.js');
    const asl = JSON.parse(read('infra/statemachines/prewarm.asl.json'));
    const aslTimeout: Record<string, number> = {
      ReadSitemapFunction: asl.States.ReadSitemap.TimeoutSeconds,
      PrewarmPagesFunction: asl.States.PrewarmLots.ItemProcessor.States.PrewarmPages.TimeoutSeconds,
      FinishPrewarmFunction: asl.States.FinishPrewarm.TimeoutSeconds,
      MarkPrewarmFailedFunction: asl.States.MarkFailed.TimeoutSeconds,
    };
    for (const [name, stepTimeout] of Object.entries(aslTimeout)) {
      const block = resource(name);
      const handler = prop(block, 'Handler')!;
      assert.match(handler, /^services\/proxy\/prewarm\.\w+$/, name);
      assert.equal(typeof (mod as Record<string, unknown>)[handler.split('.')[1]], 'function', handler);
      const timeout = Number(prop(block, 'Timeout'));
      assert.ok(timeout > 0 && timeout < stepTimeout, `${name}: Lambda ${timeout}s phải < ASL ${stepTimeout}s`);
      assert.ok(block.some((l) => l.trim() === 'TENANT_DATA_ACCESS_ROLE_ARN: !Ref TenantDataAccessRoleArn'), `${name} cần TENANT_DATA_ACCESS_ROLE_ARN`);
    }
    // PrewarmPages: ngân sách 240 s của lô phải nằm trong timeout Lambda
    assert.ok(Number(prop(resource('PrewarmPagesFunction'), 'Timeout')) * 1000 > mod.PREWARM_WORKER_BUDGET_MS);
  });

  it('QC-10: Lambda proxy dừng trước 30 s của CloudFront và dài hơn ngân sách dịch; có STATE_CACHE_S ≤ 60', () => {
    const block = resource('ProxyFunction');
    const timeout = Number(prop(block, 'Timeout'));
    assert.ok(timeout <= 25, `proxy Timeout ${timeout}s`);
    assert.ok(timeout * 1000 > 20_000);
    assert.ok(block.some((l) => l.trim() === 'STATE_CACHE_S: !Ref StateCacheSeconds'));
    assert.ok(block.some((l) => l.trim() === 'PUBLIC_BASE_URL: !Ref PublicBaseUrl'));
    const param = resource('StateCacheSeconds');
    assert.ok(param.some((l) => l.trim() === 'MaxValue: 60'));
  });
});
