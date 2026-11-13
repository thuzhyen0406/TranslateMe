import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureUsagePlanKey } from '../demo/usagePlan';
import { batchRecoveryWaitSeconds, recoverBatchJob } from '../demo/batchRecovery';

const envBefore = {
  AWS_BIN: process.env.AWS_BIN,
  FAKE_AWS_LOG: process.env.FAKE_AWS_LOG,
  FAKE_AWS_MODE: process.env.FAKE_AWS_MODE,
  TM_TABLE: process.env.TM_TABLE,
  TM_BATCH_RECOVERY_WAIT_S: process.env.TM_BATCH_RECOVERY_WAIT_S,
};
let tempDir = '';

afterEach(() => {
  for (const [key, value] of Object.entries(envBefore)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

function setupFakeAws(mode = ''): string {
  tempDir = mkdtempSync(join(tmpdir(), 'translateme-aws-bin-'));
  const log = join(tempDir, 'calls.jsonl');
  const fake = join(tempDir, 'fake-aws.mjs');
  writeFileSync(fake, `
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_AWS_LOG, JSON.stringify(args) + '\\n');
const value = (flag) => args[args.indexOf(flag) + 1];
const service = args[0], command = args[1];
const log = existsSync(process.env.FAKE_AWS_LOG) ? readFileSync(process.env.FAKE_AWS_LOG, 'utf8') : '';
const json = (value) => process.stdout.write(JSON.stringify(value));
if (service === 'apigateway' && command === 'get-api-key') {
  if (process.env.FAKE_AWS_MODE === 'missing-key') { process.stderr.write('An error occurred (NotFoundException): key missing'); process.exit(254); }
  json({ id: value('--api-key') });
} else if (service === 'apigateway' && command === 'get-usage-plan') {
  json({ id: value('--usage-plan-id') });
} else if (service === 'apigateway' && command === 'get-usage-plan-key') {
  const plan = value('--usage-plan-id');
  if (plan === 'basic-1') json({ id: value('--key-id') });
  else if (log.includes('"create-usage-plan-key"') && log.includes('"tiny-1"')) json({ id: value('--key-id') });
  else { process.stderr.write('An error occurred (NotFoundException): association missing'); process.exit(254); }
} else if (service === 'apigateway' && command === 'delete-usage-plan-key') {
  json({});
} else if (service === 'apigateway' && command === 'create-usage-plan-key') {
  if (process.env.FAKE_AWS_MODE === 'fail-tiny-attach' && value('--usage-plan-id') === 'tiny-1') {
    process.stderr.write('An error occurred (ConflictException): cannot attach'); process.exit(254);
  }
  json({ id: value('--key-id') });
} else if (service === 'dynamodb' && command === 'query') {
  if (process.env.FAKE_AWS_MODE === 'batch-page-two') {
    if (!args.includes('--exclusive-start-key')) {
      json({ Items: [], LastEvaluatedKey: { PK: { S: 'TENANT#tenant-c#JOB' }, SK: { S: 'JOB#page-1' } } });
    } else {
      json({ Items: [{
        PK: { S: 'TENANT#tenant-c#JOB' }, SK: { S: 'JOB#job-20261113-page-two' },
        jobId: { S: 'job-20261113-page-two' }, fileKey: { S: 'batch/tenant-c/input/upload.txt' }, type: { S: 'FILE' },
      }] });
    }
  } else
  if (process.env.FAKE_AWS_MODE === 'batch-found') {
    json({ Items: [{
      PK: { S: 'TENANT#tenant-c#JOB' }, SK: { S: 'JOB#job-20261113-0123456789ab' },
      jobId: { S: 'job-20261113-0123456789ab' }, fileKey: { S: 'batch/tenant-c/input/upload.txt' }, type: { S: 'FILE' },
    }] });
  } else json({ Items: [] });
} else {
  process.stderr.write('Unexpected fake AWS command: ' + args.join(' '));
  process.exit(2);
}
`);
  process.env.AWS_BIN = fake;
  process.env.FAKE_AWS_LOG = log;
  process.env.FAKE_AWS_MODE = mode;
  return log;
}

function calls(log: string): string[][] {
  return readFileSync(log, 'utf8').trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}

test('tiny-plan dùng get-usage-plan-key và chỉ detach sau khi xác thực key/plan', () => {
  const log = setupFakeAws();
  ensureUsagePlanKey({ keyId: 'key-1', targetPlanId: 'tiny-1', basicPlanId: 'basic-1' });
  const result = calls(log);
  const labels = result.map(([service, command]) => `${service} ${command}`);
  assert.ok(!labels.includes('apigateway get-usage-plan-keys'));
  assert.ok(labels.includes('apigateway get-usage-plan-key'));
  const targetLookup = result.find((args) => args[1] === 'get-usage-plan-key' && args.includes('tiny-1'));
  assert.ok(targetLookup?.includes('--key-id') && targetLookup.includes('key-1'));
  const keyCheck = labels.indexOf('apigateway get-api-key');
  const planCheck = labels.indexOf('apigateway get-usage-plan');
  const detachBasic = result.findIndex((args) => args[1] === 'delete-usage-plan-key' && args.includes('basic-1'));
  const attachTiny = result.findIndex((args) => args[1] === 'create-usage-plan-key' && args.includes('tiny-1'));
  const verifyTiny = result.findIndex((args, index) => index > attachTiny && args[1] === 'get-usage-plan-key' && args.includes('tiny-1'));
  assert.ok(keyCheck >= 0 && keyCheck < detachBasic);
  assert.ok(planCheck >= 0 && planCheck < detachBasic);
  assert.ok(detachBasic >= 0 && detachBasic < attachTiny);
  assert.ok(attachTiny >= 0 && attachTiny < verifyTiny);
});

test('tiny-plan không gỡ key khỏi Basic nếu API key không tồn tại', () => {
  const log = setupFakeAws('missing-key');
  assert.throws(() => ensureUsagePlanKey({ keyId: 'missing', targetPlanId: 'tiny-1', basicPlanId: 'basic-1' }), /không tồn tại/u);
  assert.ok(!calls(log).some((args) => args[1] === 'delete-usage-plan-key'));
});

test('tiny-plan rollback key về Basic nếu attach vào tiny thất bại', () => {
  const log = setupFakeAws('fail-tiny-attach');
  assert.throws(() => ensureUsagePlanKey({ keyId: 'key-1', targetPlanId: 'tiny-1', basicPlanId: 'basic-1' }), /ConflictException/u);
  const result = calls(log);
  const restoredBasic = result.findIndex((args) => args[1] === 'create-usage-plan-key' && args.includes('basic-1'));
  assert.ok(restoredBasic > result.findIndex((args) => args[1] === 'create-usage-plan-key' && args.includes('tiny-1')));
});

test('batch recovery query theo tenant/fileKey bằng consistent read trước khi gửi lại', async () => {
  const log = setupFakeAws('batch-found');
  process.env.TM_TABLE = 'translate-data';
  process.env.TM_BATCH_RECOVERY_WAIT_S = '90';
  const jobId = await recoverBatchJob('tenant-c', 'batch/tenant-c/input/upload.txt');
  assert.equal(jobId, 'job-20261113-0123456789ab');
  const [query] = calls(log);
  assert.deepEqual(query.slice(0, 2), ['dynamodb', 'query']);
  assert.ok(query.includes('--consistent-read'));
  assert.ok(query.some((arg) => arg.includes('TENANT#tenant-c#JOB')), JSON.stringify(query));
  assert.ok(query.some((arg) => arg.includes('batch/tenant-c/input/upload.txt')), JSON.stringify(query));
});

test('batch recovery tiếp tục phân trang khi trang đầu không khớp fileKey', async () => {
  const log = setupFakeAws('batch-page-two');
  process.env.TM_TABLE = 'translate-data';
  process.env.TM_BATCH_RECOVERY_WAIT_S = '90';
  const jobId = await recoverBatchJob('tenant-c', 'batch/tenant-c/input/upload.txt');
  assert.equal(jobId, 'job-20261113-page-two');
  const queries = calls(log);
  assert.equal(queries.length, 2);
  const pageTwo = queries[1];
  const startKeyIndex = pageTwo.indexOf('--exclusive-start-key');
  assert.ok(startKeyIndex >= 0, JSON.stringify(pageTwo));
  assert.deepEqual(JSON.parse(pageTwo[startKeyIndex + 1]), {
    PK: { S: 'TENANT#tenant-c#JOB' }, SK: { S: 'JOB#page-1' },
  });
});

test('batch recovery từ chối tiếp tục nếu không thể đọc state để đối soát', async () => {
  setupFakeAws();
  delete process.env.TM_TABLE;
  await assert.rejects(() => recoverBatchJob('tenant-c', 'some-file'), /TM_TABLE/u);
});

test('batch recovery không cho cấu hình thời gian dò ngắn hơn Lambda timeout cộng đệm', () => {
  delete process.env.TM_BATCH_RECOVERY_WAIT_S;
  assert.equal(batchRecoveryWaitSeconds(undefined), 90);
  assert.equal(batchRecoveryWaitSeconds('120'), 120);
  assert.throws(() => batchRecoveryWaitSeconds('35'), /không được ngắn hơn timeout Lambda/u);
});
