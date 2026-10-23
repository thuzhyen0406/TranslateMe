import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { check_markers, inspectSpanTags } from '../experiments/analyzers.js';
import { MARKER_SAMPLE_SENTENCES, SPAN_SAMPLE_SENTENCES } from '../experiments/sampleData.js';
import {
  MARKER_LOSS_THRESHOLD,
  compareMarkers,
  decodeHtmlEntities,
  escapeMarkerText,
  markersToSpanHtml,
  measureMarkerIntegrity,
  remapMarkerIds,
  renumberMarkers,
  restoreInlineHtml,
  spanHtmlToMarkers,
  stripMarkers,
  tokenizeMarkers,
  validateMarkers,
} from '../markers.js';

describe('tokenizeMarkers / escape', () => {
  it('tách marker mở, đóng, rỗng và văn bản', () => {
    assert.deepEqual(tokenizeMarkers('A {1}b{/1} c{2/}.'), [
      { type: 'text', value: 'A ' },
      { type: 'open', id: '1' },
      { type: 'text', value: 'b' },
      { type: 'close', id: '1' },
      { type: 'text', value: ' c' },
      { type: 'void', id: '2' },
      { type: 'text', value: '.' },
    ]);
  });

  it('ngoặc nhọn có thật trong văn bản không bị nhầm thành marker', () => {
    const plain = 'Dùng {1} và {/1} trong template {name}';
    const text = escapeMarkerText(plain);
    assert.equal(validateMarkers(text).ids.length, 0);
    assert.equal(stripMarkers(text), plain);
  });

  it('dạng lạ {0}, { 1 }, {/1/}, {a} được coi là văn bản', () => {
    for (const s of ['{0}', '{ 1 }', '{/1/}', '{a}', '{', '}']) {
      assert.deepEqual(tokenizeMarkers(s), [{ type: 'text', value: s }], s);
    }
  });
});

describe('validateMarkers', () => {
  it('toàn bộ câu mẫu M01–M06 hợp lệ', () => {
    for (const s of MARKER_SAMPLE_SENTENCES) assert.equal(validateMarkers(s.textWithMarkers).ok, true, s.id);
  });

  it('phát hiện đóng thừa, đóng lệch, thiếu đóng, trùng id', () => {
    const codes = (t: string) => validateMarkers(t).errors.map((e) => `${e.code}:${e.id}`);
    assert.deepEqual(codes('a{/1}'), ['UNMATCHED_CLOSE:1']);
    assert.deepEqual(codes('{1}a{2}b{/1}c{/2}'), ['MISMATCHED_CLOSE:1', 'UNMATCHED_CLOSE:2']);
    assert.deepEqual(codes('{1}a'), ['UNCLOSED_OPEN:1']);
    assert.deepEqual(codes('{1}a{/1}{1}b{/1}'), ['DUPLICATE_ID:1']);
  });
});

describe('renumberMarkers / remapMarkerIds', () => {
  it('đánh số lại từ 1 theo thứ tự xuất hiện và trả bảng tra ngược', () => {
    const r = renumberMarkers('{7}a{/7} {3}b{4/}{/3}');
    assert.equal(r.text, '{1}a{/1} {2}b{3/}{/2}');
    assert.deepEqual(r.idMap, { '1': '7', '2': '3', '3': '4' });
  });

  it('remap giữ nguyên văn bản có ngoặc nhọn thoát', () => {
    assert.equal(remapMarkerIds('{{x}} {1}a{/1}', { '1': '9' }), '{{x}} {9}a{/9}');
  });
});

describe('markersToSpanHtml <-> spanHtmlToMarkers', () => {
  it('M01 sinh đúng HTML của mẫu S01 (bộ thử nghiệm 1.12)', () => {
    assert.equal(markersToSpanHtml(MARKER_SAMPLE_SENTENCES[0].textWithMarkers), SPAN_SAMPLE_SENTENCES[0].taggedHtml);
  });

  it('S01–S12: HTML -> marker -> HTML không đổi, khớp inspectSpanTags', () => {
    for (const s of SPAN_SAMPLE_SENTENCES) {
      const parsed = spanHtmlToMarkers(s.taggedHtml);
      assert.equal(parsed.ok, true, `${s.id}: ${parsed.problems.join(',')}`);
      const html = markersToSpanHtml(parsed.text);
      assert.equal(html, s.taggedHtml, s.id);
      assert.equal(inspectSpanTags(s.taggedHtml, html).tagsIntact, true, s.id);
    }
  });

  it('M01–M06: marker -> HTML -> marker không đổi, check_markers báo sống sót', () => {
    for (const s of MARKER_SAMPLE_SENTENCES) {
      const back = spanHtmlToMarkers(markersToSpanHtml(s.textWithMarkers));
      assert.equal(back.text, s.textWithMarkers, s.id);
      assert.equal(check_markers(s.textWithMarkers, back.text).survived, true, s.id);
    }
  });

  it('escape & < > và giữ ngoặc nhọn có thật', () => {
    const text = `${escapeMarkerText('a < b & {x}')} {1}c > d{/1}`;
    const html = markersToSpanHtml(text);
    assert.equal(html, 'a &lt; b &amp; {x} <span data-i="1">c &gt; d</span>');
    assert.equal(spanHtmlToMarkers(html).text, text);
  });

  it('phần tử rỗng {n/} đi được hai chiều', () => {
    const html = markersToSpanHtml('Logo {1/} đây.');
    assert.equal(html, 'Logo <span data-i="1" data-v></span> đây.');
    assert.equal(spanHtmlToMarkers(html).text, 'Logo {1/} đây.');
  });

  it('chịu được đầu ra kiểu Translate: đảo thứ tự, nháy đơn, thuộc tính thừa, entity, khoảng trắng', () => {
    const out = "The <span lang='en' data-i='2' >airport shuttle</span> and <span data-i = \"1\">breakfast</span>&nbsp;&#8212; &quot;ok&quot;";
    const r = spanHtmlToMarkers(out);
    assert.equal(r.ok, true, r.problems.join(','));
    assert.equal(r.text, 'The {2}airport shuttle{/2} and {1}breakfast{/1} — "ok"');
  });

  it('báo lỗi khi mất thẻ đóng, span lạ, thẻ lạ', () => {
    assert.deepEqual(spanHtmlToMarkers('<span data-i="1">a').problems, ['UNCLOSED_SPAN:1', 'UNCLOSED_OPEN:1']);
    const r = spanHtmlToMarkers('<span>a</span> <b>b</b> <span data-i="x">c</span>');
    assert.equal(r.ok, false);
    assert.equal(r.text, 'a b c');
    assert.deepEqual(r.problems, ['SPAN_WITHOUT_DATA_I', 'UNEXPECTED_TAG:b', 'UNEXPECTED_TAG:b', 'BAD_DATA_I:x']);
    assert.deepEqual(spanHtmlToMarkers('a</span>').problems, ['UNMATCHED_SPAN_CLOSE']);
  });

  it('giải mã entity lạ hoặc sai thì giữ nguyên', () => {
    assert.equal(decodeHtmlEntities('&foo; &#xD800; &#65; &AMP;'), '&foo; &#xD800; A &');
  });
});

describe('compareMarkers', () => {
  const src = 'Giá gồm {1}bữa sáng{/1} và {2}xe {3}đưa đón{/3}{/2}.';

  it('đảo thứ tự (ko/ja) vẫn ok', () => {
    const c = compareMarkers(src, '{2}{3}送迎{/3}バス{/2}と{1}朝食{/1}込み。');
    assert.equal(c.ok, true);
    assert.equal(c.reordered, true);
  });

  it('mất marker -> missing, không khôi phục được', () => {
    const c = compareMarkers(src, 'Includes {1}breakfast{/1} and shuttle.');
    assert.equal(c.restorable, false);
    assert.deepEqual(c.missing.sort(), ['{/2}', '{/3}', '{2}', '{3}']);
  });

  it('thừa marker và marker biến dạng', () => {
    assert.deepEqual(compareMarkers('{1}a{/1}', '{1}a{/1}{1}b{/1}').extra, ['{1}', '{/1}']);
    const c = compareMarkers('{1}a{/1}', '{ 1 }a{/1}');
    assert.equal(c.ok, false);
    assert.equal(c.structureValid, false);
  });

  it('lồng nhau bị tách rời hoặc cặp bị rỗng -> lệch vị trí (ok = false, vẫn restorable)', () => {
    const nested = compareMarkers(src, 'Includes {1}breakfast{/1} and {2}shuttle{/2}{3}pickup{/3}.');
    assert.equal(nested.restorable, true);
    assert.equal(nested.ok, false);
    assert.deepEqual(nested.nestingChanged, ['3']);
    const empty = compareMarkers('{1}a{/1} b', '{1}{/1} a b');
    assert.deepEqual(empty.emptied, ['1']);
    assert.equal(empty.ok, false);
  });
});

describe('measureMarkerIntegrity', () => {
  it('tính tỷ lệ câu hỏng so với ngưỡng 5%', () => {
    assert.equal(MARKER_LOSS_THRESHOLD, 0.05);
    const good = Array.from({ length: 19 }, () => ({ source: '{1}a{/1}', translated: '{1}b{/1}' }));
    const r1 = measureMarkerIntegrity([...good, { source: '{1}a{/1}', translated: 'b' }]);
    assert.equal(r1.rate, 0.05);
    assert.equal(r1.exceedsThreshold, false);
    assert.deepEqual(r1.brokenIndexes, [19]);
    const r2 = measureMarkerIntegrity([...good.slice(0, 18), { source: '{1}a{/1}', translated: 'b' }, { source: '{1}a{/1}', translated: '{1}b' }]);
    assert.equal(r2.broken, 2);
    assert.equal(r2.exceedsThreshold, true);
    assert.equal(measureMarkerIntegrity([]).rate, 0);
  });
});

describe('restoreInlineHtml', () => {
  const tags = { '1': '<a href="/docs?a=1&amp;b=2">', '2': '<strong class="x">', '3': '<img src="/i.png" alt="">' };

  it('khôi phục theo id, không theo thứ tự', () => {
    const r = restoreInlineHtml('{2}価格{/2}は{1}こちら{/1}{3/}', tags);
    assert.equal(r.ok, true);
    assert.equal(r.html, '<strong class="x">価格</strong>は<a href="/docs?a=1&amp;b=2">こちら</a><img src="/i.png" alt="">');
  });

  it('escape văn bản dịch, giải thoát ngoặc nhọn', () => {
    assert.equal(restoreInlineHtml('a < {{b}} {1}c{/1}', tags).html, 'a &lt; {b} <a href="/docs?a=1&amp;b=2">c</a>');
  });

  it('thiếu thẻ gốc: giữ nội dung, báo missingIds', () => {
    const r = restoreInlineHtml('{9}x{/9} {1}y{/1}', tags);
    assert.equal(r.ok, false);
    assert.deepEqual(r.missingIds, ['9']);
    assert.equal(r.html, 'x <a href="/docs?a=1&amp;b=2">y</a>');
  });

  it('cấu trúc hỏng: fallback văn bản thuần, không sinh HTML vỡ', () => {
    const r = restoreInlineHtml('{1}a{2}b{/1}c{/2} <x>', tags);
    assert.equal(r.usedFallback, true);
    assert.equal(r.html, 'abc &lt;x&gt;');
  });

  it('thẻ void dùng làm marker cặp không sinh thẻ đóng', () => {
    assert.equal(restoreInlineHtml('{1}a{/1}', { '1': '<br>' }).html, '<br>a');
  });

  it('{n/} trỏ tới phần tử thường rỗng (icon <i>) vẫn được đóng thẻ', () => {
    assert.equal(restoreInlineHtml('x{1/}y', { '1': '<i class="fa">' }).html, 'x<i class="fa"></i>y');
  });

  it('{n/} mang HTML đầy đủ của phần tử được chèn nguyên văn, không đóng thẻ thừa', () => {
    const tags = { '1': '<code>npm test</code>', '2': '<i class="fa"></i>', '3': '<svg viewBox="0 0 1 1"><path d="M0"></path></svg>' };
    assert.equal(restoreInlineHtml('a{1/}b{2/}c{3/}', tags).html, `a${tags['1']}b${tags['2']}c${tags['3']}`);
  });
});

describe('hiệu năng với đầu vào xấu', () => {
  it('thẻ hỏng thiếu ">" lặp nhiều lần vẫn xử lý tuyến tính', () => {
    const started = Date.now();
    const r = spanHtmlToMarkers('<a '.repeat(50_000));
    assert.equal(r.text.length, 150_000);
    assert.ok(Date.now() - started < 2000);
  });
});
