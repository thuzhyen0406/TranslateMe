/**
 * workerEvents – sự kiện proxy (C2) gửi Lambda worker (C13) để dịch nốt trang dịch dở (B.10, 2.5 – TV2).
 *
 * Lời gọi bất đồng bộ (InvocationType = Event) có giới hạn kích thước tải trọng, nên:
 *  - danh sách câu vừa thì gửi kèm trong sự kiện (`sentences`);
 *  - nhiều thì chia thành nhiều sự kiện, mỗi sự kiện ≤ maxBytes;
 *  - vượt quá maxInlineEvents sự kiện và có kho S3 thì ghi danh sách câu ra S3, sự kiện chỉ mang `sentencesS3Key`;
 *  - một câu riêng lẻ đã làm sự kiện vượt maxBytes thì bắt buộc đi qua S3; không có kho S3 thì bỏ câu đó
 *    (báo trong `dropped`) để không sự kiện nào vượt giới hạn tải trọng.
 * Khoá S3 luôn nằm dưới tiền tố tenant/<tenantId>/worker/ để worker kiểm tra được tenant.
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
  put(key: string, body: string, tenantId?: string): Promise<void>;
  get(key: string, tenantId?: string): Promise<string>;
}

/** Giới hạn an toàn cho tải trọng lời gọi bất đồng bộ (thấp hơn giới hạn của Lambda). */
export const MAX_ASYNC_PAYLOAD_BYTES = 200_000;
export const MAX_INLINE_EVENTS = 4;
/** Mỗi tệp S3 chứa tối đa bấy nhiêu byte JSON câu */
export const MAX_S3_PAYLOAD_BYTES = 4_000_000;

export const workerKeyPrefix = (tenantId: string): string => `tenant/${tenantId}/worker/`;

const jsonBytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), 'utf8');

/**
 * Chia câu thành nhóm, mỗi nhóm (kèm phần đầu sự kiện) ≤ maxBytes.
 * Câu mà riêng nó đã vượt maxBytes: keepOversize = true thì thành một nhóm riêng (tệp S3 không giới hạn cứng),
 * ngược lại đưa vào `oversize` để nơi gọi xử lý.
 */
function splitBySize(
  base: Omit<WorkerEvent, 'sentences'>,
  sentences: readonly SentenceWithHash[],
  maxBytes: number,
  keepOversize: boolean,
): { groups: SentenceWithHash[][]; oversize: SentenceWithHash[] } {
  const overhead = jsonBytes({ ...base, sentences: [] });
  const groups: SentenceWithHash[][] = [];
  const oversize: SentenceWithHash[] = [];
  let cur: SentenceWithHash[] = [];
  let bytes = overhead;
  for (const s of sentences) {
    const b = jsonBytes(s) + 1;
    if (overhead + b > maxBytes) {
      if (keepOversize) groups.push([s]);
      else oversize.push(s);
      continue;
    }
    if (cur.length && bytes + b > maxBytes) {
      groups.push(cur);
      cur = [];
      bytes = overhead;
    }
    cur.push(s);
    bytes += b;
  }
  if (cur.length) groups.push(cur);
  return { groups, oversize };
}

export interface BuildWorkerEventsOptions {
  maxBytes?: number;
  maxInlineEvents?: number;
  store?: PayloadStore;
  /** Tạo phần duy nhất của khoá S3 (mặc định thời gian + số ngẫu nhiên) */
  uniqueId?: () => string;
}

export interface WorkerEventsPlan {
  events: WorkerEvent[];
  /** Câu không gửi được: riêng câu đó đã vượt giới hạn tải trọng và không có kho S3 */
  dropped: SentenceWithHash[];
}

export async function buildWorkerEvents(
  base: Omit<WorkerEvent, 'sentences' | 'sentencesS3Key'>,
  sentences: readonly SentenceWithHash[],
  opts: BuildWorkerEventsOptions = {},
): Promise<WorkerEventsPlan> {
  if (!sentences.length) return { events: [], dropped: [] };
  const maxBytes = opts.maxBytes ?? MAX_ASYNC_PAYLOAD_BYTES;
  const inline = splitBySize(base, sentences, maxBytes, false);
  const needS3 = inline.oversize.length > 0 || inline.groups.length > (opts.maxInlineEvents ?? MAX_INLINE_EVENTS);
  if (!needS3 || !opts.store) {
    return { events: inline.groups.map((group) => ({ ...base, sentences: group })), dropped: inline.oversize };
  }
  const uid = opts.uniqueId ?? (() => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  const id = uid();
  const files = splitBySize(base, sentences, MAX_S3_PAYLOAD_BYTES, true).groups;
  const events: WorkerEvent[] = [];
  for (let i = 0; i < files.length; i++) {
    const key = `${workerKeyPrefix(base.tenantId)}${id}-${i}.json`;
    await opts.store.put(key, JSON.stringify(files[i]), base.tenantId);
    events.push({ ...base, sentencesS3Key: key });
  }
  return { events, dropped: [] };
}
