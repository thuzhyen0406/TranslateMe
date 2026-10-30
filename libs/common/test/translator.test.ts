import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TranslateTextCommand } from '@aws-sdk/client-translate';
import { validateMarkers } from '../markers.js';
import { createTranslator, groupByBytes, type TranslateRequest } from '../translator.js';

/** "Dịch" giả: viết HOA phần chữ, giữ nguyên thẻ HTML. */
const upper = (html: string): string =>
  html.replace(/(<[^>]*>)|([^<]+)/g, (_a, tag: string | undefined, text: string | undefined) =>
    tag ?? (text ?? '').toUpperCase().replace(/&(?:[A-Z]+|#X?[0-9A-F]+);/g, (e) => e.toLowerCase()),
  );

interface Call {
  Text: string;
  SourceLanguageCode?: string;
  TargetLanguageCode?: string;
  TerminologyNames?: string[];
}

function fakeClient(behave: (text: string, i: number) => string | Promise<string> = upper) {
  let inFlight = 0;
  const c = {
    calls: [] as Call[],
    maxInFlight: 0,
    async send(cmd: TranslateTextCommand) {
      const input = cmd.input as Call;
      const i = c.calls.length;
      c.calls.push(input);
      inFlight++;
      c.maxInFlight = Math.max(c.maxInFlight, inFlight);
      try {
        await new Promise((r) => setImmediate(r));
        return { TranslatedText: await behave(input.Text, i) };
      } finally {
        inFlight--;
      }
    },
  };
  return c;
}

const throttling = () => Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
const req = (sentences: string[], o: Partial<TranslateRequest> = {}): TranslateRequest => ({
  src: 'vi',
  tgt: 'en',
  sentences: sentences.map((text, id) => ({ id, text })),
  terminologyName: null,
  deadlineAt: Number.MAX_SAFE_INTEGER,
  concurrency: 4,
  ...o,
});

describe('groupByBytes', () => {
  it('gom khối không vượt giới hạn; phần tử quá lớn đứng riêng', () => {
    assert.deepEqual(groupByBytes([3, 3, 3, 9, 1], (n) => n, 6), [[3, 3], [3], [9], [1]]);
  });
});

describe('translateSentences (B.9)', () => {
  it('trả translated theo id, giữ marker, gửi kèm mã ngôn ngữ và terminology', async () => {
    const c = fakeClient();
    const r = await createTranslator(c)(req(['Xin chào.', 'Xem {1}bảng giá{/1} nhé.', 'Mẫu {{ten}}.'], { tgt: 'ko', terminologyName: 'tm-t_1' }));
    assert.deepEqual(r.translated, [
      { id: 0, tgt: 'XIN CHÀO.', needsReview: false },
      { id: 1, tgt: 'XEM {1}BẢNG GIÁ{/1} NHÉ.', needsReview: false },
      { id: 2, tgt: 'MẪU {{TEN}}.', needsReview: false },
    ]);
    assert.deepEqual(r.pending, []);
    assert.deepEqual(r.failed, []);
    assert.equal(c.calls.length, 1);
    assert.equal(c.calls[0].TargetLanguageCode, 'ko');
    assert.deepEqual(c.calls[0].TerminologyNames, ['tm-t_1']);
    assert.match(c.calls[0].Text, /<div data-s="1">Xem <span data-i="1">bảng giá<\/span> nhé.<\/div>/);
  });

  it('terminologyName null -> không gửi TerminologyNames', async () => {
    const c = fakeClient();
    await createTranslator(c)(req(['Một']));
    assert.equal(c.calls[0].TerminologyNames, undefined);
  });

  it('câu trùng chỉ gửi một lần nhưng trả đủ cho mọi id; đếm ký tự gửi đi', async () => {
    const c = fakeClient();
    const r = await createTranslator(c)(req(['Đặt phòng', 'Liên hệ', 'Đặt phòng']));
    assert.deepEqual(r.translated.map((t) => [t.id, t.tgt]), [[0, 'ĐẶT PHÒNG'], [1, 'LIÊN HỆ'], [2, 'ĐẶT PHÒNG']]);
    assert.equal(r.stats.uniqueSentences, 2);
    assert.equal(r.stats.charsSent, Array.from(c.calls[0].Text).length);
  });

  it('chia khối ≤ 10.000 byte theo ranh giới câu, gọi song song có giới hạn', async () => {
    const sentences = Array.from({ length: 600 }, (_, i) => `Câu thứ ${i} có {1}thẻ đậm{/1} và nội dung tiếng Việt khá dài để tăng số byte.`);
    const c = fakeClient();
    const r = await createTranslator(c)(req(sentences, { concurrency: 3 }));
    assert.ok(c.calls.length > 3);
    for (const call of c.calls) {
      assert.ok(Buffer.byteLength(call.Text, 'utf8') <= 10_000);
      assert.match(call.Text, /^<div data-s="\d+">[\s\S]*<\/div>$/, 'khối bắt đầu và kết thúc ở ranh giới câu');
    }
    assert.ok(c.maxInFlight <= 3);
    assert.equal(r.translated.length, 600);
    r.translated.forEach((t) => assert.equal(t.tgt, upper(sentences[t.id])));
  });

  it('thiếu data-s -> chia đôi nhóm câu thiếu rồi dịch lại, không dịch lại câu đã có', async () => {
    const c = fakeClient((text, i) => (i === 0 ? upper(text).replace(/<div data-s="[123]">[\s\S]*?<\/div>/g, '') : upper(text)));
    const r = await createTranslator(c)(req(['Một.', 'Hai.', 'Ba {1}đậm{/1}.', 'Bốn.']));
    assert.equal(r.translated.length, 4);
    assert.deepEqual(r.translated.map((t) => t.needsReview), [false, false, false, false]);
    assert.ok(r.stats.splits >= 1);
    assert.ok(!c.calls.slice(1).some((x) => x.Text.includes('data-s="0"')), 'câu 0 không bị gửi lại');
  });

  it('một câu vẫn thiếu sau khi chia -> dịch dạng văn bản thuần, needsReview', async () => {
    const c = fakeClient((text) => (text.includes('data-s="1"') ? upper(text).replace(/<div data-s="1">[\s\S]*?<\/div>/, '') : upper(text)));
    const r = await createTranslator(c)(req(['Một.', 'Xem {1}đây{/1}.']));
    assert.deepEqual(r.translated, [
      { id: 0, tgt: 'MỘT.', needsReview: false },
      { id: 1, tgt: 'XEM ĐÂY.', needsReview: true },
    ]);
    assert.equal(c.calls.at(-1)?.Text, 'Xem đây.');
  });

  it('trùng data-s -> cũng coi là thiếu', async () => {
    const c = fakeClient((text, i) => (i === 0 ? upper(text).replace(/(<div data-s="0">[\s\S]*?<\/div>)/, '$1$1') : upper(text)));
    const r = await createTranslator(c)(req(['Một.', 'Hai.']));
    assert.deepEqual(r.translated.map((t) => t.tgt), ['MỘT.', 'HAI.']);
    assert.ok(c.calls.length >= 2);
  });

  it('marker hỏng -> dịch lại văn bản thuần (escape HTML), needsReview, không còn marker', async () => {
    const c = fakeClient((text) => upper(text).replace('</span>', ''));
    const r = await createTranslator(c)(req(['a < b & {1}c{/1}']));
    assert.equal(c.calls.at(-1)?.Text, 'a &lt; b &amp; c');
    assert.deepEqual(r.translated, [{ id: 0, tgt: 'A < B & C', needsReview: true }]);
    assert.equal(validateMarkers(r.translated[0].tgt).ids.length, 0);
    assert.equal(r.stats.plainFallbacks, 1);
  });

  it('Translate lỗi ở một khối -> câu của khối đó vào failed kèm lý do', async () => {
    const sentences = Array.from({ length: 400 }, (_, i) => `Câu ${i} tiếng Việt có dấu đủ dài để tách khối.`);
    const c = fakeClient((text, i) => {
      if (i === 0) throw throttling();
      return upper(text);
    });
    const r = await createTranslator(c)(req(sentences, { concurrency: 1 }));
    assert.ok(r.failed.length > 0 && r.failed.length < 400);
    assert.deepEqual(r.failed[0], { id: 0, reason: 'ThrottlingException' });
    assert.equal(r.translated.length + r.failed.length, 400);
    assert.deepEqual(r.pending, []);
  });

  it('đã hết giờ từ đầu -> không gọi Translate, mọi câu vào pending (để worker dịch nốt)', async () => {
    const c = fakeClient();
    const r = await createTranslator(c, { now: () => 100 })(req(['Một', 'Hai', 'Một'], { deadlineAt: 10 }));
    assert.equal(c.calls.length, 0);
    assert.deepEqual(r.translated, []);
    assert.deepEqual(r.pending, [0, 1, 2]);
  });

  it('hết giờ giữa chừng: khối đầu đã dịch, các khối sau vào pending', async () => {
    let t = 0;
    const sentences = Array.from({ length: 400 }, (_, i) => `Câu ${i} tiếng Việt có dấu đủ dài để tách khối.`);
    const c = fakeClient((text) => {
      t = 100; // lời gọi đầu tiên làm hết giờ
      return upper(text);
    });
    const r = await createTranslator(c, { now: () => t })(req(sentences, { concurrency: 1, deadlineAt: 50 }));
    assert.equal(c.calls.length, 1);
    assert.ok(r.translated.length > 0);
    assert.ok(r.pending.length > 0);
    assert.equal(r.translated.length + r.pending.length, 400);
    assert.deepEqual(r.failed, []);
  });

  it('câu lớn hơn giới hạn một lần gọi -> failed SENTENCE_TOO_LARGE', async () => {
    const r = await createTranslator(fakeClient(), { maxBytes: 100 })(req(['Ngắn', 'x'.repeat(200)]));
    assert.deepEqual(r.translated, [{ id: 0, tgt: 'NGẮN', needsReview: false }]);
    assert.deepEqual(r.failed, [{ id: 1, reason: 'SENTENCE_TOO_LARGE' }]);
  });

  it('không có câu -> không gọi Translate', async () => {
    const c = fakeClient();
    const r = await createTranslator(c)(req([]));
    assert.equal(c.calls.length, 0);
    assert.deepEqual(r, { translated: [], pending: [], failed: [], stats: { uniqueSentences: 0, calls: 0, charsSent: 0, splits: 0, plainFallbacks: 0 } });
  });
});
