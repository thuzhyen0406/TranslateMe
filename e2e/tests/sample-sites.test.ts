import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSites } from '../tools/build-sites';
import {
  A_PAGES, KB8_SHARED_SENTENCE, LATENCY_RUNS, LATENCY_SENTENCES, LATENCY_WARM_PAGE, TOO_LARGE_BYTES, latencyColdPage, vietnameseNumber,
} from '../lib/sampleSites';

const paragraphs = (html: string) => [...html.matchAll(/<p>([^<]*)<\/p>/g)].map((m) => m[1]);
const build = (codes: Record<string, string> = {}) => buildSites({
  outDir: '/dev/null',
  origins: { A: 'https://a.example.net/' },
  verifyCodes: codes,
});

test('B: mỗi trang đo có 98 đoạn + title + h1 = 100 câu; các trang lạnh và trang ấm không trùng câu', () => {
  const b = build().B;
  const seen = new Set<string>();
  for (const p of [...Array.from({ length: LATENCY_RUNS }, (_, i) => latencyColdPage(i + 1)), LATENCY_WARM_PAGE]) {
    const html = b.get(`${p}index.html`)!;
    const ps = paragraphs(html);
    assert.equal(ps.length + 2, LATENCY_SENTENCES, p);
    for (const s of ps) {
      assert.ok(!seen.has(s), `câu trùng: ${s}`);
      seen.add(s);
      assert.ok(!/\d/.test(s), 'không có chữ số (Translate giữ nguyên chữ số, câu sẽ trùng bản dịch)');
    }
  }
});

test('C: câu X có ở trang-1 và trang-2, không có ở trang-3 (kịch bản 8)', () => {
  const c = build().C;
  assert.ok(paragraphs(c.get('trang-1/index.html')!).includes(KB8_SHARED_SENTENCE));
  assert.ok(paragraphs(c.get('trang-2/index.html')!).includes(KB8_SHARED_SENTENCE));
  assert.ok(!c.get('trang-3/index.html')!.includes(KB8_SHARED_SENTENCE));
});

test('A: trang quá lớn > 3 MB, có biểu mẫu/iframe/translate="no"; sitemap khi có origin', () => {
  const a = build().A;
  assert.ok(Buffer.byteLength(a.get(`${A_PAGES.tooLarge}index.html`)!) > TOO_LARGE_BYTES);
  const contact = a.get(`${A_PAGES.contact}index.html`)!;
  for (const needle of ['placeholder=', '<select', '<textarea', 'type="submit"']) assert.ok(contact.includes(needle), needle);
  const home = a.get('index.html')!;
  for (const needle of ['<iframe', 'translate="no"', '<strong>', 'alt=', 'name="description"']) assert.ok(home.includes(needle), needle);
  assert.ok(!a.has(`${A_PAGES.missing}index.html`), 'trang 404 phải không tồn tại trên origin');
  assert.match(a.get('sitemap.xml')!, /<loc>https:\/\/a\.example\.net\/phong-nghi\/<\/loc>/);
  assert.equal(build().B.has('sitemap.xml'), false);
});

test('mã xác minh: thẻ META trong head và tệp FILE', () => {
  const sites = build({ A: 'tm-a_1', C: 'tm-c' });
  assert.ok(sites.A.get('index.html')!.includes('<meta name="translateme-site-verification" content="tm-a_1">'));
  assert.equal(sites.A.get('translateme-verification.txt'), 'tm-a_1');
  assert.ok(!sites.B.get('index.html')!.includes('translateme-site-verification'));
  assert.equal(sites.B.has('translateme-verification.txt'), false);
  assert.throws(() => build({ A: 'x"><script>' }), /không hợp lệ/);
});

test('TM_LATENCY_ROUND đổi toàn bộ câu của site B (đo lại (a) với TM rỗng), giữ nguyên đường dẫn', () => {
  const r1 = buildSites({ outDir: '/dev/null', origins: {}, verifyCodes: {} }).B;
  const r2 = buildSites({ outDir: '/dev/null', origins: {}, verifyCodes: {}, latencyRound: 2 }).B;
  assert.deepEqual([...r1.keys()].sort(), [...r2.keys()].sort());
  const s1 = new Set(paragraphs(r1.get(`${latencyColdPage(1)}index.html`)!));
  assert.ok(paragraphs(r2.get(`${latencyColdPage(1)}index.html`)!).every((s) => !s1.has(s)));
  assert.throws(() => buildSites({ outDir: '/dev/null', origins: {}, verifyCodes: {}, latencyRound: 0 }), /TM_LATENCY_ROUND/);
});

test('vietnameseNumber', () => {
  assert.equal(vietnameseNumber(7), 'bảy');
  assert.equal(vietnameseNumber(25), 'hai mươi năm');
  assert.notEqual(vietnameseNumber(101), vietnameseNumber(110));
});
