/**
 * CORS cho các Lambda sau API Gateway (tích hợp Lambda proxy) được Web Console gọi từ một origin khác
 * (console trên CloudFront riêng, API ở execute-api). Với Lambda proxy, API Gateway REST không tự thêm header
 * vào phản hồi, nên Lambda phải trả `Access-Control-Allow-Origin`; thiếu header này trình duyệt chặn mọi phản hồi.
 *
 * Dùng `*` vì Console xác thực bằng header Authorization (ID token), không dùng cookie.
 */
export const CORS_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'Authorization,Content-Type',
  'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
});

type HttpResult = { statusCode: number; headers?: Record<string, string | number | boolean>; body?: string };

/** Bọc handler để mọi phản hồi (kể cả lỗi) có header CORS; header handler tự đặt được giữ nguyên. */
export function withCors<A extends unknown[], R extends HttpResult>(
  handler: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args: A): Promise<R> => {
    const res = await handler(...args);
    if (!res || typeof res !== 'object') return res;
    const present = new Set(Object.keys(res.headers ?? {}).map((k) => k.toLowerCase()));
    const missing = Object.fromEntries(Object.entries(CORS_HEADERS).filter(([k]) => !present.has(k)));
    return { ...res, headers: { ...missing, ...(res.headers ?? {}) } };
  };
}
