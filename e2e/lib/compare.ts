import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { Resp, errCode } from './http';

export const shape = (r: Resp) => ({
  status: r.status,
  code: errCode(r) ?? null,
  message: r.body?.error?.message ?? null,
});

/** Tạo id không tồn tại nhưng cùng định dạng với id thật (cùng độ dài, cùng loại ký tự) */
export function lookalike(id: string): string {
  const hex = '0123456789abcdef';
  const up = 'ABCDEFGHJKMNPQRSTVWXYZ';
  const lo = 'abcdefghijklmnopqrstuvwxyz';
  return [...id].map((ch) => {
    if (/[0-9a-f]/.test(ch)) return hex[randomInt(16)];
    if (/[A-Z]/.test(ch)) return up[randomInt(up.length)];
    if (/[a-z]/.test(ch)) return lo[randomInt(lo.length)];
    return ch;
  }).join('');
}

/**
 * Phản hồi cho tài nguyên của tenant khác phải GIỐNG HỆT phản hồi cho tài nguyên không
 * tồn tại (QC-17): cùng status, cùng error.code, cùng message; và không lộ dữ liệu của B.
 */
export function assertDenied(
  actual: Resp,
  baseline: Resp,
  opts: { forbidden?: string[]; expectCode?: string | null } = {},
): void {
  const { forbidden = [], expectCode = 'NOT_FOUND' } = opts;
  assert.ok(actual.status >= 400 && actual.status < 500, `phải bị từ chối, nhận ${actual.status}`);
  assert.deepEqual(shape(actual), shape(baseline),
    'phản hồi phải giống hệt phản hồi cho tài nguyên không tồn tại');
  if (expectCode) assert.equal(errCode(actual), expectCode, `mã lỗi phải là ${expectCode}`);
  for (const f of forbidden) {
    if (f) assert.ok(!actual.text.includes(f), `phản hồi lộ dữ liệu của tenant khác (${f.slice(0, 8)}…)`);
  }
}
