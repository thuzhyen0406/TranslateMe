/**
 * Dịch trước theo sitemap – phần C6 (F6, Nhiệm vụ 4.5 – TV2). Mục 2.5.3 và thông điệp M2 của báo cáo.
 *
 *   POST /console/hosts/{slug}/prewarm   (Tenant Admin) -> 202 { job }   tạo JOB (QUEUED) rồi StartExecution PREWARM
 *   GET  /console/hosts/{slug}/prewarm   (Tenant Admin) -> 200 { job }   lần dịch trước gần nhất của website (null nếu chưa có)
 *   GET  /console/jobs/{jobId}           (Tenant Admin, Developer) -> 200 { job }
 *
 *  - Kiểm tra: phiên console (JWT), vai trò theo Bảng 1.2, tenant ACTIVE, website tồn tại và đã xác minh (ACTIVE).
 *  - Ngôn ngữ: mặc định mọi ngôn ngữ đích đang bật của website; body.target_langs (nếu có) phải nằm trong số đó.
 *  - Mỗi website chỉ có một lần dịch trước đang chạy: HOST.prewarm giữ job gần nhất; nếu job đó còn QUEUED/RUNNING
 *    (chưa quá PREWARM_STALE_MS) thì trả lại chính job đó (bấm nhiều lần không tạo nhiều lần chạy, không tốn ký tự trùng).
 *  - M2 chỉ mang định danh: { job_id, tenant_id, slug, target_langs }. Địa chỉ sitemap lấy từ HOST ở ReadSitemap (QC-6).
 *  - StartExecution lỗi: JOB -> FAILED (START_FAILED), trả 500 INTERNAL_ERROR.
 *
 * Step Functions được truyền vào qua cổng `startExecution` (bản thật: stepFunctionsStarter), nên services/api không
 * phụ thuộc @aws-sdk/client-sfn cho tới khi nối hạ tầng.
 */
import { createJobStore, newJobId, type JobDb, type JobSummary } from '../../../libs/common/jobs.js';
import { AppError, keys, type Ctx, type Role } from '../../../libs/common/types.js';

export const PREWARM_STALE_MS = 6 * 3600_000;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const LANG_RE = /^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/;

export interface PrewarmManagerDeps {
  db: JobDb;
  /** StartExecution của state machine PREWARM; name = job_id (Step Functions chặn trùng tên trong 90 ngày) */
  startExecution(input: { name: string; input: string }): Promise<{ executionArn?: string }>;
  now?: () => number;
  uuid?: () => string;
}

function requireConsoleRole(ctx: Ctx, allowed: readonly Role[]): void {
  if (ctx.via !== 'JWT' || !ctx.tenantId) throw new AppError('UNAUTHORIZED', 'Thao tác yêu cầu phiên console đã đăng nhập.');
  // FORBIDDEN của lớp data được trả ra ngoài thành PERMISSION_DENIED (QC-2), xem handlePrewarmRoute
  if (!ctx.role || !allowed.includes(ctx.role)) throw new AppError('FORBIDDEN', 'Vai trò hiện tại không được phép thực hiện thao tác này.');
}

async function requireActiveTenant(ctx: Ctx, db: JobDb): Promise<void> {
  const config = await db.get(ctx, keys.config(ctx), { consistent: true });
  if (!config) throw new AppError('NOT_FOUND', 'Không tìm thấy tenant.');
  if (config.status !== 'ACTIVE') throw new AppError('TENANT_SUSPENDED', 'Tenant đang bị tạm khóa.');
}

async function getHost(ctx: Ctx, slug: string, db: JobDb): Promise<Record<string, unknown>> {
  if (!SLUG_RE.test(slug)) throw new AppError('NOT_FOUND', 'Không tìm thấy website.');
  const host = await db.get(ctx, keys.host(ctx, slug), { consistent: true });
  if (!host) throw new AppError('NOT_FOUND', 'Không tìm thấy website.');
  return host;
}

const prewarmOf = (host: Record<string, unknown>): { jobId?: string; startedAt?: number } =>
  host.prewarm && typeof host.prewarm === 'object' ? (host.prewarm as { jobId?: string; startedAt?: number }) : {};

/** POST /console/hosts/{slug}/prewarm */
export async function startPrewarm(
  ctx: Ctx,
  slug: string,
  body: { target_langs?: unknown },
  deps: PrewarmManagerDeps,
): Promise<{ job: JobSummary; existing: boolean }> {
  requireConsoleRole(ctx, ['TENANT_ADMIN']);
  await requireActiveTenant(ctx, deps.db);
  const host = await getHost(ctx, slug, deps.db);
  if (host.status !== 'ACTIVE') throw new AppError('INVALID_REQUEST', 'Website chưa xác minh hoặc đang tạm dừng.');
  const enabled = Array.isArray(host.targetLangs) ? (host.targetLangs as string[]) : [];
  let langs = enabled;
  if (body?.target_langs !== undefined) {
    if (!Array.isArray(body.target_langs) || !body.target_langs.length || !body.target_langs.every((l) => typeof l === 'string' && LANG_RE.test(l))) {
      throw new AppError('INVALID_REQUEST', 'target_langs phải là danh sách mã ngôn ngữ.');
    }
    const requested = [...new Set(body.target_langs as string[])];
    if (!requested.every((l) => enabled.includes(l))) throw new AppError('UNSUPPORTED_LANGUAGE', 'Có ngôn ngữ chưa bật cho website này.');
    langs = requested;
  }
  if (!langs.length) throw new AppError('INVALID_REQUEST', 'Website chưa bật ngôn ngữ đích nào.');

  const now = deps.now ?? Date.now;
  const jobs = createJobStore(deps.db, now);

  // Một lần dịch trước đang chạy cho mỗi website: trả lại job đó
  const prev = prewarmOf(host);
  if (prev.jobId) {
    const job = await jobs.get(ctx, prev.jobId);
    if (job && (job.status === 'QUEUED' || job.status === 'RUNNING') && now() - (prev.startedAt ?? 0) < PREWARM_STALE_MS) {
      return { job, existing: true };
    }
  }

  const jobId = newJobId(now(), deps.uuid);
  try {
    await deps.db.update(ctx, {
      Key: keys.host(ctx, slug),
      UpdateExpression: 'SET #prewarm = :p',
      ConditionExpression: prev.jobId ? '#prewarm.#jobId = :prev' : 'attribute_exists(PK) AND attribute_not_exists(#prewarm)',
      ExpressionAttributeNames: { '#prewarm': 'prewarm', ...(prev.jobId ? { '#jobId': 'jobId' } : {}) },
      ExpressionAttributeValues: { ':p': { jobId, startedAt: now() }, ...(prev.jobId ? { ':prev': prev.jobId } : {}) },
    });
  } catch (err) {
    // Hai lần bấm đồng thời: lần kia đã ghi job mới, trả lại job đó
    if ((err as { name?: string })?.name !== 'ConditionalCheckFailedException') throw err;
    const again = prewarmOf(await getHost(ctx, slug, deps.db));
    const job = again.jobId ? await jobs.get(ctx, again.jobId) : null;
    if (job) return { job, existing: true };
    throw new AppError('INTERNAL_ERROR', 'Không bắt đầu được dịch trước, vui lòng thử lại.');
  }

  await jobs.create(ctx, { jobId, type: 'PREWARM', slug, targetLangs: langs });
  const m2 = { job_id: jobId, tenant_id: ctx.tenantId, slug, target_langs: langs };
  try {
    await deps.startExecution({ name: jobId, input: JSON.stringify(m2) });
  } catch {
    await jobs.finish(ctx, jobId, { status: 'FAILED', reason: 'START_FAILED' }).catch(() => {});
    throw new AppError('INTERNAL_ERROR', 'Không khởi động được dịch trước, vui lòng thử lại.');
  }
  return { job: (await jobs.get(ctx, jobId))!, existing: false };
}

/** GET /console/hosts/{slug}/prewarm */
export async function getLatestPrewarm(ctx: Ctx, slug: string, deps: Pick<PrewarmManagerDeps, 'db' | 'now'>): Promise<JobSummary | null> {
  requireConsoleRole(ctx, ['TENANT_ADMIN']);
  const host = await getHost(ctx, slug, deps.db);
  const prev = prewarmOf(host);
  return prev.jobId ? createJobStore(deps.db, deps.now).get(ctx, prev.jobId) : null;
}

/** GET /console/jobs/{jobId}: job của tenant khác hoặc không tồn tại đều NOT_FOUND. Job dịch trước chỉ Tenant Admin xem. */
export async function getJob(ctx: Ctx, jobId: string, deps: Pick<PrewarmManagerDeps, 'db' | 'now'>): Promise<JobSummary> {
  requireConsoleRole(ctx, ['TENANT_ADMIN', 'DEVELOPER']);
  const job = await createJobStore(deps.db, deps.now).get(ctx, jobId);
  if (!job || (job.type === 'PREWARM' && ctx.role !== 'TENANT_ADMIN')) throw new AppError('NOT_FOUND', 'Không tìm thấy công việc.');
  return job;
}

function statusForError(code: string): number {
  if (code === 'UNAUTHORIZED') return 401;
  if (code === 'TENANT_SUSPENDED' || code === 'FORBIDDEN') return 403;
  if (code === 'NOT_FOUND') return 404;
  if (code === 'INVALID_REQUEST' || code === 'UNSUPPORTED_LANGUAGE') return 400;
  return 500;
}

/** Route của dịch trước và công việc. Trả null nếu đường dẫn không thuộc nhóm này (để router chung xử lý tiếp). */
export async function handlePrewarmRoute(
  event: { httpMethod?: string; path?: string; rawPath?: string; body?: string | null; requestContext?: { requestId?: string; http?: { method?: string } } },
  ctx: Ctx,
  deps: PrewarmManagerDeps,
): Promise<{ statusCode: number; headers: Record<string, string>; body: string } | null> {
  const path = event.path ?? event.rawPath ?? '';
  const method = (event.httpMethod ?? event.requestContext?.http?.method ?? 'GET').toUpperCase();
  const host = /\/console\/hosts\/([^/]+)\/prewarm$/.exec(path);
  const job = /\/console\/jobs\/([^/]+)$/.exec(path);
  if (!host && !job) return null;
  const requestId = event.requestContext?.requestId ?? ctx.requestId;
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
  const respond = (statusCode: number, payload: Record<string, unknown>) => ({ statusCode, headers, body: JSON.stringify({ request_id: requestId, ...payload }) });
  try {
    if (host && method === 'POST') {
      let body: Record<string, unknown> = {};
      if (event.body) {
        try {
          body = JSON.parse(event.body);
        } catch {
          throw new AppError('INVALID_REQUEST', 'Nội dung JSON không hợp lệ.');
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError('INVALID_REQUEST', 'Nội dung yêu cầu phải là object JSON.');
      }
      const r = await startPrewarm(ctx, decodeURIComponent(host[1]), body, deps);
      return respond(202, { job: r.job, existing: r.existing });
    }
    if (host && method === 'GET') return respond(200, { job: await getLatestPrewarm(ctx, decodeURIComponent(host[1]), deps) });
    if (job && method === 'GET') return respond(200, { job: await getJob(ctx, decodeURIComponent(job[1]), deps) });
    throw new AppError('NOT_FOUND', 'Không tìm thấy endpoint.');
  } catch (error) {
    if (error instanceof AppError) {
      const code = error.code === 'FORBIDDEN' ? 'PERMISSION_DENIED' : error.code;
      return respond(statusForError(error.code), { error: { code, message: error.message } });
    }
    return respond(500, { error: { code: 'INTERNAL_ERROR', message: 'Lỗi tạm thời, vui lòng thử lại.' } });
  }
}

interface CommandCtor {
  new (input: never): unknown;
}

/**
 * Bản thật của startExecution. services/api thêm @aws-sdk/client-sfn khi nối hạ tầng:
 *   import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
 *   const startExecution = stepFunctionsStarter(new SFNClient({}), StartExecutionCommand, process.env.PREWARM_STATE_MACHINE_ARN!);
 */
export function stepFunctionsStarter(client: { send(command: unknown): Promise<unknown> }, StartExecutionCommand: CommandCtor, stateMachineArn: string) {
  return async ({ name, input }: { name: string; input: string }): Promise<{ executionArn?: string }> => {
    const out = (await client.send(new StartExecutionCommand({ stateMachineArn, name, input } as never))) as { executionArn?: string };
    return { executionArn: out.executionArn };
  };
}
