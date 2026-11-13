import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chooseSafeRunId, isSafeRunId } from '../lib/evidenceRunId';

type Evidence = { at: string; scenario: number; id: string; title: string; status: 'pass' | 'fail' | 'skip'; data?: unknown };
const expected: Record<number, string[]> = {
  4: [...Array.from({ length: 8 }, (_, i) => `P${i + 1}`), ...Array.from({ length: 8 }, (_, i) => `X${i + 1}`), ...Array.from({ length: 4 }, (_, i) => `E${i + 1}`)],
  5: ['L1', 'L2', 'L3', 'L4', 'L5'],
  6: [...Array.from({ length: 8 }, (_, i) => `S${i + 1}`), 'S8H', 'S9'],
};
const labels: Record<number, string> = { 4: 'Cô lập tenant và Platform Admin', 5: 'Giới hạn và khóa tenant', 6: 'Chặn SSRF' };
const args = process.argv.slice(2);
const runArg = args.find((a) => !a.startsWith('--'));
const allowIncomplete = args.includes('--allow-incomplete');
const requiredScenarios = new Set((process.env.TM_EVIDENCE_REQUIRED_SCENARIOS ?? '4,5,6').split(',').map(Number).filter(Number.isInteger));
const evidenceRoot = resolve(__dirname, '..', 'evidence');

function chooseRunId(): string {
  if (runArg) return chooseSafeRunId(runArg, undefined, process.env.TM_RUN_ID);
  if (!existsSync(evidenceRoot)) return chooseSafeRunId(undefined, undefined, process.env.TM_RUN_ID);
  const dirs = readdirSync(evidenceRoot).filter((name) => isSafeRunId(name) && statSync(join(evidenceRoot, name)).isDirectory());
  dirs.sort((a, b) => statSync(join(evidenceRoot, b)).mtimeMs - statSync(join(evidenceRoot, a)).mtimeMs);
  return chooseSafeRunId(undefined, dirs[0], process.env.TM_RUN_ID);
}

const runId = chooseRunId();
const runDir = join(evidenceRoot, runId);
mkdirSync(runDir, { recursive: true });
const latest = new Map<string, Evidence>();
const files = readdirSync(runDir).filter((f) => /^scenario-\d+\.jsonl$/.test(f)).sort();
for (const file of files) {
  const path = join(runDir, file);
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    let row: Evidence;
    try { row = JSON.parse(lines[i]); } catch { throw new Error(`${path}:${i + 1}: JSON không hợp lệ`); }
    if (!Number.isInteger(row.scenario) || !row.id || !['pass', 'fail', 'skip'].includes(row.status)) {
      throw new Error(`${path}:${i + 1}: bản ghi evidence thiếu scenario/id/status hợp lệ`);
    }
    const timestamp = typeof row.at === 'string' && row.at.trim() ? Date.parse(row.at) : Number.NaN;
    if (!Number.isFinite(timestamp)) {
      throw new Error(`${path}:${i + 1}: timestamp evidence thiếu hoặc không hợp lệ`);
    }
    const key = `${row.scenario}:${row.id}`;
    const prior = latest.get(key);
    if (!prior || timestamp >= Date.parse(prior.at)) latest.set(key, row);
  }
}

const md = ['# Báo cáo bằng chứng E2E', '', `- Run ID: \`${runId}\``, `- Tạo lúc: ${new Date().toISOString()}`, `- Thư mục dữ liệu: \`e2e/evidence/${runId}/\``, ''];
let failed = false, incomplete = false;
for (const scenario of [4, 5, 6]) {
  const ids = expected[scenario];
  const rows = ids.map((id) => latest.get(`${scenario}:${id}`));
  const failures = rows.filter((r) => r?.status === 'fail').length;
  const passes = rows.filter((r) => r?.status === 'pass').length;
  const skips = rows.filter((r) => r?.status === 'skip').length;
  const missing = rows.filter((r) => !r).length;
  const status = failures ? 'KHÔNG ĐẠT' : passes === ids.length ? 'ĐẠT' : 'CHƯA ĐỦ BẰNG CHỨNG';
  if (failures) failed = true;
  if (status !== 'ĐẠT' && requiredScenarios.has(scenario)) incomplete = true;
  md.push(`## Kịch bản ${scenario}: ${labels[scenario]}`, '', `**${status}** — ${passes}/${ids.length} đạt, ${failures} lỗi, ${skips} bỏ qua, ${missing} thiếu.`, '', '| Mã | Kết quả | Tiêu đề | Chi tiết |', '|---|---|---|---|');
  for (let i = 0; i < ids.length; i++) {
    const row = rows[i];
    const result = row?.status === 'pass' ? 'ĐẠT' : row?.status === 'fail' ? 'LỖI' : row?.status === 'skip' ? 'BỎ QUA' : 'THIẾU';
    const detail = !row
      ? 'Chưa có bản ghi'
      : row.status === 'fail'
        ? 'Chi tiết lỗi đã được lược khỏi artifact.'
        : row.status === 'skip'
          ? 'Chi tiết bỏ qua được giữ ngoài artifact.'
          : 'Chi tiết phản hồi được giữ ngoài artifact.';
    md.push(`| ${ids[i]} | ${result} | ${(row?.title ?? '').replace(/\|/g, '\\|')} | ${detail} |`);
  }
  md.push('');
}
md.push('## Kết luận', '', failed ? 'Có phép thử thất bại; cần xử lý trước khi phát hành.' : incomplete ? `Bằng chứng chưa đầy đủ cho kịch bản bắt buộc (${[...requiredScenarios].join(', ')}). SKIP và phép thử thiếu không được tính là đạt.` : `Các kịch bản bắt buộc (${[...requiredScenarios].join(', ')}) đã có đủ bằng chứng đạt.`, '');
const output = md.join('\n');
writeFileSync(join(runDir, 'summary.md'), output, 'utf8');
console.log(output);
if (failed || (incomplete && !allowIncomplete)) process.exitCode = 1;
