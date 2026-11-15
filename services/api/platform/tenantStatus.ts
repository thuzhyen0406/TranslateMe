import { AppError, type Ctx } from '../../../libs/common/types.js';
import { db } from '../../../libs/common/db.js';
import { invalidateForSites, type SiteInvalidationResult } from '../../../libs/common/invalidation.js';

export const PLATFORM_ADMIN_GROUP = 'PlatformAdmins';

export function isPlatformAdmin(groups: unknown): boolean {
  if (Array.isArray(groups)) {
    return groups.includes(PLATFORM_ADMIN_GROUP);
  }

  if (typeof groups !== 'string') return false;

  try {
    const parsed: unknown = JSON.parse(groups);
    return Array.isArray(parsed) && parsed.includes(PLATFORM_ADMIN_GROUP);
  } catch {
    return groups.split(',').map((value) => value.trim()).includes(PLATFORM_ADMIN_GROUP);
  }
}

export function validateTenantId(value: unknown): string {
  if (typeof value !== 'string' || !/^t_[A-Za-z0-9_-]{1,64}$/.test(value)) {
    throw new AppError('INVALID_REQUEST', 'tenantId không hợp lệ');
  }
  return value;
}

export interface PlatformStatusDependencies {
  db: Pick<typeof db, 'updateTenantStatus' | 'listTenantSites'>;
  invalidateSites: typeof invalidateForSites;
}

export const platformStatusDependencies: PlatformStatusDependencies = {
  db,
  invalidateSites: invalidateForSites,
};

export async function setTenantStatus(
  tenantId: string,
  status: 'ACTIVE' | 'LOCKED',
  deps: PlatformStatusDependencies = platformStatusDependencies,
): Promise<{ tenantId: string; status: 'ACTIVE' | 'LOCKED'; invalidation: SiteInvalidationResult }> {
  const ctx: Ctx = {
    tenantId,
    via: 'JWT',
    requestId: 'platform-admin',
  };

  await deps.db.updateTenantStatus(ctx, tenantId, status);
  const sites = await deps.db.listTenantSites(ctx);
  const publishedSites = sites.filter((site) => site.status === 'ACTIVE' || site.status === 'PAUSED');
  const slugs = [...new Set(publishedSites.map((site) => site.slug).filter((slug): slug is string => typeof slug === 'string' && slug.length > 0))];

  const invalidation = await deps.invalidateSites(ctx, { slugs });
  return { tenantId, status, invalidation };
}
