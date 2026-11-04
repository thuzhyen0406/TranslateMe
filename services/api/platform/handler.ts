import {
  isPlatformAdmin,
  setTenantStatus,
  validateTenantId,
} from './tenantStatus.js';
import { AppError } from '../../../libs/common/types.js';

const RESPONSE_HEADERS = { 'Content-Type': 'application/json' };

export async function handler(event: {
  requestContext: {
    requestId?: string;
    authorizer?: { claims?: Record<string, unknown> };
  };
  pathParameters?: Record<string, string | undefined>;
  body?: string | null;
}) {
  try {
    const claims = event.requestContext.authorizer?.claims ?? {};
    if (!isPlatformAdmin(claims['cognito:groups'])) {
      throw new AppError('PERMISSION_DENIED', 'Vai trò không được phép thực hiện thao tác này');
    }

    const tenantId = validateTenantId(event.pathParameters?.tenantId);
    let input: unknown;
    try {
      input = JSON.parse(event.body ?? '{}');
    } catch {
      throw new AppError('INVALID_REQUEST', 'Body không hợp lệ');
    }

    if (!input || typeof input !== 'object' || Array.isArray(input) || 'tenantId' in input) {
      throw new AppError('INVALID_REQUEST', 'Không được gửi tenantId trong body');
    }
    if (!('status' in input)) {
      throw new AppError('INVALID_REQUEST', 'Thiếu status');
    }
    const status = (input as { status?: unknown }).status;
    if (status !== 'ACTIVE' && status !== 'LOCKED') {
      throw new AppError('INVALID_REQUEST', 'status không hợp lệ');
    }

    const result = await setTenantStatus(tenantId, status);
    return json(200, result, event.requestContext.requestId);
  } catch (error) {
    return errorResponse(error, event.requestContext.requestId);
  }
}

function json(statusCode: number, body: Record<string, unknown>, requestId?: string) {
  return {
    statusCode,
    headers: RESPONSE_HEADERS,
    body: JSON.stringify({ request_id: requestId, ...body }),
  };
}

function errorResponse(error: unknown, requestId?: string) {
  const appError = error instanceof AppError
    ? error
    : new AppError('INTERNAL_ERROR', 'Lỗi hệ thống');
  const statusCodes: Record<string, number> = {
    UNAUTHORIZED: 401,
    PERMISSION_DENIED: 403,
    TENANT_SUSPENDED: 403,
    CACHE_INVALIDATION_FAILED: 503,
    INVALID_REQUEST: 400,
    NOT_FOUND: 404,
  };

  return json(
    statusCodes[appError.code] ?? 500,
    { error: { code: appError.code, message: appError.message } },
    requestId,
  );
}
