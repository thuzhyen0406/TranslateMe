export type TenantStatus = 'ACTIVE' | 'LOCKED';

export interface ConsoleRequestPolicyInput {
  method: string;
  path: string;
  tenantStatus: TenantStatus;
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function canConsoleRequest({
  method,
  path,
  tenantStatus,
}: ConsoleRequestPolicyInput): boolean {
  const normalizedMethod = method.trim().toUpperCase();
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;

  if (tenantStatus !== 'LOCKED' || !WRITE_METHODS.has(normalizedMethod)) {
    return true;
  }

  return normalizedMethod === 'POST'
    && normalizedPath === '/console/glossary/import/preview';
}
