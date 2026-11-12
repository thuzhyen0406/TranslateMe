import type { TenantStatus } from '../types/auth.js';

export type { TenantStatus };

export interface ConsoleRequestPolicyInput {
  method: string;
  path: string;
  tenantStatus: TenantStatus;
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Kiểm tra quyền gửi yêu cầu phía Console theo nguyên tắc fail-closed:
 *  - GET / HEAD luôn được phép (chế độ chỉ xem);
 *  - POST /console/glossary/import/preview là thao tác kiểm thử đọc (không ghi DB) nên được phép;
 *  - Mọi thao tác ghi khác CHỈ bật khi `tenantStatus === 'ACTIVE'` (cả `LOCKED` lẫn `UNKNOWN` đều bị khóa).
 */
export function canConsoleRequest({
  method,
  path,
  tenantStatus,
}: ConsoleRequestPolicyInput): boolean {
  const normalizedMethod = method.trim().toUpperCase();
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;

  if (!WRITE_METHODS.has(normalizedMethod)) {
    return true;
  }

  if (
    normalizedMethod === 'POST' &&
    normalizedPath === '/console/glossary/import/preview'
  ) {
    return true;
  }

  return tenantStatus === 'ACTIVE';
}
