import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AuthenticatedSession } from '../types/auth.js';
import {
  computeUsageMetrics,
  resolveTenantCharacterLimit,
  updatePlatformTenantLimit,
} from '../services/usageApi.js';

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
    assert.equal(metrics.is_custom_limit, false);
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
    assert.equal(metrics.is_custom_limit, false);
    assert.equal(metrics.reserved_in_flight, 30);
    assert.equal(metrics.tm_hit_rate_percent, 25);
  });

  it('ưu tiên hạn mức riêng (customLimit hoặc raw.character_limit) khi khác mức mặc định của gói và xử lý đúng hạn mức bằng 0', () => {
    // 1. Truyền customLimit = 50.000 cho tenant gói FREE (mặc định 200.000) -> 25.000 / 50.000 = 50%
    const withCustomParam = computeUsageMetrics(
      {
        tenant_id: 't_custom_1',
        month: '2026-11',
        chars_machine_translated: 25_000,
        chars_from_memory: 25_000,
        chars_quota_used: 25_000,
        requests: 120,
        pages_served: 4,
      },
      'FREE',
      50_000,
    );
    assert.equal(withCustomParam.character_limit, 50_000);
    assert.equal(withCustomParam.is_custom_limit, true);
    assert.equal(withCustomParam.quota_used_percent, 50);

    // 2. Nhận trực tiếp character_limit từ phản hồi API -> ghi đè mức mặc định của gói PRO (2.000.000)
    const withPayloadLimit = computeUsageMetrics(
      {
        tenant_id: 't_custom_2',
        month: '2026-11',
        chars_machine_translated: 40_000,
        chars_from_memory: 10_000,
        chars_quota_used: 40_000,
        requests: 80,
        pages_served: 2,
        character_limit: 80_000,
      },
      'PRO',
    );
    assert.equal(withPayloadLimit.character_limit, 80_000);
    assert.equal(withPayloadLimit.is_custom_limit, true);
    assert.equal(withPayloadLimit.quota_used_percent, 50);

    // 3. Hạn mức riêng bằng 0 (khóa hạn mức dịch máy) -> không bị bỏ qua như falsy
    const withZeroLimit = computeUsageMetrics(
      {
        tenant_id: 't_zero',
        month: '2026-11',
        chars_machine_translated: 100,
        chars_from_memory: 500,
        chars_quota_used: 100,
        requests: 5,
        pages_served: 1,
      },
      'FREE',
      0,
    );
    assert.equal(withZeroLimit.character_limit, 0);
    assert.equal(withZeroLimit.is_custom_limit, true);
    assert.equal(withZeroLimit.quota_used_percent, 100);
  });

  it('resolveTenantCharacterLimit đồng bộ hạn mức riêng từ API/session hoặc sau khi Platform Admin cập nhật', async () => {
    const baseSession = {
      tenantId: 't_custom_sync',
      plan: 'FREE',
      role: 'TENANT_ADMIN',
      idToken: 'token',
    } as AuthenticatedSession;

    // Mặc định theo gói FREE (200.000) khi chưa có hạn mức riêng
    assert.equal(resolveTenantCharacterLimit(baseSession, null), 200_000);

    // Lấy từ session.characterLimit nếu có
    assert.equal(
      resolveTenantCharacterLimit({ ...baseSession, characterLimit: 350_000 }, null),
      350_000,
    );

    // Lấy từ profileLimit (/console/me) nếu có
    assert.equal(
      resolveTenantCharacterLimit({ ...baseSession, characterLimit: 350_000 }, null, 450_000),
      450_000,
    );

    // Lấy từ usage.character_limit nếu API /console/usage trả kèm
    assert.equal(
      resolveTenantCharacterLimit(
        { ...baseSession, characterLimit: 350_000 },
        { character_limit: 600_000 },
        450_000,
      ),
      600_000,
    );

    // Khi Platform Admin cập nhật hạn mức riêng cho tenant, resolveTenantCharacterLimit phản ánh ngay
    await updatePlatformTenantLimit(baseSession, 't_custom_sync', 75_000);
    assert.equal(resolveTenantCharacterLimit(baseSession, null), 75_000);
  });
});
