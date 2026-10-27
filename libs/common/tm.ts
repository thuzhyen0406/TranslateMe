/**
 * tm – Translation Memory F3 (Nhiệm vụ 2.4 – TV2). Đúng hợp đồng B.8 (Phần B, phiên bản 1.1).
 * Dùng chung cho F2 (proxy), F9 (realtime), F10 (batch) và worker C13.
 *
 * Bản ghi TM (Bảng 2.5):
 *   PK  = TENANT#<t>#TM#<srcLang>#<tgtLang>      SK = HASH#<sha256 của câu đã chuẩn hoá>
 *   src           câu nguồn (dạng marker {n}…{/n})
 *   tgt           bản dịch đang dùng (MACHINE hoặc HUMAN)
 *   label         'MACHINE' | 'HUMAN'
 *   needsReview   cờ "Cần xem lại" (ví dụ dịch lại không kèm thẻ nội tuyến)
 *   glossaryVersion  phiên bản thuật ngữ lúc dịch máy
 *   machineTgt    bản máy dịch gần nhất (F5 dùng khi "Khôi phục bản máy dịch")
 *   version       tăng 1 mỗi lần ghi (khoá lạc quan của F5)
 *   updatedAt, updatedBy
 *   GSI3PK = TENANT#<t>#TM#<label>, GSI3SK = updatedAt   (màn Duyệt lọc theo nhãn)
 *
 * Quy tắc:
 *  - getTM: BatchGetItem theo lô 100 khoá; db.batchGet tự lặp UnprocessedKeys.
 *    HUMAN dùng ngay (needsReview tính khi đọc). MACHINE chỉ dùng khi chưa lỗi thời theo thuật ngữ.
 *  - putMachineTM: ghi có điều kiện attribute_not_exists(label) OR label = :machine
 *    -> bản HUMAN không bao giờ bị MACHINE ghi đè, kể cả khi ghi đồng thời.
 *    Dùng UpdateItem (thay vì PutItem như kế hoạch) để tăng `version` nguyên tử mà vẫn giữ điều kiện trên.
 *  - Hash do nơi gọi tính bằng thư viện 1.8 (hashSentence) – module này không tự băm.
 */
import { BatchGetCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { stripMarkers } from './markers.js';
import type { Ctx, Lang, Sha256Hex } from './types.js';

export type Label = 'MACHINE' | 'HUMAN';

/** B.2 */
export interface Sentence {
  id: number;
  text: string;
}
export interface SentenceWithHash extends Sentence {
  hash: Sha256Hex;
}

/** B.7 (TV4 cung cấp getGlossaryState; tuần này dùng stub EMPTY_GLOSSARY_STATE) */
export interface GlossaryState {
  version: number;
  terminologyName: string | null;
  terms: { normalized: string; type: 'KEEP' | 'FIXED'; sinceVersion: number }[];
}

/** Stub theo B.14 cho tới khi 2.8 xong */
export const EMPTY_GLOSSARY_STATE: GlossaryState = Object.freeze({ version: 1, terminologyName: null, terms: [] });

/** B.8 */
export interface TmHit {
  tgt: string;
  label: Label;
  glossaryVersion: number;
  needsReview: boolean;
}

export interface TmEntry {
  hash: Sha256Hex;
  sourceText: string;
  tgt: string;
  glossaryVersion: number;
  /** Mở rộng B.8: true khi câu phải dịch lại không kèm thẻ nội tuyến (2.5) */
  needsReview?: boolean;
}

export interface TmKey {
  PK: string;
  SK: string;
}

export interface UpdateExpr {
  UpdateExpression: string;
  ConditionExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, unknown>;
}

/** Phần của lớp truy cập dữ liệu 2.2 (B.5) mà TM dùng. db.batchGet phải tự lặp UnprocessedKeys. */
export interface TmDb {
  batchGet(ctx: Ctx, keys: TmKey[]): Promise<Record<string, unknown>[]>;
  update(ctx: Ctx, key: TmKey, expr: UpdateExpr): Promise<unknown>;
}

export const TM_BATCH_SIZE = 100;

/** Khoá TM theo B.3. Đề nghị TV1 đưa vào `keys.tm` của types.ts. */
export function tmKey(ctx: Ctx, src: Lang, tgt: Lang, hash: Sha256Hex): TmKey {
  return { PK: `TENANT#${ctx.tenantId}#TM#${src}#${tgt}`, SK: `HASH#${hash}` };
}

const normForMatch = (s: string): string => s.normalize('NFC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('vi');

/**
 * Quy tắc lỗi thời (B.7): câu nguồn chứa một thuật ngữ có sinceVersion > glossaryVersion của bản dịch.
 * Bản mặc định khớp chuỗi con không phân biệt hoa thường trên văn bản đã bỏ marker.
 * Khi TV4 có isStale (2.8) thì truyền vào TmDeps.isStale.
 */
export function isStaleDefault(sourceText: string, entryGlossaryVersion: number, g: GlossaryState): boolean {
  if (!g.terms.length) return false;
  const text = normForMatch(stripMarkers(sourceText));
  return g.terms.some((t) => t.sinceVersion > entryGlossaryVersion && t.normalized && text.includes(normForMatch(t.normalized)));
}

export interface TmDeps {
  db: TmDb;
  isStale?: (sourceText: string, entryGlossaryVersion: number, g: GlossaryState) => boolean;
  /** ISO-8601 UTC */
  now?: () => string;
  /** Ghi vào updatedBy, ví dụ "proxy", "realtime", "worker" */
  writer?: string;
  /** Số lời gọi UpdateItem song song khi ghi */
  concurrency?: number;
}

export interface PutMachineTmReport {
  written: number;
  /** Đã có bản HUMAN nên không ghi (điều kiện chặn) */
  skippedHuman: number;
  /** Lỗi khác (throttling…), không làm hỏng trang – nơi gọi ghi log */
  failed: { hash: Sha256Hex; error: string }[];
}

const errName = (e: unknown): string =>
  e && typeof e === 'object' && 'name' in e && typeof (e as { name: unknown }).name === 'string' ? (e as { name: string }).name : 'UnknownError';

async function runPool<T>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
      while (next < items.length) await worker(items[next++]);
    }),
  );
}

export function createTM(deps: TmDeps) {
  const isStale = deps.isStale ?? isStaleDefault;
  const now = deps.now ?? (() => new Date().toISOString());
  const writer = deps.writer ?? 'machine';

  /** B.8: tra TM. Câu trùng hash chỉ tra một lần; câu MACHINE lỗi thời nằm trong misses. */
  async function getTM(
    ctx: Ctx,
    src: Lang,
    tgt: Lang,
    items: readonly SentenceWithHash[],
    g: GlossaryState,
  ): Promise<{ hits: Map<Sha256Hex, TmHit>; misses: SentenceWithHash[] }> {
    const byHash = new Map<Sha256Hex, SentenceWithHash>();
    for (const it of items) if (!byHash.has(it.hash)) byHash.set(it.hash, it);
    const hashes = [...byHash.keys()];

    const found = new Map<string, Record<string, unknown>>();
    for (let i = 0; i < hashes.length; i += TM_BATCH_SIZE) {
      const keys = hashes.slice(i, i + TM_BATCH_SIZE).map((h) => tmKey(ctx, src, tgt, h));
      for (const item of await deps.db.batchGet(ctx, keys)) {
        if (typeof item.SK === 'string') found.set(item.SK, item);
      }
    }

    const hits = new Map<Sha256Hex, TmHit>();
    for (const hash of hashes) {
      const item = found.get(`HASH#${hash}`);
      if (!item || typeof item.tgt !== 'string' || !item.tgt) continue;
      const label: Label = item.label === 'HUMAN' ? 'HUMAN' : 'MACHINE';
      const glossaryVersion = typeof item.glossaryVersion === 'number' ? item.glossaryVersion : 0;
      const sourceText = typeof item.src === 'string' ? item.src : byHash.get(hash)!.text;
      const stale = isStale(sourceText, glossaryVersion, g);
      if (label === 'MACHINE' && stale) continue; // lỗi thời -> dịch lại
      hits.set(hash, {
        tgt: item.tgt,
        label,
        glossaryVersion,
        // HUMAN gặp thuật ngữ mới đổi: giữ bản dịch nhưng hiện "Cần xem lại"
        needsReview: item.needsReview === true || (label === 'HUMAN' && stale),
      });
    }
    const misses = items.filter((it) => !hits.has(it.hash));
    return { hits, misses };
  }

  /** B.8: ghi bản MACHINE, không bao giờ đè HUMAN. Không throw vì lỗi từng câu – xem báo cáo trả về. */
  async function putMachineTM(ctx: Ctx, src: Lang, tgt: Lang, entries: readonly TmEntry[]): Promise<PutMachineTmReport> {
    const report: PutMachineTmReport = { written: 0, skippedHuman: 0, failed: [] };
    const unique = [...new Map(entries.filter((e) => e.tgt.trim() !== '').map((e) => [e.hash, e])).values()];
    await runPool(unique, deps.concurrency ?? 8, async (e) => {
      const at = now();
      try {
        await deps.db.update(ctx, tmKey(ctx, src, tgt, e.hash), {
          UpdateExpression:
            'SET #src = :src, #tgt = :tgt, #label = :machine, #machineTgt = :tgt, #gv = :gv, #nr = :nr, ' +
            '#updatedAt = :at, #updatedBy = :by, #g3pk = :g3pk, #g3sk = :at ADD #version :one',
          ConditionExpression: 'attribute_not_exists(#label) OR #label = :machine',
          ExpressionAttributeNames: {
            '#src': 'src',
            '#tgt': 'tgt',
            '#label': 'label',
            '#machineTgt': 'machineTgt',
            '#gv': 'glossaryVersion',
            '#nr': 'needsReview',
            '#updatedAt': 'updatedAt',
            '#updatedBy': 'updatedBy',
            '#g3pk': 'GSI3PK',
            '#g3sk': 'GSI3SK',
            '#version': 'version',
          },
          ExpressionAttributeValues: {
            ':src': e.sourceText,
            ':tgt': e.tgt,
            ':machine': 'MACHINE',
            ':gv': e.glossaryVersion,
            ':nr': e.needsReview === true,
            ':at': at,
            ':by': writer,
            ':g3pk': `TENANT#${ctx.tenantId}#TM#${e.needsReview ? 'REVIEW' : 'MACHINE'}`,
            ':one': 1,
          },
        });
        report.written++;
      } catch (err) {
        if (errName(err) === 'ConditionalCheckFailedException') report.skippedHuman++;
        else report.failed.push({ hash: e.hash, error: errName(err) });
      }
    });
    return report;
  }

  return { getTM, putMachineTM };
}

// ============================================================================
// Bản db cho TM đọc ghi trực tiếp bảng DynamoDB (stub B.14 của 2.2, cùng chữ ký db.batchGet/db.update).
// Khi lớp 2.2 của TV1 có batchGet/update kiểm tra theo tiền tố thì thay bằng `db` của libs/common/db.ts.
// ============================================================================

/** Khoá phải thuộc tenant của ctx: PK = TENANT#<t> hoặc bắt đầu bằng TENANT#<t># (B.5). */
export function assertTenantKey(ctx: Ctx, key: TmKey): void {
  const base = `TENANT#${ctx.tenantId}`;
  if (!ctx.tenantId || ctx.tenantId === 'PLATFORM' || !(key.PK === base || key.PK.startsWith(`${base}#`))) {
    throw Object.assign(new Error(`Khoá ${key.PK} không thuộc tenant ${ctx.tenantId}`), { name: 'TenantKeyViolation', code: 'FORBIDDEN' });
  }
}

export interface DynamoTmDbOptions {
  maxAttempts?: number;
  /** Thời gian chờ (ms) trước lần thử lại thứ n (bắt đầu từ 1) */
  backoffMs?: (attempt: number) => number;
  sleep?: (ms: number) => Promise<void>;
}

export function createDynamoTmDb(doc: Pick<DynamoDBDocumentClient, 'send'>, tableName: string, opts: DynamoTmDbOptions = {}): TmDb {
  const maxAttempts = opts.maxAttempts ?? 6;
  const backoff = opts.backoffMs ?? ((n: number) => Math.min(1000, 25 * 2 ** n));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return {
    async batchGet(ctx, keys) {
      if (keys.length > TM_BATCH_SIZE) throw new Error(`BatchGetItem tối đa ${TM_BATCH_SIZE} khoá`);
      keys.forEach((k) => assertTenantKey(ctx, k));
      const out: Record<string, unknown>[] = [];
      let pending: TmKey[] = keys;
      for (let attempt = 1; pending.length; attempt++) {
        if (attempt > maxAttempts) throw Object.assign(new Error('UnprocessedKeys còn sót sau nhiều lần thử'), { name: 'UnprocessedKeysExhausted' });
        if (attempt > 1) await sleep(backoff(attempt - 1));
        const res = await doc.send(new BatchGetCommand({ RequestItems: { [tableName]: { Keys: pending } } }));
        out.push(...((res.Responses?.[tableName] ?? []) as Record<string, unknown>[]));
        pending = (res.UnprocessedKeys?.[tableName]?.Keys ?? []) as TmKey[];
      }
      return out;
    },
    async update(ctx, key, expr) {
      assertTenantKey(ctx, key);
      return doc.send(new UpdateCommand({ TableName: tableName, Key: key, ...expr }));
    },
  };
}
