import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ErrorAlert } from '../components/ConsoleFeedback.js';

describe('ConsoleFeedback – ErrorAlert retry & status check button visibility', () => {
  it('không hiện nút "Thử lại" cho lỗi không retryable kể cả khi màn hình truyền onRetry', () => {
    const nonRetryableErrors = [
      { code: 'UNAUTHORIZED', httpStatus: 401, message: 'Unauthorized', requestId: 'req-401' },
      { code: 'PERMISSION_DENIED', httpStatus: 403, message: 'Forbidden', requestId: 'req-403' },
      { code: 'TENANT_SUSPENDED', httpStatus: 403, message: 'Tenant locked', requestId: 'req-susp' },
      { code: 'INVALID_REQUEST', httpStatus: 400, message: 'Dữ liệu không hợp lệ', requestId: 'req-400' },
      { code: 'CHAR_QUOTA_EXCEEDED', httpStatus: 429, message: 'Quota exceeded', requestId: 'req-quota' },
      { code: 'VERSION_CONFLICT', httpStatus: 409, message: 'Conflict', requestId: 'req-409' },
      {
        code: 'VERIFICATION_FAILED',
        httpStatus: 400,
        reason: 'CODE_MISMATCH',
        message: 'Verification failed',
        requestId: 'req-verify',
      },
    ];

    for (const error of nonRetryableErrors) {
      const html = renderToStaticMarkup(
        React.createElement(ErrorAlert, {
          error,
          operation: 'read',
          onRetry: () => {},
          onCheckStatus: () => {},
        }),
      );

      assert.equal(
        html.includes('>Thử lại</button>'),
        false,
        `${error.code} không được phép hiện nút "Thử lại"`,
      );
      assert.equal(
        html.includes('>Kiểm tra trạng thái</button>'),
        false,
        `${error.code} không cần hiện nút "Kiểm tra trạng thái"`,
      );
      assert.equal(html.includes(error.code), true, `Phải giữ nguyên mã ${error.code} (QC-2)`);
    }
  });

  it('hiện nút "Thử lại" khi lỗi retryable và có callback onRetry', () => {
    const retryableCases = [
      { error: { code: 'RATE_LIMITED', httpStatus: 429, message: 'Too many requests' }, operation: 'write' as const },
      { error: { code: 'CACHE_INVALIDATION_FAILED', httpStatus: 503, message: 'CF error' }, operation: 'write' as const },
      { error: { code: 'INTERNAL_ERROR', httpStatus: 500, message: 'Server error' }, operation: 'read' as const },
      { error: { code: 'INTERNAL_ERROR', httpStatus: 500, message: 'Server error' }, operation: 'idempotent' as const },
      { error: new TypeError('Failed to fetch'), operation: 'read' as const },
    ];

    for (const testCase of retryableCases) {
      const withRetry = renderToStaticMarkup(
        React.createElement(ErrorAlert, {
          error: testCase.error,
          operation: testCase.operation,
          onRetry: () => {},
        }),
      );
      assert.equal(withRetry.includes('>Thử lại</button>'), true);

      const withoutRetry = renderToStaticMarkup(
        React.createElement(ErrorAlert, {
          error: testCase.error,
          operation: testCase.operation,
        }),
      );
      assert.equal(withoutRetry.includes('>Thử lại</button>'), false);
    }
  });

  it('lỗi 5xx/mạng ở thao tác write ẩn nút "Thử lại" và chỉ hiện "Kiểm tra trạng thái"', () => {
    const html = renderToStaticMarkup(
      React.createElement(ErrorAlert, {
        error: { code: 'INTERNAL_ERROR', httpStatus: 500, message: 'DB error', requestId: 'req-w-500' },
        operation: 'write',
        onRetry: () => {},
        onCheckStatus: () => {},
      }),
    );

    assert.equal(html.includes('>Thử lại</button>'), false);
    assert.equal(html.includes('>Kiểm tra trạng thái</button>'), true);
    assert.equal(html.includes('kiểm tra lại trạng thái trước khi gửi lại'), true);
  });
});
