/**
 * seg – chỉ mục câu–trang SEG (Nhiệm vụ 3.4 – TV2).
 * Ghi ở bước 7 của F2 (proxy, sau này cả worker ở chế độ trang của 4.5); đọc ở F5 để xóa cache chọn lọc (3.5).
 *
 * Bản ghi SEG (QC-5, Bảng 2.5):
 *   PK     = TENANT#<t>#SEG#<sha256>          SK     = PAGE#<lang>#<path>
 *   GSI2PK = TENANT#<t>#PAGE#<lang>#<path>    GSI2SK = HASH#<sha256>      (GSI2 chiếu KEYS_ONLY)
 *   ttl    = epoch giây, mặc định 30 ngày sau lần ghi gần nhất (lớn hơn thời gian lưu đệm tối đa của website)
 *
 *  - <sha256>: hash câu nguồn đã chuẩn hóa, cùng hash với khóa TM.
 *  - <lang>: ngôn ngữ đích của trang dịch.
 *  - <path>: đường dẫn đầy đủ GỒM SLUG, giữ nguyên dạng mã hóa %, không có query, ví dụ /homestay-abc/phong-nghi/.
 *    Bỏ slug thì hai website cùng tenant trùng khóa và F5 xóa cache sót trang (QC-5).
 *
 * Mỗi lần proxy dựng trang thì ghi lại toàn bộ câu của trang (PutRequest, ghi đè được) để làm mới TTL.
 * Câu đã bị gỡ khỏi trang còn bản ghi cũ tới khi hết TTL: F5 có thể xóa cache thừa một trang, không bao giờ sót.
 */
import { BatchWriteCommand, QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { assertTenantKey } from './tm.js';
import type { Ctx, Lang, Sha256Hex } from './types.js';

/** BatchWriteItem nhận tối đa 25 yêu cầu */
export const SEG_BATCH_SIZE = 25;
export const SEG_TTL_DAYS = 30;
export const SEG_GSI = 'GSI2';

export interface SegKey {
  PK: string;
  SK: string;
}

export interface SegItem extends SegKey {
  GSI2PK: string;
  GSI2SK: string;
  ttl: number;
}

// Cùng quy tắc với SLUG_RE / LANG_RE của proxy (services/proxy/sites.ts)
const SLUG_IN_PATH_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const LANG_IN_KEY_RE = /^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/;

/**
 * <path> của SEG từ slug và phần đường dẫn sau /{slug}/{lang}/ (ProxyPath.rest của proxy).
 * segPath('homestay-abc', 'phong-nghi/') = '/homestay-abc/phong-nghi/'; trang chủ: '/homestay-abc/'.
 */
export function segPath(slug: string, rest: string): string {
  if (!SLUG_IN_PATH_RE.test(slug)) throw new Error(`slug không hợp lệ cho SEG: ${slug}`);
  const r = rest.replace(/^\/+/, '');
  if (/[?#\s]/.test(r)) throw new Error('Đường dẫn SEG không được chứa query, # hoặc khoảng trắng');
  return `/${slug}/${r}`;
}

function checkLang(lang: Lang): void {
  if (!LANG_IN_KEY_RE.test(lang)) throw new Error(`Mã ngôn ngữ không hợp lệ cho SEG: ${lang}`);
}

function checkPath(path: string): void {
  if (!path.startsWith('/') || /[?#\s]/.test(path)) throw new Error(`Đường dẫn SEG không hợp lệ: ${path}`);
}

export function segKey(ctx: Ctx, hash: Sha256Hex, lang: Lang, path: string): SegKey {
  checkLang(lang);
  checkPath(path);
  return { PK: `TENANT#${ctx.tenantId}#SEG#${hash}`, SK: `PAGE#${lang}#${path}` };
}

/** Khóa phân vùng GSI2 của một trang: mọi câu của trang nằm dưới khóa này. */
export function pageGsiPk(ctx: Ctx, lang: Lang, path: string): string {
  checkLang(lang);
  checkPath(path);
  return `TENANT#${ctx.tenantId}#PAGE#${lang}#${path}`;
}

/** Phần lớp truy cập dữ liệu 2.2 (B.5) mà SEG cần. Mọi khóa phải thuộc tenant của ctx. */
export interface SegDb {
  /** Tối đa SEG_BATCH_SIZE bản ghi; tự thử lại UnprocessedItems, hết lượt thì ném lỗi */
  batchWrite(ctx: Ctx, items: SegItem[]): Promise<void>;
  /** Query bảng chính theo PK và tiền tố SK, tự lật trang */
  query(ctx: Ctx, pk: string, skPrefix: string): Promise<Record<string, unknown>[]>;
  /** Query GSI2 theo GSI2PK, tự lật trang */
  queryGsi2(ctx: Ctx, gsi2pk: string): Promise<Record<string, unknown>[]>;
}

export interface SegDeps {
  db: SegDb;
  /** mili giây, mặc định Date.now */
  now?: () => number;
  ttlDays?: number;
  /** Số lời gọi BatchWriteItem song song */
  concurrency?: number;
}

export interface WriteSegReport {
  /** Số bản ghi đã ghi (sau khi bỏ hash trùng) */
  written: number;
  /** Số bản ghi không ghi được (lô lỗi); nơi gọi quyết định cách xử lý */
  failed: number;
  errors: string[];
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

const hashFromSk = (sk: unknown, prefix: string): string | null => (typeof sk === 'string' && sk.startsWith(prefix) ? sk.slice(prefix.length) : null);

export function createSEG(deps: SegDeps) {
  const now = deps.now ?? Date.now;
  const ttlDays = deps.ttlDays ?? SEG_TTL_DAYS;

  /** F2 bước 7: ghi (hoặc làm mới) SEG cho mọi câu của một trang. Không ném lỗi theo lô – xem báo cáo. */
  async function writePageSegments(ctx: Ctx, lang: Lang, path: string, hashes: readonly Sha256Hex[]): Promise<WriteSegReport> {
    const gsi2pk = pageGsiPk(ctx, lang, path);
    const ttl = Math.floor(now() / 1000) + ttlDays * 86_400;
    const items: SegItem[] = [...new Set(hashes)].map((hash) => ({ ...segKey(ctx, hash, lang, path), GSI2PK: gsi2pk, GSI2SK: `HASH#${hash}`, ttl }));
    const batches: SegItem[][] = [];
    for (let i = 0; i < items.length; i += SEG_BATCH_SIZE) batches.push(items.slice(i, i + SEG_BATCH_SIZE));
    const report: WriteSegReport = { written: 0, failed: 0, errors: [] };
    await runPool(batches, deps.concurrency ?? 4, async (batch) => {
      try {
        await deps.db.batchWrite(ctx, batch);
        report.written += batch.length;
      } catch (err) {
        report.failed += batch.length;
        report.errors.push(errName(err));
      }
    });
    return report;
  }

  /** Các câu (hash) của một trang dịch, qua GSI2. */
  async function sentencesOfPage(ctx: Ctx, lang: Lang, path: string): Promise<Sha256Hex[]> {
    const rows = await deps.db.queryGsi2(ctx, pageGsiPk(ctx, lang, path));
    return rows.map((r) => hashFromSk(r.GSI2SK, 'HASH#')).filter((h): h is string => h !== null);
  }

  /** Các trang (path) ở ngôn ngữ đích `lang` có chứa câu `hash`. Dùng cho xóa cache chọn lọc (3.5). */
  async function pagesOfSentence(ctx: Ctx, hash: Sha256Hex, lang: Lang): Promise<string[]> {
    checkLang(lang);
    const prefix = `PAGE#${lang}#`;
    const rows = await deps.db.query(ctx, `TENANT#${ctx.tenantId}#SEG#${hash}`, prefix);
    return rows.map((r) => hashFromSk(r.SK, prefix)).filter((p): p is string => p !== null);
  }

  return { writePageSegments, sentencesOfPage, pagesOfSentence };
}

// ============================================================================
// Bản db cho SEG đọc ghi trực tiếp bảng DynamoDB (stub B.14 của 2.2, giống createDynamoTmDb).
// Khi lớp data của 2.2 (TV1) có batchWrite và query GSI thì thay bằng `db` của libs/common/db.ts (QC-3).
// ============================================================================

export interface DynamoSegDbOptions {
  maxAttempts?: number;
  backoffMs?: (attempt: number) => number;
  sleep?: (ms: number) => Promise<void>;
}

export function createDynamoSegDb(doc: Pick<DynamoDBDocumentClient, 'send'>, tableName: string, opts: DynamoSegDbOptions = {}): SegDb {
  const maxAttempts = opts.maxAttempts ?? 6;
  const backoff = opts.backoffMs ?? ((n: number) => Math.min(1000, 25 * 2 ** n));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  async function queryAll(input: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const res = await doc.send(new QueryCommand({ TableName: tableName, ...input, ...(start ? { ExclusiveStartKey: start } : {}) }));
      out.push(...((res.Items ?? []) as Record<string, unknown>[]));
      start = res.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (start);
    return out;
  }

  return {
    async batchWrite(ctx, items) {
      if (items.length > SEG_BATCH_SIZE) throw new Error(`BatchWriteItem tối đa ${SEG_BATCH_SIZE} bản ghi`);
      for (const it of items) {
        assertTenantKey(ctx, it);
        assertTenantKey(ctx, { PK: it.GSI2PK, SK: it.GSI2SK });
      }
      let pending: unknown[] = items.map((Item) => ({ PutRequest: { Item } }));
      for (let attempt = 1; pending.length; attempt++) {
        if (attempt > maxAttempts) throw Object.assign(new Error('UnprocessedItems còn sót sau nhiều lần thử'), { name: 'UnprocessedItemsExhausted' });
        if (attempt > 1) await sleep(backoff(attempt - 1));
        const res = await doc.send(new BatchWriteCommand({ RequestItems: { [tableName]: pending as never } }));
        pending = (res.UnprocessedItems?.[tableName] ?? []) as unknown[];
      }
    },
    async query(ctx, pk, skPrefix) {
      assertTenantKey(ctx, { PK: pk, SK: skPrefix });
      return queryAll({
        KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :sk)',
        ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK' },
        ExpressionAttributeValues: { ':pk': pk, ':sk': skPrefix },
      });
    },
    async queryGsi2(ctx, gsi2pk) {
      assertTenantKey(ctx, { PK: gsi2pk, SK: '' });
      return queryAll({
        IndexName: SEG_GSI,
        KeyConditionExpression: '#pk = :pk',
        ExpressionAttributeNames: { '#pk': 'GSI2PK' },
        ExpressionAttributeValues: { ':pk': gsi2pk },
      });
    },
  };
}
