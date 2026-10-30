/**
 * usage – giao diện hạn mức và bộ đếm theo B.11 (2.7 của TV3) mà proxy và worker gọi, kèm bản giả B.14.
 * Khi TV3 có reserveChars/releaseChars/settleUsage thật trong libs/common thì truyền vào ProxyDeps.quota
 * và WorkerDeps.quota; proxy không phải sửa.
 */
import type { Ctx } from '../../libs/common/types.js';

/** B.11: tháng cố định lúc đặt trước (UTC, YYYY-MM) */
export interface Reservation {
  month: string;
  reserved: number;
}

/** B.2 */
export type UsageSource = { kind: 'WEB'; slug: string } | { kind: 'CONSOLE' } | { kind: 'API'; keyId: string };

export interface UsageCounters {
  machineChars: number;
  memoryChars: number;
  sentTotal: number;
  sentFromTM: number;
  requests: number;
  pagesServed?: number;
}

export interface QuotaApi {
  /** throw lỗi có code CHAR_QUOTA_EXCEEDED khi n vượt hạn mức hoặc phần còn lại */
  reserveChars(ctx: Ctx, n: number): Promise<Reservation>;
  releaseChars(ctx: Ctx, r: Reservation): Promise<void>;
  settleUsage(ctx: Ctx, r: Reservation, source: UsageSource, u: UsageCounters): Promise<void>;
}

export const utcMonth = (ms: number = Date.now()): string => new Date(ms).toISOString().slice(0, 7);

/** Phiếu rỗng: dùng cho settleUsage khi không có câu trượt (B.11: không gọi reserveChars). */
export const emptyReservation = (ms?: number): Reservation => ({ month: utcMonth(ms), reserved: 0 });

export function isCharQuotaExceeded(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; name?: unknown };
  return e.code === 'CHAR_QUOTA_EXCEEDED' || e.name === 'CHAR_QUOTA_EXCEEDED';
}

/** Bản giả B.14: reserveChars luôn thành công, settleUsage chỉ ghi log. */
export function quotaStub(log: (entry: Record<string, unknown>) => void = () => {}): QuotaApi {
  return {
    async reserveChars(_ctx, n) {
      return { month: utcMonth(), reserved: n };
    },
    async releaseChars() {},
    async settleUsage(ctx, r, source, u) {
      log({ action: 'USAGE_STUB_SETTLE', tenantId: ctx.tenantId, month: r.month, reserved: r.reserved, source, ...u });
    },
  };
}
