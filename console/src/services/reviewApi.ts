/**
 * Dịch vụ màn Duyệt bản dịch hai cột song ngữ (Q4, Nhiệm vụ 4.10 – TV4).
 * Kết nối trực tiếp với dịch vụ F5 (Task 3.8 – services/api/review/reviewManager.ts) và Bảng 2.9 / Bảng 2.10 của báo cáo.
 *
 * Hỗ trợ hai chế độ chạy giống màn Website (4.6) và xác thực (2.9):
 *  - createHttpReviewApi: gọi REST API F5 (/console/translations, /console/invalidations/...) kèm Authorization: Bearer <idToken> (khi VITE_AUTH_MODE=cognito);
 *  - createMockReviewApi: giả lập đầy đủ trong trình duyệt (khi VITE_AUTH_MODE=mock), hỗ trợ kiểm thử trực quan
 *    cả 3 thao tác duyệt, lỗi PLACEHOLDER_MISMATCH, xung đột 409 VERSION_CONFLICT kèm bản mới nhất,
 *    trạng thái làm mới cache CloudFront (Đang làm mới -> Đã làm mới / Lỗi làm mới một phần / Lỗi làm mới + Thử lại) và câu "Không còn sử dụng".
 */
import type {
  GlossaryWarningItem,
  InvalidationOutcome,
  InvalidationStatusResponse,
  ListReviewFilter,
  ListReviewResponse,
  PlaceholderCheckResult,
  ReviewApiTab,
  ReviewLabelFilter,
  ReviewMutationResponse,
  ReviewSentenceItem,
  ReviewTabCursors,
  TranslationStatus,
} from '../types/review.js';

// ============================================================================
// Hằng số ngôn ngữ & nhãn hiển thị
// ============================================================================

export interface ReviewSiteOption {
  slug: string;
  displayName: string;
  sourceLang: string;
  targetLangs: string[];
  pages: string[];
}

export const LANGUAGE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  vi: 'Tiếng Việt',
  en: 'Tiếng Anh (en)',
  ko: 'Tiếng Hàn (ko)',
  ja: 'Tiếng Nhật (ja)',
  zh: 'Tiếng Trung (zh)',
  fr: 'Tiếng Pháp (fr)',
});

export const REVIEW_FILTER_LABELS: Readonly<Record<ReviewLabelFilter, string>> = Object.freeze({
  ALL: 'Tất cả nhãn',
  MACHINE: 'Máy dịch',
  HUMAN: 'Đã duyệt',
  NEEDS_REVIEW: 'Cần xem lại',
});

// ============================================================================
// Lớp lỗi ReviewApiError (Bảng 2.10: PLACEHOLDER_MISMATCH, VERSION_CONFLICT...)
// ============================================================================

export class ReviewApiError extends Error {
  public missing?: string[];
  public extra?: string[];
  public latest?: ReviewSentenceItem;

  constructor(
    public code: string,
    message: string,
    opts?: {
      missing?: string[];
      extra?: string[];
      latest?: ReviewSentenceItem;
    },
  ) {
    super(message);
    this.name = 'ReviewApiError';
    if (opts?.missing) this.missing = opts.missing;
    if (opts?.extra) this.extra = opts.extra;
    if (opts?.latest) this.latest = opts.latest;
  }
}

// ============================================================================
// Kiểm tra ký hiệu định dạng nội tuyến {n}, {/n}, {n/}
// ============================================================================

const PLACEHOLDER_TOKEN_RE = /\{\/?\d+\/?\}/g;

/**
 * Trích xuất danh sách ký hiệu giữ chỗ {0}, {1}, {/1}, {1/} trong câu.
 * Bỏ qua ngoặc nhọn thoát {{ và }} giống quy ước của markers.ts và reviewManager.ts (Task 3.8).
 */
export function extractPlaceholderTokens(text: string): string[] {
  const withoutEscapedBraces = text.replace(/\{\{|\}\}/g, '');
  const matches = withoutEscapedBraces.match(PLACEHOLDER_TOKEN_RE);
  return matches ? [...matches] : [];
}

/**
 * Kiểm tra bảo toàn ký hiệu {n} giữa câu gốc và bản sửa của Reviewer (Mục 1.3.4 & Bảng 2.10 PLACEHOLDER_MISMATCH).
 * Cho phép đảo vị trí các cặp {1}…{/1} và {2}…{/2} (ví dụ dịch sang tiếng Hàn/Nhật), nhưng bắt buộc:
 *  - Không thiếu hoặc thừa bất kỳ ký hiệu nào;
 *  - Mỗi cặp {n}…{/n} phải mở trước khi đóng và cân bằng.
 */
export function validatePlaceholders(sourceText: string, editedText: string): PlaceholderCheckResult {
  const srcTokens = extractPlaceholderTokens(sourceText);
  const tgtTokens = extractPlaceholderTokens(editedText);

  const srcCounts = new Map<string, number>();
  const tgtCounts = new Map<string, number>();
  for (const t of srcTokens) srcCounts.set(t, (srcCounts.get(t) ?? 0) + 1);
  for (const t of tgtTokens) tgtCounts.set(t, (tgtCounts.get(t) ?? 0) + 1);

  const missing: string[] = [];
  const extra: string[] = [];

  for (const [tok, count] of srcCounts) {
    const actual = tgtCounts.get(tok) ?? 0;
    for (let i = actual; i < count; i++) missing.push(tok);
  }
  for (const [tok, count] of tgtCounts) {
    const expected = srcCounts.get(tok) ?? 0;
    for (let i = expected; i < count; i++) extra.push(tok);
  }

  // Kiểm tra đóng trước khi mở (ví dụ {/1} đứng trước {1})
  if (missing.length === 0 && extra.length === 0) {
    const stack: string[] = [];
    for (const tok of tgtTokens) {
      if (tok.endsWith('/}')) continue; // {1/}
      if (tok.startsWith('{/')) {
        const id = tok.slice(2, -1);
        const top = stack.pop();
        if (top !== id) {
          missing.push(`{${id}} (đóng/mở lệch thứ tự với ${tok})`);
          break;
        }
      } else {
        const id = tok.slice(1, -1);
        stack.push(id);
      }
    }
  }

  return {
    ok: missing.length === 0 && extra.length === 0,
    missing,
    extra,
    requiredTokens: srcTokens,
  };
}

export function formatPlaceholderError(missing: readonly string[], extra: readonly string[]): string {
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`thiếu ký hiệu: ${missing.join(', ')}`);
  if (extra.length > 0) parts.push(`thừa ký hiệu: ${extra.join(', ')}`);
  const detail = parts.length > 0 ? ` (${parts.join('; ')})` : '';
  return `Bản dịch sửa không khớp ký hiệu định dạng {n} so với câu gốc${detail}. Vui lòng giữ nguyên các ký hiệu định dạng.`;
}

/** Thông báo tiếng Việt cho các mã lỗi của nhóm F5 (Bảng 2.10) */
export function reviewErrorMessage(err: unknown): string {
  if (!(err instanceof ReviewApiError)) {
    return 'Có lỗi tạm thời khi xử lý bản dịch, vui lòng thử lại.';
  }
  switch (err.code) {
    case 'PLACEHOLDER_MISMATCH':
      return formatPlaceholderError(err.missing ?? [], err.extra ?? []);
    case 'VERSION_CONFLICT':
      return 'Câu dịch này vừa được người khác cập nhật. Vui lòng xem bản mới nhất bên dưới trước khi quyết định lưu đè.';
    case 'PERMISSION_DENIED':
      return 'Chỉ Tenant Admin hoặc Reviewer đang hoạt động mới có quyền duyệt và chỉnh sửa bản dịch.';
    case 'TENANT_SUSPENDED':
      return 'Tổ chức đang bị tạm khóa (chế độ chỉ xem); không thể lưu hoặc duyệt bản dịch.';
    case 'UNAUTHORIZED':
      return 'Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại.';
    case 'NOT_FOUND':
      return 'Không tìm thấy bản dịch trong bộ nhớ dịch của tổ chức.';
    case 'INVALID_REQUEST':
      return err.message || 'Dữ liệu gửi lên chưa hợp lệ.';
    case 'NETWORK_ERROR':
      return 'Không kết nối được tới máy chủ, vui lòng kiểm tra mạng và thử lại.';
    default:
      return err.message || 'Có lỗi tạm thời, vui lòng thử lại.';
  }
}

// ============================================================================
// Chuyển đổi JSON (hỗ trợ cả schema F5 ReviewTranslationEntry lẫn snake_case Bảng 2.9)
// ============================================================================

type Json = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function reviewItemFromJson(raw: Json): ReviewSentenceItem {
  const statusRaw = str(raw.label ?? raw.status).trim().toUpperCase();
  const status: TranslationStatus = statusRaw === 'HUMAN' ? 'HUMAN' : 'MACHINE';
  const hasPageMetadata = Array.isArray(raw.pages);
  const pages = strs(raw.pages);
  const warningsRaw = Array.isArray(raw.glossary_warnings ?? raw.glossaryWarnings)
    ? ((raw.glossary_warnings ?? raw.glossaryWarnings) as Json[])
    : [];
  const glossaryWarnings: GlossaryWarningItem[] = warningsRaw.map((w) => ({
    sourceTerm: str(w.source_term ?? w.sourceTerm),
    expectedTarget: str(w.expected_target ?? w.expectedTarget),
    mode: str(w.mode) === 'KEEP' ? 'KEEP' : 'FIXED',
  }));
  const srcText = str(raw.sourceText ?? raw.source_text ?? raw.src_text ?? raw.srcText ?? raw.src);
  const tgtText = str(raw.tgt ?? raw.tgt_text ?? raw.tgtText);
  const machineText = str(raw.machineTgt ?? raw.machine_tgt ?? raw.machine_text ?? raw.machineText) || tgtText;
  const reviewerIdRaw = raw.updatedBy ?? raw.updated_by ?? raw.reviewer_id ?? raw.reviewerId;
  const reviewedAtRaw = raw.reviewed_at ?? raw.reviewedAt;

  return {
    hash: str(raw.hash),
    srcLang: str(raw.srcLang ?? raw.src_lang) || 'vi',
    tgtLang: str(raw.tgtLang ?? raw.tgt_lang) || 'en',
    srcText,
    tgtText,
    machineText,
    status,
    needsReview: Boolean(raw.needs_review ?? raw.needsReview),
    glossaryWarnings,
    version: num(raw.version, 1),
    glossaryVersion: num(raw.glossary_version ?? raw.glossaryVersion, 0),
    updatedAt: str(raw.updated_at ?? raw.updatedAt) || new Date().toISOString(),
    ...(typeof reviewerIdRaw === 'string' && reviewerIdRaw ? { reviewerId: reviewerIdRaw } : {}),
    ...(typeof reviewedAtRaw === 'string' && reviewedAtRaw ? { reviewedAt: reviewedAtRaw } : {}),
    pages,
    hasPageMetadata,
    unused: raw.unused !== undefined ? Boolean(raw.unused) : hasPageMetadata && pages.length === 0,
  };
}

export function invalidationFromJson(raw: Json | undefined): InvalidationOutcome {
  if (!raw || typeof raw !== 'object') {
    return {
      status: 'SKIPPED_NO_PAGES',
      mode: 'PATHS',
      paths: [],
      invalidationIds: [],
    };
  }
  const statusRaw = str(raw.status).trim().toUpperCase();
  let status: InvalidationOutcome['status'];
  if (statusRaw === 'SUBMITTED') {
    status = 'SUBMITTED';
  } else if (statusRaw === 'PARTIAL') {
    status = 'PARTIAL';
  } else if (statusRaw === 'FAILED') {
    status = 'FAILED';
  } else {
    status = 'SKIPPED_NO_PAGES';
  }
  const modeRaw = str(raw.mode).trim().toUpperCase();
  const mode: InvalidationOutcome['mode'] =
    modeRaw === 'WILDCARD' ? 'WILDCARD' : modeRaw === 'NONE' ? 'NONE' : 'PATHS';
  const paths = strs(raw.paths);
  const failedPaths = strs(raw.failed_paths ?? raw.failedPaths);
  const invalidationIds = strs(raw.invalidation_ids ?? raw.invalidationIds);
  const singleId = str(raw.invalidation_id ?? raw.invalidationId ?? raw.id) || invalidationIds[0];

  return {
    status,
    mode,
    paths,
    ...(failedPaths.length > 0 ? { failedPaths } : {}),
    ...(singleId ? { invalidationId: singleId } : {}),
    invalidationIds: invalidationIds.length > 0 ? invalidationIds : singleId ? [singleId] : [],
    ...(typeof raw.error === 'string' && raw.error ? { error: raw.error } : {}),
  };
}

/**
 * Chuẩn hóa trạng thái tiến độ xóa cache CloudFront không phân biệt hoa thường
 * (hỗ trợ cả 'COMPLETED' của F5 lẫn 'Completed' của CloudFront SDK).
 */
export function normalizeInvalidationPollStatus(rawStatus: unknown): 'InProgress' | 'Completed' | 'Failed' {
  const norm = str(rawStatus).trim().toUpperCase().replace(/[\s_-]+/g, '');
  if (norm === 'COMPLETED') return 'Completed';
  if (norm === 'FAILED') return 'Failed';
  return 'InProgress';
}

/**
 * Trích xuất danh sách tất cả các mã invalidation ID duy nhất từ InvalidationOutcome.
 */
export function extractInvalidationIds(invalidation?: Partial<InvalidationOutcome> | null): string[] {
  if (!invalidation) return [];
  const set = new Set<string>();
  if (Array.isArray(invalidation.invalidationIds)) {
    for (const id of invalidation.invalidationIds) {
      if (typeof id === 'string' && id.trim()) {
        set.add(id.trim());
      }
    }
  }
  if (typeof invalidation.invalidationId === 'string' && invalidation.invalidationId.trim()) {
    set.add(invalidation.invalidationId.trim());
  }
  return [...set];
}

export type BatchInvalidationStatus = 'InProgress' | 'Completed' | 'Failed';

export interface BatchInvalidationCheckResult {
  status: BatchInvalidationStatus;
  completedIds: string[];
  inProgressIds: string[];
  failedIds: string[];
}

export interface InvalidationStatusChecker {
  checkInvalidationStatus(
    invalidationId: string,
  ): Promise<{ status: unknown; invalidationId?: string }>;
}

/**
 * Thăm dò trạng thái cho một nhóm nhiều Invalidation ID.
 *  - Trả về 'Failed' nếu có bất kỳ ID nào thất bại;
 *  - Chỉ trả về 'Completed' khi tất cả các ID đều đã hoàn tất;
 *  - Trả về 'InProgress' nếu chưa có lỗi và vẫn còn ít nhất một ID đang chạy.
 */
export async function checkMultipleInvalidationsStatus(
  api: InvalidationStatusChecker,
  invalidationIds: readonly string[],
): Promise<BatchInvalidationCheckResult> {
  const uniqueIds = [...new Set(invalidationIds.filter((id) => typeof id === 'string' && id.trim()))];
  if (uniqueIds.length === 0) {
    return {
      status: 'Completed',
      completedIds: [],
      inProgressIds: [],
      failedIds: [],
    };
  }

  const results = await Promise.all(
    uniqueIds.map(async (id) => {
      try {
        const res = await api.checkInvalidationStatus(id);
        return {
          id,
          status: normalizeInvalidationPollStatus(res.status),
        };
      } catch {
        return {
          id,
          status: 'InProgress' as const,
        };
      }
    }),
  );

  const completedIds = results.filter((r) => r.status === 'Completed').map((r) => r.id);
  const failedIds = results.filter((r) => r.status === 'Failed').map((r) => r.id);
  const inProgressIds = results.filter((r) => r.status === 'InProgress').map((r) => r.id);

  let status: BatchInvalidationStatus = 'InProgress';
  if (failedIds.length > 0) {
    status = 'Failed';
  } else if (inProgressIds.length === 0) {
    status = 'Completed';
  }

  return { status, completedIds, inProgressIds, failedIds };
}

/**
 * Số lần polling tối đa cho một yêu cầu xóa cache CloudFront (~3.5 phút với khoảng cách thưa dần).
 */
export const MAX_INVALIDATION_POLL_ATTEMPTS = 25;

/**
 * Khoảng thời gian (ms) giữa các lần kiểm tra trạng thái xóa cache CloudFront:
 * - Lần 1..3: 3.000 ms (3 giây)
 * - Lần 4..8: 5.000 ms (5 giây)
 * - Lần 9..25: 10.000 ms (10 giây)
 */
export function getInvalidationPollIntervalMs(attempt: number): number {
  if (attempt <= 3) return 3000;
  if (attempt <= 8) return 5000;
  return 10000;
}

// ============================================================================
// Hỗ trợ phân trang theo từng tab F5 (cursor / nextTabCursors)
// ============================================================================

export const DEFAULT_REVIEW_PAGE_SIZE = 50;
export const REVIEW_API_TABS: readonly ReviewApiTab[] = Object.freeze(['REVIEW', 'MACHINE', 'HUMAN']);

/** Ánh xạ bộ lọc nhãn trên UI Q4 sang danh sách tab GSI3 trên backend F5 */
export function labelFilterToTabs(labelFilter?: ReviewLabelFilter): ReviewApiTab[] {
  if (labelFilter === 'NEEDS_REVIEW') return ['REVIEW'];
  if (labelFilter === 'MACHINE') return ['MACHINE'];
  if (labelFilter === 'HUMAN') return ['HUMAN'];
  return ['REVIEW', 'MACHINE', 'HUMAN'];
}

/** Kiểm tra xem còn ít nhất một tab vẫn có cursor để tải trang tiếp hay không */
export function hasMoreReviewPages(tabCursors?: ReviewTabCursors | null): boolean {
  if (!tabCursors) return false;
  return REVIEW_API_TABS.some((tab) => {
    const cur = tabCursors[tab];
    return typeof cur === 'string' && cur.trim().length > 0;
  });
}

/** Chuẩn hóa và lọc map cursor theo danh sách tab hợp lệ */
export function extractTabCursors(
  tabCursors: ReviewTabCursors | undefined | null,
  allowedTabs?: readonly ReviewApiTab[],
): ReviewTabCursors {
  if (!tabCursors) return {};
  const allowSet = allowedTabs ? new Set<ReviewApiTab>(allowedTabs) : null;
  const out: ReviewTabCursors = {};
  for (const tab of REVIEW_API_TABS) {
    if (allowSet && !allowSet.has(tab)) continue;
    const raw = tabCursors[tab];
    if (typeof raw === 'string' && raw.trim()) {
      out[tab] = raw.trim();
    }
  }
  return out;
}

/** Trích xuất bộ cursor trang tiếp theo từ kết quả listTranslations (hỗ trợ cả nextTabCursors và nextCursor đơn tab) */
export function extractResponseTabCursors(
  res: ListReviewResponse,
  labelFilter?: ReviewLabelFilter,
): ReviewTabCursors {
  if (res.hasMore === false) {
    return {};
  }
  const activeTabs = labelFilterToTabs(labelFilter);
  if (res.nextTabCursors !== undefined) {
    return extractTabCursors(res.nextTabCursors, activeTabs);
  }
  if (activeTabs.length === 1 && typeof res.nextCursor === 'string' && res.nextCursor.trim()) {
    return { [activeTabs[0]]: res.nextCursor.trim() };
  }
  return {};
}

/**
 * Gộp danh sách câu từ trang tiếp theo vào danh sách đã tải:
 * giữ nguyên thứ tự các câu hiện có, thêm câu mới vào cuối và khử trùng lặp theo hash.
 */
export function mergeReviewItems(
  existing: readonly ReviewSentenceItem[],
  incoming: readonly ReviewSentenceItem[],
): ReviewSentenceItem[] {
  const merged = [...existing];
  const indexByHash = new Map<string, number>();
  for (let i = 0; i < merged.length; i++) {
    const h = merged[i].hash;
    if (h && !indexByHash.has(h)) {
      indexByHash.set(h, i);
    }
  }
  for (const item of incoming) {
    if (!item.hash) continue;
    const idx = indexByHash.get(item.hash);
    if (idx === undefined) {
      indexByHash.set(item.hash, merged.length);
      merged.push(item);
    } else if (item.version > merged[idx].version) {
      merged[idx] = item;
    }
  }
  return merged;
}

// ============================================================================
// Giao diện ReviewApi
// ============================================================================

export interface ReviewApi {
  listSites?(): Promise<ReviewSiteOption[]>;
  listTranslations(filter: ListReviewFilter): Promise<ListReviewResponse>;
  getTranslation(srcLang: string, tgtLang: string, hash: string): Promise<ReviewSentenceItem>;
  acceptTranslation(input: {
    srcLang: string;
    tgtLang: string;
    hash: string;
    expectedVersion: number;
  }): Promise<ReviewMutationResponse>;
  saveAndPublishTranslation(input: {
    srcLang: string;
    tgtLang: string;
    hash: string;
    editedText: string;
    expectedVersion: number;
  }): Promise<ReviewMutationResponse>;
  restoreMachineTranslation(input: {
    srcLang: string;
    tgtLang: string;
    hash: string;
    expectedVersion: number;
  }): Promise<ReviewMutationResponse>;
  retryInvalidation(input: {
    srcLang: string;
    tgtLang: string;
    hash: string;
  }): Promise<InvalidationOutcome>;
  checkInvalidationStatus(invalidationId: string): Promise<InvalidationStatusResponse>;
}

// ============================================================================
// Bản gọi REST API thật (VITE_AUTH_MODE=cognito)
// ============================================================================

export interface HttpReviewApiOptions {
  baseUrl: string;
  getToken: () => string;
  fetchFn?: typeof fetch;
}

export function createHttpReviewApi(opts: HttpReviewApiOptions): ReviewApi {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const doFetch = opts.fetchFn ?? ((...a: Parameters<typeof fetch>) => fetch(...a));

  async function request(method: 'GET' | 'POST' | 'PUT', path: string, body?: Json): Promise<Json> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${opts.getToken()}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new ReviewApiError('NETWORK_ERROR', 'Không kết nối được tới máy chủ.');
    }

    let data: Json = {};
    try {
      data = (await res.json()) as Json;
    } catch {
      data = {};
    }

    if (!res.ok) {
      const errObj = (data.error ?? {}) as Json;
      const details = (errObj.details ?? data.details ?? {}) as Json;
      const code =
        str(errObj.code) ||
        (res.status === 401 ? 'UNAUTHORIZED' : res.status === 409 ? 'VERSION_CONFLICT' : 'INTERNAL_ERROR');
      const missing = strs(details.missing ?? errObj.missing);
      const extra = strs(details.extra ?? errObj.extra);
      const latestRaw = (details.currentEntry ??
        details.current_entry ??
        details.latest ??
        errObj.currentEntry ??
        errObj.latest) as Json | undefined;
      const latest = latestRaw && typeof latestRaw === 'object' ? reviewItemFromJson(latestRaw) : undefined;
      throw new ReviewApiError(code, str(errObj.message), {
        ...(missing.length > 0 ? { missing } : {}),
        ...(extra.length > 0 ? { extra } : {}),
        ...(latest ? { latest } : {}),
      });
    }

    return data;
  }

  return {
    async listTranslations(filter) {
      const baseTabs = labelFilterToTabs(filter.labelFilter);
      const isTabCursorMode = filter.tabCursors !== undefined;

      const requests: Array<{ tab: ReviewApiTab; cursor?: string }> = [];
      if (isTabCursorMode) {
        // Khi tải trang tiếp theo: chỉ gọi các tab vẫn còn cursor của riêng tab đó
        for (const tab of baseTabs) {
          const cur = filter.tabCursors?.[tab]?.trim();
          if (cur) {
            requests.push({ tab, cursor: cur });
          }
        }
        if (requests.length === 0) {
          return {
            items: [],
            nextTabCursors: {},
            hasMore: false,
          };
        }
      } else {
        const singleCursor = baseTabs.length === 1 ? filter.cursor?.trim() : undefined;
        for (const tab of baseTabs) {
          requests.push({
            tab,
            ...(singleCursor ? { cursor: singleCursor } : {}),
          });
        }
      }

      const pageResults = await Promise.all(
        requests.map(async ({ tab, cursor }) => {
          const q = new URLSearchParams();
          q.set('src', filter.srcLang);
          q.set('tgt', filter.tgtLang);
          q.set('tab', tab);
          if (filter.search?.trim()) q.set('search', filter.search.trim());
          if (filter.limit) q.set('limit', String(filter.limit));
          if (cursor) q.set('cursor', cursor);

          const data = await request('GET', `/console/translations?${q.toString()}`);
          const itemsRaw = Array.isArray(data.items) ? (data.items as Json[]) : [];
          const mapped = itemsRaw.map(reviewItemFromJson).filter((it) => Boolean(it.hash));
          const nextCur = str(data.next_cursor ?? data.nextCursor).trim();
          return { tab, mapped, nextCur };
        }),
      );

      const byHash = new Map<string, ReviewSentenceItem>();
      const nextTabCursors: ReviewTabCursors = {};

      for (const { tab, mapped, nextCur } of pageResults) {
        for (const item of mapped) {
          if (!byHash.has(item.hash)) {
            byHash.set(item.hash, item);
          }
        }
        if (nextCur) {
          nextTabCursors[tab] = nextCur;
        }
      }

      let items = [...byHash.values()];
      if (filter.pagePath) {
        if (filter.pagePath === '__UNUSED__') {
          items = items.filter((it) => it.unused);
        } else {
          items = items.filter((it) => it.pages.includes(filter.pagePath!));
        }
      }

      const hasMore = hasMoreReviewPages(nextTabCursors);
      const singleNextCursor = baseTabs.length === 1 ? nextTabCursors[baseTabs[0]] : undefined;

      return {
        items,
        ...(singleNextCursor ? { nextCursor: singleNextCursor } : {}),
        nextTabCursors,
        hasMore,
      };
    },

    async getTranslation(srcLang, tgtLang, hash) {
      let tabCursors: ReviewTabCursors | undefined;
      for (let page = 0; page < 20; page++) {
        const res = await this.listTranslations({
          srcLang,
          tgtLang,
          labelFilter: 'ALL',
          limit: 200,
          ...(tabCursors ? { tabCursors } : {}),
        });
        const found = res.items.find((it) => it.hash === hash);
        if (found) return found;
        if (!res.hasMore || !res.nextTabCursors || !hasMoreReviewPages(res.nextTabCursors)) {
          break;
        }
        const sameCursors =
          tabCursors !== undefined &&
          REVIEW_API_TABS.every((t) => (tabCursors?.[t] ?? '') === (res.nextTabCursors?.[t] ?? ''));
        if (sameCursors) {
          break;
        }
        tabCursors = res.nextTabCursors;
      }
      throw new ReviewApiError('NOT_FOUND', `Không tìm thấy bản dịch cho mã băm ${hash}`);
    },

    async acceptTranslation({ srcLang, tgtLang, hash, expectedVersion }) {
      const data = await request('POST', '/console/translations/accept', {
        src: srcLang,
        tgt: tgtLang,
        hash,
        expectedVersion,
        invalidateCache: false,
      });
      return {
        item: reviewItemFromJson((data.entry ?? data.item ?? data) as Json),
        invalidation: invalidationFromJson(data.invalidation as Json | undefined),
      };
    },

    async saveAndPublishTranslation({ srcLang, tgtLang, hash, editedText, expectedVersion }) {
      const data = await request('PUT', '/console/translations', {
        src: srcLang,
        tgt: tgtLang,
        hash,
        newTgt: editedText,
        expectedVersion,
      });
      return {
        item: reviewItemFromJson((data.entry ?? data.item ?? data) as Json),
        invalidation: invalidationFromJson(data.invalidation as Json | undefined),
      };
    },

    async restoreMachineTranslation({ srcLang, tgtLang, hash, expectedVersion }) {
      const data = await request('POST', '/console/translations/restore', {
        src: srcLang,
        tgt: tgtLang,
        hash,
        expectedVersion,
      });
      return {
        item: reviewItemFromJson((data.entry ?? data.item ?? data) as Json),
        invalidation: invalidationFromJson(data.invalidation as Json | undefined),
      };
    },

    async retryInvalidation({ srcLang, tgtLang, hash }) {
      const data = await request('POST', '/console/invalidations/retry', {
        src: srcLang,
        tgt: tgtLang,
        hashes: [hash],
      });
      return invalidationFromJson((data.invalidation ?? data) as Json);
    },

    async checkInvalidationStatus(invalidationId) {
      const data = await request(
        'GET',
        `/console/invalidations/${encodeURIComponent(invalidationId)}`,
      );
      return {
        invalidationId: str(data.id ?? data.invalidation_id ?? data.invalidationId) || invalidationId,
        status: normalizeInvalidationPollStatus(data.status),
      };
    },
  };
}

// ============================================================================
// Bản giả lập cho chế độ demo (VITE_AUTH_MODE=mock)
// ============================================================================

export const DEMO_REVIEW_SITES: readonly ReviewSiteOption[] = Object.freeze([
  {
    slug: 'homestay-abc',
    displayName: 'Homestay ABC Hội An',
    sourceLang: 'vi',
    targetLangs: ['en', 'ko', 'ja'],
    pages: [
      '/homestay-abc/en/',
      '/homestay-abc/en/phong-nghi',
      '/homestay-abc/en/bang-gia',
      '/homestay-abc/en/lien-he',
      '/homestay-abc/ko/',
      '/homestay-abc/ko/phong-nghi',
      '/homestay-abc/ja/',
    ],
  },
]);

const INITIAL_MOCK_ITEMS: readonly ReviewSentenceItem[] = Object.freeze([
  {
    hash: 'a101f8c3e9d24b71a09123c4e5f60001a101f8c3e9d24b71a09123c4e5f60001',
    srcLang: 'vi',
    tgtLang: 'en',
    srcText: 'Chào mừng quý khách đến với {1}Homestay ABC{/1} bên bờ sông Thu Bồn.',
    tgtText: 'Welcome to {1}ABC Homestay{/1} by the Thu Bon river.',
    machineText: 'Welcome to {1}ABC Homestay{/1} by the Thu Bon river.',
    status: 'MACHINE',
    needsReview: true,
    glossaryWarnings: [
      {
        sourceTerm: 'Homestay ABC',
        expectedTarget: 'Homestay ABC',
        mode: 'KEEP',
      },
    ],
    version: 1,
    glossaryVersion: 2,
    updatedAt: '2026-10-28T08:15:00.000Z',
    pages: ['/homestay-abc/en/', '/homestay-abc/en/lien-he'],
    hasPageMetadata: true,
    unused: false,
  },
  {
    hash: 'b202f8c3e9d24b71a09123c4e5f60002b202f8c3e9d24b71a09123c4e5f60002',
    srcLang: 'vi',
    tgtLang: 'en',
    srcText: 'Phòng có {1}ban công{/1} nhìn ra vườn dừa, xem {2}bảng giá ưu đãi{/2} mùa hè.',
    tgtText: 'The room features a {1}balcony{/1} overlooking the coconut garden, see {2}summer special rates{/2}.',
    machineText: 'Room has {1}balcony{/1} looking to coconut garden, see {2}discount price list{/2} summer.',
    status: 'HUMAN',
    needsReview: false,
    glossaryWarnings: [],
    version: 3,
    glossaryVersion: 2,
    updatedAt: '2026-10-29T10:30:00.000Z',
    reviewerId: 'minh@homestay-abc.vn',
    reviewedAt: '2026-10-29T10:30:00.000Z',
    pages: ['/homestay-abc/en/', '/homestay-abc/en/phong-nghi', '/homestay-abc/en/bang-gia'],
    hasPageMetadata: true,
    unused: false,
  },
  {
    hash: 'c303f8c3e9d24b71a09123c4e5f60003c303f8c3e9d24b71a09123c4e5f60003',
    srcLang: 'vi',
    tgtLang: 'en',
    srcText: 'Chỉ cách Phố cổ Hội An 5 phút đi xe đạp miễn phí của homestay.',
    tgtText: 'Only 5 minutes by free bicycle from the homestay to Hoi An Old Quarter.',
    machineText: 'Only 5 minutes by free bicycle from the homestay to Hoi An Old Quarter.',
    status: 'HUMAN',
    needsReview: true,
    glossaryWarnings: [
      {
        sourceTerm: 'Phố cổ Hội An',
        expectedTarget: 'Hoi An Ancient Town',
        mode: 'FIXED',
      },
    ],
    version: 2,
    glossaryVersion: 1,
    updatedAt: '2026-10-27T14:20:00.000Z',
    reviewerId: 'lan@homestay-abc.vn',
    reviewedAt: '2026-10-27T14:20:00.000Z',
    pages: ['/homestay-abc/en/', '/homestay-abc/en/phong-nghi'],
    hasPageMetadata: true,
    unused: false,
  },
  {
    hash: 'd404f8c3e9d24b71a09123c4e5f60004d404f8c3e9d24b71a09123c4e5f60004',
    srcLang: 'vi',
    tgtLang: 'en',
    srcText: 'Giá phòng đã bao gồm bữa sáng truyền thống và trà thảo mộc chào mừng.',
    tgtText: 'Room rates include traditional breakfast and welcome herbal tea.',
    machineText: 'Room rates include traditional breakfast and welcome herbal tea.',
    status: 'MACHINE',
    needsReview: false,
    glossaryWarnings: [],
    version: 1,
    glossaryVersion: 2,
    updatedAt: '2026-10-28T09:00:00.000Z',
    pages: ['/homestay-abc/en/bang-gia'],
    hasPageMetadata: true,
    unused: false,
  },
  {
    hash: 'e505f8c3e9d24b71a09123c4e5f60005e505f8c3e9d24b71a09123c4e5f60005',
    srcLang: 'vi',
    tgtLang: 'en',
    srcText: 'Chương trình khuyến mãi Tết Giáp Thìn đã kết thúc.',
    tgtText: 'The Lunar New Year promotion has ended.',
    machineText: 'The Lunar New Year promotion has ended.',
    status: 'MACHINE',
    needsReview: false,
    glossaryWarnings: [],
    version: 1,
    glossaryVersion: 2,
    updatedAt: '2026-10-15T12:00:00.000Z',
    pages: [],
    hasPageMetadata: true,
    unused: true,
  },
  {
    hash: 'f606f8c3e9d24b71a09123c4e5f60006f606f8c3e9d24b71a09123c4e5f60006',
    srcLang: 'vi',
    tgtLang: 'ko',
    srcText: 'Phòng có {1}ban công{/1} nhìn ra vườn dừa, xem {2}bảng giá ưu đãi{/2} mùa hè.',
    tgtText: '객실에는 코코넛 정원이 보이는 {1}발코니{/1}가 있으며, 여름 {2}특별 요금표{/2}를 확인하세요.',
    machineText: '객실에는 코코넛 정원이 보이는 {1}발코니{/1}가 있으며, 여름 {2}특별 요금표{/2}를 확인하세요.',
    status: 'MACHINE',
    needsReview: false,
    glossaryWarnings: [],
    version: 1,
    glossaryVersion: 2,
    updatedAt: '2026-10-28T11:00:00.000Z',
    pages: ['/homestay-abc/ko/', '/homestay-abc/ko/phong-nghi'],
    hasPageMetadata: true,
    unused: false,
  },
  {
    hash: '9707f8c3e9d24b71a09123c4e5f600079707f8c3e9d24b71a09123c4e5f60007',
    srcLang: 'vi',
    tgtLang: 'ja',
    srcText: 'Chào mừng quý khách đến với {1}Homestay ABC{/1} bên bờ sông Thu Bồn.',
    tgtText: 'トゥボン川沿いの{1}Homestay ABC{/1}へようこそ。',
    machineText: 'トゥボン川沿いの{1}Homestay ABC{/1}へようこそ。',
    status: 'HUMAN',
    needsReview: false,
    glossaryWarnings: [],
    version: 2,
    glossaryVersion: 2,
    updatedAt: '2026-10-29T07:45:00.000Z',
    reviewerId: 'minh@homestay-abc.vn',
    reviewedAt: '2026-10-29T07:45:00.000Z',
    pages: ['/homestay-abc/ja/'],
    hasPageMetadata: true,
    unused: false,
  },
]);

export interface MockReviewApiOptions {
  reviewerEmail?: string;
  now?: () => string;
  /** Bật sẵn chế độ giả lập lỗi CloudFront khi xóa cache */
  simulateCdnFailure?: boolean;
  /** Danh sách câu dịch khởi tạo tùy chọn để kiểm thử phân trang nhiều trang */
  initialItems?: readonly ReviewSentenceItem[];
}

export interface MockReviewApi extends ReviewApi {
  /** Giả lập một Reviewer khác vừa sửa câu này trên máy chủ (để test 409 VERSION_CONFLICT) */
  simulateConcurrentEdit(srcLang: string, tgtLang: string, hash: string, newText?: string): ReviewSentenceItem;
  /** Bật/tắt giả lập lỗi làm mới bộ nhớ đệm CloudFront */
  setSimulateCdnFailure(enabled: boolean): void;
  getSimulateCdnFailure(): boolean;
}

function recomputeGlossaryWarnings(
  tgtText: string,
  existingWarnings: readonly GlossaryWarningItem[],
): GlossaryWarningItem[] {
  const normTgt = tgtText.normalize('NFC').toLowerCase();
  return existingWarnings.filter((w) => !normTgt.includes(w.expectedTarget.normalize('NFC').toLowerCase()));
}

export function createMockReviewApi(opts: MockReviewApiOptions = {}): MockReviewApi {
  const store = new Map<string, ReviewSentenceItem>();
  const invalidationPolls = new Map<string, number>();
  const now = opts.now ?? (() => new Date().toISOString());
  const reviewer = opts.reviewerEmail ?? 'reviewer@homestay-abc.vn';
  let simulateCdnFailure = opts.simulateCdnFailure ?? false;
  let invSeq = 100;

  const keyOf = (src: string, tgt: string, hash: string) => `${src}#${tgt}#${hash}`;

  const seedItems = opts.initialItems ?? INITIAL_MOCK_ITEMS;
  for (const item of seedItems) {
    store.set(keyOf(item.srcLang, item.tgtLang, item.hash), {
      ...item,
      glossaryWarnings: item.glossaryWarnings.map((w) => ({ ...w })),
      pages: [...item.pages],
      hasPageMetadata: item.hasPageMetadata ?? true,
    });
  }

  function getOrThrow(src: string, tgt: string, hash: string): ReviewSentenceItem {
    const found = store.get(keyOf(src, tgt, hash));
    if (!found) {
      throw new ReviewApiError('NOT_FOUND', `Không tìm thấy bản dịch cho mã băm ${hash}`);
    }
    return found;
  }

  function buildInvalidationOutcome(item: ReviewSentenceItem): InvalidationOutcome {
    if (item.pages.length === 0) {
      return {
        status: 'SKIPPED_NO_PAGES',
        mode: 'PATHS',
        paths: [],
        invalidationIds: [],
      };
    }
    const mode = item.pages.length > 15 ? 'WILDCARD' : 'PATHS';
    if (simulateCdnFailure) {
      return {
        status: 'FAILED',
        mode,
        paths: [...item.pages],
        invalidationIds: [],
        error: 'CloudFront ThrottlingException: Rate exceeded',
      };
    }
    const invalidationId = `I-CF-${++invSeq}`;
    invalidationPolls.set(invalidationId, 0);
    return {
      status: 'SUBMITTED',
      mode,
      paths: [...item.pages],
      invalidationId,
      invalidationIds: [invalidationId],
    };
  }

  return {
    async listSites() {
      return DEMO_REVIEW_SITES.map((s) => ({
        ...s,
        targetLangs: [...s.targetLangs],
        pages: [...s.pages],
      }));
    },

    async listTranslations(filter) {
      let baseItems = [...store.values()].filter(
        (it) => it.srcLang === filter.srcLang && it.tgtLang === filter.tgtLang,
      );

      if (filter.slug) {
        const prefix = `/${filter.slug}/`;
        baseItems = baseItems.filter(
          (it) => it.pages.length === 0 || it.pages.some((p) => p.startsWith(prefix)),
        );
      }

      if (filter.pagePath) {
        if (filter.pagePath === '__UNUSED__') {
          baseItems = baseItems.filter((it) => it.pages.length === 0);
        } else {
          baseItems = baseItems.filter((it) => it.pages.includes(filter.pagePath!));
        }
      }

      if (filter.search?.trim()) {
        const kw = filter.search.trim().normalize('NFC').toLowerCase();
        baseItems = baseItems.filter(
          (it) =>
            it.srcText.normalize('NFC').toLowerCase().includes(kw) ||
            it.tgtText.normalize('NFC').toLowerCase().includes(kw),
        );
      }

      const baseTabs = labelFilterToTabs(filter.labelFilter);
      const limit =
        filter.limit && Number.isFinite(filter.limit) && filter.limit > 0
          ? Math.min(Math.floor(filter.limit), 200)
          : DEFAULT_REVIEW_PAGE_SIZE;

      const parseOffset = (cursor?: string): number => {
        if (!cursor) return 0;
        const trimmed = cursor.trim();
        const raw = trimmed.startsWith('offset:') ? trimmed.slice('offset:'.length) : trimmed;
        const parsed = Number(raw);
        return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
      };

      const isTabCursorMode = filter.tabCursors !== undefined;
      const requests: Array<{ tab: ReviewApiTab; offset: number }> = [];
      if (isTabCursorMode) {
        for (const tab of baseTabs) {
          const cur = filter.tabCursors?.[tab]?.trim();
          if (cur) {
            requests.push({ tab, offset: parseOffset(cur) });
          }
        }
        if (requests.length === 0) {
          return { items: [], nextTabCursors: {}, hasMore: false };
        }
      } else {
        const singleOffset = baseTabs.length === 1 ? parseOffset(filter.cursor) : 0;
        for (const tab of baseTabs) {
          requests.push({ tab, offset: singleOffset });
        }
      }

      const singleTabMode = baseTabs.length === 1;
      const matchesTab = (it: ReviewSentenceItem, tab: ReviewApiTab): boolean => {
        if (singleTabMode) {
          if (tab === 'REVIEW') return it.needsReview;
          if (tab === 'MACHINE') return it.status === 'MACHINE';
          return it.status === 'HUMAN';
        }
        const ownedTab: ReviewApiTab = it.needsReview
          ? 'REVIEW'
          : it.status === 'HUMAN'
            ? 'HUMAN'
            : 'MACHINE';
        return ownedTab === tab;
      };

      const chosen = new Set<ReviewSentenceItem>();
      const slicedInTabOrder: ReviewSentenceItem[] = [];
      const nextTabCursors: ReviewTabCursors = {};

      for (const { tab, offset } of requests) {
        const tabItems = baseItems.filter((it) => matchesTab(it, tab));
        const slice = tabItems.slice(offset, offset + limit);
        for (const it of slice) {
          chosen.add(it);
          slicedInTabOrder.push(it);
        }
        if (offset + limit < tabItems.length) {
          nextTabCursors[tab] = `offset:${offset + limit}`;
        }
      }

      const orderedItems =
        requests.length <= 1 ? slicedInTabOrder : baseItems.filter((it) => chosen.has(it));
      const hasMore = hasMoreReviewPages(nextTabCursors);
      const singleNextCursor = singleTabMode ? nextTabCursors[baseTabs[0]] : undefined;

      return {
        items: orderedItems.map((it) => ({
          ...it,
          glossaryWarnings: it.glossaryWarnings.map((w) => ({ ...w })),
          pages: [...it.pages],
        })),
        ...(singleNextCursor ? { nextCursor: singleNextCursor } : {}),
        nextTabCursors,
        hasMore,
      };
    },

    async getTranslation(srcLang, tgtLang, hash) {
      const it = getOrThrow(srcLang, tgtLang, hash);
      return {
        ...it,
        glossaryWarnings: it.glossaryWarnings.map((w) => ({ ...w })),
        pages: [...it.pages],
      };
    },

    async acceptTranslation({ srcLang, tgtLang, hash, expectedVersion }) {
      const current = getOrThrow(srcLang, tgtLang, hash);
      if (current.version !== expectedVersion) {
        throw new ReviewApiError('VERSION_CONFLICT', 'Câu dịch đã được người khác cập nhật.', {
          latest: { ...current, pages: [...current.pages] },
        });
      }
      const ts = now();
      const updated: ReviewSentenceItem = {
        ...current,
        status: 'HUMAN',
        needsReview: false,
        glossaryWarnings: [],
        version: current.version + 1,
        updatedAt: ts,
        reviewerId: reviewer,
        reviewedAt: ts,
      };
      store.set(keyOf(srcLang, tgtLang, hash), updated);
      return {
        item: { ...updated, pages: [...updated.pages] },
        invalidation: {
          status: 'SKIPPED_NO_PAGES',
          mode: 'PATHS',
          paths: [],
          invalidationIds: [],
        },
      };
    },

    async saveAndPublishTranslation({ srcLang, tgtLang, hash, editedText, expectedVersion }) {
      const trimmed = editedText.trim();
      if (!trimmed) {
        throw new ReviewApiError('INVALID_REQUEST', 'Nội dung bản dịch không được để trống.');
      }
      const current = getOrThrow(srcLang, tgtLang, hash);
      const check = validatePlaceholders(current.srcText, trimmed);
      if (!check.ok) {
        throw new ReviewApiError(
          'PLACEHOLDER_MISMATCH',
          formatPlaceholderError(check.missing, check.extra),
          { missing: check.missing, extra: check.extra },
        );
      }
      if (current.version !== expectedVersion) {
        throw new ReviewApiError('VERSION_CONFLICT', 'Câu dịch đã được người khác cập nhật.', {
          latest: { ...current, pages: [...current.pages] },
        });
      }

      const ts = now();
      const remainingWarnings = recomputeGlossaryWarnings(trimmed, current.glossaryWarnings);
      const updated: ReviewSentenceItem = {
        ...current,
        tgtText: trimmed,
        status: 'HUMAN',
        needsReview: false,
        glossaryWarnings: remainingWarnings,
        version: current.version + 1,
        updatedAt: ts,
        reviewerId: reviewer,
        reviewedAt: ts,
      };
      store.set(keyOf(srcLang, tgtLang, hash), updated);

      return {
        item: { ...updated, pages: [...updated.pages] },
        invalidation: buildInvalidationOutcome(updated),
      };
    },

    async restoreMachineTranslation({ srcLang, tgtLang, hash, expectedVersion }) {
      const current = getOrThrow(srcLang, tgtLang, hash);
      if (current.version !== expectedVersion) {
        throw new ReviewApiError('VERSION_CONFLICT', 'Câu dịch đã được người khác cập nhật.', {
          latest: { ...current, pages: [...current.pages] },
        });
      }
      const ts = now();
      const updated: ReviewSentenceItem = {
        ...current,
        tgtText: current.machineText,
        status: 'MACHINE',
        needsReview: current.glossaryWarnings.length > 0,
        version: current.version + 1,
        updatedAt: ts,
        reviewerId: reviewer,
        reviewedAt: ts,
      };
      store.set(keyOf(srcLang, tgtLang, hash), updated);

      return {
        item: { ...updated, pages: [...updated.pages] },
        invalidation: buildInvalidationOutcome(updated),
      };
    },

    async retryInvalidation({ srcLang, tgtLang, hash }) {
      const current = getOrThrow(srcLang, tgtLang, hash);
      return buildInvalidationOutcome(current);
    },

    async checkInvalidationStatus(invalidationId) {
      const count = (invalidationPolls.get(invalidationId) ?? 0) + 1;
      invalidationPolls.set(invalidationId, count);
      return {
        invalidationId,
        status: count >= 2 ? 'Completed' : 'InProgress',
      };
    },

    simulateConcurrentEdit(srcLang, tgtLang, hash, newText) {
      const current = getOrThrow(srcLang, tgtLang, hash);
      const ts = now();
      const updated: ReviewSentenceItem = {
        ...current,
        tgtText:
          newText ??
          `${current.tgtText} (đã được lan@homestay-abc.vn hiệu đính ở v${current.version + 1})`,
        status: 'HUMAN',
        needsReview: false,
        version: current.version + 1,
        updatedAt: ts,
        reviewerId: 'lan@homestay-abc.vn',
        reviewedAt: ts,
      };
      store.set(keyOf(srcLang, tgtLang, hash), updated);
      return { ...updated, pages: [...updated.pages] };
    },

    setSimulateCdnFailure(enabled) {
      simulateCdnFailure = enabled;
    },

    getSimulateCdnFailure() {
      return simulateCdnFailure;
    },
  };
}
