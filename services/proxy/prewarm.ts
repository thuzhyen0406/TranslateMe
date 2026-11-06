/**
 * Dịch trước theo sitemap – F6, Nhiệm vụ 4.5 (TV2). Mục 2.5.3, thông điệp M2 và M4 của báo cáo.
 *
 * State machine PREWARM (infra/statemachines/prewarm.asl.json):
 *   C6 --M2 {job_id, tenant_id, slug, target_langs}--> ReadSitemap -> Map(lots) --M4--> PrewarmPages -> FinishPrewarm
 *                                                      (lỗi ở bất kỳ bước nào) -> MarkFailed
 *
 *  - ReadSitemap: kiểm tra lại tenant và website (QC-6); tải sitemap.xml của trang chủ qua safeFetch (chặn SSRF);
 *    đọc cả sitemap index (một cấp); chỉ giữ URL cùng website với trang chủ đã xác minh; loại trùng; bỏ URL
 *    không phải trang HTML; giới hạn PREWARM_MAX_URLS; chia lô ghi ra S3 dưới worker/<tenantId>/prewarm/<jobId>/;
 *    JOB -> RUNNING với total = số URL × số ngôn ngữ đích.
 *  - PrewarmPages (C13, chế độ trang): mỗi URL × ngôn ngữ chạy lõi proxy F2 (bước 1–5 và 7: tải, tách câu, tra TM,
 *    đặt trước hạn mức, dịch, ghi TM và SEG, đếm ký tự vào WEB#slug) nhưng bỏ HTML trả về và không đếm lượt xem trang.
 *    URL lỗi bị bỏ qua và tính vào cảnh báo. Hết hạn mức ký tự thì dừng lô (mục 2.4.2: PREWARM vẫn SUCCEEDED kèm QUOTA).
 *    Tiến độ JOB cập nhật sau mỗi lô.
 *  - FinishPrewarm: JOB -> SUCCEEDED kèm cảnh báo. MarkFailed: JOB -> FAILED với lý do (tên lỗi, không kèm chi tiết).
 */
import { db } from '../../libs/common/db.js';
import { createJobStore, JOB_ID_RE, type JobDb, type JobWarning } from '../../libs/common/jobs.js';
import { safeFetch, type SafeFetchOutcome } from '../../libs/common/safeFetch.js';
import type { Ctx } from '../../libs/common/types.js';
import { createProxyHandler, depsFromEnv, type FunctionUrlEvent, type ProxyResponse } from './handler.js';
import { LANG_RE, SLUG_RE, type SiteConfig, type SiteResolver } from './sites.js';
import type { PayloadStore } from './workerEvents.js';

export const PREWARM_MAX_URLS = 500;
/** Số trang (URL × ngôn ngữ) mỗi lô: 8 × ngân sách 20 s + tải trang vẫn dưới timeout 300 s của worker */
export const PREWARM_PAGES_PER_LOT = 8;
export const PREWARM_PAGE_BUDGET_MS = 20_000;
export const PREWARM_WORKER_BUDGET_MS = 240_000;
export const MAX_CHILD_SITEMAPS = 20;
export const SITEMAP_MAX_BYTES = 5 * 1024 * 1024;
export const SITEMAP_CONTENT_TYPES = ['application/xml', 'text/xml'];

export const prewarmKeyPrefix = (tenantId: string, jobId: string): string => `worker/${tenantId}/prewarm/${jobId}/`;

// ---------------------------------------------------------------------------
// Thông điệp
// ---------------------------------------------------------------------------

/** M2: C6 -> C8 (StartExecution) */
export interface PrewarmStartInput {
  job_id: string;
  tenant_id: string;
  slug: string;
  target_langs: string[];
}

/** Kết quả ReadSitemap, đi qua Map của Step Functions (chỉ mang khóa S3, không mang danh sách URL) */
export interface ReadSitemapOutput extends PrewarmStartInput {
  urls: number;
  total_pages: number;
  lots: string[];
  warnings: JobWarning[];
}

/** M4: C8 -> C13 (Invoke đồng bộ, chế độ trang) */
export interface PrewarmPagesEvent {
  mode: 'PREWARM_PAGES';
  job_id: string;
  tenant_id: string;
  slug: string;
  target_langs: string[];
  urls_key: string;
}

export interface PrewarmPagesResult {
  pages_done: number;
  pages_failed: number;
  quota_exceeded: boolean;
  timed_out: boolean;
}

export interface FinishPrewarmEvent {
  job_id: string;
  tenant_id: string;
  slug: string;
  urls?: number;
  total_pages?: number;
  warnings?: JobWarning[];
  results: PrewarmPagesResult[];
}

export interface MarkFailedEvent {
  job_id: string;
  tenant_id: string;
  slug?: string;
  error?: { Error?: string; Cause?: string };
}

/** Lỗi có tên ổn định, dùng làm lý do FAILED của JOB (Step Functions Catch đọc $.Error) */
export class PrewarmError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

// ---------------------------------------------------------------------------
// Sitemap (hàm thuần)
// ---------------------------------------------------------------------------

const decodeXmlEntities = (s: string): string =>
  s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (all, e: string) => {
    if (e === 'amp') return '&';
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    const code = e.startsWith('#x') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
  });

/**
 * Đọc <loc> của sitemap (urlset) hoặc sitemap index. Không dùng bộ phân tích XML (không xử lý DTD/thực thể ngoài,
 * nên không có XXE). null nếu không phải sitemap.
 */
export function extractSitemapLocs(xml: string): { kind: 'urlset' | 'sitemapindex'; locs: string[] } | null {
  const body = xml.replace(/<!--[\s\S]*?-->/g, '');
  const kind = /<(?:[\w-]+:)?sitemapindex[\s>]/i.test(body) ? 'sitemapindex' : /<(?:[\w-]+:)?urlset[\s>]/i.test(body) ? 'urlset' : null;
  if (!kind) return null;
  const locs: string[] = [];
  const re = /<(?:[\w-]+:)?loc>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))\s*<\/(?:[\w-]+:)?loc>/gi;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    const v = decodeXmlEntities((m[1] ?? m[2] ?? '').trim());
    if (v) locs.push(v);
  }
  return { kind, locs };
}

const NON_HTML_EXT = /\.(?:pdf|jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|zip|rar|7z|gz|tar|docx?|xlsx?|pptx?|odt|csv|txt|xml|json|rss|atom|css|js|mjs|map|woff2?|ttf|otf|eot|mp[34]|m4a|wav|ogg|webm|mov|avi)$/i;

/** Phần đường dẫn sau trang chủ (giữ mã hóa %, kèm query) – dạng `rest` của proxy. null nếu URL ngoài website. */
export function restOfUrl(loc: string, homeUrl: string): string | null {
  let u: URL;
  let home: URL;
  try {
    u = new URL(loc);
    home = new URL(homeUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.origin !== home.origin || u.username || u.password) return null;
  const homePath = home.pathname.endsWith('/') ? home.pathname : `${home.pathname}/`;
  const path = u.pathname === homePath.slice(0, -1) ? homePath : u.pathname;
  if (!path.startsWith(homePath)) return null;
  const rest = path.slice(homePath.length);
  if (NON_HTML_EXT.test(rest) || rest.split('/').some((seg) => seg === '..' || seg === '.')) return null;
  return `${rest}${u.search}`;
}

/** Lọc danh sách <loc> thành danh sách `rest` duy nhất, giới hạn max. */
export function filterSitemapUrls(locs: readonly string[], homeUrl: string, max = PREWARM_MAX_URLS): { rests: string[]; offSite: number; truncated: number } {
  const seen = new Set<string>();
  const rests: string[] = [];
  let offSite = 0;
  let truncated = 0;
  for (const loc of locs) {
    const r = restOfUrl(loc, homeUrl);
    if (r === null) {
      offSite++;
      continue;
    }
    if (seen.has(r)) continue;
    seen.add(r);
    if (rests.length >= max) truncated++;
    else rests.push(r);
  }
  return { rests, offSite, truncated };
}

// ---------------------------------------------------------------------------
// Phụ thuộc và kiểm tra chung
// ---------------------------------------------------------------------------

export interface PrewarmLogger {
  info(entry: Record<string, unknown>): void;
  error(entry: Record<string, unknown>): void;
}

export interface PrewarmDeps {
  resolveSite: SiteResolver;
  jobDb: JobDb;
  store?: PayloadStore;
  /** safeFetch với allowedContentTypes XML (ReadSitemap) */
  fetchSitemap?: (url: string) => Promise<SafeFetchOutcome>;
  /** Lõi proxy F2 cấu hình cho dịch trước (createProxyHandler, countRequests = false, không gọi worker) */
  renderPage?: (event: FunctionUrlEvent) => Promise<ProxyResponse>;
  maxUrls?: number;
  pagesPerLot?: number;
  pageBudgetMs?: number;
  workerBudgetMs?: number;
  now?: () => number;
  logger?: PrewarmLogger;
}

export const defaultPrewarmLogger: PrewarmLogger = {
  info: (e) => console.log(JSON.stringify({ level: 'INFO', service: 'translate-prewarm', ...e })),
  error: (e) => console.error(JSON.stringify({ level: 'ERROR', service: 'translate-prewarm', ...e })),
};

const ctxOf = (tenantId: string, jobId: string, slug?: string): Ctx => ({ tenantId, via: 'SLUG', requestId: `prewarm-${jobId}`, ...(slug ? { slug } : {}) });

function checkIds(e: { job_id?: unknown; tenant_id?: unknown; slug?: unknown }): void {
  if (typeof e.job_id !== 'string' || !JOB_ID_RE.test(e.job_id)) throw new PrewarmError('INVALID_EVENT', 'job_id không hợp lệ');
  if (typeof e.tenant_id !== 'string' || !e.tenant_id || e.tenant_id === 'PLATFORM') throw new PrewarmError('INVALID_EVENT', 'tenant_id không hợp lệ');
  if (typeof e.slug !== 'string' || !SLUG_RE.test(e.slug)) throw new PrewarmError('INVALID_EVENT', 'slug không hợp lệ');
}

function checkLangs(v: unknown): string[] {
  if (!Array.isArray(v) || !v.length || !v.every((l) => typeof l === 'string' && LANG_RE.test(l))) {
    throw new PrewarmError('INVALID_EVENT', 'target_langs không hợp lệ');
  }
  return [...new Set(v as string[])];
}

/** QC-6: worker không tin mã tenant trong thông điệp; tra lại website theo slug và đối chiếu. */
async function checkSite(deps: PrewarmDeps, tenantId: string, slug: string): Promise<SiteConfig> {
  const site = await deps.resolveSite(slug);
  if (!site || site.tenantId !== tenantId) throw new PrewarmError('SITE_NOT_FOUND', 'Không tìm thấy website của tenant');
  if (site.tenantStatus !== 'ACTIVE') throw new PrewarmError('TENANT_SUSPENDED', 'Tenant đang bị khóa');
  if (site.status !== 'ACTIVE') throw new PrewarmError('SITE_NOT_ACTIVE', 'Website chưa xác minh hoặc đang tạm dừng');
  return site;
}

const warning = (code: string, count: number, message: string, where = 'sitemap'): JobWarning => ({ code, where, count, message });

// ---------------------------------------------------------------------------
// ReadSitemap
// ---------------------------------------------------------------------------

export async function readSitemap(input: PrewarmStartInput, deps: PrewarmDeps): Promise<ReadSitemapOutput> {
  checkIds(input);
  const requested = checkLangs(input.target_langs);
  if (!deps.store) throw new PrewarmError('MISCONFIGURED', 'Thiếu kho S3 cho danh sách URL');
  if (!deps.fetchSitemap) throw new PrewarmError('MISCONFIGURED', 'Thiếu bộ tải sitemap');
  const site = await checkSite(deps, input.tenant_id, input.slug);
  const langs = requested.filter((l) => site.targetLangs.includes(l));
  if (!langs.length) throw new PrewarmError('NO_TARGET_LANGS', 'Không có ngôn ngữ đích nào đang bật');

  // Địa chỉ sitemap lấy từ HOST (trang chủ), không nhận từ người dùng (M2)
  const home = new URL(site.homeUrl);
  const candidates = [...new Set([new URL('sitemap.xml', home).href, new URL('/sitemap.xml', home).href])];
  let parsed: ReturnType<typeof extractSitemapLocs> = null;
  for (const url of candidates) {
    const o = await deps.fetchSitemap(url);
    if (o.kind !== 'OK' || o.status < 200 || o.status > 299) continue;
    parsed = extractSitemapLocs(o.html);
    if (parsed) break;
  }
  if (!parsed) throw new PrewarmError('SITEMAP_NOT_FOUND', 'Không tải được sitemap.xml hợp lệ');

  const warnings: JobWarning[] = [];
  let locs = parsed.locs;
  if (parsed.kind === 'sitemapindex') {
    // Sitemap con cũng phải cùng website (một cấp, không đệ quy tiếp)
    const children = locs.filter((l) => sameOrigin(l, site.homeUrl));
    if (children.length > MAX_CHILD_SITEMAPS) warnings.push(warning('SITEMAP_INDEX_TRUNCATED', children.length - MAX_CHILD_SITEMAPS, `Chỉ đọc ${MAX_CHILD_SITEMAPS} sitemap con đầu tiên`));
    locs = [];
    let failedChildren = 0;
    for (const child of children.slice(0, MAX_CHILD_SITEMAPS)) {
      const o = await deps.fetchSitemap(child);
      const sub = o.kind === 'OK' && o.status >= 200 && o.status <= 299 ? extractSitemapLocs(o.html) : null;
      if (!sub || sub.kind !== 'urlset') failedChildren++;
      else locs.push(...sub.locs);
      if (locs.length > (deps.maxUrls ?? PREWARM_MAX_URLS) * 4) break;
    }
    if (failedChildren) warnings.push(warning('SITEMAP_CHILD_FAILED', failedChildren, 'Có sitemap con không tải hoặc không đọc được'));
  }

  const max = deps.maxUrls ?? PREWARM_MAX_URLS;
  const { rests, offSite, truncated } = filterSitemapUrls(locs, site.homeUrl, max);
  if (offSite) warnings.push(warning('URL_SKIPPED', offSite, 'Bỏ qua URL ngoài website hoặc không phải trang HTML'));
  if (truncated) warnings.push(warning('URL_LIMIT', truncated, `Chỉ dịch trước ${max} URL đầu tiên`));
  if (!rests.length) throw new PrewarmError('SITEMAP_EMPTY', 'Sitemap không có URL nào của website');

  // Chia lô: mỗi lô tối đa pagesPerLot trang (URL × ngôn ngữ)
  const perLot = Math.max(1, Math.floor((deps.pagesPerLot ?? PREWARM_PAGES_PER_LOT) / langs.length));
  const lots: string[] = [];
  for (let i = 0; i * perLot < rests.length; i++) {
    const key = `${prewarmKeyPrefix(input.tenant_id, input.job_id)}lot-${String(i).padStart(4, '0')}.json`;
    await deps.store.put(key, JSON.stringify(rests.slice(i * perLot, (i + 1) * perLot)));
    lots.push(key);
  }

  const total = rests.length * langs.length;
  await createJobStore(deps.jobDb, deps.now).markRunning(ctxOf(input.tenant_id, input.job_id), input.job_id, total, { warnings });
  (deps.logger ?? defaultPrewarmLogger).info({ action: 'PREWARM_SITEMAP', jobId: input.job_id, tenantId: input.tenant_id, slug: input.slug, urls: rests.length, lots: lots.length, total });
  return { job_id: input.job_id, tenant_id: input.tenant_id, slug: input.slug, target_langs: langs, urls: rests.length, total_pages: total, lots, warnings };
}

function sameOrigin(loc: string, homeUrl: string): boolean {
  try {
    const u = new URL(loc);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === new URL(homeUrl).origin && !u.username && !u.password;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// PrewarmPages (C13, chế độ trang)
// ---------------------------------------------------------------------------

export async function prewarmPages(event: PrewarmPagesEvent, deps: PrewarmDeps): Promise<PrewarmPagesResult> {
  checkIds(event);
  if (event.mode !== 'PREWARM_PAGES') throw new PrewarmError('INVALID_EVENT', 'mode không hợp lệ');
  const langs = checkLangs(event.target_langs);
  const prefix = prewarmKeyPrefix(event.tenant_id, event.job_id);
  if (typeof event.urls_key !== 'string' || !event.urls_key.startsWith(prefix) || event.urls_key.includes('..')) {
    throw new PrewarmError('INVALID_EVENT', 'urls_key nằm ngoài worker/<tenantId>/prewarm/<jobId>/');
  }
  // Mã lô = tên tệp lô (lot-0003): dùng để cộng tiến độ đúng một lần mỗi lô khi Step Functions chạy lại
  const lotFile = /^(lot-\d{4,})\.json$/.exec(event.urls_key.slice(prefix.length));
  if (!lotFile) throw new PrewarmError('INVALID_EVENT', 'urls_key phải là tệp lô lot-NNNN.json');
  const lotId = lotFile[1];
  if (!deps.store || !deps.renderPage) throw new PrewarmError('MISCONFIGURED', 'Thiếu kho S3 hoặc lõi proxy');
  const site = await checkSite(deps, event.tenant_id, event.slug);
  const rests: unknown = JSON.parse(await deps.store.get(event.urls_key));
  if (!Array.isArray(rests) || !rests.every((r) => typeof r === 'string')) throw new PrewarmError('INVALID_EVENT', 'Danh sách URL hỏng');

  const now = deps.now ?? Date.now;
  const started = now();
  const pageBudget = deps.pageBudgetMs ?? PREWARM_PAGE_BUDGET_MS;
  const workerBudget = deps.workerBudgetMs ?? PREWARM_WORKER_BUDGET_MS;
  const res: PrewarmPagesResult = { pages_done: 0, pages_failed: 0, quota_exceeded: false, timed_out: false };
  const enabled = langs.filter((l) => site.targetLangs.includes(l));
  const total = (rests as string[]).length * langs.length;

  outer: for (const rest of rests as string[]) {
    const [path, ...q] = rest.split('?');
    for (const lang of langs) {
      if (res.quota_exceeded || res.timed_out) break outer;
      // Không đủ thời gian cho một trang nữa (ngân sách dịch + tải trang) -> dừng, phần còn lại tính là lỗi
      if (now() - started + pageBudget + 15_000 > workerBudget) {
        res.timed_out = true;
        break outer;
      }
      if (!enabled.includes(lang)) {
        res.pages_failed++;
        continue;
      }
      try {
        const out = await deps.renderPage({
          rawPath: `/${site.slug}/${lang}/${path}`,
          rawQueryString: q.join('?'),
          requestContext: { requestId: `prewarm-${event.job_id}`, http: { method: 'GET' } },
        });
        if (out.statusCode === 200 && out.headers['x-translateme-partial'] === 'quota') {
          res.quota_exceeded = true;
          res.pages_failed++;
        } else if (out.statusCode === 200) res.pages_done++;
        else res.pages_failed++;
      } catch {
        res.pages_failed++;
      }
    }
  }
  // Trang chưa chạy tới (hết hạn mức hoặc hết giờ) tính là lỗi để tiến độ vẫn tới 100%
  res.pages_failed = total - res.pages_done;

  const logger = deps.logger ?? defaultPrewarmLogger;
  try {
    const counted = await createJobStore(deps.jobDb, deps.now).addProgress(
      ctxOf(event.tenant_id, event.job_id, event.slug),
      event.job_id,
      res.pages_done,
      res.pages_failed,
      lotId,
    );
    if (!counted) logger.info({ action: 'PREWARM_LOT_ALREADY_COUNTED', jobId: event.job_id, lot: lotId });
  } catch (err) {
    // Tiến độ chỉ để hiển thị; FinishPrewarm vẫn chốt kết quả
    logger.error({ action: 'PREWARM_PROGRESS_FAILED', jobId: event.job_id, error: err instanceof Error ? err.name : 'Unknown' });
  }
  logger.info({ action: 'PREWARM_LOT', jobId: event.job_id, tenantId: event.tenant_id, slug: event.slug, ...res });
  return res;
}

// ---------------------------------------------------------------------------
// FinishPrewarm / MarkFailed
// ---------------------------------------------------------------------------

export async function finishPrewarm(event: FinishPrewarmEvent, deps: PrewarmDeps): Promise<{ status: 'SUCCEEDED'; warnings: JobWarning[] }> {
  checkIds(event);
  const results = Array.isArray(event.results) ? event.results : [];
  const sum = (k: 'pages_done' | 'pages_failed') => results.reduce((n, r) => n + (typeof r?.[k] === 'number' ? r[k] : 0), 0);
  const failed = sum('pages_failed');
  const warnings: JobWarning[] = [...(Array.isArray(event.warnings) ? event.warnings : [])];
  if (results.some((r) => r?.quota_exceeded)) warnings.push(warning('QUOTA', 1, 'Hết hạn mức ký tự tháng, bỏ qua các trang còn lại', 'pages'));
  if (results.some((r) => r?.timed_out)) warnings.push(warning('LOT_TIMEOUT', results.filter((r) => r?.timed_out).length, 'Có lô hết thời gian, một số trang chưa dịch trước', 'pages'));
  if (failed) warnings.push(warning('PAGES_FAILED', failed, 'Một số trang không dịch trước được (lỗi tải trang, hết hạn mức hoặc hết thời gian)', 'pages'));
  await createJobStore(deps.jobDb, deps.now).finish(ctxOf(event.tenant_id, event.job_id, event.slug), event.job_id, { status: 'SUCCEEDED', warnings });
  (deps.logger ?? defaultPrewarmLogger).info({ action: 'PREWARM_DONE', jobId: event.job_id, tenantId: event.tenant_id, done: sum('pages_done'), failed });
  return { status: 'SUCCEEDED', warnings };
}

export async function markPrewarmFailed(event: MarkFailedEvent, deps: PrewarmDeps): Promise<{ status: 'FAILED'; reason: string }> {
  if (typeof event.job_id !== 'string' || !JOB_ID_RE.test(event.job_id) || typeof event.tenant_id !== 'string' || !event.tenant_id) {
    throw new PrewarmError('INVALID_EVENT', 'Thiếu job_id hoặc tenant_id');
  }
  // Chỉ giữ tên lỗi (ví dụ SITEMAP_NOT_FOUND, States.Timeout); không ghi Cause để không lộ chi tiết nội bộ
  const raw = typeof event.error?.Error === 'string' ? event.error.Error : 'INTERNAL_ERROR';
  const reason = /^[A-Za-z0-9_.]{1,64}$/.test(raw) ? raw : 'INTERNAL_ERROR';
  await createJobStore(deps.jobDb, deps.now).finish(ctxOf(event.tenant_id, event.job_id), event.job_id, { status: 'FAILED', reason });
  (deps.logger ?? defaultPrewarmLogger).error({ action: 'PREWARM_FAILED', jobId: event.job_id, tenantId: event.tenant_id, reason });
  return { status: 'FAILED', reason };
}

// ---------------------------------------------------------------------------
// Cấu hình từ biến môi trường và các handler Lambda
// (ReadSitemap, FinishPrewarm, MarkFailed là hàm tác vụ của C8; PrewarmPages là C13 chế độ trang.
//  Cùng gói mã, mỗi hàm một vai trò IAM riêng – mục 2.2.)
// ---------------------------------------------------------------------------

export function prewarmDepsFromEnv(env: NodeJS.ProcessEnv = process.env): PrewarmDeps {
  const proxy = depsFromEnv(env);
  let renderPage: PrewarmDeps['renderPage'];
  return {
    resolveSite: proxy.resolveSite,
    jobDb: db,
    store: proxy.workerStore,
    fetchSitemap: (url) => safeFetch(url, { allowedContentTypes: SITEMAP_CONTENT_TYPES, maxSizeBytes: SITEMAP_MAX_BYTES }),
    // Lõi F2 cho dịch trước: không gọi worker hoàn tất nền, không đếm lượt xem trang
    get renderPage() {
      renderPage ??= createProxyHandler({ ...proxy, invokeWorker: undefined, countRequests: false, budgetMs: PREWARM_PAGE_BUDGET_MS });
      return renderPage;
    },
  };
}

let envDeps: PrewarmDeps | undefined;
const fromEnv = (): PrewarmDeps => (envDeps ??= prewarmDepsFromEnv());

export const readSitemapHandler = (event: PrewarmStartInput) => readSitemap(event, fromEnv());
export const prewarmPagesHandler = (event: PrewarmPagesEvent) => prewarmPages(event, fromEnv());
export const finishPrewarmHandler = (event: FinishPrewarmEvent) => finishPrewarm(event, fromEnv());
export const markPrewarmFailedHandler = (event: MarkFailedEvent) => markPrewarmFailed(event, fromEnv());
