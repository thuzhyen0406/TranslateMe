import type { AuthenticatedSession } from '../types/auth.js';
import { IS_DEMO_AUTH_MODE } from './cognitoAuth.js';
import type { BatchNotificationStatus } from './batchJobStatus.js';

const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
const baseUrl = (env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');
export type KeyPlan = 'Basic' | 'Standard';
export interface ApiKeyRow { key_id: string; name: string; plan: KeyPlan; status: 'ACTIVE' | 'REVOKED'; last4: string; created_at: string; rotated_from?: string }
export interface ApiKeySecret extends ApiKeyRow { value: string }
export interface BatchJob { job_id: string; status: string; total: number; done: number; failed: number; progress: number; target_langs: string[]; send_email?: boolean; notification_status?: BatchNotificationStatus; notification_error?: string; reason?: string; downloads?: Record<string, string> }
export interface TranslateResult { translated_text: string; source_lang: string; source_lang_detected: boolean; detection_confidence?: number; target_lang: string; characters_machine_translated: number; characters_from_memory: number; terminology_version: number }

const mockKeyRows = new Map<string, ApiKeyRow[]>();
const mockJobs = new Map<string, { file: File; job: BatchJob; createdAt: number }>();
const jsonHeaders = (session: AuthenticatedSession) => ({ Authorization: `Bearer ${session.idToken}`, 'Content-Type': 'application/json' });

class ApiRequestError extends Error {
  constructor(readonly status: number, readonly code: string | undefined, message: string) {
    super(message);
  }
}

async function request<T>(session: AuthenticatedSession, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers: { ...jsonHeaders(session), ...init.headers } });
  if (!response.ok) {
    const data = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
    throw new ApiRequestError(response.status, data?.error?.code, data?.error?.message ?? `Yêu cầu thất bại (${response.status}).`);
  }
  return await response.json() as T;
}

export async function listKeys(session: AuthenticatedSession): Promise<ApiKeyRow[]> {
  if (IS_DEMO_AUTH_MODE) return (mockKeyRows.get(session.tenantId) ?? []).map((row) => ({ ...row }));
  return (await request<{ api_keys: ApiKeyRow[] }>(session, '/console/api-keys')).api_keys;
}
export async function createKey(session: AuthenticatedSession, name: string, plan: KeyPlan): Promise<ApiKeySecret> {
  if (IS_DEMO_AUTH_MODE) {
    const value = `tm_live_${crypto.randomUUID().replaceAll('-', '')}`;
    const row: ApiKeyRow = { key_id: crypto.randomUUID(), name, plan, status: 'ACTIVE', last4: value.slice(-4), created_at: new Date().toISOString() };
    mockKeyRows.set(session.tenantId, [row, ...(mockKeyRows.get(session.tenantId) ?? [])]); return { ...row, value };
  }
  return (await request<{ api_key: ApiKeySecret }>(session, '/console/api-keys', { method: 'POST', body: JSON.stringify({ name, plan }) })).api_key;
}
export async function rotateKey(session: AuthenticatedSession, row: ApiKeyRow): Promise<ApiKeySecret> {
  if (IS_DEMO_AUTH_MODE) {
    const value = `tm_live_${crypto.randomUUID().replaceAll('-', '')}`;
    const rotated: ApiKeyRow = { ...row, key_id: crypto.randomUUID(), last4: value.slice(-4), created_at: new Date().toISOString(), rotated_from: row.key_id };
    mockKeyRows.set(session.tenantId, [rotated, ...(mockKeyRows.get(session.tenantId) ?? [])]); return { ...rotated, value };
  }
  return (await request<{ api_key: ApiKeySecret }>(session, `/console/api-keys/${encodeURIComponent(row.key_id)}/rotate`, { method: 'POST' })).api_key;
}
export async function revokeKey(session: AuthenticatedSession, row: ApiKeyRow): Promise<void> {
  if (IS_DEMO_AUTH_MODE) { mockKeyRows.set(session.tenantId, (mockKeyRows.get(session.tenantId) ?? []).map((key) => key.key_id === row.key_id ? { ...key, status: 'REVOKED' } : key)); return; }
  await request(session, `/console/api-keys/${encodeURIComponent(row.key_id)}/revoke`, { method: 'POST' });
}
export async function changeKeyPlan(session: AuthenticatedSession, row: ApiKeyRow, plan: KeyPlan): Promise<void> {
  if (IS_DEMO_AUTH_MODE) { mockKeyRows.set(session.tenantId, (mockKeyRows.get(session.tenantId) ?? []).map((key) => key.key_id === row.key_id ? { ...key, plan } : key)); return; }
  await request(session, `/console/api-keys/${encodeURIComponent(row.key_id)}`, { method: 'PATCH', body: JSON.stringify({ plan }) });
}

export async function translateText(session: AuthenticatedSession, input: { text: string; source_lang?: string; target_lang: string; use_terminology: boolean }): Promise<TranslateResult> {
  if (!IS_DEMO_AUTH_MODE) return request<TranslateResult>(session, '/translate/session/realtime', { method: 'POST', body: JSON.stringify(input) });
  const lines = input.text.split(/(?<=[.!?。！？])\s+/u);
  const translated = lines.map((line) => {
    const phrase: Record<string, string> = { 'Xin chào.': 'Hello.', 'Cảm ơn bạn.': 'Thank you.', 'Chào mừng bạn đến với homestay của chúng tôi.': 'Welcome to our homestay.' };
    return phrase[line] ?? (input.target_lang === 'en' ? `[EN] ${line}` : `[${input.target_lang.toUpperCase()}] ${line}`);
  }).join(' ');
  return { translated_text: translated, source_lang: input.source_lang ?? 'vi', source_lang_detected: !input.source_lang, ...(input.source_lang ? {} : { detection_confidence: 0.99 }), target_lang: input.target_lang, characters_machine_translated: Array.from(input.text).length, characters_from_memory: 0, terminology_version: 0 };
}

export async function submitBatch(session: AuthenticatedSession, file: File, sourceLang: string, targetLangs: string[], sendEmail: boolean): Promise<BatchJob> {
  if (IS_DEMO_AUTH_MODE) {
    const jobId = `job-${new Date().toISOString().slice(0,10).replaceAll('-', '')}-${crypto.randomUUID().replaceAll('-', '').slice(0,12)}`;
    const job: BatchJob = { job_id: jobId, status: 'RUNNING', total: Math.max(1, Math.ceil(file.size / 2000)), done: 0, failed: 0, progress: 0, target_langs: targetLangs, send_email: sendEmail };
    mockJobs.set(jobId, { file, job, createdAt: Date.now() }); return job;
  }
  return submitLiveBatch(session, file, sourceLang, targetLangs, sendEmail);
}

const pendingUploads = new WeakMap<File, { submission: string; fileKey: string }>();

export async function submitLiveBatch(
  session: AuthenticatedSession,
  file: File,
  sourceLang: string,
  targetLangs: string[],
  sendEmail: boolean,
  pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
): Promise<BatchJob> {
  const submission = JSON.stringify([session.tenantId, session.sub, sourceLang, targetLangs, sendEmail]);
  let pending = pendingUploads.get(file);
  if (pending?.submission !== submission) {
    const upload = await request<{ file_key: string; upload_url: string; required_headers: Record<string, string> }>(
      session, '/translate/batch/session/upload-url', { method: 'POST', body: JSON.stringify({ file_name: file.name, size_bytes: file.size }) },
    );
    const put = await fetch(upload.upload_url, { method: 'PUT', headers: upload.required_headers, body: file });
    if (!put.ok) throw new Error('Không thể tải tệp lên kho lưu trữ.');
    pending = { submission, fileKey: upload.file_key };
    pendingUploads.set(file, pending);
  }
  const clearPending = () => {
    if (pendingUploads.get(file) === pending) pendingUploads.delete(file);
  };
  const body = JSON.stringify({
    file_key: pending.fileKey, target_langs: targetLangs, ...(sourceLang ? { source_lang: sourceLang } : {}), send_email: sendEmail,
  });
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await request<{ job_id: string; status: string; estimated_characters: number }>(
        session, '/translate/batch/session', { method: 'POST', body },
      );
      clearPending();
      return { job_id: result.job_id, status: result.status, total: result.estimated_characters, done: 0, failed: 0, progress: 0, target_langs: targetLangs, send_email: sendEmail };
    } catch (error) {
      const unavailable = error instanceof ApiRequestError && error.status === 503;
      if (unavailable && attempt < 3) {
        await pause(500 * 2 ** attempt);
        continue;
      }
      if (error instanceof ApiRequestError && error.status < 500) clearPending();
      throw error;
    }
  }
}

export async function getBatchJob(session: AuthenticatedSession, id: string): Promise<BatchJob> {
  if (IS_DEMO_AUTH_MODE) {
    const item = mockJobs.get(id); if (!item) throw new Error('Không tìm thấy công việc.');
    if (Date.now() - item.createdAt > 1500) { item.job.status = 'SUCCEEDED'; item.job.done = item.job.total; item.job.progress = 100; if (item.job.send_email) item.job.notification_status = 'SUBMITTED'; item.job.downloads ??= Object.fromEntries(item.job.target_langs.map((lang) => [lang, URL.createObjectURL(new Blob([`Bản dịch demo của ${item.file.name}`], { type: 'text/plain' }))])); }
    return { ...item.job };
  }
  const job = (await request<{ job: BatchJob & { results?: Array<{ target_lang: string; download_url: string }> } }>(session, `/translate/batch/session/${encodeURIComponent(id)}`)).job;
  if (!job.downloads && Array.isArray(job.results)) {
    job.downloads = Object.fromEntries(job.results.map((r) => [r.target_lang, r.download_url]));
  }
  return job;
}
