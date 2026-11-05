import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { keys, type Ctx } from '../../../../libs/common/types.js';
import { createBatchIngressHandler, type BatchIngressDependencies, type BatchObjectStore } from '../batchIngress.js';

const ctx: Ctx = { tenantId: 'tenant-a', via: 'KEYMAP', keyId: 'key-a', requestId: 'req-batch' };
const NOW = new Date('2026-11-02T10:00:00.000Z');

/** Tạo API giả với S3 và DynamoDB giả để test không gọi dịch vụ AWS thật. */
function setup(options: { actualSize?: number; contentType?: string; missing?: boolean; charLimit?: number; text?: string } = {}) {
  const records = new Map<string, Record<string, any>>();
  const s3Calls: Array<{ operation: string; input: Record<string, unknown> }> = [];
  const objectText = options.text ?? 'Xin chào. Đây là tệp thử nghiệm.';
  const bytes = new TextEncoder().encode(objectText);
  const configKey = keys.config(ctx);
  records.set(`${configKey.PK}|${configKey.SK}`, { ...configKey, status: 'ACTIVE', charLimit: options.charLimit ?? 1000 });
  const s3: BatchObjectStore = {
    async signPut(input) {
      s3Calls.push({ operation: 'signPut', input });
      return 'https://s3.example/presigned';
    },
    async head(input) {
      s3Calls.push({ operation: 'head', input });
      if (options.missing) throw Object.assign(new Error('missing'), { name: 'NotFound' });
      return { contentLength: options.actualSize ?? bytes.length, contentType: options.contentType ?? 'text/plain' };
    },
    async get(input) {
      s3Calls.push({ operation: 'get', input });
      return bytes;
    },
  };
  const db: BatchIngressDependencies['db'] = {
    async get(_ctx, key) { return records.get(`${key.PK}|${key.SK}`) ?? null; },
    async put(_ctx, item) { records.set(`${item.PK}|${item.SK}`, { ...item }); },
  };
  const handler = createBatchIngressHandler({
    db,
    s3,
    bucket: 'translateme-batch-test',
    resolveTenant: async () => ctx,
    now: () => new Date(NOW),
  });
  return { handler, records, s3Calls, bytes };
}

/** Gửi API Gateway event test và giải mã phản hồi JSON. */
async function request(h: ReturnType<typeof setup>, method: string, path: string, body: unknown) {
  const response = await h.handler({ httpMethod: method, path, body: JSON.stringify(body), requestContext: { requestId: ctx.requestId } });
  return { ...response, payload: JSON.parse(response.body) as Record<string, any> };
}

describe('batch upload ingress', () => {
  it('issues a 15-minute PUT URL for a tenant-scoped key and creates a valid QUEUED JOB after HeadObject', async () => {
    const h = setup();
    const upload = await request(h, 'POST', '/translate/batch/upload-url', { file_name: 'guide.txt', size_bytes: h.bytes.length, tenant_id: 'other-tenant' });
    assert.equal(upload.statusCode, 200);
    assert.equal(upload.payload.expires_in, 900);
    assert.equal(upload.payload.required_headers['Content-Type'], 'text/plain');
    assert.match(upload.payload.file_key, /^tenant\/tenant-a\/batch\/input\//u);
    assert.equal(h.s3Calls[0].operation, 'signPut');
    assert.equal(h.s3Calls[0].input.expiresIn, 900);

    const jobResponse = await request(h, 'POST', '/translate/batch', {
      file_key: upload.payload.file_key,
      target_langs: ['en', 'ko'],
      send_email: true,
    });
    assert.equal(jobResponse.statusCode, 202);
    assert.equal(jobResponse.payload.status, 'QUEUED');
    assert.equal(jobResponse.payload.estimated_characters, Array.from('Xin chào. Đây là tệp thử nghiệm.').length * 2);
    assert.equal(h.s3Calls.some((call) => call.operation === 'head'), true);
    const job = [...h.records.values()].find((item) => item.entityType === 'JOB');
    assert.equal(job?.tenantId, 'tenant-a');
    assert.equal(job?.fileKey, upload.payload.file_key);
    assert.equal(job?.ttl, Math.floor(NOW.getTime() / 1000) + 7 * 86400);
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

  it('checks actual size and actual format after upload, not only the client declaration', async () => {
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

    const bodyMismatchHarness = setup({ text: 'This is plain text, not an HTML document.', contentType: 'text/html' });
    const htmlUpload = await request(bodyMismatchHarness, 'POST', '/translate/batch/upload-url', { file_name: 'guide.html', size_bytes: bodyMismatchHarness.bytes.length });
    const bodyMismatch = await request(bodyMismatchHarness, 'POST', '/translate/batch', { file_key: htmlUpload.payload.file_key, target_langs: ['en'] });
    assert.equal(bodyMismatch.statusCode, 400);
    assert.equal(bodyMismatch.payload.error.code, 'INVALID_REQUEST');
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
  });
});
