// Kiểm tra tĩnh infra/stacks/*.yaml (không cần AWS): cfn-lint không thấy được export/import giữa các stack và
// tham số/output của stack lồng nhau, nên kiểm tra ở đây theo đúng thứ tự deploy của demo/deploy.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { STACKS } from '../demo/aws';

const infra = resolve(__dirname, '..', '..', 'infra');
const ORDER = ['bootstrap', ...STACKS];
const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const stackFile = (s: string) => join(infra, 'stacks', `${s}.yaml`);

/** Khóa cấp 2 trong một section cấp 1 (Parameters/Resources/Outputs) kèm khối nội dung của từng khóa. */
function section(text: string, name: string): Map<string, string> {
  const lines = text.split('\n');
  const start = lines.indexOf(`${name}:`);
  const out = new Map<string, string>();
  if (start < 0) return out;
  let key = '';
  let buf: string[] = [];
  for (let i = start + 1; i < lines.length && !/^\S/.test(lines[i]); i++) {
    const m = /^ {2}([A-Za-z0-9]+):\s*$/.exec(lines[i]);
    if (m) {
      if (key) out.set(key, buf.join('\n'));
      key = m[1];
      buf = [];
    } else buf.push(lines[i]);
  }
  if (key) out.set(key, buf.join('\n'));
  return out;
}

const exportsOf = (t: string) => [...t.matchAll(/Export:\s*\{?\s*Name: !Sub 'translateme-\$\{StageName\}-([A-Za-z]+)'/g)].map((m) => m[1]);
const importsOf = (t: string) => [...t.matchAll(/'Fn::ImportValue': !Sub 'translateme-\$\{StageName\}-([A-Za-z]+)'/g)].map((m) => m[1]);

test('đủ 8 template; mỗi stack có tham số StageName (deploy.ts luôn truyền)', () => {
  for (const s of ORDER) {
    assert.ok(existsSync(stackFile(s)), s);
    assert.ok(section(read(stackFile(s)), 'Parameters').has('StageName'), `${s} thiếu StageName`);
  }
});

test('mọi Fn::ImportValue đều được export bởi một stack deploy TRƯỚC nó; không export trùng', () => {
  const seen = new Map<string, string>();
  for (const s of ORDER) {
    const t = read(stackFile(s));
    for (const imp of importsOf(t)) assert.ok(seen.has(imp), `${s} import ${imp} nhưng chưa stack nào trước nó export`);
    for (const exp of exportsOf(t)) {
      assert.ok(!seen.has(exp), `${exp} export ở cả ${seen.get(exp)} và ${s}`);
      seen.set(exp, s);
    }
  }
});

test('stack lồng nhau: tệp module tồn tại, truyền đúng tham số (không thừa, không thiếu tham số bắt buộc), Outputs được dùng có thật', () => {
  for (const s of ORDER) {
    const t = read(stackFile(s));
    const resources = section(t, 'Resources');
    const nestedFiles = new Map<string, string>();
    for (const [name, body] of resources) {
      if (!/Type: AWS::CloudFormation::Stack/.test(body)) continue;
      const url = /TemplateURL: (\S+)/.exec(body)![1];
      const file = resolve(dirname(stackFile(s)), url);
      assert.ok(existsSync(file), `${s}.${name}: ${url}`);
      nestedFiles.set(name, file);
      const mod = read(file);
      const declared = section(mod, 'Parameters');
      const passed = [...body.matchAll(/^ {8}([A-Za-z0-9]+):/gm)].map((m) => m[1]);
      for (const p of passed) assert.ok(declared.has(p), `${s}.${name} truyền ${p} nhưng ${url} không khai báo`);
      for (const [p, decl] of declared) {
        if (!/^\s+Default:/m.test(decl)) assert.ok(passed.includes(p), `${s}.${name} thiếu tham số bắt buộc ${p} của ${url}`);
      }
    }
    for (const m of t.matchAll(/!GetAtt ([A-Za-z0-9]+)\.Outputs\.([A-Za-z0-9]+)/g)) {
      const file = nestedFiles.get(m[1]);
      assert.ok(file, `${s}: ${m[1]} không phải stack lồng nhau`);
      assert.ok(section(read(file!), 'Outputs').has(m[2]), `${s}: ${m[1]} không có output ${m[2]}`);
    }
  }
});

test('edge: CloudFront Function nhúng giống hệt infra/functions/viewer-request.js; đường dẫn hợp lệ/không hợp lệ', () => {
  const t = read(stackFile('edge'));
  const lines = t.split('\n');
  const at = lines.findIndex((l) => l.trim() === 'FunctionCode: |');
  const code = lines.slice(at + 1).filter((_, i, a) => a.slice(0, i + 1).every((l) => l.startsWith('        ') || l === '')).map((l) => l.slice(8)).join('\n').trim();
  const file = read(join(infra, 'functions', 'viewer-request.js')).trim();
  assert.equal(code, file);
  // Chạy thử hàm (cú pháp ES5 của CloudFront Functions)
  const handler = new Function(`${file}; return handler;`)() as (e: unknown) => { statusCode?: number; uri?: string };
  assert.equal(handler({ request: { uri: '/homestay-abc/en/phong/' } }).uri, '/homestay-abc/en/phong/');
  assert.equal(handler({ request: { uri: '/' } }).statusCode, 404);
  assert.equal(handler({ request: { uri: '/Bad_Slug/en/' } }).statusCode, 404);
});

test('identity: client không được ghi custom:tenant_id / custom:role (QC-3); api lượt 2 có đủ tham số', () => {
  const t = read(stackFile('identity'));
  for (const m of t.matchAll(/WriteAttributes: \[([^\]]*)\]/g)) {
    assert.ok(!/custom:tenant_id|custom:role/.test(m[1]), m[0]);
  }
  const api = section(read(stackFile('api')), 'Parameters');
  for (const p of ['BasicUsagePlanId', 'StandardUsagePlanId', 'CloudFrontDistributionId', 'PublicBaseUrl']) {
    assert.match(api.get(p)!, /Default: ''/, `${p} phải có Default '' cho lượt 1`);
  }
});

test('YAML không có khóa Null chưa đặt trong ngoặc (YAML hiểu là null, CloudFormation từ chối template)', () => {
  for (const f of ['modules/iam.yaml', 'modules/data.yaml', 'modules/lambdas.yaml', 'modules/api-gateway.yaml', 'modules/workflow.yaml', ...ORDER.map((s) => `stacks/${s}.yaml`)]) {
    assert.ok(!/^\s+Null:/m.test(read(join(infra, f))), f);
  }
});

test('API Gateway: mọi gateway response có CORS; response type trùng phải giống hệt nhau', () => {
  const resources = section(read(join(infra, 'modules', 'api-gateway.yaml')), 'Resources');
  const byType = new Map<string, string[]>();
  for (const [name, body] of resources) {
    if (!/Type: AWS::ApiGateway::GatewayResponse/.test(body)) continue;
    // Lỗi do API Gateway tự trả (401/403/429/4XX/5XX) cũng phải đọc được từ Web Console khác origin.
    assert.match(body, /gatewayresponse\.header\.Access-Control-Allow-Origin: "'\*'"/, `${name} thiếu CORS`);
    const type = /ResponseType: (\S+)/.exec(body)?.[1] ?? '';
    // So nội dung Properties, bỏ dòng chú thích và dòng trống (section() gom cả chú thích của tài nguyên kế tiếp).
    const props = body.slice(body.indexOf('Properties:')).split('\n')
      .filter((l) => l.trim() && !l.trim().startsWith('#')).join('\n');
    byType.set(type, [...(byType.get(type) ?? []), props]);
  }
  assert.ok(byType.has('UNAUTHORIZED') && byType.has('INVALID_API_KEY') && byType.has('DEFAULT_4XX'));
  for (const [type, variants] of byType) {
    assert.equal(new Set(variants).size, 1, `${type} khai báo nhiều lần với nội dung khác nhau`);
  }
});

test('IAM: role đọc DynamoDB trực tiếp (không qua phiên tenant) có kms:Decrypt cho bảng mã hóa KMS', () => {
  const resources = section(read(join(infra, 'modules', 'iam.yaml')), 'Resources');
  const direct = [...resources].filter(([, body]) =>
    /Type: AWS::IAM::Role/.test(body) && /Action: dynamodb:GetItem\s*\n\s*Resource: !Ref TableArn/.test(body));
  assert.deepEqual(direct.map(([n]) => n).sort(), ['ProxyExecutionRole', 'TranslateApiExecutionRole', 'WorkerExecutionRole']);
  for (const [name, body] of direct) {
    assert.match(body, /- kms:Decrypt[\s\S]*?Resource: !Ref KmsKeyArn[\s\S]*?kms:ViaService: !Sub 'dynamodb\./, `${name} thiếu kms:Decrypt`);
  }
});

test('IAM: dynamodb:LeadingKeys (khóa nhiều giá trị) luôn dùng ForAllValues kèm Null false', () => {
  for (const file of ['iam.yaml', 'data.yaml', 'lambdas.yaml', 'workflow.yaml']) {
    const path = join(infra, 'modules', file);
    if (!existsSync(path)) continue;
    const lines = read(path).split('\n');
    lines.forEach((line, i) => {
      if (!/^\s*dynamodb:LeadingKeys:/.test(line)) return;
      const indent = line.search(/\S/);
      // Dòng cha gần nhất thụt lề ít hơn là toán tử điều kiện.
      let j = i - 1;
      while (j >= 0 && (lines[j].trim().startsWith('#') || lines[j].search(/\S/) >= indent)) j--;
      const operator = lines[j].trim();
      if (operator === "'Null':") return;
      assert.match(operator, /^ForAllValues:String(Like|Equals):$/, `${file}:${i + 1} dùng ${operator} cho dynamodb:LeadingKeys`);
    });
  }
});

test('batch workflow streams lô từ manifest S3 và đối soát khi execution kết thúc lỗi', () => {
  const workflow = section(read(join(infra, 'modules', 'workflow.yaml')), 'Resources');
  const source = workflow.get('BatchStateMachine')!;
  const definition = source.split('        - |-\n')[1].split('\n        - BatchWorkflowArn')[0];
  const { States: states } = JSON.parse(definition);
  assert.equal(states.ParseAndChunk.Parameters.distributed, true);
  assert.equal(states.TranslateLots.ItemReader.Parameters['Key.$'], '$.lot_index_key');
  assert.equal(states.TranslateLots.ItemProcessor.ProcessorConfig.Mode, 'DISTRIBUTED');
  assert.ok(states.TranslateLots.ResultWriter.Parameters['Prefix.$'].includes('map-results'));
  assert.match(workflow.get('BatchTerminalExecutionRule')!, /status: \[FAILED, TIMED_OUT, ABORTED\]/);
  assert.match(workflow.get('BatchStateMachineRole')!, /lot-index\.json/);
  const lambdas = section(read(join(infra, 'modules', 'lambdas.yaml')), 'Resources');
  assert.match(lambdas.get('BatchWorkflowFunction')!, /DATA_KMS_KEY_ARN: !Ref KmsKeyArn/);
  assert.match(lambdas.get('TranslateFunction')!, /AWS_REQUEST_CHECKSUM_CALCULATION: WHEN_REQUIRED/);
});

test('các route batch và Platform có method rõ ràng bên dưới resource cụ thể', () => {
  const resources = section(read(join(infra, 'modules', 'api-gateway.yaml')), 'Resources');
  const methodNames = [
    'ApiBatchMethod', 'ApiBatchUploadUrlMethod', 'ApiBatchJobMethod',
    'BatchSessionJobMethod', 'PlatformTenantsGetMethod', 'PlatformTenantGetMethod', 'PlatformTenantLimitsMethod',
  ];
  const deployment = [...resources].find(([, body]) => body.includes('Type: AWS::ApiGateway::Deployment'))!;
  for (const name of methodNames) {
    const method = resources.get(name)!;
    assert.match(method, name.startsWith('ApiBatch') ? /ApiKeyRequired: true/ : /AuthorizationType: COGNITO_USER_POOLS/);
    assert.ok(deployment[1].includes('- ' + name));
  }
});

test('preflight Platform trả CORS trên đúng resource và được đưa vào deployment', () => {
  const resources = section(read(join(infra, 'modules', 'api-gateway.yaml')), 'Resources');
  const [deploymentName, deployment] = [...resources].find(([, body]) => body.includes('Type: AWS::ApiGateway::Deployment'))!;
  assert.ok(resources.get('ApiStage')?.includes(`DeploymentId: !Ref ${deploymentName}`));

  for (const [name, resource, method] of [
    ['PlatformTenantsOptionsMethod', 'PlatformTenantsResource', 'GET'],
    ['PlatformTenantOptionsMethod', 'PlatformTenantResource', 'GET'],
    ['PlatformTenantLimitsOptionsMethod', 'PlatformTenantLimitsResource', 'PATCH'],
    ['PlatformTenantStatusOptionsMethod', 'PlatformTenantStatusResource', 'PATCH'],
  ]) {
    const preflight = resources.get(name);
    assert.ok(preflight, `Thiếu OPTIONS cho ${resource}`);
    assert.ok(preflight.includes(`ResourceId: !Ref ${resource}\n`));
    assert.match(preflight, /HttpMethod: OPTIONS/);
    assert.match(preflight, /AuthorizationType: NONE/);
    assert.doesNotMatch(preflight, /AuthorizerId:|ApiKeyRequired: true/);
    assert.match(preflight, /Type: MOCK/);
    assert.match(preflight, /"statusCode":200/);
    for (const [header, value] of [
      ['Access-Control-Allow-Origin', '*'],
      ['Access-Control-Allow-Headers', 'Authorization,Content-Type'],
      ['Access-Control-Allow-Methods', `${method},OPTIONS`],
    ]) {
      const parameter = `method.response.header.${header}`;
      assert.ok(preflight.includes(`${parameter}: "'${value}'"`));
      assert.ok(preflight.includes(`${parameter}: true`));
    }
    assert.ok(deployment.includes(`- ${name}\n`));
  }
});
