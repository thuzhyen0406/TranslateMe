import { randomBytes } from 'node:crypto';
import { parse } from 'parse5';
import { findFirst, getAttr, isElement } from '../../../libs/common/htmlDom.js';
import { SLUG_RE, slugFromHostname } from '../../../libs/common/siteSlug.js';
import { Ctx, AppError, keys, Lang } from '../../../libs/common/types.js';
import { db, requireRole } from '../../../libs/common/db.js';
import { assertTenantWritable } from '../../../libs/common/tenant.js';
import { invalidateForSites } from '../../../libs/common/invalidation.js';
import {
  defaultResolver,
  isBlockedIp,
  safeFetch,
  validateUrl,
  type Resolver,
} from '../../../libs/common/safeFetch.js';

const TABLE_NAME = process.env.TABLE_NAME || 'translate-data';

export interface CreateSiteInput {
  homeUrl: string;
  displayName: string;
  sourceLang: Lang;
  targetLangs: Lang[];
  noTranslateSelectors?: string[];
  cacheTtlSec?: number;
}

export interface SiteManagerDependencies {
  db: Pick<typeof db, 'transact' | 'get' | 'put' | 'updateSiteStatus'>;
  resolver: Resolver;
  safeFetch: typeof safeFetch;
  assertTenantWritable?: typeof assertTenantWritable;
  invalidateSites?: typeof invalidateForSites;
}

const defaultDependencies: SiteManagerDependencies = {
  db,
  resolver: defaultResolver,
  safeFetch,
  assertTenantWritable,
  invalidateSites: invalidateForSites,
};

async function validatePublicUrl(urlStr: string, resolver: Resolver): Promise<URL> {
  const result = validateUrl(urlStr);
  if (!result.ok) {
    const code = result.reason === 'PRIVATE_IP' ? 'FORBIDDEN' : 'SITE_UNREACHABLE';
    throw new AppError(code, `URL không hợp lệ hoặc không được phép: ${result.detail}`);
  }

  if (result.ipLiteral) {
    if (isBlockedIp(result.ipLiteral)) {
      throw new AppError('FORBIDDEN', 'Không chấp nhận địa chỉ IP nội bộ hoặc không công khai');
    }
    return result.url;
  }

  const hostname = result.url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new AppError('FORBIDDEN', 'Không chấp nhận tên máy chủ nội bộ');
  }

  let addresses;
  try {
    addresses = await resolver(hostname);
  } catch {
    throw new AppError('SITE_UNREACHABLE', 'Không thể phân giải tên miền');
  }

  if (addresses.length === 0) {
    throw new AppError('SITE_UNREACHABLE', 'Tên miền không có địa chỉ IP');
  }
  if (addresses.some(({ address }) => isBlockedIp(address))) {
    throw new AppError('FORBIDDEN', 'Tên miền phân giải tới địa chỉ IP nội bộ hoặc không công khai');
  }

  return result.url;
}

async function updateSiteStatus(
  ctx: Ctx,
  slug: string,
  expectedStatus: 'ACTIVE' | 'PAUSED',
  nextStatus: 'ACTIVE' | 'PAUSED',
  deps: SiteManagerDependencies,
): Promise<void> {
  try {
    await deps.db.updateSiteStatus(ctx, slug, expectedStatus, nextStatus);
  } catch (error: unknown) {
    const isVersionConflict = error instanceof AppError && error.code === 'VERSION_CONFLICT';
    const isConditionalCheckFailed =
      typeof error === 'object' &&
      error !== null &&
      'name' in error &&
      error.name === 'ConditionalCheckFailedException';

    if (isVersionConflict || isConditionalCheckFailed) {
      // Cho phép lặp lại thao tác nếu trạng thái đã đổi nhưng lần xóa cache trước thất bại.
      const current = await deps.db.get(ctx, keys.host(ctx, slug));
      if (!current) throw new AppError('NOT_FOUND', 'Không tìm thấy website');
      if (current?.status === nextStatus) return;
      throw new AppError('VERSION_CONFLICT', 'Trạng thái website đã thay đổi');
    }
    throw error;
  }
}

function activeTenantCheck(ctx: Ctx) {
  return {
    ConditionCheck: {
      TableName: TABLE_NAME,
      Key: keys.config(ctx),
      ConditionExpression: 'attribute_exists(PK) AND #status = :active',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':active': 'ACTIVE' },
    },
  };
}

function transactionConflict(error: unknown): boolean {
  const e = error as { name?: string; CancellationReasons?: { Code?: string }[] } | null;
  return e?.name === 'TransactionCanceledException' &&
    (!e.CancellationReasons?.length || e.CancellationReasons.some(({ Code }) => Code === 'ConditionalCheckFailed'));
}

async function checkTenantAfterConflict(ctx: Ctx, deps: SiteManagerDependencies): Promise<void> {
  const config = await deps.db.get(ctx, keys.config(ctx), { consistent: true });
  if (!config) throw new AppError('NOT_FOUND', 'Không tìm thấy cấu hình tenant');
  if (config.status !== 'ACTIVE') throw new AppError('TENANT_SUSPENDED', 'Tenant đang bị khóa');
}

export async function createSite(
  ctx: Ctx,
  input: CreateSiteInput,
  deps: SiteManagerDependencies = defaultDependencies,
) {
  requireRole(ctx, ['TENANT_ADMIN']);
  await (deps.assertTenantWritable ?? assertTenantWritable)(ctx);
  const url = await validatePublicUrl(input.homeUrl, deps.resolver);
  const slug = slugFromHostname(url.hostname);
  const verificationCode = `translateme-verify-${randomBytes(16).toString('hex')}`;
  const hostKey = keys.host(ctx, slug);

  try {
    await deps.db.transact(ctx, [
      {
        Put: {
          TableName: TABLE_NAME,
          Item: {
            ...hostKey,
            slug,
            homeUrl: input.homeUrl,
            displayName: input.displayName,
            sourceLang: input.sourceLang,
            targetLangs: input.targetLangs,
            noTranslateSelectors: input.noTranslateSelectors ?? [],
            verificationCode,
            status: 'PENDING',
            createdAt: new Date().toISOString(),
          },
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      },
      activeTenantCheck(ctx),
    ]);
  } catch (error) {
    if (!transactionConflict(error)) throw error;
    await checkTenantAfterConflict(ctx, deps);
    if (await deps.db.get(ctx, hostKey, { consistent: true })) {
      throw new AppError('DUPLICATE_SLUG', 'Website đã tồn tại trong tenant');
    }
    throw error;
  }

  return { slug, status: 'PENDING' as const, verificationCode };
}

export async function verifySite(
  ctx: Ctx,
  slug: string,
  method: 'META' | 'FILE',
  deps: SiteManagerDependencies = defaultDependencies,
) {
  requireRole(ctx, ['TENANT_ADMIN']);
  await (deps.assertTenantWritable ?? assertTenantWritable)(ctx);
  const hostKey = keys.host(ctx, slug);
  const host = await deps.db.get(ctx, hostKey, { consistent: true });
  if (!host) throw new AppError('NOT_FOUND', 'Không tìm thấy website');
  if (host.status === 'ACTIVE') return { status: 'ACTIVE' as const };
  if (host.status !== 'PENDING') throw new AppError('VERSION_CONFLICT', 'Chỉ xác minh website đang chờ xác minh');
  if (!SLUG_RE.test(slug)) throw new AppError('INVALID_REQUEST', 'Slug cũ không hợp lệ. Hãy đăng ký lại URL website.');
  if (method !== 'META' && method !== 'FILE') throw new AppError('INVALID_REQUEST', 'Phương thức xác minh không hợp lệ');
  const { verificationCode, homeUrl } = host;
  if (typeof verificationCode !== 'string' || !verificationCode || typeof homeUrl !== 'string') {
    throw new AppError('VERIFICATION_CODE_MISMATCH', 'Website chưa có mã xác minh hợp lệ');
  }

  try {
    const originUrl = new URL(homeUrl);
    const verificationUrl = method === 'FILE' ? new URL('/translateme-verification.txt', originUrl) : originUrl;
    const res = await deps.safeFetch(verificationUrl.href, {
      maxSizeBytes: method === 'FILE' ? 10_000 : 3_000_000,
      timeoutMs: 5_000,
      maxRedirects: 3,
      allowedContentTypes: method === 'FILE' ? ['text/plain'] : ['text/html'],
    });
    if (res.kind !== 'OK' || res.status < 200 || res.status >= 300) {
      const reason = res.kind === 'OK' ? 'HTTP_STATUS' : res.kind;
      throw new AppError('SITE_UNREACHABLE', 'Không thể tải nội dung xác minh website', { reason });
    }
    if (new URL(res.finalUrl).origin !== originUrl.origin) {
      throw new AppError('VERIFICATION_CODE_MISMATCH', 'Nội dung xác minh phải thuộc cùng origin', { reason: 'CROSS_ORIGIN_REDIRECT' });
    }

    const head = method === 'META' ? findFirst(parse(res.html), (el) => el.tagName === 'head') : undefined;
    const matches = method === 'FILE'
      ? res.html.trim() === verificationCode
      : head?.childNodes.some((node) =>
        isElement(node) && node.tagName === 'meta' &&
        getAttr(node, 'name')?.toLowerCase() === 'translateme-site-verification' &&
        getAttr(node, 'content') === verificationCode,
      );
    if (!matches) {
      throw new AppError('VERIFICATION_CODE_MISMATCH', 'Không tìm thấy mã xác minh hợp lệ', { reason: 'VERIFICATION_CODE_MISMATCH' });
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('SITE_UNREACHABLE', 'Không thể tải nội dung xác minh website', { reason: 'SITE_UNREACHABLE' });
  }

  const verifiedAt = new Date().toISOString();
  try {
    await deps.db.transact(ctx, [
      {
        Put: {
          TableName: TABLE_NAME,
          Item: { ...keys.slug(slug), tenantId: ctx.tenantId, createdAt: host.createdAt ?? verifiedAt, verifiedAt },
          ConditionExpression: 'attribute_not_exists(PK) OR tenantId = :owner',
          ExpressionAttributeValues: { ':owner': ctx.tenantId },
        },
      },
      {
        Update: {
          TableName: TABLE_NAME,
          Key: hostKey,
          UpdateExpression: 'SET #status = :active, updatedAt = :now',
          ConditionExpression: '#status = :pending AND homeUrl = :url AND verificationCode = :code',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':active': 'ACTIVE', ':pending': 'PENDING', ':now': verifiedAt, ':url': homeUrl, ':code': verificationCode,
          },
        },
      },
      activeTenantCheck(ctx),
    ], { platformSlugReservation: true });
  } catch (error) {
    if (!transactionConflict(error)) throw error;
    await checkTenantAfterConflict(ctx, deps);
    const current = await deps.db.get(ctx, hostKey, { consistent: true });
    if (current?.status === 'ACTIVE' && current.verificationCode === verificationCode) return { status: 'ACTIVE' as const };
    if (current?.status !== 'PENDING' || current.verificationCode !== verificationCode || current.homeUrl !== homeUrl) {
      throw new AppError('VERSION_CONFLICT', 'Website đã thay đổi trong lúc xác minh');
    }
    const reasons = (error as { CancellationReasons?: { Code?: string }[] }).CancellationReasons;
    if (!reasons?.length || reasons[0]?.Code === 'ConditionalCheckFailed') {
      throw new AppError('DUPLICATE_SLUG', 'Slug đã được cấp cho website khác');
    }
    throw error;
  }
  return { status: 'ACTIVE' as const };
}

export async function pauseSite(
  ctx: Ctx,
  slug: string,
  deps: SiteManagerDependencies = defaultDependencies,
) {
  requireRole(ctx, ['TENANT_ADMIN']);
  await (deps.assertTenantWritable ?? assertTenantWritable)(ctx);

  await updateSiteStatus(ctx, slug, 'ACTIVE', 'PAUSED', deps);
  const invalidation = await (deps.invalidateSites ?? invalidateForSites)(ctx, {
    slugs: [slug],
  });
  return { status: 'PAUSED' as const, invalidation };
}

export async function resumeSite(
  ctx: Ctx,
  slug: string,
  deps: SiteManagerDependencies = defaultDependencies,
) {
  requireRole(ctx, ['TENANT_ADMIN']);
  await (deps.assertTenantWritable ?? assertTenantWritable)(ctx);

  await updateSiteStatus(ctx, slug, 'PAUSED', 'ACTIVE', deps);
  const invalidation = await (deps.invalidateSites ?? invalidateForSites)(ctx, {
    slugs: [slug],
  });
  return { status: 'ACTIVE' as const, invalidation };
}

export async function updateSite(
  ctx: Ctx,
  slug: string,
  input: Record<string, unknown>,
  deps: SiteManagerDependencies = defaultDependencies,
): Promise<Record<string, unknown>> {
  requireRole(ctx, ['TENANT_ADMIN']);
  await (deps.assertTenantWritable ?? assertTenantWritable)(ctx);

  if ('status' in input && input.status !== undefined) {
    throw new AppError('INVALID_REQUEST', 'Không được phép cập nhật trạng thái website qua endpoint này; vui lòng dùng verify, pause hoặc resume');
  }

  const site = await deps.db.get(ctx, keys.host(ctx, slug));
  if (!site) {
    throw new AppError('NOT_FOUND', 'Không tìm thấy website');
  }

  const changes = Object.fromEntries(Object.entries({
    targetLangs: Array.isArray(input.targetLangs) ? input.targetLangs : undefined,
    noTranslateSelectors: Array.isArray(input.noTranslateSelectors) ? input.noTranslateSelectors : undefined,
    displayName: typeof input.displayName === 'string' ? input.displayName : undefined,
    cacheTTL: typeof input.cacheTTL === 'number' ? input.cacheTTL : undefined,
    cacheTtlSec: typeof input.cacheTtlSec === 'number' ? input.cacheTtlSec : undefined,
    updatedAt: new Date().toISOString(),
  }).filter(([, value]) => value !== undefined));
  const entries = Object.entries(changes);
  await deps.db.transact(ctx, [
    {
      Update: {
        TableName: TABLE_NAME,
        Key: keys.host(ctx, slug),
        UpdateExpression: 'SET ' + entries.map((_, index) => `#f${index} = :v${index}`).join(', '),
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeNames: Object.fromEntries(entries.map(([field], index) => [`#f${index}`, field])),
        ExpressionAttributeValues: Object.fromEntries(entries.map(([, value], index) => [`:v${index}`, value])),
      },
    },
    activeTenantCheck(ctx),
  ]).catch(async (error: unknown) => {
    if (transactionConflict(error)) await checkTenantAfterConflict(ctx, deps);
    throw error;
  });
  return { ...site, ...changes };
}
