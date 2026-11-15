import assert from 'node:assert/strict';
import { S3Client } from '@aws-sdk/client-s3';
import { describe, it } from 'node:test';
import { AppError, keys, type Ctx } from '../../../../libs/common/types.js';
import { countChars } from '../../../../libs/common/parsers.js';
import { CharacterQuotaExceededError } from '../../../../libs/common/usage/usage.js';
import { createBatchIngressHandler, signBatchUpload, type BatchIngressDependencies, type BatchObjectStore } from '../batchIngress.js';

const ctx: Ctx = { tenantId: 'tenant-a', via: 'KEYMAP', keyId: 'key-a', requestId: 'req-batch' };
const NOW = new Date('2026-11-02T10:00:00.000Z');

/** Tạo API giả với S3 và DynamoDB giả để test không gọi dịch vụ AWS thật. */
function setup(options: {
  actualSize?: number;
  contentType?: string;
  omitHeadSize?: boolean;
  omitVersion?: boolean;
  replacementBytes?: Uint8Array;
  executionStatus?: string;
  missing?: boolean;
  charLimit?: number;
  text?: string;
  objectBytes?: Uint8Array;
  failJobWrite?: boolean;
  failUploadWrite?: boolean;
  failSignPut?: boolean;
  headError?: Error;
  getError?: Error;
  reserveError?: Error;
  failRefund?: boolean;
  status?: string;
  missingConfig?: boolean;
  tenant?: Ctx | null;
  resolveTenantError?: Error;
  startErrors?: Error[];
} = {}) {
  const records = new Map<string, Record<string, any>>();
  const s3Calls: Array<{ operation: string; input: Record<string, unknown> }> = [];
  const reservations: Array<Parameters<BatchIngressDependencies['usage']['reserve']>[0]> = [];
  const refunds: unknown[] = [];
  const startCalls: Array<{ name: string; input: string }> = [];
  const executions = new Map<string, string>();
  const startErrors = [...(options.startErrors ?? [])];
  const charLimit = options.charLimit ?? 1000;
  let reservedCharacters = 0;
  const bytes = new TextEncoder().encode(options.text ?? 'Xin chào. Đây là tệp thử nghiệm.');
  const downloadedBytes = options.objectBytes ?? bytes;
  const recordCtx = options.tenant && options.tenant !== null ? options.tenant : ctx;
  const configKey = keys.config(recordCtx);
  if (!options.missingConfig) {
    records.set(`${configKey.PK}|${configKey.SK}`, { ...configKey, status: options.status ?? 'ACTIVE', charLimit: options.charLimit ?? 1000, ownerSub: 'owner-1' });
    const ownerKey = keys.member(recordCtx, 'owner-1');
    records.set(`${ownerKey.PK}|${ownerKey.SK}`, { ...ownerKey, userSub: 'owner-1', email: 'owner@example.com' });
  }
  const s3: BatchObjectStore = {
    async signPut(input) {
      s3Calls.push({ operation: 'signPut', input });
      if (options.failSignPut) throw new Error('S3 signing unavailable');
      return 'https://s3.example/presigned';
    },
    async head(input) {
      s3Calls.push({ operation: 'head', input });
      if (options.headError) throw options.headError;
      if (options.missing) throw Object.assign(new Error('missing'), { name: 'NotFound' });
      return {
        ...(options.omitHeadSize ? {} : { contentLength: options.actualSize ?? bytes.length }),
        contentType: options.contentType ?? 'text/plain',
        ...(options.omitVersion ? {} : { versionId: 'uploaded-v1' }),
      };
    },
    async get(input) {
      s3Calls.push({ operation: 'get', input });
      if (options.getError) throw options.getError;
      return input.versionId === 'uploaded-v1' ? downloadedBytes : options.replacementBytes ?? downloadedBytes;
    },
    async signGet(input) {
      s3Calls.push({ operation: 'signGet', input });
      return `https://s3.example/download/${input.key}`;
    },
  };
  const db: BatchIngressDependencies['db'] = {
    async get(_ctx, key) { return records.get(`${key.PK}|${key.SK}`) ?? null; },
    async put(_ctx, item) {
      if (item.entityType === 'BATCH_UPLOAD' && options.failUploadWrite) throw new Error('DynamoDB unavailable');
      if (item.entityType === 'JOB' && options.failJobWrite) throw new Error('DynamoDB unavailable');
      const storageKey = `${item.PK}|${item.SK}`;
      if (records.has(storageKey)) throw Object.assign(new Error('conditional check failed'), { name: 'ConditionalCheckFailedException' });
      records.set(storageKey, { ...item });
    },
    async update(_ctx, params) {
      const storageKey = `${params.Key.PK}|${params.Key.SK}`;
      const item = records.get(storageKey);
      if (!item) return;
      if (params.ExpressionAttributeNames?.['#workflowStarted']) item.workflowStarted = params.ExpressionAttributeValues?.[':started'];
      if (params.ExpressionAttributeValues?.[':status'] === 'FAILED') {
        item.status = 'FAILED';
        item.reason = params.ExpressionAttributeValues?.[':reason'];
        if (params.UpdateExpression.includes('#failed = #total - #done')) item.failed = item.total - item.done;
      }
    },
  };
  const usage: BatchIngressDependencies['usage'] = {
    async reserve(input) {
      reservations.push(input);
      if (options.reserveError) throw options.reserveError;
      if (reservedCharacters + input.n > charLimit) throw new CharacterQuotaExceededError(input.n, charLimit);
      reservedCharacters += input.n;
      return {
        tenantId: input.tenantId,
        requestId: input.requestId,
        month: '2026-11',
        reservedChars: input.n,
        limit: charLimit,
        source: input.source,
        createdAt: (input.now ?? NOW).toISOString(),
      };
    },
    async refund(ticket) {
      refunds.push(ticket);
      if (options.failRefund) throw new Error('DynamoDB refund unavailable');
      reservedCharacters -= ticket.reservedChars;
    },
  };
  const handler = createBatchIngressHandler({
    db,
    usage,
    s3,
    bucket: 'translateme-batch-test',
    describeExecution: async () => options.executionStatus,
    startExecution: async ({ name, input }) => {
      startCalls.push({ name, input });
      const error = startErrors.shift();
      const executionArn = `arn:aws:states:test:execution:batch:${name}`;
      if (error) {
        // Model the ambiguous case where Step Functions accepted StartExecution but the reply timed out.
        if (error.name === 'TimeoutError') executions.set(name, input);
        throw error;
      }
      if (executions.has(name)) throw Object.assign(new Error('execution already exists'), { name: 'ExecutionAlreadyExists' });
      executions.set(name, input);
      return { executionArn };
    },
    resolveTenant: async () => {
      if (options.resolveTenantError) throw options.resolveTenantError;
      return options.tenant === undefined ? ctx : options.tenant;
    },
    now: () => new Date(NOW),
  });
  return {
    handler,
    records,
    s3Calls,
    bytes,
    reservations,
    refunds,
    startCalls,
    executions,
    getReservedCharacters: () => reservedCharacters,
  };
}

/** Gửi API Gateway event test và giải mã phản hồi JSON. */
async function request(
  h: ReturnType<typeof setup>,
  method: string,
  path: string,
  body: unknown,
  options: { rawBody?: boolean; rawPath?: boolean; requestId?: string } = {},
) {
  const response = await h.handler({
    httpMethod: method,
    ...(options.rawPath ? { rawPath: path } : { path }),
    body: options.rawBody ? String(body) : JSON.stringify(body),
    requestContext: { requestId: options.requestId ?? ctx.requestId },
  });
  return { ...response, payload: JSON.parse(response.body) as Record<string, any> };
}

async function createUpload(h: ReturnType<typeof setup>, fileName = 'guide.txt') {
  return request(h, 'POST', '/translate/batch/upload-url', { file_name: fileName, size_bytes: h.bytes.length });
}

function storedUpload(h: ReturnType<typeof setup>, fileKey: string) {
  const uploadId = /\/([0-9a-f-]{36})\./u.exec(fileKey)?.[1];
  assert.ok(uploadId);
  const key = keys.batchUpload(ctx, uploadId);
  const storageKey = `${key.PK}|${key.SK}`;
  const upload = h.records.get(storageKey);
  assert.ok(upload);
  return { key: storageKey, upload };
}

describe('batch upload ingress', () => {
  it('includes content length and MIME type in the actual S3 PUT signature', async () => {
    const client = new S3Client({
      region: 'ap-southeast-1', credentials: { accessKeyId: 'test-access', secretAccessKey: 'test-secret' },
      requestChecksumCalculation: 'WHEN_REQUIRED',
    });
    try {
      const url = new URL(await signBatchUpload(client, {
        bucket: 'translateme-batch-test', key: 'batch/t_demo/input/file.txt',
        contentType: 'text/plain', contentLength: 18, expiresIn: 900,
      }));
      const signed = new Set(url.searchParams.get('X-Amz-SignedHeaders')?.split(';'));
      assert.ok(signed.has('content-length'));
      assert.ok(signed.has('content-type'));
      assert.ok(![...url.searchParams.keys()].some((name) => name.startsWith('x-amz-checksum-')));
    } finally {
      client.destroy();
    }
  });
  it('pins the object version checked by HEAD even if the upload key is replaced', async () => {
    const h = setup({ replacementBytes: new TextEncoder().encode('Replaced after HEAD') });
    const upload = await createUpload(h);
    const result = await request(h, 'POST', '/translate/batch', { file_key: upload.payload.file_key, target_langs: ['en'] });
    assert.equal(result.statusCode, 202);
    assert.equal(h.s3Calls.find((entry) => entry.operation === 'get')?.input.versionId, 'uploaded-v1');
    assert.equal([...h.records.values()].find((record) => record.entityType === 'JOB')?.fileVersionId, 'uploaded-v1');
  });

  it('rejects new jobs when S3 cannot provide an immutable version ID', async () => {
    const h = setup({ omitVersion: true });
    const upload = await createUpload(h);
    const result = await request(h, 'POST', '/translate/batch', { file_key: upload.payload.file_key, target_langs: ['en'] });
    assert.equal(result.statusCode, 500);
    assert.equal(h.startCalls.length, 0);
    assert.ok(h.s3Calls.every((entry) => entry.operation !== 'get'));
  });

  it('reconciles a stale running job when the state machine aborted', async () => {
    const h = setup({ executionStatus: 'ABORTED' });
    const upload = await createUpload(h);
    const started = await request(h, 'POST', '/translate/batch', { file_key: upload.payload.file_key, target_langs: ['en'] });
    const job = [...h.records.values()].find((record) => record.entityType === 'JOB')!;
    Object.assign(job, { status: 'RUNNING', total: 7, done: 2, updatedAt: new Date(NOW.getTime() - 60_000).toISOString() });
    const response = await request(h, 'GET', `/translate/batch/${started.payload.job_id}`, undefined);
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.job.status, 'FAILED');
    assert.equal(response.payload.job.reason, 'WORKFLOW_ABORTED');
    assert.equal(response.payload.job.failed, 5);
    assert.equal(job.status, 'FAILED');
  });

  it('issues a 15-minute PUT URL for a tenant-scoped key and creates a valid QUEUED JOB after HeadObject', async () => {
    const h = setup();
    const upload = await request(h, 'POST', '/translate/batch/upload-url', { file_name: 'guide.txt', size_bytes: h.bytes.length, tenant_id: 'other-tenant' });
    assert.equal(upload.statusCode, 200);
    assert.equal(upload.payload.expires_in, 900);
    assert.equal(upload.payload.required_headers['Content-Type'], 'text/plain');
    assert.match(upload.payload.file_key, /^batch\/tenant-a\/input\/[0-9a-f-]{36}\.txt$/u);
    assert.equal(h.s3Calls[0].operation, 'signPut');
    assert.equal(h.s3Calls[0].input.expiresIn, 900);
    const stored = [...h.records.values()].find((item) => item.entityType === 'BATCH_UPLOAD');
    assert.equal(stored?.fileName, 'guide.txt');
    assert.equal(stored?.format, 'txt');
    assert.equal(stored?.contentType, 'text/plain');
    assert.equal(stored?.declaredSize, h.bytes.length);
    assert.equal(stored?.uploadUrlExpiresAt, new Date(NOW.getTime() + 15 * 60 * 1000).toISOString());
    assert.equal(stored?.expiresAt, new Date(NOW.getTime() + 7 * 86400 * 1000).toISOString());
    assert.equal(stored?.ttl, Math.floor(NOW.getTime() / 1000) + 7 * 86400);
    assert.equal(h.s3Calls[0].input.tenantId, 'tenant-a');
    assert.equal(h.s3Calls[0].input.bucket, 'translateme-batch-test');
    assert.equal(h.s3Calls[0].input.key, upload.payload.file_key);
    assert.equal(h.s3Calls[0].input.contentType, 'text/plain');
    assert.equal(h.s3Calls[0].input.contentLength, h.bytes.length);

    const jobResponse = await request(h, 'POST', '/translate/batch', {
      file_key: upload.payload.file_key,
      target_langs: ['en', 'ko'],
      send_email: true,
      source_lang: 'fr',
    });
    assert.equal(jobResponse.statusCode, 202);
    assert.equal(jobResponse.payload.status, 'QUEUED');
    const expectedCharacters = ['Xin chào.', 'Đây là tệp thử nghiệm.'].reduce((total, sentence) => total + countChars(sentence), 0) * 2;
    assert.equal(jobResponse.payload.estimated_characters, expectedCharacters);
    assert.equal(h.s3Calls.some((call) => call.operation === 'head'), true);
    const job = [...h.records.values()].find((item) => item.entityType === 'JOB');
    assert.equal(job?.tenantId, 'tenant-a');
    assert.equal(job?.fileKey, upload.payload.file_key);
    assert.equal(job?.fileVersionId, 'uploaded-v1');
    assert.equal(h.s3Calls.find((entry) => entry.operation === 'get')?.input.versionId, job?.fileVersionId);
    assert.equal(job?.type, 'FILE');
    assert.deepEqual(job?.targetLangs, ['en', 'ko']);
    assert.equal(job?.sourceLang, 'fr');
    assert.equal(job?.sendEmail, true);
    assert.equal(job?.notificationStatus, 'PENDING');
    assert.equal(job?.total, 0);
    assert.equal(job?.done, 0);
    assert.equal(job?.failed, 0);
    assert.equal(job?.estimatedCharacters, jobResponse.payload.estimated_characters);
    assert.equal(job?.usageReservation, undefined);
    assert.deepEqual(job?.usageSource, { kind: 'API', keyId: 'key-a' });
    assert.equal(job?.ttl, Math.floor(NOW.getTime() / 1000) + 7 * 86400);
    assert.equal(h.reservations.length, 1);
    assert.equal(h.reservations[0].tenantId, 'tenant-a');
    assert.match(
      h.reservations[0].requestId,
      new RegExp(`^batch-preflight-${jobResponse.payload.job_id}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`, 'u'),
    );
    assert.equal(h.reservations[0].n, jobResponse.payload.estimated_characters);
    assert.deepEqual(h.reservations[0].source, { kind: 'API', keyId: 'key-a' });
    assert.equal(h.reservations[0].now?.toISOString(), NOW.toISOString());

    const polled = await request(h, 'GET', `/translate/batch/${jobResponse.payload.job_id}`, null);
    assert.equal(polled.payload.job.send_email, true);
    assert.equal(polled.payload.job.notification_status, 'PENDING');
  });

  it('reuses the same job and execution when the client retries the same file_key', async () => {
    const h = setup();
    const upload = await createUpload(h);
    const payload = { file_key: upload.payload.file_key, target_langs: ['en'], source_lang: 'vi' };

    const first = await request(h, 'POST', '/translate/batch', payload);
    const retry = await request(h, 'POST', '/translate/batch', payload);

    assert.equal(first.statusCode, 202);
    assert.equal(retry.statusCode, 202);
    assert.equal(retry.payload.job_id, first.payload.job_id);
    assert.equal([...h.records.values()].filter((item) => item.entityType === 'JOB').length, 1);
    assert.equal(h.startCalls.length, 1);
    assert.equal(h.executions.size, 1);
    assert.equal(h.reservations.length, 1);
  });

  it('keeps a queued job retryable after an ambiguous StartExecution timeout', async () => {
    const h = setup({ startErrors: [Object.assign(new Error('request timed out'), { name: 'TimeoutError' })] });
    const upload = await createUpload(h);
    const payload = { file_key: upload.payload.file_key, target_langs: ['en'] };

    const first = await request(h, 'POST', '/translate/batch', payload);
    assert.equal(first.statusCode, 503);
    assert.equal(first.payload.status, 'QUEUED');
    assert.equal(first.payload.retryable, true);
    const jobId = first.payload.job_id as string;
    const jobKey = keys.job(ctx, jobId);
    const jobBeforeRetry = h.records.get(`${jobKey.PK}|${jobKey.SK}`);
    assert.equal(jobBeforeRetry?.status, 'QUEUED');
    assert.equal(jobBeforeRetry?.workflowStarted, undefined);

    const retry = await request(h, 'POST', '/translate/batch', payload);
    const jobAfterRetry = h.records.get(`${jobKey.PK}|${jobKey.SK}`);
    assert.equal(retry.statusCode, 202);
    assert.equal(retry.payload.job_id, jobId);
    assert.equal(jobAfterRetry?.status, 'QUEUED');
    assert.equal(jobAfterRetry?.workflowStarted, true);
    assert.equal([...h.records.values()].filter((item) => item.entityType === 'JOB').length, 1);
    assert.equal(h.startCalls.length, 2);
    assert.equal(h.executions.size, 1);
  });

  it('rejects retrying a file_key with different translation options', async () => {
    const h = setup();
    const upload = await createUpload(h);
    const first = await request(h, 'POST', '/translate/batch', { file_key: upload.payload.file_key, target_langs: ['en'] });
    const conflicting = await request(h, 'POST', '/translate/batch', { file_key: upload.payload.file_key, target_langs: ['ko'] });

    assert.equal(first.statusCode, 202);
    assert.equal(conflicting.statusCode, 409);
    assert.equal(conflicting.payload.error.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal([...h.records.values()].filter((item) => item.entityType === 'JOB').length, 1);
    assert.equal(h.startCalls.length, 1);
  });

  it('rejects missing or invalid authentication and inactive tenant configuration before storage access', async () => {
    const noContext = setup({ tenant: null });
    const unauthenticated = await request(noContext, 'POST', '/translate/batch/upload-url', { file_name: 'guide.txt', size_bytes: 10 });
    assert.equal(unauthenticated.statusCode, 401);
    assert.equal(unauthenticated.payload.error.code, 'UNAUTHORIZED');
    assert.equal(noContext.s3Calls.length, 0);

    const noKeyId = setup({ tenant: { tenantId: 'tenant-a', via: 'KEYMAP', requestId: ctx.requestId } });
    const keyRequired = await request(noKeyId, 'POST', '/translate/batch/upload-url', { file_name: 'guide.txt', size_bytes: 10 });
    assert.equal(keyRequired.statusCode, 401);
    assert.equal(keyRequired.payload.error.code, 'UNAUTHORIZED');

    const noSub = setup({ tenant: { tenantId: 'tenant-a', via: 'JWT', requestId: ctx.requestId } });
    const subRequired = await request(noSub, 'POST', '/translate/batch/upload-url', { file_name: 'guide.txt', size_bytes: 10 });
    assert.equal(subRequired.statusCode, 401);

    const authError = setup({ resolveTenantError: new AppError('UNAUTHORIZED', 'expired') });
    const authFailure = await request(authError, 'POST', '/translate/batch/upload-url', { file_name: 'guide.txt', size_bytes: 10 });
    assert.equal(authFailure.statusCode, 401);

    const inactiveMember = setup({ resolveTenantError: new AppError('PERMISSION_DENIED', 'member inactive') });
    const memberDenied = await request(inactiveMember, 'POST', '/translate/batch/upload-url', { file_name: 'guide.txt', size_bytes: 10 });
    assert.equal(memberDenied.statusCode, 403);
    assert.equal(memberDenied.payload.error.code, 'PERMISSION_DENIED');

    for (const options of [{ missingConfig: true }, { status: 'LOCKED' }]) {
      const inactive = setup(options);
      const denied = await request(inactive, 'POST', '/translate/batch/upload-url', { file_name: 'guide.txt', size_bytes: 10 });
      assert.equal(denied.statusCode, 403);
      assert.equal(denied.payload.error.code, 'TENANT_SUSPENDED');
      assert.equal(inactive.s3Calls.length, 0);
    }
  });

  it('allows job polling for a locked tenant and denies REVIEWER access to batch routes', async () => {
    const admin: Ctx = { tenantId: 'tenant-a', via: 'JWT', sub: 'admin-1', role: 'TENANT_ADMIN', requestId: 'req-locked' };
    const locked = setup({ tenant: admin, status: 'LOCKED' });
    const jobId = 'job-20261102-012345abcdef';
    const key = keys.job(admin, jobId);
    locked.records.set(`${key.PK}|${key.SK}`, {
      ...key,
      entityType: 'JOB',
      tenantId: admin.tenantId,
      type: 'FILE',
      status: 'SUCCEEDED',
      total: 1,
      done: 1,
      failed: 0,
      targetLangs: ['en'],
      fileName: 'guide.txt',
      resultFiles: { en: `batch/${admin.tenantId}/results/${jobId}/guide.en.txt` },
      warnings: [],
    });

    const result = await request(locked, 'GET', `/translate/batch/${jobId}`, null);
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.payload.job.downloads, {
      en: `https://s3.example/download/batch/${admin.tenantId}/results/${jobId}/guide.en.txt`,
    });
    assert.deepEqual(result.payload.job.results, [{
      target_lang: 'en',
      file_name: 'guide.en.txt',
      download_url: `https://s3.example/download/batch/${admin.tenantId}/results/${jobId}/guide.en.txt`,
      warnings: [],
    }]);
    assert.equal(locked.s3Calls.filter((call) => call.operation === 'signGet').length, 1);

    const stageResult = await request(locked, 'GET', `/dev/translate/batch/session/${jobId}`, null);
    assert.equal(stageResult.statusCode, 200);
    assert.deepEqual(stageResult.payload.job.downloads, {
      en: `https://s3.example/download/batch/${admin.tenantId}/results/${jobId}/guide.en.txt`,
    });

    const lockedWrite = await request(locked, 'POST', '/translate/batch/upload-url', { file_name: 'guide.txt', size_bytes: 10 });
    assert.equal(lockedWrite.statusCode, 403);
    assert.equal(lockedWrite.payload.error.code, 'TENANT_SUSPENDED');

    const reviewer: Ctx = { tenantId: 'tenant-a', via: 'JWT', sub: 'reviewer-1', role: 'REVIEWER', requestId: 'req-reviewer' };
    const reviewerHarness = setup({ tenant: reviewer });
    const denied = await request(reviewerHarness, 'GET', `/translate/batch/${jobId}`, null);
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.payload.error.code, 'PERMISSION_DENIED');
    assert.equal(reviewerHarness.s3Calls.length, 0);
  });

  it('returns the same NOT_FOUND response for missing and cross-tenant batch jobs (QC-17)', async () => {
    const otherTenant: Ctx = {
      tenantId: 'tenant-b',
      via: 'JWT',
      sub: 'admin-b',
      role: 'TENANT_ADMIN',
      requestId: 'req-qc17',
    };
    const h = setup({ tenant: otherTenant });
    const foreignJobId = 'job-20261102-fedcba654321';
    const foreignKey = keys.job(ctx, foreignJobId);
    h.records.set(`${foreignKey.PK}|${foreignKey.SK}`, {
      ...foreignKey,
      entityType: 'JOB',
      tenantId: ctx.tenantId,
      type: 'FILE',
      status: 'SUCCEEDED',
      targetLangs: ['en'],
      fileName: 'secret.txt',
      resultFiles: { en: 'batch/tenant-a/results/private.txt' },
    });

    const foreign = await request(h, 'GET', `/translate/batch/${foreignJobId}`, null, { requestId: 'same-request' });
    const missing = await request(h, 'GET', '/translate/batch/job-20261102-abcdef123456', null, { requestId: 'same-request' });
    assert.equal(foreign.statusCode, 404);
    assert.equal(missing.statusCode, 404);
    assert.deepEqual(foreign.payload, missing.payload);
    assert.deepEqual(foreign.payload.error, {
      code: 'NOT_FOUND',
      message: 'Không tìm thấy công việc batch.',
    });
    assert.equal(h.s3Calls.length, 0);
  });

  it('returns INVALID_REQUEST for malformed JSON and NOT_FOUND for unsupported method or route', async () => {
    const h = setup();
    const malformed = await request(h, 'POST', '/translate/batch/upload-url', '{', { rawBody: true });
    assert.equal(malformed.statusCode, 400);
    assert.equal(malformed.payload.error.code, 'INVALID_REQUEST');

    const nonObject = await request(h, 'POST', '/translate/batch/upload-url', '[]', { rawBody: true });
    assert.equal(nonObject.statusCode, 400);
    assert.equal(nonObject.payload.error.code, 'INVALID_REQUEST');

    const wrongMethod = await request(h, 'GET', '/translate/batch/upload-url', {});
    assert.equal(wrongMethod.statusCode, 404);
    assert.equal(wrongMethod.payload.error.code, 'NOT_FOUND');

    const wrongPath = await request(h, 'POST', '/translate/batch/unknown', {});
    assert.equal(wrongPath.statusCode, 404);
    assert.equal(wrongPath.payload.error.code, 'NOT_FOUND');
    assert.equal(h.s3Calls.length, 0);
  });

  it('rejects unsupported formats and declared uploads over 10 MB with INVALID_REQUEST', async () => {
    const h = setup();
    const wrongFormat = await request(h, 'POST', '/translate/batch/upload-url', { file_name: 'virus.exe', size_bytes: 10 });
    assert.equal(wrongFormat.statusCode, 400);
    assert.equal(wrongFormat.payload.error.code, 'INVALID_REQUEST');
    const tooLarge = await request(h, 'POST', '/translate/batch/upload-url', { file_name: 'large.docx', size_bytes: 10 * 1024 * 1024 + 1 });
    assert.equal(tooLarge.statusCode, 400);
    assert.equal(tooLarge.payload.error.code, 'INVALID_REQUEST');
  });

  it('rejects unsafe file names and invalid declared sizes without writing upload records', async () => {
    const h = setup();
    for (const fileName of [undefined, null, 12, '', '  ', '../guide.txt', 'folder\\guide.txt', 'x'.repeat(252) + '.txt', 'guide.txt\0']) {
      const response = await request(h, 'POST', '/translate/batch/upload-url', { file_name: fileName, size_bytes: h.bytes.length });
      assert.equal(response.statusCode, 400, `file name should be rejected: ${JSON.stringify(fileName)}`);
      assert.equal(response.payload.error.code, 'INVALID_REQUEST');
    }
    for (const size of [undefined, null, 0, -1, 1.5, '12', Number.MAX_SAFE_INTEGER + 1, 10 * 1024 * 1024 + 1]) {
      const response = await request(h, 'POST', '/translate/batch/upload-url', { file_name: 'guide.txt', size_bytes: size });
      assert.equal(response.statusCode, 400, `declared size should be rejected: ${String(size)}`);
      assert.equal(response.payload.error.code, 'INVALID_REQUEST');
    }
    assert.equal([...h.records.values()].some((item) => item.entityType === 'BATCH_UPLOAD'), false);
    assert.equal(h.s3Calls.length, 0);
  });

  it('returns a server error when upload persistence or presigning fails', async () => {
    const dbFailure = setup({ failUploadWrite: true });
    const notStored = await createUpload(dbFailure);
    assert.equal(notStored.statusCode, 500);
    assert.equal(notStored.payload.error.code, 'INTERNAL_ERROR');
    assert.equal(dbFailure.s3Calls.length, 0);

    const signingFailure = setup({ failSignPut: true });
    const notSigned = await createUpload(signingFailure);
    assert.equal(notSigned.statusCode, 500);
    assert.equal(notSigned.payload.error.code, 'INTERNAL_ERROR');
    assert.equal(signingFailure.s3Calls[0].operation, 'signPut');
    assert.equal(notSigned.payload.error.message.includes('S3 signing unavailable'), false);
  });

  it('accepts session routes and accounts valid Cognito jobs against console usage', async () => {
    const jwt: Ctx = { tenantId: 'tenant-a', via: 'JWT', requestId: ctx.requestId, sub: 'user-a' };
    const h = setup({ tenant: jwt });
    const upload = await request(h, 'POST', '/dev/translate/batch/session/upload-url', { file_name: 'guide.txt', size_bytes: h.bytes.length }, { rawPath: true });
    assert.equal(upload.statusCode, 200);
    const job = await request(h, 'POST', '/translate/batch/session', { file_key: upload.payload.file_key, target_langs: ['en'] });
    assert.equal(job.statusCode, 202);
    assert.deepEqual(h.reservations[0].source, { kind: 'CONSOLE' });
    assert.equal([...h.records.values()].find((item) => item.entityType === 'JOB')?.sendEmail, false);
  });

  it('rejects malformed, cross-tenant, expired, missing, or mismatched upload records before reading S3', async () => {
    const h = setup();
    for (const fileKey of [
      undefined,
      42,
      '',
      'batch/tenant-b/input/12345678-1234-1234-1234-123456789012.txt',
      'batch/tenant-a/output/12345678-1234-1234-1234-123456789012.txt',
      'batch/tenant-a/input/not-a-uuid.txt',
      'batch/tenant-a/input/12345678-1234-1234-1234-123456789012.exe',
    ]) {
      const response = await request(h, 'POST', '/translate/batch', { file_key: fileKey, target_langs: ['en'] });
      assert.equal(response.statusCode, 400);
      assert.equal(response.payload.error.code, 'FILE_NOT_UPLOADED');
    }

    const expiredHarness = setup();
    const expiredUploadResponse = await createUpload(expiredHarness);
    const expiredUpload = storedUpload(expiredHarness, expiredUploadResponse.payload.file_key);
    expiredUpload.upload.expiresAt = new Date(NOW.getTime() - 1).toISOString();
    const expired = await request(expiredHarness, 'POST', '/translate/batch', { file_key: expiredUploadResponse.payload.file_key, target_langs: ['en'] });
    assert.equal(expired.payload.error.code, 'FILE_NOT_UPLOADED');
    assert.equal(expiredHarness.s3Calls.some((call) => call.operation === 'head'), false);

    const missingHarness = setup();
    const missingUploadResponse = await createUpload(missingHarness);
    const missingUpload = storedUpload(missingHarness, missingUploadResponse.payload.file_key);
    missingHarness.records.delete(missingUpload.key);
    const missingRecord = await request(missingHarness, 'POST', '/translate/batch', { file_key: missingUploadResponse.payload.file_key, target_langs: ['en'] });
    assert.equal(missingRecord.payload.error.code, 'FILE_NOT_UPLOADED');

    const mismatchedHarness = setup();
    const mismatchedUploadResponse = await createUpload(mismatchedHarness);
    const mismatchedUpload = storedUpload(mismatchedHarness, mismatchedUploadResponse.payload.file_key);
    mismatchedUpload.upload.fileKey = 'batch/tenant-a/input/different-file.txt';
    const mismatched = await request(mismatchedHarness, 'POST', '/translate/batch', { file_key: mismatchedUploadResponse.payload.file_key, target_langs: ['en'] });
    assert.equal(mismatched.payload.error.code, 'FILE_NOT_UPLOADED');
    assert.equal(mismatchedHarness.s3Calls.some((call) => call.operation === 'head'), false);

    assert.equal(h.s3Calls.some((call) => call.operation === 'head'), false);
  });

  it('maps missing S3 objects to FILE_NOT_UPLOADED and surfaces other S3 failures as INTERNAL_ERROR', async () => {
    for (const notFound of [
      Object.assign(new Error('missing'), { name: 'NoSuchKey' }),
      Object.assign(new Error('missing'), { $metadata: { httpStatusCode: 404 } }),
    ]) {
      const h = setup({ headError: notFound });
      const upload = await createUpload(h);
      const response = await request(h, 'POST', '/translate/batch', { file_key: upload.payload.file_key, target_langs: ['en'] });
      assert.equal(response.statusCode, 400);
      assert.equal(response.payload.error.code, 'FILE_NOT_UPLOADED');
    }

    const headFailure = setup({ headError: new Error('S3 unavailable') });
    const headUpload = await createUpload(headFailure);
    const headResponse = await request(headFailure, 'POST', '/translate/batch', { file_key: headUpload.payload.file_key, target_langs: ['en'] });
    assert.equal(headResponse.statusCode, 500);
    assert.equal(headResponse.payload.error.code, 'INTERNAL_ERROR');

    const getFailure = setup({ getError: new Error('S3 unavailable') });
    const getUpload = await createUpload(getFailure);
    const getResponse = await request(getFailure, 'POST', '/translate/batch', { file_key: getUpload.payload.file_key, target_langs: ['en'] });
    assert.equal(getResponse.statusCode, 500);
    assert.equal(getResponse.payload.error.code, 'INTERNAL_ERROR');
    assert.equal(getFailure.reservations.length, 0);
  });

  it('rejects zero, unavailable, and mismatched S3 object metadata', async () => {
    for (const options of [{ actualSize: 0 }, { omitHeadSize: true }]) {
      const h = setup(options);
      const upload = await createUpload(h);
      const response = await request(h, 'POST', '/translate/batch', { file_key: upload.payload.file_key, target_langs: ['en'] });
      assert.equal(response.statusCode, 400);
      assert.equal(response.payload.error.code, 'INVALID_REQUEST');
    }
  });

  it('validates target languages, source language, and send_email before reserving quota', async () => {
    const h = setup();
    const upload = await createUpload(h);
    const invalidPayloads = [
      {},
      { target_langs: [] },
      { target_langs: 'en' },
      { target_langs: ['xx'] },
      { target_langs: ['en', 'en'] },
      { target_langs: ['en'], source_lang: 'xx' },
      { target_langs: ['en'], source_lang: 4 },
      { target_langs: ['en'], send_email: 'true' },
    ];
    for (const payload of invalidPayloads) {
      const response = await request(h, 'POST', '/translate/batch', { file_key: upload.payload.file_key, ...payload });
      assert.equal(response.statusCode, 400, `payload should be rejected: ${JSON.stringify(payload)}`);
      assert.equal(response.payload.error.code, 'INVALID_REQUEST');
    }
    assert.equal(h.reservations.length, 0);
    assert.equal([...h.records.values()].some((item) => item.entityType === 'JOB'), false);
  });

  it('checks object size, content type, and parser validity after upload', async () => {
    const tooLargeHarness = setup({ actualSize: 10 * 1024 * 1024 + 1 });
    const upload = await request(tooLargeHarness, 'POST', '/translate/batch/upload-url', { file_name: 'guide.txt', size_bytes: tooLargeHarness.bytes.length });
    const tooLarge = await request(tooLargeHarness, 'POST', '/translate/batch', { file_key: upload.payload.file_key, target_langs: ['en'] });
    assert.equal(tooLarge.statusCode, 400);
    assert.equal(tooLarge.payload.error.code, 'INVALID_REQUEST');

    const mismatchHarness = setup({ contentType: 'text/html' });
    const mismatchUpload = await request(mismatchHarness, 'POST', '/translate/batch/upload-url', { file_name: 'guide.txt', size_bytes: mismatchHarness.bytes.length });
    const mismatch = await request(mismatchHarness, 'POST', '/translate/batch', { file_key: mismatchUpload.payload.file_key, target_langs: ['en'] });
    assert.equal(mismatch.statusCode, 400);
    assert.equal(mismatch.payload.error.code, 'INVALID_REQUEST');

    const invalidUtf8Harness = setup({ text: 'xx', objectBytes: new Uint8Array([0xc3, 0x28]), contentType: 'text/html' });
    const htmlUpload = await request(invalidUtf8Harness, 'POST', '/translate/batch/upload-url', { file_name: 'guide.html', size_bytes: invalidUtf8Harness.bytes.length });
    const invalidUtf8 = await request(invalidUtf8Harness, 'POST', '/translate/batch', { file_key: htmlUpload.payload.file_key, target_langs: ['en'] });
    assert.equal(invalidUtf8.statusCode, 400);
    assert.equal(invalidUtf8.payload.error.code, 'INVALID_REQUEST');
    assert.equal(invalidUtf8Harness.reservations.length, 0);

    const changedSizeHarness = setup({ actualSize: 1 });
    const changedSizeUpload = await createUpload(changedSizeHarness);
    const changedSize = await request(changedSizeHarness, 'POST', '/translate/batch', { file_key: changedSizeUpload.payload.file_key, target_langs: ['en'] });
    assert.equal(changedSize.statusCode, 400);
    assert.equal(changedSize.payload.error.code, 'INVALID_REQUEST');

    const changedObjectHarness = setup({ objectBytes: new TextEncoder().encode('x') });
    const changedObjectUpload = await createUpload(changedObjectHarness);
    const changedObject = await request(changedObjectHarness, 'POST', '/translate/batch', { file_key: changedObjectUpload.payload.file_key, target_langs: ['en'] });
    assert.equal(changedObject.statusCode, 400);
    assert.equal(changedObject.payload.error.code, 'INVALID_REQUEST');
  });

  it('returns FILE_NOT_UPLOADED for an absent object and CHAR_QUOTA_EXCEEDED without creating a job', async () => {
    const missingHarness = setup({ missing: true });
    const missingUpload = await request(missingHarness, 'POST', '/translate/batch/upload-url', { file_name: 'guide.txt', size_bytes: missingHarness.bytes.length });
    const missing = await request(missingHarness, 'POST', '/translate/batch', { file_key: missingUpload.payload.file_key, target_langs: ['en'] });
    assert.equal(missing.statusCode, 400);
    assert.equal(missing.payload.error.code, 'FILE_NOT_UPLOADED');

    const quotaHarness = setup({ charLimit: 1 });
    const quotaUpload = await request(quotaHarness, 'POST', '/translate/batch/upload-url', { file_name: 'guide.txt', size_bytes: quotaHarness.bytes.length });
    const overQuota = await request(quotaHarness, 'POST', '/translate/batch', { file_key: quotaUpload.payload.file_key, target_langs: ['en'] });
    assert.equal(overQuota.statusCode, 429);
    assert.equal(overQuota.payload.error.code, 'CHAR_QUOTA_EXCEEDED');
    assert.equal([...quotaHarness.records.values()].some((item) => item.entityType === 'JOB'), false);
    assert.equal(quotaHarness.getReservedCharacters(), 0);
  });

  it('reserves quota before creating jobs so concurrent submissions cannot exceed the limit', async () => {
    const h = setup({ text: 'hello', charLimit: 5 });
    const upload = await request(h, 'POST', '/translate/batch/upload-url', { file_name: 'guide.txt', size_bytes: h.bytes.length });
    const submit = () => request(h, 'POST', '/translate/batch', { file_key: upload.payload.file_key, target_langs: ['en'] });
    const responses = await Promise.all([submit(), submit()]);

    assert.deepEqual(responses.map((response) => response.statusCode).sort(), [202, 429]);
    assert.equal(h.getReservedCharacters(), 0);
    assert.equal([...h.records.values()].filter((item) => item.entityType === 'JOB').length, 1);
  });

  it('returns INTERNAL_ERROR when quota reservation fails for a reason other than quota exhaustion', async () => {
    const h = setup({ reserveError: new Error('Usage store unavailable') });
    const upload = await createUpload(h);
    const response = await request(h, 'POST', '/translate/batch', { file_key: upload.payload.file_key, target_langs: ['en'] });
    assert.equal(response.statusCode, 500);
    assert.equal(response.payload.error.code, 'INTERNAL_ERROR');
    assert.equal(h.refunds.length, 0);
    assert.equal([...h.records.values()].some((item) => item.entityType === 'JOB'), false);
  });

  it('releases the quota preflight if the shared job record cannot be created', async () => {
    const h = setup({ failJobWrite: true });
    const upload = await request(h, 'POST', '/translate/batch/upload-url', { file_name: 'guide.txt', size_bytes: h.bytes.length });
    const failed = await request(h, 'POST', '/translate/batch', { file_key: upload.payload.file_key, target_langs: ['en'] });
    assert.equal(failed.statusCode, 500);
    assert.equal(h.getReservedCharacters(), 0);
    assert.equal([...h.records.values()].some((item) => item.entityType === 'JOB'), false);
  });

  it('logs a failed quota preflight refund without exposing the underlying error', async () => {
    const h = setup({ failRefund: true });
    const upload = await createUpload(h);
    const previousError = console.error;
    const logLines: string[] = [];
    console.error = (message?: unknown) => { logLines.push(String(message)); };
    try {
      const response = await request(h, 'POST', '/translate/batch', { file_key: upload.payload.file_key, target_langs: ['en'] });
      assert.equal(response.statusCode, 500);
      assert.equal(response.payload.error.code, 'INTERNAL_ERROR');
    } finally {
      console.error = previousError;
    }
    assert.equal(h.refunds.length, 1);
    assert.equal(h.getReservedCharacters(), h.reservations[0].n);
    assert.equal(logLines.length, 1);
    const log = JSON.parse(logLines[0]) as Record<string, unknown>;
    assert.equal(log.event, 'BATCH_PREFLIGHT_REFUND_FAILED');
    assert.equal(log.request_id, ctx.requestId);
    assert.equal(log.errorName, 'Error');
    assert.equal(logLines[0].includes('DynamoDB refund unavailable'), false);
  });
});
