/**
 * Router của Console Lambda (`ConsoleFunction`): API Gateway chuyển mọi `/console` và `/console/{proxy+}`
 * (Cognito User Pool Authorizer) tới handler này, router chuyển tiếp từng nhóm route cho mô-đun tương ứng.
 *
 * Đã đăng ký đầy đủ các nhóm route Console hiện có trong services/api:
 *  1. Duyệt bản dịch F5 (Task 3.8): `/console/translations*` và `/console/invalidations/*` qua `handleReviewApiGatewayRoute`.
 *  2. Quản lý thuật ngữ F4 (Task 2.8): `/console/glossary*` qua `handleGlossaryApiGatewayRoute`.
 * Biến môi trường: TABLE_NAME, CLOUDFRONT_DISTRIBUTION_ID, TENANT_DATA_ACCESS_ROLE_ARN.
 */
import {
  extractReviewCtxFromEvent,
  handleReviewApiGatewayRoute,
  type ReviewApiGatewayEvent,
  type ReviewApiGatewayResponse,
} from '../review/reviewManager.js';
import { handleGlossaryRoute, type GlossaryDependencies, type GlossaryHttpRequest } from '../glossary/glossaryManager.js';
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
 * Adapter HTTP cho nhóm route Quản lý thuật ngữ F4 (`/console/glossary*`).
 * Trả `null` nếu không thuộc đường dẫn thuật ngữ.
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

/** Danh sách các mô-đun route mặc định của Console Lambda. */
export const CONSOLE_ROUTE_MODULES: readonly ConsoleRouteModule[] = [
  (event, ctx) => handleReviewApiGatewayRoute(event, ctx),
  (event, ctx) => handleGlossaryApiGatewayRoute(event, ctx),
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
