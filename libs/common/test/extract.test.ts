import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extract } from '../extract.js';
import { markersToSpanHtml, spanHtmlToMarkers, validateMarkers } from '../markers.js';
import { rebuild } from '../rebuild.js';
import { STUB_HTML } from '../safeFetch.stub.js';

const wrap = (body: string, head = '') => `<!DOCTYPE html><html lang="vi"><head>${head}</head><body>${body}</body></html>`;
const sentencesOf = (body: string, head = '', selectors?: string[]) =>
  extract(wrap(body, head), selectors ? { customExclusionSelectors: selectors } : undefined).sentences;

export const HOMESTAY_HTML = wrap(
  `<header><nav><a href="/">Trang chủ</a> · <a href="/phong-nghi/">Phòng nghỉ</a> · <a href="/lien-he">Liên hệ</a></nav></header>
<main>
  <h1>Homestay ABC – Hội An</h1>
  <p>Chào mừng quý khách đến với <strong>Homestay ABC</strong>. Chúng tôi nằm cạnh <a href="/ban-do" title="Xem bản đồ">phố cổ Hội An</a>, chỉ 5 phút đi bộ.</p>
  <p>Giá chỉ từ <span class="price">450.000đ</span>/đêm, đã gồm bữa sáng <em>cao lầu</em>!</p>
  <p><strong>Ưu đãi mùa hè: giảm 30% cho khách đặt sớm.</strong></p>
  <ul>
    <li><a href="/phong/deluxe"><i class="fa fa-bed"></i> Phòng Deluxe</a></li>
    <li>Wi-Fi miễn phí<br>Bãi đỗ xe riêng</li>
  </ul>
  <img src="/img/san-vuon.jpg" alt="Sân vườn xanh mát" title="Sân vườn">
  <p>Dùng mã <code>HE2026</code> khi thanh toán. Mẫu {ten} được giữ nguyên.</p>
  <form action="/dat-phong" method="post">
    <input name="email" placeholder="Email của bạn" aria-label="Địa chỉ email">
    <input type="submit" value="Đặt phòng ngay">
    <select name="room"><option>Phòng đôi</option></select>
  </form>
  <div class="notranslate">Homestay ABC™</div>
  <p translate="no">Không dịch đoạn này.</p>
  <p>2026</p>
</main>
<footer class="site-footer"><p class="legal">Bản quyền thuộc Homestay ABC.</p><p>Hotline: 0905 123 456</p></footer>`,
  `<meta charset="utf-8"><title>Homestay ABC | Phòng đẹp ở Hội An</title>
<meta name="description" content="Homestay gần phố cổ, giá tốt.">
<meta name="viewport" content="width=device-width">
<meta property="og:title" content="Homestay ABC">`,
);

describe('extract – trang stub của safe_fetch', () => {
  const r = extract(STUB_HTML);

  it('tách đúng danh sách câu, menu liên kết thành từng câu riêng', () => {
    assert.deepEqual(r.sentences, [
      'TranslateMe stub page',
      'A fixed page returned by the safe_fetch stub.',
      'Home',
      'About us',
      'External',
      'Welcome to our website',
      'This is a {1}sample paragraph{/1} with {2}an inline link{/2} inside it.',
      'Prices start at $9.99 per month.',
      'Contact us at hello@example.com.',
      'Fast delivery',
      'Friendly support',
      'Secure payments',
      'Company logo',
      '© 2026 Example Inc.',
      'All rights reserved.',
    ]);
  });

  it('giữ nguyên script, pre/code, .notranslate; thẻ gốc nằm trong placeholders', () => {
    assert.ok(r.skeletonHtml.includes('<script>console.log("scripts must not be translated");</script>'));
    assert.ok(r.skeletonHtml.includes('<pre><code>const x = 1; // code must stay untouched</code></pre>'));
    assert.ok(r.skeletonHtml.includes('<div class="notranslate">BrandName™ should not be translated.</div>'));
    assert.ok(r.skeletonHtml.includes('<a href="/">'), 'liên kết menu giữ trong khung');
    assert.equal(r.placeholders['t:6:1'], '<strong>');
    assert.equal(r.placeholders['t:6:2'], '<a href="/docs">');
    assert.equal(r.placeholders['s:6'], r.sentences[6]);
  });
});

describe('extract – trang mẫu tiếng Việt', () => {
  const r = extract(HOMESTAY_HTML, { customExclusionSelectors: ['.site-footer .legal'] });
  const s = r.sentences;

  it('đủ câu trong nội dung, tiêu đề, meta và thuộc tính', () => {
    for (const expected of [
      'Homestay ABC | Phòng đẹp ở Hội An',
      'Homestay gần phố cổ, giá tốt.',
      'Trang chủ',
      'Phòng nghỉ',
      'Liên hệ',
      'Homestay ABC – Hội An',
      'Chào mừng quý khách đến với {1}Homestay ABC{/1}.',
      'Chúng tôi nằm cạnh {1}phố cổ Hội An{/1}, chỉ 5 phút đi bộ.',
      'Giá chỉ từ {1}450.000đ{/1}/đêm, đã gồm bữa sáng {2}cao lầu{/2}!',
      'Ưu đãi mùa hè: giảm 30% cho khách đặt sớm.',
      '{1/} Phòng Deluxe',
      'Wi-Fi miễn phí',
      'Bãi đỗ xe riêng',
      'Sân vườn xanh mát',
      'Sân vườn',
      'Xem bản đồ',
      'Dùng mã {1/} khi thanh toán.',
      'Mẫu {{ten}} được giữ nguyên.',
      'Email của bạn',
      'Địa chỉ email',
      'Đặt phòng ngay',
      'Phòng đôi',
      'Hotline: 0905 123 456',
    ]) {
      assert.ok(s.includes(expected), `thiếu câu: ${expected}`);
    }
  });

  it('không lấy vùng không dịch, số thuần, meta không phải mô tả', () => {
    for (const bad of ['Homestay ABC™', 'Không dịch đoạn này.', '2026', 'Bản quyền thuộc Homestay ABC.', 'width=device-width']) {
      assert.ok(!s.some((x) => x.includes(bad)), `không được lấy: ${bad}`);
    }
    assert.ok(r.skeletonHtml.includes('<p class="legal">Bản quyền thuộc Homestay ABC.</p>'));
    assert.ok(r.skeletonHtml.includes('<p>2026</p>'));
  });

  it('thẻ bao trọn câu nằm trong khung, không thành marker', () => {
    assert.ok(r.skeletonHtml.includes('<p><strong>TMS'));
  });

  it('phần tử giữ nguyên giữa câu mang đủ HTML gốc', () => {
    const iCode = s.indexOf('Dùng mã {1/} khi thanh toán.');
    assert.equal(r.placeholders[`t:${iCode}:1`], '<code>HE2026</code>');
    const iIcon = s.indexOf('{1/} Phòng Deluxe');
    assert.equal(r.placeholders[`t:${iIcon}:1`], '<i class="fa fa-bed"></i>');
  });

  it('mọi câu có marker hợp lệ, đánh số từ 1, đi qua span HTML hai chiều', () => {
    for (const x of s) {
      const v = validateMarkers(x);
      assert.equal(v.ok, true, x);
      v.ids.forEach((id, k) => assert.equal(id, String(k + 1), x));
      assert.equal(spanHtmlToMarkers(markersToSpanHtml(x)).text, x);
    }
  });

  it('dịch "nguyên văn" rồi extract lại cho đúng bộ câu cũ', () => {
    const html = rebuild(r.skeletonHtml, s, r.placeholders, {
      targetLang: 'en',
      originalUrl: 'https://homestay-abc.vn/',
      slug: 'abc',
      languageSwitcher: false,
    });
    const again = extract(html, { customExclusionSelectors: ['.site-footer .legal'] }).sentences;
    assert.deepEqual(again, s);
  });
});

describe('extract – quy tắc chi tiết', () => {
  it('<select>: chữ của <option> và label của <option>/<optgroup> là câu riêng; value giữ nguyên (5.4)', () => {
    const html = wrap('<form><label for="r">Loại phòng</label> <select id="r" name="r"><optgroup label="Nhóm phòng nhỏ"><option value="doi">Phòng đôi</option><option value="don" label="Phòng một người"></option></optgroup><option value="">  </option></select> <button>Gửi</button></form>');
    const r = extract(html);
    assert.deepEqual(r.sentences, ['Loại phòng', 'Nhóm phòng nhỏ', 'Phòng đôi', 'Phòng một người', 'Gửi']);
    const out = rebuild(r.skeletonHtml, r.sentences.map((x) => `EN ${x}`), r.placeholders, { targetLang: 'en', originalUrl: 'https://a.vn/', slug: 'a' });
    assert.ok(out.includes('<option value="doi">EN Phòng đôi</option>'), out);
    assert.ok(out.includes('<optgroup label="EN Nhóm phòng nhỏ">'));
    assert.ok(out.includes('<option value="don" label="EN Phòng một người"></option>'));
    assert.ok(out.includes('<option value="">'));
  });

  it('gộp khoảng trắng trong câu', () => {
    assert.deepEqual(sentencesOf('<p>Xin\n      chào   bạn.</p>'), ['Xin chào bạn.']);
  });

  it('<br> và phần tử khối ngắt đoạn; khối nằm trong thẻ nội tuyến', () => {
    assert.deepEqual(sentencesOf('<p>Dòng một<br>Dòng hai</p>'), ['Dòng một', 'Dòng hai']);
    assert.deepEqual(sentencesOf('<div>Trước <b>đậm</b><p>Đoạn</p> sau</div>'), ['Trước {1}đậm{/1}', 'Đoạn', 'sau']);
    assert.deepEqual(sentencesOf('<a href="/"><div>Khối trong liên kết</div></a>'), ['Khối trong liên kết']);
  });

  it('thẻ lồng nhau và cặp thẻ vắt qua hai câu', () => {
    assert.deepEqual(sentencesOf('<p>Nhấn <a href="/x"><b>Đặt</b> chỗ</a> ngay. Xong.</p>'), ['Nhấn {1}{2}Đặt{/2} chỗ{/1} ngay.', 'Xong.']);
    assert.deepEqual(sentencesOf('<p><em>Câu một. Câu hai.</em> Câu ba.</p>'), ['{1}Câu một. Câu hai.{/1}', 'Câu ba.']);
  });

  it('mỗi câu đánh số marker riêng từ 1', () => {
    const r = extract(wrap('<p>A <b>b</b>. C <i>d</i>.</p>'));
    assert.deepEqual(r.sentences, ['A {1}b{/1}.', 'C {1}d{/1}.']);
    assert.equal(r.placeholders['t:0:1'], '<b>');
    assert.equal(r.placeholders['t:1:1'], '<i>');
  });

  it('span .notranslate / translate="no" giữa câu thành {n/}', () => {
    const r = extract(wrap('<p>Liên hệ <span class="notranslate">ACME Corp</span> hoặc <b translate="no">X</b> nhé.</p>'));
    assert.deepEqual(r.sentences, ['Liên hệ {1/} hoặc {2/} nhé.']);
    assert.equal(r.placeholders['t:0:1'], '<span class="notranslate">ACME Corp</span>');
  });

  it('customExclusionSelectors: tag, #id, .class, [attr], >, con cháu; selector lỗi bị bỏ qua', () => {
    const body = '<div id="a"><p>Một</p></div><p class="x y">Hai</p><p data-k="v">Ba</p><section><p>Bốn</p></section><div><p>Năm</p></div><p>Sáu</p>';
    assert.deepEqual(sentencesOf(body, '', ['#a', 'p.x.y', '[data-k=v]', 'section > p', 'div p']), ['Sáu']);
    assert.deepEqual(sentencesOf(body, '', [':not(p)', 'p::after', '>']), ['Một', 'Hai', 'Ba', 'Bốn', 'Năm', 'Sáu']);
    assert.deepEqual(sentencesOf('<p>Một</p><p data-k="vv">Hai</p>', '', ['[data-k^=v]']), ['Một']);
  });

  it('alt của ảnh nằm trong liên kết hoặc <picture> vẫn được dịch', () => {
    const r = extract(wrap('<a href="/"><img src="logo.png" alt="Logo công ty"></a><picture><source srcset="a.webp"><img src="a.jpg" alt="Phòng ngủ"></picture>'));
    assert.deepEqual(r.sentences, ['Logo công ty', 'Phòng ngủ']);
  });

  it('trang lớn (3.000 đoạn) xử lý nhanh', () => {
    const body = Array.from({ length: 3000 }, (_, i) => `<div><p>Đoạn ${i} có <a href="/p/${i}">liên kết <b>đậm</b></a>. Câu thứ hai ở đây!</p></div>`).join('');
    const started = Date.now();
    const r = extract(wrap(body));
    const html = rebuild(r.skeletonHtml, r.sentences, r.placeholders, { targetLang: 'en', originalUrl: 'https://a.vn/', slug: 'a' });
    assert.equal(r.sentences.length, 6000);
    assert.ok(html.includes('<a href="/a/en/p/2999">'));
    assert.ok(Date.now() - started < 5000, `${Date.now() - started} ms`);
  });

  it('không có chữ thì không tạo câu; trang rỗng không lỗi', () => {
    assert.deepEqual(sentencesOf('<p>2026 – 100%</p><p> </p><p><img src="a.png"></p>'), []);
    assert.deepEqual(extract('').sentences, []);
    assert.deepEqual(extract('Chỉ có chữ').sentences, ['Chỉ có chữ']);
  });

  it('khung giữ nguyên comment ngoài câu và doctype', () => {
    const r = extract('<!DOCTYPE html><html><body><!-- ghi chú --><p>Xin chào</p></body></html>');
    assert.ok(r.skeletonHtml.startsWith('<!DOCTYPE html>'));
    assert.ok(r.skeletonHtml.includes('<!-- ghi chú -->'));
  });
});
