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

export type SessionWithOptionalLimit = AuthenticatedSession & {
  character_limit?: number;
  characterLimit?: number;
};

export interface TenantUsageSummary {
  request_id?: string;
  tenant_id: string;
  month: string;
  chars_machine_translated: number;
  chars_from_memory: number;
  chars_quota_used: number;
  requests: number;
  pages_served: number;
  /** Hạn mức ký tự riêng của tenant nếu API trả kèm hoặc đã đồng bộ từ cấu hình CONFIG. */
  character_limit?: number;
  characterLimit?: number;
}

export interface ComputedUsageMetrics extends TenantUsageSummary {
  character_limit: number;
  is_custom_limit: boolean;
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

export function isValidCharacterLimit(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function currentMonthUtc(date: Date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

const customTenantLimits = new Map<string, number>();

export function resolveTenantCharacterLimit(
  session: SessionWithOptionalLimit,
  usage?: Partial<TenantUsageSummary> | null,
  profileLimit?: number,
): number {
  if (isValidCharacterLimit(usage?.character_limit)) return usage.character_limit;
  if (isValidCharacterLimit(usage?.characterLimit)) return usage.characterLimit;
  if (isValidCharacterLimit(profileLimit)) return profileLimit;
  if (isValidCharacterLimit(session.character_limit)) return session.character_limit;
  if (isValidCharacterLimit(session.characterLimit)) return session.characterLimit;
  const storedCustom = customTenantLimits.get(session.tenantId);
  if (isValidCharacterLimit(storedCustom)) return storedCustom;
  return PLAN_CHAR_LIMITS[session.plan] ?? PLAN_CHAR_LIMITS.FREE;
}

export function computeUsageMetrics(
  raw: TenantUsageSummary,
  plan: AuthenticatedSession['plan'],
  customLimit?: number,
  priceUsdPerMillion: number = DEFAULT_TRANSLATE_PRICE_USD_PER_MILLION,
): ComputedUsageMetrics {
  const defaultPlanLimit = PLAN_CHAR_LIMITS[plan] ?? PLAN_CHAR_LIMITS.FREE;
  const characterLimit = isValidCharacterLimit(customLimit)
    ? customLimit
    : isValidCharacterLimit(raw.character_limit)
      ? raw.character_limit
      : isValidCharacterLimit(raw.characterLimit)
        ? raw.characterLimit
        : defaultPlanLimit;
  const isCustomLimit = characterLimit !== defaultPlanLimit;

  const machineChars = Math.max(0, Number(raw.chars_machine_translated ?? 0));
  const tmChars = Math.max(0, Number(raw.chars_from_memory ?? 0));
  const quotaUsed = Math.max(0, Number(raw.chars_quota_used ?? machineChars));
  const totalChars = machineChars + tmChars;
  const reservedInFlight = Math.max(0, quotaUsed - machineChars);
  const quotaUsedPercent =
    characterLimit > 0 ? (quotaUsed / characterLimit) * 100 : quotaUsed > 0 ? 100 : 0;
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
    is_custom_limit: isCustomLimit,
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

function getMockTenantCharacterLimit(tenantId: string): number | undefined {
  const custom = customTenantLimits.get(tenantId);
  if (isValidCharacterLimit(custom)) return custom;
  const tenantRow = mockPlatformTenants.find((t) => t.tenant_id === tenantId);
  return isValidCharacterLimit(tenantRow?.character_limit) ? tenantRow.character_limit : undefined;
}

function getDefaultMockUsage(tenantId: string, month: string): TenantUsageSummary {
  const key = `${tenantId}:${month}`;
  const limit = getMockTenantCharacterLimit(tenantId);
  const existing = mockUsageStore.get(key);
  if (existing) {
    return {
      ...existing,
      ...(isValidCharacterLimit(limit) ? { character_limit: limit } : {}),
    };
  }
  const initial: TenantUsageSummary = {
    request_id: `req-mock-${month}`,
    tenant_id: tenantId,
    month,
    chars_machine_translated: 28_200,
    chars_from_memory: 65_800,
    chars_quota_used: 28_200,
    requests: 2_012,
    pages_served: 48,
    ...(isValidCharacterLimit(limit) ? { character_limit: limit } : {}),
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

/**
 * Truy vấn hạn mức ký tự thực tế của tenant từ API (`/console/me`) hoặc bộ nhớ phiên làm việc.
 * Nếu tenant được Platform Admin đặt `character_limit` riêng, giá trị này sẽ ghi đè hạn mức mặc định của gói.
 */
export async function fetchTenantCustomLimit(
  session: SessionWithOptionalLimit,
  fetchImpl: typeof fetch = fetch,
): Promise<number | undefined> {
  if (IS_DEMO_AUTH_MODE && fetchImpl === fetch) {
    return (
      getMockTenantCharacterLimit(session.tenantId) ??
      (isValidCharacterLimit(session.character_limit) ? session.character_limit : undefined) ??
      (isValidCharacterLimit(session.characterLimit) ? session.characterLimit : undefined)
    );
  }
  try {
    const response = await fetchImpl(`${baseUrl}/console/me`, {
      method: 'GET',
      headers: jsonHeaders(session),
    });
    if (response.ok) {
      const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      const candidate = data?.character_limit ?? data?.characterLimit ?? data?.charLimit;
      if (isValidCharacterLimit(candidate)) {
        customTenantLimits.set(session.tenantId, candidate);
        return candidate;
      }
    }
  } catch {
    // Nếu không đọc được /console/me, lùi về hạn mức đã lưu trên session hoặc customTenantLimits
  }
  if (isValidCharacterLimit(session.character_limit)) return session.character_limit;
  if (isValidCharacterLimit(session.characterLimit)) return session.characterLimit;
  return customTenantLimits.get(session.tenantId);
}

export async function fetchTenantUsage(
  session: SessionWithOptionalLimit,
  month: string = currentMonthUtc(),
  fetchImpl: typeof fetch = fetch,
): Promise<TenantUsageSummary> {
  if (IS_DEMO_AUTH_MODE && fetchImpl === fetch) {
    return getDefaultMockUsage(session.tenantId, month);
  }
  const response = await fetchImpl(
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
  fetchImpl: typeof fetch = fetch,
): Promise<PlatformTenantSummary[]> {
  if (IS_DEMO_AUTH_MODE && fetchImpl === fetch) {
    return mockPlatformTenants.map((t) => ({ ...t }));
  }
  const allItems: PlatformTenantSummary[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  while (true) {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    const response = await fetchImpl(`${baseUrl}/platform/tenants${query}`, {
      method: 'GET',
      headers: jsonHeaders(session),
    });
    if (!response.ok) {
      const data = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      throw new Error(data?.error?.message ?? `Không thể tải danh sách tenant (${response.status}).`);
    }
    const payload = (await response.json()) as {
      items?: PlatformTenantSummary[];
      next_cursor?: string;
    };
    for (const item of payload.items ?? []) {
      if (isValidCharacterLimit(item.character_limit)) {
        customTenantLimits.set(item.tenant_id, item.character_limit);
      }
      allItems.push(item);
    }
    const nextCursor =
      typeof payload.next_cursor === 'string' && payload.next_cursor.trim()
        ? payload.next_cursor.trim()
        : undefined;
    if (!nextCursor || seenCursors.has(nextCursor)) {
      break;
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  return allItems;
}

export async function updatePlatformTenantStatus(
  session: AuthenticatedSession,
  tenantId: string,
  status: 'ACTIVE' | 'LOCKED',
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (IS_DEMO_AUTH_MODE && fetchImpl === fetch) {
    const target = mockPlatformTenants.find((t) => t.tenant_id === tenantId);
    if (target) target.status = status;
    return;
  }
  const response = await fetchImpl(
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
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!isValidCharacterLimit(characterLimit)) {
    throw new Error('Hạn mức ký tự phải là số nguyên không âm.');
  }
  if (IS_DEMO_AUTH_MODE && fetchImpl === fetch) {
    customTenantLimits.set(tenantId, characterLimit);
    const target = mockPlatformTenants.find((t) => t.tenant_id === tenantId);
    if (target) target.character_limit = characterLimit;
    return;
  }
  const response = await fetchImpl(
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
  const payload = (await response.json().catch(() => null)) as {
    character_limit?: number;
  } | null;
  const savedLimit = isValidCharacterLimit(payload?.character_limit)
    ? payload.character_limit
    : characterLimit;
  customTenantLimits.set(tenantId, savedLimit);
}
