// Trạng thái dữ liệu demo do demo/seed.ts ghi, các test đọc lại.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface TenantState {
  label: 'A' | 'B' | 'C';
  username: string;
  password: string;
  tenantId: string;
  slug: string;
  origin: string;
  apiKey: string;
  keyId: string;
  /** Chỉ tenant C: key đã chuyển sang usage plan rất nhỏ để thử REQUEST_QUOTA_EXCEEDED */
  tinyApiKey?: string;
  tinyKeyId?: string;
  jobId: string;
  fileKey: string;
  tmText: string;
  tmHash: string;
}
export interface State {
  stage: string;
  createdAt: string;
  platform: { username: string; password: string };
  /** Usage plan rất nhỏ (quota 3 yêu cầu/ngày) dùng cho phép thử REQUEST_QUOTA_EXCEEDED */
  tinyPlanId?: string;
  tenants: Record<'A' | 'B' | 'C', TenantState>;
}

export const stateFile = (stage: string) => join(__dirname, '..', '.state', `${stage}.json`);

export function loadState(stage: string): State {
  const f = stateFile(stage);
  if (!existsSync(f)) throw new Error(`Chưa có ${f}. Chạy "npm run demo:seed" trước.`);
  return JSON.parse(readFileSync(f, 'utf8')) as State;
}
export function saveState(s: State): void {
  const f = stateFile(s.stage);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(s, null, 2));
}
