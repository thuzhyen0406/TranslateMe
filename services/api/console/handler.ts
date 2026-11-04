/**
 * Router của Console Lambda (`ConsoleFunction`): API Gateway chuyển mọi `/console` và `/console/{proxy+}`
 * (Cognito User Pool Authorizer) tới handler này, router chuyển tiếp từng nhóm route cho mô-đun tương ứng.
 *
 * Đã đăng ký đầy đủ tất cả các nhóm route Console hiện có trong services/api:
 *  1. Duyệt bản dịch F5 (Task 3.8): `/console/translations*` và `/console/invalidations/*` qua `handleReviewApiGatewayRoute`.
 *  2. Quản lý thuật ngữ F4 (Task 2.8): `/console/glossary*` qua `handleGlossaryApiGatewayRoute`.
 *  3. Quản lý website F3 (Task 4.6): `/console/hosts*` và `/console/websites*` qua `handleSitesApiGatewayRoute`.
 *  4. Quản lý thành viên E.5 (Task 2.9): `/console/members*` qua `handleMembersApiGatewayRoute`.
 *
 * Biến môi trường: TABLE_NAME, CLOUDFRONT_DISTRIBUTION_ID, USER_POOL_ARN, TENANT_DATA_ACCESS_ROLE_ARN.
 */
import {
  extractReviewCtxFromEvent,
  handleReviewApiGatewayRoute,
  type ReviewApiGatewayEvent,
  type ReviewApiGatewayResponse,
} from '../review/reviewManager.js';
import { handleGlossaryRoute, type GlossaryDependencies } from '../glossary/glossaryManager.js';
import {
  createSite,
  verifySite,
  pauseSite,
  resumeSite,
  type SiteManagerDependencies,
} from '../sites/siteManager.js';
import { inviteMember, type InviteMemberDeps } from '../auth/inviteMember.js';
import { db, requireRole } from '../../../libs/common/db.js';
import { AppError, type Ctx } from '../../../libs/common/types.js';

export type ConsoleEvent = ReviewApiGatewayEvent;
export type ConsoleResponse = ReviewApiGatewayResponse;

/** Mô-đun route: trả `null` nếu đường dẫn không thuộc nhóm của mình để router thử tiếp mô-đun sau. */
export type ConsoleRouteModule = (event: ConsoleEvent, ctx: Ctx) => Promise<ConsoleResponse | null>;

const HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function errorResponse(statusCode: number, code: string, message: string, requestId: string): ConsoleResponse {
  return { statusCode, headers: HEADERS, body: JSON.stringify({ request_id: requestId, error: { code, message } }) };
}

function normalizeConsolePath(rawPath?: string): string {
  const trimmed = (rawPath ?? '').trim();
  const idx = trimmed.indexOf('/console/');
  if (idx !== -1) return trimmed.slice(idx);
  if (trimmed.endsWith('/console')) return '/console';
  return trimmed;
}

function statusForConsoleError(code: string): number {
  switch (code) {
    case 'UNAUTHORIZED':
      return 401;
    case 'FORBIDDEN':
    case 'PERMISSION_DENIED':
    case 'TENANT_SUSPENDED':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'VERSION_CONFLICT':
      return 409;
    case 'INVALID_REQUEST':
    case 'UNSUPPORTED_LANGUAGE':
      return 400;
    default:
      return 500;
  }
}

/**
 * 1. Adapter HTTP cho nhóm route Quản lý thuật ngữ F4 (`/console/glossary*`).
 */
export async function handleGlossaryApiGatewayRoute(
  event: ConsoleEvent,
  ctx: Ctx,
  deps?: GlossaryDependencies,
): Promise<ConsoleResponse | null> {
  const rawPath = event.path ?? (event as { rawPath?: string }).rawPath ?? '';
  const path = normalizeConsolePath(rawPath);
  if (path !== '/console/glossary' && !path.startsWith('/console/glossary/')) {
    return null;
  }

  const requestId = event.requestContext?.requestId ?? 'req-unknown';
  const method = (event.httpMethod ?? event.requestContext?.http?.method ?? 'GET').toUpperCase() as
    | 'GET'
    | 'PUT'
    | 'DELETE'
    | 'POST';

  let body: Record<string, any> | undefined;
  if (event.body) {
    try {
      body = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body as Record<string, any>);
    } catch {
      return errorResponse(400, 'INVALID_REQUEST', 'Body yêu cầu không đúng định dạng JSON.', requestId);
    }
  }

  try {
    const data = await handleGlossaryRoute(ctx, { method, path, body }, deps);
    const payload =
      data && typeof data === 'object' && !Array.isArray(data)
        ? { request_id: requestId, ...data }
        : { request_id: requestId, data };
    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify(payload),
    };
  } catch (err) {
    if (err instanceof AppError) {
      const statusCode = statusForConsoleError(err.code);
      return errorResponse(statusCode, err.code, err.message, requestId);
    }
    return errorResponse(500, 'INTERNAL_ERROR', 'Lỗi tạm thời phía hệ thống.', requestId);
  }
}

/**
 * 2. Adapter HTTP cho nhóm route Quản lý Website / Hosts F3 (`/console/hosts*`, `/console/websites*`).
 */
export async function handleSitesApiGatewayRoute(
  event: ConsoleEvent,
  ctx: Ctx,
  deps?: SiteManagerDependencies,
): Promise<ConsoleResponse | null> {
  const rawPath = event.path ?? (event as { rawPath?: string }).rawPath ?? '';
  const path = normalizeConsolePath(rawPath);
  const isHosts = path === '/console/hosts' || path.startsWith('/console/hosts/');
  const isWebsites = path === '/console/websites' || path.startsWith('/console/websites/');
  if (!isHosts && !isWebsites) {
    return null;
  }

  const requestId = event.requestContext?.requestId ?? 'req-unknown';
  const method = (event.httpMethod ?? event.requestContext?.http?.method ?? 'GET').toUpperCase();
  const subPath = isHosts ? path.slice('/console/hosts'.length) : path.slice('/console/websites'.length);

  let body: Record<string, any> = {};
  if (event.body) {
    try {
      body = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body as Record<string, any>);
    } catch {
      return errorResponse(400, 'INVALID_REQUEST', 'Body yêu cầu không đúng định dạng JSON.', requestId);
    }
  }

  try {
    // GET /console/hosts hoặc /console/websites -> danh sách website
    if (method === 'GET' && (subPath === '' || subPath === '/')) {
      const items = await db.listTenantSites(ctx);
      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({ request_id: requestId, items, hosts: items, websites: items }),
      };
    }

    // POST /console/hosts hoặc /console/websites -> tạo website mới
    if (method === 'POST' && (subPath === '' || subPath === '/')) {
      const created = await createSite(ctx, body as any, deps);
      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({ request_id: requestId, ...created }),
      };
    }

    // POST /console/hosts/{slug}/verify
    const verifyMatch = subPath.match(/^\/([^/]+)\/verify\/?$/);
    if (method === 'POST' && verifyMatch) {
      const slug = decodeURIComponent(verifyMatch[1]);
      const verifyMethod = (body.method === 'FILE' ? 'FILE' : 'META') as 'META' | 'FILE';
      const verified = await verifySite(ctx, slug, verifyMethod, deps);
      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({ request_id: requestId, ...verified }),
      };
    }

    // POST /console/hosts/{slug}/pause
    const pauseMatch = subPath.match(/^\/([^/]+)\/pause\/?$/);
    if (method === 'POST' && pauseMatch) {
      const slug = decodeURIComponent(pauseMatch[1]);
      const paused = await pauseSite(ctx, slug, deps);
      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({ request_id: requestId, ...paused }),
      };
    }

    // POST /console/hosts/{slug}/resume
    const resumeMatch = subPath.match(/^\/([^/]+)\/resume\/?$/);
    if (method === 'POST' && resumeMatch) {
      const slug = decodeURIComponent(resumeMatch[1]);
      const resumed = await resumeSite(ctx, slug, deps);
      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({ request_id: requestId, ...resumed }),
      };
    }

    return errorResponse(404, 'NOT_FOUND', 'Không tìm thấy endpoint website.', requestId);
  } catch (err) {
    if (err instanceof AppError) {
      const statusCode = statusForConsoleError(err.code);
      return errorResponse(statusCode, err.code, err.message, requestId);
    }
    return errorResponse(500, 'INTERNAL_ERROR', 'Lỗi tạm thời phía hệ thống.', requestId);
  }
}

/**
 * 3. Adapter HTTP cho nhóm route Quản lý Thành viên E.5 (`/console/members*`).
 */
export type MemberRouteDeps = InviteMemberDeps & {
  db?: {
    query?: (
      ctx: Ctx,
      pk: string,
      skPrefix?: string,
      opts?: { consistent?: boolean },
    ) => Promise<any[]>;
  };
};

export async function handleMembersApiGatewayRoute(
  event: ConsoleEvent,
  ctx: Ctx,
  deps?: MemberRouteDeps,
): Promise<ConsoleResponse | null> {
  const rawPath = event.path ?? (event as { rawPath?: string }).rawPath ?? '';
  const path = normalizeConsolePath(rawPath);
  if (path !== '/console/members' && !path.startsWith('/console/members/')) {
    return null;
  }

  const requestId = event.requestContext?.requestId ?? 'req-unknown';
  const method = (event.httpMethod ?? event.requestContext?.http?.method ?? 'GET').toUpperCase();
  const subPath = path.slice('/console/members'.length);

  let body: Record<string, any> = {};
  if (event.body) {
    try {
      body = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body as Record<string, any>);
    } catch {
      return errorResponse(400, 'INVALID_REQUEST', 'Body yêu cầu không đúng định dạng JSON.', requestId);
    }
  }

  try {
    // GET /console/members -> lấy danh sách thành viên của tenant (chỉ dành cho TENANT_ADMIN)
    if (method === 'GET' && (subPath === '' || subPath === '/')) {
      requireRole(ctx, ['TENANT_ADMIN']);
      const queryFn = deps?.db?.query ?? db.query;
      const items = await queryFn(ctx, `TENANT#${ctx.tenantId}`, 'MEMBER#', { consistent: true });
      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({ request_id: requestId, items }),
      };
    }

    // POST /console/members hoặc POST /console/members/invite -> mời thành viên mới
    if (method === 'POST' && (subPath === '' || subPath === '/' || subPath === '/invite' || subPath === '/invite/')) {
      requireRole(ctx, ['TENANT_ADMIN']);
      const email = typeof body.email === 'string' ? body.email : '';
      const role = typeof body.role === 'string' ? body.role : '';
      const userPoolId =
        deps?.userPoolId ??
        process.env.USER_POOL_ID ??
        (process.env.USER_POOL_ARN ? process.env.USER_POOL_ARN.split('/').pop() : undefined);

      const invited = await inviteMember(ctx.tenantId, email, role, {
        ...deps,
        userPoolId,
      });

      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({ request_id: requestId, ...invited }),
      };
    }

    return errorResponse(404, 'NOT_FOUND', 'Không tìm thấy endpoint thành viên.', requestId);
  } catch (err: any) {
    if (err instanceof AppError) {
      const statusCode = statusForConsoleError(err.code);
      return errorResponse(statusCode, err.code, err.message, requestId);
    }
    if (err?.name === 'UsernameExistsException' || err?.message?.includes('tồn tại')) {
      return errorResponse(409, 'VERSION_CONFLICT', 'Thành viên đã tồn tại trên hệ thống.', requestId);
    }
    return errorResponse(400, 'INVALID_REQUEST', err?.message ?? 'Yêu cầu không hợp lệ', requestId);
  }
}

/** Danh sách các mô-đun route mặc định của Console Lambda (hợp nhất đầy đủ 4 nhóm). */
export const CONSOLE_ROUTE_MODULES: readonly ConsoleRouteModule[] = [
  (event, ctx) => handleReviewApiGatewayRoute(event, ctx),
  (event, ctx) => handleGlossaryApiGatewayRoute(event, ctx),
  (event, ctx) => handleSitesApiGatewayRoute(event, ctx),
  (event, ctx) => handleMembersApiGatewayRoute(event, ctx),
];

export function createConsoleHandler(modules: readonly ConsoleRouteModule[] = CONSOLE_ROUTE_MODULES) {
  return async (event: ConsoleEvent): Promise<ConsoleResponse> => {
    const requestId = event.requestContext?.requestId ?? 'req-unknown';
    let ctx: Ctx;
    try {
      ctx = extractReviewCtxFromEvent(event);
    } catch (err) {
      if (err instanceof AppError) return errorResponse(401, err.code, err.message, requestId);
      return errorResponse(500, 'INTERNAL_ERROR', 'Lỗi tạm thời phía hệ thống.', requestId);
    }
    try {
      for (const route of modules) {
        const response = await route(event, ctx);
        if (response) return response;
      }
      return errorResponse(404, 'NOT_FOUND', 'Không tìm thấy endpoint.', requestId);
    } catch {
      return errorResponse(500, 'INTERNAL_ERROR', 'Lỗi tạm thời phía hệ thống.', requestId);
    }
  };
}

/** Điểm vào Lambda: `services/api/console/handler.handler` (tham số ConsoleHandler trong infra/modules/lambdas.yaml). */
export const handler = createConsoleHandler();
