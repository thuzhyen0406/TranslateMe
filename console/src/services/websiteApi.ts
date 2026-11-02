/**
 * Dịch vụ màn Website (Q2, Nhiệm vụ 4.6 – TV2): gọi nhóm /console/hosts của C6 và các hàm thuần cho giao diện.
 *
 * Route (Bảng 2.9 của báo cáo; JSON snake_case, lỗi {request_id, error: {code, message, reason?}}):
 *   GET  /console/hosts                    -> { hosts: Host[] }
 *   POST /console/hosts                    -> 201 { host }    body: home_url, display_name, source_lang, target_langs, no_translate_selectors
 *   GET  /console/hosts/{slug}             -> { host }
 *   POST /console/hosts/{slug}/verify      -> { host }        body: { method: 'META' | 'FILE' }; lỗi 400 VERIFICATION_FAILED + reason
 *   POST /console/hosts/{slug}/prewarm     -> 202 { job, existing }   (4.5)
 *   GET  /console/hosts/{slug}/prewarm     -> { job | null }          (4.5)
 *
 * Hai bản cài đặt cùng giao diện WebsiteApi:
 *  - createHttpWebsiteApi: gọi API thật kèm JWT (Authorization: Bearer <idToken>), dùng khi VITE_AUTH_MODE=cognito;
 *  - createMockWebsiteApi: giả lập trong trình duyệt cho chế độ demo (VITE_AUTH_MODE=mock), giống cognitoAuth.
 */
import type {
  CreateWebsiteInput,
  LanguageOption,
  PrewarmJob,
  VerificationFailureReason,
  VerifyMethod,
  Website,
  WebsiteStatus,
} from '../types/website.js';

// ============================================================================
// Hằng và hàm thuần cho giao diện
// ============================================================================

export const LANGUAGE_OPTIONS: readonly LanguageOption[] = Object.freeze([
  { code: 'vi', label: 'Tiếng Việt' },
  { code: 'en', label: 'Tiếng Anh' },
  { code: 'ko', label: 'Tiếng Hàn' },
  { code: 'zh', label: 'Tiếng Trung' },
  { code: 'ja', label: 'Tiếng Nhật' },
  { code: 'fr', label: 'Tiếng Pháp' },
  { code: 'de', label: 'Tiếng Đức' },
  { code: 'th', label: 'Tiếng Thái' },
]);

export const languageLabel = (code: string): string => LANGUAGE_OPTIONS.find((l) => l.code === code)?.label ?? code;

export const WEBSITE_STATUS_LABEL: Readonly<Record<WebsiteStatus, string>> = Object.freeze({
  PENDING: 'Chờ xác minh',
  ACTIVE: 'Đang hoạt động',
  PAUSED: 'Tạm dừng',
});

export const VERIFICATION_FILE_NAME = 'translateme-verification.txt';

export class WebsiteApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public reason?: string,
  ) {
    super(message);
    this.name = 'WebsiteApiError';
  }
}

/** IPv4 nội bộ, loopback, link-local, CGNAT, multicast… (chặn ngay khi nhập; máy chủ vẫn kiểm tra lại bằng DNS) */
function isPrivateIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * Kiểm tra địa chỉ trang chủ ngay khi nhập (Q2): chỉ http/https với tên miền công khai; từ chối localhost,
 * IP nội bộ, IPv6, tên miền nội bộ, có user:pass@ hoặc cổng lạ. Trả về URL chuẩn hóa hoặc thông báo lỗi.
 */
export function validateHomeUrlInput(input: string): { ok: true; url: string } | { ok: false; message: string } {
  const raw = input.trim();
  if (!raw) return { ok: false, message: 'Vui lòng nhập địa chỉ trang chủ.' };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, message: 'Địa chỉ không hợp lệ. Ví dụ: https://homestay-abc.example' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, message: 'Chỉ nhận địa chỉ bắt đầu bằng http:// hoặc https://.' };
  if (u.username || u.password) return { ok: false, message: 'Địa chỉ không được chứa tên đăng nhập hoặc mật khẩu.' };
  if (u.port && u.port !== '80' && u.port !== '443') return { ok: false, message: 'Chỉ nhận cổng mặc định 80 hoặc 443.' };
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.')) {
    return { ok: false, message: 'Không nhận tên máy nội bộ; hãy dùng tên miền công khai.' };
  }
  if (host.startsWith('[') || isPrivateIPv4(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return { ok: false, message: 'Không nhận địa chỉ IP; hãy dùng tên miền công khai.' };
  }
  u.hash = '';
  return { ok: true, url: u.href };
}

/** "a, b\n c" -> ["a", "b", "c"] (bộ chọn CSS vùng không dịch) */
export function parseSelectors(text: string): string[] {
  return [...new Set(text.split(/[,\n]/).map((s) => s.trim()).filter(Boolean))];
}

/** Kiểm tra thông tin bước 1 của Q2. Trả lỗi theo từng trường (rỗng = hợp lệ). */
export function validateCreateWebsite(input: CreateWebsiteInput): Partial<Record<keyof CreateWebsiteInput, string>> {
  const errors: Partial<Record<keyof CreateWebsiteInput, string>> = {};
  const url = validateHomeUrlInput(input.homeUrl);
  if (!url.ok) errors.homeUrl = url.message;
  if (!input.displayName.trim()) errors.displayName = 'Vui lòng nhập tên hiển thị.';
  else if (input.displayName.trim().length > 100) errors.displayName = 'Tên hiển thị tối đa 100 ký tự.';
  if (!LANGUAGE_OPTIONS.some((l) => l.code === input.sourceLang)) errors.sourceLang = 'Vui lòng chọn ngôn ngữ gốc.';
  const targets = input.targetLangs.filter((l) => l !== input.sourceLang);
  if (!targets.length) errors.targetLangs = 'Chọn ít nhất một ngôn ngữ đích khác ngôn ngữ gốc.';
  if (input.noTranslateSelectors.some((s) => s.length > 200 || /[<>{}]/.test(s))) errors.noTranslateSelectors = 'Bộ chọn CSS không hợp lệ.';
  return errors;
}

/** Đường dẫn bản dịch {PUBLIC_BASE_URL}/{slug}/{lang}/ (BASE_MODE=path, QC-10) */
export function translationUrl(publicBaseUrl: string, slug: string, lang: string): string {
  return `${publicBaseUrl.replace(/\/+$/, '')}/${encodeURIComponent(slug)}/${encodeURIComponent(lang)}/`;
}

export const verificationMetaTag = (code: string): string => `<meta name="translateme-site-verification" content="${code}">`;

/** Tệp xác minh nằm ở thư mục gốc của tên miền (như siteManager.verifySite) */
export function verificationFileUrl(homeUrl: string): string {
  try {
    return new URL(`/${VERIFICATION_FILE_NAME}`, homeUrl).href;
  } catch {
    return VERIFICATION_FILE_NAME;
  }
}

const VERIFICATION_REASON_MESSAGE: Readonly<Record<VerificationFailureReason, string>> = Object.freeze({
  UNREACHABLE: 'Không truy cập được website. Kiểm tra website đang mở công khai rồi thử lại.',
  TAG_OR_FILE_NOT_FOUND: 'Không tìm thấy thẻ meta hoặc tệp xác minh. Kiểm tra đã lưu và xuất bản thay đổi chưa.',
  CODE_MISMATCH: 'Mã xác minh không khớp. Hãy sao chép lại đúng mã ở trên.',
  TOO_MANY_REDIRECTS: 'Website chuyển hướng quá số lần cho phép. Hãy dùng đúng địa chỉ trang chủ cuối cùng.',
});

/** Thông báo tiếng Việt cho lỗi của nhóm /console/hosts (Bảng 2.10), kể cả mã của siteManager hiện tại. */
export function websiteErrorMessage(err: unknown): string {
  if (!(err instanceof WebsiteApiError)) return 'Có lỗi tạm thời, vui lòng thử lại.';
  if (err.code === 'VERIFICATION_FAILED' && err.reason && err.reason in VERIFICATION_REASON_MESSAGE) {
    return VERIFICATION_REASON_MESSAGE[err.reason as VerificationFailureReason];
  }
  switch (err.code) {
    case 'VERIFICATION_FAILED':
    case 'VERIFICATION_CODE_MISMATCH':
      return VERIFICATION_REASON_MESSAGE.CODE_MISMATCH;
    case 'VERIFICATION_NOT_FOUND':
      return VERIFICATION_REASON_MESSAGE.TAG_OR_FILE_NOT_FOUND;
    case 'SITE_UNREACHABLE':
      return VERIFICATION_REASON_MESSAGE.UNREACHABLE;
    case 'TOO_MANY_REDIRECTS':
      return VERIFICATION_REASON_MESSAGE.TOO_MANY_REDIRECTS;
    case 'DUPLICATE_SLUG':
      return 'Website này đã được thêm vào TranslateMe.';
    case 'INVALID_REQUEST':
      return err.message || 'Thông tin chưa hợp lệ, vui lòng kiểm tra lại.';
    case 'UNSUPPORTED_LANGUAGE':
      return 'Có ngôn ngữ chưa được hỗ trợ.';
    case 'FORBIDDEN':
      return 'Địa chỉ không được phép (IP nội bộ hoặc không công khai).';
    case 'PERMISSION_DENIED':
      return 'Chỉ Tenant Admin mới quản lý được website.';
    case 'TENANT_SUSPENDED':
      return 'Tổ chức đang bị tạm khóa; bạn chỉ có thể xem.';
    case 'UNAUTHORIZED':
      return 'Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại.';
    case 'NOT_FOUND':
      return 'Không tìm thấy website.';
    default:
      return 'Có lỗi tạm thời, vui lòng thử lại.';
  }
}

export const PREWARM_WARNING_LABEL: Readonly<Record<string, string>> = Object.freeze({
  URL_SKIPPED: 'URL bị bỏ qua (ngoài website hoặc không phải trang)',
  URL_LIMIT: 'Vượt giới hạn số URL, chỉ dịch trước phần đầu',
  SITEMAP_INDEX_TRUNCATED: 'Chỉ đọc một phần sitemap index',
  SITEMAP_CHILD_FAILED: 'Có sitemap con không đọc được',
  PAGES_FAILED: 'Trang không dịch trước được',
  QUOTA: 'Hết hạn mức ký tự tháng, đã dừng giữa chừng',
  LOT_TIMEOUT: 'Có lô hết thời gian xử lý',
});

export const PREWARM_REASON_LABEL: Readonly<Record<string, string>> = Object.freeze({
  SITEMAP_NOT_FOUND: 'Không tìm thấy sitemap.xml ở trang chủ của website.',
  SITEMAP_EMPTY: 'Sitemap không có trang nào thuộc website.',
  SITE_NOT_ACTIVE: 'Website chưa xác minh hoặc đang tạm dừng.',
  TENANT_SUSPENDED: 'Tổ chức đang bị tạm khóa.',
  NO_TARGET_LANGS: 'Website chưa bật ngôn ngữ đích nào.',
  START_FAILED: 'Không khởi động được, vui lòng thử lại.',
});

/** Còn cần hỏi lại tiến độ không */
export const isPrewarmActive = (job: PrewarmJob | null): boolean => job !== null && (job.status === 'QUEUED' || job.status === 'RUNNING');

// ============================================================================
// Giao diện và chuyển đổi JSON
// ============================================================================

export interface WebsiteApi {
  listWebsites(): Promise<Website[]>;
  getWebsite(slug: string): Promise<Website>;
  createWebsite(input: CreateWebsiteInput): Promise<Website>;
  verifyWebsite(slug: string, method: VerifyMethod): Promise<Website>;
  startPrewarm(slug: string): Promise<{ job: PrewarmJob; existing: boolean }>;
  getPrewarm(slug: string): Promise<PrewarmJob | null>;
}

type Json = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function websiteFromJson(h: Json): Website {
  const status = str(h.status);
  return {
    slug: str(h.slug),
    displayName: str(h.display_name) || str(h.displayName) || str(h.slug),
    homeUrl: str(h.home_url) || str(h.homeUrl),
    sourceLang: str(h.source_lang) || str(h.sourceLang),
    targetLangs: strs(h.target_langs ?? h.targetLangs),
    status: status === 'ACTIVE' || status === 'PAUSED' ? status : 'PENDING',
    verificationCode: str(h.verification_code) || str(h.verificationCode),
    noTranslateSelectors: strs(h.no_translate_selectors ?? h.noTranslateSelectors),
    createdAt: str(h.created_at) || str(h.createdAt),
  };
}

export function prewarmJobFromJson(j: Json | null | undefined): PrewarmJob | null {
  if (!j || typeof j !== 'object') return null;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const status = str(j.status);
  return {
    jobId: str(j.job_id),
    status: status === 'RUNNING' || status === 'SUCCEEDED' || status === 'FAILED' ? status : 'QUEUED',
    progress: Math.max(0, Math.min(100, num(j.progress))),
    total: num(j.total),
    done: num(j.done),
    failed: num(j.failed),
    warnings: Array.isArray(j.warnings) ? (j.warnings as PrewarmJob['warnings']) : [],
    ...(typeof j.reason === 'string' ? { reason: j.reason } : {}),
  };
}

// ============================================================================
// Bản gọi API thật
// ============================================================================

export interface HttpWebsiteApiOptions {
  /** VITE_API_BASE_URL, ví dụ https://abc.execute-api.ap-southeast-1.amazonaws.com/prod */
  baseUrl: string;
  /** JWT (idToken) của phiên hiện tại */
  getToken: () => string;
  fetchFn?: typeof fetch;
}

export function createHttpWebsiteApi(opts: HttpWebsiteApiOptions): WebsiteApi {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const doFetch = opts.fetchFn ?? ((...a: Parameters<typeof fetch>) => fetch(...a));

  async function call(method: 'GET' | 'POST', path: string, body?: Json): Promise<Json> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${opts.getToken()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new WebsiteApiError('NETWORK_ERROR', 'Không kết nối được máy chủ.');
    }
    let data: Json = {};
    try {
      data = (await res.json()) as Json;
    } catch {
      data = {};
    }
    if (!res.ok) {
      const e = (data.error ?? {}) as Json;
      throw new WebsiteApiError(str(e.code) || (res.status === 401 ? 'UNAUTHORIZED' : 'INTERNAL_ERROR'), str(e.message), str(e.reason) || undefined);
    }
    return data;
  }

  const hostPath = (slug: string) => `/console/hosts/${encodeURIComponent(slug)}`;
  return {
    async listWebsites() {
      const d = await call('GET', '/console/hosts');
      return (Array.isArray(d.hosts) ? (d.hosts as Json[]) : []).map(websiteFromJson);
    },
    async getWebsite(slug) {
      return websiteFromJson((await call('GET', hostPath(slug))).host as Json);
    },
    async createWebsite(input) {
      const d = await call('POST', '/console/hosts', {
        home_url: input.homeUrl,
        display_name: input.displayName,
        source_lang: input.sourceLang,
        target_langs: input.targetLangs,
        no_translate_selectors: input.noTranslateSelectors,
      });
      return websiteFromJson(d.host as Json);
    },
    async verifyWebsite(slug, method) {
      return websiteFromJson((await call('POST', `${hostPath(slug)}/verify`, { method })).host as Json);
    },
    async startPrewarm(slug) {
      const d = await call('POST', `${hostPath(slug)}/prewarm`, {});
      return { job: prewarmJobFromJson(d.job as Json)!, existing: d.existing === true };
    },
    async getPrewarm(slug) {
      return prewarmJobFromJson((await call('GET', `${hostPath(slug)}/prewarm`)).job as Json | null);
    },
  };
}

// ============================================================================
// Bản giả lập cho chế độ demo
// ============================================================================

export interface MockWebsiteApiOptions {
  /** Tiến độ tăng mỗi lần hỏi (mặc định 25%) */
  prewarmStep?: number;
  /** Mã xác minh sinh ra (mặc định ngẫu nhiên) */
  codeFor?: (slug: string) => string;
  /** Thời điểm hiện tại (ISO) */
  now?: () => string;
}

/**
 * Website giả lập trong bộ nhớ trình duyệt. Xác minh demo: thành công, trừ khi địa chỉ trang chủ chứa
 * "khong-truy-cap" (UNREACHABLE) hoặc "sai-ma" (CODE_MISMATCH) để thử các thông báo lỗi.
 * Dịch trước demo: mỗi lần hỏi tiến độ tăng prewarmStep%, tới 100% thì SUCCEEDED.
 */
export function createMockWebsiteApi(opts: MockWebsiteApiOptions = {}): WebsiteApi & { sites: Map<string, Website> } {
  const sites = new Map<string, Website>();
  const jobs = new Map<string, PrewarmJob>();
  const step = opts.prewarmStep ?? 25;
  const now = opts.now ?? (() => new Date().toISOString());
  const codeFor = opts.codeFor ?? (() => `ts-${Math.random().toString(16).slice(2, 12)}`);
  let seq = 0;

  const notFound = () => new WebsiteApiError('NOT_FOUND', 'Không tìm thấy website.');
  const get = (slug: string) => {
    const s = sites.get(slug);
    if (!s) throw notFound();
    return s;
  };

  return {
    sites,
    async listWebsites() {
      return [...sites.values()].map((s) => ({ ...s }));
    },
    async getWebsite(slug) {
      return { ...get(slug) };
    },
    async createWebsite(input) {
      const url = validateHomeUrlInput(input.homeUrl);
      if (!url.ok) throw new WebsiteApiError('INVALID_REQUEST', url.message);
      // Giống siteManager: slug sinh từ tên miền
      const slug = new URL(url.url).hostname.replace(/[^a-z0-9-]/gi, '-').toLowerCase().replace(/^-+|-+$/g, '').slice(0, 63);
      if (sites.has(slug)) throw new WebsiteApiError('DUPLICATE_SLUG', 'Slug đã tồn tại trên hệ thống');
      const site: Website = {
        slug,
        displayName: input.displayName.trim(),
        homeUrl: url.url,
        sourceLang: input.sourceLang,
        targetLangs: input.targetLangs.filter((l) => l !== input.sourceLang),
        status: 'PENDING',
        verificationCode: codeFor(slug),
        noTranslateSelectors: input.noTranslateSelectors,
        createdAt: now(),
      };
      sites.set(slug, site);
      return { ...site };
    },
    async verifyWebsite(slug, method) {
      const s = get(slug);
      if (method !== 'META' && method !== 'FILE') throw new WebsiteApiError('INVALID_REQUEST', 'Cách xác minh không hợp lệ.');
      if (s.homeUrl.includes('khong-truy-cap')) throw new WebsiteApiError('VERIFICATION_FAILED', '', 'UNREACHABLE');
      if (s.homeUrl.includes('sai-ma')) throw new WebsiteApiError('VERIFICATION_FAILED', '', 'CODE_MISMATCH');
      s.status = 'ACTIVE';
      return { ...s };
    },
    async startPrewarm(slug) {
      const s = get(slug);
      if (s.status !== 'ACTIVE') throw new WebsiteApiError('INVALID_REQUEST', 'Website chưa xác minh hoặc đang tạm dừng.');
      const cur = jobs.get(slug);
      if (cur && isPrewarmActive(cur)) return { job: { ...cur }, existing: true };
      const job: PrewarmJob = { jobId: `job-demo-${++seq}`, status: 'QUEUED', progress: 0, total: 10 * s.targetLangs.length, done: 0, failed: 0, warnings: [] };
      jobs.set(slug, job);
      return { job: { ...job }, existing: false };
    },
    async getPrewarm(slug) {
      get(slug);
      const job = jobs.get(slug);
      if (!job) return null;
      if (isPrewarmActive(job)) {
        job.progress = Math.min(100, job.progress + step);
        job.done = Math.round((job.total * job.progress) / 100);
        job.status = job.progress >= 100 ? 'SUCCEEDED' : 'RUNNING';
      }
      return { ...job };
    },
  };
}
