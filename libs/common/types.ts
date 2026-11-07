export type Lang = string;
export type Sha256Hex = string;
export type Role = 'TENANT_ADMIN' | 'DEVELOPER' | 'REVIEWER';

export interface Ctx {
  tenantId: string;
  via: 'JWT' | 'SLUG' | 'KEYMAP';
  requestId: string;
  /** Cognito sub lấy từ JWT đã được authorizer xác thực; dùng đối chiếu MEMBER hiện hành. */
  sub?: string;
  role?: Role;
  slug?: string;
  keyId?: string;
}

export type ErrorCode =
  | 'FORBIDDEN'
  | 'PERMISSION_DENIED'
  | 'UNAUTHORIZED'
  | 'RATE_LIMITED'
  | 'REQUEST_QUOTA_EXCEEDED'
  | 'CHAR_QUOTA_EXCEEDED'
  | 'FILE_NOT_UPLOADED'
  | 'SITE_UNREACHABLE'
  | 'VERIFICATION_NOT_FOUND'
  | 'VERIFICATION_CODE_MISMATCH'
  | 'TOO_MANY_REDIRECTS'
  | 'DUPLICATE_SLUG'
  | 'TENANT_SUSPENDED'
  | 'INVALID_REQUEST'
  | 'PLACEHOLDER_MISMATCH'
  | 'UNSUPPORTED_LANGUAGE'
  | 'NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'CACHE_INVALIDATION_FAILED'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  constructor(public code: ErrorCode, message: string, public details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
  }
}

export const keys = {
  config: (ctx: Ctx) => ({ PK: `TENANT#${ctx.tenantId}`, SK: 'CONFIG' }),
  member: (ctx: Ctx, sub: string) => ({ PK: `TENANT#${ctx.tenantId}`, SK: `MEMBER#${sub}` }),
  host: (ctx: Ctx, slug: string) => ({ PK: `TENANT#${ctx.tenantId}`, SK: `HOST#${slug}` }),
  gloss: (ctx: Ctx, normalized: string) => ({ PK: `TENANT#${ctx.tenantId}#GLOSS`, SK: `TERM#${normalized}` }),
  apiKey: (ctx: Ctx, keyId: string) => ({ PK: `TENANT#${ctx.tenantId}#APIKEY`, SK: `KEY#${keyId}` }),
  job: (ctx: Ctx, jobId: string) => ({ PK: `TENANT#${ctx.tenantId}#JOB`, SK: `JOB#${jobId}` }),
  batchUpload: (ctx: Ctx, uploadId: string) => ({ PK: `TENANT#${ctx.tenantId}#JOB`, SK: `UPLOAD#${uploadId}` }),
  tm: (ctx: Ctx, src: Lang, tgt: Lang, hash: Sha256Hex) => ({ PK: `TENANT#${ctx.tenantId}#TM#${src}#${tgt}`, SK: `HASH#${hash}` }),
  // Các khóa nền tảng chỉ sử dụng bởi module quản lý website và resolver
  slug: (slug: string) => ({ PK: `TENANT#PLATFORM#SLUG#${slug}`, SK: 'META' }),
  keymap: (keyId: string) => ({ PK: `TENANT#PLATFORM#KEY#${keyId}`, SK: 'META' }),
};
