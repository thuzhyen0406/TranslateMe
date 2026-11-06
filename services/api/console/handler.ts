/**
 * Router Console REST API cho các route API key.
 * Xác thực claims Cognito qua context dùng chung, sau đó chuyển request /console/api-keys đến keyManager.
 */
import { AppError } from '../../../libs/common/types.js';
import { contextFromIdTokenClaims } from '../auth/context.js';
import { handleApiKeyRoute } from '../keys/keyManager.js';

interface ConsoleEvent {
  httpMethod?: string;
  path?: string;
  rawPath?: string;
  body?: string | null;
  requestContext?: {
    requestId?: string;
    authorizer?: { claims?: Record<string, unknown> };
  };
}

/** Chuyển lỗi xác thực thành JSON chuẩn API Gateway; input là lỗi và request ID, output là phản hồi HTTP. */
function errorResponse(error: unknown, requestId: string) {
  const appError = error instanceof AppError
    ? error
    : new AppError('INTERNAL_ERROR', 'Lỗi tạm thời khi xử lý Console API.');
  const status = appError.code === 'UNAUTHORIZED' ? 401
    : appError.code === 'PERMISSION_DENIED' || appError.code === 'TENANT_SUSPENDED' || appError.code === 'FORBIDDEN' ? 403
    : appError.code === 'NOT_FOUND' ? 404
    : appError.code === 'INVALID_REQUEST' ? 400
    : 500;
  return {
    statusCode: status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'Authorization,Content-Type',
    },
    body: JSON.stringify({ request_id: requestId, error: { code: appError.code, message: appError.message } }),
  };
}

/** Xác thực phiên Cognito và định tuyến API key; input là event REST API, output JSON theo hợp đồng Console. */
export async function handler(event: ConsoleEvent) {
  const requestId = event.requestContext?.requestId ?? 'unknown';
  try {
    const claims = event.requestContext?.authorizer?.claims;
    if (!claims) throw new AppError('UNAUTHORIZED', 'Cần phiên đăng nhập hợp lệ.');
    const ctx = await contextFromIdTokenClaims(claims, requestId);
    const path = event.path ?? event.rawPath ?? '';
    if (!/\/console\/api-keys(?:\/|$)/u.test(path)) {
      throw new AppError('NOT_FOUND', 'Không tìm thấy endpoint Console API.');
    }
    return await handleApiKeyRoute(event, ctx);
  } catch (error) {
    return errorResponse(error, requestId);
  }
}
