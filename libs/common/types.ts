export type Lang = string;
export type Sha256Hex = string;
export type Role = 'TENANT_ADMIN' | 'DEVELOPER' | 'REVIEWER';

export interface Ctx {
  tenantId: string;
  via: 'JWT' | 'SLUG' | 'KEYMAP';
  requestId: string;
  role?: Role;
  slug?: string;
  keyId?: string;
}

export type ErrorCode = 
  | 'FORBIDDEN'
  | 'UNAUTHORIZED'
  | 'RATE_LIMITED'
  | 'REQUEST_QUOTA_EXCEEDED'
  | 'SITE_UNREACHABLE'
  | 'VERIFICATION_NOT_FOUND'
  | 'VERIFICATION_CODE_MISMATCH'
  | 'TOO_MANY_REDIRECTS'
  | 'DUPLICATE_SLUG'
  | 'TENANT_SUSPENDED'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  constructor(public code: ErrorCode, message: string, public details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
  }
}

export const keys = {
  config: (ctx: Ctx) => ({ PK: `TENANT#${ctx.tenantId}`, SK: 'CONFIG' }),
  host: (ctx: Ctx, slug: string) => ({ PK: `TENANT#${ctx.tenantId}`, SK: `HOST#${slug}` }),
  // Các khóa nền tảng chỉ sử dụng bởi module quản lý website và resolver
  slug: (slug: string) => ({ PK: `TENANT#PLATFORM#SLUG#${slug}`, SK: 'META' }),
  keymap: (keyId: string) => ({ PK: `TENANT#PLATFORM#KEY#${keyId}`, SK: 'META' }),
};