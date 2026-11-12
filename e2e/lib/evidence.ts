// Ghi bằng chứng cho từng phép thử; báo cáo tổng hợp thuộc hạng mục 5.2.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type Status = 'pass' | 'fail' | 'skip';

export function record(scenario: number, id: string, title: string, status: Status, data: unknown = {}): void {
  const dir = join(__dirname, '..', 'evidence', process.env.TM_RUN_ID ?? 'local');
  mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({ at: new Date().toISOString(), scenario, id, title, status, data });
  appendFileSync(join(dir, `scenario-${scenario}.jsonl`), line + '\n');
}

/** Đánh dấu tiêu chí chưa chạy vì endpoint/tính năng chưa được tích hợp. */
export function skipCase(scenario: number, id: string, title: string, reason: string): string {
  record(scenario, id, title, 'skip', { reason });
  return reason;
}

/** Capability flags allow a mixed product/API deployment to skip only missing routes. */
export function skipUnlessFeature(scenario: number, id: string, title: string, flag: string, reason: string): string | false {
  if (process.env.TM_E2E_ASSUME_ALL_ROUTES === '1' || process.env[flag] === '1') return false;
  return skipCase(scenario, id, title, `${reason} (đặt ${flag}=1 sau khi tích hợp)`);
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
