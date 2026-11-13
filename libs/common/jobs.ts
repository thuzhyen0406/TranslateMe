/**
 * jobs – bản ghi công việc JOB dùng chung cho dịch tệp (FILE, F10) và dịch trước (PREWARM, F6).
 * Nhiệm vụ 4.5 (TV2) viết phần PREWARM; khóa và trạng thái theo QC-5 và Hình 2.9 của báo cáo.
 *
 *   PK = TENANT#<t>#JOB   SK = JOB#<jobId>   ttl = 7 ngày
 *   type: FILE | PREWARM; status: QUEUED -> RUNNING -> SUCCEEDED | FAILED
 *   total / done / failed: số đơn vị công việc (PREWARM: số cặp URL × ngôn ngữ đích); progress = (done + failed) / total
 *
 * Tra job của tenant khác luôn không thấy vì khóa đã chứa tenant (QC-2, nguyên tắc 1).
 * Mọi thao tác đi qua lớp data (`db` của libs/common/db.ts, hoặc bản giả cùng chữ ký khi kiểm thử) – QC-3.
 */
import type { Ctx } from './types.js';
import type { UsageReservation, UsageSource } from './usage/usage.js';

export type JobType = 'FILE' | 'PREWARM';
export type JobStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
export const JOB_TTL_DAYS = 7;
export const JOB_ID_RE = /^job-\d{8}-[0-9a-f]{12}$/;
/** Mã lô dịch trước (tên tệp lô không có đuôi, ví dụ lot-0003) */
export const LOT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Mục 2.6.6: {code, where, count, message} */
export interface JobWarning {
  code: string;
  where: string;
  count: number;
  message: string;
}

/** Phần lớp data cần dùng (khớp chữ ký db.get / db.put / db.update của libs/common/db.ts). */
export interface JobDb {
  get(ctx: Ctx, key: { PK: string; SK: string }, opts?: { consistent?: boolean }): Promise<Record<string, unknown> | null>;
  put(ctx: Ctx, item: Record<string, unknown>, conditionExpression?: string): Promise<void>;
  update(
    ctx: Ctx,
    params: {
      Key: { PK: string; SK: string };
      UpdateExpression: string;
      ConditionExpression?: string;
      ExpressionAttributeNames?: Record<string, string>;
      ExpressionAttributeValues?: Record<string, unknown>;
    },
  ): Promise<void>;
}

export interface JobSummary {
  job_id: string;
  type: JobType;
  status: JobStatus;
  /** 0–100 */
  progress: number;
  total: number;
  done: number;
  failed: number;
  slug?: string;
  target_langs: string[];
  warnings: JobWarning[];
  reason?: string;
  notification_status?: 'PENDING' | 'SUBMITTED' | 'FAILED';
  notification_error?: string;
  created_at: string;
  updated_at: string;
}

export const jobKey = (ctx: Ctx, jobId: string) => ({ PK: `TENANT#${ctx.tenantId}#JOB`, SK: `JOB#${jobId}` });

/** job-YYYYMMDD-<12 hex> */
export function newJobId(nowMs: number = Date.now(), random: () => string = () => globalThis.crypto.randomUUID()): string {
  const day = new Date(nowMs).toISOString().slice(0, 10).replace(/-/g, '');
  return `job-${day}-${random().replace(/-/g, '').slice(0, 12).toLowerCase()}`;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function toJobSummary(item: Record<string, unknown>): JobSummary {
  const total = num(item.total);
  const done = num(item.done);
  const failed = num(item.failed);
  const status = item.status as JobStatus;
  const progress = status === 'SUCCEEDED' ? 100 : total > 0 ? Math.min(100, Math.floor(((done + failed) * 100) / total)) : 0;
  const notificationStatus = typeof item.notificationStatus === 'string' ? item.notificationStatus as JobSummary['notification_status'] : undefined;
  const notificationError = typeof item.notificationError === 'string' ? item.notificationError : undefined;
  return {
    job_id: String(item.jobId ?? String(item.SK ?? '').slice(4)),
    type: item.type === 'FILE' ? 'FILE' : 'PREWARM',
    status,
    progress,
    total,
    done,
    failed,
    ...(typeof item.slug === 'string' ? { slug: item.slug } : {}),
    target_langs: Array.isArray(item.targetLangs) ? (item.targetLangs as string[]) : [],
    warnings: Array.isArray(item.warnings) ? (item.warnings as JobWarning[]) : [],
    ...(typeof item.reason === 'string' ? { reason: item.reason } : {}),
    ...(notificationStatus ? { notification_status: notificationStatus } : {}),
    ...(notificationError ? { notification_error: notificationError } : {}),
    created_at: String(item.createdAt ?? ''),
    updated_at: String(item.updatedAt ?? item.createdAt ?? ''),
  };
}

export function createJobStore(db: JobDb, now: () => number = Date.now) {
  const iso = () => new Date(now()).toISOString();

  /** Tạo JOB ở trạng thái QUEUED (C6, trước StartExecution). */
  async function create(ctx: Ctx, input: {
    jobId: string;
    type: JobType;
    slug?: string;
    targetLangs: string[];
    executionName?: string;
    file?: {
      fileKey: string;
      fileName: string;
      format: string;
      sourceLang?: string;
      sendEmail: boolean;
      estimatedCharacters: number;
      usageReservation?: UsageReservation;
      usageSource?: UsageSource;
      ownerSub?: string;
      notificationEmail?: string;
    };
  }): Promise<void> {
    const at = iso();
    await db.put(
      ctx,
      {
        ...jobKey(ctx, input.jobId),
        entityType: 'JOB',
        jobId: input.jobId,
        type: input.type,
        status: 'QUEUED' satisfies JobStatus,
        tenantId: ctx.tenantId,
        ...(input.slug ? { slug: input.slug } : {}),
        targetLangs: input.targetLangs,
        ...(input.file ? {
          fileKey: input.file.fileKey,
          fileName: input.file.fileName,
          format: input.file.format,
          ...(input.file.sourceLang ? { sourceLang: input.file.sourceLang } : {}),
          sendEmail: input.file.sendEmail,
          estimatedCharacters: input.file.estimatedCharacters,
          actualCharacters: 0,
          ...(input.file.usageReservation ? { usageReservation: input.file.usageReservation } : {}),
          ...(input.file.usageSource ? { usageSource: input.file.usageSource } : {}),
          ...(input.file.ownerSub ? { ownerSub: input.file.ownerSub } : {}),
          ...(input.file.notificationEmail ? { notificationEmail: input.file.notificationEmail } : {}),
          ...(input.file.sendEmail ? { notificationStatus: 'PENDING' } : {}),
        } : {}),
        total: 0,
        done: 0,
        failed: 0,
        warnings: [],
        // Lô đã cộng tiến độ (addProgress theo lotId): Map của Step Functions retry một lô thì không cộng lần nữa
        lots: {},
        createdAt: at,
        updatedAt: at,
        ttl: Math.floor(now() / 1000) + JOB_TTL_DAYS * 86_400,
      },
      'attribute_not_exists(PK)',
    );
  }

  /** State đầu tiên của Step Functions: QUEUED -> RUNNING, ghi tổng số đơn vị. Chạy lại được (đã RUNNING thì ghi đè total). */
  async function markRunning(ctx: Ctx, jobId: string, total: number, extra: { warnings?: JobWarning[]; executionArn?: string } = {}): Promise<void> {
    await db.update(ctx, {
      Key: jobKey(ctx, jobId),
      UpdateExpression: 'SET #status = :running, #total = :total, #warnings = :warnings, #updatedAt = :at' + (extra.executionArn ? ', #arn = :arn' : ''),
      ConditionExpression: '#status IN (:queued, :running)',
      ExpressionAttributeNames: {
        '#status': 'status',
        '#total': 'total',
        '#warnings': 'warnings',
        '#updatedAt': 'updatedAt',
        ...(extra.executionArn ? { '#arn': 'executionArn' } : {}),
      },
      ExpressionAttributeValues: {
        ':running': 'RUNNING',
        ':queued': 'QUEUED',
        ':total': total,
        ':warnings': extra.warnings ?? [],
        ':at': iso(),
        ...(extra.executionArn ? { ':arn': extra.executionArn } : {}),
      },
    });
  }

  /**
   * Cập nhật tiến độ sau mỗi lô (ADD nguyên tử, các lô của Map chạy song song).
   * Có `lotId` thì cộng đúng một lần cho mỗi lô: cùng một UpdateItem vừa ADD done/failed vừa đánh dấu `lots.<lotId>`,
   * điều kiện lô chưa được đánh dấu. Step Functions chạy lại lô (Retry sau khi đã cộng) thì trả false, không cộng thêm,
   * nên done + failed không vượt total. Trả true nếu đã cộng.
   * Job không ở RUNNING thì vẫn ném ConditionalCheckFailedException như trước.
   */
  async function addProgress(ctx: Ctx, jobId: string, done: number, failed: number, lotId?: string): Promise<boolean> {
    if (lotId !== undefined && !LOT_ID_RE.test(lotId)) throw Object.assign(new Error('lotId không hợp lệ'), { name: 'InvalidLotId' });
    try {
      await db.update(ctx, {
        Key: jobKey(ctx, jobId),
        UpdateExpression: 'ADD #done :done, #failed :failed SET #updatedAt = :at' + (lotId ? ', #lots.#lot = :true' : ''),
        ConditionExpression: '#status = :running' + (lotId ? ' AND attribute_not_exists(#lots.#lot)' : ''),
        ExpressionAttributeNames: {
          '#done': 'done',
          '#failed': 'failed',
          '#updatedAt': 'updatedAt',
          '#status': 'status',
          ...(lotId ? { '#lots': 'lots', '#lot': lotId } : {}),
        },
        ExpressionAttributeValues: { ':done': done, ':failed': failed, ':at': iso(), ':running': 'RUNNING', ...(lotId ? { ':true': true } : {}) },
      });
      return true;
    } catch (err) {
      if (!lotId || (err as { name?: string })?.name !== 'ConditionalCheckFailedException') throw err;
      const item = await db.get(ctx, jobKey(ctx, jobId), { consistent: true });
      const lots = item?.lots && typeof item.lots === 'object' ? (item.lots as Record<string, unknown>) : {};
      if (item?.status === 'RUNNING' && lots[lotId] === true) return false; // lô này đã được cộng
      throw err;
    }
  }

  /** Kết thúc công việc. Chỉ đổi được từ QUEUED/RUNNING (không ghi đè kết quả đã chốt). */
  async function finish(ctx: Ctx, jobId: string, result: { status: 'SUCCEEDED' | 'FAILED'; warnings?: JobWarning[]; reason?: string; failedRemaining?: number }): Promise<void> {
    const failedRemaining = result.failedRemaining ?? 0;
    await db.update(ctx, {
      Key: jobKey(ctx, jobId),
      UpdateExpression: 'SET #status = :status, #warnings = :warnings, #updatedAt = :at, #finishedAt = :at' + (result.reason ? ', #reason = :reason' : '') + (failedRemaining ? ' ADD #failed :failedRemaining' : ''),
      ConditionExpression: '#status IN (:queued, :running)',
      ExpressionAttributeNames: {
        '#status': 'status',
        '#warnings': 'warnings',
        '#updatedAt': 'updatedAt',
        '#finishedAt': 'finishedAt',
        ...(failedRemaining ? { '#failed': 'failed' } : {}),
        ...(result.reason ? { '#reason': 'reason' } : {}),
      },
      ExpressionAttributeValues: {
        ':status': result.status,
        ':warnings': result.warnings ?? [],
        ':at': iso(),
        ':queued': 'QUEUED',
        ':running': 'RUNNING',
        ...(failedRemaining ? { ':failedRemaining': failedRemaining } : {}),
        ...(result.reason ? { ':reason': result.reason } : {}),
      },
    });
  }

  async function get(ctx: Ctx, jobId: string): Promise<JobSummary | null> {
    if (!JOB_ID_RE.test(jobId)) return null;
    const item = await db.get(ctx, jobKey(ctx, jobId), { consistent: true });
    return item ? toJobSummary(item) : null;
  }

  return { create, markRunning, addProgress, finish, get };
}

export type JobStore = ReturnType<typeof createJobStore>;
