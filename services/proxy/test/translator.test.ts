import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateMarkers } from '../../../libs/common/markers.js';
import { chunkByBytes, translateSentences } from '../translator.js';
import { fakeTranslate, throttlingError, upperCaseOutsideTags } from './helpers.js';

const opts = { sourceLang: 'vi', targetLang: 'en', deadline: Number.MAX_SAFE_INTEGER };

describe('chunkByBytes', () => {
  it('gom khối không vượt giới hạn; phần tử quá lớn đứng riêng', () => {
    assert.deepEqual(chunkByBytes([3, 3, 3, 9, 1], (n) => n, 6), [[3, 3], [3], [9], [1]]);
    assert.deepEqual(chunkByBytes([], (n: number) => n, 6), []);
  });
});

describe('translateSentences', () => {
  it('dịch đúng thứ tự, giữ marker, gửi kèm mã ngôn ngữ', async () => {
    const client = fakeTranslate();
    const r = await translateSentences(client, ['Xin chào.', 'Xem {1}bảng giá{/1} nhé.', 'Mẫu {{ten}}.'], { ...opts, targetLang: 'ko' });
    assert.deepEqual(r.translations, ['XIN CHÀO.', 'XEM {1}BẢNG GIÁ{/1} NHÉ.', 'MẪU {{TEN}}.']);
    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0].SourceLanguageCode, 'vi');
    assert.equal(client.calls[0].TargetLanguageCode, 'ko');
    assert.match(client.calls[0].Text, /<div data-s="1">Xem <span data-i="1">bảng giá<\/span> nhé.<\/div>/);
    assert.equal(r.untranslated, 0);
    assert.equal(r.timedOut, false);
  });

  it('hỗ trợ ba cặp vi→en, vi→ko và vi→ja qua cùng hàm dịch', async () => {
    for (const targetLang of ['en', 'ko', 'ja']) {
      const client = fakeTranslate();
      const result = await translateSentences(client, ['Xin chào.'], { ...opts, targetLang });
      assert.equal(result.translations[0], 'XIN CHÀO.');
      assert.equal(client.calls[0].SourceLanguageCode, 'vi');
      assert.equal(client.calls[0].TargetLanguageCode, targetLang);
    }
  });

  it('câu trùng chỉ gửi một lần; đếm ký tự gửi đi theo code point', async () => {
    const client = fakeTranslate();
    const r = await translateSentences(client, ['Đặt phòng', 'Liên hệ', 'Đặt phòng'], opts);
    assert.deepEqual(r.translations, ['ĐẶT PHÒNG', 'LIÊN HỆ', 'ĐẶT PHÒNG']);
    assert.equal(r.uniqueSentences, 2);
    assert.equal(r.charsSent, Array.from(client.calls[0].Text).length);
    assert.equal((client.calls[0].Text.match(/Đặt phòng/g) ?? []).length, 1);
  });

  it('chia khối ≤ 10.000 byte, gọi song song có giới hạn', async () => {
    const sentences = Array.from({ length: 600 }, (_, i) => `Câu thứ ${i} có {1}thẻ đậm{/1} và nội dung tiếng Việt khá dài để tăng số byte.`);
    const client = fakeTranslate();
    const r = await translateSentences(client, sentences, { ...opts, concurrency: 3 });
    assert.ok(client.calls.length > 3);
    for (const c of client.calls) assert.ok(Buffer.byteLength(c.Text, 'utf8') <= 10_000);
    assert.ok(client.maxInFlight <= 3);
    assert.equal(r.untranslated, 0);
    r.translations.forEach((t, i) => assert.equal(t, upperCaseOutsideTags(sentences[i])));
  });

  it('truyền Custom Terminology khi có', async () => {
    const client = fakeTranslate();
    await translateSentences(client, ['Xin chào'], { ...opts, terminologyNames: ['tenant-t_1'] });
    assert.deepEqual(client.calls[0].TerminologyNames, ['tenant-t_1']);
  });

  it('thiếu data-s trong kết quả -> dịch lại riêng câu đó', async () => {
    const client = fakeTranslate((text, i) => (i === 0 ? upperCaseOutsideTags(text).replace(/<div data-s="1">[\s\S]*?<\/div>/, '') : upperCaseOutsideTags(text)));
    const r = await translateSentences(client, ['Một.', 'Hai {1}đậm{/1}.'], opts);
    assert.deepEqual(r.translations, ['MỘT.', 'HAI {1}ĐẬM{/1}.']);
    assert.equal(client.calls.length, 2);
    assert.equal(client.calls[1].Text, 'Hai <span data-i="1">đậm</span>.');
  });

  it('marker hỏng -> dịch lại dạng văn bản thuần (rebuild sẽ bỏ thẻ nội tuyến)', async () => {
    const client = fakeTranslate((text) => upperCaseOutsideTags(text).replace('</span>', ''));
    const r = await translateSentences(client, ['Xem {1}đây{/1} nhé.'], opts);
    assert.deepEqual(r.translations, ['XEM ĐÂY NHÉ.']);
    assert.equal(r.plainFallbacks, 1);
    assert.equal(client.calls.at(-1)?.Text, 'Xem đây nhé.');
    assert.equal(validateMarkers(r.translations[0] ?? '').ids.length, 0);
  });

  it('văn bản thuần khi dịch lại được escape HTML', async () => {
    const client = fakeTranslate((text) => upperCaseOutsideTags(text).replace('</span>', ''));
    const r = await translateSentences(client, ['a < b & {1}c{/1}'], opts);
    assert.equal(client.calls.at(-1)?.Text, 'a &lt; b &amp; c');
    assert.deepEqual(r.translations, ['A < B & C']);
  });

  it('Translate lỗi ở một khối -> câu của khối đó giữ nguyên gốc, ghi lỗi', async () => {
    const sentences = Array.from({ length: 400 }, (_, i) => `Câu ${i} tiếng Việt có dấu đủ dài để tách khối.`);
    const client = fakeTranslate((text, i) => {
      if (i === 0) throw throttlingError();
      return upperCaseOutsideTags(text);
    });
    const r = await translateSentences(client, sentences, { ...opts, concurrency: 1 });
    assert.ok(r.untranslated > 0 && r.untranslated < sentences.length);
    assert.equal(r.translations[0], undefined);
    assert.equal(r.translations.at(-1), upperCaseOutsideTags(sentences.at(-1) ?? ''));
    assert.deepEqual(r.errors, ['ThrottlingException']);
  });

  it('hết ngân sách thời gian -> không gửi thêm khối', async () => {
    const client = fakeTranslate();
    const r = await translateSentences(client, ['Một', 'Hai'], { ...opts, deadline: 1000, now: () => 1000 });
    assert.equal(client.calls.length, 0);
    assert.equal(r.timedOut, true);
    assert.deepEqual(r.translations, [undefined, undefined]);
    assert.equal(r.untranslated, 2);
  });

  it('câu lớn hơn giới hạn một lần gọi -> giữ nguyên gốc', async () => {
    const client = fakeTranslate();
    const r = await translateSentences(client, ['Ngắn', 'x'.repeat(200)], { ...opts, maxBytes: 100 });
    assert.deepEqual(r.translations, ['NGẮN', undefined]);
    assert.deepEqual(r.errors, ['SENTENCE_TOO_LARGE x1']);
  });

  it('không có câu -> không gọi Translate', async () => {
    const client = fakeTranslate();
    const r = await translateSentences(client, [], opts);
    assert.equal(client.calls.length, 0);
    assert.deepEqual(r.translations, []);
  });
});
