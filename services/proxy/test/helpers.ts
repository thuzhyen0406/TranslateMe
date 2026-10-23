/**
 * Công cụ test cho Lambda proxy: Translate giả, safe_fetch giả, logger giả. Không dùng mạng, không cần AWS.
 */
import type { TranslateTextCommand } from '@aws-sdk/client-translate';
import { toFetchResult, type SafeFetchCompatResult, type SafeFetchOutcome } from '../../../libs/common/safeFetch.js';
import type { SiteConfig } from '../sites.js';
import type { TranslateClientLike } from '../translator.js';

/** "Dịch" giả: viết HOA phần chữ, giữ nguyên thẻ HTML (giống cách Translate giữ thẻ). */
export function upperCaseOutsideTags(html: string): string {
  return html.replace(/(<[^>]*>)|([^<]+)/g, (_all, tag: string | undefined, text: string | undefined) =>
    tag ?? (text ?? '').toUpperCase().replace(/&(?:[A-Z]+|#X?[0-9A-F]+);/g, (e) => e.toLowerCase()),
  );
}

export interface FakeTranslateCall {
  Text: string;
  SourceLanguageCode?: string;
  TargetLanguageCode?: string;
  TerminologyNames?: string[];
}

export interface FakeTranslateClient extends TranslateClientLike {
  calls: FakeTranslateCall[];
  maxInFlight: number;
}

/** Translate giả. `behave` nhận Text gửi đi, trả bản dịch hoặc ném lỗi. Mặc định: upperCaseOutsideTags. */
export function fakeTranslate(behave: (text: string, callIndex: number) => string | Promise<string> = upperCaseOutsideTags): FakeTranslateClient {
  let inFlight = 0;
  const client: FakeTranslateClient = {
    calls: [],
    maxInFlight: 0,
    async send(command: TranslateTextCommand) {
      const input = command.input as FakeTranslateCall;
      const idx = client.calls.length;
      client.calls.push(input);
      inFlight++;
      client.maxInFlight = Math.max(client.maxInFlight, inFlight);
      try {
        await new Promise((r) => setImmediate(r));
        return { TranslatedText: await behave(input.Text, idx) };
      } finally {
        inFlight--;
      }
    },
  };
  return client;
}

export function throttlingError(): Error {
  return Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
}

/** safe_fetch giả: trả outcome cho sẵn, ghi lại URL được gọi. */
export function fakeFetch(outcomeFor: (url: string) => SafeFetchOutcome) {
  const urls: string[] = [];
  const fn = async (url: string): Promise<SafeFetchCompatResult> => {
    urls.push(url);
    return toFetchResult(outcomeFor(url));
  };
  return Object.assign(fn, { urls });
}

export function okHtml(html: string, finalUrl: string, status = 200): SafeFetchOutcome {
  return { kind: 'OK', html, finalUrl, status, contentType: 'text/html', headers: { 'content-type': 'text/html; charset=utf-8' } };
}

/** Cùng hình dạng với ProxyLogger trong handler.ts (không import để test translator không phụ thuộc handler). */
interface LoggerLike {
  info(entry: Record<string, unknown>): void;
  error(entry: Record<string, unknown>): void;
}

export function fakeLogger(): LoggerLike & { infos: Record<string, unknown>[]; errors: Record<string, unknown>[] } {
  const infos: Record<string, unknown>[] = [];
  const errors: Record<string, unknown>[] = [];
  return { infos, errors, info: (e) => void infos.push(e), error: (e) => void errors.push(e) };
}

export const SITE: SiteConfig = Object.freeze({
  slug: 'homestay-abc',
  tenantId: 't_8f3a1c9e4b2d7a6f5e0c1b2a',
  homeUrl: 'https://homestay-abc.vn/',
  sourceLang: 'vi',
  targetLangs: ['en', 'ko'],
  exclusionSelectors: ['#booking-widget'],
  cacheSeconds: 86_400,
  status: 'ACTIVE',
  tenantStatus: 'ACTIVE',
}) as SiteConfig;

export const SAMPLE_PAGE = `<!DOCTYPE html><html lang="vi"><head><meta charset="utf-8"><title>Homestay ABC</title>
<link rel="stylesheet" href="/css/site.css"></head><body>
<nav><a href="/">Trang chủ</a> · <a href="/phong-nghi/">Phòng nghỉ</a></nav>
<h1>Chào mừng</h1>
<p>Phòng có <strong>ban công</strong> nhìn ra sông. Xem <a href="/bang-gia">bảng giá</a> nhé.</p>
<div id="booking-widget">Đặt phòng ngay</div>
<img src="/img/a.jpg" alt="Sân vườn">
</body></html>`;
