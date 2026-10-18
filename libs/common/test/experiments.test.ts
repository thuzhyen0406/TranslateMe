import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DetectDominantLanguageCommand } from '@aws-sdk/client-comprehend';
import { ImportTerminologyCommand, TranslateTextCommand } from '@aws-sdk/client-translate';
import {
  analyzeCharacterBilling,
  buildTerminologyCsv,
  checkTerminologyApplied,
  check_markers,
  countCodePoints,
  evaluateLanguageConfidence,
  inspectSpanTags,
} from '../experiments/analyzers.js';
import {
  executeExperiments,
  generateFindingsMarkdown,
  runPreflightCheck,
  type ComprehendClientLike,
  type TranslateClientLike,
} from '../experiments/runExperiments.js';
import { TERMINOLOGY_ENTRIES } from '../experiments/sampleData.js';

describe('Thử nghiệm 1 – inspectSpanTags (<span data-i="k">)', () => {
  it('giữ nguyên thẻ, đúng thứ tự -> tagsIntact = true, orderReordered = false', () => {
    const src = 'Chào <span data-i="1">quý khách</span> đến với <span data-i="2">Hội An</span>.';
    const tr = 'Welcome <span data-i="1">dear guest</span> to <span data-i="2">Hoi An</span>.';
    const res = inspectSpanTags(src, tr);
    assert.equal(res.tagsIntact, true);
    assert.equal(res.openEqualsClose, true);
    assert.equal(res.dataIValuesIntact, true);
    assert.equal(res.positionReasonable, true);
    assert.equal(res.orderReordered, false);
    assert.equal(res.whitespaceChanged, false);
  });

  it('tiếng Hàn/Nhật đảo trật tự từ (data-i="2" đứng trước data-i="1") nhưng cấu trúc hợp lệ -> tagsIntact = true, orderReordered = true', () => {
    const src = '<span data-i="1">Homestay ABC</span> nằm gần <span data-i="2">phố cổ Hội An</span>.';
    const trKo = '<span data-i="2">호이안 구시가지</span> 근처에 <span data-i="1">Homestay ABC</span>가 있습니다.';
    const res = inspectSpanTags(src, trKo);
    assert.equal(res.tagsIntact, true);
    assert.equal(res.orderReordered, true);
    assert.equal(res.positionReasonable, true);
  });

  it('mất thẻ đóng </span> hoặc mất thuộc tính data-i -> tagsIntact = false', () => {
    const src = 'Giá gồm <span data-i="1">bữa sáng</span> và <span data-i="2">xe đưa đón</span>.';
    const missingClose = 'Price includes <span data-i="1">breakfast and <span data-i="2">shuttle</span>.';
    const r1 = inspectSpanTags(src, missingClose);
    assert.equal(r1.tagsIntact, false);
    assert.equal(r1.openEqualsClose, false);

    const strippedAttr = 'Price includes <span>breakfast</span> and <span data-i="2">shuttle</span>.';
    const r2 = inspectSpanTags(src, strippedAttr);
    assert.equal(r2.tagsIntact, false);
    assert.equal(r2.dataIValuesIntact, false);
    assert.deepEqual(r2.missingDataI, ['1']);
  });

  it('phát hiện thêm/bớt khoảng trắng quanh thẻ <span>', () => {
    const src = 'Xem <span data-i="1">chi tiết</span> tại đây.';
    const addedInside = 'See <span data-i="1"> details</span> here.';
    const r1 = inspectSpanTags(src, addedInside);
    assert.equal(r1.whitespaceChanged, true);

    const lostOutside = 'See<span data-i="1">details</span>here.';
    const r2 = inspectSpanTags(src, lostOutside);
    assert.equal(r2.whitespaceChanged, true);
  });
});

describe('Thử nghiệm 2 – analyzeCharacterBilling (đếm code point)', () => {
  it('đếm chính xác số Unicode code point có thẻ và không thẻ', () => {
    const html = 'Đặt <span data-i="1">phòng</span>';
    // Plain: "Đặt phòng" = 9 code points; thẻ '<span data-i="1">' (17) + '</span>' (7) = 24 ký tự thẻ
    const a = analyzeCharacterBilling(html);
    assert.equal(a.plainText, 'Đặt phòng');
    assert.equal(a.codePointsWithoutTags, 9);
    assert.equal(a.codePointsWithTags, 9 + 24);
    assert.equal(a.tagOverheadCodePoints, 24);
    assert.ok(a.overheadPercent > 200);
  });

  it('đếm emoji astral plane (surrogate pair) là 1 code point', () => {
    assert.equal(countCodePoints('A😀B'), 3);
  });
});

describe('Thử nghiệm 3 – check_markers ({n}...{/n})', () => {
  it('cặp đơn, hai cặp và cặp lồng nhau nguyên vẹn -> survived = true', () => {
    const src = 'Nhấn {1}nút {2}Xác nhận{/2} ngay{/1} để nhận {3}quà{/3}.';
    const tr = 'Click {1}the {2}Confirm{/2} button now{/1} to get {3}a gift{/3}.';
    const r = check_markers(src, tr);
    assert.equal(r.survived, true);
    assert.equal(r.properlyPaired, true);
    assert.deepEqual(r.missingMarkers, []);
    assert.deepEqual(r.mutatedMarkers, []);
  });

  it('phát hiện marker bị thiếu hoặc bị biến dạng khoảng trắng / ngoặc fullwidth', () => {
    const src = '{1}Homestay ABC{/1} gần {2}phố cổ Hội An{/2}.';
    const mutated = '{ 1 }Homestay ABC{/1} near ｛2｝Hoi An Ancient Town{/2}.';
    const r = check_markers(src, mutated);
    assert.equal(r.survived, false);
    assert.deepEqual(r.missingMarkers, ['{1}', '{2}']);
    assert.ok(r.mutatedMarkers.length >= 2);
  });

  it('phát hiện đóng trước khi mở ({/1} ... {1}) -> properlyPaired = false', () => {
    const src = 'Xin chào {1}quý khách{/1}.';
    const inverted = 'Hello {/1}dear guest{1}.';
    const r = check_markers(src, inverted);
    assert.equal(r.survived, false);
    assert.equal(r.properlyPaired, false);
  });
});

describe('Thử nghiệm 4 – evaluateLanguageConfidence (ngưỡng 0.70)', () => {
  it('điểm >= 0.70 -> belowThreshold = false; điểm < 0.70 -> belowThreshold = true', () => {
    const high = evaluateLanguageConfidence([{ LanguageCode: 'vi', Score: 0.985 }]);
    assert.equal(high.topLanguageCode, 'vi');
    assert.equal(high.belowThreshold, false);

    const low = evaluateLanguageConfidence([
      { LanguageCode: 'en', Score: 0.52 },
      { LanguageCode: 'vi', Score: 0.48 },
    ]);
    assert.equal(low.topLanguageCode, 'en');
    assert.equal(low.belowThreshold, true);
  });
});

describe('Thử nghiệm 5 – Custom Terminology CSV & checkTerminologyApplied', () => {
  it('buildTerminologyCsv tạo đúng dòng đầu là mã ngôn ngữ vi,en,ko,ja', () => {
    const csv = buildTerminologyCsv(TERMINOLOGY_ENTRIES);
    const lines = csv.trim().split('\n');
    assert.equal(lines[0], 'vi,en,ko,ja');
    assert.equal(lines[1], 'Homestay ABC,Homestay ABC,Homestay ABC,Homestay ABC');
    assert.ok(lines.some((l) => l.startsWith('phố cổ Hội An,Hoi An Ancient Town,호이안 구시가지,')));
  });

  it('checkTerminologyApplied đánh dấu needsReview = true khi bản dịch thiếu thuật ngữ đích', () => {
    const ok = checkTerminologyApplied('Homestay ABC is near Hoi An Ancient Town.', [
      'Homestay ABC',
      'Hoi An Ancient Town',
    ]);
    assert.equal(ok.allApplied, true);
    assert.equal(ok.needsReview, false);

    const missed = checkTerminologyApplied('ABC Homestay is near old town of Hoi An.', [
      'Homestay ABC',
      'Hoi An Ancient Town',
    ]);
    assert.equal(missed.allApplied, false);
    assert.equal(missed.needsReview, true);
    assert.deepEqual(missed.missedTerms, ['Homestay ABC', 'Hoi An Ancient Town']);
  });
});

describe('Luồng chạy thực nghiệm với Mock AWS SDK v3 & Sinh báo cáo Markdown', () => {
  const mockTranslate: TranslateClientLike = {
    async send(cmd: unknown) {
      if (cmd instanceof ImportTerminologyCommand) {
        return {
          TerminologyProperties: {
            Name: cmd.input.Name,
            TermCount: 4,
          },
        };
      }
      if (cmd instanceof TranslateTextCommand) {
        const text = cmd.input.Text ?? '';
        const hasTerm = (cmd.input.TerminologyNames ?? []).length > 0;
        if (hasTerm && text.includes('Homestay ABC')) {
          return {
            TranslatedText: text
              .replace('phố cổ Hội An', 'Hoi An Ancient Town')
              .replace('sông Hoài', 'Hoai River'),
            AppliedTerminologies: [{ Name: cmd.input.TerminologyNames?.[0] }],
          };
        }
        return { TranslatedText: text };
      }
      return {};
    },
  };

  const mockComprehend: ComprehendClientLike = {
    async send(cmd: DetectDominantLanguageCommand) {
      const text = cmd.input.Text ?? '';
      const score = text.length > 30 ? 0.96 : 0.55;
      return {
        Languages: [{ LanguageCode: 'vi', Score: score }],
      };
    },
  };

  it('preflight thiếu region hoặc Translate lỗi -> báo translateAvailable = false rõ ràng', async () => {
    const noRegion = await runPreflightCheck({ region: '' });
    assert.equal(noRegion.translateAvailable, false);
    assert.equal(noRegion.errorCode, 'MISSING_REGION');

    const failClient: TranslateClientLike = {
      async send() {
        throw Object.assign(new Error('SubscriptionRequiredException'), {
          name: 'SubscriptionRequiredException',
        });
      },
    };
    const subErr = await runPreflightCheck({ region: 'ap-southeast-1', translateClient: failClient });
    assert.equal(subErr.translateAvailable, false);
    assert.equal(subErr.errorCode, 'SubscriptionRequiredException');
  });

  it('chạy đủ 5 thử nghiệm với mock client và sinh báo cáo Markdown đủ 7 mục', async () => {
    const results = await executeExperiments(
      'all',
      { templateOnly: false },
      {
        region: 'ap-southeast-1',
        accountPlan: 'AWS Free Tier (Mock Test)',
        translateClient: mockTranslate,
        comprehendClient: mockComprehend,
        now: () => '2026-10-18T09:30:00.000Z',
      },
    );

    assert.equal(results.environment.translateAvailable, true);
    assert.ok(results.exp1);
    assert.ok(results.exp2);
    assert.ok(results.exp3);
    assert.ok(results.exp4);
    assert.ok(results.exp5);
    assert.equal(results.exp1.summaryByLang.en.preservationRatePct, 100);
    assert.equal(results.exp3.summaryByLang.ko.survivalRatePct, 100);
    assert.ok(results.exp4.belowThresholdIds.length > 0);

    const md = generateFindingsMarkdown(results);
    assert.match(md, /## \(1\) Môi trường thực nghiệm/);
    assert.match(md, /## \(2\) Phương pháp và Bộ câu mẫu/);
    assert.match(md, /## \(3\) Bảng kết quả theo từng cặp ngôn ngữ/);
    assert.match(md, /## \(4\) Kết quả Amazon Comprehend/);
    assert.match(md, /## \(5\) Trả lời hai câu hỏi Chốt chặn 1/);
    assert.match(md, /## \(6\) Khuyến nghị thiết kế cho Module Dịch Proxy \(F2\) và Hậu kiểm \/ Glossary \(F4\)/);
    assert.match(md, /## \(7\) Phụ lục/);
  });

  it('chế độ --template để nguyên phần (5) là CHƯA CHẠY, không bịa số liệu', async () => {
    const templateRes = await executeExperiments('all', { templateOnly: true }, { region: 'ap-southeast-1' });
    const md = generateFindingsMarkdown(templateRes);
    assert.match(md, /`CHƯA CHẠY`/);
  });
});
