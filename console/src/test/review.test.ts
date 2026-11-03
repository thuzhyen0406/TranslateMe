import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ReviewApiError,
  createHttpReviewApi,
  createMockReviewApi,
  extractPlaceholderTokens,
  invalidationFromJson,
  reviewErrorMessage,
  reviewItemFromJson,
  validatePlaceholders,
} from '../services/reviewApi.js';

describe('Q4 – kiểm tra ký hiệu định dạng {n} và thông báo lỗi (Task 4.10)', () => {
  it('extractPlaceholderTokens và validatePlaceholders nhận diện đúng {n}, cho phép đảo thứ tự cặp và bỏ qua {{ }}', () => {
    const src = 'Phòng có {1}ban công{/1} và {2}bảng giá{/2} mẫu {{ten}}.';
    assert.deepEqual(extractPlaceholderTokens(src), ['{1}', '{/1}', '{2}', '{/2}']);

    // Đúng thứ tự
    const ok1 = validatePlaceholders(src, 'Room has {1}balcony{/1} and {2}price list{/2}.');
    assert.equal(ok1.ok, true);
    assert.deepEqual(ok1.missing, []);
    assert.deepEqual(ok1.extra, []);

    // Đảo thứ tự {2} lên trước {1} (tiếng Hàn/Nhật) vẫn hợp lệ
    const okReordered = validatePlaceholders(src, '{2}요금표{/2}와 {1}발코니{/1}가 있습니다.');
    assert.equal(okReordered.ok, true);

    // Thiếu {/1} và thừa {3}
    const mismatch = validatePlaceholders(src, 'Room has {1}balcony and {2}price{/2} {3}.');
    assert.equal(mismatch.ok, false);
    assert.deepEqual(mismatch.missing, ['{/1}']);
    assert.deepEqual(mismatch.extra, ['{3}']);

    // Đóng trước khi mở ({/1} ... {1})
    const inverted = validatePlaceholders('Xem {1}tại đây{/1}.', 'See {/1}here{1}.');
    assert.equal(inverted.ok, false);
    assert.ok(inverted.missing.length > 0);
  });

  it('reviewErrorMessage trả thông báo tiếng Việt rõ ràng cho PLACEHOLDER_MISMATCH, VERSION_CONFLICT, PERMISSION_DENIED, TENANT_SUSPENDED', () => {
    const phErr = new ReviewApiError('PLACEHOLDER_MISMATCH', '', {
      missing: ['{/1}'],
      extra: ['{9}'],
    });
    const msg = reviewErrorMessage(phErr);
    assert.ok(msg.includes('thiếu ký hiệu: {/1}'));
    assert.ok(msg.includes('thừa ký hiệu: {9}'));

    assert.ok(
      reviewErrorMessage(new ReviewApiError('VERSION_CONFLICT', '')).includes('người khác cập nhật'),
    );
    assert.ok(
      reviewErrorMessage(new ReviewApiError('PERMISSION_DENIED', '')).includes('Reviewer'),
    );
    assert.ok(
      reviewErrorMessage(new ReviewApiError('TENANT_SUSPENDED', '')).includes('tạm khóa'),
    );
  });

  it('reviewItemFromJson và invalidationFromJson hỗ trợ cả snake_case (Bảng 2.9) và camelCase (reviewManager)', () => {
    const item = reviewItemFromJson({
      hash: 'h123',
      src_lang: 'vi',
      tgt_lang: 'en',
      src_text: 'Xin chào {1}bạn{/1}.',
      tgt_text: 'Hello {1}friend{/1}.',
      machine_text: 'Hi {1}you{/1}.',
      status: 'HUMAN',
      needs_review: true,
      glossary_warnings: [
        { source_term: 'Homestay ABC', expected_target: 'Homestay ABC', mode: 'KEEP' },
      ],
      version: 4,
      glossary_version: 2,
      reviewer_id: 'minh@homestay-abc.vn',
      pages: [],
    });
    assert.equal(item.hash, 'h123');
    assert.equal(item.srcText, 'Xin chào {1}bạn{/1}.');
    assert.equal(item.tgtText, 'Hello {1}friend{/1}.');
    assert.equal(item.machineText, 'Hi {1}you{/1}.');
    assert.equal(item.status, 'HUMAN');
    assert.equal(item.needsReview, true);
    assert.equal(item.unused, true, 'pages rỗng phải đánh dấu unused = true (Không còn sử dụng)');
    assert.equal(item.glossaryWarnings[0].sourceTerm, 'Homestay ABC');

    const inv = invalidationFromJson({
      status: 'SUBMITTED',
      mode: 'PATHS',
      paths: ['/homestay-abc/en/'],
      invalidation_id: 'I-999',
    });
    assert.equal(inv.status, 'SUBMITTED');
    assert.equal(inv.invalidationId, 'I-999');
    assert.deepEqual(inv.paths, ['/homestay-abc/en/']);
  });
});

describe('createHttpReviewApi – kết nối với dịch vụ F5 (Task 3.8)', () => {
  it('gửi đúng JWT Bearer token, tham số lọc và xử lý lỗi 400 PLACEHOLDER_MISMATCH & 409 VERSION_CONFLICT kèm latest', async () => {
    const calls: Array<{ url: string; method: string; auth: string | null; body?: unknown }> = [];

    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const headers = new Headers(init?.headers);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, auth: headers.get('authorization'), body });

      if (url.includes('/console/review/translations?') && method === 'GET') {
        return new Response(
          JSON.stringify({
            items: [
              {
                hash: 'hash_1',
                srcLang: 'vi',
                tgtLang: 'en',
                srcText: 'Câu {1}một{/1}.',
                tgtText: 'Sentence {1}one{/1}.',
                machineText: 'Sentence {1}one{/1}.',
                status: 'MACHINE',
                needsReview: false,
                glossaryWarnings: [],
                version: 1,
                pages: ['/homestay-abc/en/'],
              },
            ],
          }),
          { status: 200 },
        );
      }

      if (url.endsWith('/hash_conflict') && method === 'PUT') {
        return new Response(
          JSON.stringify({
            error: {
              code: 'VERSION_CONFLICT',
              message: 'Phiên bản không khớp',
              details: {
                latest: {
                  hash: 'hash_conflict',
                  srcLang: 'vi',
                  tgtLang: 'en',
                  srcText: 'Câu {1}một{/1}.',
                  tgtText: 'Bản mới nhất ở v2.',
                  machineText: 'Sentence {1}one{/1}.',
                  status: 'HUMAN',
                  version: 2,
                  reviewerId: 'lan@homestay-abc.vn',
                  pages: ['/homestay-abc/en/'],
                },
              },
            },
          }),
          { status: 409 },
        );
      }

      if (url.endsWith('/hash_bad_ph') && method === 'PUT') {
        return new Response(
          JSON.stringify({
            error: {
              code: 'PLACEHOLDER_MISMATCH',
              message: 'Lệch ký hiệu',
              details: {
                missing: ['{/1}'],
                extra: ['{2}'],
              },
            },
          }),
          { status: 400 },
        );
      }

      return new Response(JSON.stringify({}), { status: 200 });
    };

    const api = createHttpReviewApi({
      baseUrl: 'https://api.translateme.example',
      getToken: () => 'jwt-token-reviewer',
      fetchFn: fakeFetch,
    });

    const list = await api.listTranslations({
      slug: 'homestay-abc',
      srcLang: 'vi',
      tgtLang: 'en',
      labelFilter: 'NEEDS_REVIEW',
    });
    assert.equal(list.items.length, 1);
    assert.equal(calls[0].auth, 'Bearer jwt-token-reviewer');
    assert.ok(calls[0].url.includes('needsReview=true'));

    // Kiểm tra nhận lỗi 409 VERSION_CONFLICT kèm bản latest
    await assert.rejects(
      () =>
        api.saveAndPublishTranslation({
          srcLang: 'vi',
          tgtLang: 'en',
          hash: 'hash_conflict',
          editedText: 'Bản sửa của tôi',
          expectedVersion: 1,
        }),
      (err: unknown) =>
        err instanceof ReviewApiError &&
        err.code === 'VERSION_CONFLICT' &&
        err.latest?.version === 2 &&
        err.latest?.tgtText === 'Bản mới nhất ở v2.',
    );

    // Kiểm tra nhận lỗi 400 PLACEHOLDER_MISMATCH kèm missing và extra
    await assert.rejects(
      () =>
        api.saveAndPublishTranslation({
          srcLang: 'vi',
          tgtLang: 'en',
          hash: 'hash_bad_ph',
          editedText: 'Sentence {1}one {2}.',
          expectedVersion: 1,
        }),
      (err: unknown) =>
        err instanceof ReviewApiError &&
        err.code === 'PLACEHOLDER_MISMATCH' &&
        assert.deepEqual(err.missing, ['{/1}']) === undefined &&
        assert.deepEqual(err.extra, ['{2}']) === undefined,
    );
  });
});

describe('createMockReviewApi – toàn bộ luồng duyệt Q4 trong chế độ demo', () => {
  it('lọc câu theo trang, theo nhãn (Máy dịch, Đã duyệt, Cần xem lại, Không còn sử dụng) và từ khóa', async () => {
    const api = createMockReviewApi();

    const allEn = await api.listTranslations({ srcLang: 'vi', tgtLang: 'en' });
    assert.equal(allEn.items.length, 5);

    const needsReview = await api.listTranslations({
      srcLang: 'vi',
      tgtLang: 'en',
      labelFilter: 'NEEDS_REVIEW',
    });
    assert.equal(needsReview.items.length, 2);

    const unused = await api.listTranslations({
      srcLang: 'vi',
      tgtLang: 'en',
      pagePath: '__UNUSED__',
    });
    assert.equal(unused.items.length, 1);
    assert.equal(unused.items[0].unused, true);

    const byKeyword = await api.listTranslations({
      srcLang: 'vi',
      tgtLang: 'en',
      search: 'trà thảo mộc',
    });
    assert.equal(byKeyword.items.length, 1);
  });

  it('thực hiện đủ 3 thao tác: Chấp nhận nguyên bản, Lưu và xuất bản (kèm xóa cache chọn lọc) và Khôi phục bản máy', async () => {
    const api = createMockReviewApi();
    const list = await api.listTranslations({ srcLang: 'vi', tgtLang: 'en' });
    const first = list.items[0]; // MACHINE, v1

    // 1. Chấp nhận nguyên bản -> HUMAN, v2, needsReview = false
    const accepted = await api.acceptTranslation({
      srcLang: first.srcLang,
      tgtLang: first.tgtLang,
      hash: first.hash,
      expectedVersion: first.version,
    });
    assert.equal(accepted.item.status, 'HUMAN');
    assert.equal(accepted.item.needsReview, false);
    assert.equal(accepted.item.version, 2);

    // 2. Lưu và xuất bản khi thiếu ký hiệu {1} -> bị từ chối với PLACEHOLDER_MISMATCH
    await assert.rejects(
      () =>
        api.saveAndPublishTranslation({
          srcLang: first.srcLang,
          tgtLang: first.tgtLang,
          hash: first.hash,
          editedText: 'Welcome to Homestay ABC by the Thu Bon river.',
          expectedVersion: 2,
        }),
      (err: unknown) =>
        err instanceof ReviewApiError &&
        err.code === 'PLACEHOLDER_MISMATCH' &&
        err.missing?.includes('{1}') === true,
    );

    // 3. Lưu và xuất bản hợp lệ -> HUMAN, v3, kích hoạt xóa cache đúng 2 trang chứa câu đó
    const saved = await api.saveAndPublishTranslation({
      srcLang: first.srcLang,
      tgtLang: first.tgtLang,
      hash: first.hash,
      editedText: 'Warm welcome to {1}Homestay ABC{/1} by the Thu Bon river.',
      expectedVersion: 2,
    });
    assert.equal(saved.item.status, 'HUMAN');
    assert.equal(saved.item.version, 3);
    assert.equal(saved.invalidation.status, 'SUBMITTED');
    assert.deepEqual(saved.invalidation.paths, ['/homestay-abc/en/', '/homestay-abc/en/lien-he']);

    const invStatus = await api.checkInvalidationStatus(saved.invalidation.invalidationId!);
    assert.equal(invStatus.status, 'Completed');

    // 4. Khôi phục bản máy dịch -> MACHINE, v4, nội dung quay về machineText
    const restored = await api.restoreMachineTranslation({
      srcLang: first.srcLang,
      tgtLang: first.tgtLang,
      hash: first.hash,
      expectedVersion: 3,
    });
    assert.equal(restored.item.status, 'MACHINE');
    assert.equal(restored.item.version, 4);
    assert.equal(restored.item.tgtText, first.machineText);
  });

  it('xử lý xung đột 409 VERSION_CONFLICT (kèm bản mới nhất) và lỗi làm mới CloudFront + Thử lại', async () => {
    const api = createMockReviewApi();
    const list = await api.listTranslations({ srcLang: 'vi', tgtLang: 'en' });
    const target = list.items[3]; // v1

    // Giả lập người khác vừa lưu câu này lên v2
    api.simulateConcurrentEdit(target.srcLang, target.tgtLang, target.hash, 'Updated by another reviewer.');

    // Lưu với expectedVersion = 1 -> nhận 409 VERSION_CONFLICT kèm latest (v2)
    let conflictLatestVersion = 0;
    await assert.rejects(
      () =>
        api.saveAndPublishTranslation({
          srcLang: target.srcLang,
          tgtLang: target.tgtLang,
          hash: target.hash,
          editedText: 'My overridden translation.',
          expectedVersion: 1,
        }),
      (err: unknown) => {
        if (err instanceof ReviewApiError && err.code === 'VERSION_CONFLICT' && err.latest) {
          conflictLatestVersion = err.latest.version;
          return err.latest.tgtText === 'Updated by another reviewer.';
        }
        return false;
      },
    );
    assert.equal(conflictLatestVersion, 2);

    // Bật giả lập lỗi CloudFront rồi lưu đè với expectedVersion = 2 -> bản sửa vẫn lưu lên v3 nhưng invalidation = FAILED
    api.setSimulateCdnFailure(true);
    const savedWithCdnFail = await api.saveAndPublishTranslation({
      srcLang: target.srcLang,
      tgtLang: target.tgtLang,
      hash: target.hash,
      editedText: 'My overridden translation.',
      expectedVersion: 2,
    });
    assert.equal(savedWithCdnFail.item.version, 3);
    assert.equal(savedWithCdnFail.item.tgtText, 'My overridden translation.');
    assert.equal(savedWithCdnFail.invalidation.status, 'FAILED');

    // Tắt lỗi CloudFront và bấm Thử lại -> SUBMITTED
    api.setSimulateCdnFailure(false);
    const retried = await api.retryInvalidation({
      srcLang: target.srcLang,
      tgtLang: target.tgtLang,
      hash: target.hash,
    });
    assert.equal(retried.status, 'SUBMITTED');
    assert.deepEqual(retried.paths, ['/homestay-abc/en/bang-gia']);
  });
});
