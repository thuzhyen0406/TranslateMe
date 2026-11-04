/**
 * Router của Console Lambda (`ConsoleFunction`): API Gateway chuyển mọi `/console` và `/console/{proxy+}`
 * (Cognito User Pool Authorizer) tới handler này, router chuyển tiếp từng nhóm route cho mô-đun tương ứng.
 *
 * Hiện đã nối nhóm Duyệt bản dịch F5 (Task 3.8): `/console/translations*` và `/console/invalidations/*`
 * qua `handleReviewApiGatewayRoute`. Mô-đun khác thêm vào `CONSOLE_ROUTE_MODULES` theo cùng giao diện.
 * Biến môi trường cần cho F5: TABLE_NAME, CLOUDFRONT_DISTRIBUTION_ID (khai báo trong infra/modules/lambdas.yaml).
 */
import {
  extractReviewCtxFromEvent,
  handleReviewApiGatewayRoute,
  type ReviewApiGatewayEvent,
  type ReviewApiGatewayResponse,
} from '../review/reviewManager.js';
import { AppError, type Ctx } from '../../../libs/common/types.js';

export type ConsoleEvent = ReviewApiGatewayEvent;
export type ConsoleResponse = ReviewApiGatewayResponse;

/** Mô-đun route: trả `null` nếu đường dẫn không thuộc nhóm của mình. */
export type ConsoleRouteModule = (event: ConsoleEvent, ctx: Ctx) => Promise<ConsoleResponse | null>;

export const CONSOLE_ROUTE_MODULES: readonly ConsoleRouteModule[] = [
  (event, ctx) => handleReviewApiGatewayRoute(event, ctx),
];

const HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function errorResponse(statusCode: number, code: string, message: string, requestId: string): ConsoleResponse {
  return { statusCode, headers: HEADERS, body: JSON.stringify({ request_id: requestId, error: { code, message } }) };
}

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
