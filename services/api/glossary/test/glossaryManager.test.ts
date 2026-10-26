import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { ImportTerminologyCommand } from '@aws-sdk/client-translate';
import { AppError, keys, type Ctx } from '../../../../libs/common/types.js';
import {
  buildTenantTerminologyCsv,
  cleanTermText,
  clearGlossaryCache,
  containsTermInText,
  decodeUtf8Csv,
  deleteTerm,
  getGlossaryState,
  handleGlossaryRoute,
  importCsv,
  isStale,
  listGlossary,
  normalizeTerm,
  postCheckGlossary,
  putTerm,
  terminologyNameOf,
  type GlossaryDependencies,
} from '../glossaryManager.js';

/**
 * Bộ giả lập DynamoDB & Amazon Translate trong bộ nhớ cho Hạng mục 2.8 (F4).
 * Kiểm tra cả kiểm soát cách ly tenant (PK = TENANT#<t> hoặc TENANT#<t>#GLOSS).
 */
function createMockHarness(initialConfig?: Record<string, any>) {
  const store = new Map<string, Record<string, any>>();
  const translateCalls: ImportTerminologyCommand[] = [];
  let queryCount = 0;
  let currentNow = 1_700_000_000_000;

  const keyStr = (pk: string, sk: string) => `${pk}||${sk}`;

  if (initialConfig) {
    store.set(keyStr(initialConfig.PK, initialConfig.SK), { ...initialConfig });
  } else {
    store.set(keyStr('TENANT#t1', 'CONFIG'), {
      PK: 'TENANT#t1',
      SK: 'CONFIG',
      tenantId: 't1',
      plan: 'FREE',
      status: 'ACTIVE',
      glossaryVersion: 0,
    });
  }

  function assertTenantKey(ctx: Ctx, pk: string) {
    const prefix = `TENANT#${ctx.tenantId}`;
    if (pk !== prefix && !pk.startsWith(`${prefix}#`)) {
      throw new AppError('FORBIDDEN', `Truy cập trái phép PK: ${pk}`);
    }
  }

  const deps: GlossaryDependencies = {
    db: {
      async get(ctx, key) {
        assertTenantKey(ctx, key.PK);
        const item = store.get(keyStr(key.PK, key.SK));
        return item ? { ...item } : null;
      },
      async put(ctx, item) {
        assertTenantKey(ctx, item.PK);
        store.set(keyStr(item.PK, item.SK), { ...item });
      },
      async query(ctx, pk, skPrefix) {
        assertTenantKey(ctx, pk);
        queryCount++;
        const results: Record<string, any>[] = [];
        for (const item of store.values()) {
          if (item.PK === pk && (!skPrefix || String(item.SK).startsWith(skPrefix))) {
            results.push({ ...item });
          }
        }
        return results;
      },
      async transact(ctx, ops: any[]) {
        for (const op of ops) {
          const item = op.Put?.Item ?? op.Update?.Key ?? op.Delete?.Key;
          if (item?.PK) {
            assertTenantKey(ctx, item.PK);
          }
        }
        for (const op of ops) {
          if (op.Put?.Item) {
            const it = op.Put.Item;
            store.set(keyStr(it.PK, it.SK), { ...it });
          }
        }
      },
    },
    translateClient: {
      async send(cmd: ImportTerminologyCommand) {
        translateCalls.push(cmd);
        return {
          TerminologyProperties: {
            Name: cmd.input.Name,
            TermCount: 1,
          },
        };
      },
    },
    now: () => currentNow,
  };

  return {
    deps,
    store,
    translateCalls,
    getQueryCount: () => queryCount,
    advanceTime: (ms: number) => {
      currentNow += ms;
    },
  };
}

const adminCtx: Ctx = {
  tenantId: 't1',
  userId: 'user-admin',
  role: 'TENANT_ADMIN',
  via: 'JWT',
  requestId: 'req-1',
};

describe('Task 2.8 – Quản lý Thuật ngữ / Glossary (F4)', () => {
  beforeEach(() => {
    clearGlossaryCache();
  });

  it('chuẩn hóa từ nguồn NFC + chữ thường và sinh tên terminology đúng chuẩn AWS Translate', () => {
    // Tổ hợp dấu rời (NFD) -> NFC
    const nfd = 'pho\u0302\u0301   co\u0302\u0309   Ho\u0323\u0302i An ';
    assert.equal(cleanTermText(nfd), 'phố cổ Hội An');
    assert.equal(normalizeTerm(nfd), 'phố cổ hội an');
    assert.equal(terminologyNameOf(adminCtx), 'tm-t1');
    assert.deepEqual(keys.gloss(adminCtx, normalizeTerm(nfd)), {
      PK: 'TENANT#t1#GLOSS',
      SK: 'TERM#phố cổ hội an',
    });
  });

  it('putTerm hỗ trợ cả KEEP (tự điền mọi ngôn ngữ đích bằng từ nguồn) và FIXED, tăng glossaryVersion và gọi ImportTerminology', async () => {
    const { deps, translateCalls } = createMockHarness();

    // 1. Thêm mục KEEP ("Homestay ABC")
    const r1 = await putTerm(
      adminCtx,
      {
        sourceTerm: '  Homestay   ABC ',
        sourceLang: 'vi',
        type: 'KEEP',
        targetLangs: ['en', 'ko', 'ja'],
      },
      deps,
    );
    assert.equal(r1.version, 1);
    assert.equal(translateCalls.length, 1);
    assert.equal(translateCalls[0].input.Name, 'tm-t1');
    assert.equal(translateCalls[0].input.MergeStrategy, 'OVERWRITE');

    const csv1 = Buffer.from(translateCalls[0].input.TerminologyData!.File!).toString('utf8');
    assert.ok(csv1.includes('vi,en,ko,ja'));
    assert.ok(csv1.includes('Homestay ABC,Homestay ABC,Homestay ABC,Homestay ABC'));

    // 2. Thêm mục FIXED ("phố cổ Hội An")
    const r2 = await putTerm(
      adminCtx,
      {
        sourceTerm: 'phố cổ Hội An',
        sourceLang: 'vi',
        type: 'FIXED',
        translations: {
          en: 'Hoi An Ancient Town',
          ko: '호이안 구시가지',
          ja: 'ホイアン旧市街',
        },
      },
      deps,
    );
    assert.equal(r2.version, 2);
    assert.equal(translateCalls.length, 2);

    const state = await getGlossaryState(adminCtx, deps);
    assert.equal(state.version, 2);
    assert.equal(state.terminologyName, 'tm-t1');
    assert.equal(state.terms.length, 2);

    const keepItem = state.terms.find((t) => t.normalized === 'homestay abc');
    assert.ok(keepItem);
    assert.equal(keepItem.type, 'KEEP');
    assert.equal(keepItem.sinceVersion, 1);
    assert.deepEqual(keepItem.translations, {
      en: 'Homestay ABC',
      ko: 'Homestay ABC',
      ja: 'Homestay ABC',
    });

    const fixedItem = state.terms.find((t) => t.normalized === 'phố cổ hội an');
    assert.ok(fixedItem);
    assert.equal(fixedItem.type, 'FIXED');
    assert.equal(fixedItem.sinceVersion, 2);
    assert.equal(fixedItem.translations?.en, 'Hoi An Ancient Town');
  });

  it('deleteTerm tăng glossaryVersion, đánh dấu xóa để bản dịch MACHINE cũ bị coi là lỗi thời (isStale = true)', async () => {
    const { deps } = createMockHarness();

    await putTerm(
      adminCtx,
      {
        sourceTerm: 'cao lầu',
        sourceLang: 'vi',
        type: 'FIXED',
        translations: { en: 'cao lau noodles', ko: '까오러우 국수', ja: 'カオラウ' },
      },
      deps,
    );

    const stateV1 = await getGlossaryState(adminCtx, deps);
    assert.equal(stateV1.version, 1);
    // Bản dịch được tạo ở glossaryVersion = 1 thì không lỗi thời ở v1
    assert.equal(isStale('Thưởng thức món cao lầu đặc sản.', 1, stateV1), false);

    // Xóa thuật ngữ "cao lầu" -> glossaryVersion tăng lên 2
    const delRes = await deleteTerm(adminCtx, 'Cao Lầu', deps);
    assert.equal(delRes.version, 2);

    const stateV2 = await getGlossaryState(adminCtx, deps);
    assert.equal(stateV2.version, 2);
    // Khi không còn mục hiệu lực nào, terminologyName trả null để không gọi TranslateText với bảng rỗng
    assert.equal(stateV2.terminologyName, null);

    const activeList = await listGlossary(adminCtx, deps);
    assert.equal(activeList.terms.length, 0);

    // Bản dịch MACHINE cũ (entryGlossaryVersion = 1) có chứa từ "cao lầu" vừa bị xóa ở v2 PHẢI bị coi là lỗi thời!
    assert.equal(isStale('Thưởng thức món cao lầu đặc sản.', 1, stateV2), true);
    // Câu không chứa từ "cao lầu" thì không bị ảnh hưởng
    assert.equal(isStale('Phòng có ban công hướng biển.', 1, stateV2), false);
  });

  it('importCsv ở chế độ PREVIEW bắt đủ các lỗi (không phải UTF-8, thiếu cột, trùng trong tệp, ô trống) và nhận diện trùng với DB', async () => {
    const { deps, translateCalls } = createMockHarness();

    // Tạo sẵn 1 mục trong DB để kiểm tra phát hiện trùng (duplicates)
    await putTerm(
      adminCtx,
      {
        sourceTerm: 'Homestay ABC',
        type: 'KEEP',
        targetLangs: ['en', 'ko', 'ja'],
      },
      deps,
    );
    translateCalls.length = 0;

    // 1. Kiểm tra từ chối tệp không phải UTF-8
    const invalidUtf8 = Buffer.from([0x76, 0x69, 0x2c, 0x65, 0x6e, 0x0a, 0xff, 0xfe, 0x80]);
    await assert.rejects(
      importCsv(adminCtx, invalidUtf8, 'PREVIEW', 'OVERWRITE', deps),
      (err: unknown) => err instanceof AppError && err.code === 'INVALID_REQUEST',
    );

    // 2. Kiểm tra CSV hỗn hợp có cả dòng đúng, dòng thiếu cột, dòng ô trống, dòng trùng trong file
    const csvContent = [
      'vi,en,ko,ja',
      'Homestay ABC,Homestay ABC,Homestay ABC,Homestay ABC', // Dòng 2: Hợp lệ (KEEP), trùng với DB
      'phố cổ Hội An,Hoi An Ancient Town,호이안 구시가지,ホイアン旧市街', // Dòng 3: Hợp lệ (FIXED)
      'cao lầu,cao lau noodles,까오러우 국수', // Dòng 4: Lỗi thiếu cột 'ja'
      'sông Hoài,Hoai River,,ホイアン川', // Dòng 5: Lỗi ô trống ở cột 'ko'
      ',Empty Source,빈 원본,空のソース', // Dòng 6: Lỗi ô từ nguồn trống
      'PHỐ CỔ HỘI AN,Old Town,구시가지,旧市街', // Dòng 7: Lỗi trùng từ nguồn trong cùng tệp CSV
    ].join('\n');

    const preview = await importCsv(adminCtx, csvContent, 'PREVIEW', 'OVERWRITE', deps);
    assert.equal(preview.validRows, 2);
    assert.equal(preview.duplicates.length, 1);
    assert.equal(preview.duplicates[0].term, 'Homestay ABC');
    assert.equal(preview.errors.length, 4);
    assert.deepEqual(
      preview.errors.map((e) => e.row),
      [4, 5, 6, 7],
    );
    assert.match(preview.errors[0].reason, /Thiếu cột 'ja'/);
    assert.match(preview.errors[1].reason, /Ô trống ở cột ngôn ngữ 'ko'/);
    assert.match(preview.errors[2].reason, /Ô từ nguồn/);
    assert.match(preview.errors[3].reason, /Trùng từ nguồn/);

    // Chế độ PREVIEW không được tăng version và không gọi ImportTerminology
    assert.equal(preview.version, 1);
    assert.equal(translateCalls.length, 0);
  });

  it('importCsv ở chế độ COMMIT xử lý đúng KEEP_EXISTING và OVERWRITE, tăng glossaryVersion và đồng bộ Translate', async () => {
    const { deps, translateCalls } = createMockHarness();

    // Tạo sẵn "phố cổ Hội An" với bản dịch cũ
    await putTerm(
      adminCtx,
      {
        sourceTerm: 'phố cổ Hội An',
        type: 'FIXED',
        translations: { en: 'Old Town V1', ko: '구시가지 V1', ja: '旧市街 V1' },
      },
      deps,
    );
    translateCalls.length = 0;

    const csv = [
      'vi,en,ko,ja',
      'Homestay ABC,Homestay ABC,Homestay ABC,Homestay ABC',
      'phố cổ Hội An,Hoi An Ancient Town,호이안 구시가지,ホイアン旧市街',
      'sông Hoài,Hoai River,호아이 강,ホアイ川',
    ].join('\n');

    // 1. COMMIT với KEEP_EXISTING -> chỉ thêm 2 mục mới, giữ nguyên "phố cổ Hội An" cũ
    const commitKeep = await importCsv(adminCtx, csv, 'COMMIT', 'KEEP_EXISTING', deps);
    assert.equal(commitKeep.version, 2);
    assert.equal(commitKeep.addedCount, 2);
    assert.equal(commitKeep.skippedCount, 1);
    assert.equal(commitKeep.overwrittenCount, 0);
    assert.equal(translateCalls.length, 1);

    let list = await listGlossary(adminCtx, deps);
    const hoiAnKeep = list.terms.find((t) => t.normalized === 'phố cổ hội an');
    assert.equal(hoiAnKeep?.translations.en, 'Old Town V1');

    // 2. COMMIT với OVERWRITE -> ghi đè cả 3 mục
    const commitOverwrite = await importCsv(adminCtx, csv, 'COMMIT', 'OVERWRITE', deps);
    assert.equal(commitOverwrite.version, 3);
    assert.equal(commitOverwrite.overwrittenCount, 3);

    list = await listGlossary(adminCtx, deps);
    const hoiAnNew = list.terms.find((t) => t.normalized === 'phố cổ hội an');
    assert.equal(hoiAnNew?.translations.en, 'Hoi An Ancient Town');
    const homestay = list.terms.find((t) => t.normalized === 'homestay abc');
    assert.equal(homestay?.type, 'KEEP');
  });

  it('getGlossaryState lưu đệm trong bộ nhớ tối đa 60 giây theo glossaryVersion', async () => {
    const { deps, getQueryCount, advanceTime } = createMockHarness();

    await putTerm(
      adminCtx,
      { sourceTerm: 'Homestay ABC', type: 'KEEP', targetLangs: ['en', 'ko', 'ja'] },
      deps,
    );
    // Sau putTerm, listGlossary đã nạp cache 1 lần
    const queriesAfterPut = getQueryCount();

    // Gọi lại getGlossaryState trong vòng 60s khi version không đổi -> không query lại bảng GLOSS
    const s1 = await getGlossaryState(adminCtx, deps);
    const s2 = await getGlossaryState(adminCtx, deps);
    assert.equal(s1.version, 1);
    assert.equal(s2.version, 1);
    assert.equal(getQueryCount(), queriesAfterPut);

    // Sau 61 giây -> cache hết hạn -> query lại DynamoDB
    advanceTime(61_000);
    await getGlossaryState(adminCtx, deps);
    assert.equal(getQueryCount(), queriesAfterPut + 1);
  });

  it('isStale và postCheckGlossary xử lý chính xác ranh giới từ tiếng Việt/Latin, chuỗi CJK và ký hiệu {n}', async () => {
    const { deps } = createMockHarness();

    await putTerm(
      adminCtx,
      {
        sourceTerm: 'Homestay ABC',
        type: 'KEEP',
        targetLangs: ['en', 'ko', 'ja'],
      },
      deps,
    );
    await putTerm(
      adminCtx,
      {
        sourceTerm: 'phố cổ Hội An',
        type: 'FIXED',
        translations: {
          en: 'Hoi An Ancient Town',
          ko: '호이안 구시가지',
          ja: 'ホイアン旧市街',
        },
      },
      deps,
    );

    const g = await getGlossaryState(adminCtx, deps);
    assert.equal(g.version, 2);

    // 1. Kiểm tra ranh giới từ: từ "an" không khớp nhầm với "bình an"
    assert.equal(containsTermInText('chúc bạn bình an', 'an'), true);
    assert.equal(containsTermInText('chúc bạn bình an', 'bình'), true);
    assert.equal(containsTermInText('chúc bạn bình an', 'ình'), false);

    // 2. Kiểm tra isStale với câu có chứa {1}...{/1}
    assert.equal(
      isStale('Chào mừng đến {1}Homestay ABC{/1} gần phố cổ Hội An.', 1, g),
      true, // vì "phố cổ Hội An" có sinceVersion = 2 > 1
    );
    assert.equal(
      isStale('Chào mừng đến {1}Homestay ABC{/1}.', 1, g),
      false, // vì "Homestay ABC" có sinceVersion = 1 <= 1
    );

    // 3. Kiểm tra hậu kiểm postCheckGlossary
    const checkEnOk = postCheckGlossary(
      'Homestay ABC nằm gần phố cổ Hội An.',
      'Homestay ABC is located near Hoi An Ancient Town.',
      'en',
      g,
    );
    assert.equal(checkEnOk.passed, true);
    assert.equal(checkEnOk.needsReview, false);

    const checkJaOk = postCheckGlossary(
      'Homestay ABC nằm gần phố cổ Hội An.',
      'Homestay ABCはホイアン旧市街の近くにあります。',
      'ja',
      g,
    );
    assert.equal(checkJaOk.passed, true);

    const checkMissing = postCheckGlossary(
      'Homestay ABC nằm gần phố cổ Hội An.',
      'Homestay ABC is near the old quarter.',
      'en',
      g,
    );
    assert.equal(checkMissing.passed, false);
    assert.equal(checkMissing.needsReview, true);
    assert.deepEqual(checkMissing.missingTerms, ['phố cổ Hội An']);
  });

  it('handleGlossaryRoute kiểm tra chặt quyền theo vai trò (TENANT_ADMIN vs DEVELOPER / REVIEWER) và trạng thái LOCKED', async () => {
    const { deps } = createMockHarness();

    const reviewerCtx: Ctx = { ...adminCtx, role: 'REVIEWER' };
    const developerCtx: Ctx = { ...adminCtx, role: 'DEVELOPER' };

    // TENANT_ADMIN được phép PUT
    const putRes = (await handleGlossaryRoute(
      adminCtx,
      {
        method: 'PUT',
        path: '/console/glossary/terms/sông%20Hoài',
        body: {
          sourceTerm: 'sông Hoài',
          type: 'FIXED',
          translations: { en: 'Hoai River', ko: '호아이 강', ja: 'ホアイ川' },
        },
      },
      deps,
    )) as { version: number };
    assert.equal(putRes.version, 1);

    // REVIEWER và DEVELOPER được phép GET
    const getRes = (await handleGlossaryRoute(
      reviewerCtx,
      { method: 'GET', path: '/console/glossary' },
      deps,
    )) as { version: number; terms: any[] };
    assert.equal(getRes.version, 1);
    assert.equal(getRes.terms.length, 1);

    // REVIEWER và DEVELOPER bị chặn 403 PERMISSION_DENIED khi gọi PUT, DELETE, POST import
    for (const ctx of [reviewerCtx, developerCtx]) {
      await assert.rejects(
        handleGlossaryRoute(
          ctx,
          {
            method: 'PUT',
            path: '/console/glossary/terms/test',
            body: { sourceTerm: 'test', type: 'KEEP' },
          },
          deps,
        ),
        (err: unknown) => err instanceof AppError && err.code === 'PERMISSION_DENIED',
      );

      await assert.rejects(
        handleGlossaryRoute(
          ctx,
          { method: 'DELETE', path: '/console/glossary/terms/sông%20Hoài', termParam: 'sông Hoài' },
          deps,
        ),
        (err: unknown) => err instanceof AppError && err.code === 'PERMISSION_DENIED',
      );

      await assert.rejects(
        handleGlossaryRoute(
          ctx,
          {
            method: 'POST',
            path: '/console/glossary/import',
            body: { csv: 'vi,en\nHomestay ABC,Homestay ABC', mode: 'PREVIEW' },
          },
          deps,
        ),
        (err: unknown) => err instanceof AppError && err.code === 'PERMISSION_DENIED',
      );
    }

    // Khi tenant bị LOCKED -> chặn ghi với mã lỗi TENANT_SUSPENDED
    const lockedHarness = createMockHarness({
      PK: 'TENANT#t1',
      SK: 'CONFIG',
      tenantId: 't1',
      status: 'LOCKED',
      glossaryVersion: 1,
    });
    await assert.rejects(
      putTerm(adminCtx, { sourceTerm: 'Homestay ABC', type: 'KEEP' }, lockedHarness.deps),
      (err: unknown) => err instanceof AppError && err.code === 'TENANT_SUSPENDED',
    );
  });

  it('decodeUtf8Csv và buildTenantTerminologyCsv xử lý đúng dấu phẩy, ngoặc kép và BOM', () => {
    const withBom = '\uFEFFvi,en\n"Áo dài, lụa","Ao dai, silk"';
    const decoded = decodeUtf8Csv(withBom);
    assert.equal(decoded, 'vi,en\n"Áo dài, lụa","Ao dai, silk"');

    const csv = buildTenantTerminologyCsv([
      {
        normalized: 'áo dài, lụa',
        sourceTerm: 'Áo dài, lụa',
        sourceLang: 'vi',
        type: 'FIXED',
        translations: { en: 'Ao dai, "silk"' },
        sinceVersion: 1,
      },
    ]);
    assert.ok(csv);
    assert.ok(csv.includes('"Áo dài, lụa","Ao dai, ""silk"""'));
  });
});
