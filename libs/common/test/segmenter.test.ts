import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MARKER_SAMPLE_SENTENCES } from '../experiments/sampleData.js';
import { escapeMarkerText, renumberMarkers, validateMarkers } from '../markers.js';
import { isTranslatable, segmentBlock, splitSentences } from '../segmenter.js';

const split = (t: string) => splitSentences(t);

describe('splitSentences – cơ bản', () => {
  it('tách câu tiếng Việt và tiếng Anh', () => {
    assert.deepEqual(split('Xin chào. Bạn khỏe không? Tôi khỏe!'), ['Xin chào.', 'Bạn khỏe không?', 'Tôi khỏe!']);
    assert.deepEqual(split('Prices start at $9.99 per month. Contact us at hello@example.com.'), [
      'Prices start at $9.99 per month.',
      'Contact us at hello@example.com.',
    ]);
    assert.deepEqual(split('© 2026 Example Inc. All rights reserved.'), ['© 2026 Example Inc.', 'All rights reserved.']);
  });

  it('không cắt số thập phân, số tiền, điểm, email, URL, giờ', () => {
    for (const s of [
      'Giá 1.250.000 VND cho 2 đêm.',
      'Điểm 9.4/10 từ du khách.',
      'Xem tại https://example.com/a.html ngay.',
      'Mở cửa 08.30 đến 22.00 hằng ngày.',
      'Phiên bản v2.1.3 đã phát hành.',
    ]) {
      assert.deepEqual(split(s), [s], s);
    }
  });

  it('không cắt sau chữ viết tắt và chữ cái đơn', () => {
    assert.deepEqual(split('Mr. Smith và Dr. Lee đến TP. Hồ Chí Minh. Họ ở Q. 1.'), [
      'Mr. Smith và Dr. Lee đến TP. Hồ Chí Minh.',
      'Họ ở Q. 1.',
    ]);
    assert.deepEqual(split('Sách của J. K. Rowling rất hay. ThS. Lan đồng ý.'), [
      'Sách của J. K. Rowling rất hay.',
      'ThS. Lan đồng ý.',
    ]);
    assert.deepEqual(split('Use e.g. this one. Done.'), ['Use e.g. this one.', 'Done.']);
  });

  it('không cắt khi chữ sau dấu chấm là chữ thường', () => {
    assert.deepEqual(split('Có phở, bún, v.v. và nhiều món khác. Hết.'), ['Có phở, bún, v.v. và nhiều món khác.', 'Hết.']);
    assert.deepEqual(split('Chờ chút… rồi đi. Xong… Tiếp nhé.'), ['Chờ chút… rồi đi.', 'Xong…', 'Tiếp nhé.']);
  });

  it('chuỗi dấu ?! … và dấu đóng nháy/ngoặc đi theo câu trước', () => {
    assert.deepEqual(split('Thật sao?! Ừ... Đúng vậy.'), ['Thật sao?!', 'Ừ...', 'Đúng vậy.']);
    assert.deepEqual(split('Anh ấy nói “Xin chào.” Rồi đi (rất nhanh.) Hết.'), [
      'Anh ấy nói “Xin chào.”',
      'Rồi đi (rất nhanh.)',
      'Hết.',
    ]);
  });

  it('tiếng Nhật/Trung cắt ở 。！？ không cần khoảng trắng; tiếng Hàn như Latin', () => {
    assert.deepEqual(split('東京に行きました。京都にも行きました！楽しい？'), ['東京に行きました。', '京都にも行きました！', '楽しい？']);
    assert.deepEqual(split('「はい。」と言った。'), ['「はい。」', 'と言った。']);
    assert.deepEqual(split('호텔에 도착했습니다. 방이 넓어요.'), ['호텔에 도착했습니다.', '방이 넓어요.']);
  });

  it('"no" là từ tiếng Việt, không phải chữ viết tắt', () => {
    assert.deepEqual(split('Ăn no. Ngủ kỹ.'), ['Ăn no.', 'Ngủ kỹ.']);
  });

  it('chuỗi khoảng trắng rất dài vẫn xử lý tuyến tính', () => {
    const t = `a${' '.repeat(200_000)}b${' '.repeat(200_000)}c.`;
    const started = Date.now();
    assert.equal(segmentBlock(t).map((p) => p.text).join(''), t);
    assert.ok(Date.now() - started < 2000);
  });

  it('khối một câu, không dấu câu, rỗng', () => {
    assert.deepEqual(split('Đặt phòng ngay'), ['Đặt phòng ngay']);
    assert.deepEqual(split('   '), []);
    assert.deepEqual(split(''), []);
  });
});

describe('splitSentences – marker {n}', () => {
  it('chỉ cắt ở chỗ marker cân bằng', () => {
    assert.deepEqual(split('{1}Câu một. Câu hai.{/1} Câu ba.'), ['{1}Câu một. Câu hai.{/1}', 'Câu ba.']);
  });

  it('dấu chấm ngay trước marker đóng: điểm cắt dời ra sau marker', () => {
    assert.deepEqual(split('Xem {1}tại đây.{/1} Sau đó {2}đăng nhập{/2}.'), ['Xem {1}tại đây.{/1}', 'Sau đó {2}đăng nhập{/2}.']);
  });

  it('câu sau bắt đầu bằng marker mở; chữ thường sau marker vẫn chặn cắt', () => {
    assert.deepEqual(split('Xong. {1}Bước{/1} tiếp.'), ['Xong.', '{1}Bước{/1} tiếp.']);
    assert.deepEqual(split('Khoảng {1}approx.{/1} {2}ten{/2} người.'), ['Khoảng {1}approx.{/1} {2}ten{/2} người.']);
  });

  it('M01–M06 (đều là 1 câu) không bị cắt', () => {
    for (const s of MARKER_SAMPLE_SENTENCES) assert.deepEqual(split(s.textWithMarkers), [s.textWithMarkers], s.id);
  });

  it('ngoặc nhọn có thật không ảnh hưởng tách câu', () => {
    const t = `${escapeMarkerText('Dùng {name}.')} Tiếp.`;
    assert.deepEqual(split(t), ['Dùng {{name}}.', 'Tiếp.']);
  });

  it('chuỗi marker hỏng -> giữ nguyên 1 câu', () => {
    assert.deepEqual(split('Một. {1}Hai. Ba.'), ['Một. {1}Hai. Ba.']);
  });

  it('marker rỗng {n/} không làm lệch độ sâu', () => {
    assert.deepEqual(split('Logo {1/}. Tiếp {2}theo{/2}.'), ['Logo {1/}.', 'Tiếp {2}theo{/2}.']);
  });
});

describe('segmentBlock – bất biến cho rebuild', () => {
  it('ghép các phần lại đúng bằng chuỗi gốc, khoảng trắng nằm trong gap', () => {
    const t = '  Một câu.\n  Hai {1}câu{/1}!   Ba  ';
    const parts = segmentBlock(t);
    assert.equal(parts.map((p) => p.text).join(''), t);
    assert.deepEqual(parts, [
      { kind: 'gap', text: '  ' },
      { kind: 'sentence', text: 'Một câu.' },
      { kind: 'gap', text: '\n  ' },
      { kind: 'sentence', text: 'Hai {1}câu{/1}!' },
      { kind: 'gap', text: '   ' },
      { kind: 'sentence', text: 'Ba' },
      { kind: 'gap', text: '  ' },
    ]);
  });

  it('fuzz 2000 khối ngẫu nhiên: ghép lại đúng, mọi câu có marker cân bằng', () => {
    let seed = 12345;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const words = ['Giá', 'phòng', '9.99', 'Mr.', 'TP.', 'v.v.', 'ok', 'Hà Nội', 'e.g.', '{{x}}', '東京', '。', '?!', '…', '"', '”', '(a.)'];
    const ends = ['.', '!', '?', '. ', '! ', '… ', '。', ''];
    for (let n = 0; n < 2000; n++) {
      let text = '';
      let id = 1;
      const open: number[] = [];
      const len = 3 + rand(25);
      for (let w = 0; w < len; w++) {
        const r = rand(10);
        if (r === 0) {
          text += `{${id}}`;
          open.push(id++);
        } else if (r === 1 && open.length) {
          text += `{/${open.pop()}}`;
        } else if (r === 2) {
          text += `{${id++}/}`;
        } else {
          text += words[rand(words.length)] + ends[rand(ends.length)] + (rand(2) ? ' ' : '');
        }
      }
      while (open.length) text += `{/${open.pop()}}`;
      assert.equal(validateMarkers(text).ok, true, text);

      const parts = segmentBlock(text);
      assert.equal(parts.map((p) => p.text).join(''), text, text);
      for (const p of parts) {
        if (p.kind === 'gap') assert.match(p.text, /^\s+$/u, text);
        else {
          assert.equal(validateMarkers(p.text).ok, true, `${text}\n=> ${p.text}`);
          assert.equal(validateMarkers(renumberMarkers(p.text).text).ok, true);
        }
      }
    }
  });
});

describe('isTranslatable', () => {
  it('bỏ qua câu không có chữ', () => {
    assert.equal(isTranslatable('{1}9.99{/1} %'), false);
    assert.equal(isTranslatable('{1/}'), false);
    assert.equal(isTranslatable('Giá {1}9.99{/1}'), true);
    assert.equal(isTranslatable('東京'), true);
  });
});
