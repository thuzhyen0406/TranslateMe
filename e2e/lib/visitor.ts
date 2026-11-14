// Gọi trang bản dịch như Visitor (qua CloudFront) và tiện ích chung cho 5.4, 5.5, kịch bản 8.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chooseSafeRunId } from './evidenceRunId';

export interface PageResult {
  url: string;
  status: number;
  /** Thời gian từ lúc gửi tới khi đọc xong body (ms) */
  ms: number;
  xCache: string;
  partial: string;
  cacheControl: string;
  location: string;
  age: string;
  bytes: number;
  body: string;
}

export type PageGetter = (url: string, o?: { method?: string }) => Promise<PageResult>;

/** fetch thật: không theo chuyển hướng (302 là kết quả cần đo), không gửi cookie. */
export const getPage: PageGetter = async (url, o = {}) => {
  const t0 = performance.now();
  const res = await fetch(url, { method: o.method ?? 'GET', redirect: 'manual', headers: { Accept: 'text/html' } });
  const body = await res.text();
  const ms = Math.round(performance.now() - t0);
  const h = (k: string) => res.headers.get(k) ?? '';
  return {
    url, status: res.status, ms, body, bytes: Buffer.byteLength(body),
    xCache: h('x-cache'), partial: h('x-translateme-partial'), cacheControl: h('cache-control'), location: h('location'), age: h('age'),
  };
};

export const isCacheHit = (xCache: string) => /^(Hit|RefreshHit) from cloudfront$/i.test(xCache.trim());
export const isCacheMiss = (xCache: string) => /^Miss from cloudfront$/i.test(xCache.trim());

export function median(xs: readonly number[]): number {
  if (!xs.length) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
export const max = (xs: readonly number[]) => (xs.length ? Math.max(...xs) : Number.NaN);

/** URL bản dịch {PUBLIC_BASE}/{slug}/{lang}/{rest} (BASE_MODE=path) */
export function translatedUrl(publicBase: string, slug: string, lang: string, rest = ''): string {
  if (!publicBase) throw new Error('Thiếu TM_PUBLIC_BASE (địa chỉ CloudFront)');
  return `${publicBase.replace(/\/+$/, '')}/${slug}/${lang}/${rest.replace(/^\/+/, '')}`;
}

/** Ghi <name>.json và <name>.md vào e2e/evidence/<runId>/ (Phụ lục C). */
export function writeReport(name: string, json: unknown, markdown: string, runId = process.env.TM_RUN_ID): string {
  const id = chooseSafeRunId(undefined, undefined, runId ?? `local-${new Date().toISOString().slice(0, 10)}`);
  const dir = join(__dirname, '..', 'evidence', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(json, null, 2) + '\n', 'utf8');
  writeFileSync(join(dir, `${name}.md`), markdown, 'utf8');
  return dir;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Gọi lại tới khi trang dịch đủ (không còn X-TranslateMe-Partial) hoặc hết số lần. */
export async function untilComplete(get: PageGetter, url: string, o: { attempts?: number; waitMs?: number; wait?: (ms: number) => Promise<void> } = {}): Promise<PageResult> {
  const attempts = o.attempts ?? 12;
  const wait = o.wait ?? sleep;
  let r = await get(url);
  for (let i = 1; i < attempts && r.status === 200 && r.partial; i++) {
    await wait(o.waitMs ?? 5000);
    r = await get(url);
  }
  return r;
}

/** Bảng Markdown đơn giản */
export function mdTable(head: string[], rows: Array<Array<string | number>>): string {
  const esc = (v: string | number) => String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`)].join('\n');
}
