import React from 'react';
import {
  errorToUiPayload,
  type ConsoleErrorScope,
  type ConsoleOperationKind,
  type ResolveConsoleErrorOptions,
} from '../services/errorMapping.js';

export interface ErrorAlertProps {
  /** Đối tượng lỗi (WebsiteApiError, GlossaryApiError, ReviewApiError, ConsoleAuthError) hoặc chuỗi tiếng Việt */
  error: unknown;
  /** Tiêu đề ngắn gọn (tùy chọn) */
  title?: string;
  /** Ngữ cảnh màn hình để ánh xạ câu chữ phù hợp khi chưa truyền formatMessage */
  scope?: ConsoleErrorScope;
  /**
   * Loại thao tác ('read' | 'idempotent' | 'write') quyết định lời khuyên khi gặp lỗi 5xx/mạng:
   * chỉ khuyên thử lại an toàn cho 'read'/'idempotent'; với 'write' (hoặc bỏ trống) sẽ nhắc kiểm tra trạng thái.
   */
  operation?: ConsoleOperationKind;
  /** Hàm chuyển thông báo tiếng Việt chuyên biệt của từng màn (websiteErrorMessage, glossaryErrorMessage...) */
  formatMessage?: (err: unknown, resolveOpts?: ResolveConsoleErrorOptions) => string;
  /** Nút thử lại (chỉ hiển thị gợi ý thử lại an toàn khi `payload.retryable = true`) */
  onRetry?: () => void;
  retryLabel?: string;
  /** Nút tải lại / kiểm tra trạng thái hiện tại khi lỗi 5xx hoặc lỗi mạng ở thao tác ghi */
  onCheckStatus?: () => void;
  checkStatusLabel?: string;
  onDismiss?: () => void;
  compact?: boolean;
  className?: string;
  children?: React.ReactNode;
}

/**
 * Hộp thông báo lỗi thống nhất toàn Web Console (Hạng mục 5.8 / QC-2):
 *  - Giữ nguyên mã lỗi gốc (`code`, không dịch) để dễ đối chiếu Bảng 2.10;
 *  - Hiển thị nội dung thông báo tiếng Việt rõ ràng, an toàn, không lộ dữ liệu tenant khác;
 *  - Hiển thị `request_id` (nếu API trả về), chỉ khuyên "thử lại an toàn" khi lỗi có thể thử lại an toàn,
 *    và nhắc kiểm tra trạng thái hiện tại nếu lỗi 5xx/mạng xảy ra trên thao tác ghi không chống lặp.
 */
export const ErrorAlert: React.FC<ErrorAlertProps> = ({
  error,
  title,
  scope = 'generic',
  operation,
  formatMessage,
  onRetry,
  retryLabel = 'Thử lại',
  onCheckStatus,
  checkStatusLabel = 'Kiểm tra trạng thái',
  onDismiss,
  compact = false,
  className = '',
  children,
}) => {
  const payload = errorToUiPayload(error, { scope, operation, formatMessage });
  if (!payload) return null;

  const hasHeader = Boolean(title || payload.code || payload.requestId || onDismiss);
  const canShowRetryButton = Boolean(onRetry && payload.retryable && !payload.requiresStatusCheck);
  const canShowCheckStatusButton = Boolean(onCheckStatus && payload.requiresStatusCheck);
  const showFooter = Boolean(
    canShowRetryButton ||
      canShowCheckStatusButton ||
      payload.retryable ||
      payload.requiresStatusCheck,
  );

  return (
    <div
      role="alert"
      className={`rounded-xl border border-red-200 bg-red-50 text-red-800 ${
        compact ? 'px-3.5 py-2.5 text-xs' : 'px-4 py-3 text-sm'
      } ${className}`}
    >
      {hasHeader && (
        <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
          <div className="flex flex-wrap items-center gap-2">
            {title && (
              <span className="font-semibold text-red-900">{title}</span>
            )}
            {payload.code && (
              <code className="px-1.5 py-0.5 rounded bg-red-100 border border-red-200 font-mono text-[11px] font-semibold text-red-900">
                {payload.code}
              </code>
            )}
          </div>
          <div className="flex items-center gap-3">
            {payload.requestId && (
              <span className="font-mono text-[11px] text-red-700/80">
                Mã yêu cầu: {payload.requestId}
              </span>
            )}
            {onDismiss && (
              <button
                type="button"
                onClick={onDismiss}
                className="text-xs font-semibold text-red-700 hover:text-red-950 underline"
              >
                Đóng
              </button>
            )}
          </div>
        </div>
      )}

      <p className={`${compact ? 'text-xs' : 'text-sm'} leading-relaxed text-red-800`}>
        {payload.message}
      </p>

      {showFooter && (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          {canShowRetryButton && onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="px-3 py-1 rounded-lg border border-red-300 bg-white hover:bg-red-100/60 text-xs font-semibold text-red-800 transition-colors"
            >
              {retryLabel}
            </button>
          )}
          {canShowCheckStatusButton && onCheckStatus && (
            <button
              type="button"
              onClick={onCheckStatus}
              className="px-3 py-1 rounded-lg border border-red-300 bg-white hover:bg-red-100/60 text-xs font-semibold text-red-800 transition-colors"
            >
              {checkStatusLabel}
            </button>
          )}
          {payload.retryable && (
            <span className="text-[11px] text-red-700">
              Đây là lỗi tạm thời, bạn có thể thử lại an toàn.
            </span>
          )}
          {payload.requiresStatusCheck && (
            <span className="text-[11px] text-red-700">
              Lỗi xảy ra sau khi gửi yêu cầu; máy chủ có thể đã xử lý. Vui lòng kiểm tra lại trạng thái trước khi gửi lại để tránh lặp tác động.
            </span>
          )}
        </div>
      )}

      {children && <div className="mt-2">{children}</div>}
    </div>
  );
};

export interface EmptyStateProps {
  title: string;
  description?: string;
  variant?: 'default' | 'error';
  actionLabel?: string;
  onAction?: () => void;
  secondaryActionLabel?: string;
  onSecondaryAction?: () => void;
  className?: string;
}

/**
 * Trạng thái trống (Empty / Error Placeholder) thống nhất cho mọi màn Web Console.
 */
export const EmptyState: React.FC<EmptyStateProps> = ({
  title,
  description,
  variant = 'default',
  actionLabel,
  onAction,
  secondaryActionLabel,
  onSecondaryAction,
  className = '',
}) => {
  const isError = variant === 'error';

  return (
    <div className={`px-6 py-10 text-center ${className}`}>
      <div
        className={`mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full ${
          isError ? 'bg-red-100 text-red-700' : 'bg-[#e6f2ee] text-[#146c54]'
        }`}
        aria-hidden="true"
      >
        {isError ? (
          <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
          </svg>
        ) : (
          <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
          </svg>
        )}
      </div>

      <h3 className={`text-sm font-semibold ${isError ? 'text-red-900' : 'text-gray-800'}`}>
        {title}
      </h3>
      {description && (
        <p className="mt-1.5 mx-auto max-w-md text-xs text-gray-500 leading-relaxed">
          {description}
        </p>
      )}

      {(actionLabel || secondaryActionLabel) && (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2.5">
          {actionLabel && onAction && (
            <button
              type="button"
              onClick={onAction}
              className={`px-4 py-2 rounded-lg text-xs font-semibold transition-colors shadow-sm ${
                isError
                  ? 'bg-white border border-red-300 text-red-800 hover:bg-red-50'
                  : 'bg-[#146c54] hover:bg-[#0f5945] text-white'
              }`}
            >
              {actionLabel}
            </button>
          )}
          {secondaryActionLabel && onSecondaryAction && (
            <button
              type="button"
              onClick={onSecondaryAction}
              className="px-4 py-2 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 text-gray-700 text-xs font-semibold transition-colors"
            >
              {secondaryActionLabel}
            </button>
          )}
        </div>
      )}
    </div>
  );
};
