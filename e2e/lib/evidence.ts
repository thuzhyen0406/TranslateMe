// Ghi bằng chứng cho từng phép thử để tools/aggregate-evidence.ts tổng hợp vào báo cáo (5.2, 5.9).
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type Status = 'pass' | 'fail' | 'skip';

export function record(scenario: number, id: string, title: string, status: Status, data: unknown = {}): void {
  const dir = join(__dirname, '..', 'evidence', process.env.TM_RUN_ID ?? 'local');
  mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({ at: new Date().toISOString(), scenario, id, title, status, data });
  appendFileSync(join(dir, `scenario-${scenario}.jsonl`), line + '\n');
}

/** Bọc thân phép thử: ghi pass/fail kèm các giá trị quan sát được, rồi ném lại lỗi nếu có */
export const ev =
  (scenario: number, id: string, title: string, fn: (note: (k: string, v: unknown) => void) => Promise<void>) =>
  async (): Promise<void> => {
    const data: Record<string, unknown> = {};
    try {
      await fn((k, v) => { data[k] = v; });
      record(scenario, id, title, 'pass', data);
    } catch (e) {
      record(scenario, id, title, 'fail', { ...data, error: (e as Error).message });
      throw e;
    }
  };
