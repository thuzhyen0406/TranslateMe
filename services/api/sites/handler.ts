import { AppError, keys, type Ctx } from '../../../libs/common/types.js';
import { db } from '../../../libs/common/db.js';
import { contextFromIdTokenClaims } from '../auth/context.js';
import { createSite, pauseSite, resumeSite, verifySite, updateSite } from './siteManager.js';

export type WebsiteEvent = {
  httpMethod?: string;
  path?: string;
  rawPath?: string;
  resource?: string;
  requestContext?: {
    requestId?: string;
    stage?: string;
    path?: string;
    authorizer?: { claims?: Record<string, unknown> };
  };
  pathParameters?: Record<string, string | undefined>;
  body?: string | null;
};

export interface WebsiteHandlerDependencies {
  contextFromClaims: typeof contextFromIdTokenClaims;
  listTenantSites: typeof db.listTenantSites;
  getHost: (ctx: Ctx, slug: string) => Promise<Record<string, unknown> | null>;
  create: typeof createSite;
  pause: typeof pauseSite;
  resume: typeof resumeSite;
  verify: typeof verifySite;
  update: typeof updateSite;
}

const defaultDependencies: WebsiteHandlerDependencies = {
  contextFromClaims: contextFromIdTokenClaims,
  listTenantSites: (ctx) => db.listTenantSites(ctx),
  getHost: (ctx, slug) => db.get(ctx, keys.host(ctx, slug)),
  create: createSite,
  pause: pauseSite,
  resume: resumeSite,
  verify: verifySite,
  update: updateSite,
};

export function createWebsiteHandler(dependencies: WebsiteHandlerDependencies = defaultDependencies) {
return async function handler(event: WebsiteEvent) {
  const requestId = event.requestContext?.requestId ?? 'unknown';
  try {
    const claims = event.requestContext?.authorizer?.claims ?? {};
    const claimTenantId = claims['custom:tenant_id'];
    if (typeof claimTenantId !== 'string' || !/^t_[A-Za-z0-9_-]{1,64}$/.test(claimTenantId)) {
      throw new AppError('UNAUTHORIZED', 'Thông tin tenant không hợp lệ');
    }
    const ctx = await dependencies.contextFromClaims(claims, requestId);
    if (ctx.role !== 'TENANT_ADMIN') {
      throw new AppError('PERMISSION_DENIED', 'Chỉ Tenant Admin được quản lý website');
    }

    const path = normalizedRequestPath(event);
    const method = (event.httpMethod ?? 'GET').toUpperCase();
    const slug = event.pathParameters?.slug ?? event.pathParameters?.proxy?.split('/').filter(Boolean)[0] ?? path.split('/').filter(Boolean)[2];
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(event.body ?? '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid body');
      body = parsed as Record<string, unknown>;
    } catch {
      throw new AppError('INVALID_REQUEST', 'Body không hợp lệ');
    }
    // Accept Console snake_case fields while retaining the original camelCase API.
    for (const [camelCase, snakeCase] of [
      ['homeUrl', 'home_url'],
      ['displayName', 'display_name'],
      ['sourceLang', 'source_lang'],
      ['targetLangs', 'target_langs'],
      ['noTranslateSelectors', 'no_translate_selectors'],
      ['cacheTTL', 'cache_ttl'],
      ['cacheSeconds', 'cache_seconds'],
    ]) {
      if (body[camelCase] === undefined && body[snakeCase] !== undefined) {
        body[camelCase] = body[snakeCase];
      }
    }
    if ('tenantId' in body || 'tenant_id' in body) {
      throw new AppError('INVALID_REQUEST', 'Không được gửi tenantId trong body');
    }

    // Kiểm tra exact path cho route detail host (/console/websites/{slug} hoặc /console/hosts/{slug})
    const isExactHostPath = isExactHostDetailRoute(path, slug);

    let result: unknown;
    if ((path === '/console/websites' || path === '/console/hosts') && method === 'GET') {
      const sites = await dependencies.listTenantSites(ctx);
      result = { websites: sites, hosts: sites };
    } else if ((path === '/console/websites' || path === '/console/hosts') && method === 'POST') {
      if (
        typeof body.homeUrl !== 'string' || typeof body.displayName !== 'string' ||
        typeof body.sourceLang !== 'string' || !Array.isArray(body.targetLangs) ||
        !body.targetLangs.every((language) => typeof language === 'string') ||
        (body.noTranslateSelectors !== undefined &&
          (!Array.isArray(body.noTranslateSelectors) ||
            !body.noTranslateSelectors.every((selector) => typeof selector === 'string')))
      ) {
        throw new AppError('INVALID_REQUEST', 'Thiếu hoặc sai kiểu thông tin website');
      }
      const created = await dependencies.create(ctx, body as never);
      const host = (await dependencies.getHost(ctx, (created as { slug?: string }).slug ?? slug)) ?? created;
      result = { ...(created as Record<string, unknown>), host };
    } else if (!slug) {
      throw new AppError('NOT_FOUND', 'Không tìm thấy website');
    } else if (path.endsWith('/verify') && method === 'POST') {
      if (body.method !== 'META' && body.method !== 'FILE') throw new AppError('INVALID_REQUEST', 'method phải là META hoặc FILE');
      await dependencies.verify(ctx, slug, body.method);
      const site = await dependencies.getHost(ctx, slug);
      if (!site) throw new AppError('NOT_FOUND', 'Không tìm thấy website');
      result = { host: site };
    } else if (path.endsWith('/pause') && (method === 'POST' || method === 'PATCH')) {
      result = await dependencies.pause(ctx, slug);
    } else if (path.endsWith('/resume') && (method === 'POST' || method === 'PATCH')) {
      result = await dependencies.resume(ctx, slug);
    } else if (isExactHostPath && method === 'PATCH') {
      // Yêu cầu [P1]: Giữ hợp đồng PATCH /console/hosts/{slug} (Cập nhật status, targetLangs, CSS selectors, cache TTL)
      result = await dependencies.update(ctx, slug, body);
      result = { ...(result as Record<string, unknown>), host: result };
    } else if (isExactHostPath && method === 'GET') {
      // Yêu cầu [P2]: Chỉ trả detail khi path khớp chính xác /console/hosts/{slug}
      const site = await dependencies.getHost(ctx, slug);
      if (!site) throw new AppError('NOT_FOUND', 'Không tìm thấy website');
      result = { website: site, host: site };
    } else {
      // Các path con không hợp lệ khác sẽ trả lỗi 404 NOT_FOUND
      throw new AppError('NOT_FOUND', 'Không tìm thấy endpoint');
    }
    const statusCode = (path === '/console/websites' || path === '/console/hosts') && method === 'POST' ? 201 : 200;
    return response(statusCode, { request_id: requestId, ...(result as Record<string, unknown>) });
  } catch (error) {
    const appError = error instanceof AppError ? error : new AppError('INTERNAL_ERROR', 'Lỗi hệ thống');
    const status: Record<string, number> = {
      UNAUTHORIZED: 401, PERMISSION_DENIED: 403, TENANT_SUSPENDED: 403,
      INVALID_REQUEST: 400, DUPLICATE_SLUG: 409, NOT_FOUND: 404,
      SITE_UNREACHABLE: 422, VERIFICATION_CODE_MISMATCH: 422, FORBIDDEN: 403,
      VERSION_CONFLICT: 409, CACHE_INVALIDATION_FAILED: 503,
    };
    return response(status[appError.code] ?? 500, {
      request_id: requestId,
      error: { code: appError.code, message: appError.message },
    });
  }
};
}

export const handler = createWebsiteHandler();

async function loadHost(
  ctx: Awaited<ReturnType<typeof contextFromIdTokenClaims>>,
  slug: string,
  dependencies: WebsiteHandlerDependencies,
) {
  const host = await dependencies.getHost(ctx, slug);
  if (!host) throw new AppError('NOT_FOUND', 'Không tìm thấy website');
  return host;
}

function response(statusCode: number, body: Record<string, unknown>) {
  return { statusCode, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: JSON.stringify(body) };
}

function normalizedRequestPath(event: WebsiteEvent): string {
  let path = event.rawPath ?? event.path ?? event.requestContext?.path ?? event.resource ?? '';
  const stagePrefix = event.requestContext?.stage ? `/${event.requestContext.stage}` : '';
  if (stagePrefix && (path === stagePrefix || path.startsWith(`${stagePrefix}/`))) {
    path = path.slice(stagePrefix.length) || '/';
  }
  if (!path.startsWith('/')) path = `/${path}`;
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

/**
 * Kiểm tra xem đường dẫn có trùng khớp chính xác dạng /console/websites/{slug} hoặc /console/hosts/{slug} hay không
 */
function isExactHostDetailRoute(path: string, slug: string): boolean {
  if (!slug) return false;
  const decodedSlug = encodeURIComponent(slug);
  return path === `/console/websites/${slug}` || 
         path === `/console/hosts/${slug}` ||
         path === `/console/websites/${decodedSlug}` || 
         path === `/console/hosts/${decodedSlug}`;
}
