// Máy chủ giả lập TranslateMe theo đúng hợp đồng trong lib/contract.ts và các quy ước QC-2, QC-17.
// Mục đích: tự kiểm tra bộ test (npm run selftest). Bật các lỗi cố ý bằng MOCK_LEAK để chứng minh
// bộ test thật sự bắt được lỗ hổng. Đây KHÔNG phải sản phẩm.
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { State, TenantState } from '../lib/state';

type Leak = 'jobs' | 'host' | 'file_key' | 'body_tenant' | 'perm_msg' | 'lock_cache' | 'lock_api' | 'platform_tm' | 'ssrf';
interface Opts { leaks?: Leak[]; lockDelayMs?: number; rate?: number }
interface Tenant { id: string; plan: string; status: 'ACTIVE' | 'LOCKED'; lockedAt: number; charUsed: number; charLimit: number }
interface Key { value: string; keyId: string; tenantId: string; plan: 'basic' | 'tiny'; used: number; win: number[] }

const NF = 'Không tìm thấy tài nguyên.';
const hex = (n: number) => randomBytes(n).toString('hex');
const hashSentence = (s: string) => createHash('sha256').update(s.normalize('NFC').replace(/\s+/gu, ' ').trim(), 'utf8').digest('hex');

interface MockHost { tenantId: string; origin: string; status: string }
interface MockTranslation { sourceText: string; targetText: string }
const stripScheme = (v: string | undefined) => (v ?? '').replace(/^Bearer\s+/i, '');

export function startMock(opts: Opts = {}) {
  const leaks = new Set(opts.leaks ?? []);
  const lockDelay = opts.lockDelayMs ?? 600;
  const rate = opts.rate ?? 5;
  const tenants = new Map<string, Tenant>();
  const users = new Map<string, { password: string; kind: 'tenant' | 'platform'; tenantId?: string }>();
  const keys = new Map<string, Key>();
  const hosts = new Map<string, MockHost>();
  const jobs = new Map<string, { tenantId: string; fileKey: string }>();
  const files = new Set<string>();
  const tm = new Map<string, Map<string, MockTranslation>>();
  let config: any = { plan_limits: { free: 200000, pro: 1000000, business: 5000000 }, unit_price_usd_per_million: 15 };

  const myTm = (id: string) => { if (!tm.has(id)) tm.set(id, new Map()); return tm.get(id)!; };

  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    const payload = body === undefined ? '' : JSON.stringify({ request_id: hex(8), ...(body as object) });
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(payload);
  };
  const fail = (res: ServerResponse, status: number, code: string, message: string) =>
    send(res, status, { error: { code, message } });
  const notFound = (res: ServerResponse) => fail(res, 404, 'NOT_FOUND', NF);
  const denyOther = (res: ServerResponse) =>
    leaks.has('perm_msg') ? fail(res, 403, 'PERMISSION_DENIED', 'Không đủ quyền.') : notFound(res);

  const isPrivateHost = (u: URL): boolean => {
    const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (u.port && !['80', '443'].includes(u.port)) return true;
    return h === 'localhost' || /^127\./.test(h) || /^10\./.test(h) || /^169\.254\./.test(h) ||
      /^192\.168\./.test(h) || h === '::1' || h.startsWith('fd') || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
  };
  const leaksSsrftarget = (u: URL): boolean =>
    leaks.has('ssrf') && u.hostname.replace(/^\[|\]$/g, '').toLowerCase() === '169.254.169.254';

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: any = {};
    try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { /* rỗng */ }

    // ---- Cognito giả
    if (path === '/cognito') {
      const u = users.get(body?.AuthParameters?.USERNAME);
      if (!u || u.password !== body.AuthParameters.PASSWORD) { res.writeHead(400); return res.end('{"__type":"NotAuthorizedException"}'); }
      res.writeHead(200, { 'Content-Type': 'application/x-amz-json-1.1' });
      return res.end(JSON.stringify({ AuthenticationResult: { IdToken: `tok.${body.AuthParameters.USERNAME}` } }));
    }

    // ---- Website của Visitor
    const site = path.match(/^\/site\/([^/]+)\/([^/]+)\/$/);
    if (site && method === 'GET') {
      const h = hosts.get(site[1]);
      if (!h) return notFound(res);
      const t = tenants.get(h.tenantId)!;
      const locked = t.status === 'LOCKED' && Date.now() - t.lockedAt >= lockDelay;
      if (locked && !leaks.has('lock_cache')) { res.writeHead(302, { Location: h.origin }); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/html', 'x-cache': 'Hit from cloudfront' });
      return res.end('<html><body>ok</body></html>');
    }

    const authUser = () => {
      const tok = stripScheme(req.headers['authorization'] as string);
      const name = tok.startsWith('tok.') ? tok.slice(4) : '';
      return users.get(name);
    };
    const consoleCtx = () => {
      const u = authUser();
      if (!u) { fail(res, 401, 'UNAUTHORIZED', 'Thiếu hoặc sai token.'); return null; }
      if (u.kind !== 'tenant') { fail(res, 403, 'PERMISSION_DENIED', 'Không đủ quyền.'); return null; }
      return tenants.get(u.tenantId!)!;
    };
    const writeBlocked = (t: Tenant) => {
      if (t.status === 'LOCKED' && !leaks.has('lock_api')) { fail(res, 403, 'TENANT_SUSPENDED', 'Tenant đang bị khóa.'); return true; }
      return false;
    };
    const apiCtx = () => {
      const k = keys.get(String(req.headers['x-api-key'] ?? ''));
      if (!k) { fail(res, 401, 'UNAUTHORIZED', 'API key không hợp lệ.'); return null; }
      const now = Date.now();
      if (k.plan === 'tiny') {
        if (k.used >= 3) { fail(res, 429, 'REQUEST_QUOTA_EXCEEDED', 'Hết hạn ngạch.'); return null; }
        k.used++;
      } else {
        k.win = k.win.filter((x) => now - x < 1000);
        if (k.win.length >= rate) { fail(res, 429, 'RATE_LIMITED', 'Vượt tốc độ.'); return null; }
        k.win.push(now);
      }
      return { key: k, tenant: tenants.get(k.tenantId)! };
    };

    const sessionJob = path.match(/^\/translate\/batch\/session\/([^/]+)$/);
    if (sessionJob && method === 'GET') {
      const tenant = consoleCtx(); if (!tenant) return;
      const job = jobs.get(sessionJob[1]);
      if (!job || job.tenantId !== tenant.id) return denyOther(res);
      return send(res, 200, { job: {
        job_id: sessionJob[1], status: 'SUCCEEDED',
        results: [{ target_lang: 'en', download_url: 'https://download.example/result.txt' }],
      } });
    }

    // ---- /translate/*
    if (path.startsWith('/translate/')) {
      const ctx = apiCtx(); if (!ctx) return;
      let tenant = ctx.tenant;
      if (leaks.has('body_tenant') && body.tenant_id && tenants.has(body.tenant_id)) tenant = tenants.get(body.tenant_id)!;
      if (path === '/translate/realtime' && method === 'POST') {
        if (writeBlocked(tenant)) return;
        const text = String(body.text ?? '');
        if (!text || !body.target_lang) return fail(res, 400, 'INVALID_REQUEST', 'Thiếu trường.');
        const h = hashSentence(text);
        const mem = myTm(tenant.id);
        if (mem.has(h)) return send(res, 200, { translated_text: mem.get(h)!.targetText, characters_machine_translated: 0, characters_from_memory: text.length });
        const limit = tenant.charLimit;
        if (tenant.charUsed + text.length > limit) return fail(res, 429, 'CHAR_QUOTA_EXCEEDED', 'Hết hạn mức ký tự.');
        tenant.charUsed += text.length;
        mem.set(h, { sourceText: text, targetText: `[en] ${text}` });
        return send(res, 200, { translated_text: `[en] ${text}`, characters_machine_translated: text.length, characters_from_memory: 0 });
      }
      if (path === '/translate/batch/upload-url' && method === 'POST') {
        if (writeBlocked(tenant)) return;
        const fk = `tenants/${tenant.id}/uploads/${hex(8)}.txt`; files.add(fk);
        return send(res, 200, { file_key: fk, upload_url: `http://upload.invalid/${fk}`, expires_in: 900 });
      }
      if (path === '/translate/batch' && method === 'POST') {
        if (writeBlocked(tenant)) return;
        const fk = String(body.file_key ?? '');
        const ownPrefix = fk.startsWith(`tenants/${tenant.id}/uploads/`);
        if (!files.has(fk) || (!ownPrefix && !leaks.has('file_key'))) return fail(res, 400, 'FILE_NOT_UPLOADED', 'Chưa có tệp.');
        const id = `job_${hex(8)}`; jobs.set(id, { tenantId: tenant.id, fileKey: fk });
        return send(res, 202, { job_id: id, status: 'QUEUED', estimated_characters: 100 });
      }
      const bj = path.match(/^\/translate\/batch\/([^/]+)$/);
      if (bj && method === 'GET') {
        const j = jobs.get(bj[1]);
        if (!j || (j.tenantId !== ctx.tenant.id && !leaks.has('jobs'))) return denyOther(res);
        return send(res, 200, { status: 'QUEUED', progress: 0, results: [], warnings: [] });
      }
      return notFound(res);
    }

    // ---- /platform/*
    if (path.startsWith('/platform/')) {
      const u = authUser();
      if (!u) return fail(res, 401, 'UNAUTHORIZED', 'Thiếu hoặc sai token.');
      if (u.kind !== 'platform') return fail(res, 403, 'PERMISSION_DENIED', 'Không đủ quyền.');
      const lockM = path.match(/^\/platform\/tenants\/([^/]+)\/status$/);
      if (lockM && method === 'PATCH') {
        const t = tenants.get(lockM[1]); if (!t) return notFound(res);
        if (body.status !== 'LOCKED' && body.status !== 'ACTIVE') return fail(res, 400, 'INVALID_REQUEST', 'status không hợp lệ.');
        t.status = body.status; t.lockedAt = Date.now();
        return send(res, 200, { tenant_id: t.id, status: t.status });
      }
      if (path === '/platform/tenants' && method === 'GET')
        return send(res, 200, { items: [...tenants.values()].map((t) => ({ tenant_id: t.id, plan: t.plan, status: t.status, chars_machine_translated: t.charUsed })) });
      const limits = path.match(/^\/platform\/tenants\/([^/]+)\/limits$/);
      if (limits && method === 'PATCH') {
        const t = tenants.get(limits[1]); if (!t) return notFound(res);
        t.charLimit = body.character_limit;
        return send(res, 200, { tenant_id: t.id, character_limit: t.charLimit });
      }
      const one = path.match(/^\/platform\/tenants\/([^/]+)$/);
      if (one && method === 'GET') {
        const t = tenants.get(one[1]); if (!t) return notFound(res);
        const extra = leaks.has('platform_tm') ? { sample: [...myTm(t.id).keys()] } : {};
        return send(res, 200, { tenant_id: t.id, plan: t.plan, status: t.status, character_limit: t.charLimit, ...extra });
      }
      if (path === '/platform/config') {
        if (method === 'GET') return send(res, 200, config);
        if (method === 'PUT') { const { request_id, ...rest } = body; config = { ...config, ...rest }; return send(res, 200, config); }
      }
      return notFound(res);
    }

    // ---- /console/*
    if (path.startsWith('/console/')) {
      const t = consoleCtx(); if (!t) return;
      const own = (m: Map<string, { tenantId: string }>, id: string) => { const x = m.get(id); return x && x.tenantId === t.id ? x : undefined; };
      if (path === '/console/me') return send(res, 200, { tenant_id: t.id, role: 'tenant_admin', status: t.status, plan: t.plan });
      if (path === '/console/hosts' && method === 'GET')
        return send(res, 200, { items: [...hosts].filter(([, h]) => h.tenantId === t.id).map(([slug, h]) => ({ slug, status: h.status, origin_url: h.origin })) });
      if (path === '/console/hosts' && method === 'POST') {
        if (writeBlocked(t)) return;
        let u: URL; try { u = new URL(String(body.home_url)); } catch { return fail(res, 400, 'FORBIDDEN', 'URL không hợp lệ.'); }
        if (!['http:', 'https:'].includes(u.protocol) || (isPrivateHost(u) && !leaksSsrftarget(u))) return fail(res, 403, 'FORBIDDEN', 'URL không phải địa chỉ công khai.');
        const slug = u.hostname.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
        if (hosts.has(slug)) return fail(res, 409, 'DUPLICATE_SLUG', 'Slug đã tồn tại.');
        hosts.set(slug, { tenantId: t.id, origin: body.home_url, status: 'PENDING' });
        return send(res, 201, { slug, status: 'PENDING', host: { slug, status: 'PENDING' } });
      }
      const hm = path.match(/^\/console\/hosts\/([^/]+)(\/verify)?$/);
      if (hm) {
        const actualHost = hosts.get(hm[1]);
        const h = actualHost?.tenantId === t.id ? actualHost : undefined;
        if (!h) {
          if (!hm[2] && method === 'GET' && actualHost && leaks.has('host')) {
            return send(res, 200, { slug: hm[1], status: actualHost.status, home_url: actualHost.origin });
          }
          return denyOther(res);
        }
        if (writeBlocked(t)) return;
        if (hm[2] && leaksSsrftarget(new URL(h.origin))) {
          h.status = 'ACTIVE';
          return send(res, 200, { slug: hm[1], status: 'ACTIVE' });
        }
        if (hm[2]) return fail(res, 400, 'VERIFICATION_FAILED', 'Không thể xác minh website.');
        if (method === 'PATCH') return send(res, 200, { slug: hm[1], status: h.status });
        return send(res, 200, { slug: hm[1], status: (h as any).status });
      }
      const jm = path.match(/^\/console\/jobs\/([^/]+)$/);
      if (jm && method === 'GET') {
        const j = jobs.get(jm[1]);
        if (!j || (j.tenantId !== t.id && !leaks.has('jobs'))) return denyOther(res);
        return send(res, 200, { job: { job_id: jm[1], status: 'QUEUED', type: 'FILE' } });
      }
      if (path === '/console/jobs') return send(res, 200, { items: [...jobs].filter(([, j]) => j.tenantId === t.id).map(([id]) => ({ job_id: id })) });
      if (path === '/console/translations' && method === 'GET') {
        const search = (url.searchParams.get('search') ?? '').normalize('NFC').trim().toLowerCase();
        const items = [...myTm(t.id)].flatMap(([hash, value]) => {
          const found = !search || value.sourceText.normalize('NFC').toLowerCase().includes(search) || value.targetText.normalize('NFC').toLowerCase().includes(search);
          return found ? [{ hash, sourceText: value.sourceText, tgt: value.targetText, label: 'MACHINE' }] : [];
        });
        return send(res, 200, { items });
      }
      if (path === '/console/tm' && method === 'GET')
        return send(res, 200, { items: [...myTm(t.id)].map(([hash, v]) => ({ hash, translation: v.targetText })) });
      const pm = path.match(/^\/console\/tm\/([^/]+)\/pages$/);
      if (pm) { if (!myTm(t.id).has(pm[1])) return denyOther(res); return send(res, 200, { items: [] }); }
      if (path === '/console/usage') return send(res, 200, { month: url.searchParams.get('month'), chars_machine_translated: t.charUsed });
      if (path === '/console/api-keys' && method === 'GET')
        return send(res, 200, { items: [...keys.values()].filter((k) => k.tenantId === t.id).map((k) => ({ key_id: k.keyId, last4: k.value.slice(-4) })) });
      if (path === '/console/api-keys' && method === 'POST') {
        if (writeBlocked(t)) return;
        const k: Key = { value: `tmk_${hex(12)}`, keyId: hex(5), tenantId: t.id, plan: 'basic', used: 0, win: [] };
        keys.set(k.value, k);
        return send(res, 201, { key_id: k.keyId, api_key: k.value });
      }
      if (path === '/console/glossary/terms') return send(res, 200, { items: [] });
      return notFound(res);
    }
    return notFound(res);
  });

  const addTenant = (label: 'A' | 'B' | 'C'): TenantState => {
    const id = `t_${hex(12)}`;
    tenants.set(id, { id, plan: 'free', status: 'ACTIVE', lockedAt: 0, charUsed: 0, charLimit: 200000 });
    const username = `user-${label.toLowerCase()}@example.com`, password = 'Passw0rd!';
    users.set(username, { password, kind: 'tenant', tenantId: id });
    const k: Key = { value: `tmk_${hex(12)}`, keyId: hex(5), tenantId: id, plan: 'basic', used: 0, win: [] };
    keys.set(k.value, k);
    const slug = `site-${label.toLowerCase()}-${hex(3)}`;
    const origin = `https://origin-${label.toLowerCase()}.example.com/`;
    hosts.set(slug, { tenantId: id, origin, status: 'ACTIVE' });
    const fileKey = `tenants/${id}/uploads/${hex(8)}.txt`; files.add(fileKey);
    const jobId = `job_${hex(8)}`; jobs.set(jobId, { tenantId: id, fileKey });
    const tmText = `Câu của tenant ${label} ${hex(3)}`;
    myTm(id).set(hashSentence(tmText), { sourceText: tmText, targetText: `[en] ${tmText}` });
    const st: TenantState = { label, username, password, tenantId: id, slug, origin, apiKey: k.value, keyId: k.keyId, jobId, fileKey, tmText, tmHash: hashSentence(tmText) };
    if (label === 'C') {
      const tk: Key = { value: `tmk_${hex(12)}`, keyId: hex(5), tenantId: id, plan: 'tiny', used: 0, win: [] };
      keys.set(tk.value, tk); st.tinyApiKey = tk.value; st.tinyKeyId = tk.keyId;
    }
    return st;
  };

  return new Promise<{ port: number; seed: () => State; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      const seed = (): State => {
        users.set('platform@example.com', { password: 'Passw0rd!', kind: 'platform' });
        return {
          stage: 'mock', createdAt: new Date().toISOString(),
          platform: { username: 'platform@example.com', password: 'Passw0rd!' },
          tenants: { A: addTenant('A'), B: addTenant('B'), C: addTenant('C') },
        };
      };
      resolve({ port, seed, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

// Chạy độc lập: MOCK_LEAK=jobs,body_tenant ts-node mock/server.ts
if (require.main === module) {
  startMock({ leaks: (process.env.MOCK_LEAK ?? '').split(',').filter(Boolean) as Leak[] }).then((m) => {
    console.log(`Mock chạy tại http://127.0.0.1:${m.port}`);
  });
}
