/**
 * Router của Console Lambda (`ConsoleFunction`): API Gateway chuyển mọi `/console` và `/console/{proxy+}`
 * (Cognito User Pool Authorizer) tới handler này, router chuyển tiếp từng nhóm route cho mô-đun tương ứng.
 *
 * Đã đăng ký đầy đủ tất cả các nhóm route Console hiện có trong services/api:
 *  1. Duyệt bản dịch F5 (Task 3.8): `/console/translations*` và `/console/invalidations/*` qua `handleReviewApiGatewayRoute`.
 *  2. Quản lý thuật ngữ F4 (Task 2.8): `/console/glossary*` qua `handleGlossaryApiGatewayRoute`.
 *  3. Quản lý website F3 (Task 4.6): `/console/hosts*` và `/console/websites*` qua `handleSitesApiGatewayRoute`.
 *  4. Dịch trước F6 & Job F10 (Task 4.5): `/console/hosts/{slug}/prewarm` và `/console/jobs/{jobId}` qua `handlePrewarmRoute`.
 *  5. Quản lý thành viên E.5 (Task 2.9): `/console/members*` qua `handleMembersApiGatewayRoute`.
 *
 * Biến môi trường: TABLE_NAME, CLOUDFRONT_DISTRIBUTION_ID, USER_POOL_ARN, TENANT_DATA_ACCESS_ROLE_ARN.
 */
import {
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
  type CreateSiteInput,
  type SiteManagerDependencies,
} from '../sites/siteManager.js';
import {
  handlePrewarmRoute,
  type PrewarmManagerDeps,
} from '../prewarm/prewarmManager.js';
import { inviteMember, type InviteMemberDeps } from '../auth/inviteMember.js';
import { contextFromIdTokenClaims } from '../auth/context.js';
import { db, requireRole } from '../../../libs/common/db.js';
import { AppError, keys, type Ctx } from '../../../libs/common/types.js';

export type ConsoleEvent = ReviewApiGatewayEvent;
export type ConsoleResponse = ReviewApiGatewayResponse;

/** Mô-đun route: trả `null` nếu đường dẫn không thuộc nhóm của mình để router thử tiếp mô-đun sau. */
export type ConsoleRouteModule = (event: ConsoleEvent, ctx: Ctx) => Promise<ConsoleResponse | null>;

const HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function errorResponse(
  statusCode: number,
  code: string,
  message: string,
  requestId: string,
  details?: Record<string, unknown>,
): ConsoleResponse {
  const extra = details?.reason ? { reason: details.reason } : {};
  return {
    statusCode,
    headers: HEADERS,
    body: JSON.stringify({
      request_id: requestId,
      error: {
        code,
        message,
        ...extra,
        ...(details ? { details } : {}),
      },
    }),
  };
}

/** Chuẩn hóa đường dẫn bỏ qua tiền tố stage (ví dụ /dev/console -> /console). */
function normalizeConsolePath(path: string): string {
  const match = path.match(/^(\/[^/]+)?(\/console.*)$/);
  return match ? match[2] : path;
}

/** Ánh xạ mã lỗi ứng dụng sang HTTP status code theo bảng hợp đồng Console. */
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
    case 'DUPLICATE_SLUG':
      return 409;
    case 'INVALID_REQUEST':
    case 'UNSUPPORTED_LANGUAGE':
    case 'PLACEHOLDER_MISMATCH':
    case 'SITE_UNREACHABLE':
    case 'VERIFICATION_NOT_FOUND':
    case 'VERIFICATION_CODE_MISMATCH':
    case 'TOO_MANY_REDIRECTS':
      return 400;
    case 'RATE_LIMITED':
    case 'REQUEST_QUOTA_EXCEEDED':
      return 429;
    case 'CACHE_INVALIDATION_FAILED':
      return 503;
    default:
      return 500;
  }
}

/** Chuẩn hóa thực thể Website / Host theo hợp đồng Console 4.6 (docs/console-website.md, snake_case). */
export interface HostResponse {
  slug: string;
  display_name: string;
  home_url: string;
  source_lang: string;
  target_langs: string[];
  status: 'PENDING' | 'ACTIVE' | 'PAUSED';
  verification_code: string;
  no_translate_selectors: string[];
  created_at: string;
}

export function toHostResponse(item: Record<string, any>): HostResponse {
  const status = item.status === 'ACTIVE' || item.status === 'PAUSED' ? item.status : 'PENDING';
  return {
    slug: String(item.slug ?? ''),
    display_name: String(item.displayName ?? item.display_name ?? item.slug ?? ''),
    home_url: String(item.homeUrl ?? item.home_url ?? ''),
    source_lang: String(item.sourceLang ?? item.source_lang ?? ''),
    target_langs: Array.isArray(item.targetLangs ?? item.target_langs)
      ? (item.targetLangs ?? item.target_langs).map(String)
      : [],
    status,
    verification_code: String(item.verificationCode ?? item.verification_code ?? ''),
    no_translate_selectors: Array.isArray(item.noTranslateSelectors ?? item.no_translate_selectors)
      ? (item.noTranslateSelectors ?? item.no_translate_selectors).map(String)
      : [],
    created_at: String(item.createdAt ?? item.created_at ?? ''),
  };
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
  } catch (err: any) {
    if (err instanceof AppError) {
      const statusCode = statusForConsoleError(err.code);
      return errorResponse(statusCode, err.code, err.message, requestId, err.details);
    }
    return errorResponse(500, 'INTERNAL_ERROR', 'Lỗi tạm thời phía hệ thống.', requestId);
  }
}

export type SiteRouteDeps = SiteManagerDependencies & {
  db?: SiteManagerDependencies['db'] & {
    listTenantSites?: (ctx: Ctx) => Promise<Array<Record<string, any>>>;
    query?: (ctx: Ctx, pk: string, skPrefix?: string, opts?: any) => Promise<Array<Record<string, any>>>;
  };
};

/**
 * 2. Adapter HTTP cho nhóm route Quản lý Website F3 (`/console/hosts*` và alias `/console/websites*`).
 */
export async function handleSitesApiGatewayRoute(
  event: ConsoleEvent,
  ctx: Ctx,
  deps?: SiteRouteDeps,
): Promise<ConsoleResponse | null> {
  const rawPath = event.path ?? (event as { rawPath?: string }).rawPath ?? '';
  const path = normalizeConsolePath(rawPath);
  const isHosts = path === '/console/hosts' || path.startsWith('/console/hosts/');
  const isWebsites = path === '/console/websites' || path.startsWith('/console/websites/');
  if (!isHosts && !isWebsites) {
    return null;
  }

  // Nhường quyền cho handlePrewarmRoute xử lý các endpoint dịch trước
  if (path.endsWith('/prewarm') || path.includes('/prewarm/')) {
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
    // GET /console/hosts hoặc /console/websites -> danh sách website (chỉ dành cho TENANT_ADMIN)
    if (method === 'GET' && (subPath === '' || subPath === '/')) {
      requireRole(ctx, ['TENANT_ADMIN']);
      const queryFn = deps?.db?.listTenantSites ?? db.listTenantSites;
      const rawItems = await queryFn(ctx);
      const hosts = (rawItems ?? []).map(toHostResponse);
      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({ request_id: requestId, hosts }),
      };
    }

    // POST /console/hosts hoặc /console/websites -> tạo website mới (trả 201 { host })
    if (method === 'POST' && (subPath === '' || subPath === '/')) {
      requireRole(ctx, ['TENANT_ADMIN']);
      const createInput: CreateSiteInput = {
        homeUrl: String(body.home_url ?? body.homeUrl ?? ''),
        displayName: String(body.display_name ?? body.displayName ?? ''),
        sourceLang: String(body.source_lang ?? body.sourceLang ?? ''),
        targetLangs: Array.isArray(body.target_langs ?? body.targetLangs)
          ? (body.target_langs ?? body.targetLangs).map(String)
          : [],
        noTranslateSelectors: Array.isArray(body.no_translate_selectors ?? body.noTranslateSelectors)
          ? (body.no_translate_selectors ?? body.noTranslateSelectors).map(String)
          : [],
      };

      const created = await createSite(ctx, createInput, deps);
      const host: HostResponse = {
        slug: created.slug,
        display_name: createInput.displayName,
        home_url: createInput.homeUrl,
        source_lang: createInput.sourceLang,
        target_langs: createInput.targetLangs,
        status: created.status,
        verification_code: created.verificationCode,
        no_translate_selectors: createInput.noTranslateSelectors ?? [],
        created_at: new Date().toISOString(),
      };

      return {
        statusCode: 201,
        headers: HEADERS,
        body: JSON.stringify({
          request_id: requestId,
          host,
        }),
      };
    }

    // POST /console/hosts/{slug}/verify hoặc /console/websites/{slug}/verify
    const verifyMatch = subPath.match(/^\/([^/]+)\/verify\/?$/);
    if (method === 'POST' && verifyMatch) {
      requireRole(ctx, ['TENANT_ADMIN']);
      const slug = decodeURIComponent(verifyMatch[1]);
      const rawMethod = body.method;
      if (rawMethod !== 'FILE' && rawMethod !== 'META') {
        throw new AppError('INVALID_REQUEST', 'Phương thức xác minh phải là FILE hoặc META.');
      }
      const verifyMethod = rawMethod as 'META' | 'FILE';
      try {
        const verified = await verifySite(ctx, slug, verifyMethod, deps);
        const getFn = deps?.db?.get ?? db.get;
        const rawHost = await getFn(ctx, keys.host(ctx, slug));
        const host = rawHost ? toHostResponse(rawHost) : { slug, status: 'ACTIVE' as const };
        return {
          statusCode: 200,
          headers: HEADERS,
          body: JSON.stringify({ request_id: requestId, ...verified, host }),
        };
      } catch (err: any) {
        if (err instanceof AppError) {
          const isVerificationError =
            err.code === 'SITE_UNREACHABLE' ||
            err.code === 'VERIFICATION_CODE_MISMATCH' ||
            err.code === 'VERIFICATION_NOT_FOUND';
          if (isVerificationError) {
            const reason = (err.details?.reason as string) ?? err.code;
            return errorResponse(400, 'VERIFICATION_FAILED', err.message, requestId, {
              reason,
              code: err.code,
              ...(err.details ?? {}),
            });
          }
          const statusCode = statusForConsoleError(err.code);
          return errorResponse(statusCode, err.code, err.message, requestId, err.details);
        }
        return errorResponse(500, 'INTERNAL_ERROR', 'Lỗi tạm thời phía hệ thống.', requestId);
      }
    }

    // POST /console/hosts/{slug}/pause hoặc /console/websites/{slug}/pause
    const pauseMatch = subPath.match(/^\/([^/]+)\/pause\/?$/);
    if (method === 'POST' && pauseMatch) {
      requireRole(ctx, ['TENANT_ADMIN']);
      const slug = decodeURIComponent(pauseMatch[1]);
      const paused = await pauseSite(ctx, slug, deps);
      const getFn = deps?.db?.get ?? db.get;
      const rawHost = await getFn(ctx, keys.host(ctx, slug));
      const host = rawHost ? toHostResponse(rawHost) : { slug, status: 'PAUSED' as const };
      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({ request_id: requestId, ...paused, host }),
      };
    }

    // POST /console/hosts/{slug}/resume hoặc /console/websites/{slug}/resume
    const resumeMatch = subPath.match(/^\/([^/]+)\/resume\/?$/);
    if (method === 'POST' && resumeMatch) {
      requireRole(ctx, ['TENANT_ADMIN']);
      const slug = decodeURIComponent(resumeMatch[1]);
      const resumed = await resumeSite(ctx, slug, deps);
      const getFn = deps?.db?.get ?? db.get;
      const rawHost = await getFn(ctx, keys.host(ctx, slug));
      const host = rawHost ? toHostResponse(rawHost) : { slug, status: 'ACTIVE' as const };
      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({ request_id: requestId, ...resumed, host }),
      };
    }

    // GET /console/hosts/{slug} hoặc /console/websites/{slug} -> chi tiết website
    const getHostMatch = subPath.match(/^\/([^/]+)\/?$/);
    if (method === 'GET' && getHostMatch && getHostMatch[1]) {
      requireRole(ctx, ['TENANT_ADMIN']);
      const slug = decodeURIComponent(getHostMatch[1]);
      const getFn = deps?.db?.get ?? db.get;
      const rawHost = await getFn(ctx, keys.host(ctx, slug));
      if (!rawHost) {
        return errorResponse(404, 'NOT_FOUND', 'Không tìm thấy website.', requestId);
      }
      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({ request_id: requestId, host: toHostResponse(rawHost) }),
      };
    }

    return errorResponse(404, 'NOT_FOUND', 'Không tìm thấy endpoint website.', requestId);
  } catch (err: any) {
    if (err instanceof AppError) {
      const statusCode = statusForConsoleError(err.code);
      return errorResponse(statusCode, err.code, err.message, requestId, err.details);
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

    // POST /console/members hoặc POST /console/members/invite -> mời thành viên mới (chỉ dành cho TENANT_ADMIN)
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
      return errorResponse(statusCode, err.code, err.message, requestId, err.details);
    }
    if (
      err?.name === 'UsernameExistsException' ||
      err?.name === 'ConditionalCheckFailedException' ||
      err?.Code === 'UsernameExistsException' ||
      err?.Code === 'ConditionalCheckFailedException'
    ) {
      return errorResponse(409, 'VERSION_CONFLICT', 'Thành viên đã tồn tại trên hệ thống.', requestId);
    }
    return errorResponse(500, 'INTERNAL_ERROR', 'Lỗi tạm thời phía hệ thống.', requestId);
  }
}

/** Dependencies mặc định cho dịch trước theo sitemap (F6) và tra cứu job (F10). */
export const defaultPrewarmDeps: PrewarmManagerDeps = {
  db,
  startExecution: async (input) => {
    return { executionArn: `arn:aws:states:local:execution:prewarm:${input.name}` };
  },
};

/** Xây dựng danh sách mô-đun route mặc định của Console Lambda (hợp nhất đầy đủ 5 nhóm route). */
export function buildConsoleRouteModules(
  prewarmDeps: PrewarmManagerDeps = defaultPrewarmDeps,
): readonly ConsoleRouteModule[] {
  return [
    (event, ctx) => handleReviewApiGatewayRoute(event, ctx),
    (event, ctx) => handleGlossaryApiGatewayRoute(event, ctx),
    (event, ctx) => handleSitesApiGatewayRoute(event, ctx),
    (event, ctx) => handlePrewarmRoute(event, ctx, prewarmDeps),
    (event, ctx) => handleMembersApiGatewayRoute(event, ctx),
  ];
}

/** Danh sách các mô-đun route mặc định của Console Lambda (hợp nhất đầy đủ 5 nhóm). */
export const CONSOLE_ROUTE_MODULES: readonly ConsoleRouteModule[] = buildConsoleRouteModules();

export interface ConsoleHandlerDeps {
  contextFromClaims?: (claims: Record<string, unknown>, requestId: string) => Promise<Ctx>;
  db?: Pick<typeof db, 'get'>;
  prewarmDeps?: PrewarmManagerDeps;
}

export function createConsoleHandler(
  modules?: readonly ConsoleRouteModule[],
  deps?: ConsoleHandlerDeps,
) {
  const effectiveModules =
    modules ?? (deps?.prewarmDeps ? buildConsoleRouteModules(deps.prewarmDeps) : CONSOLE_ROUTE_MODULES);
  return async (event: ConsoleEvent): Promise<ConsoleResponse> => {
    const requestId = event.requestContext?.requestId ?? 'req-unknown';
    let ctx: Ctx;
    try {
      const claims =
        event.requestContext?.authorizer?.claims ??
        event.requestContext?.authorizer?.jwt?.claims ??
        {};
      const resolveContext =
        deps?.contextFromClaims ??
        ((c, r) => contextFromIdTokenClaims(c, r, deps?.db ? { db: deps.db } : undefined));
      ctx = await resolveContext(claims as Record<string, unknown>, requestId);
    } catch (err: any) {
      if (err instanceof AppError) {
        const statusCode = statusForConsoleError(err.code);
        return errorResponse(statusCode, err.code, err.message, requestId);
      }
      return errorResponse(500, 'INTERNAL_ERROR', 'Lỗi tạm thời phía hệ thống.', requestId);
    }
    try {
      for (const route of effectiveModules) {
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
