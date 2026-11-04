import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_CACHE_SECONDS,
  MAX_PAGE_CACHE_SECONDS,
  cachedSiteResolver,
  SiteLookupUnavailable,
  dynamoSiteResolver,
  parseSitesJson,
  staticSiteResolver,
  validateSiteConfig,
} from '../sites.js';

const base = { slug: 'homestay-abc', tenantId: 't_1', homeUrl: 'https://homestay-abc.vn/blog', sourceLang: 'vi', targetLangs: ['en', 'vi', 'ko', 'en'] };

describe('validateSiteConfig / parseSitesJson', () => {
  it('chuẩn hoá trang chủ, bỏ ngôn ngữ gốc và ngôn ngữ trùng khỏi danh sách đích, điền mặc định', () => {
    const s = validateSiteConfig({ ...base, homeUrl: 'https://homestay-abc.vn/blog?x=1#a' });
    assert.equal(s.homeUrl, 'https://homestay-abc.vn/blog/');
    assert.deepEqual(s.targetLangs, ['en', 'ko']);
    assert.equal(s.cacheSeconds, DEFAULT_CACHE_SECONDS);
    assert.equal(s.status, 'ACTIVE');
    assert.equal(s.tenantStatus, 'ACTIVE');
    assert.deepEqual(s.exclusionSelectors, []);
  });

  it('từ chối cấu hình sai', () => {
    const bad: Array<[Record<string, unknown>, RegExp]> = [
      [{ ...base, slug: 'Homestay_ABC' }, /slug/],
      [{ ...base, slug: '-abc' }, /slug/],
      [{ ...base, homeUrl: 'ftp://a.vn/' }, /http/],
      [{ ...base, homeUrl: 'không phải url' }, /homeUrl/],
      [{ ...base, targetLangs: [] }, /targetLangs/],
      [{ ...base, targetLangs: ['english'] }, /targetLangs/],
      [{ ...base, sourceLang: 'Tiếng Việt' }, /sourceLang/],
      [{ ...base, status: 'DELETED' }, /status/],
      [{ ...base, tenantStatus: 'BANNED' }, /tenantStatus/],
      [{ ...base, tenantId: '' }, /tenantId/],
    ];
    for (const [cfg, re] of bad) assert.throws(() => validateSiteConfig(cfg), re, JSON.stringify(cfg));
  });

  it('PROXY_SITES_JSON: rỗng -> [], không phải mảng hoặc trùng slug -> lỗi', () => {
    assert.deepEqual(parseSitesJson(undefined), []);
    assert.deepEqual(parseSitesJson('  '), []);
    assert.equal(parseSitesJson(JSON.stringify([base])).length, 1);
    assert.throws(() => parseSitesJson('{"slug":"a"}'), /mảng/);
    assert.throws(() => parseSitesJson('[{'), SyntaxError);
    assert.throws(() => parseSitesJson(JSON.stringify([base, base])), /trùng/);
  });
});

describe('cacheSeconds tối đa 7 ngày (ngắn hơn TTL SEG)', () => {
  it('nhận đúng 7 ngày, từ chối dài hơn', () => {
    assert.equal(validateSiteConfig({ ...base, cacheSeconds: MAX_PAGE_CACHE_SECONDS }).cacheSeconds, 7 * 86_400);
    assert.throws(() => validateSiteConfig({ ...base, cacheSeconds: MAX_PAGE_CACHE_SECONDS + 1 }), /cacheSeconds/);
    assert.throws(() => parseSitesJson(JSON.stringify([{ ...base, cacheSeconds: 31 * 86_400 }])), /cacheSeconds/);
  });
});

describe('SiteResolver', () => {
  it('tra theo slug; không có -> null', async () => {
    const r = staticSiteResolver(parseSitesJson(JSON.stringify([base])));
    assert.equal((await r('homestay-abc'))?.tenantId, 't_1');
    assert.equal(await r('khong-co'), null);
  });

  it('dynamo resolver đọc slug, HOST, CONFIG và giữ tenant LOCKED', async () => {
    const resolver = dynamoSiteResolver({
      send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
        if (command.constructor.name === 'GetCommand') {
          return Promise.resolve({ Item: { tenantId: 't_1' } });
        }
        return Promise.resolve({
          Responses: {
            'translate-data': [
              { PK: 'TENANT#t_1', SK: 'HOST#homestay-abc', homeUrl: 'https://homestay-abc.vn', sourceLang: 'vi', targetLangs: ['en'], status: 'ACTIVE', noTranslateSelectors: ['.nav'] },
              { PK: 'TENANT#t_1', SK: 'CONFIG', status: 'LOCKED' },
            ],
          },
        });
      },
    } as never, 'translate-data');

    assert.deepEqual(
      await resolver('homestay-abc'),
      validateSiteConfig({
        ...base,
        noTranslateSelectors: undefined,
        exclusionSelectors: ['.nav'],
        tenantStatus: 'LOCKED',
        homeUrl: 'https://homestay-abc.vn',
        targetLangs: ['en'],
      }),
    );
    assert.equal(await resolver('missing-site'), null);
  });

  it('lưu đệm 60 giây, kể cả kết quả không tìm thấy', async () => {
    let calls = 0;
    let t = 0;
    const r = cachedSiteResolver(
      async (slug) => {
        calls++;
        return slug === 'a' ? validateSiteConfig({ ...base, slug: 'a' }) : null;
      },
      60_000,
      () => t,
    );
    await r('a');
    await r('a');
    await r('b');
    await r('b');
    assert.equal(calls, 2);
    t = 60_000;
    await r('a');
    assert.equal(calls, 3);
  });

  describe('dynamoSiteResolver – lỗi và bóp băng thông', () => {
    const HOST = { PK: 'TENANT#t_1', SK: 'HOST#homestay-abc', homeUrl: 'https://homestay-abc.vn', sourceLang: 'vi', targetLangs: ['en'], status: 'ACTIVE' };
    const CONFIG = { PK: 'TENANT#t_1', SK: 'CONFIG', status: 'ACTIVE' };
    type Cmd = { constructor: { name: string }; input: { RequestItems?: Record<string, { Keys: Array<{ SK: string }> }> } };
    function client(batches: Array<(cmd: Cmd) => unknown>, getItem: () => unknown = () => ({ Item: { tenantId: 't_1' } })) {
      const sent: Cmd[] = [];
      return {
        sent,
        send(cmd: Cmd) {
          if (cmd.constructor.name === 'GetCommand') return Promise.resolve().then(getItem);
          sent.push(cmd);
          const next = batches.shift();
          if (!next) throw new Error('quá số lần gọi');
          return Promise.resolve().then(() => next(cmd));
        },
      };
    }
    const noSleep = async () => {};

    it('gửi lại UnprocessedKeys (có backoff) rồi ghép kết quả', async () => {
      const waits: number[] = [];
      const c = client([
        () => ({ Responses: { t: [HOST] }, UnprocessedKeys: { t: { Keys: [{ PK: 'TENANT#t_1', SK: 'CONFIG' }] } } }),
        () => ({ Responses: { t: [] }, UnprocessedKeys: { t: { Keys: [{ PK: 'TENANT#t_1', SK: 'CONFIG' }] } } }),
        () => ({ Responses: { t: [CONFIG] } }),
      ]);
      const r = dynamoSiteResolver(c as never, 't', { sleep: async (ms) => void waits.push(ms) });
      assert.equal((await r('homestay-abc'))?.tenantId, 't_1');
      assert.equal(c.sent.length, 3);
      assert.deepEqual(c.sent[1].input.RequestItems!.t.Keys.map((k) => k.SK), ['CONFIG']);
      assert.deepEqual(waits, [50, 100]);
    });

    it('vẫn còn UnprocessedKeys sau maxAttempts -> ném SiteLookupUnavailable, không trả null', async () => {
      const throttled = () => ({ Responses: { t: [] }, UnprocessedKeys: { t: { Keys: [{ PK: 'TENANT#t_1', SK: 'CONFIG' }] } } });
      const r = dynamoSiteResolver(client([throttled, throttled]) as never, 't', { maxAttempts: 2, sleep: noSleep });
      await assert.rejects(r('homestay-abc'), (e: unknown) => e instanceof SiteLookupUnavailable && /UnprocessedKeys/.test(e.message));
    });

    it('DynamoDB lỗi (GetItem hoặc BatchGet) -> SiteLookupUnavailable; cachedSiteResolver không lưu đệm lỗi', async () => {
      const failGet = dynamoSiteResolver(client([], () => { throw Object.assign(new Error('x'), { name: 'ProvisionedThroughputExceededException' }); }) as never, 't');
      await assert.rejects(failGet('homestay-abc'), (e: unknown) => e instanceof SiteLookupUnavailable && /ProvisionedThroughput/.test(e.message));

      const c = client([
        () => { throw Object.assign(new Error('x'), { name: 'InternalServerError' }); },
        () => ({ Responses: { t: [HOST, CONFIG] } }),
      ]);
      const cached = cachedSiteResolver(dynamoSiteResolver(c as never, 't', { sleep: noSleep }));
      await assert.rejects(cached('homestay-abc'), SiteLookupUnavailable);
      assert.equal((await cached('homestay-abc'))?.slug, 'homestay-abc', 'lần sau tra lại, không dính null');
    });

    it('HOST sai dạng (cacheTtlSec > 7 ngày, homeUrl hỏng) -> ghi log INVALID và trả null, không ném', async () => {
      const logs: Array<{ slug: string; tenantId: string; error: string }> = [];
      for (const bad of [{ ...HOST, cacheTtlSec: MAX_PAGE_CACHE_SECONDS + 1 }, { ...HOST, homeUrl: 'không phải url' }]) {
        const r = dynamoSiteResolver(client([() => ({ Responses: { t: [bad, CONFIG] } })]) as never, 't', { onInvalidConfig: (e) => void logs.push(e) });
        assert.equal(await r('homestay-abc'), null);
      }
      assert.equal(logs.length, 2);
      assert.deepEqual([logs[0].slug, logs[0].tenantId], ['homestay-abc', 't_1']);
    });
  });
});
