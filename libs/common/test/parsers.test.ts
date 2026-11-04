import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parse as parseHtml, serialize } from 'parse5';
import {
  CorruptFile,
  UnsupportedFormat,
  formatFromFileName,
  parse,
  rebuild,
  rebuildDetailed,
  translatedFileName,
  type HtmlSkeleton,
  type TxtSkeleton,
} from '../parsers.js';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(b);
/** "Dịch" giả: viết HOA phần chữ, giữ nguyên ký hiệu {n} */
const upper = (t: string) => t.replace(/(\{\/?\d+\/?\})|([^{}]+)/g, (_a, m: string | undefined, x: string | undefined) => m ?? (x ?? '').toUpperCase());

describe('TXT – parse rồi rebuild không dịch cho tệp trùng từng byte', () => {
  const samples: Array<[string, string]> = [
    ['trống', ''],
    ['một dòng', 'Xin chào.'],
    ['nhiều câu, khoảng trắng đầu cuối', '  Phòng có ban công.   Giá 1.250.000đ/đêm!  '],
    ['CRLF, CR, LF lẫn nhau và dòng trống', 'Dòng một.\r\n\r\nDòng hai. Câu hai.\rDòng ba\n\n\nHết.\n'],
    ['tab, chỉ số, ký hiệu', '\tMục 1\n12345\n---\n* Ghi chú: xem bên dưới.'],
    ['ngoặc nhọn và chuỗi giống ký hiệu', 'Mẫu {ten} và {1} và {/1} và {{x}}. Hết }'],
    ['emoji, CJK, tiếng Việt NFD', 'Chào 👋 bạn. 東京は大きい。ここです。 Tiếng Việt.'],
  ];
  for (const [name, text] of samples) {
    it(name, () => {
      for (const bytes of [enc(text), enc('﻿' + text)]) {
        const doc = parse('TXT', bytes);
        assert.deepEqual(rebuild(doc.skeleton, []), bytes);
        assert.deepEqual(rebuild(JSON.parse(JSON.stringify(doc.skeleton)), []), bytes, 'skeleton qua JSON (S3) vẫn dựng lại được');
      }
    });
  }

  it('kiểm thử thuộc tính: 300 chuỗi ngẫu nhiên đều trùng từng byte sau parse–rebuild', () => {
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const alphabet = ['a', 'B', 'ệ', ' ', ' ', '  ', '.', '!', '?', '…', '\n', '\r\n', '\r', '\t', '{', '}', '{1}', '{/1}', '1', ',', 'Mr.', '。', '😀', '"'];
    for (let k = 0; k < 300; k++) {
      const n = Math.floor(rand() * 60);
      const text = Array.from({ length: n }, () => alphabet[Math.floor(rand() * alphabet.length)]).join('');
      const bytes = enc(text);
      assert.deepEqual(dec(rebuild(parse('TXT', bytes).skeleton, [])), text, JSON.stringify(text));
    }
  });
});

describe('TXT – câu và bản dịch', () => {
  it('tách theo dòng rồi theo câu; dòng chỉ có số hoặc ký hiệu không gửi dịch', () => {
    const doc = parse('TXT', enc('Xin chào. Phòng có ban công!\n\n2026\n- Liên hệ: 0905 123 456\n'));
    assert.deepEqual(doc.blocks.map((b) => b.text), ['Xin chào.', 'Phòng có ban công!', '- Liên hệ: 0905 123 456']);
    assert.deepEqual(doc.blocks.map((b) => b.id), [0, 1, 2]);
    assert.deepEqual(doc.warnings, []);
  });

  it('ngoặc nhọn có thật được thoát thành {{ }} để không thành ký hiệu, rồi trả lại nguyên dạng', () => {
    const doc = parse('TXT', enc('Điền {ten} vào {1} ô.'));
    assert.deepEqual(doc.blocks.map((b) => b.text), ['Điền {{ten}} vào {{1}} ô.']);
    assert.equal(dec(rebuild(doc.skeleton, doc.blocks.map((b) => upper(b.text)))), 'ĐIỀN {TEN} VÀO {1} Ô.');
  });

  it('ráp bản dịch giữ đúng khoảng trắng và xuống dòng gốc; thiếu bản dịch thì giữ câu gốc', () => {
    const text = '  Câu một.   Câu hai.\r\n\r\nCâu ba.\n';
    const doc = parse('TXT', enc('﻿' + text));
    const tr = doc.blocks.map((b) => upper(b.text));
    tr[1] = '';
    const { bytes, stats } = rebuildDetailed(doc.skeleton, tr);
    assert.equal(dec(bytes), '﻿  CÂU MỘT.   Câu hai.\r\n\r\nCÂU BA.\n');
    assert.deepEqual(stats, { sentences: 3, translated: 2, keptSource: 1, tagFallback: 0 });
  });

  it('skeleton chỉ gồm dữ liệu JSON', () => {
    const sk = parse('TXT', enc('A b. C d.')).skeleton as TxtSkeleton;
    assert.deepEqual(JSON.parse(JSON.stringify(sk)), sk);
    assert.equal(sk.format, 'TXT');
  });
});

describe('HTML – dùng lại extract của F2, bỏ việc riêng của website', () => {
  const page = `<!DOCTYPE html><html lang="vi"><head><meta charset="utf-8"><title>Giới thiệu</title>
<link rel="stylesheet" href="/css/a.css"><script>var x = "Không dịch";</script></head>
<body><!-- ghi chú -->
<h1>Chào mừng</h1>
<p>Phòng có <strong>ban công</strong> nhìn ra sông. Xem <a href="/bang-gia">bảng giá</a> nhé.</p>
<img src="/img/a.jpg" alt="Sân vườn"><pre>giữ   nguyên</pre>
</body></html>`;

  it('parse rồi rebuild không dịch cho cùng cây DOM', () => {
    const doc = parse('HTML', enc(page));
    assert.equal(dec(rebuild(doc.skeleton, [])), serialize(parseHtml(page)));
    assert.equal(dec(rebuild(JSON.parse(JSON.stringify(doc.skeleton)), [])), serialize(parseHtml(page)));
  });

  it('câu gồm cả thuộc tính (alt, title), thẻ nội tuyến thành {n}; script và pre không dịch', () => {
    const doc = parse('HTML', enc(page));
    const texts = doc.blocks.map((b) => b.text);
    assert.ok(texts.includes('Chào mừng'));
    assert.ok(texts.includes('Sân vườn'));
    assert.ok(texts.some((t) => t.includes('{1}ban công{/1}')));
    assert.ok(!texts.some((t) => t.includes('Không dịch') || t.includes('giữ')));
  });

  it('bản dịch: đặt <html lang>; không viết lại liên kết, không canonical, hreflang hay nút chọn ngôn ngữ', () => {
    const doc = parse('HTML', enc(page));
    const html = dec(rebuild(doc.skeleton, doc.blocks.map((b) => upper(b.text)), { targetLang: 'en' }));
    assert.ok(html.includes('<html lang="en">'));
    assert.ok(html.includes('<h1>CHÀO MỪNG</h1>'));
    assert.ok(html.includes('<strong>BAN CÔNG</strong>'));
    assert.ok(html.includes('href="/bang-gia"'), 'liên kết giữ nguyên');
    assert.ok(html.includes('href="/css/a.css"'));
    assert.ok(html.includes('alt="SÂN VƯỜN"'));
    assert.ok(!/canonical|hreflang|tm-lang/.test(html));
    assert.ok(html.includes('var x = "Không dịch"'));
  });

  it('ngôn ngữ RTL đặt dir="rtl"; tệp có BOM vẫn đọc được', () => {
    const doc = parse('HTML', enc('﻿<html><body><p>Xin chào.</p></body></html>'));
    const html = dec(rebuild(doc.skeleton, ['مرحبا'], { targetLang: 'ar' }));
    assert.ok(html.includes('<html lang="ar" dir="rtl">'));
    assert.ok(html.includes('<p>مرحبا</p>'));
  });

  it('bản dịch lệch ký hiệu {n} -> dùng văn bản thuần, báo tagFallback', () => {
    const doc = parse('HTML', enc('<p>Xem <a href="/x">bảng giá</a> nhé.</p>'));
    const { bytes, stats } = rebuildDetailed(doc.skeleton, ['See the price list.'], { targetLang: 'en' });
    assert.ok(dec(bytes).includes('<p>See the price list.</p>'));
    assert.equal(stats.tagFallback, 1);
    assert.equal((doc.skeleton as HtmlSkeleton).format, 'HTML');
  });
});

describe('parse / rebuild – giao diện chung', () => {
  it('DOCX chưa cắm vào (4.9) và định dạng lạ -> UnsupportedFormat', () => {
    assert.throws(() => parse('DOCX', enc('x')), UnsupportedFormat);
    assert.throws(() => parse('PDF', enc('x')), (e: unknown) => e instanceof UnsupportedFormat && e.format === 'PDF');
  });

  it('không phải UTF-8 -> CorruptFile NOT_UTF8; quá kích thước -> TOO_LARGE', () => {
    const latin1 = new Uint8Array([0x43, 0x68, 0xe0, 0x6f]);
    assert.throws(() => parse('TXT', latin1), (e: unknown) => e instanceof CorruptFile && e.reason === 'NOT_UTF8');
    assert.throws(() => parse('HTML', latin1), (e: unknown) => e instanceof CorruptFile && e.reason === 'NOT_UTF8');
    assert.throws(() => parse('TXT', enc('a'.repeat(11)), { maxBytes: 10 }), (e: unknown) => e instanceof CorruptFile && e.reason === 'TOO_LARGE');
  });

  it('skeleton hỏng -> CorruptFile INVALID_SKELETON', () => {
    const bad = (sk: unknown) => assert.throws(() => rebuild(sk as never, []), (e: unknown) => e instanceof CorruptFile && e.reason === 'INVALID_SKELETON');
    bad(null);
    bad({ v: 1, format: 'TXT', bom: false, parts: [0] });
    bad({ v: 1, format: 'TXT', bom: false, parts: [3], sources: ['a'] });
    bad({ v: 1, format: 'HTML', skeletonHtml: 1, placeholders: {} });
    bad({ v: 2, format: 'TXT', bom: false, parts: [], sources: [] });
    assert.throws(() => rebuild({ v: 1, format: 'DOCX' }, []), UnsupportedFormat);
  });

  it('định dạng theo tên tệp và tên tệp kết quả tên-gốc.lang.đuôi', () => {
    assert.equal(formatFromFileName('a.TXT'), 'TXT');
    assert.equal(formatFromFileName('trang.htm'), 'HTML');
    assert.equal(formatFromFileName('gioi-thieu.docx'), 'DOCX');
    assert.equal(formatFromFileName('anh.png'), null);
    assert.equal(formatFromFileName('khong-duoi'), null);
    assert.equal(translatedFileName('gioi-thieu-homestay.docx', 'en'), 'gioi-thieu-homestay.en.docx');
    assert.equal(translatedFileName('ban.v2.txt', 'ko'), 'ban.v2.ko.txt');
    assert.equal(translatedFileName('khong-duoi', 'ja'), 'khong-duoi.ja');
  });
});
