// Bọc AWS CLI. Dùng CLI thay vì SDK để không thêm phụ thuộc và dùng đúng credentials của nhóm.
// AWS_BIN cho phép thay bằng bản giả khi kiểm thử script.
import '../lib/env';
import { spawnSync } from 'node:child_process';

export const argv = process.argv.slice(2);
export const flag = (name: string): boolean => argv.includes(`--${name}`);
export const arg = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

export interface AwsOpts { readonly?: boolean; allowFail?: boolean; raw?: boolean }

/** readonly=true: chạy thật kể cả khi --dry-run. Lệnh ghi chỉ được in ra khi --dry-run. */
export function aws(args: string[], o: AwsOpts = {}): any {
  const bin = process.env.AWS_BIN ?? 'aws';
  const full = o.raw ? args : [...args, '--output', 'json'];
  if (flag('dry-run') && !o.readonly) {
    // Che mật khẩu khi in lệnh
    const shown = full.map((a, i) => (full[i - 1] === '--password' ? '***' : a));
    console.log(`[dry-run] ${bin} ${shown.join(' ')}`);
    return {};
  }
  // Cho phép dùng shim JavaScript portable trong test offline, kể cả Windows.
  const isJsShim = /\.(?:mjs|js)$/iu.test(bin);
  const command = isJsShim ? process.execPath : bin;
  const commandArgs = isJsShim ? [bin, ...full] : full;
  const r = spawnSync(command, commandArgs, { encoding: 'utf8' });
  if (r.status !== 0) {
    if (o.allowFail) return { __error: (r.stderr || r.stdout || '').trim() };
    throw new Error(`aws ${args.slice(0, 3).join(' ')} lỗi: ${(r.stderr || r.stdout || '').trim().slice(0, 400)}`);
  }
  const out = r.stdout.trim();
  if (!out) return {};
  try { return JSON.parse(out); } catch { return { __text: out }; }
}

export function git(args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout || '').trim() };
}

export const STACKS = ['data', 'identity', 'api', 'edge', 'workflow', 'console', 'ops'] as const;
export const stackName = (stage: string, name: string) => `${process.env.TM_STACK_PREFIX ?? 'translateme'}-${stage}-${name}`;

/** Stack templates là các entry point độc lập, không phải module template trong infra/modules/. */
export const stackTemplate = (directory: string, name: typeof STACKS[number]) =>
  process.env[`TM_TEMPLATE_${name.toUpperCase()}`] ?? `${directory}/${name}.yaml`;
