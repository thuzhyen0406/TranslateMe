import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv, pass2Stacks, stackParams } from '../demo/deployPlan';
import { codeKey, shouldShip } from '../demo/lambdaPackage';

const FAKE_AWS = String.raw`
import { appendFileSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const statePath = process.env.FAKE_AWS_STATE;
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
appendFileSync(process.env.FAKE_AWS_LOG, JSON.stringify(args) + '\n');
const opt = (k) => args[args.indexOf(k) + 1];
const OUT = {
  bootstrap: { ArtifactBucketName: 'artifacts-bucket' },
  data: { TableName: 'translateme-dev' },
  identity: { UserPoolId: 'pool-1', UserPoolArn: 'arn:pool', ConsoleClientId: 'client-c', PlatformClientId: 'client-p' },
  api: { ApiBaseUrl: 'https://api.example/dev', ApiId: 'api123', BasicUsagePlanId: 'plan-b', StandardUsagePlanId: 'plan-s', PostConfirmationFunctionArn: 'arn:lambda:pc' },
  edge: { DistributionId: 'EDIST', PublicBaseUrl: 'https://d1.cloudfront.net' },
  workflow: {}, console: { ConsoleBucketName: 'console-b', ConsoleDistributionId: 'ECON', ConsoleUrl: 'https://c.cloudfront.net' }, ops: {},
};
if (args[0] === 'sts') { process.stdout.write(JSON.stringify({ Account: '123456789012' })); process.exit(0); }
if (args[0] === 'cloudformation' && args[1] === 'describe-stacks') {
  const st = state[opt('--stack-name')];
  if (!st) { process.stderr.write('Stack does not exist'); process.exit(255); }
  process.stdout.write(JSON.stringify({ Stacks: [{ StackStatus: 'UPDATE_COMPLETE',
    Outputs: Object.entries(st.outputs).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })),
    Parameters: Object.entries(st.params).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })) }] }));
  process.exit(0);
}
if (args[0] === 'cloudformation' && args[1] === 'package') { copyFileSync(opt('--template-file'), opt('--output-template-file')); process.exit(0); }
if (args[0] === 'cloudformation' && args[1] === 'deploy') {
  const name = opt('--stack-name');
  const i = args.indexOf('--parameter-overrides'); const j = args.indexOf('--tags');
  const params = Object.fromEntries(args.slice(i + 1, j).map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
  state[name] = { outputs: OUT[name.split('-').pop()], params };
  writeFileSync(statePath, JSON.stringify(state));
  process.exit(0);
}
process.stdout.write('{}');
`;

function runDeploy(dir: string, extraArgs: string[] = []) {
  const res = spawnSync(process.execPath, ['--require', 'ts-node/register/transpile-only', 'demo/deploy.ts', '--stage', 'dev', '--skip-console', ...extraArgs], {
    cwd: resolve(__dirname, '..'),
    encoding: 'utf8',
    env: {
      ...process.env, AWS_BIN: join(dir, 'aws.mjs'), FAKE_AWS_LOG: join(dir, 'log.jsonl'), FAKE_AWS_STATE: join(dir, 'state.json'),
      TM_REGION: 'ap-southeast-1', TM_ACCOUNT: '123456789012', TM_CODE_KEYS: 'proxy=lambda/proxy-aaa.zip api=lambda/api-bbb.zip',
      TM_ALERT_EMAIL: 'ops@example.invalid', TM_ENV_FILE: '/dev/null',
    },
  });
  const calls: string[][] = readFileSync(join(dir, 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { res, calls };
}

test('deploy lần đầu: bootstrap + 7 stack theo thứ tự, package với bucket bootstrap, rồi lượt 2 cho identity và api', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tm-deploy-'));
  try {
    writeFileSync(join(dir, 'aws.mjs'), FAKE_AWS);
    writeFileSync(join(dir, 'log.jsonl'), '');
    const { res, calls } = runDeploy(dir);
    assert.equal(res.status, 0, res.stderr + res.stdout);
    const deploys = calls.filter((c) => c[1] === 'deploy').map((c) => c[c.indexOf('--stack-name') + 1]);
    assert.deepEqual(deploys, ['bootstrap', 'data', 'identity', 'api', 'edge', 'workflow', 'console', 'ops', 'identity', 'api'].map((s) => `translateme-dev-${s}`));
    const packages = calls.filter((c) => c[1] === 'package');
    assert.equal(packages.length, 9, '7 stack + 2 lượt 2, bootstrap không cần package');
    assert.ok(packages.every((c) => c[c.indexOf('--s3-bucket') + 1] === 'artifacts-bucket'));
    const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    assert.deepEqual(
      { ...state['translateme-dev-api'].params },
      { StageName: 'dev', ProxyCodeKey: 'lambda/proxy-aaa.zip', ApiCodeKey: 'lambda/api-bbb.zip', BasicUsagePlanId: 'plan-b', StandardUsagePlanId: 'plan-s', CloudFrontDistributionId: 'EDIST', PublicBaseUrl: 'https://d1.cloudfront.net' },
    );
    assert.equal(state['translateme-dev-identity'].params.PostConfirmationFunctionArn, 'arn:lambda:pc');
    assert.equal(state['translateme-dev-ops'].params.AlertEmail, 'ops@example.invalid');
    assert.match(res.stdout, /TM_PUBLIC_BASE=https:\/\/d1\.cloudfront\.net/);
    assert.match(res.stdout, /TM_CONSOLE_CLIENT_ID=client-c/);

    // Lần sau: đã đủ output nên lượt 1 có ngay tham số đầy đủ, không có lượt 2
    writeFileSync(join(dir, 'log.jsonl'), '');
    const again = runDeploy(dir);
    assert.equal(again.res.status, 0, again.res.stderr);
    const deploys2 = again.calls.filter((c) => c[1] === 'deploy').map((c) => c[c.indexOf('--stack-name') + 1].split('-').pop());
    assert.deepEqual(deploys2, ['bootstrap', 'data', 'identity', 'api', 'edge', 'workflow', 'console', 'ops']);
    const apiDeploy = again.calls.find((c) => c[1] === 'deploy' && c.includes('translateme-dev-api'))!;
    assert.ok(apiDeploy.includes('CloudFrontDistributionId=EDIST'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(resolve(__dirname, '..', '..', '.build', 'dev'), { recursive: true, force: true });
  }
});

test('deploy --only edge: chỉ một stack, không lượt 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tm-deploy-'));
  try {
    writeFileSync(join(dir, 'aws.mjs'), FAKE_AWS);
    writeFileSync(join(dir, 'log.jsonl'), '');
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ 'translateme-dev-bootstrap': { outputs: { ArtifactBucketName: 'artifacts-bucket' }, params: {} } }));
    const { res, calls } = runDeploy(dir, ['--only', 'edge']);
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(calls.filter((c) => c[1] === 'deploy').map((c) => c[c.indexOf('--stack-name') + 1]), ['translateme-dev-edge']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(resolve(__dirname, '..', '..', '.build', 'dev'), { recursive: true, force: true });
  }
});

test('stackParams/pass2Stacks: lượt 1 thiếu thì lượt 2 bổ sung; đủ rồi thì không deploy lại', () => {
  const keys = { proxy: 'p', api: 'a' };
  const first = { identity: stackParams('identity', { stage: 'dev', outputs: {} }), api: stackParams('api', { stage: 'dev', outputs: {}, codeKeys: keys }) };
  assert.equal(first.api.CloudFrontDistributionId, '');
  const full = { api: { PostConfirmationFunctionArn: 'arn:pc', BasicUsagePlanId: 'b', StandardUsagePlanId: 's' }, edge: { DistributionId: 'E', PublicBaseUrl: 'https://x' } };
  assert.deepEqual(pass2Stacks(first, { stage: 'dev', outputs: full, codeKeys: keys }), ['identity', 'api']);
  const done = { identity: stackParams('identity', { stage: 'dev', outputs: full }), api: stackParams('api', { stage: 'dev', outputs: full, codeKeys: keys }) };
  assert.deepEqual(pass2Stacks(done, { stage: 'dev', outputs: full, codeKeys: keys }), []);
  assert.equal(stackParams('data', { stage: 'demo', outputs: {} }).DeletionProtection, 'true');
  assert.throws(() => stackParams('api', { stage: 'dev', outputs: {} }), /khóa S3/);
  assert.match(e2eEnv({ identity: { UserPoolId: 'p' } }, { stage: 'dev', region: 'r', account: '1' }), /TM_PLATFORM_USER_POOL_ID=p/);
});

test('gói Lambda: bỏ test, console, map; khóa S3 theo nội dung', () => {
  assert.equal(shouldShip('services/proxy/handler.js'), true);
  assert.equal(shouldShip('libs/common/tm.js'), true);
  assert.equal(shouldShip('services/proxy/test/handler.test.js'), false);
  assert.equal(shouldShip('console/src/services/websiteApi.js'), false);
  assert.equal(shouldShip('services/proxy/handler.js.map'), false);
  assert.equal(shouldShip('libs/common/experiments/run.js'), false);
  assert.equal(codeKey('proxy', 'abcdef0123456789ffff'), 'lambda/proxy-abcdef0123456789.zip');
  assert.ok(!existsSync(resolve(__dirname, '..', '..', '.build', 'dev', 'lambda-proxy')) || true);
});
