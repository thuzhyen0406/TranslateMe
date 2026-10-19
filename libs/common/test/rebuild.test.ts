import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extract } from '../extract.js';
import { rebuild, rebuildDetailed, type RebuildOptionsExt } from '../rebuild.js';

const ORIGIN = 'https://homestay-abc.vn';
const opts = (o: Partial<RebuildOptionsExt> = {}): RebuildOptionsExt => ({
  targetLang: 'en',
  originalUrl: `${ORIGIN}/phong-nghi/deluxe?ref=1`,
  slug: 'abc',
  languageSwitcher: false,
  ...o,
});

/** extract rồi rebuild với bản dịch = hàm biến đổi câu (mặc định giữ nguyên câu) */
function roundTrip(html: string, o: Partial<RebuildOptionsExt> = {}, translate: (s: string, i: number) => string | undefined = (s) => s) {
  const r = extract(html);
  return rebuildDetailed(r.skeletonHtml, r.sentences.map(translate) as string[], r.placeholders, opts(o));
}
const page = (body: string, head = '') => `<!DOCTYPE html><html lang="vi"><head>${head}</head><body>${body}</body></html>`;

describe('rebuild – điền bản dịch', () => {
  it('khôi phục thẻ theo id dù bản dịch đảo thứ tự (ko/ja)', () => {
    const r = extract(page('<p>Giá gồm <b>bữa sáng</b> và <a href="/xe">xe đưa đón</a>.</p>'));
    assert.deepEqual(r.sentences, ['Giá gồm {1}bữa sáng{/1} và {2}xe đưa đón{/2}.']);
    const html = rebuild(r.skeletonHtml, ['{2}送迎{/2}と{1}朝食{/1}込み。'], r.placeholders, opts({ targetLang: 'ja' }));
    assert.ok(html.includes('<p><a href="/ja/xe">送迎</a>と<b>朝食</b>込み。</p>'), html);
  });

  it('câu chưa có bản dịch giữ nguyên gốc (trang dịch dở)', () => {
    const { html, stats } = roundTrip(page('<p>Một.</p><p>Hai.</p><p>Ba.</p>'), {}, (s, i) => (i === 1 ? 'Two.' : undefined));
    assert.ok(html.includes('<p>Một.</p><p>Two.</p><p>Ba.</p>'));
    assert.deepEqual(stats, { sentences: 3, translated: 1, keptSource: 2, tagFallback: 0 });
  });

  it('bản dịch mất marker -> văn bản thuần, không vỡ DOM', () => {
    const { html, stats } = roundTrip(page('<p>Xem <a href="/a">tại đây</a> nhé.</p>'), {}, () => 'See {1}here please.');
    assert.ok(html.includes('<p>See here please.</p>'), html);
    assert.equal(stats.tagFallback, 1);
  });

  it('escape văn bản dịch: không chèn được thẻ hay thuộc tính (chống XSS)', () => {
    const { html } = roundTrip(page('<p>Xin chào.</p><img src="a.png" alt="Ảnh đẹp">'), {}, (s) =>
      s === 'Xin chào.' ? '<script>alert(1)</script> & co' : '" onerror="alert(1)',
    );
    assert.ok(html.includes('<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; co</p>'), html);
    assert.ok(html.includes('alt="&quot; onerror=&quot;alert(1)"'), html);
    assert.ok(!html.includes('<script>alert'));
  });

  it('dịch thuộc tính nằm trong thẻ nội tuyến (title của <a>)', () => {
    const { html } = roundTrip(page('<p>Đi tới <a href="/ban-do" title="Xem bản đồ">bản đồ</a> ngay.</p>'), {}, (s) =>
      s === 'Xem bản đồ' ? 'View map' : 'Go to {1}the map{/1} now.',
    );
    assert.ok(html.includes('<p>Go to <a href="/en/ban-do" title="View map">the map</a> now.</p>'), html);
  });

  it('ngoặc nhọn có thật trong văn bản được trả về đúng', () => {
    const { html } = roundTrip(page('<p>Mẫu {ten} giữ nguyên.</p>'));
    assert.ok(html.includes('<p>Mẫu {ten} giữ nguyên.</p>'), html);
  });
});

describe('rebuild – lang, canonical, hreflang', () => {
  const head = `<link rel="canonical" href="${ORIGIN}/phong-nghi/deluxe"><link rel="alternate" hreflang="fr" href="${ORIGIN}/fr/">`;
  const { html } = roundTrip(page('<p>Xin chào</p>', head), { targetLang: 'ko', languages: ['en', 'ko', 'ja'] });

  it('<html lang> theo ngôn ngữ đích', () => {
    assert.ok(html.includes('<html lang="ko">'));
  });

  it('canonical trỏ về chính trang dịch; bỏ canonical/hreflang cũ', () => {
    assert.equal(html.match(/rel="canonical"/g)?.length, 1);
    assert.ok(html.includes('<link rel="canonical" href="https://abc.translateme.example/ko/phong-nghi/deluxe?ref=1">'));
    assert.ok(!html.includes('hreflang="fr"'));
  });

  it('hreflang cho mọi ngôn ngữ đang bật, ngôn ngữ gốc và x-default', () => {
    for (const l of ['en', 'ko', 'ja']) {
      assert.ok(html.includes(`<link rel="alternate" hreflang="${l}" href="https://abc.translateme.example/${l}/phong-nghi/deluxe?ref=1">`), l);
    }
    assert.ok(html.includes(`<link rel="alternate" hreflang="vi" href="${ORIGIN}/phong-nghi/deluxe?ref=1">`));
    assert.ok(html.includes(`<link rel="alternate" hreflang="x-default" href="${ORIGIN}/phong-nghi/deluxe?ref=1">`));
  });

  it('tên miền proxy, ngôn ngữ RTL và website nằm trong thư mục con', () => {
    const r = roundTrip(page('<p>Xin chào</p><a href="/blog/bai-1">Bài 1</a><a href="/shop/">Cửa hàng</a>'), {
      targetLang: 'ar',
      originalUrl: `${ORIGIN}/blog/gioi-thieu`,
      siteHomeUrl: `${ORIGIN}/blog/`,
      proxyBaseDomain: 'translateme.app',
    }).html;
    assert.ok(r.includes('<html lang="ar" dir="rtl">'));
    assert.ok(r.includes('href="https://abc.translateme.app/ar/gioi-thieu"'));
    assert.ok(r.includes('<a href="/ar/bai-1">'));
    assert.ok(r.includes(`<a href="${ORIGIN}/shop/">`), 'ngoài thư mục website -> về gốc');
  });
});

describe('rebuild – viết lại URL', () => {
  const body = `
<a href="/lien-he?x=1#map">a</a><a href="tien-ich">b</a><a href="${ORIGIN}/">c</a><a href="https://other.com/p">d</a>
<a href="#top">e</a><a href="mailto:a@b.vn">f</a><a href="tel:0905">g</a><a href="javascript:void(0)">h</a><a href="/bang-gia.pdf">i</a>
<img src="/img/a.jpg" srcset="/img/a-1x.jpg 1x, img/a-2x.jpg 2x"><img src="data:image/png;base64,AAAA">
<script src="/js/app.js"></script><iframe src="/video"></iframe>
<form action="/dat-phong" method="post"><input type="image" src="/btn.png"></form><form method="get"><button formaction="/tim">x</button></form>
<div style="background:url('/img/bg.jpg')">x</div>`;
  const headHtml = `<link rel="stylesheet" href="/css/site.css"><link rel="icon" href="favicon.ico"><style>body{background:url(/img/b.png)} @import "/css/more.css";</style>`;
  const { html } = roundTrip(page(body, headHtml));

  it('liên kết nội bộ -> /{lang}/…, giữ query và hash; tương đối theo trang hiện tại', () => {
    assert.ok(html.includes('<a href="/en/lien-he?x=1#map">'));
    assert.ok(html.includes('<a href="/en/phong-nghi/tien-ich">'));
    assert.ok(html.includes('<a href="/en/">'));
  });

  it('liên kết ngoài, #, mailto, tel, javascript giữ nguyên; tệp không phải trang -> về gốc', () => {
    assert.ok(html.includes('<a href="https://other.com/p">'));
    for (const v of ['#top', 'mailto:a@b.vn', 'tel:0905', 'javascript:void(0)']) assert.ok(html.includes(`<a href="${v}">`), v);
    assert.ok(html.includes(`<a href="${ORIGIN}/bang-gia.pdf">`));
  });

  it('tài nguyên và form -> URL tuyệt đối về website gốc', () => {
    for (const v of [
      `src="${ORIGIN}/img/a.jpg"`,
      `srcset="${ORIGIN}/img/a-1x.jpg 1x, ${ORIGIN}/phong-nghi/img/a-2x.jpg 2x"`,
      'src="data:image/png;base64,AAAA"',
      `<script src="${ORIGIN}/js/app.js">`,
      `<iframe src="${ORIGIN}/video">`,
      `<form action="${ORIGIN}/dat-phong" method="post">`,
      `<input type="image" src="${ORIGIN}/btn.png">`,
      `<form method="get" action="${ORIGIN}/phong-nghi/deluxe?ref=1">`,
      `formaction="${ORIGIN}/tim"`,
      `style="background:url('${ORIGIN}/img/bg.jpg')"`,
      `<link rel="stylesheet" href="${ORIGIN}/css/site.css">`,
      `<link rel="icon" href="${ORIGIN}/phong-nghi/favicon.ico">`,
      `background:url(${ORIGIN}/img/b.png)`,
      `@import "${ORIGIN}/css/more.css"`,
    ]) {
      assert.ok(html.includes(v), v);
    }
  });

  it('srcset có dấu phẩy trong URL (Cloudinary) và data: URI không bị cắt', () => {
    const r = roundTrip(
      page('<img srcset="https://res.cloudinary.com/x/w_400,h_300/a.jpg 400w, /b.jpg 800w,data:image/png;base64,AA,BB 1x">'),
    ).html;
    assert.ok(r.includes(`srcset="https://res.cloudinary.com/x/w_400,h_300/a.jpg 400w, ${ORIGIN}/b.jpg 800w, data:image/png;base64,AA,BB 1x"`), r);
  });

  it('og:url trỏ về trang dịch', () => {
    const r = roundTrip(page('<p>x y</p>', `<meta property="og:url" content="${ORIGIN}/phong-nghi/deluxe">`)).html;
    assert.ok(r.includes('<meta property="og:url" content="https://abc.translateme.example/en/phong-nghi/deluxe?ref=1">'));
  });

  it('<base href> được dùng để phân giải rồi bỏ đi', () => {
    const r = roundTrip(page('<a href="gioi-thieu">x</a><img src="logo.png">', `<base href="${ORIGIN}/vi/">`)).html;
    assert.ok(!r.includes('<base'));
    assert.ok(r.includes('<a href="/en/vi/gioi-thieu">'));
    assert.ok(r.includes(`src="${ORIGIN}/vi/logo.png"`));
  });
});

describe('rebuild – nút chọn ngôn ngữ', () => {
  it('chèn <details> đầu body, có mục gốc, đánh dấu ngôn ngữ hiện tại, không bị dịch lại', () => {
    const { html } = roundTrip(page('<p>Xin chào</p>'), { languageSwitcher: true, targetLang: 'ko', languages: ['en', 'ko'] });
    assert.match(html, /<body><details id="tm-lang" class="notranslate" translate="no">/);
    assert.ok(html.includes(`<a href="${ORIGIN}/phong-nghi/deluxe?ref=1" hreflang="vi" lang="vi">Tiếng Việt (gốc)</a>`));
    assert.ok(html.includes('<a href="/en/phong-nghi/deluxe?ref=1" hreflang="en" lang="en">English</a>'));
    assert.ok(html.includes('<a href="/ko/phong-nghi/deluxe?ref=1" hreflang="ko" lang="ko" aria-current="page">한국어</a>'));
    assert.ok(!html.includes('<script'), 'không dùng JavaScript');
    assert.deepEqual(extract(html).sentences, ['Xin chào'], 'nút chọn ngôn ngữ không bị coi là nội dung cần dịch');
  });

  it('tắt được bằng languageSwitcher: false', () => {
    assert.ok(!roundTrip(page('<p>x y</p>')).html.includes('tm-lang'));
  });
});
