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
 *  6. Quản lý API key (Task 3.6): `/console/api-keys*` qua `handleApiKeysApiGatewayRoute` (`handleApiKeyRoute`).
 *
 * Biến môi trường: TABLE_NAME, CLOUDFRONT_DISTRIBUTION_ID, USER_POOL_ARN, TENANT_DATA_ACCESS_ROLE_ARN.
 */
import {
  handleReviewApiGatewayRoute,
  type ReviewApiGatewayEvent,
  type ReviewApiGatewayResponse,
} from '../review/reviewManager.js';
import { handleGlossaryRoute, type GlossaryDependencies } from '../glossary/glossaryManager.js';
import { handleApiKeyRoute, type ApiKeyManagerDependencies } from '../keys/keyManager.js';
import {
  createSite,
  verifySite,
  pauseSite,
  resumeSite,
  type CreateSiteInput,
  type SiteManagerDependencies,
} from '../sites/siteManager.js';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import {
  handlePrewarmRoute,
  stepFunctionsStarter,
  type PrewarmManagerDeps,
} from '../prewarm/prewarmManager.js';
import { inviteMember, type InviteMemberDeps } from '../auth/inviteMember.js';
import { contextFromIdTokenClaims } from '../auth/context.js';
import { db, requireRole } from '../../../libs/common/db.js';
import { withCors } from '../../../libs/common/cors.js';
import { monthUtc, usageKeys } from '../../../libs/common/usage/usage.js';
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
        const rawHost = await getFn(ctx, keys.host(ctx, slug), { consistent: true });
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

let defaultSfnClient: SFNClient | undefined;
function getSfnClient(): SFNClient {
  if (!defaultSfnClient) {
    defaultSfnClient = new SFNClient({});
  }
  return defaultSfnClient;
}

/**
 * Tạo hàm startExecution kết nối Step Functions thật qua SFNClient.
 * Nếu chưa cấu hình PREWARM_STATE_MACHINE_ARN, hàm ném lỗi CONFIG_ERROR
 * để startPrewarm đánh dấu JOB là FAILED (START_FAILED) và router trả về HTTP 500,
 * thay vì trả mã 202 giả lập và để JOB kẹt ở QUEUED.
 */
export function createDefaultPrewarmStarter(
  stateMachineArn: string | undefined = process.env.PREWARM_STATE_MACHINE_ARN,
  client?: SFNClient,
): (input: { name: string; input: string }) => Promise<{ executionArn?: string }> {
  return async (input: { name: string; input: string }): Promise<{ executionArn?: string }> => {
    const arn = stateMachineArn?.trim() || process.env.PREWARM_STATE_MACHINE_ARN?.trim();
    if (!arn) {
      throw new AppError(
        'INTERNAL_ERROR',
        'Tính năng dịch trước chưa được cấu hình state machine (thiếu biến môi trường PREWARM_STATE_MACHINE_ARN).',
      );
    }
    const starter = stepFunctionsStarter(client ?? getSfnClient(), StartExecutionCommand, arn);
    return starter(input);
  };
}

/**
 * 4. Adapter HTTP cho nhóm route Quản lý API key (`/console/api-keys*`).
 * Trả `null` nếu đường dẫn không thuộc `/console/api-keys` để router thử tiếp mô-đun sau.
 */
export async function handleApiKeysApiGatewayRoute(
  event: ConsoleEvent,
  ctx: Ctx,
  deps?: ApiKeyManagerDependencies,
): Promise<ConsoleResponse | null> {
  const rawPath = event.path ?? (event as { rawPath?: string }).rawPath ?? '';
  const path = normalizeConsolePath(rawPath);
  if (path !== '/console/api-keys' && !path.startsWith('/console/api-keys/')) {
    return null;
  }
  return handleApiKeyRoute({ ...event, path }, ctx, deps);
}

/** Dependencies mặc định cho dịch trước theo sitemap (F6) và tra cứu job (F10). */
export const defaultPrewarmDeps: PrewarmManagerDeps = {
  db,
  startExecution: createDefaultPrewarmStarter(),
};

/** Xây dựng danh sách mô-đun route mặc định của Console Lambda (hợp nhất đầy đủ 6 nhóm route). */
export function buildConsoleRouteModules(
  prewarmDeps: PrewarmManagerDeps = defaultPrewarmDeps,
  apiKeyDeps?: ApiKeyManagerDependencies,
): readonly ConsoleRouteModule[] {
  return [
    (event, ctx) => handleReviewApiGatewayRoute(event, ctx),
    (event, ctx) => handleGlossaryApiGatewayRoute(event, ctx),
    (event, ctx) => handleSitesApiGatewayRoute(event, ctx),
    (event, ctx) => handlePrewarmRoute(event, ctx, prewarmDeps),
    (event, ctx) => handleMembersApiGatewayRoute(event, ctx),
    (event, ctx) => handleApiKeysApiGatewayRoute(event, ctx, apiKeyDeps),
  ];
}

/** Danh sách các mô-đun route mặc định của Console Lambda (hợp nhất đầy đủ 6 nhóm). */
export const CONSOLE_ROUTE_MODULES: readonly ConsoleRouteModule[] = buildConsoleRouteModules();

/** Dependencies cho endpoint danh tính & trạng thái tenant (`GET /console/me`). */
export interface ConsoleMeDeps {
  db?: Pick<typeof db, 'get'>;
}

/**
 * Adapter HTTP cho `GET /console/me`: trả về danh tính, vai trò hiện hành và
 * trạng thái khóa/hoạt động từ bản ghi `CONFIG` của tenant để Console bật/tắt thao tác ghi fail-closed.
 * Mọi vai trò hợp lệ (`TENANT_ADMIN`, `DEVELOPER`, `REVIEWER`) đều đọc được kể cả khi tenant đang `LOCKED`.
 */
export async function handleConsoleMeApiGatewayRoute(
  event: ConsoleEvent,
  ctx: Ctx,
  deps?: ConsoleMeDeps,
): Promise<ConsoleResponse | null> {
  const rawPath = event.path ?? (event as { rawPath?: string }).rawPath ?? '';
  const path = normalizeConsolePath(rawPath);
  if (path !== '/console/me' && path !== '/console/me/') {
    return null;
  }

  const requestId = event.requestContext?.requestId ?? 'req-unknown';
  const method = (event.httpMethod ?? event.requestContext?.http?.method ?? 'GET').toUpperCase();
  if (method !== 'GET') {
    return errorResponse(404, 'NOT_FOUND', 'Không tìm thấy endpoint.', requestId);
  }

  try {
    requireRole(ctx, ['TENANT_ADMIN', 'DEVELOPER', 'REVIEWER']);
    const getFn = deps?.db?.get ?? db.get;
    const config = await getFn(ctx, keys.config(ctx), { consistent: true });
    if (!config) {
      return errorResponse(404, 'NOT_FOUND', 'Không tìm thấy thông tin tổ chức.', requestId);
    }

    const rawStatus = typeof config.status === 'string' ? config.status.trim().toUpperCase() : '';
    if (rawStatus !== 'ACTIVE' && rawStatus !== 'LOCKED') {
      return errorResponse(500, 'INTERNAL_ERROR', 'Trạng thái tổ chức không hợp lệ.', requestId);
    }

    const tenantStatus: 'ACTIVE' | 'LOCKED' = rawStatus;
    const payload: Record<string, unknown> = {
      request_id: requestId,
      tenant_id: ctx.tenantId,
      role: ctx.role,
      tenant_status: tenantStatus,
      tenant_locked: tenantStatus === 'LOCKED',
    };
    if (typeof config.organizationName === 'string' && config.organizationName.trim()) {
      payload.organization_name = config.organizationName;
    }
    if (typeof config.plan === 'string' && config.plan.trim()) {
      payload.plan = config.plan;
    }
    const rawLimit = config.characterLimit ?? config.charLimit ?? config.character_limit;
    if (typeof rawLimit === 'number' && Number.isSafeInteger(rawLimit) && rawLimit >= 0) {
      payload.character_limit = rawLimit;
    }

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

async function handleConsoleUsageRoute(
  event: ConsoleEvent,
  ctx: Ctx,
  usageDb: Pick<typeof db, 'get'>,
): Promise<ConsoleResponse | null> {
  const path = normalizeConsolePath(event.path ?? event.rawPath ?? '').replace(/\/$/, '');
  if (path !== '/console/usage') return null;
  const requestId = event.requestContext?.requestId ?? ctx.requestId;
  if ((event.httpMethod ?? event.requestContext?.http?.method ?? 'GET').toUpperCase() !== 'GET') {
    return errorResponse(404, 'NOT_FOUND', 'Không tìm thấy endpoint.', requestId);
  }
  try {
    requireRole(ctx, ['TENANT_ADMIN', 'DEVELOPER']);
    const month = event.queryStringParameters?.month ?? monthUtc();
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      throw new AppError('INVALID_REQUEST', 'month phải có định dạng YYYY-MM.');
    }
    const { total } = usageKeys(ctx.tenantId, month, { kind: 'CONSOLE' });
    const usage = await usageDb.get(ctx, total, { consistent: true });
    const fromMemory = Number(usage?.sentFromTM ?? usage?.memoryChars ?? 0);
    const quotaUsed = Number(usage?.machineChars ?? 0);
    const rawLimit =
      usage?.characterLimit ??
      usage?.charLimit ??
      usage?.character_limit ??
      usage?.limit;
    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({
        request_id: requestId,
        tenant_id: ctx.tenantId,
        month,
        chars_machine_translated: usage?.sentTotal === undefined ? quotaUsed : Math.max(0, Number(usage.sentTotal) - fromMemory),
        chars_from_memory: fromMemory,
        chars_quota_used: quotaUsed,
        requests: Number(usage?.requests ?? 0),
        pages_served: Number(usage?.pagesServed ?? 0),
        ...(typeof rawLimit === 'number' && Number.isSafeInteger(rawLimit) && rawLimit >= 0
          ? { character_limit: rawLimit }
          : {}),
      }),
    };
  } catch (error) {
    if (error instanceof AppError) return errorResponse(statusForConsoleError(error.code), error.code, error.message, requestId);
    return errorResponse(500, 'INTERNAL_ERROR', 'Lỗi tạm thời phía hệ thống.', requestId);
  }
}

export interface ConsoleHandlerDeps {
  contextFromClaims?: (claims: Record<string, unknown>, requestId: string) => Promise<Ctx>;
  db?: Pick<typeof db, 'get'>;
  prewarmDeps?: PrewarmManagerDeps;
  apiKeyDeps?: ApiKeyManagerDependencies;
}

export function createConsoleHandler(
  modules?: readonly ConsoleRouteModule[],
  deps?: ConsoleHandlerDeps,
) {
  const effectiveModules =
    modules ??
    (deps?.prewarmDeps || deps?.apiKeyDeps
      ? buildConsoleRouteModules(deps.prewarmDeps ?? defaultPrewarmDeps, deps.apiKeyDeps)
      : CONSOLE_ROUTE_MODULES);
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
      if (!modules) {
        const meResponse = await handleConsoleMeApiGatewayRoute(
          event,
          ctx,
          deps?.db ? { db: deps.db } : undefined,
        );
        if (meResponse) return meResponse;
        const usageResponse = await handleConsoleUsageRoute(event, ctx, deps?.db ?? db);
        if (usageResponse) return usageResponse;
      }
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

/**
 * Điểm vào Lambda: `services/api/console/handler.handler` (tham số ConsoleHandler trong infra/modules/lambdas.yaml).
 * Bọc CORS vì Web Console gọi từ origin khác (CloudFront của console → execute-api).
 */
export const handler = withCors(createConsoleHandler());
