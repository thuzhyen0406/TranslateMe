// Kịch bản 4 (Bảng 3.8) và hạng mục 5.1: cô lập tenant.
// 8 phép thử dương (P1–P8) + 8 phép thử chéo (X1–X8) + phép thử phụ (E1–E4).
// Chạy lại sau MỌI lần deploy (QC-11).
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cfg } from '../lib/config';
import { loadState, State } from '../lib/state';
import { login } from '../lib/auth';
import { call, errCode } from '../lib/http';
import { B, R, hashSentence, listOf } from '../lib/contract';
import { assertDenied, lookalike } from '../lib/compare';
import { ev } from '../lib/evidence';

const SC = 4;
let S: State;
let tokA = '', tokB = '', tokPlat = '';
const A = () => S.tenants.A;
const Bt = () => S.tenants.B;

before(async () => {
  const c = cfg();
  S = loadState(c.stage);
  tokA = await login(c.consoleClientId, A().username, A().password);
  tokB = await login(c.consoleClientId, Bt().username, Bt().password);
  tokPlat = await login(c.platformClientId, S.platform.username, S.platform.password);
});

describe('Kịch bản 4 – phép thử dương: tenant A đọc dữ liệu của chính mình', () => {
  it('P1 /console/me trả vai trò và trạng thái ACTIVE', ev(SC, 'P1', 'GET /console/me', async (note) => {
    const r = await call('GET', R.me, { token: tokA });
    note('status', r.status);
    assert.equal(r.status, 200);
    assert.ok(r.text.includes('ACTIVE'), 'trạng thái tenant phải là ACTIVE');
    assert.ok(r.body?.request_id, 'mọi phản hồi có request_id');
  }));

  it('P2 danh sách website chỉ có website của A', ev(SC, 'P2', 'GET /console/hosts', async (note) => {
    const r = await call('GET', R.hosts, { token: tokA });
    note('status', r.status);
    assert.equal(r.status, 200);
    assert.ok(r.text.includes(A().slug), 'phải thấy website của A');
    assert.ok(!r.text.includes(Bt().slug), 'không được thấy website của B');
  }));

  it('P3 dịch thời gian thực bằng API key của A', ev(SC, 'P3', 'POST /translate/realtime', async (note) => {
    const r = await call('POST', R.translate, { apiKey: A().apiKey, body: B.translate(A().tmText) });
    note('status', r.status);
    assert.equal(r.status, 200);
    assert.equal(typeof r.body?.translated_text, 'string');
    assert.ok('characters_from_memory' in r.body && 'characters_machine_translated' in r.body);
  }));

  it('P4 bộ nhớ dịch của A có câu của A', ev(SC, 'P4', 'GET /console/tm', async (note) => {
    const r = await call('GET', R.tm, { token: tokA });
    note('status', r.status);
    assert.equal(r.status, 200);
    assert.ok(r.text.includes(A().tmHash), 'TM của A phải chứa câu của A');
    assert.ok(!r.text.includes(Bt().tmHash), 'TM của A không được chứa câu của B');
  }));

  it('P5 job của A đọc được bằng JWT của A', ev(SC, 'P5', 'GET /console/jobs/{job_id}', async (note) => {
    const r = await call('GET', R.job(A().jobId), { token: tokA });
    note('status', r.status);
    assert.equal(r.status, 200);
    assert.ok(r.body?.status, 'job phải có status');
  }));

  it('P6 lượng dùng của A', ev(SC, 'P6', 'GET /console/usage', async (note) => {
    const r = await call('GET', R.usage(cfg().platformKeyMonth), { token: tokA });
    note('status', r.status);
    assert.equal(r.status, 200);
  }));

  it('P7 API key của A: có keyId, KHÔNG có giá trị key', ev(SC, 'P7', 'GET /console/api-keys', async (note) => {
    const r = await call('GET', R.apiKeys, { token: tokA });
    note('status', r.status);
    assert.equal(r.status, 200);
    assert.ok(r.text.includes(A().keyId), 'phải thấy key của A');
    assert.ok(!r.text.includes(A().apiKey), 'không được đọc lại giá trị key sau khi tạo');
    assert.ok(!r.text.includes(Bt().keyId), 'không được thấy key của B');
  }));

  it('P8 thuật ngữ của A', ev(SC, 'P8', 'GET /console/glossary/terms', async (note) => {
    const r = await call('GET', R.glossary, { token: tokA });
    note('status', r.status);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(listOf(r.body)));
  }));
});

describe('Kịch bản 4 – phép thử chéo: A truy cập tài nguyên của B (phải giống hệt "không tồn tại")', () => {
  it('X1 JWT của A đọc job của B', ev(SC, 'X1', 'JWT A -> GET /console/jobs/{job B}', async (note) => {
    const run = (id: string) => call('GET', R.job(id), { token: tokA });
    const [x, base] = [await run(Bt().jobId), await run(lookalike(Bt().jobId))];
    note('status', x.status); note('code', errCode(x));
    assertDenied(x, base, { forbidden: [Bt().jobId, Bt().fileKey] });
  }));

  it('X2 JWT của A sửa website của B', ev(SC, 'X2', 'JWT A -> PATCH /console/hosts/{slug B}', async (note) => {
    const run = (slug: string) => call('PATCH', R.host(slug), { token: tokA, body: B.noopHostPatch() });
    const [x, base] = [await run(Bt().slug), await run(lookalike(Bt().slug))];
    note('status', x.status); note('code', errCode(x));
    assertDenied(x, base, { forbidden: [Bt().origin] });
  }));

  it('X3 JWT của A xem trang chứa câu TM của B', ev(SC, 'X3', 'JWT A -> GET /console/tm/{hash B}/pages', async (note) => {
    const run = (h: string) => call('GET', R.tmPages(h), { token: tokA });
    const [x, base] = [await run(Bt().tmHash), await run(lookalike(Bt().tmHash))];
    note('status', x.status); note('code', errCode(x));
    assertDenied(x, base, { forbidden: [Bt().slug, Bt().tmText] });
  }));

  it('X4 JWT của A tải kết quả batch của B', ev(SC, 'X4', 'JWT A -> GET /console/batch/{job B}', async (note) => {
    const run = (id: string) => call('GET', R.consoleBatch(id), { token: tokA });
    const own = await call('GET', R.consoleBatch(Bt().jobId), { token: tokB });
    assert.equal(own.status, 200, 'tenant B phải đọc được kết quả batch của chính mình trước khi thử truy cập chéo');
    const [x, base] = [await run(Bt().jobId), await run(lookalike(Bt().jobId))];
    note('status', x.status); note('code', errCode(x));
    assertDenied(x, base, { forbidden: [Bt().jobId, 'download_url', Bt().fileKey] });
  }));

  it('X5 API key của A không thay thế được JWT khi đọc batch job của B', ev(SC, 'X5', 'API key A -> GET /console/jobs/{job B}', async (note) => {
    const run = (id: string, apiKey?: string) => call('GET', R.job(id), apiKey ? { apiKey } : {});
    const [x, base] = [await run(Bt().jobId, A().apiKey), await run(lookalike(Bt().jobId))];
    note('status', x.status); note('code', errCode(x));
    assert.ok([401, 403].includes(x.status), `API key không được xác thực trên Console, nhận ${x.status}`);
    assert.deepEqual({ status: x.status, code: errCode(x) ?? null }, { status: base.status, code: errCode(base) ?? null });
    assert.ok(!x.text.includes(Bt().jobId) && !x.text.includes(Bt().fileKey), 'không được lộ dữ liệu job của B');
  }));

  it('X6 JWT của A xác minh slug của B', ev(SC, 'X6', 'JWT A -> POST /console/hosts/{slug B}/verify', async (note) => {
    const run = (slug: string) => call('POST', R.hostVerify(slug), { token: tokA, body: { method: 'META' } });
    const [x, base] = [await run(Bt().slug), await run(lookalike(Bt().slug))];
    note('status', x.status); note('code', errCode(x));
    assertDenied(x, base, { forbidden: [Bt().origin], expectCode: 'SITE_UNREACHABLE' });
  }));

  it('X7 file_key của B đưa vào batch của A (presigned URL / tệp)', ev(SC, 'X7', 'API key A -> POST /translate/batch {file_key B}', async (note) => {
    const run = (k: string) => call('POST', R.batch, { apiKey: A().apiKey, body: B.batch(k) });
    const [x, base] = [await run(Bt().fileKey), await run(lookalike(Bt().fileKey))];
    note('status', x.status); note('code', errCode(x));
    assertDenied(x, base, { forbidden: [Bt().fileKey], expectCode: null });
    assert.ok(![200, 201, 202].includes(x.status), 'không được tạo job từ tệp của tenant khác');
  }));

  it('X8 tenant_id của B trong body và header bị bỏ qua', ev(SC, 'X8', 'API key A -> POST /translate/realtime {tenant_id B}', async (note) => {
    const text = `Câu thử cô lập ${Date.now()}`;
    const r = await call('POST', R.translate, {
      apiKey: A().apiKey,
      headers: { 'x-tenant-id': Bt().tenantId },
      body: B.translate(text, { tenant_id: Bt().tenantId }),
    });
    note('status', r.status);
    assert.equal(r.status, 200, 'trường lạ phải bị bỏ qua, không gây lỗi riêng');
    const h = hashSentence(text);
    const tmA = await call('GET', R.tm, { token: tokA });
    const tmB = await call('GET', R.tm, { token: tokB });
    assert.ok(tmA.text.includes(h), 'câu phải nằm trong TM của A');
    assert.ok(!tmB.text.includes(h), 'câu không được lọt vào TM của B');
  }));
});

describe('Kịch bản 4 – phép thử phụ: xác thực và Platform Admin', () => {
  it('E1 không có token thì 401 UNAUTHORIZED', ev(SC, 'E1', 'GET /console/me không token', async (note) => {
    const r = await call('GET', R.me);
    note('status', r.status);
    assert.equal(r.status, 401);
  }));

  it('E2 token Platform Admin không dùng được trên /console/*', ev(SC, 'E2', 'Platform JWT -> GET /console/tm', async (note) => {
    const r = await call('GET', R.tm, { token: tokPlat });
    note('status', r.status);
    assert.ok([401, 403].includes(r.status), `nhận ${r.status}`);
    assert.ok(!r.text.includes(A().tmHash));
  }));

  it('E3 Platform Admin không đọc được nội dung TM của tenant', ev(SC, 'E3', 'Platform JWT -> GET /platform/tenants/{A}', async (note) => {
    const r = await call('GET', R.platformTenant(A().tenantId), { token: tokPlat });
    note('status', r.status);
    assert.equal(r.status, 200);
    for (const f of [A().tmHash, A().tmText, A().slug, A().apiKey]) {
      assert.ok(!r.text.includes(f), 'chỉ được có số liệu tổng hợp và cấu hình');
    }
  }));

  it('E4 token tenant không dùng được trên /platform/*', ev(SC, 'E4', 'JWT A -> GET /platform/tenants', async (note) => {
    const r = await call('GET', R.platformTenants, { token: tokA });
    note('status', r.status);
    assert.ok([401, 403].includes(r.status), `nhận ${r.status}`);
  }));
});
