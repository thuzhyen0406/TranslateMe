// Bước 1–2 của runbook triển khai demo (5.4): kiểm tra điều kiện trước khi deploy và sau khi deploy.
//   npm run demo:preflight                 # trước khi deploy
//   npm run demo:preflight -- --post       # sau khi deploy: thêm kiểm tra stack, Cognito, API
// Mã thoát 1 nếu có mục FAIL. WARN không chặn nhưng phải ghi vào báo cáo.
import { aws, arg, flag, git, STACKS, stackName } from './aws';

type Status = 'PASS' | 'WARN' | 'FAIL';
interface Result { name: string; status: Status; detail: string }
const results: Result[] = [];
const add = (name: string, status: Status, detail: string) => results.push({ name, status, detail });

const stage = arg('stage') ?? process.env.TM_STAGE ?? 'dev';
const region = process.env.TM_REGION ?? '';
const rflag = region ? ['--region', region] : [];

function check(name: string, fn: () => [Status, string]) {
  try { const [s, d] = fn(); add(name, s, d); } catch (e) { add(name, 'FAIL', (e as Error).message.slice(0, 200)); }
}

check('Tài khoản AWS', () => {
  const want = process.env.TM_ACCOUNT;
  if (!want) return ['FAIL', 'chưa đặt TM_ACCOUNT; cần AWS account ID đích gồm 12 chữ số'];
  if (!/^\d{12}$/.test(want)) return ['FAIL', `TM_ACCOUNT không hợp lệ: ${want}; cần đúng 12 chữ số`];
  const id = aws(['sts', 'get-caller-identity'], { readonly: true });
  if (id.Account !== want) return ['FAIL', `đang dùng tài khoản ${id.Account ?? '(không xác định)'}, mong đợi ${want}`];
  return ['PASS', `tài khoản ${id.Account} khớp TM_ACCOUNT`];
});

check('Region thống nhất', () => {
  if (!region) return ['FAIL', 'chưa đặt TM_REGION; cả nhóm phải dùng đúng một Region'];
  const envRegion = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  if (envRegion && envRegion !== region) return ['FAIL', `AWS_REGION=${envRegion} khác TM_REGION=${region}`];
  return ['PASS', region];
});

check('Amazon Translate truy cập được', () => {
  // API chỉ đọc, không tạo giao dịch dịch có tính phí trong bước preflight.
  const r = aws(['translate', 'list-terminologies', '--max-results', '1', ...rflag], { readonly: true });
  // ListTerminologies trả về TerminologyPropertiesList (không phải TerminologyProperties).
  const list = r.TerminologyPropertiesList ?? [];
  return Array.isArray(list) ? ['PASS', `đọc được danh sách terminology (${list.length})`] : ['FAIL', 'phản hồi AWS không đúng định dạng'];
});

check('Lambda đồng thời (Service Quotas)', () => {
  const r = aws(['lambda', 'get-account-settings', ...rflag], { readonly: true });
  const n = r.AccountLimit?.ConcurrentExecutions;
  const min = Number(process.env.TM_MIN_LAMBDA_CONCURRENCY ?? '50');
  if (typeof n !== 'number') return ['FAIL', 'không đọc được hạn mức'];
  if (n < 10) return ['FAIL', `chỉ ${n} thực thi đồng thời, không đủ cho batch; xin tăng Service Quotas`];
  if (n < min) return ['WARN', `${n} thực thi đồng thời (< ${min}); giảm MAP_MAX_CONCURRENCY và ghi vào báo cáo`];
  return ['PASS', `${n} thực thi đồng thời`];
});

check('SES (email cảnh báo và batch)', () => {
  const acc = aws(['sesv2', 'get-account', ...rflag], { readonly: true });
  const ids = aws(['sesv2', 'list-email-identities', ...rflag], { readonly: true });
  const verified = (ids.EmailIdentities ?? []).filter((i: any) => i.SendingEnabled).length;
  if (!acc.ProductionAccessEnabled) {
    return verified > 0
      ? ['WARN', `SES còn sandbox, ${verified} danh tính đã xác minh: chỉ gửi tới địa chỉ đã xác minh, dùng SNS dự phòng`]
      : ['FAIL', 'SES sandbox và chưa có danh tính nào được xác minh'];
  }
  return ['PASS', `production access, ${verified} danh tính`];
});

check('AWS Budgets', () => {
  const id = aws(['sts', 'get-caller-identity'], { readonly: true });
  const r = aws(['budgets', 'describe-budgets', '--account-id', id.Account], { readonly: true });
  const n = (r.Budgets ?? []).length;
  return n > 0 ? ['PASS', `${n} budget`] : ['FAIL', 'chưa có AWS Budgets; bật trước khi chạy kiểm thử tải'];
});

check('Mã nguồn sẵn sàng phát hành', () => {
  const dirty = git(['status', '--porcelain']);
  if (dirty.out) return [stage === 'demo' ? 'FAIL' : 'WARN', 'còn thay đổi chưa commit'];
  const tag = git(['describe', '--exact-match', '--tags', 'HEAD']);
  if (!tag.ok || !/^v\d/.test(tag.out)) {
    return [stage === 'demo' ? 'FAIL' : 'WARN', 'HEAD chưa có thẻ phát hành dạng vX.Y.Z (bắt buộc cho demo)'];
  }
  return ['PASS', `thẻ ${tag.out}`];
});

if (flag('post')) {
  for (const s of STACKS) {
    check(`Stack ${s}`, () => {
      const r = aws(['cloudformation', 'describe-stacks', '--stack-name', stackName(stage, s), ...rflag], { readonly: true });
      const st = r.Stacks?.[0]?.StackStatus as string | undefined;
      return st && /^(CREATE|UPDATE)_COMPLETE$/.test(st) ? ['PASS', st] : ['FAIL', st ?? 'không tồn tại'];
    });
  }
  for (const [label, poolEnv, clientEnv] of [
    ['console', 'TM_CONSOLE_USER_POOL_ID', 'TM_CONSOLE_CLIENT_ID'],
    ['platform', 'TM_PLATFORM_USER_POOL_ID', 'TM_PLATFORM_CLIENT_ID'],
  ] as const) {
    check(`Cognito ${label}: đăng nhập bằng mật khẩu cho test`, () => {
      const pool = process.env[poolEnv], client = process.env[clientEnv];
      if (!pool || !client) return ['FAIL', `thiếu ${poolEnv} hoặc ${clientEnv}`];
      const r = aws(['cognito-idp', 'describe-user-pool-client', '--user-pool-id', pool, '--client-id', client, ...rflag], { readonly: true });
      const flows: string[] = r.UserPoolClient?.ExplicitAuthFlows ?? [];
      return flows.includes('ALLOW_USER_PASSWORD_AUTH')
        ? ['PASS', 'ALLOW_USER_PASSWORD_AUTH bật']
        : ['FAIL', 'app client chưa bật ALLOW_USER_PASSWORD_AUTH, bộ test không đăng nhập được'];
    });
  }
}

const w = Math.max(...results.map((r) => r.name.length));
for (const r of results) console.log(`${r.status.padEnd(4)} ${r.name.padEnd(w)}  ${r.detail}`);
const fails = results.filter((r) => r.status === 'FAIL').length;
const warns = results.filter((r) => r.status === 'WARN').length;
console.log(`\n${results.length - fails - warns} PASS, ${warns} WARN, ${fails} FAIL`);
process.exit(fails ? 1 : 0);
