// Kịch bản 8: xóa cache chọn lọc (site C, 3 trang; câu X ở trang-1 và trang-2).
// Sửa bản dịch câu X ở ngôn ngữ `lang` (Reviewer/Tenant Admin, F5) -> CreateInvalidation đúng 2 đường dẫn
// /{slug}/{lang}/trang-1/ và /{slug}/{lang}/trang-2/; trang-3 và ngôn ngữ khác vẫn x-cache: Hit; bản HUMAN không bị ghi đè.
//
//   npm run demo:kb8                    # tenant C trong .state/<stage>.json, lang=en, ngôn ngữ đối chứng=ko
//   npm run demo:kb8 -- --prepare       # bật thêm ngôn ngữ đối chứng cho website nếu chưa có
import { arg, flag } from './aws';
import { login } from '../lib/auth';
import { cfg } from '../lib/config';
import { hashSentence } from '../lib/contract';
import { call } from '../lib/http';
import { loadState } from '../lib/state';
import { KB8_PAGES, KB8_PAGES_WITH_SHARED, KB8_SHARED_SENTENCE } from '../lib/sampleSites';
import { getPage, isCacheHit, mdTable, sleep, translatedUrl, untilComplete, writeReport, type PageGetter } from '../lib/visitor';

export type Api = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;

export interface Kb8Deps {
  get: PageGetter;
  api: Api;
  publicBase: string;
  slug: string;
  lang: string;
  otherLang: string;
  prepare?: boolean;
  newTgt?: string;
  wait?: (ms: number) => Promise<void>;
  /** Thời gian chờ invalidation hoàn tất tối đa (ms) */
  invalidationTimeoutMs?: number;
  log?: (s: string) => void;
}

export interface Kb8Check { id: string; title: string; pass: boolean; detail: string }
export interface Kb8Result { checks: Kb8Check[]; invalidation?: { id?: string; paths: string[]; mode?: string; status?: string }; entry?: Record<string, unknown> }

const unwrap = (b: any) => (b && typeof b === 'object' && b.data && !b.items && !b.entry ? b.data : b);

export function expectedPaths(slug: string, lang: string): string[] {
  return KB8_PAGES_WITH_SHARED.map((p) => `/${slug}/${lang}/${p}`).sort();
}

async function findEntry(api: Api, lang: string): Promise<Record<string, any> | undefined> {
  const hash = hashSentence(KB8_SHARED_SENTENCE);
  for (const tab of ['MACHINE', 'HUMAN', 'REVIEW']) {
    const r = await api('GET', `/console/translations?tab=${tab}&src=vi&tgt=${lang}&search=${encodeURIComponent(KB8_SHARED_SENTENCE)}`);
    const items: any[] = unwrap(r.body)?.items ?? [];
    const hit = items.find((i) => i?.hash === hash);
    if (hit) return hit;
  }
  return undefined;
}

export async function runKb8(d: Kb8Deps): Promise<Kb8Result> {
  const log = d.log ?? (() => {});
  const wait = d.wait ?? sleep;
  const checks: Kb8Check[] = [];
  const check = (id: string, title: string, pass: boolean, detail: string) => {
    checks.push({ id, title, pass, detail });
    log(`${pass ? 'ĐẠT ' : 'LỖI '} ${id} ${title} – ${detail}`);
  };
  const url = (lang: string, page: string) => translatedUrl(d.publicBase, d.slug, lang, page);

  // 0. Website phải bật cả ngôn ngữ sửa và ngôn ngữ đối chứng
  const host = unwrap((await d.api('GET', `/console/hosts/${d.slug}`)).body)?.host ?? {};
  const langs: string[] = host.target_langs ?? host.targetLangs ?? [];
  if (!langs.includes(d.lang) || !langs.includes(d.otherLang)) {
    if (!d.prepare) throw new Error(`Website ${d.slug} cần bật ${d.lang} và ${d.otherLang} (đang có: ${langs.join(', ') || 'không rõ'}); chạy lại với --prepare`);
    const next = [...new Set([...langs, d.lang, d.otherLang])];
    const r = await d.api('PATCH', `/console/hosts/${d.slug}`, { target_langs: next });
    if (r.status !== 200) throw new Error(`Không bật được ngôn ngữ ${next.join(', ')}: HTTP ${r.status}`);
    log(`Đã bật ngôn ngữ ${next.join(', ')}; chờ 65 s cho bộ đệm trạng thái của proxy (STATE_CACHE_S)`);
    await wait(65_000);
  }

  // 1. Dịch đủ và nạp cache cho 3 trang × 2 ngôn ngữ
  for (const lang of [d.lang, d.otherLang]) {
    for (const page of KB8_PAGES) {
      const done = await untilComplete(d.get, url(lang, page), { wait });
      if (done.status !== 200 || done.partial) throw new Error(`Không dịch đủ ${url(lang, page)}: ${done.status} partial=${done.partial}`);
      let r = await d.get(url(lang, page));
      for (let i = 0; i < 3 && !isCacheHit(r.xCache); i++) r = await d.get(url(lang, page));
      if (!isCacheHit(r.xCache)) throw new Error(`${url(lang, page)} chưa vào cache (x-cache "${r.xCache}"); kiểm tra Cache-Control`);
    }
  }
  log('Đã nạp cache 6 trang');

  // 2. Câu X trong TM
  const entry = await findEntry(d.api, d.lang);
  if (!entry) throw new Error(`Không tìm thấy câu X trong TM (${d.lang}); trang-1 đã được dịch chưa?`);
  const newTgt = d.newTgt ?? `Free breakfast is served from six to nine every morning (KB8 ${new Date().toISOString().slice(0, 16)}).`;

  // 3. Sửa và xuất bản
  const put = await d.api('PUT', '/console/translations', { src: 'vi', tgt: d.lang, hash: entry.hash, newTgt, expectedVersion: entry.version });
  const out = unwrap(put.body) ?? {};
  check('K1', 'Lưu bản dịch người (PUT /console/translations)', put.status === 200 && out.entry?.label === 'HUMAN', `HTTP ${put.status}, label=${out.entry?.label}`);
  const inv = out.invalidation ?? {};
  const paths: string[] = [...(inv.paths ?? [])].sort();
  const want = expectedPaths(d.slug, d.lang);
  check('K2', 'CreateInvalidation đúng 2 đường dẫn của trang chứa câu X', JSON.stringify(paths) === JSON.stringify(want) && inv.mode === 'PATHS',
    `paths=${JSON.stringify(paths)} mode=${inv.mode}; cần ${JSON.stringify(want)}`);
  const invId: string | undefined = inv.invalidationId ?? inv.invalidationIds?.[0];
  check('K3', 'Có mã invalidation', Boolean(invId), `id=${invId ?? '–'} status=${inv.status}`);

  // 4. Chờ CloudFront hoàn tất
  let status = inv.status as string | undefined;
  if (invId) {
    const deadline = Date.now() + (d.invalidationTimeoutMs ?? 5 * 60_000);
    while (Date.now() < deadline) {
      const s = unwrap((await d.api('GET', `/console/invalidations/${encodeURIComponent(invId)}`)).body) ?? {};
      status = s.status;
      if (status === 'COMPLETED') {
        const p2 = [...(s.paths ?? [])].sort();
        check('K4', 'Invalidation hoàn tất, nội dung khớp', JSON.stringify(p2) === JSON.stringify(want), `paths=${JSON.stringify(p2)}`);
        break;
      }
      await wait(10_000);
    }
    if (status !== 'COMPLETED') check('K4', 'Invalidation hoàn tất, nội dung khớp', false, `trạng thái cuối: ${status}`);
  }

  // 5. Trang chứa X đã mới; trang khác và ngôn ngữ khác vẫn trúng cache
  for (const page of KB8_PAGES_WITH_SHARED) {
    const r = await d.get(url(d.lang, page));
    check(`K5:${page}`, `${d.lang}/${page} bị xóa cache và hiện bản mới`, r.status === 200 && !isCacheHit(r.xCache) && r.body.includes(newTgt),
      `HTTP ${r.status}, x-cache "${r.xCache}", có bản mới: ${r.body.includes(newTgt)}`);
  }
  const untouched = [...KB8_PAGES.filter((p) => !(KB8_PAGES_WITH_SHARED as readonly string[]).includes(p)).map((p) => [d.lang, p]), ...KB8_PAGES.map((p) => [d.otherLang, p])];
  for (const [lang, page] of untouched) {
    const r = await d.get(url(lang, page));
    check(`K6:${lang}/${page}`, `${lang}/${page} vẫn trúng cache`, isCacheHit(r.xCache), `x-cache "${r.xCache}", age ${r.age || '–'}`);
  }

  // 6. HUMAN không bị ghi đè sau khi proxy dựng lại trang
  const after = await findEntry(d.api, d.lang);
  check('K7', 'Bản HUMAN giữ nguyên sau khi trang được dịch lại', after?.label === 'HUMAN' && after?.tgt === newTgt, `label=${after?.label} tgt khớp: ${after?.tgt === newTgt}`);
  const again = await d.get(url(d.lang, KB8_PAGES_WITH_SHARED[0]));
  check('K8', 'Trang vẫn hiện bản HUMAN ở lượt sau', again.body.includes(newTgt), `x-cache "${again.xCache}"`);

  return { checks, invalidation: { id: invId, paths, mode: inv.mode, status }, entry: { hash: entry.hash, versionBefore: entry.version, newTgt } };
}

export function kb8Markdown(res: Kb8Result, meta: Record<string, string>): string {
  const ok = res.checks.every((c) => c.pass);
  return [
    '# Kịch bản 8 – Xóa cache chọn lọc', '',
    ...Object.entries(meta).map(([k, v]) => `- ${k}: \`${v}\``), '',
    `**${ok ? 'ĐẠT' : 'KHÔNG ĐẠT'}** – ${res.checks.filter((c) => c.pass).length}/${res.checks.length} phép kiểm tra.`, '',
    '## CreateInvalidation', '', '```json', JSON.stringify(res.invalidation, null, 2), '```', '',
    mdTable(['Mã', 'Kiểm tra', 'Kết quả', 'Chi tiết'], res.checks.map((c) => [c.id, c.title, c.pass ? 'ĐẠT' : 'LỖI', c.detail])), '',
  ].join('\n');
}

async function main(): Promise<void> {
  const c = cfg();
  const state = loadState(c.stage);
  const t = state.tenants.C;
  const token = await login(c.consoleClientId, t.username, t.password);
  const api: Api = async (method, path, body) => {
    const r = await call(method, path, { token, body });
    return { status: r.status, body: r.body };
  };
  const slug = arg('slug') ?? t.slug;
  const lang = arg('lang') ?? 'en';
  const otherLang = arg('other-lang') ?? 'ko';
  const res = await runKb8({ get: getPage, api, publicBase: c.publicBase, slug, lang, otherLang, prepare: flag('prepare'), log: (s) => console.log(s) });
  const meta = { PUBLIC_BASE: c.publicBase, slug, 'Ngôn ngữ sửa': lang, 'Ngôn ngữ đối chứng': otherLang, 'Câu X': KB8_SHARED_SENTENCE, 'Thời điểm': new Date().toISOString() };
  const dir = writeReport('kb8-invalidation', { meta, ...res }, kb8Markdown(res, meta));
  console.log(`Bằng chứng: ${dir}/kb8-invalidation.{md,json}`);
  if (res.checks.some((x) => !x.pass)) process.exitCode = 1;
}

if (require.main === module) main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
