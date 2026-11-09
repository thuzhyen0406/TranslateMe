import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ConsoleAuthError,
  mapCognitoErrorToVietnamese,
} from '../services/cognitoAuth.js';
import {
  ERROR_CODE_SPECS,
  EXTRA_CONSOLE_ERROR_CODES,
  TABLE_2_10_ERROR_CODES,
  errorToUiPayload,
  extractApiErrorPayload,
  formatPlaceholderMismatchMessage,
  httpStatusToErrorCode,
  isKnownConsoleErrorCode,
  isTable210ErrorCode,
  mapErrorCodeToVietnamese,
  resolveConsoleError,
  sanitizeClientSafeMessage,
} from '../services/errorMapping.js';
import {
  GlossaryApiError,
  createHttpGlossaryApi,
  glossaryErrorMessage,
} from '../services/glossaryApi.js';
import {
  ReviewApiError,
  createHttpReviewApi,
  reviewErrorMessage,
} from '../services/reviewApi.js';
import { canConsoleRequest } from '../services/tenantPolicy.js';
import {
  WebsiteApiError,
  createHttpWebsiteApi,
  websiteErrorMessage,
} from '../services/websiteApi.js';

describe('Task 5.8 – Ánh xạ mã lỗi chuẩn Bảng 2.10 & nguyên tắc QC-2', () => {
  it('chứa đầy đủ 16 mã lỗi chuẩn theo Bảng 2.10 và ánh xạ toàn bộ sang tiếng Việt (giữ nguyên code)', () => {
    assert.deepEqual([...TABLE_2_10_ERROR_CODES], [
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
    ]);

    for (const code of [...TABLE_2_10_ERROR_CODES, ...EXTRA_CONSOLE_ERROR_CODES]) {
      assert.equal(isKnownConsoleErrorCode(code), true, code);
      const spec = ERROR_CODE_SPECS[code];
      assert.ok(spec.defaultMessage.length >= 10, `Thiếu thông báo cho ${code}`);

      const ui = errorToUiPayload({
        code,
        message: 'Raw internal English detail',
        request_id: `req-${code}`,
      });
      assert.ok(ui);
      assert.equal(ui.code, code, 'QC-2: Phải giữ nguyên mã lỗi không dịch');
      assert.equal(ui.requestId, `req-${code}`);
      assert.notEqual(ui.message, code);
      assert.ok(ui.message.trim().length > 0);
    }

    assert.equal(isTable210ErrorCode('TEXT_TOO_LONG'), true);
    assert.equal(isTable210ErrorCode('NETWORK_ERROR'), false);
  });

  it('ánh xạ chính xác các reason của VERIFICATION_FAILED và chi tiết thiếu/thừa {n} của PLACEHOLDER_MISMATCH', () => {
    assert.match(
      mapErrorCodeToVietnamese('VERIFICATION_FAILED', { reason: 'UNREACHABLE' }),
      /Không truy cập được website/,
    );
    assert.match(
      mapErrorCodeToVietnamese('VERIFICATION_FAILED', { reason: 'TAG_OR_FILE_NOT_FOUND' }),
      /Không tìm thấy thẻ meta hoặc tệp xác minh/,
    );
    assert.match(
      mapErrorCodeToVietnamese('VERIFICATION_FAILED', { reason: 'CODE_MISMATCH' }),
      /Mã xác minh không khớp/,
    );
    assert.match(
      mapErrorCodeToVietnamese('VERIFICATION_FAILED', { reason: 'TOO_MANY_REDIRECTS' }),
      /chuyển hướng quá số lần/,
    );

    const phMsg = formatPlaceholderMismatchMessage(['{1}', '{/1}'], ['{2}']);
    assert.match(phMsg, /thiếu ký hiệu: \{1\}, \{\/1\}/);
    assert.match(phMsg, /thừa ký hiệu: \{2\}/);

    const phUi = errorToUiPayload(
      new ReviewApiError('PLACEHOLDER_MISMATCH', 'Placeholder mismatch', {
        missing: ['{1}'],
        extra: ['{9}'],
        requestId: 'req-ph-1',
      }),
      { scope: 'review', formatMessage: reviewErrorMessage },
    );
    assert.ok(phUi);
    assert.equal(phUi.code, 'PLACEHOLDER_MISMATCH');
    assert.equal(phUi.requestId, 'req-ph-1');
    assert.match(phUi.message, /thiếu ký hiệu: \{1\}/);
    assert.match(phUi.message, /thừa ký hiệu: \{9\}/);
  });

  it('phân loại đúng lỗi tạm thời có thể thử lại (429 RATE_LIMITED, 5xx INTERNAL_ERROR, NETWORK_ERROR)', () => {
    for (const code of [
      'INTERNAL_ERROR',
      'RATE_LIMITED',
      'CACHE_INVALIDATION_FAILED',
      'NETWORK_ERROR',
    ]) {
      const resolved = resolveConsoleError({ code, message: 'Temporary failure' });
      assert.equal(resolved.retryable, true, `${code} phải cho phép thử lại`);
    }

    for (const code of [
      'REQUEST_QUOTA_EXCEEDED',
      'CHAR_QUOTA_EXCEEDED',
      'PERMISSION_DENIED',
      'TENANT_SUSPENDED',
      'UNAUTHORIZED',
      'NOT_FOUND',
      'VERSION_CONFLICT',
      'INVALID_REQUEST',
      'PLACEHOLDER_MISMATCH',
    ]) {
      const resolved = resolveConsoleError({ code, message: 'Rejected' });
      assert.equal(resolved.retryable, false, `${code} không tự động đánh dấu lỗi tạm thời`);
    }

    const fetchErr = resolveConsoleError(new TypeError('Failed to fetch'));
    assert.equal(fetchErr.code, 'NETWORK_ERROR');
    assert.equal(fetchErr.retryable, true);
    assert.match(fetchErr.message, /kết nối/i);

    const runtimeErr = resolveConsoleError(new Error('Something crashed'));
    assert.equal(runtimeErr.code, undefined);
    assert.equal(runtimeErr.retryable, false);
  });

  it('bảo vệ riêng tư QC-2: NOT_FOUND khác tenant trả thông báo đồng nhất, tuyệt đối không lộ khóa nội bộ hoặc stack trace', () => {
    const missingWebsiteMsg = websiteErrorMessage(new WebsiteApiError('NOT_FOUND', 'Not found'));
    const crossTenantWebsiteMsg = websiteErrorMessage(
      new WebsiteApiError(
        'NOT_FOUND',
        'Host secret-resort thuộc TENANT#t_other_999 (owner other@secret.vn)',
        undefined,
        'req-leak-1',
        404,
      ),
    );
    assert.equal(crossTenantWebsiteMsg, missingWebsiteMsg);
    assert.equal(crossTenantWebsiteMsg.includes('t_other_999'), false);
    assert.equal(crossTenantWebsiteMsg.includes('secret-resort'), false);
    assert.equal(crossTenantWebsiteMsg.includes('other@secret.vn'), false);

    const missingTermMsg = glossaryErrorMessage(new GlossaryApiError('NOT_FOUND', ''));
    const crossTenantTermMsg = glossaryErrorMessage(
      new GlossaryApiError('NOT_FOUND', 'Term in TENANT#t_999 does not belong to you'),
    );
    assert.equal(crossTenantTermMsg, missingTermMsg);
    assert.equal(crossTenantTermMsg.includes('t_999'), false);

    const missingReviewMsg = reviewErrorMessage(new ReviewApiError('NOT_FOUND', ''));
    const crossTenantReviewMsg = reviewErrorMessage(
      new ReviewApiError('NOT_FOUND', 'Hash HASH#abc123 of TENANT#t_other missing'),
    );
    assert.equal(crossTenantReviewMsg, missingReviewMsg);
    assert.equal(crossTenantReviewMsg.includes('HASH#abc123'), false);

    const crossTenantAuthMsg = mapCognitoErrorToVietnamese(
      new ConsoleAuthError('NOT_FOUND', 'Member alice@competitor.com in tenant t_other not found'),
    );
    assert.equal(crossTenantAuthMsg.includes('competitor.com'), false);
    assert.equal(crossTenantAuthMsg.includes('t_other'), false);

    assert.equal(
      sanitizeClientSafeMessage('ConditionalCheckFailedException on TENANT#t_01#HASH#ff'),
      null,
    );
    assert.equal(
      sanitizeClientSafeMessage('arn:aws:dynamodb:ap-southeast-1:123456:table/TranslateMe'),
      null,
    );
    assert.equal(sanitizeClientSafeMessage('Error\n    at handler (index.ts:42:11)'), null);
    assert.equal(sanitizeClientSafeMessage('Forbidden'), null);
    assert.equal(sanitizeClientSafeMessage('Internal server error'), null);
    assert.equal(
      sanitizeClientSafeMessage('Tên hiển thị tối đa 100 ký tự.'),
      'Tên hiển thị tối đa 100 ký tự.',
    );
  });

  it('extractApiErrorPayload và httpStatusToErrorCode xử lý chuẩn cấu trúc { request_id, error }', () => {
    assert.equal(httpStatusToErrorCode(401), 'UNAUTHORIZED');
    assert.equal(httpStatusToErrorCode(403), 'PERMISSION_DENIED');
    assert.equal(httpStatusToErrorCode(404), 'NOT_FOUND');
    assert.equal(httpStatusToErrorCode(409), 'VERSION_CONFLICT');
    assert.equal(httpStatusToErrorCode(429), 'RATE_LIMITED');
    assert.equal(httpStatusToErrorCode(503), 'INTERNAL_ERROR');
    assert.equal(httpStatusToErrorCode(400), 'INVALID_REQUEST');

    const extracted = extractApiErrorPayload(
      {
        request_id: 'req-api-001',
        error: {
          code: 'CHAR_QUOTA_EXCEEDED',
          message: 'Character quota exceeded',
          details: { limit: 100000 },
        },
      },
      429,
    );
    assert.equal(extracted.code, 'CHAR_QUOTA_EXCEEDED');
    assert.equal(extracted.requestId, 'req-api-001');
    assert.equal(extracted.httpStatus, 429);
    assert.deepEqual(extracted.details, { limit: 100000 });

    const fallback = extractApiErrorPayload({ message: 'Forbidden' }, 403);
    assert.equal(fallback.code, 'PERMISSION_DENIED');
    assert.equal(fallback.httpStatus, 403);
  });

  it('tích hợp HTTP client Website/Glossary/Review với toàn bộ mã Bảng 2.10 và giữ requestId', async () => {
    const makeErrorFetch =
      (status: number, code: string, message: string, requestId = 'req-test-1'): typeof fetch =>
      async () =>
        new Response(
          JSON.stringify({
            request_id: requestId,
            error: { code, message },
          }),
          { status, headers: { 'content-type': 'application/json' } },
        );

    const wApi = createHttpWebsiteApi({
      baseUrl: 'https://api.example',
      getToken: () => 'jwt',
      fetchFn: makeErrorFetch(403, 'TENANT_SUSPENDED', 'Tenant t_other suspended', 'req-w-403'),
    });
    await assert.rejects(
      wApi.listWebsites(),
      (err: unknown) =>
        err instanceof WebsiteApiError &&
        err.code === 'TENANT_SUSPENDED' &&
        err.requestId === 'req-w-403' &&
        err.httpStatus === 403 &&
        /tạm khóa/.test(websiteErrorMessage(err)),
    );

    const gApi = createHttpGlossaryApi({
      baseUrl: 'https://api.example',
      getToken: () => 'jwt',
      fetchFn: makeErrorFetch(429, 'RATE_LIMITED', 'Too many requests', 'req-g-429'),
    });
    await assert.rejects(
      gApi.listGlossary(),
      (err: unknown) => {
        if (!(err instanceof GlossaryApiError)) return false;
        const ui = errorToUiPayload(err, { scope: 'glossary', formatMessage: glossaryErrorMessage });
        return Boolean(
          ui &&
            ui.code === 'RATE_LIMITED' &&
            ui.requestId === 'req-g-429' &&
            ui.retryable === true &&
            /nhanh/.test(ui.message),
        );
      },
    );

    const rApi = createHttpReviewApi({
      baseUrl: 'https://api.example',
      getToken: () => 'jwt',
      fetchFn: makeErrorFetch(429, 'CHAR_QUOTA_EXCEEDED', 'Monthly quota exceeded', 'req-r-429'),
    });
    await assert.rejects(
      rApi.acceptTranslation({ srcLang: 'vi', tgtLang: 'en', hash: 'h1', expectedVersion: 1 }),
      (err: unknown) => {
        if (!(err instanceof ReviewApiError)) return false;
        const ui = errorToUiPayload(err, { scope: 'review', formatMessage: reviewErrorMessage });
        return Boolean(
          ui &&
            ui.code === 'CHAR_QUOTA_EXCEEDED' &&
            ui.requestId === 'req-r-429' &&
            ui.retryable === false &&
            /hạn mức ký tự/.test(ui.message),
        );
      },
    );

    const rErr500 = createHttpReviewApi({
      baseUrl: 'https://api.example',
      getToken: () => 'jwt',
      fetchFn: makeErrorFetch(500, 'INTERNAL_ERROR', 'DynamoDB ConditionalCheckFailed', 'req-r-500'),
    });
    await assert.rejects(
      rErr500.listTranslations({ srcLang: 'vi', tgtLang: 'en' }),
      (err: unknown) => {
        const ui = errorToUiPayload(err, { scope: 'review', formatMessage: reviewErrorMessage });
        return Boolean(
          ui &&
            ui.code === 'INTERNAL_ERROR' &&
            ui.requestId === 'req-r-500' &&
            ui.retryable === true &&
            !ui.message.includes('DynamoDB'),
        );
      },
    );
  });

  it('mapCognitoErrorToVietnamese dịch thông báo Cognito tiếng Anh và chặn thao tác ghi khi tenant LOCKED', () => {
    assert.match(
      mapCognitoErrorToVietnamese({ code: 'UsernameExistsException', message: 'User already exists' }),
      /đã được đăng ký/,
    );
    assert.match(
      mapCognitoErrorToVietnamese(
        new ConsoleAuthError('InvalidPasswordException', 'Password did not conform with policy'),
      ),
      /tối thiểu 8 ký tự/,
    );
    assert.match(
      mapCognitoErrorToVietnamese(new ConsoleAuthError('TENANT_SUSPENDED', 'Tenant t_abc locked')),
      /tạm khóa/,
    );

    for (const path of [
      '/console/members/invite',
      '/console/hosts',
      '/console/glossary/terms',
      '/console/translations',
    ]) {
      assert.equal(
        canConsoleRequest({ method: 'POST', path, tenantStatus: 'LOCKED' }),
        false,
        `${path} phải bị chặn khi LOCKED`,
      );
      assert.equal(
        canConsoleRequest({ method: 'PUT', path, tenantStatus: 'LOCKED' }),
        false,
        `PUT ${path} phải bị chặn khi LOCKED`,
      );
    }
  });
});
