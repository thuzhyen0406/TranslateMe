// 5.5 / Kịch bản 3: độ trễ proxy trên trang khoảng 100 câu (site B), 10 lần × 3 trường hợp.
//   (a) TM rỗng, cache rỗng: 10/10 lần < 30 s, không 5xx (trang dịch dở được chấp nhận)
//   (b) trúng TM, cache CloudFront đã xóa: trung vị ≤ 2 s
//   (c) trúng cache CloudFront (x-cache: Hit): trung vị ≤ 300 ms
//
//   npm run demo:latency                          # đọc .state/<stage>.json (slug tenant B) và TM_PUBLIC_BASE
//   npm run demo:latency -- --bust query          # (b) đổi query thay vì CreateInvalidation (cache key phải gồm query)
//   TM_CF_DISTRIBUTION_ID=E123 npm run demo:latency   # (b) xóa cache bằng CreateInvalidation (mặc định nếu có biến này)
//
// Đo lại (a) cần TM rỗng: build site B với TM_LATENCY_ROUND mới (tools/build-sites.ts), đăng lại rồi đo.
import { aws, arg } from './aws';
import { cfg } from '../lib/config';
import { loadState } from '../lib/state';
import { LATENCY_RUNS, LATENCY_WARM_PAGE, latencyColdPage } from '../lib/sampleSites';
import {
  getPage, isCacheHit, isCacheMiss, max, mdTable, median, translatedUrl, untilComplete, writeReport,
  type PageGetter, type PageResult,
} from '../lib/visitor';

export type CaseKey = 'a' | 'b' | 'c';
export interface LatencyRow { case: CaseKey; run: number; url: string; status: number; ms: number; xCache: string; partial: string; valid: boolean; note?: string }
export interface CaseSummary { case: CaseKey; criterion: string; runs: number; validRuns: number; medianMs: number; maxMs: number; pass: boolean; reason?: string }

export const LIMITS = { aMaxMs: 30_000, bMedianMs: 2_000, cMedianMs: 300 } as const;

export interface LatencyDeps {
  get: PageGetter;
  publicBase: string;
  slug: string;
  lang: string;
  runs?: number;
  bust: 'invalidate' | 'query';
  /** Xóa cache các đường dẫn và CHỜ hoàn tất (bust = invalidate) */
  invalidate?: (paths: string[]) => Promise<void>;
  wait?: (ms: number) => Promise<void>;
  log?: (s: string) => void;
}

const row = (c: CaseKey, run: number, r: PageResult, valid: boolean, note?: string): LatencyRow => ({
  case: c, run, url: r.url, status: r.status, ms: r.ms, xCache: r.xCache, partial: r.partial, valid, ...(note ? { note } : {}),
});

export async function runLatency(d: LatencyDeps): Promise<LatencyRow[]> {
  const runs = d.runs ?? LATENCY_RUNS;
  const log = d.log ?? (() => {});
  const rows: LatencyRow[] = [];

  // (a) mỗi lần một trang có câu chưa từng dịch
  for (let run = 1; run <= runs; run++) {
    const r = await d.get(translatedUrl(d.publicBase, d.slug, d.lang, latencyColdPage(run)));
    // Lỗi (504 từ CloudFront…) vẫn là lượt hợp lệ để tiêu chí "không 5xx" bắt được; chỉ loại lượt trúng cache
    const cold = !isCacheHit(r.xCache);
    rows.push(row('a', run, r, cold, cold ? undefined : `x-cache "${r.xCache}" – trang đã nằm trong cache, cần TM_LATENCY_ROUND mới`));
    log(`(a) lần ${run}: ${r.status} ${r.ms} ms ${r.xCache}${r.partial ? ` partial=${r.partial}` : ''}`);
  }

  // (b) trang ấm: dịch đủ một lần (TM có mọi câu), rồi mỗi lần xóa cache trước khi đo
  const warmPath = LATENCY_WARM_PAGE;
  const warmUrl = translatedUrl(d.publicBase, d.slug, d.lang, warmPath);
  const primed = await untilComplete(d.get, warmUrl, { wait: d.wait });
  if (primed.status !== 200 || primed.partial) throw new Error(`Không dịch đủ trang ấm ${warmUrl}: ${primed.status} partial=${primed.partial}`);
  for (let run = 1; run <= runs; run++) {
    let url = warmUrl;
    if (d.bust === 'invalidate') {
      if (!d.invalidate) throw new Error('bust=invalidate cần hàm invalidate (TM_CF_DISTRIBUTION_ID)');
      await d.invalidate([new URL(warmUrl).pathname]);
    } else {
      url = `${warmUrl}?tm_lat=${run}-${Date.now().toString(36)}`;
    }
    const r = await d.get(url);
    const ok = isCacheMiss(r.xCache) && !r.partial;
    rows.push(row('b', run, r, ok, ok ? undefined : `x-cache "${r.xCache}"${r.partial ? `, partial=${r.partial}` : ''} – không phải lượt trúng TM sau khi xóa cache`));
    log(`(b) lần ${run}: ${r.status} ${r.ms} ms ${r.xCache}`);
  }

  // (c) trúng cache: lượt đầu nạp cache (không tính), rồi 10 lần
  await d.get(warmUrl);
  for (let run = 1; run <= runs; run++) {
    const r = await d.get(warmUrl);
    const ok = isCacheHit(r.xCache);
    rows.push(row('c', run, r, ok, ok ? undefined : `x-cache "${r.xCache}" – không trúng cache`));
    log(`(c) lần ${run}: ${r.status} ${r.ms} ms ${r.xCache}`);
  }
  return rows;
}

export function evaluateLatency(rows: readonly LatencyRow[], runs = LATENCY_RUNS): CaseSummary[] {
  const of = (c: CaseKey) => rows.filter((r) => r.case === c);
  const sum = (c: CaseKey, criterion: string, check: (rs: LatencyRow[], valid: LatencyRow[]) => string | undefined): CaseSummary => {
    const rs = of(c);
    const valid = rs.filter((r) => r.valid);
    const ms = valid.map((r) => r.ms);
    const enough = rs.length >= runs && valid.length === rs.length;
    const reason = !enough ? `${valid.length}/${rs.length} lần hợp lệ (cần ${runs})` : check(rs, valid);
    return { case: c, criterion, runs: rs.length, validRuns: valid.length, medianMs: median(ms), maxMs: max(ms), pass: !reason, ...(reason ? { reason } : {}) };
  };
  return [
    sum('a', `10/10 lần < ${LIMITS.aMaxMs / 1000} s, không 5xx`, (rs) => {
      const bad = rs.filter((r) => r.status >= 500 || r.ms >= LIMITS.aMaxMs || r.status !== 200);
      return bad.length ? `${bad.length} lần lỗi/chậm: ${bad.map((r) => `#${r.run} ${r.status} ${r.ms} ms`).join(', ')}` : undefined;
    }),
    sum('b', `trung vị ≤ ${LIMITS.bMedianMs} ms`, (_rs, v) => (median(v.map((r) => r.ms)) <= LIMITS.bMedianMs && v.every((r) => r.status === 200) ? undefined : `trung vị ${median(v.map((r) => r.ms))} ms`)),
    sum('c', `trung vị ≤ ${LIMITS.cMedianMs} ms, x-cache: Hit`, (_rs, v) => (median(v.map((r) => r.ms)) <= LIMITS.cMedianMs && v.every((r) => r.status === 200) ? undefined : `trung vị ${median(v.map((r) => r.ms))} ms`)),
  ];
}

export function latencyMarkdown(rows: readonly LatencyRow[], summary: readonly CaseSummary[], meta: Record<string, string>): string {
  const label: Record<CaseKey, string> = { a: '(a) TM rỗng', b: '(b) trúng TM, cache đã xóa', c: '(c) trúng cache CloudFront' };
  return [
    '# Kịch bản 3 – Độ trễ proxy (5.5)', '',
    ...Object.entries(meta).map(([k, v]) => `- ${k}: \`${v}\``), '',
    mdTable(['Trường hợp', 'Tiêu chí', 'Hợp lệ', 'Trung vị (ms)', 'Max (ms)', 'Kết quả'],
      summary.map((s) => [label[s.case], s.criterion, `${s.validRuns}/${s.runs}`, s.medianMs, s.maxMs, s.pass ? 'ĐẠT' : `KHÔNG ĐẠT – ${s.reason}`])), '',
    '## Số đo từng lần', '',
    mdTable(['Trường hợp', 'Lần', 'HTTP', 'ms', 'x-cache', 'Partial', 'Ghi chú'],
      rows.map((r) => [r.case, r.run, r.status, r.ms, r.xCache || '–', r.partial || '–', r.note ?? ''])), '',
    'Thời gian đo từ máy chạy script tới lúc đọc xong body, gồm cả mạng tới edge CloudFront.', '',
  ].join('\n');
}

/** CreateInvalidation rồi chờ hoàn tất bằng AWS CLI (dùng credentials của nhóm). */
export function cliInvalidator(distributionId: string) {
  return async (paths: string[]): Promise<void> => {
    const created = aws(['cloudfront', 'create-invalidation', '--distribution-id', distributionId, '--paths', ...paths]);
    const id = created?.Invalidation?.Id;
    if (!id) throw new Error(`CreateInvalidation không trả Id: ${JSON.stringify(created).slice(0, 200)}`);
    aws(['cloudfront', 'wait', 'invalidation-completed', '--distribution-id', distributionId, '--id', id], { raw: true });
  };
}

async function main(): Promise<void> {
  const c = cfg();
  const state = loadState(c.stage);
  const slug = arg('slug') ?? state.tenants.B.slug;
  const lang = arg('lang') ?? 'en';
  const distributionId = process.env.TM_CF_DISTRIBUTION_ID?.trim();
  const bust = (arg('bust') ?? (distributionId ? 'invalidate' : 'query')) as 'invalidate' | 'query';
  if (bust !== 'invalidate' && bust !== 'query') throw new Error('--bust phải là invalidate hoặc query');
  const rows = await runLatency({
    get: getPage, publicBase: c.publicBase, slug, lang, bust,
    invalidate: distributionId ? cliInvalidator(distributionId) : undefined,
    log: (s) => console.log(s),
  });
  const summary = evaluateLatency(rows);
  const meta = { 'PUBLIC_BASE': c.publicBase, slug, lang, 'Xóa cache (b)': bust, 'Thời điểm': new Date().toISOString() };
  const dir = writeReport('kb3-latency', { meta, summary, rows }, latencyMarkdown(rows, summary, meta));
  for (const s of summary) console.log(`(${s.case}) ${s.pass ? 'ĐẠT' : 'KHÔNG ĐẠT'} – trung vị ${s.medianMs} ms, max ${s.maxMs} ms${s.reason ? ` – ${s.reason}` : ''}`);
  console.log(`Bằng chứng: ${dir}/kb3-latency.{md,json}`);
  if (summary.some((s) => !s.pass)) process.exitCode = 1;
}

if (require.main === module) main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
