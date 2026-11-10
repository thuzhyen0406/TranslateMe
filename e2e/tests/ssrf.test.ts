// Kịch bản 6 (Bảng 3.8): chạy bộ thử SSRF 9 đích qua giao diện thêm/xác minh website.
// Bộ fixture (máy chủ DNS rebinding, máy chủ chuyển hướng) do TV4 cung cấp từ hạng mục 1.10.
// KHÔNG nới quy tắc chặn để cho một đích đi qua.
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { cfg } from '../lib/config';
import { loadState, State } from '../lib/state';
import { login } from '../lib/auth';
import { call, errCode } from '../lib/http';
import { B, R, listOf } from '../lib/contract';
import { ev, record } from '../lib/evidence';

const SC = 6;
let S: State;
let tokC = '';

before(async () => {
  const c = cfg();
  S = loadState(c.stage);
  // Dùng tenant C (tenant thử giới hạn) để không làm bẩn website của A và B
  tokC = await login(c.consoleClientId, S.tenants.C.username, S.tenants.C.password);
});

const TARGETS: Array<{ id: string; name: string; url: string }> = [
  { id: 'S1', name: '169.254.169.254', url: 'http://169.254.169.254/latest/meta-data/' },
  { id: 'S2', name: 'localhost', url: 'http://localhost/' },
  { id: 'S3', name: '127.0.0.1', url: 'http://127.0.0.1/' },
  { id: 'S4', name: '10.0.0.1', url: 'http://10.0.0.1/' },
  { id: 'S5', name: '[::1]', url: 'http://[::1]/' },
  { id: 'S6', name: '[fd00::1]', url: 'http://[fd00::1]/' },
  { id: 'S7', name: 'DNS rebinding', url: process.env.TM_SSRF_REBIND_URL ?? '' },
  { id: 'S8', name: 'Chuyển hướng về địa chỉ nội bộ', url: process.env.TM_SSRF_REDIRECT_URL ?? '' },
  { id: 'S9', name: 'Cổng 22', url: process.env.TM_SSRF_PORT22_URL ?? 'http://example.com:22/' },
];
const METADATA_MARKERS = /ami-id|instance-id|security-credentials|AccessKeyId|SecretAccessKey/i;
// POST /hosts trả FORBIDDEN/SITE_UNREACHABLE; verify route chuẩn hóa lỗi safeFetch thành VERIFICATION_FAILED.
const ALLOWED_CODES = ['FORBIDDEN', 'SITE_UNREACHABLE', 'VERIFICATION_FAILED'];

describe('Kịch bản 6 – SSRF: 9 đích phải bị chặn', () => {
  for (const t of TARGETS) {
    const skip = !t.url && 'thiếu fixture của TV4 (đặt biến môi trường TM_SSRF_*_URL)';
    it(`${t.id} ${t.name}`, { skip }, async (ctx) => {
      const run = ev(SC, t.id, `SSRF ${t.name}`, async (note) => {
        const requestedSlug = `ssrf-${randomBytes(4).toString('hex')}`;
        const add = await call('POST', R.hosts, { token: tokC, body: B.addHost(requestedSlug, t.url) });
        note('them_website', `${add.status} ${errCode(add) ?? ''}`.trim());
        let verdict = add;
        const slug = add.body?.host?.slug ?? add.body?.slug;
        if (add.status >= 200 && add.status < 300) {
          // Thêm chưa tải URL; việc tải xảy ra ở bước xác minh
          assert.equal(typeof slug, 'string', 'POST /console/hosts phải trả slug do server sinh');
          verdict = await call('POST', R.hostVerify(slug), { token: tokC, body: { method: 'META' } });
          note('xac_minh', `${verdict.status} ${errCode(verdict) ?? ''}`.trim());
        }
        note('ms', verdict.ms);
        assert.ok(verdict.status >= 400 && verdict.status < 500, `đích phải bị chặn, nhận ${verdict.status}`);
        assert.ok(ALLOWED_CODES.includes(errCode(verdict) ?? ''), `mã lỗi ${errCode(verdict)} không thuộc ${ALLOWED_CODES}`);
        assert.ok(!METADATA_MARKERS.test(verdict.text), 'phản hồi không được chứa nội dung từ địa chỉ nội bộ');
        assert.ok(verdict.ms < 20_000, `phản hồi quá chậm (${verdict.ms} ms)`);
        const hosts = listOf((await call('GET', R.hosts, { token: tokC })).body);
        const mine = hosts.find((h: any) => h?.slug === slug);
        assert.ok(!mine || mine.status !== 'ACTIVE', 'website SSRF không được ở trạng thái ACTIVE');
      });
      await run();
    });
    if (skip) record(SC, t.id, `SSRF ${t.name}`, 'skip', { reason: 'thiếu fixture của TV4' });
  }
});
