import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_GLOSSARY_TARGET_LANGS,
  GlossaryApiError,
  analyzeGlossaryCsv,
  buildSampleGlossaryCsv,
  buildUpsertGlossaryInput,
  createHttpGlossaryApi,
  createMockGlossaryApi,
  decodeCsvUtf8Bytes,
  getEditableGlossaryTargetLangs,
  getGlossaryTableLangs,
  glossaryErrorMessage,
  mergeGlossaryCacheInvalidations,
  glossaryTermFromJson,
  initGlossaryFormTranslations,
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
  it('giữ và gộp các invalidation ID cũ khi thử lại', () => {
    const merged = mergeGlossaryCacheInvalidations(
      {
        status: 'PARTIAL', mode: 'WILDCARD', paths: ['/site-a/*', '/site-b/*'],
        invalidationIds: ['inv-first'], failedPaths: ['/site-b/*'],
      },
      {
        status: 'SUBMITTED', mode: 'WILDCARD', paths: ['/site-b/*'],
        invalidationIds: ['inv-second'], failedPaths: [],
      },
    );

    assert.deepEqual(merged.invalidationIds, ['inv-first', 'inv-second']);
    assert.deepEqual(merged.paths, ['/site-a/*', '/site-b/*']);
    assert.deepEqual(merged.failedPaths, []);
  });

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
            terminologyName: 'tm-t_123-v3',
            terms: [
              {
                normalized: 'homestay abc',
                sourceTerm: 'Homestay ABC',
                sourceLang: 'vi',
                type: 'KEEP',
                translations: { en: 'Homestay ABC' },
                sinceVersion: 3,
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
            terminologySynced: true,
            cacheInvalidation: {
              status: 'SUBMITTED', mode: 'WILDCARD', paths: ['/site-a/*'], invalidationIds: ['inv-123'],
            },
          }),
          { status: 200 },
        );
      }

      if (url.endsWith('/console/glossary/cache-invalidation/retry') && method === 'POST') {
        assert.deepEqual(body, { failedPaths: ['/site-b/*'] });
        return new Response(JSON.stringify({
          status: 'SUBMITTED', mode: 'WILDCARD', paths: ['/site-a/*'], invalidationIds: ['inv-retry'],
        }), { status: 200 });
      }
      if (url.endsWith('/console/glossary/cache-invalidation/inv-123') && method === 'GET') {
        return new Response(JSON.stringify({ id: 'inv-123', status: 'COMPLETED', paths: ['/site-a/*'] }), { status: 200 });
      }

      if (url.endsWith('/console/glossary/import/preview') && method === 'POST') {
        return new Response(
          JSON.stringify({
            validRows: 4,
            errors: [],
            duplicates: [{ term: 'Homestay ABC' }],
            addedCount: 3,
            overwrittenCount: 1,
            skippedCount: 0,
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
    assert.equal(state.terms[0].normalizedTerm, 'homestay abc');
    assert.equal(state.terms[0].updatedInVersion, 3);
    assert.equal(calls[0].auth, 'Bearer jwt-admin-token');

    const upserted = await api.upsertTerm({
      sourceTerm: 'cao lầu',
      sourceLang: 'vi',
      type: 'FIXED',
      translations: { en: 'cao lau noodles' },
      targetLangs: ['en'],
    });
    assert.equal(upserted.version, 4);
    assert.equal(upserted.terminologySynced, true);
    assert.equal(upserted.cacheInvalidation?.status, 'SUBMITTED');
    assert.deepEqual(upserted.cacheInvalidation?.invalidationIds, ['inv-123']);
    // F4 không trả term -> console dựng lại từ dữ liệu đã gửi
    assert.equal(upserted.term.sourceTerm, 'cao lầu');
    assert.equal(upserted.term.type, 'FIXED');
    // Body chỉ dùng camelCase như handleGlossaryRoute
    const putBody = calls[1].body as Record<string, unknown>;
    assert.equal(putBody.sourceTerm, 'cao lầu');
    assert.equal('source_term' in putBody, false);
    assert.equal('source_lang' in putBody, false);
    assert.equal('target_langs' in putBody, false);

    const retried = await api.retryCacheInvalidation(['/site-b/*']);
    assert.equal(retried.status, 'SUBMITTED');
    assert.deepEqual(retried.invalidationIds, ['inv-retry']);
    assert.equal(calls[2].url, 'https://api.translateme.example/console/glossary/cache-invalidation/retry');
    const invalidationStatus = await api.getCacheInvalidationStatus('inv-123');
    assert.equal(invalidationStatus.status, 'COMPLETED');
    assert.deepEqual(invalidationStatus.paths, ['/site-a/*']);

    const preview = await api.previewImportCsv(buildSampleGlossaryCsv(), 'OVERWRITE');
    assert.equal(preview.validRows, 4);
    assert.equal(preview.overwrittenCount, 1);
    const previewBody = calls[4].body as Record<string, unknown>;
    assert.equal(previewBody.onDuplicate, 'OVERWRITE');
    assert.equal('on_duplicate' in previewBody, false);

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

  it('cho phép nhập đủ en/ko/ja/zh/fr, đồng bộ cột bảng và giữ nguyên zh/fr/ngôn ngữ khác khi sửa thuật ngữ', async () => {
    // 1. Hợp đồng mặc định phải đủ 5 ngôn ngữ đích en, ko, ja, zh, fr
    for (const lang of ['en', 'ko', 'ja', 'zh', 'fr']) {
      assert.ok(
        DEFAULT_GLOSSARY_TARGET_LANGS.includes(lang),
        `DEFAULT_GLOSSARY_TARGET_LANGS phải gồm ${lang}`,
      );
    }

    // 2. Term có sẵn en/ko/ja/zh/fr (và cả de mở rộng) -> khi mở form Sửa phải nạp & giữ đủ mọi ngôn ngữ
    const existingTerm = glossaryTermFromJson({
      sourceTerm: 'bún chả',
      sourceLang: 'vi',
      type: 'FIXED',
      translations: {
        en: 'bun cha',
        ko: '분짜',
        ja: 'ブンチャー',
        zh: '烤肉米线',
        fr: 'bun cha grillé',
        de: 'Bun-Cha-Nudeln',
      },
      sinceVersion: 2,
    });

    const editableLangs = getEditableGlossaryTargetLangs(
      existingTerm.sourceLang,
      existingTerm.translations,
    );
    assert.deepEqual(editableLangs, ['en', 'ko', 'ja', 'zh', 'fr', 'de']);

    const tableCols = getGlossaryTableLangs([existingTerm]);
    assert.deepEqual(tableCols, ['en', 'ko', 'ja', 'zh', 'fr', 'de']);

    const formInit = initGlossaryFormTranslations(existingTerm);
    assert.equal(formInit.zh, '烤肉米线');
    assert.equal(formInit.fr, 'bun cha grillé');
    assert.equal(formInit.de, 'Bun-Cha-Nudeln');

    // Người dùng chỉ sửa cột tiếng Anh -> payload phải giữ nguyên zh, fr, de
    const editedForm = { ...formInit, en: 'grilled pork with rice noodles' };
    const payload = buildUpsertGlossaryInput({
      sourceTerm: existingTerm.sourceTerm,
      sourceLang: existingTerm.sourceLang,
      type: existingTerm.type,
      formTranslations: editedForm,
      targetLangs: editableLangs,
    });
    assert.equal(payload.translations.en, 'grilled pork with rice noodles');
    assert.equal(payload.translations.zh, '烤肉米线');
    assert.equal(payload.translations.fr, 'bun cha grillé');
    assert.equal(payload.translations.de, 'Bun-Cha-Nudeln');

    // 3. Kiểm tra qua createHttpGlossaryApi: PUT gửi đủ zh/fr và GET/kết quả trả về còn nguyên zh/fr
    const sentBodies: Array<Record<string, unknown>> = [];
    const serverStore = new Map<string, Record<string, unknown>>([
      [
        'bún chả',
        {
          normalized: 'bún chả',
          sourceTerm: 'bún chả',
          sourceLang: 'vi',
          type: 'FIXED',
          translations: { ...existingTerm.translations },
          sinceVersion: 2,
        },
      ],
    ]);

    const httpApi = createHttpGlossaryApi({
      baseUrl: 'https://api.translateme.example',
      getToken: () => 'jwt-admin-token',
      fetchFn: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/console/glossary/terms') && method === 'GET') {
          return new Response(
            JSON.stringify({
              version: 3,
              terms: [...serverStore.values()],
            }),
            { status: 200 },
          );
        }
        if (url.includes('/console/glossary/terms/') && method === 'PUT') {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          sentBodies.push(body);
          serverStore.set('bún chả', {
            normalized: 'bún chả',
            sourceTerm: body.sourceTerm,
            sourceLang: body.sourceLang,
            type: body.type,
            translations: body.translations,
            sinceVersion: 3,
          });
          return new Response(JSON.stringify({ version: 3, terminologySynced: true }), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 404 });
      },
    });

    const savedHttp = await httpApi.upsertTerm(payload);
    assert.equal(savedHttp.term.translations.zh, '烤肉米线');
    assert.equal(savedHttp.term.translations.fr, 'bun cha grillé');
    assert.equal(savedHttp.term.translations.de, 'Bun-Cha-Nudeln');
    const httpSentTranslations = sentBodies[0].translations as Record<string, string>;
    assert.equal(httpSentTranslations.zh, '烤肉米线');
    assert.equal(httpSentTranslations.fr, 'bun cha grillé');
    assert.equal(httpSentTranslations.de, 'Bun-Cha-Nudeln');

    const reloadedHttp = await httpApi.listGlossary();
    assert.equal(reloadedHttp.terms[0].translations.en, 'grilled pork with rice noodles');
    assert.equal(reloadedHttp.terms[0].translations.zh, '烤肉米线');
    assert.equal(reloadedHttp.terms[0].translations.fr, 'bun cha grillé');
    assert.equal(reloadedHttp.terms[0].translations.de, 'Bun-Cha-Nudeln');

    // 4. Kiểm tra qua createMockGlossaryApi: sửa term có sẵn zh/fr sau upsert vẫn giữ nguyên zh/fr
    const mockApi = createMockGlossaryApi();
    await mockApi.upsertTerm(payload);
    const mockList = await mockApi.listGlossary();
    const savedMock = mockList.terms.find((t) => t.normalizedTerm === 'bún chả');
    assert.ok(savedMock);
    assert.equal(savedMock.translations.zh, '烤肉米线');
    assert.equal(savedMock.translations.fr, 'bun cha grillé');
    assert.equal(savedMock.translations.de, 'Bun-Cha-Nudeln');

    // Sửa lại một term demo mặc định (phố cổ Hội An đã có sẵn zh/fr) chỉ thay en -> zh/fr vẫn còn
    const hoiAn = mockList.terms.find((t) => t.normalizedTerm === 'phố cổ hội an');
    assert.ok(hoiAn && hoiAn.translations.zh && hoiAn.translations.fr);
    const hoiAnForm = initGlossaryFormTranslations(hoiAn);
    const hoiAnPayload = buildUpsertGlossaryInput({
      sourceTerm: hoiAn.sourceTerm,
      sourceLang: hoiAn.sourceLang,
      type: hoiAn.type,
      formTranslations: { ...hoiAnForm, en: 'Hoi An Historic Town' },
      targetLangs: getEditableGlossaryTargetLangs(hoiAn.sourceLang, hoiAn.translations),
    });
    const hoiAnSaved = await mockApi.upsertTerm(hoiAnPayload);
    assert.equal(hoiAnSaved.term.translations.en, 'Hoi An Historic Town');
    assert.equal(hoiAnSaved.term.translations.zh, hoiAn.translations.zh);
    assert.equal(hoiAnSaved.term.translations.fr, hoiAn.translations.fr);

    // 5. Loại FIXED chỉ điền một số ngôn ngữ (ví dụ en, zh) -> bỏ các ô trống để F4 không báo lỗi 400
    const partialFixedPayload = buildUpsertGlossaryInput({
      sourceTerm: 'bánh xèo',
      sourceLang: 'vi',
      type: 'FIXED',
      formTranslations: { en: 'crispy pancake', ko: '  ', ja: '', zh: '越南煎饼', fr: '' },
      targetLangs: ['en', 'ko', 'ja', 'zh', 'fr'],
    });
    assert.deepEqual(partialFixedPayload.translations, {
      en: 'crispy pancake',
      zh: '越南煎饼',
    });

    // 6. Sửa term KEEP có sẵn zh/fr/de -> vẫn giữ đủ mọi ngôn ngữ đích cho KEEP
    const existingKeep = glossaryTermFromJson({
      sourceTerm: 'Thu Bồn Riverside',
      sourceLang: 'vi',
      type: 'KEEP',
      translations: {
        en: 'Thu Bồn Riverside',
        ko: 'Thu Bồn Riverside',
        ja: 'Thu Bồn Riverside',
        zh: 'Thu Bồn Riverside',
        fr: 'Thu Bồn Riverside',
        de: 'Thu Bồn Riverside',
      },
      sinceVersion: 2,
    });
    const keepTargets = getEditableGlossaryTargetLangs(existingKeep.sourceLang, existingKeep.translations);
    const keepPayload = buildUpsertGlossaryInput({
      sourceTerm: existingKeep.sourceTerm,
      sourceLang: existingKeep.sourceLang,
      type: 'KEEP',
      formTranslations: initGlossaryFormTranslations(existingKeep),
      targetLangs: keepTargets,
    });
    assert.deepEqual(keepPayload.targetLangs, ['en', 'ko', 'ja', 'zh', 'fr', 'de']);
    assert.equal(keepPayload.translations.zh, 'Thu Bồn Riverside');
    assert.equal(keepPayload.translations.fr, 'Thu Bồn Riverside');
    assert.equal(keepPayload.translations.de, 'Thu Bồn Riverside');
  });
});
