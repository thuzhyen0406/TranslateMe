import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_CACHE_SECONDS, cachedSiteResolver, parseSitesJson, staticSiteResolver, validateSiteConfig } from '../sites.js';

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

describe('SiteResolver', () => {
  it('tra theo slug; không có -> null', async () => {
    const r = staticSiteResolver(parseSitesJson(JSON.stringify([base])));
    assert.equal((await r('homestay-abc'))?.tenantId, 't_1');
    assert.equal(await r('khong-co'), null);
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
});
