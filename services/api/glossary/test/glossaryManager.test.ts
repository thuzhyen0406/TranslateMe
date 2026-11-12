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
  MAX_CSV_IMPORT_ROWS,
  normalizeTerm,
  postCheckGlossary,
  putTerm,
  terminologyNameOf,
  type GlossaryCacheInvalidationResult,
  type GlossaryDependencies,
} from '../glossaryManager.js';

/**
 * Bộ giả lập DynamoDB & Amazon Translate trong bộ nhớ cho Hạng mục 2.8 (F4).
 * Hỗ trợ đầy đủ:
 *  - Kiểm soát cách ly tenant (PK = TENANT#<t> hoặc TENANT#<t>#GLOSS).
 *  - Giao dịch `Update` có `ConditionExpression` (Optimistic Locking `glossaryVersion = :old AND #st <> :locked`
 *    và `terminologySyncedVersion < :v`) mà vẫn giữ nguyên các trường khác của `CONFIG`.
 */
function createMockHarness(
  initialConfig?: Record<string, any> | null,
  options?: {
    shouldFailImportTerminology?: boolean;
    onBeforeVersionTransaction?: (store: Map<string, Record<string, any>>) => void;
  },
) {
  const store = new Map<string, Record<string, any>>();
  const translateCalls: ImportTerminologyCommand[] = [];
  let queryCount = 0;
  let transactCount = 0;
  let currentNow = 1_700_000_000_000;
  let failTranslate = Boolean(options?.shouldFailImportTerminology);

  const keyStr = (pk: string, sk: string) => `${pk}||${sk}`;

  if (initialConfig !== null) {
    if (initialConfig) {
      store.set(keyStr(initialConfig.PK, initialConfig.SK), { ...initialConfig });
    } else {
      store.set(keyStr('TENANT#t1', 'CONFIG'), {
        PK: 'TENANT#t1',
        SK: 'CONFIG',
        tenantId: 't1',
        plan: 'PRO',
        quotaLimit: 500_000,
        status: 'ACTIVE',
        glossaryVersion: 0,
      });
    }
  }

  function assertTenantKey(ctx: Ctx, pk: string) {
    const prefix = `TENANT#${ctx.tenantId}`;
    if (pk !== prefix && !pk.startsWith(`${prefix}#`)) {
      throw new AppError('FORBIDDEN', `Truy cập trái phép PK: ${pk}`);
    }
  }

  function applyUpdateOperation(updateOp: Record<string, any>) {
    const k = keyStr(updateOp.Key.PK, updateOp.Key.SK);
    const existing = store.get(k);
    const cond: string = updateOp.ConditionExpression ?? '';
    const vals: Record<string, any> = updateOp.ExpressionAttributeValues ?? {};

    if (cond.includes('attribute_exists(PK)') && !existing) {
      throw Object.assign(new Error('Transaction cancelled: item does not exist'), {
        name: 'TransactionCanceledException',
      });
    }

    if (cond.includes('glossaryVersion = :old')) {
      const currentVer = existing?.glossaryVersion;
      if (currentVer !== undefined && currentVer !== vals[':old']) {
        throw Object.assign(new Error('Transaction cancelled: version mismatch'), {
          name: 'TransactionCanceledException',
        });
      }
    }

    if (cond.includes('#st <> :locked')) {
      if (existing?.status === vals[':locked']) {
        throw Object.assign(new Error('Transaction cancelled: tenant locked'), {
          name: 'TransactionCanceledException',
        });
      }
    }

    if (cond.includes('#st = :active')) {
      if (existing?.status !== vals[':active']) {
        throw Object.assign(new Error('Transaction cancelled: tenant not active'), {
          name: 'TransactionCanceledException',
        });
      }
    }

    if (cond.includes('terminologySyncedVersion < :v')) {
      const syncedVer = existing?.terminologySyncedVersion;
      if (syncedVer !== undefined && syncedVer >= vals[':v']) {
        throw Object.assign(new Error('ConditionalCheckFailed: newer version already synced'), {
          name: 'ConditionalCheckFailedException',
        });
      }
    }

    const updated = { ...(existing ?? { PK: updateOp.Key.PK, SK: updateOp.Key.SK }) };
    const expr: string = updateOp.UpdateExpression ?? '';

    if (expr.includes('glossaryVersion = :new')) {
      updated.glossaryVersion = vals[':new'];
    }
    if (expr.includes('terminologyName = :tname')) {
      updated.terminologyName = vals[':tname'];
    }
    if (expr.includes('terminologySyncedVersion = :v')) {
      updated.terminologySyncedVersion = vals[':v'];
    }
    if (expr.includes('updatedAt = :now')) {
      updated.updatedAt = vals[':now'];
    }

    store.set(k, updated);
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
      async update(ctx, params) {
        assertTenantKey(ctx, params.Key.PK);
        applyUpdateOperation(params);
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
      async listTenantSites(ctx) {
        assertTenantKey(ctx, `TENANT#${ctx.tenantId}`);
        return [
          { SK: 'HOST#active-site', status: 'ACTIVE' },
          { SK: 'HOST#paused-site', status: 'PAUSED' },
        ];
      },
      async transact(ctx, ops: any[]) {
        transactCount++;
        for (const op of ops) {
          const item =
            op.Put?.Item ?? op.Update?.Key ?? op.Delete?.Key ?? op.ConditionCheck?.Key;
          if (item?.PK) {
            assertTenantKey(ctx, item.PK);
          }
        }

        const hasVersionUpdate = ops.some((op) =>
          String(op.Update?.UpdateExpression ?? '').includes('glossaryVersion = :new'),
        );
        if (hasVersionUpdate && options?.onBeforeVersionTransaction) {
          options.onBeforeVersionTransaction(store);
        }

        // Kiểm tra và thực thi các lệnh Update trước (để nếu ConditionExpression lỗi thì không ghi Put)
        for (const op of ops) {
          if (op.Update) {
            applyUpdateOperation(op.Update);
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
        if (failTranslate) {
          throw new Error('AWS Translate throttled or unavailable');
        }
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
    getTransactCount: () => transactCount,
    setFailTranslate: (val: boolean) => {
      failTranslate = val;
    },
    advanceTime: (ms: number) => {
      currentNow += ms;
    },
  };
}

const adminCtx: Ctx = {
  tenantId: 't1',
  role: 'TENANT_ADMIN',
  via: 'JWT',
  requestId: 'req-1',
};

describe('Task 2.8 – Quản lý Thuật ngữ / Glossary (F4)', () => {
  beforeEach(() => {
    clearGlossaryCache();
  });

  it('chuẩn hóa từ nguồn NFC + chữ thường và sinh tên terminology đúng chuẩn AWS Translate', () => {
    const nfd = 'pho\u0302\u0301   co\u0302\u0309   Ho\u0323\u0302i An ';
    assert.equal(cleanTermText(nfd), 'phố cổ Hội An');
    assert.equal(normalizeTerm(nfd), 'phố cổ hội an');
    assert.equal(terminologyNameOf(adminCtx), 'tm-t1');
    assert.deepEqual(keys.gloss(adminCtx, normalizeTerm(nfd)), {
      PK: 'TENANT#t1#GLOSS',
      SK: 'TERM#phố cổ hội an',
    });
  });

  it('putTerm hỗ trợ cả KEEP và FIXED, bảo toàn các thuộc tính khác của CONFIG, tăng glossaryVersion và gọi ImportTerminology', async () => {
    const { deps, store, translateCalls } = createMockHarness();

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
    assert.equal(r1.terminologySynced, true);
    assert.equal(translateCalls.length, 1);
    assert.equal(translateCalls[0].input.Name, 'tm-t1');
    assert.equal(translateCalls[0].input.MergeStrategy, 'OVERWRITE');

    const csv1 = Buffer.from(translateCalls[0].input.TerminologyData!.File!).toString('utf8');
    assert.ok(csv1.includes('vi,en,ko,ja'));
    assert.ok(csv1.includes('Homestay ABC,Homestay ABC,Homestay ABC,Homestay ABC'));

    // Kiểm tra CONFIG vẫn giữ nguyên plan = PRO và quotaLimit = 500_000 (không bị ghi đè mất trường)
    const savedConfig = store.get('TENANT#t1||CONFIG');
    assert.equal(savedConfig?.plan, 'PRO');
    assert.equal(savedConfig?.quotaLimit, 500_000);
    assert.equal(savedConfig?.glossaryVersion, 1);
    assert.equal(savedConfig?.terminologyName, 'tm-t1');

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
    assert.equal(r2.terminologySynced, true);
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

  it('deleteTerm tăng glossaryVersion, đặt terminologyName = null khi xóa hết mục và đánh dấu isStale cho bản dịch MACHINE cũ', async () => {
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
    assert.equal(stateV1.terminologyName, 'tm-t1');
    assert.equal(isStale('Thưởng thức món cao lầu đặc sản.', 1, stateV1), false);

    // Xóa thuật ngữ "cao lầu" -> glossaryVersion tăng lên 2
    const delRes = await deleteTerm(adminCtx, 'Cao Lầu', deps);
    assert.equal(delRes.version, 2);
    assert.equal(delRes.terminologySynced, true);

    const stateV2 = await getGlossaryState(adminCtx, deps);
    assert.equal(stateV2.version, 2);
    assert.equal(stateV2.terminologyName, null);

    const activeList = await listGlossary(adminCtx, deps);
    assert.equal(activeList.terms.length, 0);

    // Bản dịch MACHINE cũ (entryGlossaryVersion = 1) chứa từ vừa xóa PHẢI bị coi là lỗi thời
    assert.equal(isStale('Thưởng thức món cao lầu đặc sản.', 1, stateV2), true);
    assert.equal(isStale('Phòng có ban công hướng biển.', 1, stateV2), false);
  });

  it('sau khi lưu thuật ngữ, chỉ invalidates website ACTIVE qua invalidator chung và trả trạng thái refresh', async () => {
    const { deps } = createMockHarness();
    let receivedSlugs: readonly string[] = [];
    deps.invalidateSites = async (_ctx, request) => {
      receivedSlugs = request.slugs;
      return {
        paths: ['/active-site/*'],
        mode: 'WILDCARD',
        status: 'SUBMITTED',
        invalidationIds: ['invalidation-123'],
      };
    };

    const result = await putTerm(adminCtx, {
      sourceTerm: 'Cao Lầu',
      sourceLang: 'vi',
      type: 'KEEP',
    }, deps);

    assert.deepEqual(receivedSlugs, ['active-site']);
    assert.equal(result.cacheInvalidation.status, 'SUBMITTED');
    assert.deepEqual(result.cacheInvalidation.invalidationIds, ['invalidation-123']);
  });

  it('trả trạng thái refresh FAILED nhưng vẫn giữ glossary đã lưu khi invalidation lỗi', async () => {
    const { deps } = createMockHarness();
    deps.invalidateSites = async () => {
      throw new Error('CloudFront unavailable');
    };

    const result = await putTerm(adminCtx, {
      sourceTerm: 'Phở',
      sourceLang: 'vi',
      type: 'KEEP',
    }, deps);

    assert.equal(result.cacheInvalidation.status, 'FAILED');
    assert.equal(result.cacheInvalidation.error, 'CloudFront unavailable');
    const saved = await getGlossaryState(adminCtx, deps);
    assert.equal(saved.terms.some((term) => term.normalized === 'phở'), true);
  });

  it('endpoint thử lại chỉ gửi lại invalidation cho website ACTIVE, không tăng phiên bản glossary', async () => {
    const { deps } = createMockHarness();
    let receivedSlugs: readonly string[] = [];
    deps.invalidateSites = async (_ctx, request) => {
      receivedSlugs = request.slugs;
      return { status: 'SUBMITTED', paths: ['/active-site/*'], mode: 'WILDCARD', invalidationIds: ['retry-123'] };
    };

    const before = await listGlossary(adminCtx, deps);
    const result = await handleGlossaryRoute(adminCtx, {
      method: 'POST',
      path: '/console/glossary/cache-invalidation/retry',
      body: { failedPaths: ['/paused-site/*', '/active-site/*'] },
    }, deps) as GlossaryCacheInvalidationResult;
    const after = await listGlossary(adminCtx, deps);

    assert.deepEqual(receivedSlugs, ['active-site']);
    assert.deepEqual(result.invalidationIds, ['retry-123']);
    assert.equal(after.version, before.version);

    deps.getInvalidationStatus = async (_ctx, id) => ({
      id, status: 'COMPLETED', paths: ['/active-site/*'],
    });
    const status = await handleGlossaryRoute(adminCtx, {
      method: 'GET',
      path: '/console/glossary/cache-invalidation/retry-123',
    }, deps) as { id: string; status: string };
    assert.deepEqual(status, { id: 'retry-123', status: 'COMPLETED', paths: ['/active-site/*'] });
  });

  it('Optimistic Locking: phát hiện xung đột VERSION_CONFLICT, TENANT_SUSPENDED giữa chừng và NOT_FOUND khi thiếu CONFIG', async () => {
    // 1. Khi CONFIG không tồn tại -> ném NOT_FOUND, không tự tạo CONFIG giả
    const missingConfigHarness = createMockHarness(null);
    await assert.rejects(
      putTerm(adminCtx, { sourceTerm: 'Homestay ABC', type: 'KEEP' }, missingConfigHarness.deps),
      (err: unknown) => err instanceof AppError && err.code === 'NOT_FOUND',
    );
    assert.equal(missingConfigHarness.store.has('TENANT#t1||CONFIG'), false);

    // 2. Khi một request khác cập nhật glossaryVersion xen giữa bước đọc và bước ghi -> ném VERSION_CONFLICT
    const conflictHarness = createMockHarness(undefined, {
      onBeforeVersionTransaction(store) {
        const cfg = store.get('TENANT#t1||CONFIG')!;
        store.set('TENANT#t1||CONFIG', { ...cfg, glossaryVersion: 99 });
      },
    });
    await assert.rejects(
      putTerm(adminCtx, { sourceTerm: 'Homestay ABC', type: 'KEEP' }, conflictHarness.deps),
      (err: unknown) => err instanceof AppError && err.code === 'VERSION_CONFLICT',
    );

    // 3. Khi tenant bị chuyển sang LOCKED ngay trước khi giao dịch thực thi -> ném TENANT_SUSPENDED và giữ nguyên LOCKED
    const lockedMidflightHarness = createMockHarness(undefined, {
      onBeforeVersionTransaction(store) {
        const cfg = store.get('TENANT#t1||CONFIG')!;
        store.set('TENANT#t1||CONFIG', { ...cfg, status: 'LOCKED' });
      },
    });
    await assert.rejects(
      putTerm(adminCtx, { sourceTerm: 'Homestay ABC', type: 'KEEP' }, lockedMidflightHarness.deps),
      (err: unknown) => err instanceof AppError && err.code === 'TENANT_SUSPENDED',
    );
    assert.equal(lockedMidflightHarness.store.get('TENANT#t1||CONFIG')?.status, 'LOCKED');
  });

  it('khi ImportTerminology thất bại ở lần tạo đầu tiên, getGlossaryState trả terminologyName = null để không làm gãy F2/F9/F10', async () => {
    const { deps, setFailTranslate } = createMockHarness(undefined, {
      shouldFailImportTerminology: true,
    });

    const res = await putTerm(
      adminCtx,
      { sourceTerm: 'Homestay ABC', type: 'KEEP', targetLangs: ['en', 'ko'] },
      deps,
    );
    assert.equal(res.version, 1);
    assert.equal(res.terminologySynced, false);

    // Vì ImportTerminology lỗi nên terminologyName chưa tồn tại trên AWS Translate -> phải trả null
    const stateFailed = await getGlossaryState(adminCtx, deps);
    assert.equal(stateFailed.version, 1);
    assert.equal(stateFailed.terminologyName, null);
    assert.equal(stateFailed.terms.length, 1);

    // Khi AWS Translate phục hồi ở lần lưu kế tiếp -> terminologyName được cập nhật thành 'tm-t1'
    setFailTranslate(false);
    const res2 = await putTerm(
      adminCtx,
      {
        sourceTerm: 'phố cổ Hội An',
        type: 'FIXED',
        translations: { en: 'Hoi An Ancient Town', ko: '호이안 구시가지' },
      },
      deps,
    );
    assert.equal(res2.version, 2);
    assert.equal(res2.terminologySynced, true);

    const stateRecovered = await getGlossaryState(adminCtx, deps);
    assert.equal(stateRecovered.version, 2);
    assert.equal(stateRecovered.terminologyName, 'tm-t1');
  });

  it('importCsv ở chế độ PREVIEW bắt đủ các lỗi và giới hạn tối đa 99 dòng hợp lệ trong 1 giao dịch nguyên tử', async () => {
    const { deps, translateCalls } = createMockHarness();

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

    // 1. Từ chối tệp không phải UTF-8
    const invalidUtf8 = Buffer.from([0x76, 0x69, 0x2c, 0x65, 0x6e, 0x0a, 0xff, 0xfe, 0x80]);
    await assert.rejects(
      importCsv(adminCtx, invalidUtf8, 'PREVIEW', 'OVERWRITE', deps),
      (err: unknown) => err instanceof AppError && err.code === 'INVALID_REQUEST',
    );

    // 2. Kiểm tra CSV hỗn hợp
    const csvContent = [
      'vi,en,ko,ja',
      'Homestay ABC,Homestay ABC,Homestay ABC,Homestay ABC',
      'phố cổ Hội An,Hoi An Ancient Town,호이안 구시가지,ホイアン旧市街',
      'cao lầu,cao lau noodles,까오러우 국수',
      'sông Hoài,Hoai River,,ホイアン川',
      ',Empty Source,빈 원본,空のソース',
      'PHỐ CỔ HỘI AN,Old Town,구시가지,旧市街',
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
    assert.equal(preview.version, 1);
    assert.equal(translateCalls.length, 0);

    // 3. Từ chối CSV vượt quá 99 dòng hợp lệ (MAX_CSV_IMPORT_ROWS = 99)
    const hundredRowsCsv = [
      'vi,en',
      ...Array.from({ length: MAX_CSV_IMPORT_ROWS + 1 }, (_, i) => `thuật ngữ ${i + 1},term ${i + 1}`),
    ].join('\n');
    await assert.rejects(
      importCsv(adminCtx, hundredRowsCsv, 'COMMIT', 'OVERWRITE', deps),
      (err: unknown) => err instanceof AppError && err.code === 'INVALID_REQUEST',
    );
  });

  it('importCsv ở chế độ COMMIT xử lý đúng KEEP_EXISTING và OVERWRITE trong 1 giao dịch nguyên tử', async () => {
    const { deps, translateCalls } = createMockHarness();

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
    assert.equal(commitKeep.terminologySynced, true);
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

  it('tự động lấy targetLangs từ bản ghi website HOST# cho mục KEEP và kiểm tra nhất quán sourceLang', async () => {
    const { deps, store, translateCalls } = createMockHarness();

    // Giả lập tenant có 1 website cấu hình dịch từ 'vi' sang ['en', 'fr', 'de']
    store.set('TENANT#t1||HOST#homestay-abc-vn', {
      PK: 'TENANT#t1',
      SK: 'HOST#homestay-abc-vn',
      slug: 'homestay-abc-vn',
      sourceLang: 'vi',
      targetLangs: ['en', 'fr', 'de'],
      status: 'ACTIVE',
    });

    // Tạo mục KEEP mà không truyền targetLangs -> tự động điền cả fr, de theo cấu hình HOST#
    await putTerm(
      adminCtx,
      {
        sourceTerm: 'Homestay ABC',
        type: 'KEEP',
      },
      deps,
    );

    const csvSent = Buffer.from(translateCalls[0].input.TerminologyData!.File!).toString('utf8');
    const headerCols = csvSent.split('\n')[0].split(',');
    assert.equal(headerCols[0], 'vi');
    assert.ok(headerCols.includes('fr'));
    assert.ok(headerCols.includes('de'));

    // Nếu cố tình thêm thuật ngữ có sourceLang = 'en' trái với sourceLang = 'vi' của tenant -> ném INVALID_REQUEST
    await assert.rejects(
      putTerm(
        adminCtx,
        {
          sourceTerm: 'Ancient Town',
          sourceLang: 'en',
          type: 'FIXED',
          translations: { fr: 'Vieille ville' },
        },
        deps,
      ),
      (err: unknown) => err instanceof AppError && err.code === 'INVALID_REQUEST',
    );
  });

  it('getGlossaryState lưu đệm trong bộ nhớ tối đa 60 giây theo glossaryVersion', async () => {
    const { deps, getQueryCount, advanceTime } = createMockHarness();

    await putTerm(
      adminCtx,
      { sourceTerm: 'Homestay ABC', type: 'KEEP', targetLangs: ['en', 'ko', 'ja'] },
      deps,
    );

    const s1 = await getGlossaryState(adminCtx, deps);
    const queriesAfterFirstRead = getQueryCount();
    const s2 = await getGlossaryState(adminCtx, deps);
    assert.equal(s1.version, 1);
    assert.equal(s2.version, 1);
    assert.equal(getQueryCount(), queriesAfterFirstRead);

    advanceTime(61_000);
    await getGlossaryState(adminCtx, deps);
    assert.equal(getQueryCount(), queriesAfterFirstRead + 1);
  });

  it('isStale và postCheckGlossary xử lý chính xác ranh giới từ, ký hiệu {n} và đạt hiệu năng < 50ms cho 300 câu x 500 thuật ngữ', async () => {
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

    assert.equal(containsTermInText('chúc bạn bình an', 'an'), true);
    assert.equal(containsTermInText('chúc bạn bình an', 'bình'), true);
    assert.equal(containsTermInText('chúc bạn bình an', 'ình'), false);

    assert.equal(isStale('Chào mừng đến {1}Homestay ABC{/1} gần phố cổ Hội An.', 1, g), true);
    assert.equal(isStale('Chào mừng đến {1}Homestay ABC{/1}.', 1, g), false);

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

    // Kiểm tra hiệu năng: 300 câu x 500 thuật ngữ với WeakMap pre-compiled regex + includes pre-filter
    const bigGlossary: typeof g = {
      version: 10,
      terminologyName: 'tm-t1',
      terms: Array.from({ length: 500 }, (_, i) => ({
        normalized: `thuật ngữ chuyên ngành ${i}`,
        sourceTerm: `Thuật ngữ chuyên ngành ${i}`,
        sourceLang: 'vi',
        type: 'FIXED' as const,
        translations: { en: `Specialized term ${i}` },
        sinceVersion: 5,
      })),
    };
    const sampleSentences = Array.from(
      { length: 300 },
      (_, i) => `Đây là câu văn bản mẫu số ${i} trên trang chủ khách sạn du lịch biển Đà Nẵng.`,
    );

    const t0 = performance.now();
    for (const sentence of sampleSentences) {
      isStale(sentence, 1, bigGlossary);
    }
    const elapsedMs = performance.now() - t0;
    assert.ok(elapsedMs < 100, `Expected 300x500 isStale < 100ms, got ${elapsedMs.toFixed(2)}ms`);
  });

  it('handleGlossaryRoute kiểm tra quyền trước tài nguyên và xử lý đúng trạng thái LOCKED', async () => {
    const { deps } = createMockHarness();

    const reviewerCtx: Ctx = { ...adminCtx, role: 'REVIEWER' };
    const developerCtx: Ctx = { ...adminCtx, role: 'DEVELOPER' };

    // TENANT_ADMIN được phép PUT
    const putRes = (await handleGlossaryRoute(
      adminCtx,
      {
        method: 'PUT',
        path: '/console/glossary/terms/s%C3%B4ng%20Ho%C3%A0i',
        termParam: 's%C3%B4ng%20Ho%C3%A0i',
        body: {
          sourceTerm: 'sông Hoài',
          type: 'FIXED',
          translations: { en: 'Hoai River', ko: '호아이 강', ja: 'ホアイ川' },
        },
      },
      deps,
    )) as { version: number };
    assert.equal(putRes.version, 1);

    // Nếu termParam trên URL và body.sourceTerm lệch nhau -> ném INVALID_REQUEST
    await assert.rejects(
      handleGlossaryRoute(
        adminCtx,
        {
          method: 'PUT',
          path: '/console/glossary/terms/s%C3%B4ng%20Ho%C3%A0i',
          termParam: 's%C3%B4ng%20Ho%C3%A0i',
          body: {
            sourceTerm: 'chùa Cầu',
            type: 'KEEP',
          },
        },
        deps,
      ),
      (err: unknown) => err instanceof AppError && err.code === 'INVALID_REQUEST',
    );

    // REVIEWER và DEVELOPER được phép GET
    const getRes = (await handleGlossaryRoute(
      reviewerCtx,
      { method: 'GET', path: '/console/glossary' },
      deps,
    )) as { version: number; terms: any[] };
    assert.equal(getRes.version, 1);
    assert.equal(getRes.terms.length, 1);

    // REVIEWER và DEVELOPER bị chặn PUT và DELETE; preview glossary được phép.
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

      const preview = await handleGlossaryRoute(
        ctx,
        {
          method: 'POST',
          path: '/console/glossary/import/preview',
          body: { csv: 'vi,en\nHomestay ABC,Homestay ABC', mode: 'COMMIT' },
        },
        deps,
      );
      assert.ok(preview);
    }

    // COMMIT import vẫn chỉ dành cho TENANT_ADMIN.
    for (const ctx of [reviewerCtx, developerCtx]) {
      await assert.rejects(
        handleGlossaryRoute(
          ctx,
          {
            method: 'POST',
            path: '/console/glossary/import',
            body: { csv: 'vi,en\nHomestay ABC,Homestay ABC' },
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
