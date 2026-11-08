/**
 * Kiểm thử tự động Bộ thử SSRF – Kịch bản 6 (Nhiệm vụ Tuần 5 – TV4).
 * Dùng cho kiểm thử đơn vị của libs/common và tích hợp với quy trình CI / kiểm thử của TV1 (5.1).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runSsrfScenario6 } from './ssrfScenario6.js';

describe('Kịch bản 6 – Bộ thử hồi quy mô phỏng SSRF 9 đích (Unit Regression Test)', async () => {
  const report = await runSsrfScenario6();

  it('tổng số test case mô phỏng phải đúng 9 đích bắt buộc', () => {
    assert.equal(report.totalTests, 9);
    assert.equal(report.results.length, 9);
  });

  it('9/9 đích mô phỏng phải đạt tiêu chuẩn (allPassed = true, passCount = 9, failCount = 0)', () => {
    assert.equal(report.passCount, 9, `Chỉ có ${report.passCount}/9 phép thử đạt`);
    assert.equal(report.failCount, 0);
    assert.equal(report.allPassed, true);
  });

  it('9/9 đích mô phỏng bị chặn hoặc không bao giờ chạm tới IP nội bộ (blockedCount = 9)', () => {
    assert.equal(report.blockedCount, 9);
  });

  it('tuyệt đối không có kết nối nào tới IP nội bộ được chuyển tới mock transport (internalIpsContactedCount = 0)', () => {
    assert.equal(report.internalIpsContactedCount, 0, 'Phát hiện có kết nối socket tới IP nội bộ!');
  });

  it('tuyệt đối không chuyển tiếp Cookie hay Header xác thực nhạy cảm (sensitiveHeadersLeakedCount = 0)', () => {
    assert.equal(report.sensitiveHeadersLeakedCount, 0, 'Phát hiện rò rỉ Cookie hoặc Authorization header!');
  });

  for (const r of report.results) {
    it(`[${r.id}] ${r.name} -> ${r.passed ? 'PASS' : 'FAIL'} (${r.actualReason})`, () => {
      assert.equal(r.passed, true, `Phép thử ${r.id} không đạt: ${r.detail}`);
      assert.equal(r.noInternalConnection, true, `Phép thử ${r.id} kết nối tới IP nội bộ: ${r.contactedIps.join(', ')}`);
      assert.equal(r.headersSanitized, true, `Phép thử ${r.id} làm rò rỉ header nhạy cảm!`);
    });
  }
});
