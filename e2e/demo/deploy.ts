// Triển khai TranslateMe lên AWS: bootstrap + 7 stack (infra/stacks) theo STACKS, rồi lượt 2, rồi web console.
//   npm run demo:deploy -- --stage dev
//   npm run demo:deploy -- --stage demo --approved-by "<người duyệt>"
//   --only <stack>        chỉ deploy một stack (không lượt 2, không console trừ khi --only console)
//   --skip-build          dùng lại gói mã Lambda đang deploy (chỉ đổi hạ tầng)
//   --skip-console        không build/đồng bộ web console
//   --dry-run             chỉ in lệnh ghi (lệnh đọc vẫn chạy)
// Biến: TM_REGION, TM_ACCOUNT (bắt buộc); TM_ALERT_EMAIL, TM_MONTHLY_BUDGET_USD (ops); TM_CONSOLE_AUTH_MODE
// (mặc định cognito; mock để thử giao diện không cần tài khoản); TM_PARAMS_<STACK>="K=V ..." thêm tham số. Quy tắc: demo chỉ deploy từ thẻ phát hành sạch, có người duyệt.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { aws, arg, flag, git, STACKS, stackName, stackTemplate } from './aws';
import { e2eEnv, pass2Stacks, stackParams, toOverrides, type CodeKeys, type StackKey, type StackOutputs } from './deployPlan';
import { LAMBDA_PACKAGES, buildLambdaPackage, repoRoot, run } from './lambdaPackage';

const stage = arg('stage') ?? process.env.TM_STAGE ?? 'dev';
const only = arg('only');
const approvedBy = arg('approved-by');
const dryRun = flag('dry-run');
const region = process.env.TM_REGION;
if (!['dev', 'demo'].includes(stage)) {
  console.error(`--stage không hợp lệ: ${stage}. Chỉ hỗ trợ dev hoặc demo.`);
  process.exit(1);
}
if (!region) { console.error('Chưa đặt TM_REGION'); process.exit(1); }
const expectedAccount = process.env.TM_ACCOUNT;
if (!expectedAccount || !/^\d{12}$/.test(expectedAccount)) {
  console.error('Bắt buộc đặt TM_ACCOUNT thành AWS account ID gồm 12 chữ số trước khi deploy.');
  process.exit(1);
}
if (only && only !== 'bootstrap' && !(STACKS as readonly string[]).includes(only)) {
  console.error(`--only phải là bootstrap hoặc một trong: ${STACKS.join(', ')}`);
  process.exit(1);
}

// Xác minh credentials ngay trong tiến trình deploy, trước mọi lệnh ghi.
const identity = aws(['sts', 'get-caller-identity'], { readonly: true });
if (identity.Account !== expectedAccount) {
  console.error(`AWS account không khớp: credentials hiện tại là ${identity.Account ?? '(không xác định)'}, TM_ACCOUNT=${expectedAccount}. Dừng deploy.`);
  process.exit(1);
}
console.log(`AWS account đã xác nhận: ${identity.Account}`);

if (stage === 'demo' && !flag('allow-untagged')) {
  const tag = git(['describe', '--exact-match', '--tags', 'HEAD']);
  if (!tag.ok || !/^v\d/.test(tag.out)) { console.error('Demo chỉ được deploy từ thẻ phát hành vX.Y.Z (HEAD chưa có thẻ).'); process.exit(1); }
  if (git(['status', '--porcelain']).out) { console.error('Còn thay đổi chưa commit.'); process.exit(1); }
  console.log(`Thẻ phát hành: ${tag.out}`);
}
if (stage === 'demo' && !approvedBy) { console.error('Demo cần --approved-by "<tên người duyệt>" (nhóm trưởng).'); process.exit(1); }

const templateDir = resolve(process.env.TM_TEMPLATE_DIR ?? join(repoRoot, 'infra', 'stacks'));
const buildDir = join(repoRoot, '.build', stage);
mkdirSync(buildDir, { recursive: true });
const rflag = ['--region', region];
const nameOf = (s: StackKey) => stackName(stage, s);
const templateOf = (s: StackKey) => (s === 'bootstrap' ? join(templateDir, 'bootstrap.yaml') : resolve(stackTemplate(templateDir, s)));

function readStack(s: StackKey): { outputs: Record<string, string>; params: Record<string, string> } | undefined {
  const r = aws(['cloudformation', 'describe-stacks', '--stack-name', nameOf(s), ...rflag], { readonly: true, allowFail: true });
  const st = r?.Stacks?.[0];
  if (!st || /^(DELETE_COMPLETE|ROLLBACK_COMPLETE)$/.test(st.StackStatus ?? '')) return undefined;
  const map = (xs: Array<Record<string, string>> | undefined, k: string, v: string) =>
    Object.fromEntries((xs ?? []).map((x) => [x[k], x[v] ?? '']));
  return { outputs: map(st.Outputs, 'OutputKey', 'OutputValue'), params: map(st.Parameters, 'ParameterKey', 'ParameterValue') };
}

const outputs: StackOutputs = {};
const deployedParams: Partial<Record<StackKey, Record<string, string>>> = {};
for (const s of ['bootstrap', ...STACKS] as StackKey[]) outputs[s] = readStack(s)?.outputs;

const missing = [...STACKS, 'bootstrap' as const].map((s) => templateOf(s)).filter((t) => !existsSync(t));
if (missing.length) { console.error(`Thiếu template: ${missing.join(', ')}`); process.exit(1); }

function deployStack(s: StackKey, params: Record<string, string>, label = ''): void {
  console.log(`\n== ${s}${label} -> ${nameOf(s)}`);
  const bucket = outputs.bootstrap?.ArtifactBucketName ?? (dryRun ? '<artifact-bucket>' : undefined);
  let template = templateOf(s);
  if (s !== 'bootstrap') {
    if (!bucket) throw new Error('Chưa có bucket bootstrap (ArtifactBucketName)');
    const packaged = join(buildDir, `${s}.packaged.yaml`);
    // TemplateURL tương đối của stack lồng nhau -> tải template module lên S3
    aws(['cloudformation', 'package', '--template-file', template, '--s3-bucket', bucket, '--s3-prefix', `templates/${stage}/${s}`,
      '--output-template-file', packaged, ...rflag], { raw: true });
    template = packaged;
  }
  const extra = (process.env[`TM_PARAMS_${s.toUpperCase()}`] ?? '').split(/\s+/).filter(Boolean);
  aws([
    'cloudformation', 'deploy', '--template-file', template, '--stack-name', nameOf(s),
    '--capabilities', 'CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND', '--no-fail-on-empty-changeset', ...rflag,
    '--parameter-overrides', `StageName=${stage}`, ...toOverrides(params), ...extra,
    '--tags', 'app=translateme', 'project=translateme', `stage=${stage}`, ...(approvedBy ? [`approved-by=${approvedBy}`] : []),
  ], { raw: true });
  deployedParams[s] = params;
  if (dryRun) return;
  const after = readStack(s);
  const r = aws(['cloudformation', 'describe-stacks', '--stack-name', nameOf(s), ...rflag], { readonly: true });
  const status = r.Stacks?.[0]?.StackStatus as string | undefined;
  console.log(`   trạng thái: ${status}`);
  if (!/^(CREATE|UPDATE)_COMPLETE$/.test(status ?? '')) throw new Error(`Stack ${nameOf(s)} không ở trạng thái hoàn tất`);
  outputs[s] = after?.outputs ?? {};
}

function codeKeys(): CodeKeys {
  // TM_CODE_KEYS="proxy=lambda/proxy-….zip api=lambda/api-….zip": gói đã tải sẵn (CI, test)
  const given = Object.fromEntries((process.env.TM_CODE_KEYS ?? '').split(/\s+/).filter(Boolean).map((kv) => kv.split('=') as [string, string]));
  if (given.proxy && given.api) return { proxy: given.proxy, api: given.api };
  const current = readStack('api')?.params;
  if (flag('skip-build')) {
    if (!current?.ProxyCodeKey || !current?.ApiCodeKey) throw new Error('--skip-build cần stack api đã có gói mã');
    console.log('Dùng lại gói mã Lambda đang deploy.');
    return { proxy: current.ProxyCodeKey, api: current.ApiCodeKey };
  }
  if (dryRun) {
    console.log('[dry-run] build và tải gói mã Lambda proxy, api');
    return { proxy: current?.ProxyCodeKey ?? 'lambda/proxy-DRYRUN.zip', api: current?.ApiCodeKey ?? 'lambda/api-DRYRUN.zip' };
  }
  const keys = {} as CodeKeys;
  for (const p of LAMBDA_PACKAGES) {
    const built = buildLambdaPackage(p.name, buildDir, { install: !flag('no-install') });
    aws(['s3', 'cp', built.zip, `s3://${outputs.bootstrap!.ArtifactBucketName}/${built.key}`, '--only-show-errors', ...rflag], { raw: true });
    console.log(`Gói ${p.name}: ${built.key} (${(built.bytes / 1024 / 1024).toFixed(1)} MB)`);
    keys[p.name] = built.key;
  }
  return keys;
}

function deployConsole(): void {
  const o = outputs;
  const bucket = o.console?.ConsoleBucketName;
  if (!bucket && !dryRun) throw new Error('Chưa có stack console');
  const env = {
    ...process.env,
    VITE_AUTH_MODE: process.env.TM_CONSOLE_AUTH_MODE || 'cognito',
    VITE_AWS_REGION: region!,
    VITE_COGNITO_USER_POOL_ID: o.identity?.UserPoolId ?? '',
    VITE_COGNITO_CLIENT_ID: o.identity?.ConsoleClientId ?? '',
    VITE_API_BASE_URL: o.api?.ApiBaseUrl ?? '',
    VITE_PUBLIC_BASE_URL: o.edge?.PublicBaseUrl ?? '',
    VITE_WEBSITE_API_ENABLED: 'true',
  };
  console.log(`\n== web console (VITE_AUTH_MODE=${env.VITE_AUTH_MODE}) -> s3://${bucket ?? '<console-bucket>'}`);
  if (dryRun) { console.log('[dry-run] npm ci && npm run build (console), s3 sync, CreateInvalidation /*'); return; }
  const dir = join(repoRoot, 'console');
  if (!flag('no-install')) run('npm', ['ci', '--no-audit', '--no-fund'], dir, env);
  run('npm', ['run', 'build'], dir, env);
  aws(['s3', 'sync', join(dir, 'dist'), `s3://${bucket}`, '--delete', '--only-show-errors', ...rflag], { raw: true });
  aws(['cloudfront', 'create-invalidation', '--distribution-id', o.console!.ConsoleDistributionId, '--paths', '/*']);
}

try {
  const order: StackKey[] = only ? [only as StackKey] : ['bootstrap', ...STACKS];
  if (order.includes('bootstrap')) deployStack('bootstrap', {});
  const keys = order.includes('api') ? codeKeys() : undefined;
  for (const s of order.filter((x) => x !== 'bootstrap')) {
    deployStack(s, stackParams(s, { stage, outputs, codeKeys: keys, env: process.env }));
  }
  // Lượt 2: trigger Cognito, ID usage plan, ID CloudFront + PUBLIC_BASE_URL (chỉ khi deploy đủ bộ)
  if (!only) {
    for (const s of pass2Stacks(deployedParams, { stage, outputs, codeKeys: keys, env: process.env })) {
      deployStack(s, stackParams(s, { stage, outputs, codeKeys: keys, env: process.env }), ' (lượt 2)');
    }
  }
  if ((!only || only === 'console') && !flag('skip-console')) deployConsole();

  const envText = e2eEnv(outputs, { stage, region, account: expectedAccount });
  if (!dryRun) writeFileSync(join(buildDir, 'e2e.env'), envText);
  if (dryRun) {
    console.log(`\n[dry-run] Xong. Khi chạy thật, cấu hình e2e (đủ giá trị) được lưu ở ${join('.build', stage, 'e2e.env')}; lượt 2 chỉ hiện khi chạy thật.`);
  } else {
    console.log(`\nXong. Cấu hình e2e (đã lưu ${join('.build', stage, 'e2e.env')}):\n\n${envText}`);
    console.log('Tiếp theo: dán khối trên vào e2e/.env.dev, rồi npm run demo:preflight -- --post');
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
