import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeUsageMetrics } from '../services/usageApi.js';

describe('Usage & Cost Avoided calculation (Q5 / KB2)', () => {
  it('tính chính xác tỷ lệ trúng TM, chi phí dịch máy và chi phí ước tính tránh được theo đơn giá 15 USD/1M ký tự', () => {
    const metrics = computeUsageMetrics(
      {
        tenant_id: 't_01hxyz987654',
        month: '2026-11',
        chars_machine_translated: 28_200,
        chars_from_memory: 65_800,
        chars_quota_used: 28_200,
        requests: 2_000,
        pages_served: 12,
      },
      'FREE',
    );

    assert.equal(metrics.character_limit, 200_000);
    assert.equal(metrics.total_chars_processed, 94_000);
    assert.equal(metrics.reserved_in_flight, 0);
    assert.equal(Number(metrics.quota_used_percent.toFixed(2)), 14.1);
    assert.equal(Number(metrics.tm_hit_rate_percent.toFixed(1)), 70.0);
    assert.equal(Number(metrics.estimated_machine_cost_usd.toFixed(3)), 0.423);
    assert.equal(Number(metrics.estimated_cost_avoided_usd.toFixed(3)), 0.987);
  });

  it('tách biệt số ký tự đang giữ chỗ tạm thời (reserved_in_flight) khi chars_quota_used > chars_machine_translated', () => {
    const metrics = computeUsageMetrics(
      {
        tenant_id: 't_usage',
        month: '2026-11',
        chars_machine_translated: 30,
        chars_from_memory: 10,
        chars_quota_used: 60,
        requests: 3,
        pages_served: 0,
      },
      'PRO',
    );

    assert.equal(metrics.character_limit, 2_000_000);
    assert.equal(metrics.reserved_in_flight, 30);
    assert.equal(metrics.tm_hit_rate_percent, 25);
  });
});
