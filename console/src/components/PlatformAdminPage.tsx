import React, { useCallback, useEffect, useState } from 'react';
import type { AuthenticatedSession } from '../types/auth.js';
import {
  DEFAULT_PRICE_REFERENCED_AT,
  DEFAULT_TRANSLATE_PRICE_USD_PER_MILLION,
  listPlatformTenants,
  parseCharacterLimitInput,
  updatePlatformTenantLimit,
  updatePlatformTenantStatus,
  type PlatformTenantSummary,
} from '../services/usageApi.js';

function formatNumber(n: number): string {
  return new Intl.NumberFormat('vi-VN').format(Math.round(n));
}

export const PlatformAdminPage: React.FC<{
  session: AuthenticatedSession;
  mode?: 'tenants' | 'pricing';
}> = ({ session, mode = 'tenants' }) => {
  const [tenants, setTenants] = useState<PlatformTenantSummary[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [busyId, setBusyId] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [limitDrafts, setLimitDrafts] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    if (mode === 'pricing') {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const items = await listPlatformTenants(session);
      setTenants(items);
      setLimitDrafts(
        Object.fromEntries(
          items.map((t) => [t.tenant_id, String(t.character_limit ?? 200_000)]),
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Không thể tải danh sách khách hàng.');
    } finally {
      setLoading(false);
    }
  }, [session, mode]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleToggleStatus = async (row: PlatformTenantSummary) => {
    const nextStatus: 'ACTIVE' | 'LOCKED' = row.status === 'LOCKED' ? 'ACTIVE' : 'LOCKED';
    setBusyId(row.tenant_id);
    setError('');
    try {
      await updatePlatformTenantStatus(session, row.tenant_id, nextStatus);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Không thể cập nhật trạng thái tenant.');
    } finally {
      setBusyId('');
    }
  };

  const handleSaveLimit = async (row: PlatformTenantSummary) => {
    const limit = parseCharacterLimitInput(limitDrafts[row.tenant_id] ?? String(row.character_limit ?? 200_000));
    if (limit === undefined) {
      setError('Nhập hạn mức ký tự là số nguyên không âm.');
      return;
    }
    setBusyId(row.tenant_id);
    setError('');
    try {
      await updatePlatformTenantLimit(session, row.tenant_id, limit);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Không thể cập nhật hạn mức ký tự.');
    } finally {
      setBusyId('');
    }
  };

  if (mode === 'pricing') {
    return (
      <div className="mx-auto max-w-4xl p-6 md:p-9">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs font-bold uppercase tracking-wider text-[#146c54]">
            Thông tin tham chiếu hệ thống (F11)
          </p>
          <span className="rounded-full bg-slate-100 border border-slate-200 px-2.5 py-0.5 text-xs font-semibold text-slate-600">
            Chỉ đọc (Tĩnh)
          </span>
        </div>
        <h1 className="mt-1 text-2xl font-bold text-gray-800">
          Thông tin đơn giá tham chiếu & Ngưỡng ngân sách mặc định
        </h1>
        <p className="mt-2 text-sm text-gray-500">
          Trang tra cứu tĩnh hiển thị các hằng số tham chiếu của nền tảng (được thiết lập qua mã hạ tầng CloudFormation{' '}
          <code className="text-gray-700">infra/stacks/ops.yaml</code> và tệp hạt giống{' '}
          <code className="text-gray-700">e2e/demo/platform-config.json</code>) dùng để quy đổi chi phí dịch máy và chi phí ước tính tránh được trên báo cáo lượng dùng.
        </p>

        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
            <div className="text-xs font-semibold uppercase text-gray-500">
              Đơn giá tham chiếu Amazon Translate (Pay-as-you-go)
            </div>
            <div className="mt-2 text-2xl font-bold text-[#146c54]">
              ${DEFAULT_TRANSLATE_PRICE_USD_PER_MILLION.toFixed(2)} / 1.000.000 ký tự
            </div>
            <p className="mt-2 text-xs text-gray-500">
              Ngày tra cứu tham chiếu: <code>{DEFAULT_PRICE_REFERENCED_AT}</code> (nguồn biểu giá chuẩn của AWS Amazon Translate).
            </p>
          </div>

          <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
            <div className="text-xs font-semibold uppercase text-gray-500">
              Ngưỡng cảnh báo AWS Budgets mặc định (IaC)
            </div>
            <div className="mt-2 text-2xl font-bold text-gray-800">$20.00 / tháng</div>
            <p className="mt-2 text-xs text-gray-500">
              Cấu hình trong <code>ops.yaml</code> (`TranslateMeMonthlyBudget`): gửi cảnh báo SNS tại các mốc 50% ($10), 80% ($16) và dự báo 100% ($20).
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl p-6 md:p-9">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-[#146c54]">
            Quản trị toàn nền tảng (Platform Admin – Q5 / F11)
          </p>
          <h1 className="mt-1 text-2xl font-bold text-gray-800">
            Danh sách tổ chức khách hàng (Tenants)
          </h1>
          <p className="mt-1.5 text-sm text-gray-500">
            Kiểm soát trạng thái hoạt động (<code className="text-gray-700">ACTIVE / LOCKED</code>) và hạn mức ký tự tháng. Platform Admin bị chặn tuyệt đối không đọc được nội dung câu dịch (TM) hay thuật ngữ của khách hàng.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className="rounded-lg bg-[#146c54] px-3.5 py-2 text-sm font-semibold text-white hover:bg-[#0f5945] disabled:opacity-50"
        >
          {loading ? 'Đang tải…' : 'Làm mới danh sách'}
        </button>
      </div>

      {error && (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"
        >
          {error}
        </div>
      )}

      <section className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-5 py-3">Tenant ID / Tổ chức</th>
                <th className="px-4 py-3">Gói</th>
                <th className="px-4 py-3">Trạng thái</th>
                <th className="px-4 py-3">Hạn mức ký tự/tháng</th>
                <th className="px-5 py-3 text-right">Thao tác quản trị</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {tenants.map((row) => (
                <tr key={row.tenant_id}>
                  <td className="px-5 py-4">
                    <div className="font-semibold text-gray-800">
                      {row.organization_name ?? row.tenant_id}
                    </div>
                    <code className="text-xs text-gray-400">{row.tenant_id}</code>
                  </td>
                  <td className="px-4 py-4 font-medium text-gray-700">
                    {row.plan ?? 'FREE'}
                  </td>
                  <td className="px-4 py-4">
                    <span
                      className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                        row.status === 'LOCKED'
                          ? 'bg-red-50 text-red-700'
                          : 'bg-green-50 text-green-700'
                      }`}
                    >
                      {row.status === 'LOCKED' ? 'Đã khóa (LOCKED)' : 'Hoạt động (ACTIVE)'}
                    </span>
                  </td>
                  <td className="px-4 py-4">
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        aria-label={`Hạn mức cho ${row.tenant_id}`}
                        value={limitDrafts[row.tenant_id] ?? String(row.character_limit ?? 200_000)}
                        onChange={(e) =>
                          setLimitDrafts((prev) => ({
                            ...prev,
                            [row.tenant_id]: e.target.value,
                          }))
                        }
                        className="w-32 rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm"
                      />
                      <button
                        type="button"
                        disabled={busyId === row.tenant_id}
                        onClick={() => void handleSaveLimit(row)}
                        className="rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-100"
                      >
                        Lưu ({formatNumber(Number(row.character_limit ?? 200_000))})
                      </button>
                    </div>
                  </td>
                  <td className="px-5 py-4 text-right">
                    <button
                      type="button"
                      disabled={busyId === row.tenant_id}
                      onClick={() => void handleToggleStatus(row)}
                      className={`rounded-lg px-3 py-1.5 text-xs font-semibold text-white ${
                        row.status === 'LOCKED'
                          ? 'bg-[#146c54] hover:bg-[#0f5945]'
                          : 'bg-red-600 hover:bg-red-700'
                      }`}
                    >
                      {row.status === 'LOCKED' ? 'Mở khóa (ACTIVE)' : 'Khóa Tenant (LOCKED)'}
                    </button>
                  </td>
                </tr>
              ))}
              {!tenants.length && !loading && (
                <tr>
                  <td colSpan={5} className="px-5 py-10 text-center text-sm text-gray-400">
                    Chưa có tenant nào được ghi nhận.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};
