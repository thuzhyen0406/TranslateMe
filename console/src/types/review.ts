/**
 * Kiểu dữ liệu màn Duyệt bản dịch hai cột song ngữ (Q4, Nhiệm vụ 4.10 – TV4).
 * Kết nối với dịch vụ F5 (Task 3.8 – services/api/review/reviewManager.ts) và Bảng 2.9 / Bảng 2.10 của báo cáo.
 * JSON của REST API dùng snake_case (QC-1); reviewApi.ts hỗ trợ ánh xạ cả snake_case lẫn camelCase.
 */

export type TranslationStatus = 'MACHINE' | 'HUMAN';

/** Bộ lọc theo nhãn trên giao diện Q4 (Mục 1.3.4 bước 2) */
export type ReviewLabelFilter = 'ALL' | 'MACHINE' | 'HUMAN' | 'NEEDS_REVIEW';

/** Trạng thái làm mới bộ nhớ đệm CloudFront sau khi sửa bản dịch (Mục 1.3.4 bước 6) */
export type CacheRefreshState = 'IDLE' | 'NOT_USED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';

export interface GlossaryWarningItem {
  sourceTerm: string;
  expectedTarget: string;
  mode: 'KEEP' | 'FIXED';
}

export interface ReviewSentenceItem {
  hash: string;
  srcLang: string;
  tgtLang: string;
  /** Câu gốc (có thể chứa ký hiệu nội tuyến {1}…{/1}) */
  srcText: string;
  /** Bản dịch hiện đang áp dụng */
  tgtText: string;
  /** Bản dịch máy gốc để khôi phục khi cần (F5.3) */
  machineText: string;
  status: TranslationStatus;
  /** Nhãn "Cần xem lại": câu MACHINE thiếu thuật ngữ đích hoặc câu HUMAN có thuật ngữ vừa đổi */
  needsReview: boolean;
  glossaryWarnings: GlossaryWarningItem[];
  /** Số phiên bản khóa lạc quan (Optimistic Locking) */
  version: number;
  glossaryVersion: number;
  updatedAt: string;
  reviewerId?: string;
  reviewedAt?: string;
  /** Danh sách đường dẫn trang chứa câu này (ví dụ ["/homestay-abc/en/", "/homestay-abc/en/phong-nghi"]) */
  pages: string[];
  /** Câu không còn xuất hiện trên trang nào (pages.length === 0) -> hiển thị "Không còn sử dụng" */
  unused: boolean;
}

export interface InvalidationOutcome {
  /** SUBMITTED | SKIPPED_NO_PAGES | FAILED */
  status: 'SUBMITTED' | 'SKIPPED_NO_PAGES' | 'FAILED';
  mode: 'PATHS' | 'WILDCARD';
  paths: string[];
  invalidationId?: string;
  invalidationIds: string[];
  error?: string;
}

export interface ReviewMutationResponse {
  item: ReviewSentenceItem;
  invalidation: InvalidationOutcome;
}

export interface InvalidationStatusResponse {
  invalidationId: string;
  /** InProgress | Completed */
  status: 'InProgress' | 'Completed';
}

export interface ListReviewFilter {
  slug?: string;
  srcLang: string;
  tgtLang: string;
  pagePath?: string;
  labelFilter?: ReviewLabelFilter;
  search?: string;
  cursor?: string;
  limit?: number;
}

export interface ListReviewResponse {
  items: ReviewSentenceItem[];
  nextCursor?: string;
}

export interface PlaceholderCheckResult {
  ok: boolean;
  missing: string[];
  extra: string[];
  requiredTokens: string[];
}
