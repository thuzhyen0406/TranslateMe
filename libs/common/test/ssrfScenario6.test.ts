/**
 * Kiểm thử tự động Bộ thử SSRF – Kịch bản 6 (Nhiệm vụ Tuần 5 – TV4).
 * Dùng cho kiểm thử đơn vị của libs/common và tích hợp với quy trình CI / kiểm thử của TV1 (5.1).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runSsrfScenario6 } from './ssrfScenario6.js';

describe('Kịch bản 6 – Bộ thử hồi quy mô phỏng SSRF 9 đích (Unit Regression Test)', async () => {
  const report = await runSsrfScenario6();

  it('tổng số tình huống mô phỏng phải đúng 9 đích bắt buộc', () => {
    assert.equal(report.totalTests, 9);
    assert.equal(report.results.length, 9);
  });

  it('9/9 tình huống mô phỏng phải đạt tiêu chuẩn an toàn (allPassed = true, passCount = 9, failCount = 0)', () => {
    assert.equal(report.passCount, 9, `Chỉ có ${report.passCount}/9 phép thử đạt`);
    assert.equal(report.failCount, 0);
    assert.equal(report.allPassed, true);
  });

  it('9/9 tình huống ngăn chặn thành công việc truy cập vào IP nội bộ (preventedInternalAccessCount = 9)', () => {
    assert.equal(report.preventedInternalAccessCount, 9);
  });

  it('phân định chính xác: 8 yêu cầu bị chặn hoàn toàn và 1 yêu cầu an toàn được phép kết nối IP công khai đã ghim', () => {
    assert.equal(report.blockedRequestsCount, 8, 'Phải có đúng 8 yêu cầu bị chặn hoàn toàn');
    assert.equal(report.allowedSafeRequestsCount, 1, 'Phải có đúng 1 yêu cầu an toàn được phép hoàn tất (DNS rebinding)');
  });

  it('tình huống 6.7 (DNS rebinding) trả outcome OK với IP công khai đã ghim và không kết nối 127.0.0.1', () => {
    const r67 = report.results.find((r) => r.id === '6.7')!;
    assert.ok(r67, 'Phải tìm thấy test 6.7');
    assert.equal(r67.actualOutcome, 'OK');
    assert.equal(r67.blocked, false);
    assert.equal(r67.allowedSafeConnection, true);
    assert.equal(r67.preventedInternalAccess, true);
    assert.deepEqual(r67.contactedIps, ['93.184.216.34']);
  });

  it('8 tình huống còn lại đều có outcome là BLOCKED (PRIVATE_IP hoặc PORT)', () => {
    const otherTests = report.results.filter((r) => r.id !== '6.7');
    assert.equal(otherTests.length, 8);
    for (const r of otherTests) {
      assert.equal(r.actualOutcome, 'BLOCKED');
      assert.equal(r.blocked, true);
      assert.equal(r.preventedInternalAccess, true);
    }
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
