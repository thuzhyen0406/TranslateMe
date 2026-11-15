// Kịch bản 5 (Bảng 3.8) và hạng mục 5.1: ba loại 429, hết hạn mức vẫn 200 với câu có trong TM,
// khóa tenant (API 403, website 302 trong 60 giây, tenant khác không bị ảnh hưởng).
// Các phép thử đổi trạng thái hệ thống chỉ chạy khi TM_ALLOW_MUTATION=1 (dev hoặc demo).
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cfg } from '../lib/config';
import { loadState, State } from '../lib/state';
import { login } from '../lib/auth';
import { call, errCode } from '../lib/http';
import { B, R } from '../lib/contract';
import { ev, record, skipCase } from '../lib/evidence';

const SC = 5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let S: State;
let tokA = '', tokB = '', tokC = '', tokPlat = '';
const c0 = () => cfg();
const mutate = () => c0().allowMutation;
const maxLockS = () => Number(process.env.TM_LOCK_MAX_S ?? '60');

before(async () => {
  const c = cfg();
  S = loadState(c.stage);
  tokA = await login(c.consoleClientId, S.tenants.A.username, S.tenants.A.password);
  tokB = await login(c.consoleClientId, S.tenants.B.username, S.tenants.B.password);
  tokC = await login(c.consoleClientId, S.tenants.C.username, S.tenants.C.password);
  tokPlat = await login(c.platformClientId, S.platform.username, S.platform.password);
});

describe('Kịch bản 5 – ba loại 429', () => {
  it('L1 RATE_LIMITED khi vượt tốc độ của gói API', ev(SC, 'L1', '429 RATE_LIMITED', async (note) => {
    const n = c0().floodN;
    const key = S.tenants.C.apiKey;
    const rs = await Promise.all(
      Array.from({ length: n }, () => call('POST', R.translate, { apiKey: key, retryRate: false, body: B.translate('xin chào') })),
    );
    const by: Record<string, number> = {};
    for (const r of rs) by[`${r.status}${errCode(r) ? ' ' + errCode(r) : ''}`] = (by[`${r.status}${errCode(r) ? ' ' + errCode(r) : ''}`] ?? 0) + 1;
    note('requests', n); note('phan_bo', by);
    assert.ok(rs.some((r) => r.status === 429 && errCode(r) === 'RATE_LIMITED'),
      `không thấy 429 RATE_LIMITED sau ${n} yêu cầu đồng thời; tăng TM_FLOOD_N hoặc kiểm tra Usage Plan`);
    assert.ok(rs.every((r) => r.status === 200 || r.status === 429), 'chỉ được có 200 hoặc 429, không có 5xx');
  }));

  it('L2 REQUEST_QUOTA_EXCEEDED khi hết hạn ngạch của gói API', ev(SC, 'L2', '429 REQUEST_QUOTA_EXCEEDED', async (note) => {
    const key = S.tenants.C.tinyApiKey;
    assert.ok(key, 'tenant C chưa có key thuộc usage plan có quota thấp; hãy seed tinyApiKey trong .state/<stage>.json bằng quy trình demo của môi trường');
    let got = '';
    for (let i = 1; i <= 12 && !got; i++) {
      const r = await call('POST', R.translate, { apiKey: key, retryRate: false, body: B.translate('xin chào') });
      note(`lan_${i}`, `${r.status} ${errCode(r) ?? ''}`.trim());
      if (r.status === 429) got = errCode(r) ?? '';
      else assert.equal(r.status, 200);
    }
    assert.equal(got, 'REQUEST_QUOTA_EXCEEDED');
  }));

  const l3Skip = !mutate() && skipCase(SC, 'L3', 'CHAR_QUOTA_EXCEEDED và TM hit', 'cần TM_ALLOW_MUTATION=1 trên dev/demo');
  it('L3 CHAR_QUOTA_EXCEEDED, nhưng câu đã có trong TM vẫn 200', { skip: l3Skip },
    ev(SC, 'L3', '429 CHAR_QUOTA_EXCEEDED và 200 cho câu trong TM', async (note) => {
      const tenant = S.tenants.C;
      const known = `Câu đã có trong bộ nhớ dịch ${Date.now()}`;
      const fresh = `Câu mới chưa từng dịch ${Date.now() + 1}`;
      const route = R.platformTenantLimits(tenant.tenantId);
      const detail = R.platformTenant(tenant.tenantId);
      const original = await call('GET', detail, { token: tokPlat });
      assert.equal(original.status, 200);
      const originalLimit = original.body?.character_limit;
      assert.ok(Number.isSafeInteger(originalLimit) && originalLimit >= 0, 'tenant C phải có hạn mức ký tự');
      const request = (text: string) => call('POST', R.translate, { apiKey: tenant.apiKey, body: B.translate(text) });
      const setLimit = (character_limit: number) => call('PATCH', route, { token: tokPlat, body: { character_limit } });

      const first = await request(known);
      assert.equal(first.status, 200, 'dịch lần đầu phải thành công để câu vào TM');
      try {
        const exhausted = await setLimit(0);
        assert.equal(exhausted.status, 200);
        const miss = await request(fresh);
        note('fresh', `${miss.status} ${errCode(miss) ?? ''}`.trim());
        assert.equal(miss.status, 429);
        assert.equal(errCode(miss), 'CHAR_QUOTA_EXCEEDED');
        const hit = await request(known);
        note('known_again', hit.status);
        assert.equal(hit.status, 200, 'câu đã có trong TM vẫn phải trả 200 khi hết hạn mức');
        assert.equal(hit.body?.characters_machine_translated, 0);
        assert.ok(hit.body?.characters_from_memory > 0);
      } finally {
        const restored = await setLimit(originalLimit);
        assert.equal(restored.status, 200, 'phải khôi phục được hạn mức của tenant C');
        const after = await call('GET', detail, { token: tokPlat });
        assert.equal(after.status, 200);
        assert.equal(after.body?.character_limit, originalLimit);
      }
    }));
});

describe('Kịch bản 5 – khóa tenant', () => {
  it('L4 khóa A: API 403, console chỉ đọc, website 302 trong 60 giây, B không bị ảnh hưởng; mở khóa phục hồi',
    { skip: (!mutate() && 'cần TM_ALLOW_MUTATION=1') || (!c0().publicBase && 'cần TM_PUBLIC_BASE') },
    ev(SC, 'L4', 'Khóa tenant A', async (note) => {
      const c = c0();
      const A = S.tenants.A, Bt = S.tenants.B;
      const siteA = R.site(c.publicBase, A.slug, 'en');
      const siteB = R.site(c.publicBase, Bt.slug, 'en');
      const get = (u: string) => call('GET', u, { absolute: true, redirect: 'manual' });

      // Làm nóng cache CloudFront: đây đúng là tình huống dễ vi phạm tiêu chí 60 giây (QC-16)
      for (let i = 0; i < 2; i++) {
        const a = await get(siteA), b = await get(siteB);
        assert.equal(a.status, 200, 'website A phải ACTIVE trước khi khóa');
        assert.equal(b.status, 200, 'website B phải ACTIVE');
      }

      const t0 = Date.now();
      try {
        // Bắt đầu try trước PATCH: API có thể đã ghi trạng thái LOCKED dù client
        // nhận lỗi hoặc timeout, vì vậy finally luôn phải thử mở khóa.
        const lock = await call('PATCH', R.tenantStatus(A.tenantId), { token: tokPlat, body: { status: 'LOCKED' } });
        note('lock', lock.status);
        assert.equal(lock.status, 200, `khóa tenant thất bại: HTTP ${lock.status} ${errCode(lock) ?? ''}`.trim());

        // API: 403 TENANT_SUSPENDED cho thao tác ghi
        let api = await call('POST', R.translate, { apiKey: A.apiKey, body: B.translate('xin chào') });
        for (let i = 0; i < 10 && api.status !== 403; i++) { await sleep(1000); api = await call('POST', R.translate, { apiKey: A.apiKey, body: B.translate('xin chào') }); }
        note('api_sau_s', Math.round((Date.now() - t0) / 1000));
        assert.equal(api.status, 403);
        assert.equal(errCode(api), 'TENANT_SUSPENDED');

        // Console: vẫn đăng nhập và đọc được, thao tác ghi bị chặn
        const read = await call('GET', R.hosts, { token: tokA });
        assert.equal(read.status, 200, 'đọc vẫn được phép khi bị khóa');
        const write = await call('POST', R.apiKeys, { token: tokA, body: B.createKey('thu-khi-khoa') });
        assert.equal(write.status, 403);
        assert.equal(errCode(write), 'TENANT_SUSPENDED');

        // Website: 302 trong tối đa 60 giây, B luôn 200
        let redirectedAt = -1, bAlways200 = true;
        while ((Date.now() - t0) / 1000 < c.lockDeadlineS) {
          const a = await get(siteA);
          const b = await get(siteB);
          if (b.status !== 200) bAlways200 = false;
          if (a.status >= 300 && a.status < 400) { redirectedAt = (Date.now() - t0) / 1000; break; }
          await sleep(c.pollMs);
        }
        note('website_302_sau_s', redirectedAt); note('B_luon_200', bAlways200);
        assert.ok(bAlways200, 'tenant B không được bị ảnh hưởng');
        assert.ok(redirectedAt >= 0,
          `website A không chuyển 302 sau ${c.lockDeadlineS}s. Nghi ngờ trang đã nằm trong cache CloudFront nên vẫn được phục vụ ` +
          'đến hết s-maxage; cần xóa cache wildcard /{slug}/* khi khóa và cache ngắn cho phản hồi 302 (QC-16)');
        assert.ok(redirectedAt <= maxLockS(), `302 sau ${redirectedAt}s, vượt ${maxLockS()}s`);
      } finally {
        const un = await call('PATCH', R.tenantStatus(A.tenantId), { token: tokPlat, body: { status: 'ACTIVE' } });
        note('unlock', un.status);
        // Phục hồi: API 200 và website không còn 302
        let ok = false;
        const t1 = Date.now();
        while ((Date.now() - t1) / 1000 < c.lockDeadlineS) {
          const api = await call('POST', R.translate, { apiKey: A.apiKey, body: B.translate('xin chào') });
          const web = await get(siteA);
          if (api.status === 200 && web.status === 200) { ok = true; break; }
          await sleep(c.pollMs);
        }
        record(SC, 'L5', 'Mở khóa phục hồi API và website', ok ? 'pass' : 'fail', { sau_s: Math.round((Date.now() - t1) / 1000) });
        assert.ok(ok, 'sau khi mở khóa, API và website của A phải hoạt động lại');
      }
    }));
});
