import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JOB_ID_RE, createJobStore, jobKey, newJobId, toJobSummary } from '../jobs.js';
import type { Ctx } from '../types.js';
import { memoryDataDb } from './memoryDataDb.js';

const ctxA: Ctx = { tenantId: 't_aaaaaaaaaaaaaaaaaaaaaaaa', via: 'JWT', requestId: 'r1' };
const ctxB: Ctx = { tenantId: 't_bbbbbbbbbbbbbbbbbbbbbbbb', via: 'JWT', requestId: 'r2' };
const T0 = Date.UTC(2026, 10, 1, 8, 0, 0);

describe('jobs – bản ghi JOB (QC-5, Hình 2.9)', () => {
  it('khóa và mã job', () => {
    assert.deepEqual(jobKey(ctxA, 'job-20261101-0123456789ab'), { PK: `TENANT#${ctxA.tenantId}#JOB`, SK: 'JOB#job-20261101-0123456789ab' });
    const id = newJobId(T0, () => '0123ABCD-4567-89ab-cdef-000000000000');
    assert.equal(id, 'job-20261101-0123abcd4567');
    assert.match(id, JOB_ID_RE);
    assert.match(newJobId(), JOB_ID_RE);
  });

  it('QUEUED -> RUNNING -> tiến độ theo lô -> SUCCEEDED; TTL 7 ngày', async () => {
    const db = memoryDataDb();
    let t = T0;
    const jobs = createJobStore(db, () => t);
    const id = 'job-20261101-aaaaaaaaaaaa';
    await jobs.create(ctxA, { jobId: id, type: 'PREWARM', slug: 'homestay-abc', targetLangs: ['en', 'ko'] });
    const raw = db.store.get(`TENANT#${ctxA.tenantId}#JOB|JOB#${id}`)!;
    assert.equal(raw.ttl, T0 / 1000 + 7 * 86_400);
    assert.equal((await jobs.get(ctxA, id))!.status, 'QUEUED');

    t += 1000;
    await jobs.markRunning(ctxA, id, 10, { warnings: [{ code: 'URL_LIMIT', where: 'sitemap', count: 3, message: 'x' }] });
    await Promise.all([jobs.addProgress(ctxA, id, 3, 1), jobs.addProgress(ctxA, id, 2, 0)]);
    const mid = (await jobs.get(ctxA, id))!;
    assert.deepEqual({ status: mid.status, total: mid.total, done: mid.done, failed: mid.failed, progress: mid.progress }, { status: 'RUNNING', total: 10, done: 5, failed: 1, progress: 60 });
    assert.equal(mid.warnings[0].code, 'URL_LIMIT');

    await jobs.finish(ctxA, id, { status: 'SUCCEEDED', warnings: [] });
    const end = (await jobs.get(ctxA, id))!;
    assert.equal(end.status, 'SUCCEEDED');
    assert.equal(end.progress, 100);
    assert.equal(end.slug, 'homestay-abc');
    assert.deepEqual(end.target_langs, ['en', 'ko']);
  });

  it('không đổi được kết quả đã chốt; không cập nhật tiến độ khi chưa RUNNING', async () => {
    const db = memoryDataDb();
    const jobs = createJobStore(db, () => T0);
    const id = 'job-20261101-bbbbbbbbbbbb';
    await jobs.create(ctxA, { jobId: id, type: 'PREWARM', targetLangs: ['en'] });
    await assert.rejects(jobs.addProgress(ctxA, id, 1, 0), { name: 'ConditionalCheckFailedException' });
    await jobs.finish(ctxA, id, { status: 'FAILED', reason: 'SITEMAP_NOT_FOUND' });
    await assert.rejects(jobs.finish(ctxA, id, { status: 'SUCCEEDED' }), { name: 'ConditionalCheckFailedException' });
    await assert.rejects(jobs.markRunning(ctxA, id, 5), { name: 'ConditionalCheckFailedException' });
    const s = (await jobs.get(ctxA, id))!;
    assert.equal(s.status, 'FAILED');
    assert.equal(s.reason, 'SITEMAP_NOT_FOUND');
  });

  it('addProgress theo lotId cộng đúng một lần mỗi lô (Retry của Step Functions); lô khác vẫn cộng', async () => {
    const db = memoryDataDb();
    const jobs = createJobStore(db, () => T0);
    const id = 'job-20261101-eeeeeeeeeeee';
    await jobs.create(ctxA, { jobId: id, type: 'PREWARM', targetLangs: ['en'] });
    await jobs.markRunning(ctxA, id, 6);
    assert.equal(await jobs.addProgress(ctxA, id, 2, 1, 'lot-0000'), true);
    assert.equal(await jobs.addProgress(ctxA, id, 2, 1, 'lot-0000'), false, 'chạy lại lô 0');
    assert.equal(await jobs.addProgress(ctxA, id, 3, 0, 'lot-0001'), true);
    const s = (await jobs.get(ctxA, id))!;
    assert.deepEqual([s.done, s.failed, s.progress], [5, 1, 100]);
    assert.ok(!('lots' in s), 'không lộ danh sách lô ra API');
    await jobs.finish(ctxA, id, { status: 'SUCCEEDED' });
    await assert.rejects(jobs.addProgress(ctxA, id, 1, 0, 'lot-0002'), { name: 'ConditionalCheckFailedException' }, 'job đã chốt');
    await assert.rejects(jobs.addProgress(ctxA, id, 1, 0, 'a.b'), { name: 'InvalidLotId' });
  });

  it('tạo trùng mã job bị từ chối; tenant khác không thấy job; mã sai dạng trả null', async () => {
    const db = memoryDataDb();
    const jobs = createJobStore(db, () => T0);
    const id = 'job-20261101-cccccccccccc';
    await jobs.create(ctxA, { jobId: id, type: 'FILE', targetLangs: ['en'] });
    await assert.rejects(jobs.create(ctxA, { jobId: id, type: 'FILE', targetLangs: ['en'] }), { name: 'ConditionalCheckFailedException' });
    assert.equal(await jobs.get(ctxB, id), null);
    assert.equal(await jobs.get(ctxA, '../x'), null);
  });

  it('khởi tạo notification ở trạng thái PENDING khi batch yêu cầu email', async () => {
    const db = memoryDataDb();
    const jobs = createJobStore(db, () => T0);
    const id = 'job-20261101-ffffffffffff';
    await jobs.create(ctxA, {
      jobId: id,
      type: 'FILE',
      targetLangs: ['en'],
      file: {
        fileKey: `batch/${ctxA.tenantId}/input/source.txt`,
        fileName: 'source.txt',
        format: 'txt',
        sendEmail: true,
        estimatedCharacters: 10,
      },
    });
    const job = await jobs.get(ctxA, id);
    assert.equal(job?.notification_status, 'PENDING');
  });

  it('tiến độ không vượt 100% khi lô chạy lại (Retry của Step Functions)', () => {
    const s = toJobSummary({ SK: 'JOB#job-20261101-dddddddddddd', status: 'RUNNING', total: 4, done: 6, failed: 0 });
    assert.equal(s.progress, 100);
    assert.equal(s.job_id, 'job-20261101-dddddddddddd');
    assert.equal(toJobSummary({ status: 'RUNNING', total: 0 }).progress, 0);
  });
});
