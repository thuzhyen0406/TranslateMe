import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError, type Ctx } from '../../../../libs/common/types.js';
import type { SafeFetchOutcome } from '../../../../libs/common/safeFetch.js';
import {
  createSite,
  pauseSite,
  resumeSite,
  verifySite,
  type CreateSiteInput,
  type SiteManagerDependencies,
} from '../siteManager.js';

const tenantA: Ctx = { tenantId: 'tenant-a', via: 'JWT', requestId: 'test-a', role: 'TENANT_ADMIN' };
const tenantB: Ctx = { tenantId: 'tenant-b', via: 'JWT', requestId: 'test-b', role: 'TENANT_ADMIN' };

const siteInput: CreateSiteInput = {
  homeUrl: 'https://site.example/',
  displayName: 'Test site',
  sourceLang: 'vi',
  targetLangs: ['en'],
};

function successfulFetch(html: string): SafeFetchOutcome {
  return {
    kind: 'OK',
    html,
    finalUrl: 'https://site.example/',
    status: 200,
    contentType: 'text/html',
    headers: {},
  };
}

function createHarness() {
  const records = new Map<string, Record<string, any>>();
  const transactions: any[][] = [];
  const requestedUrls: string[] = [];
  const invalidations: Array<{ slugs: readonly string[] }> = [];
  let fetchOutcome: SafeFetchOutcome = successfulFetch('');
  const keyOf = (item: { PK: string; SK: string }) => `${item.PK}::${item.SK}`;
  records.set('TENANT#tenant-a::CONFIG', { PK: 'TENANT#tenant-a', SK: 'CONFIG', status: 'ACTIVE' });
  records.set('TENANT#tenant-b::CONFIG', { PK: 'TENANT#tenant-b', SK: 'CONFIG', status: 'ACTIVE' });

  const dependencies: SiteManagerDependencies = {
    async assertTenantWritable() {},
    db: {
      async transact(_ctx, operations) {
        transactions.push(operations);
        const puts = operations.map((operation) => operation.Put).filter(Boolean);
        const hasConflict = puts.some((put) => records.has(keyOf(put.Item)));
        if (hasConflict) {
          throw Object.assign(new Error('Conditional transaction failed'), {
            name: 'TransactionCanceledException',
            CancellationReasons: [
              { Code: 'ConditionalCheckFailed' },
              { Code: 'None' },
              { Code: 'None' },
            ],
          });
        }

        for (const put of puts) records.set(keyOf(put.Item), { ...put.Item });
      },
      async get(_ctx, key) {
        const record = records.get(keyOf(key));
        return record ? { ...record } : null;
      },
      async put(_ctx, item) {
        const record = item as { PK: string; SK: string };
        records.set(keyOf(record), { ...item });
      },
      async updateSiteStatus(ctx, slug, expectedStatus, nextStatus) {
        const key = `TENANT#${ctx.tenantId}::HOST#${slug}`;
        const record = records.get(key);
        if (!record || record.status !== expectedStatus) {
          throw new AppError('VERSION_CONFLICT', 'Trạng thái website đã thay đổi');
        }
        record.status = nextStatus;
        record.updatedAt = new Date().toISOString();
      },
    },
    resolver: async () => [{ address: '93.184.216.34', family: 4 }],
    invalidateSites: async (_ctx, options) => {
      invalidations.push(options);
      return { paths: [`/${options.slugs[0]}/*`], mode: 'WILDCARD' };
    },
    safeFetch: async (url) => {
      requestedUrls.push(url);
      return fetchOutcome;
    },
  };

  return {
    dependencies,
    records,
    transactions,
    requestedUrls,
    invalidations,
    setFetchOutcome(outcome: SafeFetchOutcome) {
      fetchOutcome = outcome;
    },
  };
}

function hostFor(records: Map<string, Record<string, any>>, tenantId: string, slug: string) {
  return records.get(`TENANT#${tenantId}::HOST#${slug}`);
}

describe('siteManager', () => {
  it('kiểm tra role trước khi truy cập hoặc xác thực tài nguyên website', async () => {
    const developerCtx: Ctx = { ...tenantA, role: 'DEVELOPER' };
    await assert.rejects(
      createSite(developerCtx, siteInput),
      (err: unknown) => err instanceof AppError && err.code === 'PERMISSION_DENIED',
    );
  });

  it('tạo site PENDING và ghi HOST + SLUG nguyên tử với điều kiện không trùng', async () => {
    const harness = createHarness();

    const result = await createSite(tenantA, siteInput, harness.dependencies);

    assert.equal(result.slug, 'site-example');
    assert.equal(result.status, 'PENDING');
    assert.match(result.verificationCode, /^translateme-verify-/);
    assert.equal(harness.transactions.length, 1);
    assert.equal(harness.transactions[0].length, 3);
    assert.deepEqual(
      harness.transactions[0].map((operation) => operation.Put?.ConditionExpression).filter(Boolean),
      ['attribute_not_exists(PK)', 'attribute_not_exists(SK)'],
    );
    const tenantStatusCheck = harness.transactions[0][2].ConditionCheck;
    assert.deepEqual(tenantStatusCheck.Key, { PK: 'TENANT#tenant-a', SK: 'CONFIG' });
    assert.equal(tenantStatusCheck.ConditionExpression, 'attribute_exists(PK) AND #status = :active');
    assert.deepEqual(tenantStatusCheck.ExpressionAttributeNames, { '#status': 'status' });
    assert.deepEqual(tenantStatusCheck.ExpressionAttributeValues, { ':active': 'ACTIVE' });
    assert.equal(harness.records.get('TENANT#PLATFORM#SLUG#site-example::META')?.tenantId, 'tenant-a');
    assert.equal(hostFor(harness.records, 'tenant-a', result.slug)?.status, 'PENDING');
  });

  it('từ chối localhost, IP private và metadata trước khi ghi dữ liệu', async () => {
    for (const homeUrl of [
      'http://localhost/',
      'http://127.0.0.1/',
      'http://10.1.2.3/',
      'http://172.16.0.1/',
      'http://192.168.1.1/',
      'http://169.254.169.254/',
    ]) {
      const harness = createHarness();

      await assert.rejects(
        createSite(tenantA, { ...siteInput, homeUrl }, harness.dependencies),
        (error: unknown) => error instanceof AppError && error.code === 'FORBIDDEN',
        homeUrl,
      );
      assert.equal(harness.transactions.length, 0, homeUrl);
      assert.equal(
        [...harness.records.values()].some((record) =>
          record.SK?.startsWith('HOST#') || record.PK?.includes('#SLUG#')
        ),
        false,
        homeUrl,
      );
    }
  });

  it('từ chối tên miền phân giải tới IP private', async () => {
    const harness = createHarness();
    harness.dependencies.resolver = async () => [{ address: '10.0.0.5', family: 4 }];

    await assert.rejects(
      createSite(tenantA, siteInput, harness.dependencies),
      (error: unknown) => error instanceof AppError && error.code === 'FORBIDDEN',
    );
    assert.equal(harness.transactions.length, 0);
  });

  it('xác minh META thành công và chuyển trạng thái PENDING sang ACTIVE', async () => {
    const harness = createHarness();
    const created = await createSite(tenantA, siteInput, harness.dependencies);
    harness.setFetchOutcome(successfulFetch(
      `<meta name="translateme-site-verification" content="${created.verificationCode}">`,
    ));

    assert.deepEqual(await verifySite(tenantA, created.slug, 'META', harness.dependencies), { status: 'ACTIVE' });
    assert.equal(hostFor(harness.records, 'tenant-a', created.slug)?.status, 'ACTIVE');
    assert.deepEqual(harness.requestedUrls, [siteInput.homeUrl]);
  });

  it('trả lỗi VERIFICATION_CODE_MISMATCH cho META sai và giữ PENDING', async () => {
    const harness = createHarness();
    const created = await createSite(tenantA, siteInput, harness.dependencies);
    harness.setFetchOutcome(successfulFetch(
      '<meta name="translateme-site-verification" content="wrong-code">',
    ));

    await assert.rejects(
      verifySite(tenantA, created.slug, 'META', harness.dependencies),
      (error: unknown) => error instanceof AppError && error.code === 'VERIFICATION_CODE_MISMATCH',
    );
    assert.equal(hostFor(harness.records, 'tenant-a', created.slug)?.status, 'PENDING');
  });

  it('xác minh FILE thành công tại đúng đường dẫn và chuyển sang ACTIVE', async () => {
    const harness = createHarness();
    const created = await createSite(tenantA, siteInput, harness.dependencies);
    harness.setFetchOutcome(successfulFetch(`\n${created.verificationCode}\n`));

    assert.deepEqual(await verifySite(tenantA, created.slug, 'FILE', harness.dependencies), { status: 'ACTIVE' });
    assert.equal(hostFor(harness.records, 'tenant-a', created.slug)?.status, 'ACTIVE');
    assert.deepEqual(harness.requestedUrls, ['https://site.example/translateme-verification.txt']);
  });

  it('trả lỗi VERIFICATION_CODE_MISMATCH cho FILE sai và giữ PENDING', async () => {
    const harness = createHarness();
    const created = await createSite(tenantA, siteInput, harness.dependencies);
    harness.setFetchOutcome(successfulFetch('wrong-code'));

    await assert.rejects(
      verifySite(tenantA, created.slug, 'FILE', harness.dependencies),
      (error: unknown) => error instanceof AppError && error.code === 'VERIFICATION_CODE_MISMATCH',
    );
    assert.equal(hostFor(harness.records, 'tenant-a', created.slug)?.status, 'PENDING');
  });

  it('trả SITE_UNREACHABLE nếu safeFetch bị chặn và giữ trạng thái PENDING', async () => {
    const harness = createHarness();
    const created = await createSite(tenantA, siteInput, harness.dependencies);
    harness.setFetchOutcome({
      kind: 'BLOCKED',
      reason: 'PRIVATE_IP',
      url: siteInput.homeUrl,
      detail: 'Blocked by safeFetch',
    });

    await assert.rejects(
      verifySite(tenantA, created.slug, 'META', harness.dependencies),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'SITE_UNREACHABLE' &&
        error.details?.reason === 'BLOCKED',
    );
    assert.equal(hostFor(harness.records, 'tenant-a', created.slug)?.status, 'PENDING');
  });

  it('pauseSite chuyển ACTIVE sang PAUSED và chạy invalidation', async () => {
    const harness = createHarness();
    const created = await createSite(tenantA, siteInput, harness.dependencies);
    const host = hostFor(harness.records, 'tenant-a', created.slug);
    assert.ok(host);
    host.status = 'ACTIVE';

    assert.deepEqual(await pauseSite(tenantA, created.slug, harness.dependencies), {
      status: 'PAUSED',
      invalidation: {
        paths: [`/${created.slug}/*`],
        mode: 'WILDCARD',
      },
    });
    assert.equal(hostFor(harness.records, 'tenant-a', created.slug)?.status, 'PAUSED');
    assert.deepEqual(harness.invalidations, [{ slugs: [created.slug] }]);
  });

  it('resumeSite chuyển PAUSED sang ACTIVE và chạy invalidation', async () => {
    const harness = createHarness();
    const created = await createSite(tenantA, siteInput, harness.dependencies);
    const host = hostFor(harness.records, 'tenant-a', created.slug);
    assert.ok(host);
    host.status = 'PAUSED';

    assert.deepEqual(await resumeSite(tenantA, created.slug, harness.dependencies), {
      status: 'ACTIVE',
      invalidation: {
        paths: [`/${created.slug}/*`],
        mode: 'WILDCARD',
      },
    });
    assert.equal(hostFor(harness.records, 'tenant-a', created.slug)?.status, 'ACTIVE');
    assert.deepEqual(harness.invalidations, [{ slugs: [created.slug] }]);
  });

  it('resumeSite từ chối PENDING và không chạy invalidation', async () => {
    const harness = createHarness();
    const created = await createSite(tenantA, siteInput, harness.dependencies);

    await assert.rejects(
      resumeSite(tenantA, created.slug, harness.dependencies),
      (error: unknown) => error instanceof AppError && error.code === 'VERSION_CONFLICT',
    );
    assert.equal(hostFor(harness.records, 'tenant-a', created.slug)?.status, 'PENDING');
    assert.deepEqual(harness.invalidations, []);
  });

  it('pauseSite từ chối trạng thái khác ACTIVE và không chạy invalidation', async () => {
    const harness = createHarness();
    const created = await createSite(tenantA, siteInput, harness.dependencies);

    await assert.rejects(
      pauseSite(tenantA, created.slug, harness.dependencies),
      (error: unknown) => error instanceof AppError && error.code === 'VERSION_CONFLICT',
    );
    assert.equal(hostFor(harness.records, 'tenant-a', created.slug)?.status, 'PENDING');
    assert.deepEqual(harness.invalidations, []);
  });

  it('chuyển ConditionalCheckFailedException thành VERSION_CONFLICT', async () => {
    const harness = createHarness();
    const created = await createSite(tenantA, siteInput, harness.dependencies);
    harness.dependencies.db.updateSiteStatus = async () => {
      throw Object.assign(new Error('The conditional request failed'), {
        name: 'ConditionalCheckFailedException',
      });
    };

    await assert.rejects(
      resumeSite(tenantA, created.slug, harness.dependencies),
      (error: unknown) => error instanceof AppError && error.code === 'VERSION_CONFLICT',
    );
    assert.deepEqual(harness.invalidations, []);
  });

  it('trả về NOT_FOUND khi website không tồn tại', async () => {
    const harness = createHarness();

    await assert.rejects(
      pauseSite(tenantA, 'missing-site', harness.dependencies),
      (error: unknown) => error instanceof AppError && error.code === 'NOT_FOUND',
    );
  });

  it('cho phép thử lại invalidation sau khi trạng thái đã đổi', async () => {
    const harness = createHarness();
    const created = await createSite(tenantA, siteInput, harness.dependencies);
    const host = hostFor(harness.records, 'tenant-a', created.slug);
    assert.ok(host);
    host.status = 'ACTIVE';

    let attempts = 0;
    harness.dependencies.invalidateSites = async (_ctx, options) => {
      attempts += 1;
      if (attempts === 1) throw new AppError('CACHE_INVALIDATION_FAILED', 'CloudFront unavailable');
      return { paths: [`/${options.slugs[0]}/*`], mode: 'WILDCARD' };
    };

    await assert.rejects(
      pauseSite(tenantA, created.slug, harness.dependencies),
      (error: unknown) => error instanceof AppError && error.code === 'CACHE_INVALIDATION_FAILED',
    );
    assert.equal(host.status, 'PAUSED');

    assert.deepEqual(await pauseSite(tenantA, created.slug, harness.dependencies), {
      status: 'PAUSED',
      invalidation: { paths: [`/${created.slug}/*`], mode: 'WILDCARD' },
    });
    assert.equal(attempts, 2);
  });

  it('chỉ một tenant đăng ký thành công khi hai tenant cùng đăng ký slug', async () => {
    const harness = createHarness();

    const results = await Promise.allSettled([
      createSite(tenantA, siteInput, harness.dependencies),
      createSite(tenantB, siteInput, harness.dependencies),
    ]);
    const succeeded = results.filter((result) => result.status === 'fulfilled');
    const failed = results.filter((result) => result.status === 'rejected');

    assert.equal(succeeded.length, 1);
    assert.equal(failed.length, 1);
    if (failed[0].status === 'rejected') {
      assert.ok(failed[0].reason instanceof AppError);
      assert.equal(failed[0].reason.code, 'DUPLICATE_SLUG');
    }
    assert.equal(harness.records.has('TENANT#PLATFORM#SLUG#site-example::META'), true);
    assert.equal(
      [...harness.records.keys()].filter((key) => key.endsWith('::HOST#site-example')).length,
      1,
    );
  });
});
