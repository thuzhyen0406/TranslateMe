import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { afterEach, test } from 'node:test';
import { createServer, Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir = '';
let apiServer: Server | undefined;

afterEach(async () => {
  if (apiServer?.listening) await new Promise<void>((resolve) => apiServer!.close(() => resolve()));
  apiServer = undefined;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

async function runSeed(options: { stage: string; account?: string; callerAccount?: string }) {
  tempDir = mkdtempSync(join(tmpdir(), 'translateme-seed-guard-'));
  const awsLog = join(tempDir, 'aws.jsonl');
  const fakeAws = join(tempDir, 'fake-aws.mjs');
  writeFileSync(awsLog, '');
  writeFileSync(fakeAws, `
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_AWS_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'sts' && args[1] === 'get-caller-identity') {
  process.stdout.write(JSON.stringify({ Account: process.env.FAKE_CALLER_ACCOUNT }));
} else {
  process.stdout.write(JSON.stringify({}));
}
`);

  const apiRequests: Array<{ method: string; path: string }> = [];
  apiServer = createServer((req, res) => {
    apiRequests.push({ method: req.method ?? '', path: req.url ?? '/' });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve, reject) => {
    apiServer!.once('error', reject);
    apiServer!.listen(0, '127.0.0.1', resolve);
  });
  const address = apiServer.address();
  assert.ok(address && typeof address === 'object');

  const child = spawn(process.execPath, [
    '--require', require.resolve('ts-node/register/transpile-only'),
    'demo/seed.ts', 'platform',
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      TM_STAGE: options.stage,
      TM_ACCOUNT: options.account ?? '',
      TM_API_BASE: `http://127.0.0.1:${address.port}`,
      TM_ENV_FILE: join(tempDir, 'no-env-file'),
      AWS_BIN: fakeAws,
      FAKE_AWS_LOG: awsLog,
      FAKE_CALLER_ACCOUNT: options.callerAccount ?? '111111111111',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', reject);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
  const awsCalls = readFileSync(awsLog, 'utf8').split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as string[]);
  return { ...result, awsCalls, apiRequests };
}

test('seed từ chối stage sai trước mọi lệnh AWS/API', async () => {
  const result = await runSeed({ stage: 'production', account: '111111111111' });
  assert.notEqual(result.code, 0);
  assert.match(result.output, /TM_STAGE không hợp lệ/u);
  assert.deepEqual(result.awsCalls, []);
  assert.deepEqual(result.apiRequests, []);
});

test('seed từ chối thiếu TM_ACCOUNT trước mọi lệnh AWS/API', async () => {
  const result = await runSeed({ stage: 'dev' });
  assert.notEqual(result.code, 0);
  assert.match(result.output, /TM_ACCOUNT bắt buộc/u);
  assert.deepEqual(result.awsCalls, []);
  assert.deepEqual(result.apiRequests, []);
});

test('seed từ chối AWS account không khớp trước mọi lệnh ghi/API', async () => {
  const result = await runSeed({ stage: 'demo', account: '111111111111', callerAccount: '222222222222' });
  assert.notEqual(result.code, 0);
  assert.match(result.output, /không khớp TM_ACCOUNT/u);
  assert.deepEqual(result.awsCalls.map((args) => args.slice(0, 2)), [['sts', 'get-caller-identity']]);
  assert.deepEqual(result.apiRequests, []);
});
