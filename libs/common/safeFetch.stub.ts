/**
 * STUB của safe_fetch – dùng tạm cho đồng đội (F1/F2/F6) trong ngày đầu.
 * - Cùng chữ ký với bản thật: safe_fetch(targetUrl, options?) -> Promise<FetchResult & { outcome }>
 * - KHÔNG gọi mạng, KHÔNG phân giải DNS. Trả về một trang HTML cố định.
 * - Vẫn chạy kiểm tra URL thuần (scheme/cổng/credential/IP literal) để hành vi BLOCKED giống bản thật.
 * Khi tích hợp: đổi import từ './safeFetch.stub.js' sang './safeFetch.js' – không phải sửa code gọi.
 */
import type { FetchOptions, FetchResult, safe_fetch as ContractSafeFetch } from './interfaces.js';
import { isBlockedIp, toFetchResult, validateUrl, type SafeFetchCompatResult } from './safeFetch.js';

export const STUB_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>TranslateMe stub page</title>
  <meta name="description" content="A fixed page returned by the safe_fetch stub.">
  <link rel="stylesheet" href="/static/site.css">
</head>
<body>
  <header><nav><a href="/">Home</a> | <a href="/about">About us</a> | <a href="https://external.example/">External</a></nav></header>
  <main>
    <h1>Welcome to our website</h1>
    <p>This is a <strong>sample paragraph</strong> with <a href="/docs">an inline link</a> inside it.</p>
    <p>Prices start at $9.99 per month. Contact us at hello@example.com.</p>
    <ul><li>Fast delivery</li><li>Friendly support</li><li>Secure payments</li></ul>
    <img src="/img/logo.png" alt="Company logo">
    <div class="notranslate">BrandName™ should not be translated.</div>
    <pre><code>const x = 1; // code must stay untouched</code></pre>
  </main>
  <script>console.log("scripts must not be translated");</script>
  <footer><p>&copy; 2026 Example Inc. All rights reserved.</p></footer>
</body>
</html>`;

export async function safe_fetch(targetUrl: string, _options?: FetchOptions): Promise<SafeFetchCompatResult> {
  const check = validateUrl(targetUrl);
  if (!check.ok) {
    return toFetchResult({ kind: 'BLOCKED', reason: check.reason, url: String(targetUrl), detail: check.detail });
  }
  if (check.ipLiteral !== null && isBlockedIp(check.ipLiteral)) {
    return toFetchResult({ kind: 'BLOCKED', reason: 'PRIVATE_IP', url: check.url.href, detail: `IP bị chặn: ${check.ipLiteral}` });
  }
  return toFetchResult({
    kind: 'OK',
    html: STUB_HTML,
    finalUrl: check.url.href,
    status: 200,
    contentType: 'text/html',
    headers: { 'content-type': 'text/html; charset=utf-8', 'x-translateme-stub': '1' },
  });
}

// Kiểm tra lúc biên dịch: stub phải khớp chữ ký đã chốt.
type Assert<T extends true> = T;
type _ContractStub = Assert<typeof safe_fetch extends typeof ContractSafeFetch ? true : false>;
type _ContractStubResult = Assert<SafeFetchCompatResult extends FetchResult ? true : false>;
