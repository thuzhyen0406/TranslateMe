// Tự kiểm tra bộ test: chạy toàn bộ suite với (1) mock đúng quy ước, mong đợi không có lỗi,
// và (2) mock có lỗ hổng cố ý, mong đợi đúng phép thử tương ứng bị đỏ.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startMock } from '../mock/server';
import { saveState } from '../lib/state';

type Leak = 'jobs' | 'file_key' | 'body_tenant' | 'perm_msg' | 'lock_cache' | 'lock_api' | 'platform_tm' | 'ssrf';
const CASES: Array<{ leak: Leak | null; expectFail: string[] }> = [
  { leak: null, expectFail: [] },
  { leak: 'jobs', expectFail: ['X1'] },
  { leak: 'file_key', expectFail: ['X7'] },
  { leak: 'body_tenant', expectFail: ['X8'] },
  { leak: 'perm_msg', expectFail: ['X1', 'X2', 'X3', 'X4'] },
  { leak: 'platform_tm', expectFail: ['E3'] },
  { leak: 'lock_api', expectFail: ['L4'] },
  { leak: 'lock_cache', expectFail: ['L4'] },
  { leak: 'ssrf', expectFail: ['S1'] },
];

async function main() {
  let bad = 0;
  for (const cs of CASES) {
    const m = await startMock({ leaks: cs.leak ? [cs.leak] : [], lockDelayMs: 500, rate: 5 });
    const st = m.seed();
    st.stage = 'mock';
    saveState(st);
    const run = `selftest-${cs.leak ?? 'clean'}`;
    rmSync(join(__dirname, '..', 'evidence', run), { recursive: true, force: true });
    const env = {
      ...process.env,
      TM_STAGE: 'mock', TM_API_BASE: `http://127.0.0.1:${m.port}`, TM_PUBLIC_BASE: `http://127.0.0.1:${m.port}/site`,
      TM_COGNITO_ENDPOINT: `http://127.0.0.1:${m.port}/cognito`, TM_ALLOW_MUTATION: '1',
      TM_LOCK_DEADLINE_S: '4', TM_LOCK_MAX_S: '3', TM_POLL_MS: '300', TM_FLOOD_N: '30', TM_RUN_ID: run,
    };
    const out = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      // Phải dùng spawn bất đồng bộ: mock chạy trong tiến trình này, spawnSync sẽ chặn nó
      const child = spawn(process.execPath, [
        '--require', require.resolve('ts-node/register/transpile-only'),
        '--test', '--test-concurrency=1', '--test-reporter=tap',
        'tests/isolation.test.ts', 'tests/ssrf.test.ts', 'tests/limits.test.ts',
      ], { cwd: join(__dirname, '..'), env });
      let stdout = '', stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
      child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    });
    await m.close();
    const failed = new Set<string>();
    for (const line of out.stdout.split('\n')) {
      const mm = line.match(/^\s*not ok \d+ - ([A-Z]\d)\b/);
      if (mm) failed.add(mm[1]);
    }
    const missing = cs.expectFail.filter((x) => !failed.has(x));
    const unexpected = [...failed].filter((x) => !cs.expectFail.includes(x));
    const ok = !missing.length && !unexpected.length && (cs.expectFail.length > 0 || out.status === 0);
    if (!ok) bad++;
    console.log(`${ok ? 'OK  ' : 'FAIL'} mock=${cs.leak ?? 'đúng quy ước'} | đỏ: [${[...failed].join(', ')}] | mong đợi đỏ: [${cs.expectFail.join(', ')}]` +
      (missing.length ? ` | thiếu: ${missing}` : '') + (unexpected.length ? ` | ngoài ý muốn: ${unexpected}` : ''));
    if (!ok && process.env.VERBOSE) console.log(out.stdout, out.stderr);
  }
  rmSync(join(__dirname, '..', '.state', 'mock.json'), { force: true });
  if (bad) { console.error(`${bad} tổ hợp sai`); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
