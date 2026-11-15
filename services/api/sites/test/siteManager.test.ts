import assert from 'node:assert/strict';
import { SLUG_RE, slugFromHostname } from '../../../../libs/common/siteSlug.js';
import { describe, it } from 'node:test';
import { AppError, type Ctx } from '../../../../libs/common/types.js';
import { safeFetch, type SafeFetchOutcome } from '../../../../libs/common/safeFetch.js';
import {
  createSite,
  pauseSite,
  resumeSite,
  verifySite,
  updateSite,
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
        const reasons = operations.map(({ Put, Update, ConditionCheck }) => {
          let failed = false;
          if (Put) {
            const current = records.get(keyOf(Put.Item));
            failed = Boolean(current && current.tenantId !== Put.ExpressionAttributeValues?.[':owner']);
            if (current && !Put.ExpressionAttributeValues?.[':owner']) failed = true;
          } else if (Update) {
            const current = records.get(keyOf(Update.Key));
            const values = Update.ExpressionAttributeValues;
            failed = !current || (values[':pending'] !== undefined &&
              (current.status !== values[':pending'] || current.homeUrl !== values[':url'] || current.verificationCode !== values[':code']));
          } else if (ConditionCheck) {
            failed = records.get(keyOf(ConditionCheck.Key))?.status !== 'ACTIVE';
          }
          return { Code: failed ? 'ConditionalCheckFailed' : 'None' };
        });
        if (reasons.some(({ Code }) => Code === 'ConditionalCheckFailed')) {
          throw Object.assign(new Error('Conditional transaction failed'), {
            name: 'TransactionCanceledException', CancellationReasons: reasons,
          });
        }
        for (const { Put, Update } of operations) {
          if (Put) records.set(keyOf(Put.Item), { ...Put.Item });
          if (Update) {
            const current = records.get(keyOf(Update.Key))!;
            if (Update.ExpressionAttributeValues[':pending'] !== undefined) {
              Object.assign(current, { status: 'ACTIVE', updatedAt: Update.ExpressionAttributeValues[':now'] });
            } else {
              for (const [placeholder, value] of Object.entries(Update.ExpressionAttributeValues)) {
                const attr = Update.ExpressionAttributeNames[placeholder.replace(':v', '#f')];
                current[attr] = value;
              }
            }
          }
        }
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
        const config = records.get(`TENANT#${ctx.tenantId}::CONFIG`);
        if (!config || config.status !== 'ACTIVE') {
          throw new AppError('TENANT_SUSPENDED', 'Tenant đang bị khóa');
        }
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

  it('tạo site PENDING chỉ trong tenant hiện tại', async () => {
    const harness = createHarness();

    const result = await createSite(tenantA, siteInput, harness.dependencies);

    assert.equal(result.slug, 'site-example');
    assert.equal(result.status, 'PENDING');
    assert.match(result.verificationCode, /^translateme-verify-/);
    assert.equal(harness.transactions.length, 1);
    assert.equal(harness.transactions[0].length, 2);
    assert.deepEqual(
      harness.transactions[0].map((operation) => operation.Put?.ConditionExpression).filter(Boolean),
      ['attribute_not_exists(PK)'],
    );
    const tenantStatusCheck = harness.transactions[0][1].ConditionCheck;
    assert.deepEqual(tenantStatusCheck.Key, { PK: 'TENANT#tenant-a', SK: 'CONFIG' });
    assert.equal(tenantStatusCheck.ConditionExpression, 'attribute_exists(PK) AND #status = :active');
    assert.deepEqual(tenantStatusCheck.ExpressionAttributeNames, { '#status': 'status' });
    assert.deepEqual(tenantStatusCheck.ExpressionAttributeValues, { ':active': 'ACTIVE' });
    assert.equal(harness.records.has('TENANT#PLATFORM#SLUG#site-example::META'), false);
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
      `<HTML><HEAD><META content='${created.verificationCode}' NAME='translateme-site-verification'></HEAD></HTML>`,
    ));

    assert.deepEqual(await verifySite(tenantA, created.slug, 'META', harness.dependencies), { status: 'ACTIVE' });
    assert.equal(harness.records.get('TENANT#PLATFORM#SLUG#site-example::META')?.tenantId, tenantA.tenantId);
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
    harness.dependencies.safeFetch = (url, options) => {
      harness.requestedUrls.push(url);
      return safeFetch(url, options, {
        resolver: harness.dependencies.resolver,
        transport: async () => ({
          status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' },
          body: (async function* () { yield Buffer.from(`\n${created.verificationCode}\n`); })(),
          destroy() {},
        }),
      });
    };

    assert.deepEqual(await verifySite(tenantA, created.slug, 'FILE', harness.dependencies), { status: 'ACTIVE' });
    assert.equal(hostFor(harness.records, 'tenant-a', created.slug)?.status, 'ACTIVE');
    assert.deepEqual(harness.requestedUrls, ['https://site.example/translateme-verification.txt']);
  });

  it('không xác minh website nếu tenant bị khóa trong lúc tải trang', async () => {
    const harness = createHarness();
    const created = await createSite(tenantA, siteInput, harness.dependencies);
    harness.setFetchOutcome(successfulFetch(
      `<meta name="translateme-site-verification" content="${created.verificationCode}">`,
    ));
    harness.dependencies.safeFetch = async () => {
      const config = harness.records.get('TENANT#tenant-a::CONFIG');
      if (config) config.status = 'LOCKED';
      return successfulFetch(
        `<meta name="translateme-site-verification" content="${created.verificationCode}">`,
      );
    };

    await assert.rejects(
      verifySite(tenantA, created.slug, 'META', harness.dependencies),
      (error: unknown) => error instanceof AppError && error.code === 'TENANT_SUSPENDED',
    );
    assert.equal(hostFor(harness.records, 'tenant-a', created.slug)?.status, 'PENDING');
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

  it('pauseSite và resumeSite từ chối cập nhật nếu CONFIG bị khóa', async () => {
    const harness = createHarness();
    const created = await createSite(tenantA, siteInput, harness.dependencies);
    const host = hostFor(harness.records, 'tenant-a', created.slug);
    const config = harness.records.get('TENANT#tenant-a::CONFIG');
    assert.ok(host);
    assert.ok(config);

    host.status = 'ACTIVE';
    config.status = 'LOCKED';
    await assert.rejects(
      pauseSite(tenantA, created.slug, harness.dependencies),
      (error: unknown) => error instanceof AppError && error.code === 'TENANT_SUSPENDED',
    );
    assert.equal(host.status, 'ACTIVE');

    host.status = 'PAUSED';
    await assert.rejects(
      resumeSite(tenantA, created.slug, harness.dependencies),
      (error: unknown) => error instanceof AppError && error.code === 'TENANT_SUSPENDED',
    );
    assert.equal(host.status, 'PAUSED');
    assert.deepEqual(harness.invalidations, []);
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
    await assert.rejects(
      verifySite(tenantA, 'missing-site', 'META', harness.dependencies),
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

  it('hai tenant tạo được PENDING, chỉ một tenant giành được slug khi xác minh đồng thời', async () => {
    const harness = createHarness();
    const [a, b] = await Promise.all([
      createSite(tenantA, siteInput, harness.dependencies),
      createSite(tenantB, siteInput, harness.dependencies),
    ]);
    assert.equal(a.slug, b.slug);
    assert.notEqual(a.verificationCode, b.verificationCode);
    assert.equal(harness.records.has('TENANT#PLATFORM#SLUG#site-example::META'), false);
    const proof = (code: string) => `<meta name="translateme-site-verification" content="${code}">`;
    harness.setFetchOutcome(successfulFetch(proof(a.verificationCode) + proof(b.verificationCode)));
    const results = await Promise.allSettled([
      verifySite(tenantA, a.slug, 'META', harness.dependencies),
      verifySite(tenantB, b.slug, 'META', harness.dependencies),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const failed = results.find((r) => r.status === 'rejected');
    assert.equal(failed?.reason.code, 'DUPLICATE_SLUG');
    const mapping = harness.records.get('TENANT#PLATFORM#SLUG#site-example::META')!;
    assert.ok(mapping.verifiedAt);
    assert.equal(hostFor(harness.records, mapping.tenantId, a.slug)?.status, 'ACTIVE');
  });

  it('chấp nhận mapping cũ của chính tenant và xác minh lại ACTIVE theo kiểu idempotent', async () => {
    const harness = createHarness();
    const { slug, verificationCode } = await createSite(tenantA, siteInput, harness.dependencies);
    const PK = `TENANT#PLATFORM#SLUG#${slug}`;
    harness.records.set(`${PK}::META`, { PK, SK: 'META', tenantId: tenantA.tenantId });
    harness.setFetchOutcome(successfulFetch(`<meta name="translateme-site-verification" content="${verificationCode}">`));
    await verifySite(tenantA, slug, 'META', harness.dependencies);
    assert.deepEqual(await verifySite(tenantA, slug, 'META', harness.dependencies), { status: 'ACTIVE' });
    assert.equal(harness.requestedUrls.length, 1);
    assert.ok(harness.records.get(`${PK}::META`)?.verifiedAt);
  });

  it('từ chối proof trong comment, body, phản hồi lỗi và chuyển hướng sang origin khác', async () => {
    const harness = createHarness();
    const { slug, verificationCode } = await createSite(tenantA, siteInput, harness.dependencies);
    const proof = `<meta name="translateme-site-verification" content="${verificationCode}">`;
    const cases = [
      { res: successfulFetch(`<!-- ${proof} -->`), method: 'META', code: 'VERIFICATION_CODE_MISMATCH' },
      { res: successfulFetch(`<body>${proof}</body>`), method: 'META', code: 'VERIFICATION_CODE_MISMATCH' },
      { res: { ...successfulFetch(proof), status: 404 }, method: 'META', code: 'SITE_UNREACHABLE' },
      { res: { ...successfulFetch(proof), finalUrl: 'https://other.example/' }, method: 'META', code: 'VERIFICATION_CODE_MISMATCH' },
      { res: { ...successfulFetch(verificationCode), finalUrl: 'https://other.example/proof.txt' }, method: 'FILE', code: 'VERIFICATION_CODE_MISMATCH' },
    ] as const;
    for (const { res, method, code } of cases) {
      harness.setFetchOutcome(res);
      await assert.rejects(verifySite(tenantA, slug, method, harness.dependencies), { code });
    }
    assert.equal(hostFor(harness.records, tenantA.tenantId, slug)?.status, 'PENDING');
    assert.equal(harness.records.has(`TENANT#PLATFORM#SLUG#${slug}::META`), false);
  });

  it('slug hostname dài phù hợp regex proxy và phân biệt hostname có dấu gạch nối', async () => {
    const harness = createHarness();
    const hostname = 'a'.repeat(50) + '.' + 'b'.repeat(15) + '.example';
    const { slug } = await createSite(tenantA, { ...siteInput, homeUrl: `https://${hostname}/` }, harness.dependencies);
    assert.match(slug, SLUG_RE);
    assert.equal(slug, slugFromHostname(hostname.toUpperCase() + '.'));
    assert.notEqual(slugFromHostname('a-b.c.example'), slugFromHostname('a.b-c.example'));
  });

  it('updateSite cập nhật thông tin chung nhưng cấm đổi status', async () => {
    const harness = createHarness();
    const created = await createSite(tenantA, siteInput, harness.dependencies);

    // Cập nhật hợp lệ
    const updated = await updateSite(tenantA, created.slug, {
      displayName: 'Tên mới',
      targetLangs: ['en', 'fr'],
      noTranslateSelectors: ['.code'],
      cacheTTL: 7200,
    }, harness.dependencies);

    assert.equal(updated.displayName, 'Tên mới');
    assert.deepEqual(updated.targetLangs, ['en', 'fr']);
    assert.deepEqual(updated.noTranslateSelectors, ['.code']);
    assert.equal(updated.cacheTTL, 7200);

    // Cấm đổi status
    await assert.rejects(
      updateSite(tenantA, created.slug, { status: 'ACTIVE' }, harness.dependencies),
      (err: unknown) => err instanceof AppError && err.code === 'INVALID_REQUEST',
    );

    // Báo NOT_FOUND khi không tồn tại slug
    await assert.rejects(
      updateSite(tenantA, 'khong-ton-tai', { displayName: 'X' }, harness.dependencies),
      (err: unknown) => err instanceof AppError && err.code === 'NOT_FOUND',
    );
  });
});
