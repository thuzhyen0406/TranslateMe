import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { createInvalidator, createMemoryCdn } from '../../../../libs/common/invalidation.js';
import { createSEG, segPath, type SegDb, type SegItem } from '../../../../libs/common/seg.js';
import { tmKey } from '../../../../libs/common/tm.js';
import { AppError, keys, type Ctx } from '../../../../libs/common/types.js';
import {
  acceptTranslation,
  checkInvalidationStatus,
  configureDefaultCloudFrontCdn,
  createReviewDependencies,
  createReviewLambdaHandler,
  extractReviewCtxFromEvent,
  getTranslation,
  handleReviewApiGatewayRoute,
  handleReviewRoute,
  listTranslations,
  restoreMachineTranslation,
  retryInvalidation,
  saveAndPublishTranslation,
  type ReviewDependencies,
} from '../reviewManager.js';

const TENANT_A = 't_review_tenant_a';
const TENANT_B = 't_review_tenant_b';

const reviewerCtx: Ctx = {
  tenantId: TENANT_A,
  via: 'JWT',
  requestId: 'req-rev-1',
  role: 'REVIEWER',
  sub: 'u_reviewer_01',
};

const adminCtx: Ctx = {
  tenantId: TENANT_A,
  via: 'JWT',
  requestId: 'req-adm-1',
  role: 'TENANT_ADMIN',
  sub: 'u_admin_01',
};

const devCtx: Ctx = {
  tenantId: TENANT_A,
  via: 'JWT',
  requestId: 'req-dev-1',
  role: 'DEVELOPER',
  sub: 'u_dev_01',
};

const hashOf = (text: string): string => createHash('sha256').update(text.normalize('NFC'), 'utf8').digest('hex');

/**
 * Bộ giả lập DynamoDB + SEG + CloudFront CDN trong bộ nhớ cho Hạng mục 3.8 (F5).
 */
function createReviewHarness(options?: {
  tenantStatus?: 'ACTIVE' | 'LOCKED';
  glossaryVersion?: number;
}) {
  const store = new Map<string, Record<string, any>>();
  const segStore = new Map<string, SegItem>();
  const keyStr = (pk: string, sk: string) => `${pk}||${sk}`;
  let currentNow = 1_730_000_000_000;

  // Khởi tạo CONFIG và các bản ghi MEMBER mặc định cho TENANT_A
  store.set(keyStr(`TENANT#${TENANT_A}`, 'CONFIG'), {
    PK: `TENANT#${TENANT_A}`,
    SK: 'CONFIG',
    tenantId: TENANT_A,
    status: options?.tenantStatus ?? 'ACTIVE',
    glossaryVersion: options?.glossaryVersion ?? 4,
  });

  store.set(keyStr(`TENANT#${TENANT_A}`, 'MEMBER#u_reviewer_01'), {
    PK: `TENANT#${TENANT_A}`,
    SK: 'MEMBER#u_reviewer_01',
    sub: 'u_reviewer_01',
    role: 'REVIEWER',
    status: 'ACTIVE',
  });

  store.set(keyStr(`TENANT#${TENANT_A}`, 'MEMBER#u_admin_01'), {
    PK: `TENANT#${TENANT_A}`,
    SK: 'MEMBER#u_admin_01',
    sub: 'u_admin_01',
    role: 'TENANT_ADMIN',
    status: 'ACTIVE',
  });

  function assertTenantAccess(ctx: Ctx, pk: string) {
    const allowed = `TENANT#${ctx.tenantId}`;
    if (pk !== allowed && !pk.startsWith(`${allowed}#`)) {
      throw new AppError('FORBIDDEN', `Truy cập trái phép PK: ${pk}`);
    }
  }

  const segDb: SegDb = {
    async batchWrite(ctx, items) {
      for (const it of items) {
        assertTenantAccess(ctx, it.PK);
        segStore.set(keyStr(it.PK, it.SK), { ...it });
      }
    },
    async query(ctx, pk, skPrefix) {
      assertTenantAccess(ctx, pk);
      return [...segStore.values()]
        .filter((i) => i.PK === pk && i.SK.startsWith(skPrefix))
        .map((i) => ({ ...i } as unknown as Record<string, unknown>));
    },
    async queryGsi2(ctx, gsi2pk) {
      assertTenantAccess(ctx, gsi2pk);
      return [...segStore.values()]
        .filter((i) => i.GSI2PK === gsi2pk)
        .map((i) => ({ ...i } as unknown as Record<string, unknown>));
    },
  };

  const seg = createSEG({ db: segDb });
  const cdn = createMemoryCdn();
  const invalidator = createInvalidator({ seg, cdn });
  const invalidateCalls: Array<{ ctx: Ctx; src: string; tgt: string; hashes: readonly string[] }> = [];

  const deps: ReviewDependencies = {
    now: () => currentNow,
    db: {
      async get(ctx, key) {
        assertTenantAccess(ctx, key.PK);
        const item = store.get(keyStr(key.PK, key.SK));
        return item ? { ...item } : null;
      },
      async query(ctx, pk, skPrefix) {
        assertTenantAccess(ctx, pk);
        return [...store.values()]
          .filter((item) => item.PK === pk && (!skPrefix || String(item.SK).startsWith(skPrefix)))
          .map((item) => ({ ...item }));
      },
      async queryGsi3(ctx, gsi3pk) {
        assertTenantAccess(ctx, gsi3pk);
        return [...store.values()]
          .filter((item) => item.GSI3PK === gsi3pk)
          .map((item) => ({ ...item }));
      },
      async update(ctx, params) {
        assertTenantAccess(ctx, params.Key.PK);
        const k = keyStr(params.Key.PK, params.Key.SK);
        const existing = store.get(k);
        const cond = params.ConditionExpression ?? '';
        const vals = params.ExpressionAttributeValues ?? {};
        const names = params.ExpressionAttributeNames ?? {};

        if (cond.includes('attribute_exists(PK)') && !existing) {
          throw Object.assign(new Error('ConditionalCheckFailed: item not found'), {
            name: 'ConditionalCheckFailedException',
          });
        }
        if (cond.includes('#version = :expectedVersion')) {
          const curVer = Number(existing?.version ?? 0);
          if (curVer !== vals[':expectedVersion']) {
            throw Object.assign(new Error('ConditionalCheckFailed: version mismatch'), {
              name: 'ConditionalCheckFailedException',
            });
          }
        }

        const updated: Record<string, any> = { ...(existing ?? { ...params.Key }) };
        const [setPart, addPart] = params.UpdateExpression.split(' ADD ');
        for (const assign of setPart.replace(/^SET\s+/, '').split(',')) {
          const [lhs, rhs] = assign.trim().split(/\s*=\s*/);
          const prop = names[lhs] ?? lhs;
          updated[prop] = vals[rhs];
        }
        if (addPart) {
          for (const addExpr of addPart.split(',')) {
            const [lhs, rhs] = addExpr.trim().split(/\s+/);
            const prop = names[lhs] ?? lhs;
            updated[prop] = Number(updated[prop] ?? 0) + Number(vals[rhs] ?? 0);
          }
        }

        store.set(k, updated);
      },
    },
    async invalidateForSentences(ctx, req) {
      invalidateCalls.push({ ctx, src: req.src, tgt: req.tgt, hashes: [...req.hashes] });
      return invalidator.invalidateForSentences(ctx, req);
    },
    async getInvalidationStatus(ctx, id) {
      return invalidator.getInvalidationStatus(ctx, id);
    },
  };

  function seedTmEntry(entry: {
    srcLang?: string;
    tgtLang?: string;
    sourceText: string;
    tgt: string;
    machineTgt?: string;
    label?: 'MACHINE' | 'HUMAN';
    needsReview?: boolean;
    glossaryVersion?: number;
    version?: number;
    updatedAt?: string;
    updatedBy?: string;
  }) {
    const srcLang = entry.srcLang ?? 'vi';
    const tgtLang = entry.tgtLang ?? 'en';
    const hash = hashOf(entry.sourceText);
    const key = tmKey(reviewerCtx, srcLang, tgtLang, hash);
    const label = entry.label ?? 'MACHINE';
    const needsReview = entry.needsReview ?? false;
    const updatedAt = entry.updatedAt ?? '2026-10-28T10:00:00.000Z';
    const item = {
      PK: key.PK,
      SK: key.SK,
      hash,
      src: entry.sourceText,
      tgt: entry.tgt,
      machineTgt: entry.machineTgt ?? (label === 'MACHINE' ? entry.tgt : undefined),
      label,
      needsReview,
      glossaryVersion: entry.glossaryVersion ?? 2,
      version: entry.version ?? 1,
      updatedAt,
      updatedBy: entry.updatedBy ?? 'proxy',
      GSI3PK: `TENANT#${TENANT_A}#TM#${needsReview ? 'REVIEW' : label}`,
      GSI3SK: updatedAt,
    };
    store.set(keyStr(key.PK, key.SK), item);
    return { hash, key, item };
  }

  return {
    deps,
    store,
    seg,
    cdn,
    invalidateCalls,
    seedTmEntry,
    advanceTime: (ms: number) => {
      currentNow += ms;
    },
  };
}

describe('Task 3.8 – Duyệt bản dịch (F5)', () => {
  it('listTranslations lọc đúng theo 3 tab (REVIEW, MACHINE, HUMAN), cặp ngôn ngữ và từ khóa', async () => {
    const { deps, seedTmEntry } = createReviewHarness();

    seedTmEntry({
      sourceText: 'Chào mừng đến {1}Homestay ABC{/1}.',
      tgt: 'Welcome to {1}Homestay ABC{/1}.',
      label: 'MACHINE',
      needsReview: false,
      updatedAt: '2026-10-28T08:00:00.000Z',
    });
    seedTmEntry({
      sourceText: 'Xem {1}bảng giá{/1} gần phố cổ Hội An.',
      tgt: 'See {1}prices{/1} near old town.',
      label: 'MACHINE',
      needsReview: true,
      updatedAt: '2026-10-28T09:00:00.000Z',
    });
    seedTmEntry({
      sourceText: 'Liên hệ lễ tân 24/7.',
      tgt: 'Contact 24/7 reception.',
      label: 'HUMAN',
      needsReview: false,
      updatedAt: '2026-10-28T10:00:00.000Z',
    });

    const reviewList = await listTranslations(reviewerCtx, { tab: 'REVIEW', src: 'vi', tgt: 'en' }, deps);
    assert.equal(reviewList.total, 1);
    assert.equal(reviewList.items[0].sourceText, 'Xem {1}bảng giá{/1} gần phố cổ Hội An.');
    assert.equal(reviewList.items[0].needsReview, true);

    const machineList = await listTranslations(reviewerCtx, { tab: 'MACHINE', src: 'vi', tgt: 'en' }, deps);
    assert.equal(machineList.total, 1);
    assert.equal(machineList.items[0].label, 'MACHINE');
    assert.equal(machineList.items[0].needsReview, false);

    const humanList = await listTranslations(reviewerCtx, { tab: 'HUMAN', src: 'vi', tgt: 'en' }, deps);
    assert.equal(humanList.total, 1);
    assert.equal(humanList.items[0].label, 'HUMAN');

    const searched = await listTranslations(
      reviewerCtx,
      { tab: 'REVIEW', search: 'Phố Cổ Hội An'.normalize('NFD') },
      deps,
    );
    assert.equal(searched.total, 1);
  });

  it('acceptTranslation chuyển bản MACHINE / Cần xem lại sang HUMAN, xóa cờ needsReview và tăng version', async () => {
    const { deps, seedTmEntry, invalidateCalls } = createReviewHarness({ glossaryVersion: 6 });
    const seeded = seedTmEntry({
      sourceText: 'Xem {1}bảng giá{/1} tại quầy.',
      tgt: 'See {1}price list{/1} at the desk.',
      label: 'MACHINE',
      needsReview: true,
      version: 2,
    });

    const res = await acceptTranslation(
      reviewerCtx,
      {
        src: 'vi',
        tgt: 'en',
        hash: seeded.hash,
        expectedVersion: 2,
      },
      deps,
    );

    assert.equal(res.entry.label, 'HUMAN');
    assert.equal(res.entry.needsReview, false);
    assert.equal(res.entry.version, 3);
    assert.equal(res.entry.glossaryVersion, 6);
    assert.equal(res.entry.machineTgt, 'See {1}price list{/1} at the desk.');
    assert.equal(res.entry.updatedBy, 'u_reviewer_01');
    assert.equal(res.entry.GSI3PK, `TENANT#${TENANT_A}#TM#HUMAN`);
    assert.equal(res.invalidation.status, 'NOTHING_TO_DO');
    assert.equal(invalidateCalls.length, 0, 'mặc định ACCEPT giữ nguyên tgt nên không cần gọi xóa cache');
  });

  it('saveAndPublishTranslation kiểm tra thiếu/thừa {n} -> trả 400 PLACEHOLDER_MISMATCH chi tiết', async () => {
    const { deps, seedTmEntry, invalidateCalls } = createReviewHarness();
    const seeded = seedTmEntry({
      sourceText: 'Phòng có {1}ban công{/1} nhìn ra {2}sông Hoài{/2}.',
      tgt: 'Room with {1}balcony{/1} overlooking {2}Hoai River{/2}.',
      label: 'MACHINE',
      version: 1,
    });

    // 1. Thiếu {2}...{/2}
    await assert.rejects(
      saveAndPublishTranslation(
        reviewerCtx,
        {
          src: 'vi',
          tgt: 'en',
          hash: seeded.hash,
          newTgt: 'Room with {1}balcony{/1} overlooking Hoai River.',
          expectedVersion: 1,
        },
        deps,
      ),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'PLACEHOLDER_MISMATCH');
        assert.deepEqual(err.details?.missing, ['{2}', '{/2}']);
        return true;
      },
    );

    // 2. Thừa {3}...{/3}
    await assert.rejects(
      saveAndPublishTranslation(
        reviewerCtx,
        {
          src: 'vi',
          tgt: 'en',
          hash: seeded.hash,
          newTgt: 'Room with {1}balcony{/1} overlooking {2}Hoai River{/2} {3}now{/3}.',
          expectedVersion: 1,
        },
        deps,
      ),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'PLACEHOLDER_MISMATCH');
        assert.deepEqual(err.details?.extra, ['{3}', '{/3}']);
        return true;
      },
    );

    // 3. Đóng/mở lệch cấu trúc ({1} ... {2} ... {/1} ... {/2})
    await assert.rejects(
      saveAndPublishTranslation(
        reviewerCtx,
        {
          src: 'vi',
          tgt: 'en',
          hash: seeded.hash,
          newTgt: 'Room {1}with {2}balcony{/1} river{/2}.',
          expectedVersion: 1,
        },
        deps,
      ),
      (err: unknown) => err instanceof AppError && err.code === 'PLACEHOLDER_MISMATCH',
    );

    assert.equal(invalidateCalls.length, 0, 'lỗi PLACEHOLDER_MISMATCH không được ghi hay gọi xóa cache');
  });

  it('saveAndPublishTranslation cho phép đảo thứ tự {2} trước {1}, lưu HUMAN và gọi xóa cache chọn lọc (3.5)', async () => {
    const { deps, seg, seedTmEntry, invalidateCalls } = createReviewHarness({ glossaryVersion: 5 });
    const seeded = seedTmEntry({
      sourceText: 'Xem {1}bảng giá{/1} tại {2}trang chủ{/2}.',
      tgt: 'See {1}price list{/1} at {2}home page{/2}.',
      label: 'MACHINE',
      needsReview: true,
      version: 1,
    });

    // Ghi chỉ mục SEG: câu này xuất hiện trên 2 trang của website homestay-abc
    await seg.writePageSegments(reviewerCtx, 'en', segPath('homestay-abc', ''), [seeded.hash]);
    await seg.writePageSegments(reviewerCtx, 'en', segPath('homestay-abc', 'phong-nghi/deluxe'), [seeded.hash]);

    // Bản dịch đảo {2} lên trước {1} vẫn hoàn toàn hợp lệ
    const res = await saveAndPublishTranslation(
      reviewerCtx,
      {
        src: 'vi',
        tgt: 'en',
        hash: seeded.hash,
        newTgt: 'At {2}the home page{/2}, see {1}our official rates{/1}.',
        expectedVersion: 1,
      },
      deps,
    );

    assert.equal(res.entry.label, 'HUMAN');
    assert.equal(res.entry.needsReview, false);
    assert.equal(res.entry.version, 2);
    assert.equal(res.entry.tgt, 'At {2}the home page{/2}, see {1}our official rates{/1}.');
    assert.equal(res.entry.machineTgt, 'See {1}price list{/1} at {2}home page{/2}.');
    assert.equal(res.entry.GSI3PK, `TENANT#${TENANT_A}#TM#HUMAN`);

    // Kiểm tra kết quả xóa cache chọn lọc từ hạng mục 3.5
    assert.equal(invalidateCalls.length, 1);
    assert.deepEqual(invalidateCalls[0], {
      ctx: reviewerCtx,
      src: 'vi',
      tgt: 'en',
      hashes: [seeded.hash],
    });
    assert.equal(res.invalidation.status, 'SUBMITTED');
    assert.equal(res.invalidation.mode, 'PATHS');
    assert.equal(res.invalidation.invalidationId, 'I000000000001');
    assert.deepEqual(res.invalidation.paths, [
      '/homestay-abc/en/',
      '/homestay-abc/en/phong-nghi/deluxe',
    ]);

    // Kiểm tra trạng thái xóa cache qua checkInvalidationStatus (lần 1 IN_PROGRESS, lần 2 COMPLETED)
    const st1 = await checkInvalidationStatus(reviewerCtx, 'I000000000001', deps);
    assert.equal(st1.status, 'IN_PROGRESS');
    const st2 = await checkInvalidationStatus(reviewerCtx, 'I000000000001', deps);
    assert.equal(st2.status, 'COMPLETED');
  });

  it('restoreMachineTranslation khôi phục bản dịch máy gốc (machineTgt), đặt label = MACHINE và xóa cache', async () => {
    const { deps, seg, seedTmEntry, invalidateCalls } = createReviewHarness();
    const seeded = seedTmEntry({
      sourceText: 'Chào mừng quý khách.',
      tgt: 'Warmest welcome to our guests.',
      machineTgt: 'Welcome guests.',
      label: 'HUMAN',
      needsReview: false,
      version: 3,
    });

    await seg.writePageSegments(reviewerCtx, 'en', segPath('homestay-abc', 'gioi-thieu'), [seeded.hash]);

    const res = await restoreMachineTranslation(
      reviewerCtx,
      {
        src: 'vi',
        tgt: 'en',
        hash: seeded.hash,
        expectedVersion: 3,
      },
      deps,
    );

    assert.equal(res.entry.label, 'MACHINE');
    assert.equal(res.entry.tgt, 'Welcome guests.');
    assert.equal(res.entry.version, 4);
    assert.equal(res.entry.GSI3PK, `TENANT#${TENANT_A}#TM#MACHINE`);
    assert.equal(invalidateCalls.length, 1);
    assert.deepEqual(res.invalidation.paths, ['/homestay-abc/en/gioi-thieu']);
  });

  it('khóa lạc quan: trả 409 VERSION_CONFLICT kèm bản mới nhất của câu khi 2 Reviewer lưu trùng lúc', async () => {
    const { deps, seedTmEntry } = createReviewHarness();
    const seeded = seedTmEntry({
      sourceText: 'Đặt phòng ngay hôm nay.',
      tgt: 'Book a room today.',
      label: 'MACHINE',
      version: 1,
    });

    // Reviewer 1 (adminCtx) lưu thành công lên version 2
    await saveAndPublishTranslation(
      adminCtx,
      {
        src: 'vi',
        tgt: 'en',
        hash: seeded.hash,
        newTgt: 'Reserve your room today!',
        expectedVersion: 1,
      },
      deps,
    );

    // Reviewer 2 (reviewerCtx) vẫn gửi expectedVersion = 1 -> nhận 409 VERSION_CONFLICT kèm bản mới nhất
    await assert.rejects(
      saveAndPublishTranslation(
        reviewerCtx,
        {
          src: 'vi',
          tgt: 'en',
          hash: seeded.hash,
          newTgt: 'Book your stay right now.',
          expectedVersion: 1,
        },
        deps,
      ),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'VERSION_CONFLICT');
        assert.equal(err.details?.expectedVersion, 1);
        assert.equal(err.details?.actualVersion, 2);
        const latest = err.details?.latest as Record<string, any>;
        assert.ok(latest);
        assert.equal(latest.version, 2);
        assert.equal(latest.tgt, 'Reserve your room today!');
        assert.equal(latest.updatedBy, 'u_admin_01');
        return true;
      },
    );
  });

  it('kiểm tra quyền vai trò, bảng MEMBER và trạng thái tenant LOCKED', async () => {
    const { deps, store, seedTmEntry } = createReviewHarness();
    const seeded = seedTmEntry({
      sourceText: 'Xin chào.',
      tgt: 'Hello.',
      label: 'MACHINE',
      version: 1,
    });

    // 1. DEVELOPER bị từ chối truy cập F5 với PERMISSION_DENIED (theo đúng hợp đồng QC-2 / Bảng 1.2)
    await assert.rejects(
      listTranslations(devCtx, {}, deps),
      (err: unknown) => err instanceof AppError && err.code === 'PERMISSION_DENIED',
    );
    await assert.rejects(
      acceptTranslation(devCtx, { src: 'vi', tgt: 'en', hash: seeded.hash, expectedVersion: 1 }, deps),
      (err: unknown) => err instanceof AppError && err.code === 'PERMISSION_DENIED',
    );

    // 2. Thiếu hoặc rỗng ctx.sub -> bị từ chối ngay với UNAUTHORIZED (không bỏ qua kiểm tra MEMBER)
    const missingSubCtx: Ctx = { tenantId: TENANT_A, via: 'JWT', requestId: 'req-no-sub', role: 'REVIEWER' };
    await assert.rejects(
      listTranslations(missingSubCtx, {}, deps),
      (err: unknown) => err instanceof AppError && err.code === 'UNAUTHORIZED',
    );
    const emptySubCtx: Ctx = { ...reviewerCtx, sub: '   ' };
    await assert.rejects(
      acceptTranslation(emptySubCtx, { src: 'vi', tgt: 'en', hash: seeded.hash, expectedVersion: 1 }, deps),
      (err: unknown) => err instanceof AppError && err.code === 'UNAUTHORIZED',
    );

    // 3. Thành viên không còn ACTIVE trong bảng MEMBER -> bị từ chối với PERMISSION_DENIED
    const removedReviewerCtx: Ctx = { ...reviewerCtx, sub: 'u_removed_reviewer' };
    store.set(`TENANT#${TENANT_A}||MEMBER#u_removed_reviewer`, {
      PK: `TENANT#${TENANT_A}`,
      SK: 'MEMBER#u_removed_reviewer',
      sub: 'u_removed_reviewer',
      role: 'REVIEWER',
      status: 'REMOVED',
    });
    await assert.rejects(
      listTranslations(removedReviewerCtx, {}, deps),
      (err: unknown) => err instanceof AppError && err.code === 'PERMISSION_DENIED',
    );

    // 3. Tenant bị khóa (LOCKED) -> cho phép đọc danh sách (tenantLocked = true) nhưng chặn mọi thao tác ghi (TENANT_SUSPENDED)
    store.set(`TENANT#${TENANT_A}||CONFIG`, {
      PK: `TENANT#${TENANT_A}`,
      SK: 'CONFIG',
      tenantId: TENANT_A,
      status: 'LOCKED',
      glossaryVersion: 4,
    });

    const readWhenLocked = await listTranslations(reviewerCtx, { tab: 'MACHINE' }, deps);
    assert.equal(readWhenLocked.tenantLocked, true);
    assert.equal(readWhenLocked.total, 1);

    await assert.rejects(
      saveAndPublishTranslation(
        reviewerCtx,
        { src: 'vi', tgt: 'en', hash: seeded.hash, newTgt: 'Hi there.', expectedVersion: 1 },
        deps,
      ),
      (err: unknown) => err instanceof AppError && err.code === 'TENANT_SUSPENDED',
    );
  });

  it('khi CloudFront lỗi tạm thời: bản sửa vẫn được lưu (QC-8) và retryInvalidation tính lại đường dẫn từ SEG để thử lại', async () => {
    const { deps, seg, cdn, seedTmEntry } = createReviewHarness();
    const seeded = seedTmEntry({
      sourceText: 'Thực đơn bữa sáng.',
      tgt: 'Breakfast menu.',
      label: 'MACHINE',
      version: 1,
    });

    await seg.writePageSegments(reviewerCtx, 'en', segPath('homestay-abc', 'am-thuc'), [seeded.hash]);

    // Giả lập CloudFront lỗi ở lần gọi đầu tiên
    cdn.failWith = 'TooManyInvalidationsInProgress';
    const saved = await saveAndPublishTranslation(
      reviewerCtx,
      {
        src: 'vi',
        tgt: 'en',
        hash: seeded.hash,
        newTgt: 'Daily breakfast menu.',
        expectedVersion: 1,
      },
      deps,
    );

    // Bản dịch trong TM đã được lưu thành công dù xóa cache lỗi
    assert.equal(saved.entry.label, 'HUMAN');
    assert.equal(saved.entry.tgt, 'Daily breakfast menu.');
    assert.equal(saved.invalidation.status, 'FAILED');

    const storedAfter = await getTranslation(reviewerCtx, { src: 'vi', tgt: 'en', hash: seeded.hash }, deps);
    assert.equal(storedAfter.tgt, 'Daily breakfast menu.');
    assert.equal(storedAfter.version, 2);

    // Khôi phục CDN và bấm nút "Thử lại" qua handleReviewRoute POST /console/invalidations/retry
    cdn.failWith = undefined;
    const retried = (await handleReviewRoute(
      reviewerCtx,
      {
        method: 'POST',
        path: '/console/invalidations/retry',
        body: {
          src: 'vi',
          tgt: 'en',
          hashes: [seeded.hash],
        },
      },
      deps,
    )) as Awaited<ReturnType<typeof retryInvalidation>>;

    assert.equal(retried.status, 'SUBMITTED');
    assert.deepEqual(retried.paths, ['/homestay-abc/en/am-thuc']);
    assert.ok(retried.invalidationId);

    // Tenant khác không được phép tra cứu invalidationId của TENANT_A
    const otherTenantCtx: Ctx = {
      tenantId: TENANT_B,
      via: 'JWT',
      requestId: 'req-other',
      role: 'TENANT_ADMIN',
      sub: 'u_other_admin',
    };
    storeTenantBConfig(deps);
    await assert.rejects(
      checkInvalidationStatus(otherTenantCtx, retried.invalidationId!, deps),
      (err: unknown) => err instanceof AppError && err.code === 'NOT_FOUND',
    );

    function storeTenantBConfig(d: ReviewDependencies) {
      const origGet = d.db.get.bind(d.db);
      d.db.get = async (c, k, o) => {
        if (c.tenantId === TENANT_B && k.SK === 'CONFIG') {
          return { PK: keys.config(c).PK, SK: 'CONFIG', status: 'ACTIVE', glossaryVersion: 1 };
        }
        if (c.tenantId === TENANT_B && k.SK === 'MEMBER#u_other_admin') {
          return {
            PK: keys.member(c, 'u_other_admin').PK,
            SK: 'MEMBER#u_other_admin',
            sub: 'u_other_admin',
            role: 'TENANT_ADMIN',
            status: 'ACTIVE',
          };
        }
        return origGet(c, k, o);
      };
    }
  });

  it('invalidation mặc định yêu cầu CloudFront thật (không dùng memory CDN ngầm) và hỗ trợ cấu hình CdnClient', async () => {
    const { deps, seedTmEntry } = createReviewHarness();
    const seeded = seedTmEntry({
      sourceText: 'Xe đưa đón sân bay.',
      tgt: 'Airport shuttle.',
      label: 'MACHINE',
      version: 1,
    });

    const prevDistId = process.env.CLOUDFRONT_DISTRIBUTION_ID;
    delete process.env.CLOUDFRONT_DISTRIBUTION_ID;
    configureDefaultCloudFrontCdn(null);

    try {
      const prodDepsWithoutDist = createReviewDependencies({ db: deps.db, env: {} });
      await assert.rejects(
        checkInvalidationStatus(reviewerCtx, 'I000000000001', prodDepsWithoutDist),
        (err: unknown) => (err as { name?: string })?.name === 'MissingCloudFrontDistributionId',
      );
    } finally {
      if (prevDistId !== undefined) process.env.CLOUDFRONT_DISTRIBUTION_ID = prevDistId;
      configureDefaultCloudFrontCdn(null);
    }
    assert.ok(seeded.hash);
  });

  it('handleReviewApiGatewayRoute và createReviewLambdaHandler nối các route /console/translations* và /console/invalidations* với API Gateway', async () => {
    const { deps, seg, seedTmEntry } = createReviewHarness();
    const seeded = seedTmEntry({
      sourceText: 'Bữa sáng tự chọn.',
      tgt: 'Buffet breakfast.',
      label: 'MACHINE',
      needsReview: true,
      version: 1,
    });
    await seg.writePageSegments(reviewerCtx, 'en', segPath('homestay-abc', 'bua-sang'), [seeded.hash]);

    // 1. Đường dẫn không thuộc F5 trả về null để router chung chuyển tiếp
    const unrelated = await handleReviewApiGatewayRoute(
      { httpMethod: 'GET', path: '/console/glossary/terms' },
      reviewerCtx,
      deps,
    );
    assert.equal(unrelated, null);

    // 2. Lambda handler trích xuất Ctx từ Cognito Authorizer claims và xử lý GET / PUT / GET invalidation
    const lambdaHandler = createReviewLambdaHandler(deps);

    const unauthRes = await lambdaHandler({
      httpMethod: 'GET',
      path: '/console/translations',
      requestContext: { requestId: 'req-unauth', authorizer: { claims: {} } },
    });
    assert.equal(unauthRes.statusCode, 401);

    const devForbiddenRes = await lambdaHandler({
      httpMethod: 'GET',
      path: '/console/translations',
      requestContext: {
        requestId: 'req-gw-dev',
        authorizer: {
          claims: {
            'custom:tenant_id': TENANT_A,
            'custom:role': 'DEVELOPER',
            sub: 'u_dev_01',
          },
        },
      },
    });
    assert.equal(devForbiddenRes.statusCode, 403);
    assert.equal(JSON.parse(devForbiddenRes.body).error?.code, 'PERMISSION_DENIED');

    const listRes = await lambdaHandler({
      httpMethod: 'GET',
      path: '/prod/console/translations',
      queryStringParameters: { tab: 'REVIEW', src: 'vi', tgt: 'en' },
      requestContext: {
        requestId: 'req-gw-list',
        authorizer: {
          claims: {
            'custom:tenant_id': TENANT_A,
            'custom:role': 'REVIEWER',
            sub: 'u_reviewer_01',
          },
        },
      },
    });
    assert.equal(listRes.statusCode, 200);
    const listBody = JSON.parse(listRes.body);
    assert.equal(listBody.request_id, 'req-gw-list');
    assert.equal(listBody.total, 1);

    const publishRes = await lambdaHandler({
      httpMethod: 'PUT',
      path: '/console/translations',
      body: JSON.stringify({
        src: 'vi',
        tgt: 'en',
        hash: seeded.hash,
        newTgt: 'Daily buffet breakfast.',
        expectedVersion: 1,
      }),
      requestContext: {
        requestId: 'req-gw-put',
        authorizer: {
          claims: {
            'custom:tenant_id': TENANT_A,
            'custom:role': 'REVIEWER',
            sub: 'u_reviewer_01',
          },
        },
      },
    });
    assert.equal(publishRes.statusCode, 200);
    const publishBody = JSON.parse(publishRes.body);
    assert.equal(publishBody.entry.label, 'HUMAN');
    assert.equal(publishBody.invalidation.status, 'SUBMITTED');

    // Xung đột phiên bản trả về HTTP 409 kèm details.latest
    const conflictRes = await lambdaHandler({
      httpMethod: 'PUT',
      path: '/console/translations',
      body: JSON.stringify({
        src: 'vi',
        tgt: 'en',
        hash: seeded.hash,
        newTgt: 'Stale edit.',
        expectedVersion: 1,
      }),
      requestContext: {
        requestId: 'req-gw-409',
        authorizer: {
          claims: {
            'custom:tenant_id': TENANT_A,
            'custom:role': 'REVIEWER',
            sub: 'u_reviewer_01',
          },
        },
      },
    });
    assert.equal(conflictRes.statusCode, 409);
    const conflictBody = JSON.parse(conflictRes.body);
    assert.equal(conflictBody.error.code, 'VERSION_CONFLICT');
    assert.equal(conflictBody.error.details.latest.version, 2);

    // Kiểm tra extractReviewCtxFromEvent
    const extracted = extractReviewCtxFromEvent({
      requestContext: {
        requestId: 'req-ctx',
        authorizer: {
          jwt: {
            claims: {
              'custom:tenant_id': TENANT_A,
              'custom:role': 'TENANT_ADMIN',
              sub: 'u_admin_01',
            },
          },
        },
      },
    });
    assert.equal(extracted.tenantId, TENANT_A);
    assert.equal(extracted.role, 'TENANT_ADMIN');
    assert.equal(extracted.sub, 'u_admin_01');
  });

  it('extractReviewCtxFromEvent chấp nhận claim custom:role chữ thường do Cognito tạo (tenant_admin, reviewer, developer)', () => {
    const make = (role: string) =>
      extractReviewCtxFromEvent({
        requestContext: {
          requestId: 'req-role',
          authorizer: { claims: { 'custom:tenant_id': TENANT_A, 'custom:role': role, sub: 'u_01' } },
        },
      });
    assert.equal(make('tenant_admin').role, 'TENANT_ADMIN');
    assert.equal(make('reviewer').role, 'REVIEWER');
    assert.equal(make('developer').role, 'DEVELOPER');
    assert.equal(make('Reviewer').role, 'REVIEWER');
    assert.equal(make('REVIEWER').role, 'REVIEWER');
    assert.throws(() => make('superuser'), (err: unknown) => (err as { code?: string }).code === 'UNAUTHORIZED');
    assert.throws(() => make(''), (err: unknown) => (err as { code?: string }).code === 'UNAUTHORIZED');
  });

  it('extractReviewCtxFromEvent chỉ chấp nhận claims.sub thật từ Cognito, từ chối khi chỉ có cognito:username', () => {
    // Có cognito:username nhưng thiếu sub -> bắt buộc từ chối UNAUTHORIZED
    assert.throws(
      () =>
        extractReviewCtxFromEvent({
          requestContext: {
            requestId: 'req-username-no-sub',
            authorizer: {
              claims: {
                'custom:tenant_id': TENANT_A,
                'custom:role': 'reviewer',
                'cognito:username': 'reviewer_john',
              },
            },
          },
        }),
      (err: unknown) => err instanceof AppError && err.code === 'UNAUTHORIZED',
    );

    // Có sub hợp lệ -> trích xuất đúng
    const parsed = extractReviewCtxFromEvent({
      requestContext: {
        requestId: 'req-sub-ok',
        authorizer: {
          claims: {
            'custom:tenant_id': TENANT_A,
            'custom:role': 'reviewer',
            sub: 'sub-uuid-abc-123',
            'cognito:username': 'reviewer_john',
          },
        },
      },
    });
    assert.equal(parsed.sub, 'sub-uuid-abc-123');
    assert.equal(parsed.tenantId, TENANT_A);
    assert.equal(parsed.role, 'REVIEWER');
  });

  it('tương thích tuyệt đối với chữ ký tối thiểu đã chốt: invalidateForSentences(ctx, { src, tgt, hashes }): Promise<{ paths, mode, invalidationId? }>', async () => {
    const { deps, seedTmEntry } = createReviewHarness();
    const seeded = seedTmEntry({
      sourceText: 'Hồ bơi ngoài trời.',
      tgt: 'Outdoor pool.',
      label: 'MACHINE',
      version: 1,
    });

    // Truyền hàm đúng chữ ký tối thiểu không có các trường mở rộng (status, invalidationIds, failedPaths)
    const minimalDeps: ReviewDependencies = {
      ...deps,
      invalidateForSentences: async (_ctx, { src, tgt, hashes }): Promise<{ paths: string[]; mode: 'PATHS' | 'WILDCARD'; invalidationId?: string }> => ({
        paths: [`/homestay-abc/${tgt}/*`],
        mode: 'WILDCARD',
        invalidationId: `inv-${src}-${hashes[0].slice(0, 6)}`,
      }),
    };

    const res = await saveAndPublishTranslation(
      reviewerCtx,
      {
        src: 'vi',
        tgt: 'en',
        hash: seeded.hash,
        newTgt: 'Outdoor swimming pool.',
        expectedVersion: 1,
      },
      minimalDeps,
    );

    assert.deepEqual(res.invalidation.paths, ['/homestay-abc/en/*']);
    assert.equal(res.invalidation.mode, 'WILDCARD');
    assert.equal(res.invalidation.invalidationId, `inv-vi-${seeded.hash.slice(0, 6)}`);
    assert.equal(res.invalidation.status, 'SUBMITTED');
  });

  it('defaultReviewDb.queryGsi3 và defaultSeg được bọc qua tenant document router với quyền STS theo tenant', async () => {
    // 1. Kiểm tra defaultDocClient và defaultReviewDb
    const { defaultDocClient, defaultReviewDb, createReviewDependencies } = await import('../reviewManager.js');
    assert.ok(defaultDocClient, 'defaultDocClient phải tồn tại');
    assert.ok(typeof defaultReviewDb.queryGsi3 === 'function', 'defaultReviewDb phải có queryGsi3');

    // 2. Chặn truy cập GSI3PK khi ctx tenant không khớp
    await assert.rejects(
      () => defaultReviewDb.queryGsi3!(reviewerCtx, 'TENANT#t_other#TM#REVIEW'),
      (err: unknown) => (err as { code?: string })?.code === 'FORBIDDEN',
    );

    // 3. createReviewDependencies hỗ trợ docClient tùy biến cho SEG
    const capturedCommands: unknown[] = [];
    const customDocClient = {
      send: async (cmd: unknown) => {
        capturedCommands.push(cmd);
        return { Items: [] };
      },
    };
    const depsWithCustomDoc = createReviewDependencies({ docClient: customDocClient as any });
    assert.ok(depsWithCustomDoc.invalidateForSentences, 'Phải tạo invalidator với custom docClient');
  });

  it('infra/modules/iam.yaml cấp quyền cloudfront:GetInvalidation cho ConsoleApiExecutionRole (sửa blocker 2)', () => {
    const candidates = [path.resolve('infra/modules/iam.yaml'), path.resolve('../../infra/modules/iam.yaml')]; const found = candidates.find((p) => fs.existsSync(p)) || ''; const iamYaml = fs.readFileSync(found, 'utf8');
    const consoleApiRoleSection = iamYaml.slice(iamYaml.indexOf('ConsoleApiExecutionRole:'));
    const nextRoleIndex = consoleApiRoleSection.indexOf('TranslateApiExecutionRole:');
    const consoleSnippet = consoleApiRoleSection.slice(0, nextRoleIndex);

    assert.ok(
      consoleSnippet.includes('cloudfront:GetInvalidation'),
      'ConsoleApiExecutionRole phải có quyền cloudfront:GetInvalidation',
    );
    assert.ok(
      consoleSnippet.includes('cloudfront:CreateInvalidation'),
      'ConsoleApiExecutionRole phải có quyền cloudfront:CreateInvalidation',
    );
  });

  it('listTranslations phân trang trên GSI3 theo thứ tự GSI3SK giảm dần với Limit và con trỏ cursor / nextCursor', async () => {
    const { deps, seedTmEntry } = createReviewHarness();

    seedTmEntry({
      sourceText: 'Câu 1 cũ nhất.',
      tgt: 'Sentence 1 oldest.',
      label: 'MACHINE',
      needsReview: true,
      updatedAt: '2026-10-28T08:00:00.000Z',
    });
    seedTmEntry({
      sourceText: 'Câu 2 giữa.',
      tgt: 'Sentence 2 middle.',
      label: 'MACHINE',
      needsReview: true,
      updatedAt: '2026-10-28T09:00:00.000Z',
    });
    seedTmEntry({
      sourceText: 'Câu 3 mới nhất.',
      tgt: 'Sentence 3 newest.',
      label: 'MACHINE',
      needsReview: true,
      updatedAt: '2026-10-28T10:00:00.000Z',
    });

    // Trang 1 (limit = 2): trả 2 câu mới nhất kèm nextCursor
    const page1 = await listTranslations(reviewerCtx, { tab: 'REVIEW', limit: 2 }, deps);
    assert.equal(page1.items.length, 2);
    assert.equal(page1.items[0].sourceText, 'Câu 3 mới nhất.');
    assert.equal(page1.items[1].sourceText, 'Câu 2 giữa.');
    assert.ok(page1.nextCursor, 'Phải trả nextCursor khi còn bản ghi tiếp theo');

    // Trang 2 (dùng cursor từ trang 1): trả câu còn lại và không còn nextCursor
    const page2 = await listTranslations(
      reviewerCtx,
      { tab: 'REVIEW', limit: 2, cursor: page1.nextCursor },
      deps,
    );
    assert.equal(page2.items.length, 1);
    assert.equal(page2.items[0].sourceText, 'Câu 1 cũ nhất.');
    assert.equal(page2.nextCursor, undefined);

    // Con trỏ giả mạo hoặc khác tenant/tab bị từ chối với INVALID_REQUEST
    await assert.rejects(
      listTranslations(reviewerCtx, { tab: 'HUMAN', cursor: page1.nextCursor }, deps),
      (err: unknown) => err instanceof AppError && err.code === 'INVALID_REQUEST',
    );
  });
});
