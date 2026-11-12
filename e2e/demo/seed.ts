// Bước 5–6 của runbook (5.4): dữ liệu nền và dữ liệu cho 8 kịch bản nghiệm thu.
//   npm run demo:seed -- platform     # tài khoản Platform Admin + PLATFORM CONFIG
//   npm run demo:seed -- tenants      # tenant A, B, C: tài khoản, website, API key, TM, job
//   npm run demo:seed -- tiny-plan    # usage plan rất nhỏ cho REQUEST_QUOTA_EXCEEDED (tenant C)
//   npm run demo:seed -- all
// Chạy lại được: bỏ qua phần đã có trong .state/<stage>.json (thêm --force để làm lại).
// --dry-run chỉ in các lệnh AWS CLI, không gọi API. Tệp .state chứa mật khẩu và key: KHÔNG commit.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { aws, argv, flag } from './aws';
import { cfg } from '../lib/config';
import { loadState, saveState, State, stateFile, TenantState } from '../lib/state';
import { idTokenClaims, login } from '../lib/auth';
import { call, Resp } from '../lib/http';
import { B, R, hashSentence, jobIdOf, keyIdOf, keyValueOf, listOf } from '../lib/contract';

const need = (k: string): string => { const v = process.env[k]; if (!v) throw new Error(`Thiếu biến môi trường ${k}`); return v; };
const hex = (n: number) => randomBytes(n).toString('hex');
const pw = () => `Aa1!${hex(9)}`;
const dry = flag('dry-run');
const force = flag('force');
const stage = process.env.TM_STAGE ?? 'dev';
const domain = process.env.TM_E2E_EMAIL_DOMAIN ?? 'example.com';
const region = process.env.TM_REGION ? ['--region', process.env.TM_REGION] : [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function must(r: Resp, what: string): Resp {
  if (r.status < 200 || r.status >= 300) throw new Error(`${what}: HTTP ${r.status} ${r.text.slice(0, 300)}`);
  return r;
}

function loadOrNew(): State {
  if (existsSync(stateFile(stage))) return loadState(stage);
  return {
    stage, createdAt: new Date().toISOString(), platform: { username: '', password: '' },
    tenants: {} as State['tenants'],
  };
}

async function seedPlatform(st: State): Promise<void> {
  const pool = need('TM_PLATFORM_USER_POOL_ID');
  const group = process.env.TM_PLATFORM_GROUP ?? 'PlatformAdmins';
  const { _ghi_chu, ...body } = JSON.parse(readFileSync(join(__dirname, 'platform-config.json'), 'utf8'));
  if (!st.platform.username || force) st.platform = { username: `tm-e2e-platform-${stage}@${domain}`, password: pw() };
  const { username, password } = st.platform;
  aws(['cognito-idp', 'admin-create-user', '--user-pool-id', pool, '--username', username, '--message-action', 'SUPPRESS',
    '--user-attributes', `Name=email,Value=${username}`, 'Name=email_verified,Value=true', ...region], { allowFail: true });
  aws(['cognito-idp', 'admin-set-user-password', '--user-pool-id', pool, '--username', username, '--password', password,
    '--permanent', ...region]);
  aws(['cognito-idp', 'admin-add-user-to-group', '--user-pool-id', pool, '--username', username, '--group-name', group, ...region],
    { allowFail: true });
  if (dry) { console.log('[dry-run] sẽ PUT /platform/config với demo/platform-config.json'); return; }
  const tok = await login(cfg().platformClientId, username, password);
  must(await call('PUT', R.platformConfig, { token: tok, body }), 'PUT /platform/config');
  console.log(`Platform Admin: ${username}; PLATFORM CONFIG đã đặt`);
}

async function seedTenant(label: 'A' | 'B' | 'C', st: State): Promise<void> {
  if (st.tenants[label]?.apiKey && st.tenants[label]?.websiteStatus === 'ACTIVE' && !force) {
    console.log(`Tenant ${label}: đã có và website ACTIVE, bỏ qua (dùng --force để làm lại)`);
    return;
  }
  const c = cfg();
  const pool = need('TM_CONSOLE_USER_POOL_ID');
  const existing = st.tenants[label];
  const username = existing?.username ?? `tm-e2e-${stage}-${label.toLowerCase()}@${domain}`;
  const password = existing?.password ?? pw();
  const origin = need(`TM_DEMO_ORIGIN_${label}`);
  const expectedSlug = new URL(origin).hostname.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  if (Object.values(st.tenants).some((t) => t && t.label !== label && t.slug === expectedSlug)) {
    throw new Error(`TM_DEMO_ORIGIN_${label} dùng hostname trùng với tenant khác: ${expectedSlug}`);
  }
  const t: TenantState = existing ?? {
    label, username, password, tenantId: '', slug: expectedSlug, origin,
    apiKey: '', keyId: '', jobId: '', fileKey: '', tmText: '', tmHash: '',
  };
  t.origin = origin;
  st.tenants[label] = t;
  if (!dry) saveState(st); // Giữ credential ổn định nếu seed bị ngắt giữa chừng.
  aws(['cognito-idp', 'sign-up', '--client-id', c.consoleClientId, '--username', username, '--password', password,
    '--user-attributes', `Name=email,Value=${username}`, ...region], { allowFail: true });
  aws(['cognito-idp', 'admin-set-user-password', '--user-pool-id', pool, '--username', username, '--password', password,
    '--permanent', ...region]);
  aws(['cognito-idp', 'admin-confirm-sign-up', '--user-pool-id', pool, '--username', username, ...region], { allowFail: true });
  if (dry) { console.log(`[dry-run] tenant ${label}: đăng nhập, tạo website, API key, TM, job`); return; }

  // PostConfirmation tạo tenant và gán custom:tenant_id; không phụ thuộc route /console/me.
  let tok = '';
  for (let i = 0; i < 15; i++) {
    try {
      tok = await login(c.consoleClientId, username, password);
      const claim = idTokenClaims(tok)['custom:tenant_id'];
      if (typeof claim === 'string' && /^t_[A-Za-z0-9_-]{1,64}$/.test(claim)) { t.tenantId = claim; break; }
    } catch { /* Cognito trigger may still be completing. */ }
    await sleep(2000);
  }
  if (!t.tenantId) throw new Error(`Tenant ${label}: ID token chưa có custom:tenant_id; kiểm tra PostConfirmation và app client.`);

  const existingHosts = must(await call('GET', R.hosts, { token: tok }), 'GET /console/hosts');
  const priorHost = listOf(existingHosts.body).find((h: any) => h?.slug === expectedSlug);
  let slug = expectedSlug;
  if (priorHost) {
    slug = String(priorHost.slug);
  } else {
    const created = must(await call('POST', R.hosts, { token: tok, body: B.addHost(`e2e-${label}`, origin) }), 'POST /console/hosts');
    slug = created.body?.host?.slug;
    if (typeof slug !== 'string' || slug !== expectedSlug) {
      throw new Error(`Tenant ${label}: API trả slug website không khớp hostname ${expectedSlug}`);
    }
  }
  t.slug = slug;
  t.websiteStatus = priorHost?.status === 'ACTIVE' ? 'ACTIVE' : 'PENDING';
  saveState(st);
  if (priorHost?.status !== 'ACTIVE') {
    const ver = await call('POST', R.hostVerify(slug), { token: tok, body: { method: 'META' } });
    const verifiedStatus = ver.body?.host?.status ?? ver.body?.status;
    if (ver.status < 200 || ver.status >= 300 || verifiedStatus !== 'ACTIVE') {
      throw new Error(
        `Tenant ${label}: website ${slug} chưa ACTIVE sau xác minh ` +
        `(HTTP ${ver.status}, status=${verifiedStatus ?? 'không có'}). Seed dừng tại đây; ` +
        `kiểm tra TM_DEMO_ORIGIN_${label}, cấu hình META và hoàn tất xác minh website, ` +
        `sau đó chạy lại "npm run demo:seed -- tenants". State hiện tại chưa đủ điều kiện chạy bài test khóa tenant.`,
      );
    }
    t.websiteStatus = 'ACTIVE';
    saveState(st);
  }

  if (!t.apiKey || force) {
    const k = must(await call('POST', R.apiKeys, { token: tok, body: B.createKey(`e2e-${label}`) }), 'POST /console/api-keys');
    t.apiKey = keyValueOf(k.body); t.keyId = keyIdOf(k.body);
    if (!t.apiKey || !t.keyId) throw new Error(`Tenant ${label}: response API key thiếu key_id hoặc api_key`);
    saveState(st);
  }

  if (!t.tmText || force) { t.tmText = `Xin chào từ tenant ${label} ${hex(3)}`; t.tmHash = hashSentence(t.tmText); saveState(st); }
  must(await call('POST', R.translate, { apiKey: t.apiKey, body: B.translate(t.tmText) }), 'POST /translate/realtime');

  if (!t.jobId || force) {
    const contents = 'Xin chào\n';
    const contentType = 'text/plain';
    const up = must(await call('POST', R.uploadUrl, {
      apiKey: t.apiKey, body: B.uploadUrl('e2e.txt', Buffer.byteLength(contents)),
    }), 'POST /translate/batch/upload-url');
    const fileKey: string = up.body.file_key;
    const put = await fetch(up.body.upload_url, { method: 'PUT', headers: { 'Content-Type': contentType }, body: contents });
    if (!put.ok) throw new Error(`Tải tệp lên thất bại: ${put.status}`);
    t.fileKey = fileKey;
    const job = must(await call('POST', R.batch, { apiKey: t.apiKey, body: B.batch(fileKey) }), 'POST /translate/batch');
    t.jobId = jobIdOf(job.body);
    if (!t.jobId) throw new Error(`Tenant ${label}: response batch thiếu job_id`);
    saveState(st);
  }

  if (label === 'C' && (!t.tinyApiKey || force)) {
    // Key thứ hai sẽ được chuyển sang usage plan nhỏ ở bước tiny-plan
    const k2 = must(await call('POST', R.apiKeys, { token: tok, body: B.createKey('e2e-C-tiny') }), 'POST /console/api-keys (tiny)');
    t.tinyApiKey = keyValueOf(k2.body); t.tinyKeyId = keyIdOf(k2.body);
    saveState(st);
  }
  console.log(`Tenant ${label}: ${t.tenantId}, website ${slug}, key ${t.keyId}, job ${t.jobId}`);
}

function seedTinyPlan(st: State): void {
  const c = st.tenants.C;
  if (!dry && !c?.tinyKeyId) throw new Error('Chạy "seed tenants" trước (cần tenant C có key tiny).');
  const apiId = need('TM_API_ID'), apiStage = need('TM_API_STAGE');
  let planId = st.tinyPlanId;
  if (!planId || force) {
    const r = aws(['apigateway', 'create-usage-plan', '--name', `translateme-${stage}-e2e-tiny`,
      '--throttle', 'burstLimit=100,rateLimit=100', '--quota', 'limit=3,period=DAY',
      '--api-stages', `apiId=${apiId},stage=${apiStage}`, ...region]);
    planId = r.id ?? 'DRY-RUN';
  }
  const selectedPlanId = planId ?? 'DRY-RUN';
  const keyId = c?.tinyKeyId ?? 'DRY-RUN-KEY';
  if (!dry && st.tinyPlanId && st.tinyPlanId !== selectedPlanId) {
    aws(['apigateway', 'delete-usage-plan-key', '--usage-plan-id', st.tinyPlanId, '--key-id', keyId, ...region], { allowFail: true });
  }
  // Một key chỉ ở một usage plan trên cùng một stage: gỡ khỏi plan Basic trước khi thêm vào plan nhỏ
  aws(['apigateway', 'delete-usage-plan-key', '--usage-plan-id', need('TM_PLAN_BASIC'), '--key-id', keyId, ...region], { allowFail: true });
  const attached = dry ? undefined : aws(['apigateway', 'get-usage-plan-keys', '--usage-plan-id', selectedPlanId, '--key-id', keyId, ...region], { readonly: true });
  if (dry || !attached?.items?.some((item: any) => item.id === keyId)) {
    aws(['apigateway', 'create-usage-plan-key', '--usage-plan-id', selectedPlanId, '--key-id', keyId, '--key-type', 'API_KEY', ...region]);
  }
  st.tinyPlanId = selectedPlanId;
  if (!dry) saveState(st);
  console.log(`${dry ? '[dry-run] ' : ''}Usage plan nhỏ ${selectedPlanId} (3 yêu cầu/ngày) gắn cho key ${keyId}`);
}

async function main() {
  const cmd = argv.find((a) => !a.startsWith('--')) ?? 'all';
  const st = loadOrNew();
  if (cmd === 'platform' || cmd === 'all') await seedPlatform(st);
  if (!dry) saveState(st);
  if (cmd === 'tenants' || cmd === 'all') for (const l of ['A', 'B', 'C'] as const) await seedTenant(l, st);
  if (cmd === 'tiny-plan' || cmd === 'all') seedTinyPlan(st);
  if (!['platform', 'tenants', 'tiny-plan', 'all'].includes(cmd)) { console.error('Lệnh: platform | tenants | tiny-plan | all'); process.exit(1); }
  console.log(`\nTrạng thái: ${stateFile(stage)} (chứa mật khẩu và key, không commit)`);
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
