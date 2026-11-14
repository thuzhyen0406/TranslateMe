import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { parse as parseHtml, serialize } from 'parse5';
import {
  computeCrc32,
  countDocxStructure,
  createDocxPackage,
  type DocxSkeleton,
} from '../docx.js';
import {
  CorruptFile,
  UnsupportedFormat,
  countChars,
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

  it('bản dịch mất marker {n/} (Translate bỏ span) -> vẫn giữ phần tử translate="no" và ảnh của câu gốc', () => {
    const doc = parse('HTML', enc('<h1>Chào mừng đến với <span translate="no">Phố Cổ Homestay</span></h1>'
      + '<p>Ảnh <img src="/a.png" alt=""> và <a href="/x">liên kết</a> ở đây.</p>'));
    // Đúng đầu ra Translate thật trên dev 14/11: "Welcome to" (mất marker); câu 2 mất cả {2}{/2} lẫn {1/}.
    const { bytes, stats } = rebuildDetailed(doc.skeleton, ['Welcome to', 'Picture and link here.'], { targetLang: 'en' });
    const html = dec(bytes);
    assert.ok(html.includes('<h1>Welcome to <span translate="no">Phố Cổ Homestay</span></h1>'), html);
    assert.ok(/<p>Picture and link here <img [^>]*src="[^"]*a\.png"[^>]*>\.<\/p>/.test(html), html);
    assert.equal(stats.tagFallback, 2);
  });

  it('bản dịch lệch ký hiệu {n} -> dùng văn bản thuần, báo tagFallback', () => {
    const doc = parse('HTML', enc('<p>Xem <a href="/x">bảng giá</a> nhé.</p>'));
    const { bytes, stats } = rebuildDetailed(doc.skeleton, ['See the price list.'], { targetLang: 'en' });
    assert.ok(dec(bytes).includes('<p>See the price list.</p>'));
    assert.equal(stats.tagFallback, 1);
    assert.equal((doc.skeleton as HtmlSkeleton).format, 'HTML');
  });
});

// ============================================================================
// Kiểm thử DOCX (Nhiệm vụ 4.9 – TV4)
// ============================================================================

const SAMPLE_DOCX_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    <w:p>
      <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
      <w:r><w:rPr><w:b/></w:rPr><w:t>Homestay Sông Hàn</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t xml:space="preserve">Phòng có </w:t></w:r>
      <w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">ban </w:t></w:r>
      <w:r><w:rPr><w:b/></w:rPr><w:t>công</w:t></w:r>
      <w:r><w:t xml:space="preserve"> nhìn ra sông. Xem </w:t></w:r>
      <w:hyperlink r:id="rId5" w:history="1">
        <w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t>bảng giá</w:t></w:r>
      </w:hyperlink>
      <w:r><w:t> chi tiết.</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>Giờ nhận phòng:</w:t><w:tab/><w:t>14:00</w:t><w:br/><w:t>Giờ trả phòng: 12:00.</w:t></w:r>
    </w:p>
    <w:tbl>
      <w:tr>
        <w:tc><w:p><w:r><w:t>Loại phòng</w:t></w:r></w:p></w:tc>
        <w:tc>
          <w:p><w:r><w:t>Mô tả tiện nghi</w:t></w:r></w:p>
          <w:tbl>
            <w:tr>
              <w:tc><w:p><w:r><w:t>Bao gồm ăn sáng miễn phí.</w:t></w:r></w:p></w:tc>
            </w:tr>
          </w:tbl>
        </w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>2026</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Phòng đôi có cửa sổ lớn.</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
    <w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>
  </w:body>
</w:document>`;

describe('DOCX (4.9) – phân tích đoạn văn, bảng lồng nhau, gộp run và dựng lại', () => {
  it('parse rồi rebuild không dịch (translations = []) cho tệp DOCX tương đương và giữ nguyên tệp nhị phân khác trong gói', () => {
    const fakePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const docxBytes = createDocxPackage({
      'word/document.xml': SAMPLE_DOCX_XML,
      'word/styles.xml': '<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:styleId="Heading1"/></w:styles>',
      'word/media/image1.png': fakePng,
    });

    const doc = parse('DOCX', docxBytes);
    const sk = doc.skeleton as DocxSkeleton;
    assert.equal(sk.format, 'DOCX');
    assert.deepEqual(JSON.parse(JSON.stringify(sk)), sk, 'skeleton DOCX phải thuần JSON để ghi S3');

    // Gộp run: "ban " và "công" có cùng <w:rPr><w:b/></w:rPr> phải gộp thành {1}ban công{/1}
    // Đoạn 1 toàn bộ là chữ đậm -> chữ đậm là định dạng nền, không bọc {1} thừa
    assert.deepEqual(
      doc.blocks.map((b) => b.text),
      [
        'Homestay Sông Hàn',
        'Phòng có {1}ban công{/1} nhìn ra sông.',
        'Xem {1}bảng giá{/1} chi tiết.',
        'Giờ nhận phòng:\t14:00\nGiờ trả phòng: 12:00.',
        'Loại phòng',
        'Mô tả tiện nghi',
        'Bao gồm ăn sáng miễn phí.',
        'Phòng đôi có cửa sổ lớn.',
      ],
    );

    // Rebuild không dịch (translations = []) qua cả skeleton trực tiếp và skeleton sau JSON.parse
    const rebuiltBytes = rebuild(JSON.parse(JSON.stringify(sk)), []);
    const reparsed = parse('DOCX', rebuiltBytes);
    assert.deepEqual(reparsed.blocks, doc.blocks);
    assert.deepEqual(reparsed.warnings, doc.warnings);

    const reparsedSk = reparsed.skeleton as DocxSkeleton;
    assert.equal(reparsedSk.expectedParagraphCount, sk.expectedParagraphCount);
    assert.equal(reparsedSk.expectedTableCellCount, sk.expectedTableCellCount);

    // Kiểm tra ảnh trong gói ZIP được sao chép nguyên vẹn từng byte
    const origImg = sk.entries.find((e) => e.name === 'word/media/image1.png')!;
    const newImg = reparsedSk.entries.find((e) => e.name === 'word/media/image1.png')!;
    assert.equal(newImg.compressedBase64, origImg.compressedBase64);
    assert.equal(newImg.crc32, origImg.crc32);
  });

  it('dịch sang en và ko (Kịch bản 7): bảo toàn định dạng {n}, đích hyperlink, tab/br, số w:p & w:tc và đặt phông Đông Á', () => {
    const docxBytes = createDocxPackage({
      'word/document.xml': SAMPLE_DOCX_XML,
    });
    const doc = parse('DOCX', docxBytes);

    const enTranslations = [
      'Han River Homestay',
      'The room has a {1}balcony{/1} overlooking the river.',
      'See the {1}price list{/1} in detail.',
      'Check-in time:\t14:00\nCheck-out time: 12:00.',
      'Room type',
      'Amenities description',
      'Free breakfast included.',
      'Double room with large window.',
    ];
    const enResult = rebuildDetailed(doc.skeleton, enTranslations, { targetLang: 'en' });
    assert.deepEqual(enResult.stats, {
      sentences: 8,
      translated: 8,
      keptSource: 0,
      tagFallback: 0,
    });

    const enParsed = parse('DOCX', enResult.bytes);
    const enSk = enParsed.skeleton as DocxSkeleton;
    assert.equal(enSk.expectedParagraphCount, (doc.skeleton as DocxSkeleton).expectedParagraphCount);
    assert.equal(enSk.expectedTableCellCount, (doc.skeleton as DocxSkeleton).expectedTableCellCount);
    assert.ok(enSk.documentXml.includes('<w:hyperlink r:id="rId5" w:history="1">'));
    assert.ok(enSk.documentXml.includes('<w:tab/>'));
    assert.ok(enSk.documentXml.includes('<w:br/>'));
    assert.ok(enSk.documentXml.includes('xml:space="preserve"'));

    // Dịch sang tiếng Hàn (ko): kiểm tra gán phông Đông Á w:eastAsia="Malgun Gothic" và w:lang w:eastAsia="ko-KR"
    const koTranslations = [
      '한강 홈스테이',
      '강이 보이는 {1}발코니{/1}가 있는 객실입니다.',
      '자세한 {1}요금표{/1}를 확인하세요.',
      '체크인:\t14:00\n체크아웃: 12:00.',
      '객실 유형',
      '편의시설 설명',
      '무료 조식이 포함되어 있습니다.',
      '큰 창문이 있는 더블룸입니다.',
    ];
    const koBytes = rebuild(doc.skeleton, koTranslations, { targetLang: 'ko' });
    const koSk = parse('DOCX', koBytes).skeleton as DocxSkeleton;
    assert.equal(koSk.expectedParagraphCount, (doc.skeleton as DocxSkeleton).expectedParagraphCount);
    assert.equal(koSk.expectedTableCellCount, (doc.skeleton as DocxSkeleton).expectedTableCellCount);
    assert.ok(koSk.documentXml.includes('w:eastAsia="Malgun Gothic"'));
    assert.ok(koSk.documentXml.includes('w:eastAsia="ko-KR"'));

    // Dịch sang tiếng Nhật (ja) và tiếng Trung (zh, zh-TW)
    const jaSk = parse('DOCX', rebuild(doc.skeleton, koTranslations, { targetLang: 'ja' })).skeleton as DocxSkeleton;
    assert.ok(jaSk.documentXml.includes('w:eastAsia="MS Mincho"'));
    assert.ok(jaSk.documentXml.includes('w:eastAsia="ja-JP"'));

    const zhSk = parse('DOCX', rebuild(doc.skeleton, koTranslations, { targetLang: 'zh' })).skeleton as DocxSkeleton;
    assert.ok(zhSk.documentXml.includes('w:eastAsia="SimSun"'));
    assert.ok(zhSk.documentXml.includes('w:eastAsia="zh-CN"'));
  });

  it('khi bản dịch đảo thứ tự {1} và {2} vẫn khôi phục đúng định dạng; khi mất {1} thì fallback văn bản thuần và báo tagFallback', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
                  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <w:body>
          <w:p>
            <w:r><w:t xml:space="preserve">Đặt </w:t></w:r>
            <w:r><w:rPr><w:b/></w:rPr><w:t>phòng VIP</w:t></w:r>
            <w:r><w:t xml:space="preserve"> tại </w:t></w:r>
            <w:hyperlink r:id="rId9"><w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t>trang chủ</w:t></w:r></w:hyperlink>
            <w:r><w:t> ngay hôm nay.</w:t></w:r>
          </w:p>
        </w:body>
      </w:document>`;
    const doc = parse('DOCX', createDocxPackage({ 'word/document.xml': xml }));
    assert.deepEqual(doc.blocks.map((b) => b.text), ['Đặt {1}phòng VIP{/1} tại {2}trang chủ{/2} ngay hôm nay.']);

    // Đảo thứ tự {2} lên trước {1}
    const reorderedBytes = rebuild(doc.skeleton, ['Tại {2}homepage{/2} đặt {1}VIP room{/1} ngay.']);
    const reorderedSk = parse('DOCX', reorderedBytes).skeleton as DocxSkeleton;
    assert.ok(reorderedSk.documentXml.includes('<w:hyperlink r:id="rId9"><w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t xml:space="preserve">homepage</w:t></w:r></w:hyperlink>'));
    assert.ok(reorderedSk.documentXml.includes('<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">VIP room</w:t></w:r>'));

    // Bản dịch làm mất {/1} -> fallback văn bản thuần và tăng stats.tagFallback
    const brokenRes = rebuildDetailed(doc.skeleton, ['Book {1}VIP room at homepage today.']);
    assert.equal(brokenRes.stats.tagFallback, 1);
    const brokenSk = parse('DOCX', brokenRes.bytes).skeleton as DocxSkeleton;
    assert.ok(brokenSk.documentXml.includes('Book VIP room at homepage today.'));
  });

  it('ngoặc nhọn có thật {ten}, {1} và ký tự đặc biệt XML (&, <, >) trong DOCX được thoát và khôi phục chính xác; kiểm tra REBUILD_VERIFICATION_FAILED', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body>
          <w:p>
            <w:r><w:t xml:space="preserve">Điền {ten} &amp; {1} vào </w:t></w:r>
            <w:r><w:rPr><w:i/></w:rPr><w:t>ô &lt;A&gt;</w:t></w:r>
            <w:r><w:t>.</w:t></w:r>
          </w:p>
        </w:body>
      </w:document>`;
    const doc = parse('DOCX', createDocxPackage({ 'word/document.xml': xml }));
    assert.deepEqual(doc.blocks.map((b) => b.text), ['Điền {{ten}} & {{1}} vào {1}ô <A>{/1}.']);

    const rebuilt = rebuild(doc.skeleton, ['Fill {{name}} & {{1}} into {1}box <A>{/1}.'], { targetLang: 'en' });
    const reparsed = parse('DOCX', rebuilt);
    assert.deepEqual(reparsed.blocks.map((b) => b.text), ['Fill {{name}} & {{1}} into {1}box <A>{/1}.']);

    // Kiểm tra REBUILD_VERIFICATION_FAILED khi số w:p hoặc w:tc không khớp với expectedParagraphCount
    const tamperedSkeleton: DocxSkeleton = {
      ...(doc.skeleton as DocxSkeleton),
      expectedParagraphCount: 99,
    };
    assert.throws(
      () => rebuild(tamperedSkeleton, []),
      (e: unknown) => e instanceof CorruptFile && e.reason === 'REBUILD_VERIFICATION_FAILED',
    );
  });

  it('giữ nguyên đúng vị trí của hình ảnh (w:drawing), bookmark giữa câu và phần tử được giữ nguyên khi rebuild', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body>
          <w:p>
            <w:r><w:t xml:space="preserve">Đoạn chữ trước hình. </w:t></w:r>
            <w:r><w:drawing><w:inline id="img-mid"/></w:drawing></w:r>
            <w:r><w:t xml:space="preserve"> Đoạn chữ sau hình.</w:t></w:r>
          </w:p>
          <w:p>
            <w:r><w:t xml:space="preserve">Xem </w:t></w:r>
            <w:bookmarkStart w:id="10" w:name="bm_gia"/>
            <w:r><w:t>bảng giá</w:t></w:r>
            <w:bookmarkEnd w:id="10"/>
            <w:r><w:t xml:space="preserve"> chi tiết tại lễ tân.</w:t></w:r>
          </w:p>
        </w:body>
      </w:document>`;

    const doc = parse('DOCX', createDocxPackage({ 'word/document.xml': xml }));
    assert.deepEqual(doc.blocks.map((b) => b.text), [
      'Đoạn chữ trước hình.',
      'Đoạn chữ sau hình.',
      'Xem {1}bảng giá{/1} chi tiết tại lễ tân.',
    ]);

    const rebuiltBytes = rebuild(
      doc.skeleton,
      [
        'Text before image.',
        'Text after image.',
        'At the reception, see the detailed {1}price list{/1}.',
      ],
      { targetLang: 'en' },
    );
    const rebuiltXml = (parse('DOCX', rebuiltBytes).skeleton as DocxSkeleton).documentXml;

    // 1. Hình ảnh (w:drawing) phải nằm đúng ở giữa "Text before image." và "Text after image." (không bị đẩy xuống cuối đoạn)
    const beforeIdx = rebuiltXml.indexOf('Text before image.');
    const drawingIdx = rebuiltXml.indexOf('<w:drawing><w:inline id="img-mid"/></w:drawing>');
    const afterIdx = rebuiltXml.indexOf('Text after image.');
    assert.ok(beforeIdx >= 0 && drawingIdx > beforeIdx && afterIdx > drawingIdx, 'w:drawing phải nằm giữa hai phần văn bản');

    // 2. Bookmark phải bao quanh đúng cụm từ "price list" ở vị trí mới trong câu dịch
    assert.ok(
      rebuiltXml.includes(
        '<w:bookmarkStart w:id="10" w:name="bm_gia"/><w:r><w:t xml:space="preserve">price list</w:t></w:r><w:bookmarkEnd w:id="10"/>',
      ),
      'bookmarkStart/bookmarkEnd phải bám sát vùng văn bản mà nó đánh dấu',
    );
  });
});

describe('DOCX (4.9) – cảnh báo thành phần ngoài phạm vi theo Bảng 2.17', () => {
  it('phát hiện UNSUPPORTED_PART (header, footer, footnotes, endnotes), UNSUPPORTED_ELEMENT (drawing, txbxContent, fldSimple, oMath) và TRACKED_CHANGES (w:ins, w:del)', () => {
    const complexXml = `<?xml version="1.0" encoding="UTF-8"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
                  xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">
        <w:body>
          <w:p>
            <w:r><w:t xml:space="preserve">Giá phòng đã </w:t></w:r>
            <w:ins w:id="1" w:author="Admin"><w:r><w:t>giảm 20%</w:t></w:r></w:ins>
            <w:del w:id="2" w:author="Admin"><w:r><w:delText>tăng 10%</w:delText></w:r></w:del>
            <w:r><w:t> trong tháng này.</w:t></w:r>
          </w:p>
          <w:p>
            <w:r>
              <w:drawing>
                <w:txbxContent>
                  <w:p><w:r><w:t>Chữ trong hộp văn bản không dịch.</w:t></w:r></w:p>
                </w:txbxContent>
              </w:drawing>
            </w:r>
            <w:fldSimple w:instr="PAGE"><w:r><w:t>1</w:t></w:r></w:fldSimple>
            <m:oMath><m:r><m:t>x+y=z</m:t></m:r></m:oMath>
          </w:p>
        </w:body>
      </w:document>`;

    const docxBytes = createDocxPackage({
      'word/document.xml': complexXml,
      'word/header1.xml': '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Đầu trang</w:t></w:r></w:p></w:hdr>',
      'word/footer1.xml': '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Chân trang</w:t></w:r></w:p></w:ftr>',
      'word/footnotes.xml': '<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote w:id="1"><w:p><w:r><w:t>Chú thích 1</w:t></w:r></w:p></w:footnote></w:footnotes>',
    });

    const doc = parse('DOCX', docxBytes);

    // Chỉ câu ở đoạn 1 (gồm phần w:ins "giảm 20%", bỏ qua phần w:del "tăng 10%") được trích xuất dịch;
    // chữ trong w:txbxContent ("Chữ trong hộp văn bản không dịch.") được giữ nguyên, không đưa vào blocks
    assert.deepEqual(doc.blocks.map((b) => b.text), ['Giá phòng đã giảm 20% trong tháng này.']);

    const codes = new Set(doc.warnings.map((w) => w.code));
    assert.ok(codes.has('UNSUPPORTED_PART'), 'phải có cảnh báo UNSUPPORTED_PART');
    assert.ok(codes.has('UNSUPPORTED_ELEMENT'), 'phải có cảnh báo UNSUPPORTED_ELEMENT');
    assert.ok(codes.has('TRACKED_CHANGES'), 'phải có cảnh báo TRACKED_CHANGES');

    // Khi dựng lại, phần w:drawing/w:txbxContent vẫn còn nguyên và tổng số w:p (gồm cả w:p trong txbxContent) không đổi
    const rebuilt = rebuild(doc.skeleton, ['Room price has been reduced by 20% this month.'], { targetLang: 'en' });
    const reparsedSk = parse('DOCX', rebuilt).skeleton as DocxSkeleton;
    assert.equal(reparsedSk.expectedParagraphCount, 3);
    assert.ok(reparsedSk.documentXml.includes('Chữ trong hộp văn bản không dịch.'));
    assert.ok(!reparsedSk.documentXml.includes('tăng 10%'));
  });
});

describe('DOCX (4.9) – bảo mật chống XXE và tệp nén độc hại (ZIP bomb)', () => {
  it('chặn mẫu XXE (<!DOCTYPE / <!ENTITY) trong word/document.xml và [Content_Types].xml', () => {
    const xxeXml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE foo [
  <!ELEMENT foo ANY >
  <!ENTITY xxe SYSTEM "file:///etc/passwd" >
]>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>&xxe;</w:t></w:r></w:p></w:body>
</w:document>`;

    const xxeDocx = createDocxPackage({ 'word/document.xml': xxeXml });
    assert.throws(
      () => parse('DOCX', xxeDocx),
      (e: unknown) => e instanceof CorruptFile && e.reason === 'XXE_DETECTED',
    );

    const xxeInContentTypes = createDocxPackage({
      '[Content_Types].xml': '<?xml version="1.0"?><!DOCTYPE Types [<!ENTITY x SYSTEM "http://169.254.169.254/">]><Types/>',
      'word/document.xml': SAMPLE_DOCX_XML,
    });
    assert.throws(
      () => parse('DOCX', xxeInContentTypes),
      (e: unknown) => e instanceof CorruptFile && e.reason === 'XXE_DETECTED',
    );
  });

  it('chặn tệp nén độc hại (ZIP bomb) vượt tỷ lệ nén 100:1, kể cả khi giả mạo uncompressedSize nhỏ trong header', () => {
    // Tạo một XML lặp rất dài nén cực nhỏ (tỷ lệ nén > 200:1)
    const hugeRepeatedXml =
      '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      '<w:p><w:r><w:t>' +
      'A'.repeat(300_000) +
      '</w:t></w:r></w:p></w:body></w:document>';
    const bombDocx = createDocxPackage({ 'word/document.xml': hugeRepeatedXml });
    assert.throws(
      () => parse('DOCX', bombDocx),
      (e: unknown) => e instanceof CorruptFile && e.reason === 'ZIP_BOMB',
    );

    // Giả mạo header Central Directory: ghi uncompressedSize = 500 byte để qua mặt kiểm tra header nhưng luồng deflate thực tế bung ra 300 KB
    const spoofed = new Uint8Array(bombDocx);
    const rawBytes = enc(hugeRepeatedXml);
    const compressedLen = deflateRawSync(rawBytes).byteLength;
    assert.ok(rawBytes.byteLength / compressedLen > 100);
    // Tìm các vị trí chứa rawBytes.byteLength (300161) trong ZIP và ghi đè thành 500
    for (let i = 0; i <= spoofed.byteLength - 4; i++) {
      const val =
        (spoofed[i] | (spoofed[i + 1] << 8) | (spoofed[i + 2] << 16) | (spoofed[i + 3] << 24)) >>> 0;
      if (val === rawBytes.byteLength) {
        spoofed[i] = 500 & 0xff;
        spoofed[i + 1] = (500 >>> 8) & 0xff;
        spoofed[i + 2] = 0;
        spoofed[i + 3] = 0;
      }
    }
    assert.throws(
      () => parse('DOCX', spoofed),
      (e: unknown) => e instanceof CorruptFile && e.reason === 'ZIP_BOMB',
      'phải chặn ngay trong lúc inflate bằng maxOutputLength kể cả khi header khai gian',
    );
  });

  it('chặn gói ZIP vượt quá 2.000 mục (ZIP_TOO_MANY_ENTRIES) hoặc chứa đường dẫn ../ (Zip Slip)', () => {
    const manyFiles: Record<string, string> = { 'word/document.xml': SAMPLE_DOCX_XML };
    for (let i = 0; i < 2001; i++) {
      manyFiles[`word/extra/item_${i}.txt`] = 'x';
    }
    const tooManyEntriesZip = createDocxPackage(manyFiles, { compressionMethod: 0 });
    assert.throws(
      () => parse('DOCX', tooManyEntriesZip),
      (e: unknown) => e instanceof CorruptFile && e.reason === 'ZIP_TOO_MANY_ENTRIES',
    );

    const zipSlipDocx = createDocxPackage({
      'word/document.xml': SAMPLE_DOCX_XML,
      'word/../../etc/passwd': 'root:x:0:0',
    });
    assert.throws(
      () => parse('DOCX', zipSlipDocx),
      (e: unknown) => e instanceof CorruptFile && e.reason === 'INVALID_DOCX',
    );
  });
});

describe('parse / rebuild – giao diện chung', () => {
  it('countChars bỏ marker, chuẩn hóa NFC/khoảng trắng và đếm Unicode code point', () => {
    assert.equal(countChars('Xem {1}ba\u0309ng  gia\u0301{/1} nhé.'), Array.from('Xem bảng giá nhé.').length);
    assert.equal(countChars('  e\u0301   😀  '), 3);
    assert.equal(countChars('   '), 0);
  });

  it('định dạng lạ -> UnsupportedFormat; DOCX hỏng -> CorruptFile INVALID_DOCX', () => {
    assert.throws(() => parse('DOCX', enc('x')), (e: unknown) => e instanceof CorruptFile && e.reason === 'INVALID_DOCX');
    assert.throws(() => parse('PDF', enc('x')), (e: unknown) => e instanceof UnsupportedFormat && e.format === 'PDF');
    void computeCrc32;
    void countDocxStructure;
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
    bad({ v: 1, format: 'DOCX' });
    assert.throws(() => rebuild({ v: 1, format: 'PDF' as never }, []), UnsupportedFormat);
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

  it('phát hiện CRC32 không khớp sau khi giải nén -> CorruptFile(INVALID_DOCX)', () => {
    const pkg = createDocxPackage({ 'word/document.xml': SAMPLE_DOCX_XML });
    const corrupted = new Uint8Array(pkg);
    // Tìm Central Directory File Header (0x02014b50)
    for (let i = 0; i <= corrupted.byteLength - 46; i++) {
      if (
        corrupted[i] === 0x50 &&
        corrupted[i + 1] === 0x4b &&
        corrupted[i + 2] === 0x01 &&
        corrupted[i + 3] === 0x02
      ) {
        // CDFH found: CRC32 nằm ở offset i + 16
        corrupted[i + 16] ^= 0xff;
        break;
      }
    }
    assert.throws(
      () => parse('DOCX', corrupted),
      (e: unknown) => e instanceof CorruptFile && e.reason === 'INVALID_DOCX',
    );
  });

  it('cho phép DOCX thật chứa bảng lớn nhiều ô trống (tỷ lệ nén cao) phân tích và dựng lại thành công', () => {
    let rowsXml = '';
    for (let r = 0; r < 60; r++) {
      rowsXml += '<w:tr>';
      for (let c = 0; c < 4; c++) {
        rowsXml += '<w:tc><w:p><w:r><w:t></w:t></w:r></w:p></w:tc>';
      }
      rowsXml += '</w:tr>';
    }
    const tableXml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:body><w:p><w:r><w:t>Bảng mẫu nhiều ô</w:t></w:r></w:p>' +
      `<w:tbl>${rowsXml}</w:tbl>` +
      '</w:body></w:document>';

    const tableDocx = createDocxPackage({ 'word/document.xml': tableXml });
    const parsed = parse('DOCX', tableDocx);
    assert.equal(parsed.blocks.length, 1);
    assert.equal(parsed.blocks[0].text, 'Bảng mẫu nhiều ô');

    const rebuilt = rebuild(parsed.skeleton, ['Sample table']);
    assert.ok(rebuilt.byteLength > 0);
    const reparsed = parse('DOCX', rebuilt);
    assert.equal(reparsed.blocks[0].text, 'Sample table');
  });
});
