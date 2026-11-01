import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createJobStore } from '../../../../libs/common/jobs.js';
import { memoryDataDb } from '../../../../libs/common/test/memoryDataDb.js';
import { AppError, keys, type Ctx } from '../../../../libs/common/types.js';
import { PREWARM_STALE_MS, getJob, getLatestPrewarm, handlePrewarmRoute, startPrewarm, stepFunctionsStarter, type PrewarmManagerDeps } from '../prewarmManager.js';

const T = 't_aaaaaaaaaaaaaaaaaaaaaaaa';
const admin: Ctx = { tenantId: T, via: 'JWT', requestId: 'r1', role: 'TENANT_ADMIN' };
const dev: Ctx = { ...admin, role: 'DEVELOPER' };
const other: Ctx = { tenantId: 't_bbbbbbbbbbbbbbbbbbbbbbbb', via: 'JWT', requestId: 'r2', role: 'TENANT_ADMIN' };
const T0 = Date.UTC(2026, 10, 1, 9, 0, 0);

async function setup(o: { tenantStatus?: string; hostStatus?: string; startFails?: boolean } = {}) {
  const db = memoryDataDb();
  await db.put(admin, { ...keys.config(admin), status: o.tenantStatus ?? 'ACTIVE', plan: 'Free' });
  await db.put(admin, { ...keys.host(admin, 'homestay-abc'), homeUrl: 'https://homestay-abc.vn/', sourceLang: 'vi', targetLangs: ['en', 'ko'], status: o.hostStatus ?? 'ACTIVE' });
  await db.put(other, { ...keys.config(other), status: 'ACTIVE' });
  let t = T0;
  let n = 0;
  const starts: Array<{ name: string; input: string }> = [];
  const deps: PrewarmManagerDeps = {
    db,
    now: () => t,
    uuid: () => `${String(++n).padStart(8, '0')}-abcd-0000-0000-000000000000`,
    startExecution: async (i) => {
      starts.push(i);
      if (o.startFails) throw Object.assign(new Error('x'), { name: 'ExecutionLimitExceeded' });
      return { executionArn: `arn:aws:states:x:execution:prewarm:${i.name}` };
    },
  };
  return { db, deps, starts, advance: (ms: number) => (t += ms), jobs: createJobStore(db, () => t) };
}

const isCode = (code: string) => (e: unknown) => e instanceof AppError && e.code === code;

describe('startPrewarm (POST /console/hosts/{slug}/prewarm)', () => {
  it('tạo JOB QUEUED, gửi M2 chỉ mang định danh, ghi HOST.prewarm', async () => {
    const s = await setup();
    const r = await startPrewarm(admin, 'homestay-abc', {}, s.deps);
    assert.equal(r.existing, false);
    assert.deepEqual([r.job.status, r.job.type, r.job.slug, r.job.target_langs], ['QUEUED', 'PREWARM', 'homestay-abc', ['en', 'ko']]);
    assert.equal(s.starts.length, 1);
    assert.equal(s.starts[0].name, r.job.job_id);
    assert.deepEqual(JSON.parse(s.starts[0].input), { job_id: r.job.job_id, tenant_id: T, slug: 'homestay-abc', target_langs: ['en', 'ko'] });
    const host = await s.db.get(admin, keys.host(admin, 'homestay-abc'));
    assert.deepEqual(host?.prewarm, { jobId: r.job.job_id, startedAt: T0 });
  });

  it('chọn một phần ngôn ngữ; ngôn ngữ chưa bật -> UNSUPPORTED_LANGUAGE; sai dạng -> INVALID_REQUEST', async () => {
    const s = await setup();
    assert.deepEqual((await startPrewarm(admin, 'homestay-abc', { target_langs: ['ko'] }, s.deps)).job.target_langs, ['ko']);
    const s2 = await setup();
    await assert.rejects(startPrewarm(admin, 'homestay-abc', { target_langs: ['ja'] }, s2.deps), isCode('UNSUPPORTED_LANGUAGE'));
    await assert.rejects(startPrewarm(admin, 'homestay-abc', { target_langs: 'en' }, s2.deps), isCode('INVALID_REQUEST'));
    await assert.rejects(startPrewarm(admin, 'homestay-abc', { target_langs: [] }, s2.deps), isCode('INVALID_REQUEST'));
  });

  it('đang có lần dịch trước chạy -> trả lại job đó, không StartExecution lần nữa; job xong thì tạo lần mới', async () => {
    const s = await setup();
    const a = await startPrewarm(admin, 'homestay-abc', {}, s.deps);
    const b = await startPrewarm(admin, 'homestay-abc', {}, s.deps);
    assert.equal(b.existing, true);
    assert.equal(b.job.job_id, a.job.job_id);
    assert.equal(s.starts.length, 1);
    await s.jobs.finish(admin, a.job.job_id, { status: 'SUCCEEDED' });
    const c = await startPrewarm(admin, 'homestay-abc', {}, s.deps);
    assert.equal(c.existing, false);
    assert.notEqual(c.job.job_id, a.job.job_id);
    assert.equal(s.starts.length, 2);
  });

  it('job treo quá lâu (QUEUED sau PREWARM_STALE_MS) không chặn lần mới', async () => {
    const s = await setup();
    const a = await startPrewarm(admin, 'homestay-abc', {}, s.deps);
    s.advance(PREWARM_STALE_MS + 1);
    const b = await startPrewarm(admin, 'homestay-abc', {}, s.deps);
    assert.equal(b.existing, false);
    assert.notEqual(b.job.job_id, a.job.job_id);
  });

  it('StartExecution lỗi -> JOB FAILED (START_FAILED), trả INTERNAL_ERROR', async () => {
    const s = await setup({ startFails: true });
    await assert.rejects(startPrewarm(admin, 'homestay-abc', {}, s.deps), isCode('INTERNAL_ERROR'));
    const host = await s.db.get(admin, keys.host(admin, 'homestay-abc'));
    const job = await s.jobs.get(admin, (host?.prewarm as { jobId: string }).jobId);
    assert.deepEqual([job?.status, job?.reason], ['FAILED', 'START_FAILED']);
  });

  it('kiểm tra vai trò, phiên, tenant, website', async () => {
    const s = await setup();
    await assert.rejects(startPrewarm(dev, 'homestay-abc', {}, s.deps), isCode('FORBIDDEN'));
    await assert.rejects(startPrewarm({ ...admin, via: 'KEYMAP' }, 'homestay-abc', {}, s.deps), isCode('UNAUTHORIZED'));
    await assert.rejects(startPrewarm(other, 'homestay-abc', {}, s.deps), isCode('NOT_FOUND'), 'website của tenant khác');
    await assert.rejects(startPrewarm(admin, 'khong-co', {}, s.deps), isCode('NOT_FOUND'));
    await assert.rejects(startPrewarm(admin, '../x', {}, s.deps), isCode('NOT_FOUND'));
    await assert.rejects(startPrewarm(admin, 'homestay-abc', {}, (await setup({ hostStatus: 'PENDING' })).deps), isCode('INVALID_REQUEST'));
    await assert.rejects(startPrewarm(admin, 'homestay-abc', {}, (await setup({ tenantStatus: 'LOCKED' })).deps), isCode('TENANT_SUSPENDED'));
    assert.equal(s.starts.length, 0);
  });
});

describe('getLatestPrewarm / getJob', () => {
  it('trả job gần nhất của website; chưa có thì null', async () => {
    const s = await setup();
    assert.equal(await getLatestPrewarm(admin, 'homestay-abc', s.deps), null);
    const r = await startPrewarm(admin, 'homestay-abc', {}, s.deps);
    await s.jobs.markRunning(admin, r.job.job_id, 10);
    await s.jobs.addProgress(admin, r.job.job_id, 4, 1);
    const j = await getLatestPrewarm(admin, 'homestay-abc', s.deps);
    assert.deepEqual([j?.status, j?.progress], ['RUNNING', 50]);
  });

  it('job tenant khác hoặc không tồn tại -> NOT_FOUND; Developer không xem job dịch trước', async () => {
    const s = await setup();
    const r = await startPrewarm(admin, 'homestay-abc', {}, s.deps);
    assert.equal((await getJob(admin, r.job.job_id, s.deps)).job_id, r.job.job_id);
    await assert.rejects(getJob(other, r.job.job_id, s.deps), isCode('NOT_FOUND'));
    await assert.rejects(getJob(admin, 'job-20261101-ffffffffffff', s.deps), isCode('NOT_FOUND'));
    await assert.rejects(getJob(dev, r.job.job_id, s.deps), isCode('NOT_FOUND'));
  });
});

describe('handlePrewarmRoute', () => {
  it('202 khi bắt đầu, 200 khi xem; lỗi theo Bảng 2.10 kèm request_id; đường dẫn khác -> null', async () => {
    const s = await setup();
    const post = await handlePrewarmRoute({ httpMethod: 'POST', path: '/console/hosts/homestay-abc/prewarm', body: '{"target_langs":["en"]}', requestContext: { requestId: 'req-1' } }, admin, s.deps);
    assert.equal(post?.statusCode, 202);
    const pb = JSON.parse(post!.body);
    assert.equal(pb.request_id, 'req-1');
    assert.equal(pb.job.status, 'QUEUED');
    assert.equal(post?.headers['cache-control'], 'no-store');

    const get = await handlePrewarmRoute({ httpMethod: 'GET', path: '/console/hosts/homestay-abc/prewarm' }, admin, s.deps);
    assert.equal(JSON.parse(get!.body).job.job_id, pb.job.job_id);
    const job = await handlePrewarmRoute({ httpMethod: 'GET', path: `/console/jobs/${pb.job.job_id}` }, admin, s.deps);
    assert.equal(job?.statusCode, 200);

    const denied = await handlePrewarmRoute({ httpMethod: 'POST', path: '/console/hosts/homestay-abc/prewarm' }, dev, s.deps);
    assert.equal(denied?.statusCode, 403);
    assert.equal(JSON.parse(denied!.body).error.code, 'PERMISSION_DENIED');
    const bad = await handlePrewarmRoute({ httpMethod: 'POST', path: '/console/hosts/homestay-abc/prewarm', body: '{' }, admin, s.deps);
    assert.equal(bad?.statusCode, 400);
    const missing = await handlePrewarmRoute({ httpMethod: 'GET', path: '/console/hosts/khong-co/prewarm' }, admin, s.deps);
    assert.equal(missing?.statusCode, 404);
    assert.equal(await handlePrewarmRoute({ httpMethod: 'GET', path: '/console/api-keys' }, admin, s.deps), null);
  });

  it('stepFunctionsStarter gửi đúng stateMachineArn, name, input', async () => {
    class StartExecutionCommand {
      constructor(public input: unknown) {}
    }
    const sent: unknown[] = [];
    const start = stepFunctionsStarter({ send: async (c) => (sent.push(c), { executionArn: 'arn:e' }) }, StartExecutionCommand, 'arn:sm');
    assert.deepEqual(await start({ name: 'job-1', input: '{}' }), { executionArn: 'arn:e' });
    assert.deepEqual((sent[0] as StartExecutionCommand).input, { stateMachineArn: 'arn:sm', name: 'job-1', input: '{}' });
  });
});
