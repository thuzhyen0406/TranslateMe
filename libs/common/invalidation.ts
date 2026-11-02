/**
 * invalidation – xóa cache CloudFront chọn lọc (F5, Nhiệm vụ 3.5 – TV2; mục 2.6.4, thông điệp M8).
 * C6 gọi sau khi đã ghi bản sửa vào TM (3.8 – Duyệt bản dịch). Chữ ký đã chốt với TV4:
 *
 *   invalidateForSentences(ctx, { src, tgt, hashes }): Promise<{ paths, mode: 'PATHS' | 'WILDCARD', invalidationId? }>
 *
 * Các bước:
 *  1. Với mỗi hash, tra SEG (pagesOfSentence) ra các trang ở ngôn ngữ đích `tgt`. TM dùng chung cho mọi website của
 *     tenant, nên tra trên mọi website của tenant (không lọc theo slug): một câu sửa ở TM đổi bản dịch ở mọi trang có câu đó.
 *  2. Đổi <path> của SEG (/<slug>/<phần còn lại>) sang đường dẫn CloudFront /<slug>/<tgt>/<phần còn lại>, loại trùng.
 *  3. Website nào có quá `wildcardThreshold` đường dẫn (mặc định 500) thì thay bằng một wildcard /<slug>/<tgt>/*,
 *     vẫn trong phạm vi một website và một ngôn ngữ.
 *  4. Gọi CreateInvalidation theo lô (mặc định 500 đường dẫn), CallerReference = t:<tenantId>:<uuid> (M8).
 *  5. Không ném lỗi khi tra SEG hay gọi CloudFront lỗi: bản sửa đã lưu (QC-8), kết quả trả `status` FAILED/PARTIAL để
 *     console hiện "Lỗi làm mới" và nút Thử lại. Thử lại = gọi lại invalidateForSentences với cùng hashes
 *     (đường dẫn luôn tính lại từ SEG phía máy chủ, không nhận danh sách đường dẫn từ client – QC-3).
 *
 * getInvalidationStatus(ctx, id): GetInvalidation và so CallerReference với tiền tố t:<tenantId>: của người gọi;
 * không khớp hoặc không tồn tại thì ném NOT_FOUND, nên tenant này không tra được lần xóa của tenant khác.
 *
 * invalidateForSites(ctx, { slugs }) (3.1/3.2 – khóa tenant, tạm dừng/bật lại website; QC-3 hiệu lực ≤ 60 s):
 *  - Xóa toàn bộ cache của từng website bằng wildcard /<slug>/* (mọi ngôn ngữ), CallerReference t:<tenantId>:<uuid>.
 *  - CloudFront chỉ cho 15 đường dẫn wildcard đang xử lý mỗi distribution, nên chia lô ≤ 15 wildcard.
 *  - Khác invalidateForSentences: lỗi CloudFront thì NÉM AppError CACHE_INVALIDATION_FAILED (503) để màn quản trị
 *    báo lỗi và người dùng bấm lại. Thao tác gọi nó (ghi trạng thái rồi xóa cache) lặp lại được nên thử lại an toàn.
 *  - Bản mặc định (hàm export invalidateForSites) tự dựng CloudFront từ CLOUDFRONT_DISTRIBUTION_ID. Thiếu biến này:
 *    chạy trong Lambda thì ném CACHE_INVALIDATION_FAILED (cấu hình thiếu không được im lặng bỏ qua), chạy local/test
 *    thì trả status NOT_CONFIGURED và ghi log cảnh báo.
 */
import { createSEG } from './seg.js';
import { AppError, type Ctx, type Lang, type Sha256Hex } from './types.js';

export const DEFAULT_WILDCARD_THRESHOLD = 500;
export const DEFAULT_INVALIDATION_BATCH_SIZE = 500;

export type InvalidationMode = 'PATHS' | 'WILDCARD';
/** Mở rộng chữ ký đã chốt: trạng thái gửi yêu cầu xóa cache */
export type InvalidationSubmitStatus = 'SUBMITTED' | 'NOTHING_TO_DO' | 'PARTIAL' | 'FAILED';

export interface InvalidateRequest {
  src: Lang;
  tgt: Lang;
  hashes: readonly Sha256Hex[];
}

export interface InvalidateResult {
  /** Đường dẫn CloudFront cần xóa (đã đổi wildcard nếu vượt ngưỡng). Rỗng = câu không còn trên trang nào. */
  paths: string[];
  /** WILDCARD nếu có ít nhất một website dùng /<slug>/<tgt>/* */
  mode: InvalidationMode;
  /** Id lần xóa đầu tiên (đủ cho trường hợp thường gặp: một lô) */
  invalidationId?: string;
  // ---- mở rộng (không phá chữ ký đã chốt) ----
  status: InvalidationSubmitStatus;
  /** Mọi id đã tạo, khi phải chia nhiều lô */
  invalidationIds: string[];
  /** Đường dẫn chưa gửi được (lô lỗi); thử lại bằng cách gọi lại với cùng hashes */
  failedPaths: string[];
  /** Tên lỗi đầu tiên (không chứa nội dung người dùng) */
  error?: string;
}

export type InvalidationProgress = 'IN_PROGRESS' | 'COMPLETED';

export interface InvalidationStatus {
  id: string;
  status: InvalidationProgress;
  paths: string[];
  createdAt?: string;
}

/** CloudFront: tối đa 15 đường dẫn wildcard đang xử lý trên mỗi distribution */
export const CLOUDFRONT_WILDCARD_LIMIT = 15;

export type SiteInvalidationStatus = 'SUBMITTED' | 'NOTHING_TO_DO' | 'NOT_CONFIGURED';

export interface SiteInvalidationResult {
  paths: string[];
  mode: 'WILDCARD';
  // ---- mở rộng (tùy chọn để không phá các bản giả sẵn có) ----
  status?: SiteInvalidationStatus;
  invalidationIds?: string[];
}

export interface SiteInvalidationRequest {
  slugs: readonly string[];
}

export type SiteInvalidator = (ctx: Ctx, req: SiteInvalidationRequest) => Promise<SiteInvalidationResult>;

/** Cổng tới CloudFront (C1). Bản thật: cloudFrontCdn(); bản giả cho dev/test: createMemoryCdn(). */
export interface CdnClient {
  createInvalidation(input: { callerReference: string; paths: string[] }): Promise<{ id: string }>;
  /** null nếu không tồn tại */
  getInvalidation(id: string): Promise<{ id: string; status: string; callerReference: string; paths: string[]; createdAt?: string } | null>;
}

export interface InvalidationDeps {
  seg: Pick<ReturnType<typeof createSEG>, 'pagesOfSentence'>;
  cdn: CdnClient;
  /** INVALIDATION_WILDCARD_THRESHOLD: số đường dẫn tối đa của một website trước khi dùng wildcard */
  wildcardThreshold?: number;
  /** Số đường dẫn trong một CreateInvalidation */
  batchSize?: number;
  uuid?: () => string;
  /** Số lời gọi tra SEG song song */
  concurrency?: number;
  /** Ghi metric theo QC-9 (obs.metric khi có mô-đun obs); không bao giờ làm hỏng yêu cầu */
  metric?: (name: string, value: number, dims: Record<string, string>) => void;
}

const HASH_RE = /^[0-9a-f]{64}$/;
const LANG_RE = /^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const INVALIDATION_ID_RE = /^[A-Z0-9]{1,64}$/;

const errName = (e: unknown): string =>
  e && typeof e === 'object' && 'name' in e && typeof (e as { name: unknown }).name === 'string' ? (e as { name: string }).name : 'UnknownError';

/** Tiền tố CallerReference của tenant (M8) */
export const callerReferencePrefix = (tenantId: string): string => `t:${tenantId}:`;

/**
 * <path> của SEG (/<slug>/<phần còn lại>) -> đường dẫn CloudFront /<slug>/<lang>/<phần còn lại>.
 * null nếu path không đúng dạng (bỏ qua, không gửi CloudFront).
 */
export function cloudFrontPath(segPath: string, lang: Lang): { slug: string; path: string } | null {
  const m = /^\/([^/]+)\/(.*)$/s.exec(segPath);
  if (!m || !SLUG_RE.test(m[1]) || /[?#\s*]/.test(m[2])) return null;
  return { slug: m[1], path: `/${m[1]}/${lang}/${m[2]}` };
}

async function runPool<T>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
      while (next < items.length) await worker(items[next++]);
    }),
  );
}

/** /<slug>/* cho từng website. Bỏ slug sai dạng: proxy không bao giờ phục vụ slug đó nên không có gì để xóa. */
function sitePaths(slugs: readonly string[]): string[] {
  return [...new Set(slugs)]
    .filter((slug) => typeof slug === 'string' && SLUG_RE.test(slug))
    .sort()
    .map((slug) => `/${slug}/*`);
}

/**
 * Xóa toàn bộ cache của các website (khóa tenant, tạm dừng/bật lại website).
 * Ném CACHE_INVALIDATION_FAILED nếu có lô CloudFront lỗi; gọi lại với cùng slugs để thử lại.
 */
export function createSiteInvalidator(deps: Pick<InvalidationDeps, 'cdn' | 'uuid' | 'metric'>): SiteInvalidator {
  const uuid = deps.uuid ?? (() => globalThis.crypto.randomUUID());
  return async (ctx, req) => {
    const paths = sitePaths(req.slugs);
    if (!paths.length) return { paths, mode: 'WILDCARD', status: 'NOTHING_TO_DO', invalidationIds: [] };

    const invalidationIds: string[] = [];
    let failed = 0;
    let firstError: string | undefined;
    for (let i = 0; i < paths.length; i += CLOUDFRONT_WILDCARD_LIMIT) {
      const batch = paths.slice(i, i + CLOUDFRONT_WILDCARD_LIMIT);
      try {
        const out = await deps.cdn.createInvalidation({ callerReference: `${callerReferencePrefix(ctx.tenantId)}${uuid()}`, paths: batch });
        invalidationIds.push(out.id);
      } catch (err) {
        failed += batch.length;
        firstError ??= errName(err);
      }
    }
    try {
      deps.metric?.('invalidation.paths', paths.length - failed, { mode: 'site' });
    } catch {
      // metric không bao giờ làm hỏng yêu cầu (QC-9)
    }
    if (failed) {
      throw new AppError(
        'CACHE_INVALIDATION_FAILED',
        `Chưa làm mới được cache của ${failed}/${paths.length} website (${firstError}), vui lòng thử lại`,
      );
    }
    return { paths, mode: 'WILDCARD', status: 'SUBMITTED', invalidationIds };
  };
}

export function createInvalidator(deps: InvalidationDeps) {
  const threshold = deps.wildcardThreshold ?? DEFAULT_WILDCARD_THRESHOLD;
  const batchSize = deps.batchSize ?? DEFAULT_INVALIDATION_BATCH_SIZE;
  const uuid = deps.uuid ?? (() => globalThis.crypto.randomUUID());
  const metric = (name: string, value: number, dims: Record<string, string>) => {
    try {
      deps.metric?.(name, value, dims);
    } catch {
      // metric không bao giờ làm hỏng yêu cầu (QC-9)
    }
  };

  /** Mục 2.6.4 bước 2–5. Ném INVALID_REQUEST nếu đầu vào sai; không ném lỗi vì SEG hay CloudFront. */
  async function invalidateForSentences(ctx: Ctx, req: InvalidateRequest): Promise<InvalidateResult> {
    if (!LANG_RE.test(req.src) || !LANG_RE.test(req.tgt)) throw new AppError('INVALID_REQUEST', 'Mã ngôn ngữ không hợp lệ');
    const hashes = [...new Set(req.hashes)];
    if (hashes.some((h) => !HASH_RE.test(h))) throw new AppError('INVALID_REQUEST', 'Hash câu phải là SHA-256 dạng hex thường');

    const result: InvalidateResult = { paths: [], mode: 'PATHS', status: 'NOTHING_TO_DO', invalidationIds: [], failedPaths: [] };

    // Bước 2: tra SEG ra các trang ở ngôn ngữ đích
    const bySlug = new Map<string, Set<string>>();
    try {
      await runPool(hashes, deps.concurrency ?? 8, async (hash) => {
        for (const p of await deps.seg.pagesOfSentence(ctx, hash, req.tgt)) {
          const cf = cloudFrontPath(p, req.tgt);
          if (!cf) continue;
          if (!bySlug.has(cf.slug)) bySlug.set(cf.slug, new Set());
          bySlug.get(cf.slug)!.add(cf.path);
        }
      });
    } catch (err) {
      return { ...result, status: 'FAILED', error: `SEG_QUERY_FAILED:${errName(err)}` };
    }

    // Bước 3–4: chọn cách xóa theo từng website
    const paths: string[] = [];
    for (const [slug, set] of [...bySlug.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (set.size > threshold) {
        paths.push(`/${slug}/${req.tgt}/*`);
        result.mode = 'WILDCARD';
      } else paths.push(...[...set].sort());
    }
    result.paths = paths;
    if (!paths.length) return result;

    // Bước 5: CreateInvalidation theo lô, CallerReference t:<tenant>:<uuid>
    for (let i = 0; i < paths.length; i += batchSize) {
      const batch = paths.slice(i, i + batchSize);
      try {
        const out = await deps.cdn.createInvalidation({ callerReference: `${callerReferencePrefix(ctx.tenantId)}${uuid()}`, paths: batch });
        result.invalidationIds.push(out.id);
      } catch (err) {
        result.failedPaths.push(...batch);
        result.error ??= errName(err);
      }
    }
    result.invalidationId = result.invalidationIds[0];
    result.status = !result.failedPaths.length ? 'SUBMITTED' : result.invalidationIds.length ? 'PARTIAL' : 'FAILED';
    metric('invalidation.paths', paths.length - result.failedPaths.length, { mode: result.mode === 'WILDCARD' ? 'wildcard' : 'paths' });
    return result;
  }

  /** Mục 2.6.4 bước 6: trạng thái một lần xóa; chỉ tenant tạo ra nó mới tra được. */
  async function getInvalidationStatus(ctx: Ctx, id: string): Promise<InvalidationStatus> {
    const notFound = () => new AppError('NOT_FOUND', 'Không tìm thấy lần làm mới');
    if (!INVALIDATION_ID_RE.test(id)) throw notFound();
    const inv = await deps.cdn.getInvalidation(id);
    if (!inv || !inv.callerReference.startsWith(callerReferencePrefix(ctx.tenantId))) throw notFound();
    return { id: inv.id, status: inv.status === 'Completed' ? 'COMPLETED' : 'IN_PROGRESS', paths: inv.paths, ...(inv.createdAt ? { createdAt: inv.createdAt } : {}) };
  }

  return { invalidateForSentences, getInvalidationStatus, invalidateForSites: createSiteInvalidator(deps) };
}

/** Đọc cấu hình từ biến môi trường của C6. */
export function invalidationConfigFromEnv(env: Record<string, string | undefined>): { distributionId?: string; wildcardThreshold: number; batchSize: number } {
  const pos = (v: string | undefined, d: number) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    distributionId: env.CLOUDFRONT_DISTRIBUTION_ID?.trim() || undefined,
    wildcardThreshold: pos(env.INVALIDATION_WILDCARD_THRESHOLD, DEFAULT_WILDCARD_THRESHOLD),
    // CloudFront giới hạn 3.000 đường dẫn đang xử lý mỗi distribution
    batchSize: Math.min(3000, pos(env.INVALIDATION_BATCH_SIZE, DEFAULT_INVALIDATION_BATCH_SIZE)),
  };
}

// ============================================================================
// Bản CloudFront thật. invalidateForSentences/createInvalidator nhận client và hai lớp lệnh từ nơi dùng (C6),
// ví dụ (invalidateForSites mặc định tự làm việc này bằng import động, xem bên dưới):
//   import { CloudFrontClient, CreateInvalidationCommand, GetInvalidationCommand } from '@aws-sdk/client-cloudfront';
//   const cdn = cloudFrontCdn(new CloudFrontClient({}), { CreateInvalidationCommand, GetInvalidationCommand }, distributionId);
// ============================================================================

interface CommandCtor {
  new (input: never): unknown;
}

export function cloudFrontCdn(
  client: { send(command: unknown): Promise<unknown> },
  commands: { CreateInvalidationCommand: CommandCtor; GetInvalidationCommand: CommandCtor },
  distributionId: string,
): CdnClient {
  return {
    async createInvalidation({ callerReference, paths }) {
      const out = (await client.send(
        new commands.CreateInvalidationCommand({
          DistributionId: distributionId,
          InvalidationBatch: { CallerReference: callerReference, Paths: { Quantity: paths.length, Items: paths } },
        } as never),
      )) as { Invalidation?: { Id?: string } };
      const id = out.Invalidation?.Id;
      if (!id) throw Object.assign(new Error('CreateInvalidation không trả Id'), { name: 'InvalidationMissingId' });
      return { id };
    },
    async getInvalidation(id) {
      try {
        const out = (await client.send(new commands.GetInvalidationCommand({ DistributionId: distributionId, Id: id } as never))) as {
          Invalidation?: { Id?: string; Status?: string; CreateTime?: Date; InvalidationBatch?: { CallerReference?: string; Paths?: { Items?: string[] } } };
        };
        const inv = out.Invalidation;
        if (!inv?.Id) return null;
        return {
          id: inv.Id,
          status: inv.Status ?? 'InProgress',
          callerReference: inv.InvalidationBatch?.CallerReference ?? '',
          paths: inv.InvalidationBatch?.Paths?.Items ?? [],
          ...(inv.CreateTime ? { createdAt: new Date(inv.CreateTime).toISOString() } : {}),
        };
      } catch (err) {
        if (errName(err) === 'NoSuchInvalidation') return null;
        throw err;
      }
    },
  };
}

// ============================================================================
// Bản mặc định của invalidateForSites cho C6 (siteManager, platform/tenantStatus).
// Dựng CloudFront thật từ CLOUDFRONT_DISTRIBUTION_ID; SDK chỉ được nạp (import động) khi có biến này.
// ============================================================================

let defaultSiteInvalidator: Promise<SiteInvalidator | null> | undefined;

/** Thay bản mặc định (test, hoặc nơi khởi tạo muốn tự truyền cdn). null = chưa cấu hình CDN. */
export function configureSiteInvalidation(cdn: CdnClient | null, o: Pick<InvalidationDeps, 'uuid' | 'metric'> = {}): void {
  defaultSiteInvalidator = Promise.resolve(cdn ? createSiteInvalidator({ cdn, ...o }) : null);
}

async function siteInvalidatorFromEnv(): Promise<SiteInvalidator | null> {
  const { distributionId } = invalidationConfigFromEnv(process.env);
  if (!distributionId) return null;
  const sdk = await import('@aws-sdk/client-cloudfront');
  return createSiteInvalidator({ cdn: cloudFrontCdn(new sdk.CloudFrontClient({}), sdk, distributionId) });
}

/** Làm mới toàn bộ cache của các website khi trạng thái website hoặc tenant thay đổi (QC-3). */
export async function invalidateForSites(ctx: Ctx, req: SiteInvalidationRequest): Promise<SiteInvalidationResult> {
  const paths = sitePaths(req.slugs);
  if (!paths.length) return { paths, mode: 'WILDCARD', status: 'NOTHING_TO_DO', invalidationIds: [] };

  if (!defaultSiteInvalidator) {
    defaultSiteInvalidator = siteInvalidatorFromEnv();
    defaultSiteInvalidator.catch(() => {
      defaultSiteInvalidator = undefined; // lần sau thử dựng lại
    });
  }
  let invalidate: SiteInvalidator | null;
  try {
    invalidate = await defaultSiteInvalidator;
  } catch (err) {
    throw new AppError('CACHE_INVALIDATION_FAILED', `Không khởi tạo được CloudFront (${errName(err)}), vui lòng thử lại`);
  }
  if (invalidate) return invalidate(ctx, req);

  if (process.env.AWS_LAMBDA_FUNCTION_NAME) {
    // Đã triển khai mà thiếu CLOUDFRONT_DISTRIBUTION_ID: báo lỗi thay vì để trang cũ còn trong cache tới 7 ngày
    throw new AppError('CACHE_INVALIDATION_FAILED', 'Chưa cấu hình CLOUDFRONT_DISTRIBUTION_ID');
  }
  console.warn(JSON.stringify({ level: 'WARN', action: 'CDN_NOT_CONFIGURED', tenantId: ctx.tenantId, paths: paths.length }));
  return { paths, mode: 'WILDCARD', status: 'NOT_CONFIGURED', invalidationIds: [] };
}

/**
 * CloudFront giả trong bộ nhớ, cho môi trường dev chưa có distribution và cho kiểm thử của 3.8.
 * Lần xóa chuyển sang Completed sau `completeAfterReads` lần GetInvalidation (mặc định 1).
 */
export function createMemoryCdn(o: { completeAfterReads?: number; failWith?: string } = {}) {
  const items = new Map<string, { id: string; callerReference: string; paths: string[]; reads: number; createdAt: string }>();
  let seq = 0;
  const cdn: CdnClient & { items: typeof items; failWith?: string } = {
    items,
    failWith: o.failWith,
    async createInvalidation({ callerReference, paths }) {
      if (cdn.failWith) throw Object.assign(new Error('fail'), { name: cdn.failWith });
      if ([...items.values()].some((i) => i.callerReference === callerReference)) {
        throw Object.assign(new Error('CallerReference đã dùng'), { name: 'InvalidationBatchAlreadyExists' });
      }
      const id = `I${String(++seq).padStart(12, '0')}`;
      items.set(id, { id, callerReference, paths: [...paths], reads: 0, createdAt: new Date().toISOString() });
      return { id };
    },
    async getInvalidation(id) {
      const it = items.get(id);
      if (!it) return null;
      it.reads++;
      return { id, status: it.reads > (o.completeAfterReads ?? 1) ? 'Completed' : 'InProgress', callerReference: it.callerReference, paths: [...it.paths], createdAt: it.createdAt };
    },
  };
  return cdn;
}
