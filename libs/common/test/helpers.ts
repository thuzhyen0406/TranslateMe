/**
 * Công cụ test: resolver DNS giả + transport HTTP giả. Không dùng mạng, không cần AWS.
 */
import type { ResolvedAddress, Resolver, Transport, TransportRequest, TransportResponse } from '../safeFetch.js';

/** IP công khai dùng trong test (không thuộc dải bị chặn). */
export const PUBLIC_IP = '93.184.216.34';
export const PUBLIC_IP_2 = '151.101.1.69';

export interface ResolverSpy extends Resolver {
  calls: string[];
}

/**
 * Resolver giả. Giá trị map có thể là:
 *  - mảng IP (trả về mỗi lần gọi)
 *  - hàm (callIndex) => mảng IP (mô phỏng DNS rebinding: lần 1 công khai, lần 2 nội bộ)
 */
export function fakeResolver(table: Record<string, string[] | ((callIndex: number) => string[])>): ResolverSpy {
  const calls: string[] = [];
  const perHost = new Map<string, number>();
  const fn = (async (hostname: string): Promise<ResolvedAddress[]> => {
    calls.push(hostname);
    const idx = perHost.get(hostname) ?? 0;
    perHost.set(hostname, idx + 1);
    const entry = table[hostname];
    if (entry === undefined) throw Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
    const ips = typeof entry === 'function' ? entry(idx) : entry;
    return ips.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }) as ResolvedAddress);
  }) as ResolverSpy;
  fn.calls = calls;
  return fn;
}

export interface FakeBody {
  body: AsyncIterable<Uint8Array>;
  /** Số chunk transport đã bị kéo ra (để chứng minh dừng đọc sớm). */
  pulled: () => number;
}

/** Body từ danh sách chunk. */
export function bodyOf(chunks: Array<string | Buffer>): FakeBody {
  let pulled = 0;
  return {
    pulled: () => pulled,
    body: (async function* () {
      for (const c of chunks) {
        pulled++;
        yield typeof c === 'string' ? Buffer.from(c, 'utf8') : c;
      }
    })(),
  };
}

/** Body vô hạn (mỗi chunk `size` byte). */
export function infiniteBody(size = 64 * 1024): FakeBody {
  let pulled = 0;
  const chunk = Buffer.alloc(size, 0x61);
  return {
    pulled: () => pulled,
    body: (async function* () {
      for (;;) {
        pulled++;
        yield chunk;
      }
    })(),
  };
}

/** Body treo mãi không trả chunk nào. */
export function hangingBody(): FakeBody {
  return {
    pulled: () => 0,
    body: {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<Uint8Array>>(() => {}) }),
    },
  };
}

export function response(
  status: number,
  headers: Record<string, string | string[]>,
  body: FakeBody = bodyOf([]),
): TransportResponse & { destroyed: () => boolean } {
  let destroyed = false;
  return {
    status,
    headers,
    body: body.body,
    destroy: () => {
      destroyed = true;
    },
    destroyed: () => destroyed,
  };
}

export const html = (content: string, extraHeaders: Record<string, string> = {}) =>
  response(200, { 'content-type': 'text/html; charset=utf-8', ...extraHeaders }, bodyOf([content]));

export const redirect = (status: number, location: string) =>
  response(status, { location, 'content-type': 'text/html' });

export type Route = (req: TransportRequest) => TransportResponse | Promise<TransportResponse>;

export interface TransportSpy extends Transport {
  calls: TransportRequest[];
}

/** Transport giả: route theo url.href. Request không có route -> lỗi (test sẽ thấy NETWORK_ERROR). */
export function fakeTransport(routes: Record<string, Route>): TransportSpy {
  const calls: TransportRequest[] = [];
  const fn = (async (req: TransportRequest) => {
    calls.push(req);
    const route = routes[req.url.href];
    if (!route) throw Object.assign(new Error(`Không có route cho ${req.url.href}`), { code: 'TEST_NO_ROUTE' });
    return route(req);
  }) as TransportSpy;
  fn.calls = calls;
  return fn;
}

/** Tất cả IP mà transport đã được phép kết nối tới. */
export const contactedIps = (t: TransportSpy): string[] => t.calls.flatMap((c) => c.addresses.map((a) => a.address));
