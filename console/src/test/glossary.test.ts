import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  GlossaryApiError,
  analyzeGlossaryCsv,
  buildSampleGlossaryCsv,
  createHttpGlossaryApi,
  createMockGlossaryApi,
  decodeCsvUtf8Bytes,
  glossaryErrorMessage,
  glossaryTermFromJson,
  validateUpsertTermInput,
} from '../services/glossaryApi.js';

describe('Q3 – kiểm tra đầu vào thuật ngữ và giải mã CSV UTF-8 (Task 4.11)', () => {
  it('validateUpsertTermInput kiểm tra từ nguồn, loại KEEP/FIXED và chặn thẻ HTML hoặc ký hiệu {n}', () => {
    assert.equal(
      validateUpsertTermInput({
        sourceTerm: 'Homestay ABC',
        sourceLang: 'vi',
        type: 'KEEP',
        translations: {},
        targetLangs: ['en', 'ko'],
      }),
      null,
    );

    assert.ok(
      validateUpsertTermInput({
        sourceTerm: '   ',
        sourceLang: 'vi',
        type: 'KEEP',
        translations: {},
        targetLangs: ['en'],
      })?.includes('không được để trống'),
    );

    assert.ok(
      validateUpsertTermInput({
        sourceTerm: 'phố cổ Hội An',
        sourceLang: 'vi',
        type: 'FIXED',
        translations: { en: '   ' },
        targetLangs: ['en'],
      })?.includes('ít nhất một ngôn ngữ đích'),
    );

    assert.ok(
      validateUpsertTermInput({
        sourceTerm: '<b>Homestay</b>',
        sourceLang: 'vi',
        type: 'KEEP',
        translations: {},
        targetLangs: ['en'],
      })?.includes('HTML'),
    );

    assert.ok(
      validateUpsertTermInput({
        sourceTerm: 'Câu {1}mẫu{/1}',
        sourceLang: 'vi',
        type: 'KEEP',
        translations: {},
        targetLangs: ['en'],
      })?.includes('{n}'),
    );
  });

  it('decodeCsvUtf8Bytes nhận UTF-8 (kể cả BOM) và từ chối mảng byte không phải UTF-8', () => {
    const sample = buildSampleGlossaryCsv();
    const utf8WithBom = new TextEncoder().encode('\uFEFF' + sample);
    assert.equal(decodeCsvUtf8Bytes(utf8WithBom), sample);

    // Byte 0xE0 đơn lẻ (Latin-1 'à') không phải chuỗi UTF-8 hợp lệ
    const invalidLatin1 = new Uint8Array([0x76, 0x69, 0x2c, 0x65, 0x6e, 0x0a, 0x43, 0x68, 0xe0, 0x6f]);
    assert.throws(
      () => decodeCsvUtf8Bytes(invalidLatin1),
      (err: unknown) => err instanceof GlossaryApiError && err.code === 'INVALID_REQUEST',
    );
  });

  it('analyzeGlossaryCsv phân loại KEEP/FIXED, bắt lỗi dòng CSV và tính đúng số dòng trùng lặp', () => {
    const existing = new Map([
      [
        'homestay abc',
        glossaryTermFromJson({
          source_term: 'Homestay ABC',
          source_lang: 'vi',
          type: 'KEEP',
          translations: { en: 'Homestay ABC', ko: 'Homestay ABC' },
          updated_in_version: 1,
        }),
      ],
    ]);

    const csv = [
      'vi,en,ko',
      'Homestay ABC,Homestay ABC,Homestay ABC',
      'mì Quảng,Quang noodles,꽝남 쌀국수',
      'đèn lồng,Lantern,',
      'mì Quảng,Duplicate in file,중복',
      ',Empty source,빈 원본',
    ].join('\n');

    const overwriteAnalysis = analyzeGlossaryCsv(csv, existing, 'OVERWRITE', 2);
    assert.equal(overwriteAnalysis.result.validRows, 2);
    assert.equal(overwriteAnalysis.result.addedCount, 1);
    assert.equal(overwriteAnalysis.result.overwrittenCount, 1);
    assert.equal(overwriteAnalysis.result.skippedCount, 0);
    assert.equal(overwriteAnalysis.result.duplicates.length, 1);
    assert.equal(overwriteAnalysis.result.duplicates[0].term, 'Homestay ABC');
    assert.equal(overwriteAnalysis.result.errors.length, 3);
    assert.equal(overwriteAnalysis.parsedEntries[0].type, 'KEEP');
    assert.equal(overwriteAnalysis.parsedEntries[1].type, 'FIXED');

    const keepExistingAnalysis = analyzeGlossaryCsv(csv, existing, 'KEEP_EXISTING', 2);
    assert.equal(keepExistingAnalysis.result.overwrittenCount, 0);
    assert.equal(keepExistingAnalysis.result.skippedCount, 1);

    // Thiếu cột ngôn ngữ trên dòng tiêu đề
    const missingLangCol = analyzeGlossaryCsv('vi\nHomestay ABC', existing, 'OVERWRITE', 2);
    assert.equal(missingLangCol.result.validRows, 0);
    assert.ok(missingLangCol.result.errors[0].reason.includes('thiếu cột ngôn ngữ'));
  });
});

describe('createHttpGlossaryApi – kết nối với dịch vụ F4 (Task 2.8)', () => {
  it('gửi đúng JWT Bearer token cho GET/PUT/DELETE/POST import và ánh xạ lỗi tiếng Việt', async () => {
    const calls: Array<{ url: string; method: string; auth: string | null; body?: unknown }> = [];

    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const headers = new Headers(init?.headers);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, auth: headers.get('authorization'), body });

      if (url.endsWith('/console/glossary/terms') && method === 'GET') {
        return new Response(
          JSON.stringify({
            version: 3,
            terminology_name: 'tm-t_123-v3',
            terms: [
              {
                source_term: 'Homestay ABC',
                source_lang: 'vi',
                type: 'KEEP',
                translations: { en: 'Homestay ABC' },
                updated_in_version: 3,
              },
            ],
          }),
          { status: 200 },
        );
      }

      if (url.includes('/console/glossary/terms/') && method === 'PUT') {
        return new Response(
          JSON.stringify({
            version: 4,
            terminology_synced: true,
            term: {
              source_term: 'cao lầu',
              source_lang: 'vi',
              type: 'FIXED',
              translations: { en: 'cao lau noodles' },
              updated_in_version: 4,
            },
          }),
          { status: 200 },
        );
      }

      if (url.endsWith('/console/glossary/import/preview') && method === 'POST') {
        return new Response(
          JSON.stringify({
            valid_rows: 4,
            errors: [],
            duplicates: [{ term: 'Homestay ABC' }],
            added_count: 3,
            overwritten_count: 1,
            skipped_count: 0,
            version: 4,
          }),
          { status: 200 },
        );
      }

      return new Response(
        JSON.stringify({
          error: { code: 'PERMISSION_DENIED', message: 'Forbidden' },
        }),
        { status: 403 },
      );
    };

    const api = createHttpGlossaryApi({
      baseUrl: 'https://api.translateme.example',
      getToken: () => 'jwt-admin-token',
      fetchFn: fakeFetch,
    });

    const state = await api.listGlossary();
    assert.equal(state.version, 3);
    assert.equal(state.terminologyName, 'tm-t_123-v3');
    assert.equal(state.terms.length, 1);
    assert.equal(calls[0].auth, 'Bearer jwt-admin-token');

    const upserted = await api.upsertTerm({
      sourceTerm: 'cao lầu',
      sourceLang: 'vi',
      type: 'FIXED',
      translations: { en: 'cao lau noodles' },
      targetLangs: ['en'],
    });
    assert.equal(upserted.version, 4);
    assert.equal(upserted.term.sourceTerm, 'cao lầu');

    const preview = await api.previewImportCsv(buildSampleGlossaryCsv(), 'OVERWRITE');
    assert.equal(preview.validRows, 4);
    assert.equal(preview.overwrittenCount, 1);

    await assert.rejects(
      () => api.deleteTerm('Homestay ABC'),
      (err: unknown) =>
        err instanceof GlossaryApiError &&
        err.code === 'PERMISSION_DENIED' &&
        glossaryErrorMessage(err).includes('Tenant Admin'),
    );
  });
});

describe('createMockGlossaryApi – toàn bộ luồng Q3 trong chế độ demo', () => {
  it('thêm loại KEEP (tự điền từ nguồn), thêm loại FIXED, sửa, xóa và nhập CSV tăng phiên bản', async () => {
    const api = createMockGlossaryApi();

    const initial = await api.listGlossary();
    assert.equal(initial.version, 2);
    assert.equal(initial.terms.length, 4);

    // 1. Thêm mục KEEP -> tự động điền từ nguồn cho mọi ngôn ngữ đích, version tăng lên 3
    const addedKeep = await api.upsertTerm({
      sourceTerm: 'VinWonders Nam Hội An',
      sourceLang: 'vi',
      type: 'KEEP',
      translations: {},
      targetLangs: ['en', 'ko', 'ja'],
    });
    assert.equal(addedKeep.version, 3);
    assert.deepEqual(addedKeep.term.translations, {
      en: 'VinWonders Nam Hội An',
      ko: 'VinWonders Nam Hội An',
      ja: 'VinWonders Nam Hội An',
    });

    // 2. Xóa mục vừa thêm -> version tăng lên 4
    const deleted = await api.deleteTerm('VinWonders Nam Hội An');
    assert.equal(deleted.deleted, true);
    assert.equal(deleted.version, 4);

    // 3. Xem trước và Nhập CSV với từ mới + từ trùng
    const csv = [
      'vi,en,ko',
      'Homestay ABC,Homestay ABC,Homestay ABC',
      'bánh mì Phượng,Banh Mi Phuong,반미 프엉',
    ].join('\n');

    const preview = await api.previewImportCsv(csv, 'KEEP_EXISTING');
    assert.equal(preview.validRows, 2);
    assert.equal(preview.addedCount, 1);
    assert.equal(preview.skippedCount, 1);

    const committed = await api.commitImportCsv(csv, 'KEEP_EXISTING');
    assert.equal(committed.version, 5);

    const finalState = await api.listGlossary();
    assert.equal(finalState.version, 5);
    assert.equal(finalState.terms.length, 5);
  });
});
