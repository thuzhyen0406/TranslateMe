// Bước 3 của runbook (5.4): triển khai 7 stack CloudFormation theo đúng thứ tự Bảng 2.25.
//   npm run demo:deploy -- --stage dev
//   npm run demo:deploy -- --stage demo --approved-by "Nguyễn Thị Thu Huyền"
//   thêm --only <stack> để chỉ deploy một stack, --dry-run để chỉ in lệnh
// Quy tắc: demo chỉ deploy từ thẻ phát hành sạch và phải có người duyệt (nhóm trưởng).
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { aws, arg, flag, git, STACKS, stackName, stackTemplate } from './aws';

const stage = arg('stage') ?? process.env.TM_STAGE ?? 'dev';
const only = arg('only');
const approvedBy = arg('approved-by');
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

// Không dựa vào việc người chạy đã gọi preflight: xác minh credentials ngay
// trong tiến trình deploy, trước khi có bất kỳ lệnh CloudFormation ghi nào.
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

const dir = resolve(process.env.TM_TEMPLATE_DIR ?? '../infra/stacks');
const order = only ? STACKS.filter((s) => s === only) : [...STACKS];
if (!order.length) { console.error(`--only phải là một trong: ${STACKS.join(', ')}`); process.exit(1); }

const templates = new Map(order.map((s) => [s, resolve(stackTemplate(dir, s))]));
const missing = [...templates.entries()].filter(([, tpl]) => !existsSync(tpl));
if (missing.length && !flag('dry-run')) {
  console.error('Thiếu CloudFormation stack template(s):');
  for (const [s, tpl] of missing) console.error(`  ${s}: ${tpl}`);
  console.error('TM_TEMPLATE_DIR phải trỏ tới thư mục có data.yaml, identity.yaml, api.yaml, edge.yaml, workflow.yaml, console.yaml và ops.yaml; có thể ghi đè từng file bằng TM_TEMPLATE_<STACK>.');
  console.error('Các file trong infra/modules/ là module template, chưa phải bảy stack entry point độc lập.');
  process.exit(1);
}

for (const s of order) {
  const tpl = templates.get(s)!;
  const extra = (process.env[`TM_PARAMS_${s.toUpperCase()}`] ?? '').split(/\s+/).filter(Boolean);
  console.log(`\n== ${s} -> ${stackName(stage, s)}`);
  aws([
    'cloudformation', 'deploy', '--template-file', tpl, '--stack-name', stackName(stage, s),
    '--capabilities', 'CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND', '--no-fail-on-empty-changeset',
    '--region', region, '--parameter-overrides', `${process.env.TM_STAGE_PARAM ?? 'StageName'}=${stage}`, ...extra,
    '--tags', 'app=translateme', `stage=${stage}`,
    ...(approvedBy ? [`approved-by=${approvedBy}`] : []),
  ], { raw: true });
  if (!flag('dry-run')) {
    const r = aws(['cloudformation', 'describe-stacks', '--stack-name', stackName(stage, s), '--region', region], { readonly: true });
    const st = r.Stacks?.[0]?.StackStatus;
    console.log(`   trạng thái: ${st}`);
    if (!/^(CREATE|UPDATE)_COMPLETE$/.test(st ?? '')) { console.error('Dừng: stack không ở trạng thái hoàn tất.'); process.exit(1); }
  }
}
console.log('\nXong. Chạy: npm run demo:preflight -- --post');
