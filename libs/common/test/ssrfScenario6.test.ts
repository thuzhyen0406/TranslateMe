/**
 * Kiểm thử tự động Bộ thử SSRF – Kịch bản 6 (Nhiệm vụ Tuần 5 – TV4).
 * Dùng cho kiểm thử đơn vị của libs/common và tích hợp với quy trình CI / kiểm thử của TV1 (5.1).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runSsrfScenario6 } from './ssrfScenario6.js';

describe('Kịch bản 6 – Bộ thử hồi quy mô phỏng SSRF (9/9 ngăn kết nối IP nội bộ)', async () => {
  const report = await runSsrfScenario6();

  it('tổng số tình huống mô phỏng phải đúng 9 tình huống', () => {
    assert.equal(report.totalTests, 9);
    assert.equal(report.results.length, 9);
  });

  it('9/9 tình huống mô phỏng đạt tiêu chuẩn an toàn (allPassed = true, passCount = 9, failCount = 0)', () => {
    assert.equal(report.passCount, 9, `Chỉ có ${report.passCount}/9 phép thử đạt`);
    assert.equal(report.failCount, 0);
    assert.equal(report.allPassed, true);
  });

  it('tiêu chí cốt lõi: 9/9 tình huống ngăn chặn kết nối vào IP nội bộ (0 kết nối IP nội bộ)', () => {
    assert.equal(report.preventedInternalAccessCount, 9);
    assert.equal(report.internalIpsContactedCount, 0, 'Phát hiện kết nối tới IP nội bộ!');
  });

  it('phân định rõ: 8 yêu cầu bị BLOCKED và 1 yêu cầu ghim IP công khai an toàn (OK)', () => {
    assert.equal(report.blockedRequestsCount, 8, 'Phải có đúng 8 yêu cầu bị chặn hoàn toàn');
    assert.equal(report.allowedSafeRequestsCount, 1, 'Phải có đúng 1 yêu cầu an toàn được phép hoàn tất (6.7 DNS rebinding)');
  });

  it('tình huống 6.7 (DNS rebinding) trả outcome OK với IP công khai đã ghim và không kết nối 127.0.0.1', () => {
    const r67 = report.results.find((r) => r.id === '6.7')!;
    assert.ok(r67, 'Phải tìm thấy test 6.7');
    assert.equal(r67.expectedOutcome, 'OK');
    assert.equal(r67.expectedReason, 'PINNED_LOOKUP_PUBLIC_ALLOWED');
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
      assert.equal(r.expectedOutcome, 'BLOCKED');
      assert.equal(r.actualOutcome, 'BLOCKED');
      assert.equal(r.blocked, true);
      assert.equal(r.preventedInternalAccess, true);
    }
  });

  it('vệ sinh header: kiểm chứng thực tế trên 2/2 tình huống qua transport (6.7, 6.8) và 7 ca dừng trước transport', () => {
    assert.equal(report.transportRequestsCount, 2);
    assert.equal(report.headersVerifiedAtTransportCount, 2);
    assert.equal(report.blockedBeforeTransportCount, 7);
    assert.equal(report.sensitiveHeadersLeakedCount, 0, 'Phát hiện rò rỉ Cookie hoặc Authorization header!');

    for (const id of ['6.7', '6.8']) {
      const item = report.results.find((r) => r.id === id)!;
      assert.equal(item.transportRequestsCount, 1);
      assert.equal(item.headerAuditStatus, 'SANITIZED_AT_TRANSPORT');
      assert.equal(item.headersVerifiedAtTransport, true);
      assert.equal(item.headersSanitized, true);
      assert.deepEqual(item.leakedHeaderNames, []);
    }

    for (const id of ['6.1', '6.2', '6.3', '6.4', '6.5', '6.6', '6.9']) {
      const item = report.results.find((r) => r.id === id)!;
      assert.equal(item.transportRequestsCount, 0);
      assert.equal(item.headerAuditStatus, 'NOT_SENT_BLOCKED_BEFORE_TRANSPORT');
      assert.equal(item.headersVerifiedAtTransport, false);
      assert.equal(item.headersSanitized, null);
    }
  });

  for (const r of report.results) {
    it(`[${r.id}] ${r.name} -> ${r.passed ? 'PASS' : 'FAIL'} (${r.actualOutcome}: ${r.actualReason})`, () => {
      assert.equal(r.passed, true, `Phép thử ${r.id} không đạt: ${r.detail}`);
      assert.equal(r.noInternalConnection, true, `Phép thử ${r.id} kết nối tới IP nội bộ: ${r.contactedIps.join(', ')}`);
      assert.equal(r.noSensitiveHeadersLeaked, true, `Phép thử ${r.id} làm rò rỉ header nhạy cảm!`);
      if (r.transportRequestsCount > 0) {
        assert.equal(r.headersSanitized, true, `Phép thử ${r.id} chưa xác minh làm sạch header trên transport!`);
      } else {
        assert.equal(r.headersSanitized, null);
      }
    });
  }
});
