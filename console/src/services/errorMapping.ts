/**
 * Ánh xạ mã lỗi tập trung theo QC-2 / Bảng 2.10 (Hạng mục 5.8).
 *
 * Nguyên tắc bắt buộc (QC-2):
 *  1. Tài nguyên của tenant khác luôn trả NOT_FOUND giống hệt tài nguyên không tồn tại;
 *  2. Thông báo lỗi tiếng Việt tuyệt đối không làm lộ dữ liệu của tenant hoặc người dùng khác;
 *  3. Mã lỗi (code) giữ nguyên không dịch, phần mô tả (message) dùng tiếng Việt rõ ràng;
 *  4. Lỗi 429 RATE_LIMITED và CACHE_INVALIDATION_FAILED có thể thử lại an toàn; lỗi 5xx/mạng chỉ khuyên thử lại
 *     với thao tác đọc (`read`) hoặc thao tác ghi có bảo đảm chống lặp (`idempotent`), còn thao tác ghi khác
 *     (`write` hoặc chưa rõ ngữ cảnh) phải hướng dẫn kiểm tra trạng thái trước khi gửi lại để tránh lặp tác động;
 *  5. Giữ lại request_id từ phản hồi API (nếu có) để phục vụ đối chiếu log.
 */

export const TABLE_2_10_ERROR_CODES = [
  'INVALID_REQUEST',
  'UNSUPPORTED_LANGUAGE',
  'TEXT_TOO_LONG',
  'LANGUAGE_NOT_DETECTED',
  'FILE_NOT_UPLOADED',
  'PLACEHOLDER_MISMATCH',
  'VERIFICATION_FAILED',
  'UNAUTHORIZED',
  'TENANT_SUSPENDED',
  'PERMISSION_DENIED',
  'NOT_FOUND',
  'VERSION_CONFLICT',
  'RATE_LIMITED',
  'REQUEST_QUOTA_EXCEEDED',
  'CHAR_QUOTA_EXCEEDED',
  'INTERNAL_ERROR',
] as const;

export type Table210ErrorCode = (typeof TABLE_2_10_ERROR_CODES)[number];

export const EXTRA_CONSOLE_ERROR_CODES = [
  'FORBIDDEN',
  'DUPLICATE_SLUG',
  'SITE_UNREACHABLE',
  'VERIFICATION_NOT_FOUND',
  'VERIFICATION_CODE_MISMATCH',
  'TOO_MANY_REDIRECTS',
  'CACHE_INVALIDATION_FAILED',
  'NETWORK_ERROR',
] as const;

export type ExtraConsoleErrorCode = (typeof EXTRA_CONSOLE_ERROR_CODES)[number];
export type KnownConsoleErrorCode = Table210ErrorCode | ExtraConsoleErrorCode;

export type ConsoleErrorScope = 'generic' | 'auth' | 'members' | 'website' | 'glossary' | 'review';

/**
 * Phân loại thao tác gọi API:
 *  - 'read': GET / xem trước chỉ đọc (an toàn thử lại khi 5xx/mạng);
 *  - 'idempotent': thao tác ghi đã có bảo đảm chống lặp phía máy chủ (verify, prewarm, retryInvalidation);
 *  - 'write': thao tác ghi có thể đã ghi dữ liệu trước khi phát sinh 5xx/mạng -> không tự khuyên thử lại an toàn.
 */
export type ConsoleOperationKind = 'read' | 'idempotent' | 'write';

export function isSafeToRetryOperation(operation?: ConsoleOperationKind): boolean {
  return operation === 'read' || operation === 'idempotent';
}

export interface ErrorCodeSpec {
  code: KnownConsoleErrorCode;
  httpStatus: number;
  retryable: boolean;
  defaultMessage: string;
}

export const VERIFICATION_FAILURE_MESSAGES: Readonly<
  Record<'UNREACHABLE' | 'TAG_OR_FILE_NOT_FOUND' | 'CODE_MISMATCH' | 'TOO_MANY_REDIRECTS', string>
> = Object.freeze({
  UNREACHABLE: 'Không truy cập được website. Kiểm tra website đang mở công khai rồi thử lại.',
  TAG_OR_FILE_NOT_FOUND:
    'Không tìm thấy thẻ meta hoặc tệp xác minh. Kiểm tra đã lưu và xuất bản thay đổi chưa.',
  CODE_MISMATCH: 'Mã xác minh không khớp. Hãy sao chép lại đúng mã ở trên.',
  TOO_MANY_REDIRECTS:
    'Website chuyển hướng quá số lần cho phép. Hãy dùng đúng địa chỉ trang chủ cuối cùng.',
});

export const ERROR_CODE_SPECS: Readonly<Record<KnownConsoleErrorCode, ErrorCodeSpec>> = Object.freeze({
  INVALID_REQUEST: {
    code: 'INVALID_REQUEST',
    httpStatus: 400,
    retryable: false,
    defaultMessage: 'Thông tin gửi lên chưa hợp lệ. Vui lòng kiểm tra lại các trường đã nhập.',
  },
  UNSUPPORTED_LANGUAGE: {
    code: 'UNSUPPORTED_LANGUAGE',
    httpStatus: 400,
    retryable: false,
    defaultMessage: 'Có ngôn ngữ chưa được hệ thống hỗ trợ.',
  },
  TEXT_TOO_LONG: {
    code: 'TEXT_TOO_LONG',
    httpStatus: 400,
    retryable: false,
    defaultMessage: 'Nội dung vượt quá giới hạn tối đa 5.000 ký tự cho mỗi yêu cầu.',
  },
  LANGUAGE_NOT_DETECTED: {
    code: 'LANGUAGE_NOT_DETECTED',
    httpStatus: 400,
    retryable: false,
    defaultMessage:
      'Không nhận diện được ngôn ngữ đủ độ tin cậy. Vui lòng chọn rõ ngôn ngữ nguồn.',
  },
  FILE_NOT_UPLOADED: {
    code: 'FILE_NOT_UPLOADED',
    httpStatus: 400,
    retryable: false,
    defaultMessage:
      'Chưa tìm thấy tệp đã tải lên hoặc liên kết tải lên đã hết hạn. Vui lòng tải lại tệp.',
  },
  PLACEHOLDER_MISMATCH: {
    code: 'PLACEHOLDER_MISMATCH',
    httpStatus: 400,
    retryable: false,
    defaultMessage:
      'Bản dịch sửa không khớp ký hiệu định dạng {n} so với câu gốc. Vui lòng giữ nguyên các ký hiệu định dạng.',
  },
  VERIFICATION_FAILED: {
    code: 'VERIFICATION_FAILED',
    httpStatus: 400,
    retryable: false,
    defaultMessage:
      'Xác minh quyền sở hữu website chưa thành công. Vui lòng kiểm tra thẻ meta hoặc tệp xác minh và thử lại.',
  },
  UNAUTHORIZED: {
    code: 'UNAUTHORIZED',
    httpStatus: 401,
    retryable: false,
    defaultMessage: 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn. Vui lòng đăng nhập lại.',
  },
  TENANT_SUSPENDED: {
    code: 'TENANT_SUSPENDED',
    httpStatus: 403,
    retryable: false,
    defaultMessage:
      'Tổ chức đang bị tạm khóa (chế độ chỉ xem); không thể thực hiện thao tác thay đổi dữ liệu hoặc dịch mới.',
  },
  PERMISSION_DENIED: {
    code: 'PERMISSION_DENIED',
    httpStatus: 403,
    retryable: false,
    defaultMessage: 'Bạn không có quyền thực hiện thao tác này hoặc tài khoản thành viên đã bị khóa.',
  },
  NOT_FOUND: {
    code: 'NOT_FOUND',
    httpStatus: 404,
    retryable: false,
    defaultMessage: 'Không tìm thấy tài nguyên được yêu cầu.',
  },
  VERSION_CONFLICT: {
    code: 'VERSION_CONFLICT',
    httpStatus: 409,
    retryable: false,
    defaultMessage:
      'Dữ liệu vừa được cập nhật từ phiên khác. Vui lòng tải lại dữ liệu mới nhất trước khi tiếp tục.',
  },
  RATE_LIMITED: {
    code: 'RATE_LIMITED',
    httpStatus: 429,
    retryable: true,
    defaultMessage: 'Tần suất gửi yêu cầu quá nhanh. Vui lòng đợi vài giây rồi thử lại.',
  },
  REQUEST_QUOTA_EXCEEDED: {
    code: 'REQUEST_QUOTA_EXCEEDED',
    httpStatus: 429,
    retryable: false,
    defaultMessage:
      'Đã vượt hạn ngạch số lượng yêu cầu của gói API hiện tại. Vui lòng đợi chu kỳ mới hoặc nâng cấp gói.',
  },
  CHAR_QUOTA_EXCEEDED: {
    code: 'CHAR_QUOTA_EXCEEDED',
    httpStatus: 429,
    retryable: false,
    defaultMessage:
      'Đã hết hạn mức ký tự dịch trong tháng của tổ chức. Vui lòng nâng cấp gói hoặc duyệt lại các câu có sẵn trong bộ nhớ dịch.',
  },
  INTERNAL_ERROR: {
    code: 'INTERNAL_ERROR',
    httpStatus: 500,
    retryable: false,
    defaultMessage:
      'Hệ thống đang gặp lỗi tạm thời. Vui lòng kiểm tra trạng thái hiện tại trước khi gửi lại.',
  },
  FORBIDDEN: {
    code: 'FORBIDDEN',
    httpStatus: 403,
    retryable: false,
    defaultMessage: 'Thao tác hoặc địa chỉ truy cập không được phép.',
  },
  DUPLICATE_SLUG: {
    code: 'DUPLICATE_SLUG',
    httpStatus: 409,
    retryable: false,
    defaultMessage: 'Website này đã được thêm vào TranslateMe.',
  },
  SITE_UNREACHABLE: {
    code: 'SITE_UNREACHABLE',
    httpStatus: 400,
    retryable: false,
    defaultMessage: VERIFICATION_FAILURE_MESSAGES.UNREACHABLE,
  },
  VERIFICATION_NOT_FOUND: {
    code: 'VERIFICATION_NOT_FOUND',
    httpStatus: 400,
    retryable: false,
    defaultMessage: VERIFICATION_FAILURE_MESSAGES.TAG_OR_FILE_NOT_FOUND,
  },
  VERIFICATION_CODE_MISMATCH: {
    code: 'VERIFICATION_CODE_MISMATCH',
    httpStatus: 400,
    retryable: false,
    defaultMessage: VERIFICATION_FAILURE_MESSAGES.CODE_MISMATCH,
  },
  TOO_MANY_REDIRECTS: {
    code: 'TOO_MANY_REDIRECTS',
    httpStatus: 400,
    retryable: false,
    defaultMessage: VERIFICATION_FAILURE_MESSAGES.TOO_MANY_REDIRECTS,
  },
  CACHE_INVALIDATION_FAILED: {
    code: 'CACHE_INVALIDATION_FAILED',
    httpStatus: 503,
    retryable: true,
    defaultMessage: 'Làm mới bộ nhớ đệm CloudFront gặp lỗi tạm thời. Bạn có thể bấm Thử lại.',
  },
  NETWORK_ERROR: {
    code: 'NETWORK_ERROR',
    httpStatus: 0,
    retryable: false,
    defaultMessage:
      'Không nhận được phản hồi từ máy chủ. Vui lòng kiểm tra kết nối và trạng thái hiện tại trước khi gửi lại.',
  },
});

const KNOWN_CODE_SET = new Set<string>(Object.keys(ERROR_CODE_SPECS));

export function isTable210ErrorCode(code: unknown): code is Table210ErrorCode {
  return (
    typeof code === 'string' &&
    (TABLE_2_10_ERROR_CODES as readonly string[]).includes(code.trim().toUpperCase())
  );
}

export function isKnownConsoleErrorCode(code: unknown): code is KnownConsoleErrorCode {
  return typeof code === 'string' && KNOWN_CODE_SET.has(code.trim().toUpperCase());
}

/**
 * Ánh xạ HTTP status code sang mã lỗi chuẩn Bảng 2.10 khi máy chủ không trả `error.code`.
 */
export function httpStatusToErrorCode(httpStatus: number): Table210ErrorCode {
  if (httpStatus === 401) return 'UNAUTHORIZED';
  if (httpStatus === 403) return 'PERMISSION_DENIED';
  if (httpStatus === 404) return 'NOT_FOUND';
  if (httpStatus === 409) return 'VERSION_CONFLICT';
  if (httpStatus === 429) return 'RATE_LIMITED';
  if (httpStatus >= 500) return 'INTERNAL_ERROR';
  return 'INVALID_REQUEST';
}

export function formatPlaceholderMismatchMessage(
  missing: readonly string[] = [],
  extra: readonly string[] = [],
): string {
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`thiếu ký hiệu: ${missing.join(', ')}`);
  if (extra.length > 0) parts.push(`thừa ký hiệu: ${extra.join(', ')}`);
  const detail = parts.length > 0 ? ` (${parts.join('; ')})` : '';
  return `Bản dịch sửa không khớp ký hiệu định dạng {n} so với câu gốc${detail}. Vui lòng giữ nguyên các ký hiệu định dạng.`;
}

const INTERNAL_LEAK_RE =
  /(TENANT#[A-Za-z0-9_-]+|HASH#[0-9a-f]+|arn:aws:|ConditionalCheckFailed|DynamoDB|ResourceNotFoundException|\n\s+at\s+)/i;

const GENERIC_ENGLISH_NOISE_RE =
  /^(bad request|unauthorized|forbidden|not found|conflict|too many requests|internal server error|service unavailable|failed to fetch|fetch failed|network\s?error|load failed|request timed out|error|failed|unknown error)$/i;

/**
 * Lọc thông điệp thô để ngăn rò rỉ stack trace, khóa nội bộ DynamoDB hoặc dữ liệu tenant khác (QC-2).
 */
export function sanitizeClientSafeMessage(raw?: string | null): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length <= 2) return null;
  if (INTERNAL_LEAK_RE.test(trimmed)) return null;
  if (GENERIC_ENGLISH_NOISE_RE.test(trimmed)) return null;
  return trimmed.slice(0, 280);
}

export interface ExtractedApiErrorPayload {
  code: string;
  message: string;
  requestId?: string;
  reason?: string;
  details?: Record<string, unknown>;
  httpStatus: number;
}

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

const strVal = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Trích xuất chuẩn cấu trúc phản hồi lỗi `{ request_id, error: { code, message, reason?, details? } }` từ API Gateway/Lambda.
 */
export function extractApiErrorPayload(
  data: unknown,
  httpStatus: number,
): ExtractedApiErrorPayload {
  const root = asRecord(data) ?? {};
  const errObj = asRecord(root.error) ?? {};
  const details = asRecord(errObj.details) ?? asRecord(root.details);
  const rawCode = strVal(errObj.code ?? root.code).toUpperCase();
  const code = rawCode || httpStatusToErrorCode(httpStatus);
  const requestId = strVal(root.request_id ?? root.requestId ?? errObj.request_id ?? errObj.requestId) || undefined;
  const reason =
    strVal(errObj.reason ?? root.reason ?? details?.reason).toUpperCase() || undefined;
  const message = strVal(errObj.message ?? root.message);

  return {
    code,
    message,
    ...(requestId ? { requestId } : {}),
    ...(reason ? { reason } : {}),
    ...(details ? { details } : {}),
    httpStatus,
  };
}

export interface ConsoleUiError {
  /** Mã lỗi gốc từ API / Cognito (giữ nguyên không dịch theo QC-2) */
  code?: string;
  /** Thông báo tiếng Việt rõ ràng, an toàn và không rò rỉ dữ liệu khác tenant */
  message: string;
  httpStatus?: number;
  reason?: string;
  requestId?: string;
  /** Chỉ bật khi an toàn để bấm thử lại ngay (429 RATE_LIMITED, CACHE_INVALIDATION_FAILED, hoặc 5xx/mạng ở read/idempotent) */
  retryable: boolean;
  /** Bật khi 5xx/mạng xảy ra trên thao tác ghi không chống lặp (hoặc chưa rõ ngữ cảnh) -> hướng dẫn kiểm tra trạng thái trước */
  requiresStatusCheck?: boolean;
}

export interface ResolveConsoleErrorOptions {
  scope?: ConsoleErrorScope;
  /** Phân loại thao tác; mặc định thận trọng xem như chưa có bảo đảm chống lặp */
  operation?: ConsoleOperationKind;
  /** Ghi đè thông báo theo ngữ cảnh từng màn (ví dụ NOT_FOUND -> "Không tìm thấy website.") */
  overrides?: Partial<Record<KnownConsoleErrorCode, string>>;
}

export function mapErrorCodeToVietnamese(
  codeInput: string,
  opts: ResolveConsoleErrorOptions & {
    reason?: string;
    serverMessage?: string;
    missing?: readonly string[];
    extra?: readonly string[];
  } = {},
): string {
  const code = codeInput.trim().toUpperCase();
  const safeRetryOp = isSafeToRetryOperation(opts.operation);

  if (code === 'PLACEHOLDER_MISMATCH') {
    if ((opts.missing && opts.missing.length > 0) || (opts.extra && opts.extra.length > 0)) {
      return formatPlaceholderMismatchMessage(opts.missing ?? [], opts.extra ?? []);
    }
    return ERROR_CODE_SPECS.PLACEHOLDER_MISMATCH.defaultMessage;
  }

  if (code === 'VERIFICATION_FAILED') {
    const reason = opts.reason?.trim().toUpperCase();
    if (reason && reason in VERIFICATION_FAILURE_MESSAGES) {
      return VERIFICATION_FAILURE_MESSAGES[
        reason as keyof typeof VERIFICATION_FAILURE_MESSAGES
      ];
    }
    return ERROR_CODE_SPECS.VERIFICATION_FAILED.defaultMessage;
  }

  if (isKnownConsoleErrorCode(code)) {
    const override = opts.overrides?.[code];
    if (override) return override;

    if (code === 'INTERNAL_ERROR') {
      return safeRetryOp
        ? 'Hệ thống đang gặp lỗi tạm thời, an toàn để thử lại sau ít phút.'
        : ERROR_CODE_SPECS.INTERNAL_ERROR.defaultMessage;
    }

    if (code === 'NETWORK_ERROR') {
      return safeRetryOp
        ? 'Không kết nối được tới máy chủ. Vui lòng kiểm tra kết nối mạng và thử lại.'
        : ERROR_CODE_SPECS.NETWORK_ERROR.defaultMessage;
    }

    if (code === 'INVALID_REQUEST') {
      const safe = sanitizeClientSafeMessage(opts.serverMessage);
      if (safe) return safe;
    }

    return ERROR_CODE_SPECS[code].defaultMessage;
  }

  return (
    sanitizeClientSafeMessage(opts.serverMessage) ??
    mapErrorCodeToVietnamese('INTERNAL_ERROR', opts)
  );
}

const IGNORED_RUNTIME_ERROR_NAMES = new Set<string>([
  'Error',
  'TypeError',
  'SyntaxError',
  'RangeError',
  'ReferenceError',
  'ValidationError',
]);

export function resolveConsoleError(
  err: unknown,
  opts: ResolveConsoleErrorOptions = {},
): ConsoleUiError {
  const safeRetryOp = isSafeToRetryOperation(opts.operation);

  if (typeof err === 'string') {
    const clean =
      sanitizeClientSafeMessage(err) ?? mapErrorCodeToVietnamese('INTERNAL_ERROR', opts);
    return { message: clean, retryable: false };
  }

  const obj = err && typeof err === 'object' ? (err as Record<string, unknown>) : null;
  if (!obj) {
    return {
      code: 'INTERNAL_ERROR',
      message: mapErrorCodeToVietnamese('INTERNAL_ERROR', opts),
      httpStatus: 500,
      retryable: safeRetryOp,
      ...(safeRetryOp ? {} : { requiresStatusCheck: true }),
    };
  }

  const nestedErr = asRecord(obj.error);
  const rawCodeRaw = strVal(obj.code ?? nestedErr?.code ?? obj.__type ?? obj.name);
  const rawCode = rawCodeRaw.includes('#') ? rawCodeRaw.split('#').pop()! : rawCodeRaw;
  const upperCode = rawCode.toUpperCase();
  const reason = strVal(obj.reason ?? nestedErr?.reason).toUpperCase() || undefined;
  const requestId =
    strVal(obj.requestId ?? obj.request_id ?? nestedErr?.request_id ?? nestedErr?.requestId) ||
    undefined;
  const httpStatus =
    typeof obj.httpStatus === 'number' && Number.isFinite(obj.httpStatus)
      ? obj.httpStatus
      : isKnownConsoleErrorCode(upperCode)
        ? ERROR_CODE_SPECS[upperCode].httpStatus
        : undefined;

  const details = asRecord(obj.details) ?? asRecord(nestedErr?.details);
  const missing = Array.isArray(obj.missing)
    ? (obj.missing as unknown[]).filter((x): x is string => typeof x === 'string')
    : Array.isArray(details?.missing)
      ? (details.missing as unknown[]).filter((x): x is string => typeof x === 'string')
      : undefined;
  const extra = Array.isArray(obj.extra)
    ? (obj.extra as unknown[]).filter((x): x is string => typeof x === 'string')
    : Array.isArray(details?.extra)
      ? (details.extra as unknown[]).filter((x): x is string => typeof x === 'string')
      : undefined;

  const rawServerMessage =
    typeof obj.message === 'string'
      ? obj.message
      : typeof nestedErr?.message === 'string'
        ? nestedErr.message
        : err instanceof Error
          ? err.message
          : undefined;

  const isFetchFailure =
    IGNORED_RUNTIME_ERROR_NAMES.has(rawCode) &&
    typeof rawServerMessage === 'string' &&
    /^(failed to fetch|fetch failed|network\s?error|load failed)/i.test(rawServerMessage.trim());

  const effectiveCode = isKnownConsoleErrorCode(upperCode)
    ? upperCode
    : isFetchFailure
      ? 'NETWORK_ERROR'
      : httpStatus
        ? httpStatusToErrorCode(httpStatus)
        : rawCode && !IGNORED_RUNTIME_ERROR_NAMES.has(rawCode)
          ? rawCode
          : undefined;

  const message = mapErrorCodeToVietnamese(effectiveCode ?? 'INTERNAL_ERROR', {
    ...opts,
    reason,
    serverMessage: rawServerMessage,
    missing,
    extra,
  });

  const isUncertain5xxOrNetwork =
    effectiveCode === 'INTERNAL_ERROR' ||
    effectiveCode === 'NETWORK_ERROR' ||
    (effectiveCode !== 'CACHE_INVALIDATION_FAILED' &&
      typeof httpStatus === 'number' &&
      httpStatus >= 500);

  const retryable = isUncertain5xxOrNetwork
    ? safeRetryOp
    : effectiveCode && isKnownConsoleErrorCode(effectiveCode)
      ? ERROR_CODE_SPECS[effectiveCode].retryable
      : httpStatus === 429;

  const requiresStatusCheck = isUncertain5xxOrNetwork && !safeRetryOp;

  return {
    ...(effectiveCode ? { code: effectiveCode } : {}),
    message,
    ...(typeof httpStatus === 'number' && httpStatus > 0 ? { httpStatus } : {}),
    ...(reason ? { reason } : {}),
    ...(requestId ? { requestId } : {}),
    retryable,
    ...(requiresStatusCheck ? { requiresStatusCheck: true } : {}),
  };
}

/**
 * Chuyển đổi đối tượng lỗi bất kỳ sang payload đồng nhất cho component UI (`ErrorAlert`):
 * giữ nguyên mã lỗi (`code`) và luôn trả thông báo tiếng Việt hợp lệ.
 */
export function errorToUiPayload(
  err: unknown,
  opts: ResolveConsoleErrorOptions & {
    formatMessage?: (e: unknown, resolveOpts?: ResolveConsoleErrorOptions) => string;
  } = {},
): ConsoleUiError | null {
  if (err === null || err === undefined || err === '') return null;
  if (typeof err === 'string') {
    const trimmed = err.trim();
    if (!trimmed) return null;
    return { message: trimmed, retryable: false };
  }

  const resolved = resolveConsoleError(err, opts);
  if (opts.formatMessage) {
    const customMsg = opts.formatMessage(err, opts)?.trim();
    if (customMsg) {
      resolved.message = customMsg;
    }
  }
  return resolved;
}
