/**
 * workerEvents – sự kiện proxy (C2) gửi Lambda worker (C13) để dịch nốt trang dịch dở (B.10, 2.5 – TV2).
 *
 * Lời gọi bất đồng bộ (InvocationType = Event) có giới hạn kích thước tải trọng, nên:
 *  - danh sách câu vừa thì gửi kèm trong sự kiện (`sentences`);
 *  - nhiều thì chia thành nhiều sự kiện, mỗi sự kiện ≤ maxBytes;
 *  - vượt quá maxInlineEvents sự kiện và có kho S3 thì ghi danh sách câu ra S3, sự kiện chỉ mang `sentencesS3Key`.
 * Khoá S3 luôn nằm dưới tiền tố worker/<tenantId>/ để worker kiểm tra được tenant.
 */
import type { SentenceWithHash } from '../../libs/common/tm.js';
import type { Lang } from '../../libs/common/types.js';

export interface WorkerEvent {
  type: 'FINISH_PAGE';
  /** do proxy đã xác thực qua slug; worker kiểm tra lại */
  tenantId: string;
  slug: string;
  src: Lang;
  tgt: Lang;
  path: string;
  glossaryVersion: number;
  terminologyName: string | null;
  sentences?: SentenceWithHash[];
  sentencesS3Key?: string;
  requestId?: string;
}

export interface PayloadStore {
  put(key: string, body: string): Promise<void>;
  get(key: string): Promise<string>;
}

/** Giới hạn an toàn cho tải trọng lời gọi bất đồng bộ (thấp hơn giới hạn của Lambda). */
export const MAX_ASYNC_PAYLOAD_BYTES = 200_000;
export const MAX_INLINE_EVENTS = 4;
/** Mỗi tệp S3 chứa tối đa bấy nhiêu byte JSON câu */
export const MAX_S3_PAYLOAD_BYTES = 4_000_000;

export const workerKeyPrefix = (tenantId: string): string => `worker/${tenantId}/`;

const jsonBytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), 'utf8');

function splitBySize(base: Omit<WorkerEvent, 'sentences'>, sentences: readonly SentenceWithHash[], maxBytes: number): SentenceWithHash[][] {
  const overhead = jsonBytes({ ...base, sentences: [] });
  const groups: SentenceWithHash[][] = [];
  let cur: SentenceWithHash[] = [];
  let bytes = overhead;
  for (const s of sentences) {
    const b = jsonBytes(s) + 1;
    if (cur.length && bytes + b > maxBytes) {
      groups.push(cur);
      cur = [];
      bytes = overhead;
    }
    cur.push(s);
    bytes += b;
  }
  if (cur.length) groups.push(cur);
  return groups;
}

export interface BuildWorkerEventsOptions {
  maxBytes?: number;
  maxInlineEvents?: number;
  store?: PayloadStore;
  /** Tạo phần duy nhất của khoá S3 (mặc định thời gian + số ngẫu nhiên) */
  uniqueId?: () => string;
}

export async function buildWorkerEvents(
  base: Omit<WorkerEvent, 'sentences' | 'sentencesS3Key'>,
  sentences: readonly SentenceWithHash[],
  opts: BuildWorkerEventsOptions = {},
): Promise<WorkerEvent[]> {
  if (!sentences.length) return [];
  const maxBytes = opts.maxBytes ?? MAX_ASYNC_PAYLOAD_BYTES;
  const inline = splitBySize(base, sentences, maxBytes);
  if (inline.length <= (opts.maxInlineEvents ?? MAX_INLINE_EVENTS) || !opts.store) {
    return inline.map((group) => ({ ...base, sentences: group }));
  }
  const uid = opts.uniqueId ?? (() => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  const id = uid();
  const files = splitBySize(base, sentences, MAX_S3_PAYLOAD_BYTES);
  const events: WorkerEvent[] = [];
  for (let i = 0; i < files.length; i++) {
    const key = `${workerKeyPrefix(base.tenantId)}${id}-${i}.json`;
    await opts.store.put(key, JSON.stringify(files[i]));
    events.push({ ...base, sentencesS3Key: key });
  }
  return events;
}
