/**
 * usage – giao diện hạn mức và bộ đếm theo B.11 mà proxy, worker và prewarm gọi (QC-7).
 *  - usageServiceQuota: nối QuotaApi vào UsageService thật của TV3 (libs/common/usage, 2.7).
 *  - quotaStub: bản giả B.14, chỉ dùng khi chạy local không có TABLE_NAME.
 */
import { randomUUID } from 'node:crypto';
import type { Ctx } from '../../libs/common/types.js';
import type { ActualUsage, UsageReservation, UsageService } from '../../libs/common/usage/usage.js';

/** B.11: tháng cố định lúc đặt trước (UTC, YYYY-MM) */
export interface Reservation {
  month: string;
  reserved: number;
  /** Vé của UsageService; không có với phiếu rỗng (không có câu trượt) và với quotaStub. */
  ticket?: UsageReservation;
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

// ============================================================================
// Nối UsageService thật (QC-7)
// ============================================================================

export type UsageServiceApi = Pick<UsageService, 'reserve' | 'settle' | 'refund'>;

export interface UsageServiceQuotaOptions {
  /** Phần ngẫu nhiên của requestId đặt trước; mặc định randomUUID (thay được trong test). */
  newId?: () => string;
}

/** Độ dài tối đa phần requestId gốc (Lambda requestId, prewarm-<jobId>…) giữ trong khoá RESERVATION#. */
const MAX_BASE_REQUEST_ID = 100;

function webSource(ctx: Ctx): UsageSource {
  if (!ctx.slug) throw new TypeError('Usage WEB cần ctx.slug');
  return { kind: 'WEB', slug: ctx.slug };
}

function sameWebSource(a: UsageSource, b: UsageSource): boolean {
  return a.kind === 'WEB' && b.kind === 'WEB' && a.slug === b.slug;
}

/**
 * QuotaApi trên UsageService (reserve/settle/refund theo tháng UTC cố định lúc đặt trước).
 *
 * requestId của mỗi lần đặt trước luôn mới (`<ctx.requestId>:<uuid>`): một lượt proxy, mỗi sự kiện worker
 * và mỗi trang prewarm là một phiếu riêng. Worker nhận lại requestId của proxy và các trang prewarm dùng chung
 * `prewarm-<jobId>`, nên nếu dùng nguyên ctx.requestId thì phiếu sau sẽ đụng phiếu đã SETTLED của lượt trước.
 * Lambda chạy lại (worker bất đồng bộ, Step Functions retry) tra lại TM trước, nên không dịch và tính trùng.
 *
 * Trang không có câu trượt (B.11: không gọi reserveChars) vẫn cần ghi memoryChars/requests/pagesServed;
 * UsageService chỉ quyết toán được phiếu đã đặt, nên settleUsage tự đặt phiếu 0 ký tự rồi quyết toán.
 */
export function usageServiceQuota(service: UsageServiceApi, options: UsageServiceQuotaOptions = {}): QuotaApi {
  const newId = options.newId ?? randomUUID;
  const requestIdFor = (ctx: Ctx): string => `${(ctx.requestId || 'web').slice(0, MAX_BASE_REQUEST_ID)}:${newId()}`;
  const reserve = async (ctx: Ctx, n: number, source: UsageSource): Promise<UsageReservation> =>
    service.reserve({ tenantId: ctx.tenantId, requestId: requestIdFor(ctx), n, source });

  return {
    async reserveChars(ctx, n) {
      // CharacterQuotaExceededError của UsageService có code CHAR_QUOTA_EXCEEDED nên isCharQuotaExceeded nhận ra
      const ticket = await reserve(ctx, n, webSource(ctx));
      return { month: ticket.month, reserved: ticket.reservedChars, ticket };
    },
    async releaseChars(_ctx, r) {
      if (r.ticket) await service.refund(r.ticket);
    },
    async settleUsage(ctx, r, source, u) {
      if (source.kind !== 'WEB') throw new TypeError('Proxy chỉ quyết toán nguồn WEB');
      let ticket = r.ticket;
      if (!ticket) {
        if (r.reserved !== 0 || u.machineChars !== 0) {
          throw new TypeError('settleUsage có ký tự dịch máy nhưng không có phiếu đặt trước');
        }
        ticket = await reserve(ctx, 0, source);
      } else if (!sameWebSource(ticket.source, source)) {
        throw new TypeError('Nguồn quyết toán khác nguồn đã đặt trước');
      }
      const actual: ActualUsage = {
        machineChars: u.machineChars,
        memoryChars: u.memoryChars,
        tmHits: u.sentFromTM,
        tmMisses: Math.max(0, u.sentTotal - u.sentFromTM),
        pagesServed: u.pagesServed ?? 0,
        requests: u.requests,
      };
      await service.settle(ticket, actual);
    },
  };
}
