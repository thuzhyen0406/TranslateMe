/**
 * Kiểu dữ liệu màn Website (Q2, Nhiệm vụ 4.6 – TV2). JSON của API dùng snake_case (QC-1);
 * console đổi sang camelCase ở websiteApi.ts.
 */

export type WebsiteStatus = 'PENDING' | 'ACTIVE' | 'PAUSED';
export type VerifyMethod = 'META' | 'FILE';

/** Lý do xác minh thất bại (QC-2: VERIFICATION_FAILED.reason) */
export type VerificationFailureReason = 'UNREACHABLE' | 'TAG_OR_FILE_NOT_FOUND' | 'CODE_MISMATCH' | 'TOO_MANY_REDIRECTS';

export interface Website {
  slug: string;
  displayName: string;
  homeUrl: string;
  sourceLang: string;
  targetLangs: string[];
  status: WebsiteStatus;
  verificationCode: string;
  noTranslateSelectors: string[];
  createdAt: string;
}

export interface CreateWebsiteInput {
  homeUrl: string;
  displayName: string;
  sourceLang: string;
  targetLangs: string[];
  noTranslateSelectors: string[];
}

export type PrewarmStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';

export interface PrewarmWarning {
  code: string;
  where: string;
  count: number;
  message: string;
}

/** JOB dịch trước (GET /console/hosts/{slug}/prewarm, 4.5) */
export interface PrewarmJob {
  jobId: string;
  status: PrewarmStatus;
  /** 0–100, theo số trang (URL × ngôn ngữ) đã xong */
  progress: number;
  total: number;
  done: number;
  failed: number;
  warnings: PrewarmWarning[];
  reason?: string;
}

export interface LanguageOption {
  code: string;
  label: string;
}
