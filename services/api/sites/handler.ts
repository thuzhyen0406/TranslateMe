import { AppError, keys } from '../../../libs/common/types.js';
import { db } from '../../../libs/common/db.js';
import { contextFromIdTokenClaims } from '../auth/context.js';
import { createSite, pauseSite, resumeSite, verifySite } from './siteManager.js';

type WebsiteEvent = {
  httpMethod?: string;
  path?: string;
  rawPath?: string;
  requestContext?: { requestId?: string; authorizer?: { claims?: Record<string, unknown> } };
  pathParameters?: Record<string, string | undefined>;
  body?: string | null;
};

export async function handler(event: WebsiteEvent) {
  const requestId = event.requestContext?.requestId ?? 'unknown';
  try {
    const claims = event.requestContext?.authorizer?.claims ?? {};
    const claimTenantId = claims['custom:tenant_id'];
    if (typeof claimTenantId !== 'string' || !/^t_[A-Za-z0-9_-]{1,64}$/.test(claimTenantId)) {
      throw new AppError('UNAUTHORIZED', 'Thông tin tenant không hợp lệ');
    }
    const ctx = await contextFromIdTokenClaims(claims, requestId);
    if (ctx.role !== 'TENANT_ADMIN') {
      throw new AppError('PERMISSION_DENIED', 'Chỉ Tenant Admin được quản lý website');
    }

    const path = event.rawPath ?? event.path ?? '';
    const method = event.httpMethod ?? 'GET';
    const slug = event.pathParameters?.slug ?? event.pathParameters?.proxy?.split('/').filter(Boolean)[0] ?? path.split('/').filter(Boolean)[2];
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(event.body ?? '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid body');
      body = parsed as Record<string, unknown>;
    } catch {
      throw new AppError('INVALID_REQUEST', 'Body không hợp lệ');
    }
    if ('tenantId' in body || 'tenant_id' in body) {
      throw new AppError('INVALID_REQUEST', 'Không được gửi tenantId trong body');
    }

    let result: unknown;
    if (path === '/console/websites' && method === 'GET') {
      const sites = await db.listTenantSites(ctx);
      result = { websites: sites };
    } else if (path === '/console/websites' && method === 'POST') {
      if (
        typeof body.homeUrl !== 'string' || typeof body.displayName !== 'string' ||
        typeof body.sourceLang !== 'string' || !Array.isArray(body.targetLangs) ||
        !body.targetLangs.every((language) => typeof language === 'string')
      ) {
        throw new AppError('INVALID_REQUEST', 'Thiếu hoặc sai kiểu thông tin website');
      }
      result = await createSite(ctx, body as never);
    } else if (!slug) {
      throw new AppError('NOT_FOUND', 'Không tìm thấy website');
    } else if (path.endsWith('/verify') && method === 'POST') {
      if (body.method !== 'META' && body.method !== 'FILE') throw new AppError('INVALID_REQUEST', 'method phải là META hoặc FILE');
      result = await verifySite(ctx, slug, body.method);
    } else if (path.endsWith('/pause') && method === 'PATCH') {
      result = await pauseSite(ctx, slug);
    } else if (path.endsWith('/resume') && method === 'PATCH') {
      result = await resumeSite(ctx, slug);
    } else if (method === 'GET') {
      const site = await db.get(ctx, keys.host(ctx, slug));
      if (!site) throw new AppError('NOT_FOUND', 'Không tìm thấy website');
      result = { website: site };
    } else {
      throw new AppError('NOT_FOUND', 'Không tìm thấy endpoint');
    }
    const statusCode = path === '/console/websites' && method === 'POST' ? 201 : 200;
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
}

function response(statusCode: number, body: Record<string, unknown>) {
  return { statusCode, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: JSON.stringify(body) };
}
