import type { AuthenticatedSession } from '../types/auth.js';
import { IS_DEMO_AUTH_MODE } from './cognitoAuth.js';

const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
const baseUrl = (env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');

export const DEFAULT_TRANSLATE_PRICE_USD_PER_MILLION = 15.0;
export const DEFAULT_PRICE_REFERENCED_AT = '2026-10-08';

export const PLAN_CHAR_LIMITS: Readonly<Record<AuthenticatedSession['plan'], number>> = Object.freeze({
  FREE: 200_000,
  PRO: 2_000_000,
  BUSINESS: 10_000_000,
});

export interface TenantUsageSummary {
  request_id?: string;
  tenant_id: string;
  month: string;
  chars_machine_translated: number;
  chars_from_memory: number;
  chars_quota_used: number;
  requests: number;
  pages_served: number;
}

export interface ComputedUsageMetrics extends TenantUsageSummary {
  character_limit: number;
  total_chars_processed: number;
  reserved_in_flight: number;
  quota_used_percent: number;
  tm_hit_rate_percent: number;
  price_usd_per_million: number;
  price_referenced_at: string;
  estimated_machine_cost_usd: number;
  estimated_cost_avoided_usd: number;
}

export interface PlatformTenantSummary {
  tenant_id: string;
  organization_name?: string;
  plan?: string;
  status?: 'ACTIVE' | 'LOCKED';
  created_at?: string;
  character_limit?: number;
}

export function currentMonthUtc(date: Date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function computeUsageMetrics(
  raw: TenantUsageSummary,
  plan: AuthenticatedSession['plan'],
  customLimit?: number,
  priceUsdPerMillion: number = DEFAULT_TRANSLATE_PRICE_USD_PER_MILLION,
): ComputedUsageMetrics {
  const characterLimit =
    typeof customLimit === 'number' && customLimit > 0
      ? customLimit
      : (PLAN_CHAR_LIMITS[plan] ?? PLAN_CHAR_LIMITS.FREE);
  const machineChars = Math.max(0, Number(raw.chars_machine_translated ?? 0));
  const tmChars = Math.max(0, Number(raw.chars_from_memory ?? 0));
  const quotaUsed = Math.max(0, Number(raw.chars_quota_used ?? machineChars));
  const totalChars = machineChars + tmChars;
  const reservedInFlight = Math.max(0, quotaUsed - machineChars);
  const quotaUsedPercent = characterLimit > 0 ? (quotaUsed / characterLimit) * 100 : 0;
  const tmHitRatePercent = totalChars > 0 ? (tmChars / totalChars) * 100 : 0;
  const estimatedMachineCostUsd = (machineChars * priceUsdPerMillion) / 1_000_000;
  const estimatedCostAvoidedUsd = (tmChars * priceUsdPerMillion) / 1_000_000;

  return {
    ...raw,
    chars_machine_translated: machineChars,
    chars_from_memory: tmChars,
    chars_quota_used: quotaUsed,
    requests: Math.max(0, Number(raw.requests ?? 0)),
    pages_served: Math.max(0, Number(raw.pages_served ?? 0)),
    character_limit: characterLimit,
    total_chars_processed: totalChars,
    reserved_in_flight: reservedInFlight,
    quota_used_percent: quotaUsedPercent,
    tm_hit_rate_percent: tmHitRatePercent,
    price_usd_per_million: priceUsdPerMillion,
    price_referenced_at: DEFAULT_PRICE_REFERENCED_AT,
    estimated_machine_cost_usd: estimatedMachineCostUsd,
    estimated_cost_avoided_usd: estimatedCostAvoidedUsd,
  };
}

const mockUsageStore = new Map<string, TenantUsageSummary>();

const mockPlatformTenants: PlatformTenantSummary[] = [
  {
    tenant_id: 't_01hxyz987654',
    organization_name: 'Homestay Phố Cổ Hội An (Tenant A)',
    plan: 'FREE',
    status: 'ACTIVE',
    created_at: '2026-10-15T08:00:00.000Z',
    character_limit: 200_000,
  },
  {
    tenant_id: 't_02hotel_danang',
    organization_name: 'Đà Nẵng Beach Resort (Tenant B)',
    plan: 'PRO',
    status: 'ACTIVE',
    created_at: '2026-10-18T09:30:00.000Z',
    character_limit: 2_000_000,
  },
  {
    tenant_id: 't_03songhoai_bistro',
    organization_name: 'Nhà hàng Sông Hoài (Tenant C)',
    plan: 'FREE',
    status: 'ACTIVE',
    created_at: '2026-10-20T14:15:00.000Z',
    character_limit: 200_000,
  },
];

function getDefaultMockUsage(tenantId: string, month: string): TenantUsageSummary {
  const key = `${tenantId}:${month}`;
  const existing = mockUsageStore.get(key);
  if (existing) return { ...existing };
  const initial: TenantUsageSummary = {
    request_id: `req-mock-${month}`,
    tenant_id: tenantId,
    month,
    chars_machine_translated: 28_200,
    chars_from_memory: 65_800,
    chars_quota_used: 28_200,
    requests: 2_012,
    pages_served: 48,
  };
  mockUsageStore.set(key, initial);
  return { ...initial };
}

function jsonHeaders(session: AuthenticatedSession): Record<string, string> {
  return {
    Authorization: `Bearer ${session.idToken}`,
    'Content-Type': 'application/json',
  };
}

export async function fetchTenantUsage(
  session: AuthenticatedSession,
  month: string = currentMonthUtc(),
): Promise<TenantUsageSummary> {
  if (IS_DEMO_AUTH_MODE) {
    return getDefaultMockUsage(session.tenantId, month);
  }
  const response = await fetch(
    `${baseUrl}/console/usage?month=${encodeURIComponent(month)}`,
    {
      method: 'GET',
      headers: jsonHeaders(session),
    },
  );
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    throw new Error(data?.error?.message ?? `Không thể tải báo cáo lượng dùng (${response.status}).`);
  }
  return (await response.json()) as TenantUsageSummary;
}

export async function listPlatformTenants(
  session: AuthenticatedSession,
): Promise<PlatformTenantSummary[]> {
  if (IS_DEMO_AUTH_MODE) {
    return mockPlatformTenants.map((t) => ({ ...t }));
  }
  const response = await fetch(`${baseUrl}/platform/tenants`, {
    method: 'GET',
    headers: jsonHeaders(session),
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new Error(data?.error?.message ?? `Không thể tải danh sách tenant (${response.status}).`);
  }
  const payload = (await response.json()) as { items?: PlatformTenantSummary[] };
  return payload.items ?? [];
}

export async function updatePlatformTenantStatus(
  session: AuthenticatedSession,
  tenantId: string,
  status: 'ACTIVE' | 'LOCKED',
): Promise<void> {
  if (IS_DEMO_AUTH_MODE) {
    const target = mockPlatformTenants.find((t) => t.tenant_id === tenantId);
    if (target) target.status = status;
    return;
  }
  const response = await fetch(
    `${baseUrl}/platform/tenants/${encodeURIComponent(tenantId)}/status`,
    {
      method: 'PATCH',
      headers: jsonHeaders(session),
      body: JSON.stringify({ status }),
    },
  );
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new Error(data?.error?.message ?? `Không thể cập nhật trạng thái tenant (${response.status}).`);
  }
}

export async function updatePlatformTenantLimit(
  session: AuthenticatedSession,
  tenantId: string,
  characterLimit: number,
): Promise<void> {
  if (IS_DEMO_AUTH_MODE) {
    const target = mockPlatformTenants.find((t) => t.tenant_id === tenantId);
    if (target) target.character_limit = characterLimit;
    return;
  }
  const response = await fetch(
    `${baseUrl}/platform/tenants/${encodeURIComponent(tenantId)}/limits`,
    {
      method: 'PATCH',
      headers: jsonHeaders(session),
      body: JSON.stringify({ character_limit: characterLimit }),
    },
  );
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new Error(data?.error?.message ?? `Không thể cập nhật hạn mức ký tự (${response.status}).`);
  }
}
