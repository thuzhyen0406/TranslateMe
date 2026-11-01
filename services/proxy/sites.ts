/**
 * sites – tra cấu hình website theo slug cho Lambda proxy (F2 bước 1 – Nhiệm vụ 1.6, TV2).
 *
 * Tuần 1 chưa có lớp truy cập DynamoDB (1.7 của TV3, 2.2 của TV1), nên proxy đọc danh sách website
 * từ biến môi trường PROXY_SITES_JSON. Khi có DynamoDB, chỉ cần viết một SiteResolver khác:
 *   GetItem (đọc nhất quán) TENANT#PLATFORM#SLUG#<slug> -> tenantId, rồi BatchGetItem HOST + CONFIG.
 * Handler không phải sửa. Kết quả được lưu đệm trong bộ nhớ Lambda 60 giây (cachedSiteResolver).
 */

import { MAX_PAGE_CACHE_SECONDS } from '../../libs/common/seg.js';

export { MAX_PAGE_CACHE_SECONDS };

export type SiteStatus = 'PENDING' | 'ACTIVE' | 'PAUSED';
export type TenantStatus = 'ACTIVE' | 'LOCKED';

export interface SiteConfig {
  slug: string;
  tenantId: string;
  /** Trang chủ website gốc (bản ghi HOST), ví dụ https://homestay-abc.vn/ */
  homeUrl: string;
  /** Ngôn ngữ gốc, ví dụ "vi" */
  sourceLang: string;
  /** Ngôn ngữ đích đang bật, ví dụ ["en", "ko"] */
  targetLangs: string[];
  /** Bộ chọn CSS vùng không dịch (Q2) */
  exclusionSelectors?: string[];
  /**
   * Thời gian lưu đệm trang dịch đầy đủ ở CloudFront (giây). Mặc định DEFAULT_CACHE_SECONDS, tối đa
   * MAX_PAGE_CACHE_SECONDS (7 ngày) để luôn ngắn hơn TTL của SEG (30 ngày) – nếu không, SEG có thể hết hạn
   * trước cache và xóa cache chọn lọc sẽ sót trang.
   */
  cacheSeconds?: number;
  /** Trạng thái HOST */
  status: SiteStatus;
  /** Trạng thái tenant (CONFIG.status) */
  tenantStatus: TenantStatus;
}

export type SiteResolver = (slug: string) => Promise<SiteConfig | null>;

export const DEFAULT_CACHE_SECONDS = 3600;
export const SITE_CACHE_TTL_MS = 60_000;

/** slug: chữ thường, số, gạch nối; 1–63 ký tự; không bắt đầu/kết thúc bằng gạch nối (dùng được làm tên miền con). */
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** Mã ngôn ngữ ISO 639-1 (có thể kèm vùng), ví dụ en, ko, zh-TW */
export const LANG_RE = /^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/;

/** Kiểm tra và chuẩn hoá một cấu hình website. Ném lỗi kèm lý do nếu sai. */
export function validateSiteConfig(raw: unknown): SiteConfig {
  if (!raw || typeof raw !== 'object') throw new Error('Cấu hình website phải là object');
  const o = raw as Record<string, unknown>;
  const str = (k: string): string => {
    const v = o[k];
    if (typeof v !== 'string' || !v.trim()) throw new Error(`Thiếu trường ${k}`);
    return v.trim();
  };
  const slug = str('slug');
  if (!SLUG_RE.test(slug)) throw new Error(`slug không hợp lệ: ${slug}`);
  let home: URL;
  try {
    home = new URL(str('homeUrl'));
  } catch {
    throw new Error(`homeUrl không hợp lệ (${slug})`);
  }
  if (home.protocol !== 'http:' && home.protocol !== 'https:') throw new Error(`homeUrl phải là http/https (${slug})`);
  home.search = '';
  home.hash = '';
  if (!home.pathname.endsWith('/')) home.pathname += '/';

  const sourceLang = str('sourceLang');
  if (!LANG_RE.test(sourceLang)) throw new Error(`sourceLang không hợp lệ (${slug})`);
  const targetLangs = Array.isArray(o.targetLangs) ? o.targetLangs.filter((l): l is string => typeof l === 'string') : [];
  if (!targetLangs.length || !targetLangs.every((l) => LANG_RE.test(l))) throw new Error(`targetLangs không hợp lệ (${slug})`);

  const exclusionSelectors = Array.isArray(o.exclusionSelectors)
    ? o.exclusionSelectors.filter((s): s is string => typeof s === 'string' && s.trim() !== '')
    : [];
  const cacheSeconds = typeof o.cacheSeconds === 'number' && o.cacheSeconds > 0 ? Math.floor(o.cacheSeconds) : DEFAULT_CACHE_SECONDS;
  if (cacheSeconds > MAX_PAGE_CACHE_SECONDS) {
    throw new Error(`cacheSeconds tối đa ${MAX_PAGE_CACHE_SECONDS} giây (7 ngày), ngắn hơn TTL của chỉ mục SEG (${slug})`);
  }
  const status = (o.status ?? 'ACTIVE') as SiteStatus;
  if (!['PENDING', 'ACTIVE', 'PAUSED'].includes(status)) throw new Error(`status không hợp lệ (${slug})`);
  const tenantStatus = (o.tenantStatus ?? 'ACTIVE') as TenantStatus;
  if (!['ACTIVE', 'LOCKED'].includes(tenantStatus)) throw new Error(`tenantStatus không hợp lệ (${slug})`);

  return {
    slug,
    tenantId: str('tenantId'),
    homeUrl: home.href,
    sourceLang,
    targetLangs: [...new Set(targetLangs.filter((l) => l !== sourceLang))],
    exclusionSelectors,
    cacheSeconds,
    status,
    tenantStatus,
  };
}

/** Đọc PROXY_SITES_JSON: mảng cấu hình website. Ném lỗi nếu JSON hỏng hoặc trùng slug. */
export function parseSitesJson(json: string | undefined): SiteConfig[] {
  if (!json || !json.trim()) return [];
  const data: unknown = JSON.parse(json);
  if (!Array.isArray(data)) throw new Error('PROXY_SITES_JSON phải là một mảng');
  const sites = data.map(validateSiteConfig);
  const seen = new Set<string>();
  for (const s of sites) {
    if (seen.has(s.slug)) throw new Error(`slug bị trùng: ${s.slug}`);
    seen.add(s.slug);
  }
  return sites;
}

export function staticSiteResolver(sites: readonly SiteConfig[]): SiteResolver {
  const map = new Map(sites.map((s) => [s.slug, s]));
  return async (slug) => map.get(slug) ?? null;
}

/** Lưu đệm kết quả tra cứu (kể cả "không tìm thấy") trong bộ nhớ Lambda. */
export function cachedSiteResolver(inner: SiteResolver, ttlMs = SITE_CACHE_TTL_MS, now: () => number = Date.now): SiteResolver {
  const cache = new Map<string, { at: number; value: SiteConfig | null }>();
  return async (slug) => {
    const hit = cache.get(slug);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const value = await inner(slug);
    cache.set(slug, { at: now(), value });
    return value;
  };
}
