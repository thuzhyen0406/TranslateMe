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
  const changed = [...id].map((ch) => {
    const pool = /[0-9]/.test(ch) ? '0123456789' : /[A-Z]/.test(ch) ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' : /[a-z]/.test(ch) ? 'abcdefghijklmnopqrstuvwxyz' : '';
    if (pool) {
      const alternatives = pool.replace(ch, '');
      return alternatives[randomInt(alternatives.length)];
    }
    return ch;
  }).join('');
  if (changed === id && id.length > 0) throw new Error('ID không có ký tự chữ/số để tạo lookalike cùng định dạng');
  return changed;
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
