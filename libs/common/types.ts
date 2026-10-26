/**
 * Kiểu dữ liệu dùng chung và hàm tạo khóa chính cho bảng đơn DynamoDB (Single-Table Design).
 * Bám sát Phần B (v1.1) – Hợp đồng giao diện giữa các module:
 *  - B.2: Ctx, Role, Plan, Label, Source
 *  - B.3: keys (chuẩn hóa khóa PK/SK cho mọi thực thể)
 *  - B.5: AppError & ErrorCode
 */

export type Role = 'TENANT_ADMIN' | 'DEVELOPER' | 'REVIEWER';
export type Plan = 'FREE' | 'PRO' | 'BUSINESS';
export type Lang = string;
export type Label = 'AUTO' | 'REVIEWED' | 'NEEDS_REVIEW';
export type Source = 'MACHINE' | 'HUMAN';

export interface Ctx {
  tenantId: string;
  sub?: string;
  userId?: string;
  role?: Role;
  via: 'JWT' | 'API_KEY' | 'SLUG';
  apiKeyId?: string;
  slug?: string;
  requestId: string;
}

export type ErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'PERMISSION_DENIED'
  | 'TENANT_SUSPENDED'
  | 'QUOTA_EXCEEDED'
  | 'CHAR_QUOTA_EXCEEDED'
  | 'REQUEST_QUOTA_EXCEEDED'
  | 'RATE_LIMITED'
  | 'VALIDATION_ERROR'
  | 'INVALID_REQUEST'
  | 'UNSUPPORTED_LANGUAGE'
  | 'TEXT_TOO_LONG'
  | 'LANGUAGE_NOT_DETECTED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'VERSION_CONFLICT'
  | 'DUPLICATE_SLUG'
  | 'SITE_UNREACHABLE'
  | 'VERIFICATION_CODE_MISMATCH'
  | 'VERIFICATION_FAILED'
  | 'FILE_NOT_UPLOADED'
  | 'PLACEHOLDER_MISMATCH'
  | 'TRANSLATE_FAILED'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const keys = {
  config: (ctx: Ctx) => ({ PK: `TENANT#${ctx.tenantId}`, SK: 'CONFIG' }),
  member: (ctx: Ctx, userId: string) => ({
    PK: `TENANT#${ctx.tenantId}`,
    SK: `MEMBER#${userId}`,
  }),
  host: (ctx: Ctx, slug: string) => ({
    PK: `TENANT#${ctx.tenantId}`,
    SK: `HOST#${slug}`,
  }),
  gloss: (ctx: Ctx, normalizedTerm: string) => ({
    PK: `TENANT#${ctx.tenantId}#GLOSS`,
    SK: `TERM#${normalizedTerm}`,
  }),
  tm: (ctx: Ctx, src: Lang, tgt: Lang, hash: string) => ({
    PK: `TENANT#${ctx.tenantId}#TM#${src}#${tgt}`,
    SK: `SEG#${hash}`,
  }),
  seg: (ctx: Ctx, slug: string, pagePath: string, hash: string) => ({
    PK: `TENANT#${ctx.tenantId}#SITE#${slug}`,
    SK: `PAGE#${pagePath}#SEG#${hash}`,
  }),
  usageTotal: (ctx: Ctx, ym: string) => ({
    PK: `TENANT#${ctx.tenantId}#USAGE`,
    SK: `MONTH#${ym}#TOTAL`,
  }),
  usageWeb: (ctx: Ctx, ym: string, slug: string) => ({
    PK: `TENANT#${ctx.tenantId}#USAGE`,
    SK: `MONTH#${ym}#WEB#${slug}`,
  }),
  usageConsole: (ctx: Ctx, ym: string) => ({
    PK: `TENANT#${ctx.tenantId}#USAGE`,
    SK: `MONTH#${ym}#CONSOLE`,
  }),
  keyUsage: (ctx: Ctx, ym: string, keyId: string) => ({
    PK: `TENANT#${ctx.tenantId}#USAGE`,
    SK: `MONTH#${ym}#KEY#${keyId}`,
  }),
  slug: (slug: string) => ({ PK: `TENANT#PLATFORM#SLUG#${slug}`, SK: 'META' }),
  keymap: (keyId: string) => ({
    PK: `TENANT#PLATFORM#KEY#${keyId}`,
    SK: 'META',
  }),
};
