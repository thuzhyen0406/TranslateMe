import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { AuthenticatedSession } from '../types/auth.js';
import {
  computeUsageMetrics,
  currentMonthUtc,
  DEFAULT_PRICE_REFERENCED_AT,
  DEFAULT_TRANSLATE_PRICE_USD_PER_MILLION,
  fetchTenantCustomLimit,
  fetchTenantUsage,
  resolveTenantCharacterLimit,
  type ComputedUsageMetrics,
  type SessionWithOptionalLimit,
} from '../services/usageApi.js';

function formatNumber(n: number): string {
  return new Intl.NumberFormat('vi-VN').format(Math.round(n));
}

function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function buildRecentMonths(baseMonth: string, count = 6): string[] {
  const [yStr, mStr] = baseMonth.split('-');
  let year = Number(yStr) || new Date().getUTCFullYear();
  let month = Number(mStr) || new Date().getUTCMonth() + 1;
  const list: string[] = [];
  for (let i = 0; i < count; i++) {
    list.push(`${year}-${String(month).padStart(2, '0')}`);
    month -= 1;
    if (month < 1) {
      month = 12;
      year -= 1;
    }
  }
  return list;
}

export const UsagePage: React.FC<{ session: AuthenticatedSession }> = ({ session }) => {
  const defaultMonth = useMemo(() => currentMonthUtc(), []);
  const recentMonths = useMemo(() => buildRecentMonths(defaultMonth, 6), [defaultMonth]);
  const [month, setMonth] = useState<string>(defaultMonth);
  const [metrics, setMetrics] = useState<ComputedUsageMetrics | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>('');

  const loadUsage = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const sessionWithLimit = session as SessionWithOptionalLimit;
      const [rawUsage, profileLimit] = await Promise.all([
        fetchTenantUsage(sessionWithLimit, month),
        fetchTenantCustomLimit(sessionWithLimit),
      ]);
      const effectiveLimit = resolveTenantCharacterLimit(
        sessionWithLimit,
        rawUsage,
        profileLimit,
      );
      setMetrics(computeUsageMetrics(rawUsage, session.plan, effectiveLimit));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Không thể tải báo cáo lượng dùng.');
    } finally {
      setLoading(false);
    }
  }, [session, month]);

  useEffect(() => {
    void loadUsage();
  }, [loadUsage]);

  const quotaColorClass = useMemo(() => {
    if (!metrics) return 'bg-[#146c54]';
    if (metrics.quota_used_percent >= 100) return 'bg-red-600';
    if (metrics.quota_used_percent >= 80) return 'bg-amber-500';
    return 'bg-[#146c54]';
  }, [metrics]);

  return (
    <div className="mx-auto max-w-6xl p-6 md:p-9">
      {/* Tiêu đề trang & Bộ chọn kỳ báo cáo */}
      <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-[#146c54]">
            Đo lường lượng dùng & FinOps (Q5)
          </p>
          <h1 className="mt-1 text-2xl font-bold text-gray-800">
            Báo cáo lượng dùng & Chi phí ước tính tránh được
          </h1>
          <p className="mt-1.5 text-sm text-gray-500">
            Theo dõi số ký tự dịch máy, số ký tự tái sử dụng từ Bộ nhớ dịch (TM) và số tiền tiết kiệm được của tổ chức{' '}
            <strong className="text-gray-700">{session.organizationName}</strong>.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <label className="text-xs font-semibold text-gray-600" htmlFor="usage-month-select">
            Kỳ báo cáo (UTC):
          </label>
          <select
            id="usage-month-select"
            aria-label="Chọn tháng báo cáo"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 outline-none focus:border-[#146c54] focus:ring-2 focus:ring-[#146c54]/15"
          >
            {recentMonths.map((m) => (
              <option key={m} value={m}>
                Tháng {m}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void loadUsage()}
            disabled={loading}
            className="rounded-lg bg-[#146c54] px-3.5 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#0f5945] disabled:opacity-50"
          >
            {loading ? 'Đang tải…' : 'Làm mới số liệu'}
          </button>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="mb-5 rounded-lg border border-red-200 bg-red-50 p-3.5 text-sm text-red-700"
        >
          {error}
        </div>
      )}

      {/* Thanh tiến độ hạn mức ký tự tháng */}
      {metrics && (
        <section className="mb-6 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-semibold text-gray-800">
                  Hạn mức ký tự dịch máy tháng {metrics.month}
                </h2>
                <span className="rounded-full bg-[#e6f2ee] px-2.5 py-0.5 text-xs font-semibold text-[#146c54]">
                  Gói {session.plan}
                </span>
                {metrics.is_custom_limit && (
                  <span
                    data-testid="badge-custom-limit"
                    className="rounded-full bg-amber-50 border border-amber-200 px-2.5 py-0.5 text-xs font-semibold text-amber-800"
                  >
                    Hạn mức riêng: {formatNumber(metrics.character_limit)} ký tự
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs text-gray-500">
                Kiểm soát nguyên tử qua <code className="text-gray-700">reserveChars</code> /{' '}
                <code className="text-gray-700">settleUsage</code>. Khi chạm trần ký tự dịch máy, các câu đã có trong Bộ nhớ dịch (TM) vẫn trả về{' '}
                <code className="text-gray-700">200 OK</code> bình thường.
              </p>
            </div>
            <div className="text-right">
              <div className="text-lg font-bold text-gray-800">
                {formatNumber(metrics.chars_quota_used)}{' '}
                <span className="text-sm font-normal text-gray-500">
                  / {formatNumber(metrics.character_limit)} ký tự ({metrics.quota_used_percent.toFixed(1)}%)
                </span>
              </div>
              {metrics.reserved_in_flight > 0 && (
                <div className="text-xs text-amber-700">
                  Đang giữ chỗ tạm thời: {formatNumber(metrics.reserved_in_flight)} ký tự
                </div>
              )}
            </div>
          </div>

          <div className="mt-3 h-3 w-full overflow-hidden rounded-full bg-gray-100">
            <div
              className={`h-full transition-all duration-300 ${quotaColorClass}`}
              style={{
                width: `${
                  metrics.quota_used_percent <= 0
                    ? 0
                    : Math.min(100, Math.max(1, metrics.quota_used_percent))
                }%`,
              }}
            />
          </div>
        </section>
      )}

      {/* 4 Thẻ chỉ số cốt lõi (KPI Cards) */}
      {metrics && (
        <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
            <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              1. Ký tự dịch máy (Translate)
            </div>
            <div
              data-testid="metric-machine-chars"
              className="mt-2 text-2xl font-bold text-gray-800"
            >
              {formatNumber(metrics.chars_machine_translated)}
            </div>
            <p className="mt-1.5 text-xs text-gray-500">
              Ký tự câu mới gửi sang Amazon Translate (tính vào hạn mức tháng).
            </p>
          </div>

          <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
            <div className="text-xs font-semibold uppercase tracking-wide text-[#146c54]">
              2. Ký tự từ Bộ nhớ dịch (TM)
            </div>
            <div
              data-testid="metric-tm-chars"
              className="mt-2 text-2xl font-bold text-[#146c54]"
            >
              {formatNumber(metrics.chars_from_memory)}
            </div>
            <p className="mt-1.5 text-xs text-gray-500">
              Tái sử dụng tức thời từ bảng đơn DynamoDB (miễn phí dịch máy 100%).
            </p>
          </div>

          <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
            <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              3. Tỷ lệ trúng TM (Hit Rate)
            </div>
            <div
              data-testid="metric-tm-hit-rate"
              className="mt-2 text-2xl font-bold text-gray-800"
            >
              {metrics.tm_hit_rate_percent.toFixed(1)}%
            </div>
            <p className="mt-1.5 text-xs text-gray-500">
              Tổng xử lý: <strong>{formatNumber(metrics.total_chars_processed)}</strong> ký tự (TM + Dịch máy).
            </p>
          </div>

          <div className="rounded-xl border border-[#b8dfd3] bg-[#f2faf7] p-5 shadow-sm">
            <div className="text-xs font-bold uppercase tracking-wide text-[#146c54]">
              4. Chi phí ước tính tránh được
            </div>
            <div
              data-testid="metric-cost-avoided"
              className="mt-2 text-2xl font-bold text-[#146c54]"
            >
              {formatUsd(metrics.estimated_cost_avoided_usd)}
            </div>
            <p className="mt-1.5 text-xs text-gray-600">
              Chi phí dịch máy thực tế:{' '}
              <strong data-testid="metric-machine-cost" className="text-gray-800">
                {formatUsd(metrics.estimated_machine_cost_usd)}
              </strong>{' '}
              (đơn giá {DEFAULT_TRANSLATE_PRICE_USD_PER_MILLION} USD/1M ký tự).
            </p>
          </div>
        </div>
      )}

      {/* Bảng tổng hợp số liệu cấp tổ chức & Công thức quy đổi chi phí */}
      {metrics && (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
          <section className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
            <div className="border-b border-gray-100 px-5 py-4">
              <h2 className="font-semibold text-gray-800">
                Tổng hợp lưu lượng cấp tổ chức trong kỳ ({metrics.month})
              </h2>
              <p className="mt-1 text-xs text-gray-500">
                Số liệu tổng hợp toàn tổ chức từ bản ghi{' '}
                <code className="text-gray-700">PK = TENANT#{metrics.tenant_id}#USAGE</code>,{' '}
                <code className="text-gray-700">SK = MONTH#{metrics.month}</code> (gộp chung lưu lượng từ Website Proxy, REST API và Web Console).
              </p>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="px-5 py-3">Bộ đếm tổng hợp của tổ chức</th>
                    <th className="px-4 py-3">Trường phản hồi (/console/usage)</th>
                    <th className="px-5 py-3 text-right">Giá trị ghi nhận</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  <tr>
                    <td className="px-5 py-3.5 font-medium text-gray-800">
                      Ký tự dịch máy thực tế đã quyết toán
                    </td>
                    <td className="px-4 py-3.5 font-mono text-xs text-gray-500">
                      chars_machine_translated
                    </td>
                    <td className="px-5 py-3.5 text-right font-semibold text-gray-800">
                      {formatNumber(metrics.chars_machine_translated)} ký tự
                    </td>
                  </tr>
                  <tr>
                    <td className="px-5 py-3.5 font-medium text-gray-800">
                      Ký tự tính vào hạn mức tháng (gồm cả giữ chỗ)
                    </td>
                    <td className="px-4 py-3.5 font-mono text-xs text-gray-500">
                      chars_quota_used / character_limit
                    </td>
                    <td className="px-5 py-3.5 text-right font-semibold text-gray-800">
                      {formatNumber(metrics.chars_quota_used)} / {formatNumber(metrics.character_limit)} ký tự
                    </td>
                  </tr>
                  <tr>
                    <td className="px-5 py-3.5 font-medium text-gray-800">
                      Ký tự phục vụ từ Bộ nhớ dịch (TM)
                    </td>
                    <td className="px-4 py-3.5 font-mono text-xs text-gray-500">
                      chars_from_memory
                    </td>
                    <td className="px-5 py-3.5 text-right font-semibold text-[#146c54]">
                      {formatNumber(metrics.chars_from_memory)} ký tự ({formatUsd(metrics.estimated_cost_avoided_usd)})
                    </td>
                  </tr>
                  <tr>
                    <td className="px-5 py-3.5 font-medium text-gray-800">
                      Tổng số lượt yêu cầu dịch trong tháng
                    </td>
                    <td className="px-4 py-3.5 font-mono text-xs text-gray-500">
                      requests
                    </td>
                    <td className="px-5 py-3.5 text-right font-semibold text-gray-800">
                      {formatNumber(metrics.requests)} yêu cầu
                    </td>
                  </tr>
                  <tr>
                    <td className="px-5 py-3.5 font-medium text-gray-800">
                      Tổng số trang Website Proxy đã phục vụ
                    </td>
                    <td className="px-4 py-3.5 font-mono text-xs text-gray-500">
                      pages_served
                    </td>
                    <td className="px-5 py-3.5 text-right font-semibold text-gray-800">
                      {formatNumber(metrics.pages_served)} trang
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section className="h-fit rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
            <h2 className="font-semibold text-gray-800">Cơ sở tính toán chi phí</h2>
            <div className="mt-3 space-y-2.5 text-xs leading-5 text-gray-600">
              <div className="rounded-lg bg-gray-50 p-3">
                <div className="font-semibold text-gray-800">Đơn giá tham chiếu AWS Translate</div>
                <div className="mt-1">
                  <strong>{DEFAULT_TRANSLATE_PRICE_USD_PER_MILLION.toFixed(2)} USD</strong> / 1.000.000 ký tự
                  (chế độ Standard Pay-as-you-go, tra cứu ngày{' '}
                  <code className="text-gray-700">{DEFAULT_PRICE_REFERENCED_AT}</code>).
                </div>
              </div>
              <p>
                • <strong>Chi phí dịch máy ước tính:</strong>{' '}
                <code>chars_machine_translated × 15 / 1.000.000</code>
              </p>
              <p>
                • <strong>Chi phí ước tính tránh được nhờ TM:</strong>{' '}
                <code>chars_from_memory × 15 / 1.000.000</code>
              </p>
              <p className="text-gray-500">
                Mọi câu trùng lặp giữa Website Proxy, API dịch tức thời và dịch tệp hàng loạt đều dùng chung một Bộ nhớ dịch (TM) của tổ chức.
              </p>
            </div>
          </section>
        </div>
      )}
    </div>
  );
};
