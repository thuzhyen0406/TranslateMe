import { cfg } from './config';

export interface Resp {
  status: number;
  headers: Headers;
  text: string;
  body: any;
  ms: number;
}
export interface CallOpts {
  /** JWT Cognito (console hoặc platform) */
  token?: string;
  /** API key cho /translate/* */
  apiKey?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Gọi thẳng URL tuyệt đối (website của Visitor) thay vì API */
  absolute?: boolean;
  redirect?: 'follow' | 'manual';
  /** Mặc định true: gặp 429 RATE_LIMITED thì chờ rồi thử lại, để các test không kiểm thử giới hạn không bị nhiễu. */
  retryRate?: boolean;
}

export async function call(method: string, path: string, o: CallOpts = {}): Promise<Resp> {
  let r = await callOnce(method, path, o);
  if (o.apiKey && o.retryRate !== false) {
    for (let i = 0; i < 6 && r.status === 429 && errCode(r) === 'RATE_LIMITED'; i++) {
      await new Promise((x) => setTimeout(x, 1100));
      r = await callOnce(method, path, o);
    }
  }
  return r;
}

async function callOnce(method: string, path: string, o: CallOpts): Promise<Resp> {
  const c = cfg();
  const url = o.absolute ? path : `${c.apiBase}${path}`;
  const headers: Record<string, string> = { Accept: 'application/json', ...(o.headers ?? {}) };
  if (o.token) headers['Authorization'] = `${c.authScheme}${o.token}`;
  if (o.apiKey) headers['x-api-key'] = o.apiKey;
  let body: string | undefined;
  if (o.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(o.body);
  }
  const t0 = Date.now();
  const res = await fetch(url, { method, headers, body, redirect: o.redirect ?? 'follow' });
  const text = await res.text();
  let parsed: any = undefined;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { /* không phải JSON (HTML, redirect) */ }
  return { status: res.status, headers: res.headers, text, body: parsed, ms: Date.now() - t0 };
}

export const errCode = (r: Resp): string | undefined => r.body?.error?.code;
