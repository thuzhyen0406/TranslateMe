/**
 * safe_fetch – tải trang web bên ngoài an toàn, chống SSRF (Nhiệm vụ 1.10).
 * Dùng chung cho: F1 (xác minh sở hữu website), F2 (proxy tải HTML gốc), F6 (tải sitemap).
 *
 * Hai lớp API:
 *  - safeFetch(url, options?, deps?)  -> Promise<SafeFetchOutcome>  (union phân biệt theo `kind`, không bao giờ throw)
 *  - safe_fetch(url, options?)        -> Promise<FetchResult & { outcome }>  (ĐÚNG chữ ký đã chốt ở interfaces.d.ts)
 *
 * Luồng mỗi lần nhảy (kể cả sau chuyển hướng):
 *   validateUrl (scheme/cổng/credential/dạng IP) -> phân giải DNS 1 lần, kiểm tra TẤT CẢ IP
 *   -> kết nối thẳng tới IP đã kiểm tra (lookup ghim, không hỏi DNS lần 2)
 *   -> xử lý 3xx thủ công -> kiểm tra Content-Type -> Content-Length -> đọc body dạng stream có giới hạn.
 */
import type { LookupAddress, LookupOptions } from 'node:dns';
import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { Readable, pipeline, type Transform } from 'node:stream';
import zlib from 'node:zlib';
import type { FetchOptions, FetchResult, safe_fetch as ContractSafeFetch } from './interfaces.js';

// ============================================================================
// Cấu hình mặc định
// ============================================================================

export const SAFE_FETCH_DEFAULTS = Object.freeze({
  connectTimeoutMs: 5_000,
  totalTimeoutMs: 10_000,
  maxSizeBytes: 3 * 1024 * 1024, // 3 MB HTML gốc (tính sau giải nén)
  maxRedirects: 5,
  allowedContentTypes: Object.freeze(['text/html']) as readonly string[],
  // TODO(nhóm): chốt User-Agent chính thức (nên kèm URL trang giới thiệu bot).
  userAgent: process.env.SAFE_FETCH_USER_AGENT ?? 'TranslateMe-Fetcher/0.1',
});

/** Mã lỗi nội bộ (transport có thể ném lỗi mang các `code` này). */
export const SAFE_FETCH_ERROR_CODES = Object.freeze({
  CONNECT_TIMEOUT: 'SAFE_FETCH_CONNECT_TIMEOUT',
  BLOCKED_AT_CONNECT: 'SAFE_FETCH_BLOCKED_AT_CONNECT',
  ABORTED: 'SAFE_FETCH_ABORTED',
});

const ALLOWED_PORTS = new Set([80, 443]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_URL_LENGTH = 8192;

/** Header người gọi được phép truyền (allowlist). Mọi header khác bị bỏ qua. */
const CALLER_HEADER_ALLOWLIST = new Set(['accept', 'accept-language', 'user-agent']);
/** Header tuyệt đối không gửi đi (phòng thủ chiều sâu, xoá lần cuối trước khi gửi). */
const FORBIDDEN_OUTGOING_HEADERS = ['cookie', 'cookie2', 'authorization', 'proxy-authorization'];

// ============================================================================
// Kiểu dữ liệu
// ============================================================================

export type BlockReason =
  | 'INVALID_URL' // không phân tích được / quá dài / Location hỏng
  | 'SCHEME' // không phải http/https
  | 'CREDENTIALS' // có user:pass@
  | 'NO_HOST' // không có hostname
  | 'PORT' // cổng khác 80/443
  | 'IP_FORMAT' // hostname dạng số lạ không chuẩn hoá được
  | 'PRIVATE_IP'; // IP (literal hoặc từ DNS) thuộc dải bị chặn

export type SafeFetchOutcome =
  | {
      kind: 'OK';
      html: string;
      finalUrl: string;
      status: number;
      contentType: string;
      headers: Record<string, string>;
    }
  | { kind: 'BLOCKED'; reason: BlockReason; url: string; detail: string }
  | {
      kind: 'NOT_HTML';
      finalUrl: string;
      contentType: string;
      status: number;
      headers: Record<string, string>;
    }
  | { kind: 'TOO_LARGE'; finalUrl: string; limitBytes: number; detail: string }
  | { kind: 'TOO_MANY_REDIRECTS'; finalUrl: string; maxRedirects: number }
  | { kind: 'TIMEOUT'; finalUrl: string; phase: 'connect' | 'total'; timeoutMs: number }
  | { kind: 'NETWORK_ERROR'; finalUrl: string; code: string; detail: string };

export type SafeFetchKind = SafeFetchOutcome['kind'];

/** Tuỳ chọn mở rộng cho hàm lõi; FetchOptions (đã chốt) là tập con. */
export interface SafeFetchOptions extends FetchOptions {
  /** Timeout tổng (ms) cho toàn bộ chuỗi chuyển hướng + đọc body. Mặc định 10000. */
  timeoutMs?: number;
  /** Kích thước tối đa body sau giải nén (byte). Mặc định 3 MB. */
  maxSizeBytes?: number;
  /** Timeout kết nối TCP/TLS (ms). Mặc định 5000. */
  connectTimeoutMs?: number;
  /** Số lần chuyển hướng tối đa. Mặc định 5. */
  maxRedirects?: number;
  /** Chỉ accept / accept-language / user-agent được dùng; Cookie, Authorization... luôn bị loại. */
  headers?: Record<string, string>;
  /** Media type chấp nhận. Mặc định ['text/html']. F6 (sitemap) có thể truyền ['application/xml','text/xml']. */
  allowedContentTypes?: string[];
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Resolver DNS: phải trả về TẤT CẢ địa chỉ (A + AAAA). Tiêm bản giả khi test. */
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface TransportRequest {
  /** URL đích (hostname gốc – dùng cho Host, SNI, xác thực chứng chỉ). */
  url: URL;
  /** Các IP ĐÃ kiểm tra. Transport chỉ được kết nối tới các IP này. */
  addresses: readonly ResolvedAddress[];
  /** Header đã làm sạch (không Cookie/Authorization), có Host = hostname gốc. */
  headers: Readonly<Record<string, string>>;
  connectTimeoutMs: number;
  signal: AbortSignal;
}

export interface TransportResponse {
  status: number;
  /** Header khoá chữ thường (giống IncomingMessage.headers). */
  headers: Record<string, string | string[] | undefined>;
  /** Body thô (có thể còn nén), đọc dạng stream. */
  body: AsyncIterable<Uint8Array>;
  /** Giải phóng kết nối (gọi khi bỏ dở body). */
  destroy(): void;
}

/** Transport HTTP: chỉ thực hiện 1 request GET, KHÔNG tự theo chuyển hướng. Tiêm bản giả khi test. */
export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

export interface SafeFetchDeps {
  resolver?: Resolver;
  transport?: Transport;
}

/** Kết quả của safe_fetch: đúng FetchResult đã chốt + `outcome` chi tiết. */
export interface SafeFetchCompatResult extends FetchResult {
  outcome: SafeFetchOutcome;
}

// ============================================================================
// Kiểm tra IP (hàm thuần, test độc lập)
// ============================================================================

/** Phân tích IPv4 dạng chuẩn a.b.c.d (thập phân, không số 0 đứng đầu). Trả null nếu dạng lạ. */
function parseIPv4(s: string): [number, number, number, number] | null {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return null;
  const parts = s.split('.');
  const out: number[] = [];
  for (const p of parts) {
    if (p.length > 1 && p.startsWith('0')) return null; // tránh mơ hồ bát phân (0177...)
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out as [number, number, number, number];
}

/** Phân tích IPv6 (hỗ trợ '::' và đuôi IPv4 nhúng) thành 8 nhóm 16 bit. Trả null nếu không hợp lệ. */
function parseIPv6(input: string): number[] | null {
  let s = input;
  if (s.length < 2 || s.length > 45) return null;
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(':');
  if (lastColon === -1) return null;
  const lastPart = s.slice(lastColon + 1);
  if (lastPart.includes('.')) {
    const v4 = parseIPv4(lastPart);
    if (!v4) return null;
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    s = s.slice(0, lastColon + 1);
    if (!s.endsWith('::')) s = s.slice(0, -1);
  }
  const dbl = s.indexOf('::');
  if (dbl !== s.lastIndexOf('::')) return null;
  const groupsOf = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  if (dbl === -1) {
    const g = groupsOf(s);
    if (!g) return null;
    const all = [...g, ...tail];
    return all.length === 8 ? all : null;
  }
  const head = groupsOf(s.slice(0, dbl));
  const rest = groupsOf(s.slice(dbl + 2));
  if (!head || !rest) return null;
  const fill = 8 - head.length - rest.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...rest, ...tail];
}

const v4ToInt = (o: readonly number[]): number =>
  (((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3]) >>> 0;

const cidr4 = (base: string, prefix: number): [number, number] => {
  const p = parseIPv4(base);
  if (!p) throw new Error(`CIDR cấu hình sai: ${base}`);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return [(v4ToInt(p) & mask) >>> 0, mask];
};

/** Dải IPv4 bị chặn. Được phép THÊM dải, KHÔNG được bớt. */
const BLOCKED_V4: ReadonlyArray<[number, number]> = [
  cidr4('0.0.0.0', 8), // "this network" (gồm 0.0.0.0)
  cidr4('10.0.0.0', 8), // RFC1918
  cidr4('100.64.0.0', 10), // CGNAT (chặn thêm)
  cidr4('127.0.0.0', 8), // loopback
  cidr4('169.254.0.0', 16), // link-local, gồm metadata 169.254.169.254
  cidr4('172.16.0.0', 12), // RFC1918
  cidr4('192.168.0.0', 16), // RFC1918
  cidr4('224.0.0.0', 4), // multicast (chặn thêm)
  cidr4('240.0.0.0', 4), // reserved + broadcast 255.255.255.255 (chặn thêm)
];

function isBlockedIPv4(o: readonly number[]): boolean {
  const n = v4ToInt(o);
  return BLOCKED_V4.some(([base, mask]) => ((n & mask) >>> 0) === base);
}

function isBlockedIPv6(g: readonly number[]): boolean {
  const zeros = (count: number) => g.slice(0, count).every((x) => x === 0);
  const embedded = (hi: number, lo: number) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];

  // IPv4-mapped ::ffff:a.b.c.d -> tách IPv4 ra rồi kiểm tra lại (không tin net.BlockList cho dạng này).
  if (zeros(5) && g[5] === 0xffff) return isBlockedIPv4(embedded(g[6], g[7]));
  // ::/96 gồm ::, ::1 và IPv4-compatible (::a.b.c.d, đã lỗi thời) -> chặn toàn bộ.
  if (zeros(6)) return true;
  // IPv4-translated ::ffff:0:a.b.c.d (SIIT) -> kiểm tra IPv4 nhúng.
  if (zeros(4) && g[4] === 0xffff && g[5] === 0) return isBlockedIPv4(embedded(g[6], g[7]));
  // NAT64 64:ff9b::/96 (VPC có DNS64) -> kiểm tra IPv4 nhúng; 64:ff9b:1::/48 (local-use) -> chặn.
  if (g[0] === 0x64 && g[1] === 0xff9b) {
    if (g[2] === 1) return true;
    if (g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
      return isBlockedIPv4(embedded(g[6], g[7]));
    }
  }
  // 6to4 2002:AABB:CCDD::/48 -> kiểm tra IPv4 nhúng.
  if (g[0] === 0x2002) return isBlockedIPv4(embedded(g[1], g[2]));
  // Teredo 2001:0::/32 (IPv4 bị che bằng XOR) -> chặn luôn.
  if (g[0] === 0x2001 && g[1] === 0) return true;
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local (gồm fd00:ec2::254 – IMDS IPv6)
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (cũ)
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/**
 * Trả về true nếu IP thuộc dải bị chặn HOẶC không phân tích được (fail-closed).
 * Chấp nhận IPv4 a.b.c.d, IPv6 (có/không ngoặc vuông). Dạng lạ (2130706433, 0x7f.1, 0177...) -> true.
 */
export function isBlockedIp(ip: string): boolean {
  if (typeof ip !== 'string') return true;
  let s = ip.trim();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  if (s.includes('%')) return true; // zone id (fe80::1%eth0) -> không hợp lệ cho đích công khai
  const v4 = parseIPv4(s);
  if (v4) return isBlockedIPv4(v4);
  if (s.includes(':')) {
    const g = parseIPv6(s);
    return g ? isBlockedIPv6(g) : true;
  }
  return true;
}

// ============================================================================
// Kiểm tra URL (hàm thuần)
// ============================================================================

export type UrlCheck =
  | { ok: true; url: URL; port: number; ipLiteral: string | null }
  | { ok: false; reason: BlockReason; detail: string };

const urlFail = (reason: BlockReason, detail: string): UrlCheck => ({ ok: false, reason, detail });

/**
 * Kiểm tra scheme/credential/hostname/cổng và nhận diện IP literal.
 * WHATWG URL đã chuẩn hoá các dạng IPv4 lạ (2130706433, 0x7f.1, 0177.0.0.1 -> 127.0.0.1);
 * mọi hostname còn sót dạng số không chuẩn đều bị từ chối.
 */
export function validateUrl(input: string): UrlCheck {
  if (typeof input !== 'string' || input.length === 0 || input.length > MAX_URL_LENGTH) {
    return urlFail('INVALID_URL', 'URL rỗng hoặc quá dài');
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return urlFail('INVALID_URL', 'Không phân tích được URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return urlFail('SCHEME', `Scheme không được phép: ${url.protocol}`);
  }
  if (url.username !== '' || url.password !== '') {
    return urlFail('CREDENTIALS', 'URL chứa thông tin đăng nhập user:pass@');
  }
  const hostname = url.hostname;
  if (hostname === '') return urlFail('NO_HOST', 'URL không có hostname');

  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  if (!ALLOWED_PORTS.has(port)) return urlFail('PORT', `Cổng không được phép: ${port}`);

  if (hostname.startsWith('[')) {
    const v6 = hostname.slice(1, -1);
    if (!hostname.endsWith(']') || isIP(v6) !== 6) return urlFail('IP_FORMAT', 'IPv6 literal không hợp lệ');
    return { ok: true, url, port, ipLiteral: v6 };
  }
  if (isIP(hostname) === 4) return { ok: true, url, port, ipLiteral: hostname };

  const labels = hostname.split('.').filter((l) => l !== '');
  const last = labels[labels.length - 1] ?? '';
  if (/^(0x[0-9a-f]*|[0-9]+)$/i.test(last)) {
    return urlFail('IP_FORMAT', `Hostname dạng số không chuẩn: ${hostname.slice(0, 64)}`);
  }
  return { ok: true, url, port, ipLiteral: null };
}

// ============================================================================
// Header gửi đi
// ============================================================================

/** Tạo header gửi đi. Không bao giờ chứa Cookie/Authorization dù người gọi truyền vào. */
export function buildOutgoingHeaders(
  url: URL,
  callerHeaders: Record<string, string> | undefined,
  userAgent: string = SAFE_FETCH_DEFAULTS.userAgent,
): Record<string, string> {
  const headers: Record<string, string> = {
    host: url.host, // Host = tên miền gốc (không phải IP đã ghim)
    'user-agent': userAgent,
    accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
    'accept-encoding': 'gzip, deflate, br',
  };
  if (callerHeaders && typeof callerHeaders === 'object') {
    for (const [rawKey, value] of Object.entries(callerHeaders)) {
      const key = rawKey.toLowerCase();
      // Bảo mật: chỉ nhận header trong allowlist -> Cookie, Authorization, Host, X-Forwarded-For... bị loại.
      if (!CALLER_HEADER_ALLOWLIST.has(key)) continue;
      if (typeof value !== 'string' || /[\r\n\0]/.test(value)) continue; // chống header injection
      headers[key] = value;
    }
  }
  // Phòng thủ chiều sâu: xoá lần cuối các header nhạy cảm.
  for (const h of FORBIDDEN_OUTGOING_HEADERS) delete headers[h];
  return headers;
}

// ============================================================================
// Resolver & transport mặc định (Node.js thật)
// ============================================================================

/** Resolver mặc định: dns.lookup với all:true -> lấy TẤT CẢ địa chỉ A và AAAA. */
export const defaultResolver: Resolver = async (hostname) => {
  const list = await dnsLookup(hostname, { all: true, verbatim: true });
  return list.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
};

/**
 * Tạo hàm `lookup` cho http(s).request chỉ trả về các IP đã kiểm tra.
 * Bảo mật (chống DNS rebinding): KHÔNG phân giải DNS ở đây, nên không có khoảng hở
 * giữa lúc kiểm tra và lúc kết nối. IP được kiểm tra lại lần nữa ngay tại điểm kết nối.
 */
export function createPinnedLookup(addresses: readonly ResolvedAddress[]): LookupFunction {
  const pinned: LookupAddress[] = addresses.map((a) => ({ address: a.address, family: a.family }));
  return (_hostname: string, options: LookupOptions, callback) => {
    if (pinned.length === 0 || pinned.some((a) => isBlockedIp(a.address))) {
      const err = codeError(SAFE_FETCH_ERROR_CODES.BLOCKED_AT_CONNECT, 'IP bị chặn tại thời điểm kết nối');
      callback(err as NodeJS.ErrnoException, '', 0);
      return;
    }
    const opts: LookupOptions = options && typeof options === 'object' ? options : {};
    if (opts.all) {
      // Node 20 bật autoSelectFamily -> gọi lookup với all:true; trả mọi IP đã kiểm tra.
      callback(null, pinned.map((a) => ({ ...a })));
      return;
    }
    const fam: unknown = opts.family;
    const want = fam === 6 || fam === 'IPv6' ? 6 : fam === 4 || fam === 'IPv4' ? 4 : 0;
    const pick = pinned.find((a) => want === 0 || a.family === want) ?? pinned[0];
    callback(null, pick.address, pick.family);
  };
}

/** Dựng tuỳ chọn cho http(s).request (tách riêng để test không cần mạng). */
export function buildNodeRequestOptions(req: TransportRequest): https.RequestOptions {
  const { url } = req;
  const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  const opts: https.RequestOptions = {
    protocol: url.protocol,
    host: hostname, // tên miền gốc; IP thật lấy từ lookup ghim
    port,
    method: 'GET', // chỉ GET
    path: `${url.pathname}${url.search}`,
    headers: { ...req.headers },
    agent: false, // không dùng lại socket giữa các request/tenant
    lookup: createPinnedLookup(req.addresses),
    signal: req.signal,
  };
  if (url.protocol === 'https:') {
    // Bảo mật: SNI + xác thực chứng chỉ theo TÊN MIỀN GỐC, không theo IP.
    opts.rejectUnauthorized = true;
    if (isIP(hostname) === 0) opts.servername = hostname.replace(/\.$/, '');
  }
  return opts;
}

/** Transport mặc định dùng node:http / node:https. Không tự theo chuyển hướng. */
export const nodeTransport: Transport = (req) =>
  new Promise<TransportResponse>((resolve, reject) => {
    const options = buildNodeRequestOptions(req);
    const isHttps = req.url.protocol === 'https:';
    let connectTimer: NodeJS.Timeout | undefined;
    const clearConnectTimer = () => {
      if (connectTimer) clearTimeout(connectTimer);
      connectTimer = undefined;
    };

    const onResponse = (res: http.IncomingMessage) => {
      clearConnectTimer();
      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: res,
        destroy: () => {
          res.destroy();
          request.destroy();
        },
      });
    };
    const request = isHttps ? https.request(options, onResponse) : http.request(options, onResponse);

    request.on('socket', (socket) => {
      if (!socket.connecting) return;
      connectTimer = setTimeout(() => {
        request.destroy(codeError(SAFE_FETCH_ERROR_CODES.CONNECT_TIMEOUT, 'Hết thời gian kết nối'));
      }, req.connectTimeoutMs);
      socket.once(isHttps ? 'secureConnect' : 'connect', clearConnectTimer);
      socket.once('close', clearConnectTimer);
    });
    request.on('error', (err) => {
      clearConnectTimer();
      reject(err);
    });
    request.end();
  });

// ============================================================================
// Hàm lõi
// ============================================================================

interface NormalizedConfig {
  totalTimeoutMs: number;
  connectTimeoutMs: number;
  maxSizeBytes: number;
  maxRedirects: number;
  allowedContentTypes: readonly string[];
  headers: Record<string, string> | undefined;
  userAgent: string;
}

const posInt = (v: unknown, def: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : def;

function normalizeOptions(o: SafeFetchOptions | undefined): NormalizedConfig {
  const opts = o ?? {};
  const totalTimeoutMs = posInt(opts.timeoutMs, SAFE_FETCH_DEFAULTS.totalTimeoutMs);
  const types = Array.isArray(opts.allowedContentTypes)
    ? opts.allowedContentTypes.map((t) => String(t).trim().toLowerCase()).filter((t) => t !== '')
    : [];
  return {
    totalTimeoutMs,
    connectTimeoutMs: Math.min(posInt(opts.connectTimeoutMs, SAFE_FETCH_DEFAULTS.connectTimeoutMs), totalTimeoutMs),
    maxSizeBytes: posInt(opts.maxSizeBytes, SAFE_FETCH_DEFAULTS.maxSizeBytes),
    maxRedirects:
      typeof opts.maxRedirects === 'number' && Number.isInteger(opts.maxRedirects) && opts.maxRedirects >= 0
        ? opts.maxRedirects
        : SAFE_FETCH_DEFAULTS.maxRedirects,
    allowedContentTypes: types.length > 0 ? types : SAFE_FETCH_DEFAULTS.allowedContentTypes,
    headers: opts.headers,
    userAgent: SAFE_FETCH_DEFAULTS.userAgent,
  };
}

/**
 * Tải URL an toàn. KHÔNG BAO GIỜ throw – mọi tình huống trả về SafeFetchOutcome có `kind`.
 * @param targetUrl URL cần tải
 * @param options   Tuỳ chọn (timeout, giới hạn, header allowlist, content-type chấp nhận)
 * @param deps      Tiêm resolver/transport giả khi test (mặc định: DNS + node:http(s) thật)
 */
export async function safeFetch(
  targetUrl: string,
  options?: SafeFetchOptions,
  deps: SafeFetchDeps = {},
): Promise<SafeFetchOutcome> {
  const cfg = normalizeOptions(options);
  const resolver = deps.resolver ?? defaultResolver;
  const transport = deps.transport ?? nodeTransport;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.totalTimeoutMs);
  const state = { currentUrl: String(targetUrl) };
  try {
    return await fetchLoop(cfg, resolver, transport, controller.signal, state);
  } catch (err) {
    return mapError(err, controller.signal, state.currentUrl, cfg);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchLoop(
  cfg: NormalizedConfig,
  resolver: Resolver,
  transport: Transport,
  signal: AbortSignal,
  state: { currentUrl: string },
): Promise<SafeFetchOutcome> {
  let redirects = 0;
  for (;;) {
    // (1) Kiểm tra URL – chạy lại cho MỖI URL mới sau chuyển hướng.
    const check = validateUrl(state.currentUrl);
    if (!check.ok) return { kind: 'BLOCKED', reason: check.reason, url: state.currentUrl, detail: check.detail };
    const url = check.url;
    state.currentUrl = url.href;

    // (2) Phân giải DNS một lần + kiểm tra tất cả IP.
    const resolved = await resolveAndCheck(check, resolver, signal);
    if (!resolved.ok) return resolved.outcome;

    // (3) Kết nối thẳng tới IP đã kiểm tra (transport nhận danh sách IP ghim).
    const headers = buildOutgoingHeaders(url, cfg.headers, cfg.userAgent);
    const res = await raceAbort(
      Promise.resolve().then(() =>
        transport({ url, addresses: resolved.addresses, headers, connectTimeoutMs: cfg.connectTimeoutMs, signal }),
      ),
      signal,
      (late) => late.destroy(),
    );
    const resHeaders = flattenHeaders(res.headers);

    // (4) Chuyển hướng thủ công.
    if (REDIRECT_STATUSES.has(res.status)) {
      res.destroy();
      const location = resHeaders['location'];
      if (!location) {
        return { kind: 'NETWORK_ERROR', finalUrl: url.href, code: 'REDIRECT_WITHOUT_LOCATION', detail: `HTTP ${res.status} thiếu Location` };
      }
      if (redirects >= cfg.maxRedirects) {
        return { kind: 'TOO_MANY_REDIRECTS', finalUrl: url.href, maxRedirects: cfg.maxRedirects };
      }
      redirects++;
      let next: string;
      try {
        next = new URL(location, url).href; // hỗ trợ Location tương đối
      } catch {
        return { kind: 'BLOCKED', reason: 'INVALID_URL', url: location.slice(0, 2048), detail: 'Location không hợp lệ' };
      }
      state.currentUrl = next;
      continue;
    }

    // (7) Kiểm tra Content-Type TRƯỚC khi đọc body.
    const contentType = resHeaders['content-type'] ?? '';
    const mediaType = contentType.split(';')[0].trim().toLowerCase();
    if (!cfg.allowedContentTypes.includes(mediaType)) {
      res.destroy();
      return { kind: 'NOT_HTML', finalUrl: url.href, contentType, status: res.status, headers: resHeaders };
    }

    // (5a) Content-Length khai báo vượt giới hạn -> dừng, không đọc body.
    const declared = resHeaders['content-length'];
    if (declared !== undefined) {
      const n = Number(declared);
      if (Number.isFinite(n) && n > cfg.maxSizeBytes) {
        res.destroy();
        return { kind: 'TOO_LARGE', finalUrl: url.href, limitBytes: cfg.maxSizeBytes, detail: `Content-Length=${n}` };
      }
    }

    // (5b) Đọc body dạng stream, dừng ngay khi vượt (tính cả sau giải nén).
    const body = await readBodyLimited(res, resHeaders['content-encoding'] ?? '', cfg.maxSizeBytes, signal);
    if (body.tooLarge) {
      return { kind: 'TOO_LARGE', finalUrl: url.href, limitBytes: cfg.maxSizeBytes, detail: body.detail };
    }
    return {
      kind: 'OK',
      html: decodeBody(body.bytes, contentType),
      finalUrl: url.href,
      status: res.status,
      contentType: mediaType,
      headers: resHeaders,
    };
  }
}

type ResolveResult = { ok: true; addresses: ResolvedAddress[] } | { ok: false; outcome: SafeFetchOutcome };

async function resolveAndCheck(
  check: Extract<UrlCheck, { ok: true }>,
  resolver: Resolver,
  signal: AbortSignal,
): Promise<ResolveResult> {
  const href = check.url.href;
  if (check.ipLiteral !== null) {
    if (isBlockedIp(check.ipLiteral)) {
      return { ok: false, outcome: { kind: 'BLOCKED', reason: 'PRIVATE_IP', url: href, detail: `IP bị chặn: ${check.ipLiteral}` } };
    }
    return { ok: true, addresses: [{ address: check.ipLiteral, family: isIP(check.ipLiteral) === 6 ? 6 : 4 }] };
  }

  const hostname = check.url.hostname;
  const list = await raceAbort(Promise.resolve().then(() => resolver(hostname)), signal);
  if (!Array.isArray(list) || list.length === 0) {
    return { ok: false, outcome: { kind: 'NETWORK_ERROR', finalUrl: href, code: 'DNS_NO_ADDRESS', detail: `Không phân giải được ${hostname}` } };
  }
  const seen = new Set<string>();
  const addresses: ResolvedAddress[] = [];
  for (const entry of list) {
    const address = String(entry?.address ?? '');
    // Bảo mật: chặn nếu BẤT KỲ địa chỉ nào bị chặn (kể cả khi host có cả IP công khai).
    if (isBlockedIp(address)) {
      return {
        ok: false,
        outcome: { kind: 'BLOCKED', reason: 'PRIVATE_IP', url: href, detail: `${hostname} phân giải ra IP bị chặn: ${address.slice(0, 64)}` },
      };
    }
    if (seen.has(address)) continue;
    seen.add(address);
    addresses.push({ address, family: isIP(address) === 6 ? 6 : 4 });
  }
  addresses.sort((a, b) => a.family - b.family); // ưu tiên IPv4 (Lambda ngoài VPC thường chỉ có IPv4)
  return { ok: true, addresses };
}

// ============================================================================
// Đọc body có giới hạn + giải nén + giải mã ký tự
// ============================================================================

function createDecoder(encodingHeader: string): Transform | undefined {
  const enc = encodingHeader.trim().toLowerCase();
  if (enc === '' || enc === 'identity') return undefined;
  if (enc === 'gzip' || enc === 'x-gzip') return zlib.createGunzip();
  if (enc === 'deflate') return zlib.createInflate();
  if (enc === 'br') return zlib.createBrotliDecompress();
  throw codeError('UNSUPPORTED_CONTENT_ENCODING', `Không hỗ trợ Content-Encoding: ${enc.slice(0, 40)}`);
}

async function readBodyLimited(
  res: TransportResponse,
  contentEncoding: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ tooLarge: false; bytes: Buffer } | { tooLarge: true; detail: string }> {
  const limit = { hit: '' };
  let decoder: Transform | undefined;
  let iterator: AsyncIterator<Uint8Array> | undefined;

  async function* countedRaw(): AsyncGenerator<Uint8Array> {
    let rawBytes = 0;
    for await (const chunk of res.body) {
      rawBytes += chunk.byteLength;
      if (rawBytes > maxBytes) {
        limit.hit = `Body thô vượt ${maxBytes} byte`;
        throw codeError('SAFE_FETCH_TOO_LARGE', limit.hit);
      }
      yield chunk;
    }
  }

  const chunks: Buffer[] = [];
  let total = 0;
  try {
    decoder = createDecoder(contentEncoding);
    const source: AsyncIterable<Uint8Array> = decoder
      ? pipeline(Readable.from(countedRaw(), { objectMode: false }), decoder, () => {})
      : countedRaw();
    iterator = source[Symbol.asyncIterator]();
    for (;;) {
      const step = await raceAbort(iterator.next(), signal);
      if (step.done) break;
      const buf = Buffer.isBuffer(step.value) ? step.value : Buffer.from(step.value);
      total += buf.byteLength;
      if (total > maxBytes) {
        limit.hit = `Body sau giải nén vượt ${maxBytes} byte`;
        break;
      }
      chunks.push(buf);
    }
  } catch (err) {
    if (limit.hit) return { tooLarge: true, detail: limit.hit };
    throw err;
  } finally {
    // Dừng đọc ngay: huỷ luồng giải nén, iterator và kết nối gốc.
    decoder?.destroy();
    iterator?.return?.()?.catch(() => {});
    res.destroy();
  }
  if (limit.hit) return { tooLarge: true, detail: limit.hit };
  return { tooLarge: false, bytes: Buffer.concat(chunks, total) };
}

/** Giải mã body theo charset ở Content-Type, rồi <meta charset>, mặc định UTF-8. */
export function decodeBody(bytes: Buffer, contentType: string): string {
  const fromHeader = /charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType)?.[1];
  const fromMeta = fromHeader
    ? undefined
    : /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_\-:.]+)/i.exec(bytes.subarray(0, 2048).toString('latin1'))?.[1];
  const label = fromHeader ?? fromMeta ?? 'utf-8';
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

// ============================================================================
// Tiện ích
// ============================================================================

function flattenHeaders(h: TransportResponse['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) {
    const key = k.toLowerCase();
    if (v === undefined || key === 'set-cookie') continue; // không chuyển cookie của origin cho nơi gọi
    out[key] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

function codeError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** Đua promise với AbortSignal; nếu promise thắng muộn thì gọi onLateValue để dọn dẹp. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal, onLateValue?: (v: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(codeError(SAFE_FETCH_ERROR_CODES.ABORTED, 'Hết thời gian tổng'));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        if (settled) {
          onLateValue?.(v);
          return;
        }
        settled = true;
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        if (settled) return;
        settled = true;
        reject(e);
      },
    );
  });
}

function mapError(err: unknown, signal: AbortSignal, currentUrl: string, cfg: NormalizedConfig): SafeFetchOutcome {
  if (signal.aborted) return { kind: 'TIMEOUT', finalUrl: currentUrl, phase: 'total', timeoutMs: cfg.totalTimeoutMs };
  const code =
    err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string'
      ? (err as { code: string }).code
      : 'UNKNOWN';
  if (code === SAFE_FETCH_ERROR_CODES.CONNECT_TIMEOUT) {
    return { kind: 'TIMEOUT', finalUrl: currentUrl, phase: 'connect', timeoutMs: cfg.connectTimeoutMs };
  }
  if (code === SAFE_FETCH_ERROR_CODES.BLOCKED_AT_CONNECT) {
    return { kind: 'BLOCKED', reason: 'PRIVATE_IP', url: currentUrl, detail: 'IP bị chặn tại thời điểm kết nối' };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { kind: 'NETWORK_ERROR', finalUrl: currentUrl, code, detail: message.slice(0, 200) };
}

// ============================================================================
// Adapter theo chữ ký đã chốt ở interfaces.d.ts
// ============================================================================

/**
 * Chuyển SafeFetchOutcome -> FetchResult (đã chốt).
 *  - OK       : body = HTML, isHtml = true
 *  - NOT_HTML : body = '', isHtml = false, finalUrl = URL cuối (proxy trả 302 về đây)
 *  - còn lại  : status = 0 (không có phản hồi HTTP dùng được), body = '', isHtml = false
 * Chi tiết luôn nằm ở `outcome.kind`.
 */
export function toFetchResult(outcome: SafeFetchOutcome): SafeFetchCompatResult {
  switch (outcome.kind) {
    case 'OK':
      return {
        status: outcome.status,
        headers: outcome.headers,
        body: outcome.html,
        finalUrl: outcome.finalUrl,
        isHtml: outcome.contentType === 'text/html' || outcome.contentType === 'application/xhtml+xml',
        outcome,
      };
    case 'NOT_HTML':
      return { status: outcome.status, headers: outcome.headers, body: '', finalUrl: outcome.finalUrl, isHtml: false, outcome };
    case 'BLOCKED':
      return { status: 0, headers: {}, body: '', finalUrl: outcome.url, isHtml: false, outcome };
    default:
      return { status: 0, headers: {}, body: '', finalUrl: outcome.finalUrl, isHtml: false, outcome };
  }
}

/** Tạo hàm có ĐÚNG chữ ký safe_fetch nhưng tiêm resolver/transport (dùng khi test F1/F2/F6). */
export function createSafeFetch(deps: SafeFetchDeps = {}) {
  return async function safe_fetch(targetUrl: string, options?: FetchOptions): Promise<SafeFetchCompatResult> {
    return toFetchResult(await safeFetch(targetUrl, options, deps));
  };
}

/** Bản dùng thật – đúng chữ ký `safe_fetch(targetUrl, options?)` trong libs/common/interfaces.d.ts. */
export const safe_fetch = createSafeFetch();

// Kiểm tra lúc biên dịch: lệch chữ ký đã chốt -> tsc báo lỗi.
type Assert<T extends true> = T;
type _ContractSafeFetch = Assert<typeof safe_fetch extends typeof ContractSafeFetch ? true : false>;
type _ContractResult = Assert<SafeFetchCompatResult extends FetchResult ? true : false>;
