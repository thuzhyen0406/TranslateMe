/**
 * Hạng mục 3.8 – Duyệt bản dịch / Translation Review (F5).
 *
 * Bám sát Quy ước chung (QC-1..QC-8), Mục 1.3.4, 2.2.6, 2.6.4 của Báo cáo:
 *  - Phân quyền: Chỉ cho phép `TENANT_ADMIN` và `REVIEWER` (chặn `DEVELOPER` với `FORBIDDEN`).
 *  - Kiểm tra bảng `MEMBER` (`PK = TENANT#<t>`, `SK = MEMBER#<sub>`): thành viên phải đang `ACTIVE`.
 *  - Kiểm tra `CONFIG` (`PK = TENANT#<t>`, `SK = CONFIG`): khi `status === 'LOCKED'`, chặn mọi thao tác ghi
 *    với mã lỗi `TENANT_SUSPENDED` (chỉ cho phép xem danh sách ở chế độ chỉ đọc).
 *  - 3 thao tác duyệt câu trên bản ghi `TM` (`PK = TENANT#<t>#TM#<src>#<tgt>`, `SK = HASH#<hash>`):
 *      1. Chấp nhận nguyên bản (`acceptTranslation` / `ACCEPT`): chuyển sang `HUMAN`, `needsReview = false`.
 *      2. Lưu và xuất bản (`saveAndPublishTranslation` / `SAVE_AND_PUBLISH`): kiểm tra bảo toàn ký hiệu nội tuyến
 *         `{n}` bằng `compareMarkers` (`400 PLACEHOLDER_MISMATCH`), cập nhật `HUMAN` và gọi xóa cache chọn lọc.
 *      3. Khôi phục bản máy (`restoreMachineTranslation` / `RESTORE_MACHINE`): khôi phục `tgt = machineTgt`,
 *         chuyển `label = 'MACHINE'` và gọi xóa cache chọn lọc.
 *  - Khóa lạc quan (`Optimistic Locking`): kiểm tra `version = :expectedVersion`; nếu xung đột thì đọc lại
 *    bản ghi mới nhất của câu đó và ném `409 VERSION_CONFLICT` kèm `details.latest`.
 *  - Kết nối xóa cache chọn lọc của Hạng mục 3.5 (`libs/common/invalidation.ts`) qua chữ ký đã chốt:
 *      `invalidateForSentences(ctx, { src, tgt, hashes }): Promise<{ paths, mode: 'PATHS' | 'WILDCARD', invalidationId? }>`
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { db, requireRole } from '../../../libs/common/db.js';
import { createTenantDocumentClientRouter } from '../../../libs/common/tenantAws.js';
import {
  cloudFrontCdn,
  createInvalidator,
  invalidationConfigFromEnv,
  type CdnClient,
  type InvalidationProgress,
  type InvalidationStatus,
  type InvalidationSubmitStatus,
} from '../../../libs/common/invalidation.js';
import { compareMarkers } from '../../../libs/common/markers.js';
import { createDynamoSegDb, createSEG } from '../../../libs/common/seg.js';
import { roleFromClaim } from '../../../libs/common/roles.js';
import { tmKey } from '../../../libs/common/tm.js';
import { AppError, keys, type Ctx, type Lang, type Role, type Sha256Hex } from '../../../libs/common/types.js';

const TABLE_NAME = process.env.TABLE_NAME || 'translate-data';
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

export type ReviewTab = 'REVIEW' | 'MACHINE' | 'HUMAN';
export type ReviewActionType = 'ACCEPT' | 'SAVE_AND_PUBLISH' | 'RESTORE_MACHINE';

export interface ReviewTranslationEntry {
  hash: Sha256Hex;
  srcLang: Lang;
  tgtLang: Lang;
  sourceText: string;
  tgt: string;
  machineTgt?: string;
  label: 'MACHINE' | 'HUMAN';
  needsReview: boolean;
  glossaryVersion: number;
  version: number;
  updatedAt: string;
  updatedBy: string;
  GSI3PK: string;
  GSI3SK: string;
}

/**
 * Chữ ký hàm xóa cache chọn lọc đã chốt giữa 3.8 (TV4) và 3.5 (TV2):
 *   invalidateForSentences(ctx, { src, tgt, hashes }): Promise<{ paths, mode: 'PATHS' | 'WILDCARD', invalidationId? }>
 */
export type InvalidateForSentencesFn = (
  ctx: Ctx,
  req: { src: Lang; tgt: Lang; hashes: readonly Sha256Hex[] },
) => Promise<{
  paths: string[];
  mode: 'PATHS' | 'WILDCARD';
  invalidationId?: string;
  status?: InvalidationSubmitStatus;
  invalidationIds?: string[];
  failedPaths?: string[];
  error?: string;
}>;

export interface ReviewInvalidationResult {
  paths: string[];
  mode: 'PATHS' | 'WILDCARD';
  invalidationId?: string;
  status: InvalidationSubmitStatus;
  invalidationIds: string[];
  failedPaths: string[];
  error?: string;
}

export interface ReviewMutationResult {
  entry: ReviewTranslationEntry;
  invalidation: ReviewInvalidationResult;
}

export const DEFAULT_TRANSLATIONS_LIMIT = 50;
export const MAX_TRANSLATIONS_LIMIT = 200;

export interface ListTranslationsFilter {
  src?: Lang;
  tgt?: Lang;
  tab?: ReviewTab;
  search?: string;
  limit?: number;
  cursor?: string;
}

export interface ListTranslationsResult {
  items: ReviewTranslationEntry[];
  total: number;
  tab: ReviewTab;
  tenantLocked: boolean;
  glossaryVersion: number;
  nextCursor?: string;
}

export interface AcceptTranslationInput {
  src: Lang;
  tgt: Lang;
  hash: Sha256Hex;
  expectedVersion: number;
  /** Mặc định false vì ACCEPT giữ nguyên văn bản tgt nên trang cache không đổi; đặt true nếu muốn ép làm mới */
  invalidateCache?: boolean;
}

export interface SaveTranslationInput {
  src: Lang;
  tgt: Lang;
  hash: Sha256Hex;
  newTgt: string;
  expectedVersion: number;
}

export interface RestoreMachineInput {
  src: Lang;
  tgt: Lang;
  hash: Sha256Hex;
  expectedVersion: number;
  /** Bản dịch máy dự phòng nếu bản ghi cũ chưa lưu trường machineTgt */
  machineTgtFallback?: string;
}

export interface RetryInvalidationInput {
  src: Lang;
  tgt: Lang;
  hashes: readonly Sha256Hex[];
}

export interface QueryGsi3Options {
  /** Sắp xếp theo GSI3SK tăng dần (true) hay giảm dần (false, mặc định mới nhất trước). */
  scanIndexForward?: boolean;
  /** Giới hạn số bản ghi tối đa đọc trong một truy vấn GSI3. */
  limit?: number;
  /** Con trỏ phân trang mã hóa base64url của ExclusiveStartKey. */
  cursor?: string;
  /** Tiền tố GSI3SK tùy chọn. */
  gsi3skPrefix?: string;
}

export interface QueryGsi3PageResult {
  items: Record<string, any>[];
  nextCursor?: string;
}

export interface ReviewDb extends Pick<typeof db, 'get' | 'update' | 'query'> {
  /** Truy vấn trên GSI3 (PK = TENANT#<t>#TM#<REVIEW|MACHINE|HUMAN>) theo thứ tự GSI3SK giảm dần và có giới hạn Limit */
  queryGsi3?: (
    ctx: Ctx,
    gsi3pk: string,
    gsi3skPrefix?: string,
    options?: QueryGsi3Options,
  ) => Promise<Record<string, any>[]>;
  /** Truy vấn một trang trên GSI3 theo thứ tự GSI3SK giảm dần kèm con trỏ phân trang */
  queryGsi3Page?: (
    ctx: Ctx,
    gsi3pk: string,
    options?: QueryGsi3Options,
  ) => Promise<QueryGsi3PageResult>;
}

export interface ReviewDependencies {
  db: ReviewDb;
  invalidateForSentences: InvalidateForSentencesFn;
  getInvalidationStatus?: (ctx: Ctx, id: string) => Promise<InvalidationStatus>;
  now: () => number;
}

// ============================================================================
// Phụ thuộc mặc định (kết nối CloudFront thật qua cloudFrontCdn & CLOUDFRONT_DISTRIBUTION_ID)
// ============================================================================

const rawDynamoClient = new DynamoDBClient({});
export const defaultDocClient = createTenantDocumentClientRouter(
  DynamoDBDocumentClient.from(rawDynamoClient),
  {
    roleArn: process.env.TENANT_DATA_ACCESS_ROLE_ARN,
    sessionName: 'console-review',
  },
);
export const defaultSeg = createSEG({ db: createDynamoSegDb(defaultDocClient, TABLE_NAME) });

let configuredCdnClient: CdnClient | null = null;
let cachedEnvCdn: { distributionId: string; client: CdnClient } | null = null;

/**
 * Cho phép C6 / tầng khởi tạo Lambda cấu hình sẵn `CdnClient` thật (ví dụ từ `cloudFrontCdn(...)`).
 * Nếu không gọi hàm này, `defaultCdn` sẽ tự động đọc `CLOUDFRONT_DISTRIBUTION_ID` từ `process.env`
 * và nạp `@aws-sdk/client-cloudfront`.
 */
export function configureDefaultCloudFrontCdn(cdn: CdnClient | null): void {
  configuredCdnClient = cdn;
}

async function resolveDefaultCdnClient(): Promise<CdnClient> {
  if (configuredCdnClient) {
    return configuredCdnClient;
  }
  const { distributionId } = invalidationConfigFromEnv(process.env);
  if (!distributionId) {
    throw Object.assign(
      new Error('Chưa cấu hình biến môi trường CLOUDFRONT_DISTRIBUTION_ID cho xóa cache CloudFront'),
      { name: 'MissingCloudFrontDistributionId' },
    );
  }
  if (cachedEnvCdn && cachedEnvCdn.distributionId === distributionId) {
    return cachedEnvCdn.client;
  }
  const cfModuleName = '@aws-sdk/client-cloudfront';
  const cf = (await import(cfModuleName)) as {
    CloudFrontClient: new (cfg: Record<string, unknown>) => { send(command: unknown): Promise<unknown> };
    CreateInvalidationCommand: new (input: never) => unknown;
    GetInvalidationCommand: new (input: never) => unknown;
  };
  const client = cloudFrontCdn(
    new cf.CloudFrontClient({}),
    {
      CreateInvalidationCommand: cf.CreateInvalidationCommand,
      GetInvalidationCommand: cf.GetInvalidationCommand,
    },
    distributionId,
  );
  cachedEnvCdn = { distributionId, client };
  return client;
}

const defaultCloudFrontCdn: CdnClient = {
  async createInvalidation(input) {
    const cdn = await resolveDefaultCdnClient();
    return cdn.createInvalidation(input);
  },
  async getInvalidation(id) {
    const cdn = await resolveDefaultCdnClient();
    return cdn.getInvalidation(id);
  },
};

function getDefaultInvalidator() {
  const cfg = invalidationConfigFromEnv(process.env);
  return createInvalidator({
    seg: defaultSeg,
    cdn: defaultCloudFrontCdn,
    wildcardThreshold: cfg.wildcardThreshold,
    batchSize: cfg.batchSize,
  });
}

/** Mã hóa khóa đánh giá cuối cùng của DynamoDB thành con trỏ base64url. */
export function encodeReviewCursor(key: Record<string, any>): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

/** Giải mã và xác thực con trỏ phân trang phải thuộc đúng tenant và GSI3PK hiện tại. */
export function decodeReviewCursor(
  cursor: string,
  expectedTenantId: string,
  expectedGsi3pk: string,
): Record<string, any> {
  try {
    const raw = Buffer.from(cursor.trim(), 'base64url').toString('utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Invalid cursor object');
    }
    const pk = typeof parsed.PK === 'string' ? parsed.PK : '';
    const gsi3pk = typeof parsed.GSI3PK === 'string' ? parsed.GSI3PK : '';
    if (!pk.startsWith(`TENANT#${expectedTenantId}#`) || gsi3pk !== expectedGsi3pk) {
      throw new Error('Cursor tenant/GSI3PK mismatch');
    }
    return parsed as Record<string, any>;
  } catch {
    throw new AppError('INVALID_REQUEST', 'Con trỏ phân trang (cursor) không hợp lệ');
  }
}

export const defaultReviewDb: ReviewDb = {
  ...db,
  async queryGsi3Page(ctx: Ctx, gsi3pk: string, options?: QueryGsi3Options): Promise<QueryGsi3PageResult> {
    const allowedPrefix = `TENANT#${ctx.tenantId}#`;
    if (!ctx.tenantId || ctx.tenantId === 'PLATFORM' || !gsi3pk.startsWith(allowedPrefix)) {
      throw new AppError('FORBIDDEN', `Bị từ chối: Ctx Tenant (${ctx.tenantId}) không có quyền truy cập GSI3PK (${gsi3pk})`);
    }
    const gsi3skPrefix = options?.gsi3skPrefix;
    const scanIndexForward = options?.scanIndexForward ?? false;
    const limit = Math.min(
      Math.max(Number(options?.limit ?? DEFAULT_TRANSLATIONS_LIMIT) || DEFAULT_TRANSLATIONS_LIMIT, 1),
      MAX_TRANSLATIONS_LIMIT,
    );
    const exclusiveStartKey = options?.cursor
      ? decodeReviewCursor(options.cursor, ctx.tenantId, gsi3pk)
      : undefined;

    const res = await defaultDocClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI3',
        KeyConditionExpression: gsi3skPrefix ? 'GSI3PK = :gsi3pk AND begins_with(GSI3SK, :sk)' : 'GSI3PK = :gsi3pk',
        ExpressionAttributeValues: gsi3skPrefix ? { ':gsi3pk': gsi3pk, ':sk': gsi3skPrefix } : { ':gsi3pk': gsi3pk },
        ScanIndexForward: scanIndexForward,
        Limit: limit,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    );

    const items = (res.Items as Record<string, any>[] | undefined) ?? [];
    const lastKey = res.LastEvaluatedKey as Record<string, any> | undefined;
    return {
      items,
      ...(lastKey ? { nextCursor: encodeReviewCursor(lastKey) } : {}),
    };
  },
  async queryGsi3(ctx: Ctx, gsi3pk: string, gsi3skPrefix?: string, options?: QueryGsi3Options) {
    const page = await defaultReviewDb.queryGsi3Page!(ctx, gsi3pk, {
      ...options,
      gsi3skPrefix: gsi3skPrefix ?? options?.gsi3skPrefix,
      scanIndexForward: options?.scanIndexForward ?? false,
      limit: options?.limit ?? MAX_TRANSLATIONS_LIMIT,
    });
    return page.items;
  },
};

export function createReviewDependencies(options?: {
  db?: ReviewDb;
  cdn?: CdnClient;
  env?: Record<string, string | undefined>;
  now?: () => number;
  docClient?: Pick<DynamoDBDocumentClient, 'send'>;
}): ReviewDependencies {
  const cfg = invalidationConfigFromEnv(options?.env ?? process.env);
  const activeDocClient = options?.docClient ?? defaultDocClient;
  const activeSeg = options?.docClient
    ? createSEG({ db: createDynamoSegDb(activeDocClient, TABLE_NAME) })
    : defaultSeg;
  const invalidator = options?.cdn
    ? createInvalidator({
        seg: activeSeg,
        cdn: options.cdn,
        wildcardThreshold: cfg.wildcardThreshold,
        batchSize: cfg.batchSize,
      })
    : null;

  return {
    db: options?.db ?? defaultReviewDb,
    invalidateForSentences: (ctx, req) => (invalidator ?? getDefaultInvalidator()).invalidateForSentences(ctx, req),
    getInvalidationStatus: (ctx, id) => (invalidator ?? getDefaultInvalidator()).getInvalidationStatus(ctx, id),
    now: options?.now ?? (() => Date.now()),
  };
}

const defaultDependencies: ReviewDependencies = createReviewDependencies();

// ============================================================================
// Hàm phụ trợ kiểm tra quyền, MEMBER, trạng thái tenant & chuẩn hóa dữ liệu
// ============================================================================

function validateLangCode(lang: string, fieldName: string): Lang {
  if (typeof lang !== 'string' || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(lang.trim())) {
    throw new AppError('INVALID_REQUEST', `Mã ngôn ngữ '${fieldName}' không hợp lệ`);
  }
  return lang.trim();
}

function validateHash(hash: string): Sha256Hex {
  if (typeof hash !== 'string' || !SHA256_HEX_RE.test(hash.trim().toLowerCase())) {
    throw new AppError('INVALID_REQUEST', 'Mã băm câu (hash) phải là chuỗi SHA-256 hex 64 ký tự');
  }
  return hash.trim().toLowerCase();
}

function validateExpectedVersion(version: unknown): number {
  const num = Number(version);
  if (!Number.isInteger(num) || num < 1) {
    throw new AppError('INVALID_REQUEST', 'expectedVersion phải là số nguyên dương (>= 1)');
  }
  return num;
}

/**
 * Kiểm tra quyền truy cập F5 (Bảng 1.2, QC-6 M5/M6, QC-7):
 *  - Chỉ `TENANT_ADMIN` và `REVIEWER` được truy cập Duyệt bản dịch (`DEVELOPER` bị từ chối).
 *  - Bắt buộc `ctx.sub` phải có mặt và kiểm tra bản ghi `MEMBER#<sub>` trong DynamoDB phải tồn tại và có `status = 'ACTIVE'`.
 *  - Nếu `mode === 'WRITE'` và `CONFIG.status === 'LOCKED'`, từ chối với `TENANT_SUSPENDED`.
 */
async function assertReviewAccess(
  ctx: Ctx,
  mode: 'READ' | 'WRITE',
  deps: ReviewDependencies,
): Promise<{
  config: Record<string, any>;
  currentGlossaryVersion: number;
  tenantLocked: boolean;
}> {
  if (!ctx.tenantId || ctx.tenantId === 'PLATFORM') {
    throw new AppError('PERMISSION_DENIED', 'Ngữ cảnh tenant không hợp lệ');
  }

  if (ctx.via && ctx.via !== 'JWT') {
    throw new AppError('UNAUTHORIZED', 'Thao tác duyệt bản dịch yêu cầu phiên đăng nhập Console (JWT)');
  }

  if (!ctx.role || (ctx.role !== 'TENANT_ADMIN' && ctx.role !== 'REVIEWER')) {
    throw new AppError(
      'PERMISSION_DENIED',
      'Vai trò không được phép truy cập màn Duyệt bản dịch (chỉ TENANT_ADMIN và REVIEWER)',
    );
  }

  const sub = typeof ctx.sub === 'string' ? ctx.sub.trim() : '';
  if (!sub) {
    throw new AppError('UNAUTHORIZED', 'Thiếu định danh người dùng (ctx.sub) trong ngữ cảnh xác thực');
  }

  const member = await deps.db.get(ctx, keys.member(ctx, sub), { consistent: true });
  if (!member || member.status !== 'ACTIVE') {
    throw new AppError(
      'PERMISSION_DENIED',
      'Tài khoản thành viên không tồn tại hoặc không còn ở trạng thái hoạt động (ACTIVE) trong tenant',
    );
  }

  const config = await deps.db.get(ctx, keys.config(ctx), { consistent: true });
  if (!config) {
    throw new AppError('NOT_FOUND', `Không tìm thấy cấu hình của tenant ${ctx.tenantId}`);
  }

  const tenantLocked = config.status === 'LOCKED';
  if (mode === 'WRITE' && tenantLocked) {
    throw new AppError('TENANT_SUSPENDED', 'Tenant đang bị tạm khóa, chỉ được phép xem bản dịch ở chế độ chỉ đọc');
  }

  return {
    config,
    currentGlossaryVersion: Number(config.glossaryVersion ?? 0),
    tenantLocked,
  };
}

function parseLangPairFromPk(pk: string): { srcLang: string; tgtLang: string } {
  // PK = TENANT#<t>#TM#<src>#<tgt>
  const parts = pk.split('#');
  const tmIdx = parts.indexOf('TM');
  if (tmIdx >= 0 && parts.length >= tmIdx + 3) {
    return { srcLang: parts[tmIdx + 1], tgtLang: parts[tmIdx + 2] };
  }
  return { srcLang: 'vi', tgtLang: 'en' };
}

function mapRawToReviewEntry(raw: Record<string, any>): ReviewTranslationEntry {
  const pk = String(raw.PK ?? '');
  const sk = String(raw.SK ?? '');
  const { srcLang, tgtLang } = parseLangPairFromPk(pk);
  const hash = String(raw.hash ?? sk.replace(/^HASH#/, ''));
  const label: 'MACHINE' | 'HUMAN' = raw.label === 'HUMAN' ? 'HUMAN' : 'MACHINE';
  const needsReview = Boolean(raw.needsReview);
  const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date(0).toISOString();
  const tenantId = pk.startsWith('TENANT#') ? pk.split('#')[1] ?? '' : '';
  const defaultGsi3Pk = `TENANT#${tenantId}#TM#${needsReview ? 'REVIEW' : label}`;

  return {
    hash,
    srcLang: typeof raw.srcLang === 'string' ? raw.srcLang : srcLang,
    tgtLang: typeof raw.tgtLang === 'string' ? raw.tgtLang : tgtLang,
    sourceText: String(raw.src ?? raw.sourceText ?? ''),
    tgt: String(raw.tgt ?? ''),
    ...(typeof raw.machineTgt === 'string' ? { machineTgt: raw.machineTgt } : {}),
    label,
    needsReview,
    glossaryVersion: Number(raw.glossaryVersion ?? 0),
    version: Number(raw.version ?? 1),
    updatedAt,
    updatedBy: String(raw.updatedBy ?? 'machine'),
    GSI3PK: typeof raw.GSI3PK === 'string' ? raw.GSI3PK : defaultGsi3Pk,
    GSI3SK: typeof raw.GSI3SK === 'string' ? raw.GSI3SK : updatedAt,
  };
}

function normalizeInvalidationResult(
  raw: Awaited<ReturnType<InvalidateForSentencesFn>>,
): ReviewInvalidationResult {
  const paths = Array.isArray(raw.paths) ? [...raw.paths] : [];
  const mode = raw.mode === 'WILDCARD' ? 'WILDCARD' : 'PATHS';
  const status: InvalidationSubmitStatus =
    raw.status ??
    (paths.length === 0 ? 'NOTHING_TO_DO' : raw.invalidationId ? 'SUBMITTED' : 'FAILED');
  const invalidationIds = Array.isArray(raw.invalidationIds)
    ? [...raw.invalidationIds]
    : raw.invalidationId
      ? [raw.invalidationId]
      : [];
  const failedPaths = Array.isArray(raw.failedPaths) ? [...raw.failedPaths] : [];

  return {
    paths,
    mode,
    ...(raw.invalidationId !== undefined ? { invalidationId: raw.invalidationId } : {}),
    status,
    invalidationIds,
    failedPaths,
    ...(raw.error !== undefined ? { error: raw.error } : {}),
  };
}

async function safeInvokeInvalidate(
  ctx: Ctx,
  req: { src: Lang; tgt: Lang; hashes: readonly Sha256Hex[] },
  deps: ReviewDependencies,
): Promise<ReviewInvalidationResult> {
  try {
    const res = await deps.invalidateForSentences(ctx, req);
    return normalizeInvalidationResult(res);
  } catch (err) {
    // Theo QC-8: lỗi xóa cache không làm hỏng bản dịch đã lưu trong TM
    const errName = err instanceof Error ? err.name : 'InvalidationError';
    return {
      paths: [],
      mode: 'PATHS',
      status: 'FAILED',
      invalidationIds: [],
      failedPaths: [],
      error: errName,
    };
  }
}

function isConditionalCheckFailed(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: string }).name ?? '';
  const msg = (err as { message?: string }).message ?? '';
  return name === 'ConditionalCheckFailedException' || msg.includes('ConditionalCheckFailed');
}

async function handleVersionConflictOrThrow(
  ctx: Ctx,
  src: Lang,
  tgt: Lang,
  hash: Sha256Hex,
  expectedVersion: number,
  err: unknown,
  deps: ReviewDependencies,
): Promise<never> {
  if (isConditionalCheckFailed(err)) {
    const latestRaw = await deps.db.get(ctx, tmKey(ctx, src, tgt, hash), { consistent: true });
    if (!latestRaw) {
      throw new AppError('NOT_FOUND', 'Bản dịch không còn tồn tại trong bộ nhớ dịch');
    }
    const latestEntry = mapRawToReviewEntry(latestRaw);
    throw new AppError(
      'VERSION_CONFLICT',
      `Xung đột phiên bản: câu dịch đã được cập nhật lên phiên bản ${latestEntry.version} (phiên bản gửi lên: ${expectedVersion})`,
      {
        expectedVersion,
        actualVersion: latestEntry.version,
        latest: latestEntry,
      },
    );
  }
  throw err;
}

// ============================================================================
// 1. Liệt kê & Tra cứu câu dịch (GET /console/translations)
// ============================================================================

const MAX_GSI3_SCAN_PAGES = 5;

/**
 * Liệt kê danh sách bản dịch trong TM theo tab (`REVIEW`, `MACHINE`, `HUMAN`), cặp ngôn ngữ và từ khóa tìm kiếm.
 * Truy vấn trên GSI3 theo thứ tự `GSI3SK` giảm dần (`ScanIndexForward: false`) với `Limit` giới hạn
 * (mặc định 50, tối đa 200) và hỗ trợ con trỏ phân trang `cursor` / `nextCursor`.
 */
export async function listTranslations(
  ctx: Ctx,
  filter: ListTranslationsFilter = {},
  deps: ReviewDependencies = defaultDependencies,
): Promise<ListTranslationsResult> {
  const { currentGlossaryVersion, tenantLocked } = await assertReviewAccess(ctx, 'READ', deps);
  const tab: ReviewTab =
    filter.tab === 'MACHINE' || filter.tab === 'HUMAN' || filter.tab === 'REVIEW'
      ? filter.tab
      : 'REVIEW';

  const limit =
    filter.limit && Number.isFinite(filter.limit) && filter.limit > 0
      ? Math.min(Math.floor(filter.limit), MAX_TRANSLATIONS_LIMIT)
      : DEFAULT_TRANSLATIONS_LIMIT;

  const gsi3pk = `TENANT#${ctx.tenantId}#TM#${tab}`;
  const srcFilter = filter.src ? filter.src.trim() : undefined;
  const tgtFilter = filter.tgt ? filter.tgt.trim() : undefined;
  const searchQuery =
    typeof filter.search === 'string' && filter.search.trim() !== ''
      ? filter.search.normalize('NFC').trim().toLowerCase()
      : undefined;
  const hasPostFilter = Boolean(srcFilter || tgtFilter || searchQuery);

  const matchesFilter = (item: ReviewTranslationEntry): boolean => {
    if (tab === 'REVIEW' && !(item.needsReview === true || item.GSI3PK.endsWith('#TM#REVIEW'))) {
      return false;
    }
    if (tab === 'HUMAN' && !(item.label === 'HUMAN' && !item.needsReview)) {
      return false;
    }
    if (tab === 'MACHINE' && !(item.label === 'MACHINE' && !item.needsReview)) {
      return false;
    }
    if (srcFilter && item.srcLang !== srcFilter) return false;
    if (tgtFilter && item.tgtLang !== tgtFilter) return false;
    if (searchQuery) {
      const matchSrc = item.sourceText.normalize('NFC').toLowerCase().includes(searchQuery);
      const matchTgt = item.tgt.normalize('NFC').toLowerCase().includes(searchQuery);
      if (!matchSrc && !matchTgt) return false;
    }
    return true;
  };

  if (deps.db.queryGsi3Page) {
    const collected: ReviewTranslationEntry[] = [];
    let currentCursor = filter.cursor;
    let nextCursor: string | undefined;
    const pageLimit = hasPostFilter ? MAX_TRANSLATIONS_LIMIT : limit;

    for (let pageIdx = 0; pageIdx < MAX_GSI3_SCAN_PAGES; pageIdx++) {
      const page = await deps.db.queryGsi3Page(ctx, gsi3pk, {
        scanIndexForward: false,
        limit: pageLimit,
        cursor: currentCursor,
      });
      const mapped = page.items.map(mapRawToReviewEntry);

      for (let i = 0; i < mapped.length; i++) {
        const entry = mapped[i];
        if (!matchesFilter(entry)) continue;
        collected.push(entry);
        if (collected.length === limit) {
          const hasMoreInPage = mapped.slice(i + 1).some(matchesFilter);
          if (hasMoreInPage || page.nextCursor) {
            const itemKey = tmKey(ctx, entry.srcLang, entry.tgtLang, entry.hash);
            nextCursor = encodeReviewCursor({
              PK: itemKey.PK,
              SK: itemKey.SK,
              GSI3PK: entry.GSI3PK,
              GSI3SK: entry.GSI3SK,
            });
          }
          break;
        }
      }

      if (collected.length >= limit) {
        break;
      }
      if (!page.nextCursor) {
        nextCursor = undefined;
        break;
      }
      currentCursor = page.nextCursor;
      nextCursor = page.nextCursor;
    }

    return {
      items: collected,
      total: collected.length,
      tab,
      tenantLocked,
      glossaryVersion: currentGlossaryVersion,
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  let rawItems: Record<string, any>[] = [];
  const decodedCursor = filter.cursor
    ? decodeReviewCursor(filter.cursor, ctx.tenantId, gsi3pk)
    : undefined;

  if (deps.db.queryGsi3) {
    rawItems = await deps.db.queryGsi3(ctx, gsi3pk, undefined, {
      scanIndexForward: false,
      limit: hasPostFilter ? MAX_TRANSLATIONS_LIMIT : limit,
      cursor: filter.cursor,
    });
  } else if (filter.src && filter.tgt) {
    const src = validateLangCode(filter.src, 'src');
    const tgt = validateLangCode(filter.tgt, 'tgt');
    const pk = `TENANT#${ctx.tenantId}#TM#${src}#${tgt}`;
    rawItems = await deps.db.query(ctx, pk, 'HASH#');
  }

  let entries = rawItems.map(mapRawToReviewEntry).filter(matchesFilter);
  entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.hash.localeCompare(b.hash));

  const total = entries.length;
  if (decodedCursor) {
    const idx = entries.findIndex((item) => {
      const itemKey = tmKey(ctx, item.srcLang, item.tgtLang, item.hash);
      return itemKey.PK === decodedCursor.PK && itemKey.SK === decodedCursor.SK;
    });
    if (idx >= 0) {
      entries = entries.slice(idx + 1);
    }
  }

  const items = entries.slice(0, limit);
  const lastItem = items[items.length - 1];
  const lastItemKey = lastItem ? tmKey(ctx, lastItem.srcLang, lastItem.tgtLang, lastItem.hash) : undefined;
  const nextCursor =
    entries.length > limit && lastItem && lastItemKey
      ? encodeReviewCursor({
          PK: lastItemKey.PK,
          SK: lastItemKey.SK,
          GSI3PK: lastItem.GSI3PK,
          GSI3SK: lastItem.GSI3SK,
        })
      : undefined;

  return {
    items,
    total,
    tab,
    tenantLocked,
    glossaryVersion: currentGlossaryVersion,
    ...(nextCursor ? { nextCursor } : {}),
  };
}

/**
 * Đọc chi tiết một câu dịch theo `(src, tgt, hash)`.
 */
export async function getTranslation(
  ctx: Ctx,
  params: { src: Lang; tgt: Lang; hash: Sha256Hex },
  deps: ReviewDependencies = defaultDependencies,
): Promise<ReviewTranslationEntry> {
  await assertReviewAccess(ctx, 'READ', deps);
  const src = validateLangCode(params.src, 'src');
  const tgt = validateLangCode(params.tgt, 'tgt');
  const hash = validateHash(params.hash);

  const raw = await deps.db.get(ctx, tmKey(ctx, src, tgt, hash), { consistent: true });
  if (!raw) {
    throw new AppError('NOT_FOUND', `Không tìm thấy câu dịch với hash '${hash}' (${src} -> ${tgt})`);
  }
  return mapRawToReviewEntry(raw);
}

// ============================================================================
// 2. Chấp nhận nguyên bản (ACCEPT)
// ============================================================================

/**
 * Chấp nhận nguyên bản dịch hiện tại (chuyển từ `MACHINE` hoặc `needsReview = true` sang `HUMAN`, `needsReview = false`).
 */
export async function acceptTranslation(
  ctx: Ctx,
  input: AcceptTranslationInput,
  deps: ReviewDependencies = defaultDependencies,
): Promise<ReviewMutationResult> {
  const { currentGlossaryVersion } = await assertReviewAccess(ctx, 'WRITE', deps);
  const src = validateLangCode(input.src, 'src');
  const tgt = validateLangCode(input.tgt, 'tgt');
  const hash = validateHash(input.hash);
  const expectedVersion = validateExpectedVersion(input.expectedVersion);

  const key = tmKey(ctx, src, tgt, hash);
  const existingRaw = await deps.db.get(ctx, key, { consistent: true });
  if (!existingRaw) {
    throw new AppError('NOT_FOUND', `Không tìm thấy câu dịch cần duyệt (hash: ${hash})`);
  }

  const existing = mapRawToReviewEntry(existingRaw);

  // Kiểm tra bảo toàn ký hiệu {n} của bản dịch hiện tại trước khi đóng dấu HUMAN
  const markerCheck = compareMarkers(existing.sourceText, existing.tgt);
  if (!markerCheck.restorable) {
    throw new AppError(
      'PLACEHOLDER_MISMATCH',
      'Không thể chấp nhận nguyên bản vì bản dịch hiện tại đang thiếu hoặc lệch ký hiệu nội tuyến {n}. Vui lòng chỉnh sửa lại các ký hiệu {n} trước khi lưu.',
      {
        missing: markerCheck.missing,
        extra: markerCheck.extra,
        structureValid: markerCheck.structureValid,
      },
    );
  }

  const updatedAt = new Date(deps.now()).toISOString();
  const updatedBy = ctx.sub?.trim() || ctx.role || 'reviewer';
  const machineTgt = existing.machineTgt ?? (existing.label === 'MACHINE' ? existing.tgt : undefined);
  const newVersion = expectedVersion + 1;
  const gsi3pk = `TENANT#${ctx.tenantId}#TM#HUMAN`;

  try {
    await deps.db.update(ctx, {
      Key: key,
      UpdateExpression:
        'SET #label = :human, #nr = :false, #gv = :gv, #updatedAt = :at, #updatedBy = :by, ' +
        '#g3pk = :g3pk, #g3sk = :at' +
        (machineTgt !== undefined ? ', #machineTgt = :machineTgt' : '') +
        ' ADD #version :one',
      ConditionExpression: 'attribute_exists(PK) AND #version = :expectedVersion',
      ExpressionAttributeNames: {
        '#label': 'label',
        '#nr': 'needsReview',
        '#gv': 'glossaryVersion',
        '#updatedAt': 'updatedAt',
        '#updatedBy': 'updatedBy',
        '#g3pk': 'GSI3PK',
        '#g3sk': 'GSI3SK',
        '#version': 'version',
        ...(machineTgt !== undefined ? { '#machineTgt': 'machineTgt' } : {}),
      },
      ExpressionAttributeValues: {
        ':human': 'HUMAN',
        ':false': false,
        ':gv': currentGlossaryVersion > 0 ? currentGlossaryVersion : existing.glossaryVersion,
        ':at': updatedAt,
        ':by': updatedBy,
        ':g3pk': gsi3pk,
        ':expectedVersion': expectedVersion,
        ':one': 1,
        ...(machineTgt !== undefined ? { ':machineTgt': machineTgt } : {}),
      },
    });
  } catch (err) {
    await handleVersionConflictOrThrow(ctx, src, tgt, hash, expectedVersion, err, deps);
  }

  const updatedEntry: ReviewTranslationEntry = {
    ...existing,
    ...(machineTgt !== undefined ? { machineTgt } : {}),
    label: 'HUMAN',
    needsReview: false,
    glossaryVersion: currentGlossaryVersion > 0 ? currentGlossaryVersion : existing.glossaryVersion,
    version: newVersion,
    updatedAt,
    updatedBy,
    GSI3PK: gsi3pk,
    GSI3SK: updatedAt,
  };

  const invalidation: ReviewInvalidationResult = input.invalidateCache
    ? await safeInvokeInvalidate(ctx, { src, tgt, hashes: [hash] }, deps)
    : {
        paths: [],
        mode: 'PATHS',
        status: 'NOTHING_TO_DO',
        invalidationIds: [],
        failedPaths: [],
      };

  return { entry: updatedEntry, invalidation };
}

// ============================================================================
// 3. Lưu và xuất bản bản dịch chỉnh sửa (SAVE_AND_PUBLISH)
// ============================================================================

/**
 * Lưu bản dịch do Reviewer chỉnh sửa (`label = 'HUMAN'`, `needsReview = false`),
 * kiểm tra nghiêm ngặt ký hiệu `{n}` (`PLACEHOLDER_MISMATCH`), khóa lạc quan (`409 VERSION_CONFLICT`),
 * và kích hoạt xóa cache CloudFront chọn lọc (`invalidateForSentences`).
 */
export async function saveAndPublishTranslation(
  ctx: Ctx,
  input: SaveTranslationInput,
  deps: ReviewDependencies = defaultDependencies,
): Promise<ReviewMutationResult> {
  const { currentGlossaryVersion } = await assertReviewAccess(ctx, 'WRITE', deps);
  const src = validateLangCode(input.src, 'src');
  const tgt = validateLangCode(input.tgt, 'tgt');
  const hash = validateHash(input.hash);
  const expectedVersion = validateExpectedVersion(input.expectedVersion);

  if (typeof input.newTgt !== 'string' || input.newTgt.trim() === '') {
    throw new AppError('INVALID_REQUEST', 'Nội dung bản dịch mới (newTgt) không được để trống');
  }
  const newTgt = input.newTgt.trim();

  const key = tmKey(ctx, src, tgt, hash);
  const existingRaw = await deps.db.get(ctx, key, { consistent: true });
  if (!existingRaw) {
    throw new AppError('NOT_FOUND', `Không tìm thấy câu dịch cần chỉnh sửa (hash: ${hash})`);
  }

  const existing = mapRawToReviewEntry(existingRaw);

  // Kiểm tra thiếu/thừa/sai cấu trúc {n} (QC-6 M4: PLACEHOLDER_MISMATCH)
  const markerCheck = compareMarkers(existing.sourceText, newTgt);
  if (!markerCheck.restorable) {
    const detailsParts: string[] = [];
    if (markerCheck.missing.length > 0) {
      detailsParts.push(`thiếu: ${markerCheck.missing.join(', ')}`);
    }
    if (markerCheck.extra.length > 0) {
      detailsParts.push(`thừa: ${markerCheck.extra.join(', ')}`);
    }
    if (!markerCheck.structureValid) {
      detailsParts.push('cấu trúc đóng/mở thẻ nội tuyến không hợp lệ');
    }
    throw new AppError(
      'PLACEHOLDER_MISMATCH',
      `Bản dịch lệch ký hiệu nội tuyến {n} so với câu gốc (${detailsParts.join('; ')})`,
      {
        missing: markerCheck.missing,
        extra: markerCheck.extra,
        structureValid: markerCheck.structureValid,
      },
    );
  }

  const updatedAt = new Date(deps.now()).toISOString();
  const updatedBy = ctx.sub?.trim() || ctx.role || 'reviewer';
  const machineTgt = existing.machineTgt ?? (existing.label === 'MACHINE' ? existing.tgt : undefined);
  const newVersion = expectedVersion + 1;
  const gsi3pk = `TENANT#${ctx.tenantId}#TM#HUMAN`;

  try {
    await deps.db.update(ctx, {
      Key: key,
      UpdateExpression:
        'SET #tgt = :tgt, #label = :human, #nr = :false, #gv = :gv, #updatedAt = :at, #updatedBy = :by, ' +
        '#g3pk = :g3pk, #g3sk = :at' +
        (machineTgt !== undefined ? ', #machineTgt = :machineTgt' : '') +
        ' ADD #version :one',
      ConditionExpression: 'attribute_exists(PK) AND #version = :expectedVersion',
      ExpressionAttributeNames: {
        '#tgt': 'tgt',
        '#label': 'label',
        '#nr': 'needsReview',
        '#gv': 'glossaryVersion',
        '#updatedAt': 'updatedAt',
        '#updatedBy': 'updatedBy',
        '#g3pk': 'GSI3PK',
        '#g3sk': 'GSI3SK',
        '#version': 'version',
        ...(machineTgt !== undefined ? { '#machineTgt': 'machineTgt' } : {}),
      },
      ExpressionAttributeValues: {
        ':tgt': newTgt,
        ':human': 'HUMAN',
        ':false': false,
        ':gv': currentGlossaryVersion > 0 ? currentGlossaryVersion : existing.glossaryVersion,
        ':at': updatedAt,
        ':by': updatedBy,
        ':g3pk': gsi3pk,
        ':expectedVersion': expectedVersion,
        ':one': 1,
        ...(machineTgt !== undefined ? { ':machineTgt': machineTgt } : {}),
      },
    });
  } catch (err) {
    await handleVersionConflictOrThrow(ctx, src, tgt, hash, expectedVersion, err, deps);
  }

  const updatedEntry: ReviewTranslationEntry = {
    ...existing,
    tgt: newTgt,
    ...(machineTgt !== undefined ? { machineTgt } : {}),
    label: 'HUMAN',
    needsReview: false,
    glossaryVersion: currentGlossaryVersion > 0 ? currentGlossaryVersion : existing.glossaryVersion,
    version: newVersion,
    updatedAt,
    updatedBy,
    GSI3PK: gsi3pk,
    GSI3SK: updatedAt,
  };

  // Gọi xóa cache chọn lọc của 3.5 qua chữ ký đã chốt
  const invalidation = await safeInvokeInvalidate(ctx, { src, tgt, hashes: [hash] }, deps);

  return {
    entry: updatedEntry,
    invalidation,
  };
}

// ============================================================================
// 4. Khôi phục bản dịch máy (RESTORE_MACHINE)
// ============================================================================

/**
 * Khôi phục câu dịch về lại bản dịch máy gần nhất (`machineTgt`), chuyển `label = 'MACHINE'`,
 * tăng `version` với khóa lạc quan và gọi xóa cache chọn lọc trên CloudFront.
 */
export async function restoreMachineTranslation(
  ctx: Ctx,
  input: RestoreMachineInput,
  deps: ReviewDependencies = defaultDependencies,
): Promise<ReviewMutationResult> {
  await assertReviewAccess(ctx, 'WRITE', deps);
  const src = validateLangCode(input.src, 'src');
  const tgt = validateLangCode(input.tgt, 'tgt');
  const hash = validateHash(input.hash);
  const expectedVersion = validateExpectedVersion(input.expectedVersion);

  const key = tmKey(ctx, src, tgt, hash);
  const existingRaw = await deps.db.get(ctx, key, { consistent: true });
  if (!existingRaw) {
    throw new AppError('NOT_FOUND', `Không tìm thấy câu dịch cần khôi phục (hash: ${hash})`);
  }

  const existing = mapRawToReviewEntry(existingRaw);
  const restoredText = (
    existing.machineTgt ??
    input.machineTgtFallback ??
    (existing.label === 'MACHINE' ? existing.tgt : '')
  ).trim();

  if (!restoredText) {
    throw new AppError(
      'INVALID_REQUEST',
      'Bản ghi không có bản dịch máy gốc (machineTgt) để khôi phục',
    );
  }

  const markerCheck = compareMarkers(existing.sourceText, restoredText);
  const needsReview = !markerCheck.restorable;
  const updatedAt = new Date(deps.now()).toISOString();
  const updatedBy = ctx.sub?.trim() || ctx.role || 'reviewer';
  const newVersion = expectedVersion + 1;
  const gsi3pk = `TENANT#${ctx.tenantId}#TM#${needsReview ? 'REVIEW' : 'MACHINE'}`;

  try {
    await deps.db.update(ctx, {
      Key: key,
      UpdateExpression:
        'SET #tgt = :tgt, #machineTgt = :tgt, #label = :machine, #nr = :nr, ' +
        '#updatedAt = :at, #updatedBy = :by, #g3pk = :g3pk, #g3sk = :at ADD #version :one',
      ConditionExpression: 'attribute_exists(PK) AND #version = :expectedVersion',
      ExpressionAttributeNames: {
        '#tgt': 'tgt',
        '#machineTgt': 'machineTgt',
        '#label': 'label',
        '#nr': 'needsReview',
        '#updatedAt': 'updatedAt',
        '#updatedBy': 'updatedBy',
        '#g3pk': 'GSI3PK',
        '#g3sk': 'GSI3SK',
        '#version': 'version',
      },
      ExpressionAttributeValues: {
        ':tgt': restoredText,
        ':machine': 'MACHINE',
        ':nr': needsReview,
        ':at': updatedAt,
        ':by': updatedBy,
        ':g3pk': gsi3pk,
        ':expectedVersion': expectedVersion,
        ':one': 1,
      },
    });
  } catch (err) {
    await handleVersionConflictOrThrow(ctx, src, tgt, hash, expectedVersion, err, deps);
  }

  const updatedEntry: ReviewTranslationEntry = {
    ...existing,
    tgt: restoredText,
    machineTgt: restoredText,
    label: 'MACHINE',
    needsReview,
    version: newVersion,
    updatedAt,
    updatedBy,
    GSI3PK: gsi3pk,
    GSI3SK: updatedAt,
  };

  const invalidation = await safeInvokeInvalidate(ctx, { src, tgt, hashes: [hash] }, deps);

  return {
    entry: updatedEntry,
    invalidation,
  };
}

// ============================================================================
// 5. Thử lại xóa cache & Tra trạng thái xóa cache CloudFront (QC-3, QC-8)
// ============================================================================

/**
 * Thử lại xóa cache chọn lọc cho một hoặc nhiều câu (`hashes`).
 * Tuân thủ QC-3 & QC-8: luôn tính lại danh sách đường dẫn từ chỉ mục `SEG` phía máy chủ,
 * tuyệt đối không nhận danh sách `paths` từ phía client.
 */
export async function retryInvalidation(
  ctx: Ctx,
  input: RetryInvalidationInput,
  deps: ReviewDependencies = defaultDependencies,
): Promise<ReviewInvalidationResult> {
  await assertReviewAccess(ctx, 'WRITE', deps);
  const src = validateLangCode(input.src, 'src');
  const tgt = validateLangCode(input.tgt, 'tgt');

  if (!Array.isArray(input.hashes) || input.hashes.length === 0 || input.hashes.length > 100) {
    throw new AppError('INVALID_REQUEST', 'Danh sách hashes cần làm mới cache phải có từ 1 đến 100 phần tử');
  }
  const hashes = [...new Set(input.hashes.map(validateHash))];

  return safeInvokeInvalidate(ctx, { src, tgt, hashes }, deps);
}

/**
 * Tra cứu trạng thái tiến trình xóa cache CloudFront (`GET /console/invalidations/{id}`, QC-8).
 */
export async function checkInvalidationStatus(
  ctx: Ctx,
  invalidationId: string,
  deps: ReviewDependencies = defaultDependencies,
): Promise<InvalidationStatus> {
  await assertReviewAccess(ctx, 'READ', deps);
  if (typeof invalidationId !== 'string' || !invalidationId.trim()) {
    throw new AppError('INVALID_REQUEST', 'Mã tiến trình xóa cache (invalidationId) không được để trống');
  }
  if (!deps.getInvalidationStatus) {
    throw new AppError('NOT_FOUND', 'Không tìm thấy tiến trình xóa cache');
  }
  return deps.getInvalidationStatus(ctx, invalidationId.trim());
}

export type { InvalidationProgress, InvalidationStatus, InvalidationSubmitStatus };

// ============================================================================
// 6. Bộ định tuyến HTTP cho các Route Console của Duyệt bản dịch (F5)
// ============================================================================

export interface ReviewHttpRequest {
  method: 'GET' | 'POST' | 'PUT';
  path: string;
  query?: Record<string, string | undefined>;
  body?: Record<string, any>;
}

/**
 * Xử lý các route `/console/translations*` và `/console/invalidations*`:
 *  - `GET /console/translations`: liệt kê danh sách câu dịch theo tab (`REVIEW`, `MACHINE`, `HUMAN`), `src`, `tgt`, `search`.
 *  - `POST /console/translations/accept`: chấp nhận nguyên bản.
 *  - `PUT /console/translations` (hoặc `POST /console/translations/publish`): lưu và xuất bản.
 *  - `POST /console/translations/restore`: khôi phục bản máy.
 *  - `POST /console/invalidations/retry`: thử lại xóa cache CloudFront từ `hashes`.
 *  - `GET /console/invalidations/{id}`: kiểm tra trạng thái xóa cache CloudFront.
 */
export async function handleReviewRoute(
  ctx: Ctx,
  req: ReviewHttpRequest,
  deps: ReviewDependencies = defaultDependencies,
): Promise<unknown> {
  const path = req.path.replace(/\/+$/, '');

  if (req.method === 'GET' && path.startsWith('/console/invalidations/')) {
    const id = decodeURIComponent(path.slice('/console/invalidations/'.length));
    return checkInvalidationStatus(ctx, id, deps);
  }

  if (req.method === 'GET' && path === '/console/translations') {
    const q = req.query ?? {};
    return listTranslations(
      ctx,
      {
        src: q.src,
        tgt: q.tgt,
        tab: q.tab as ReviewTab | undefined,
        search: q.search,
        limit: q.limit ? Number(q.limit) : undefined,
        cursor: q.cursor,
      },
      deps,
    );
  }

  const body = req.body ?? {};

  if (req.method === 'POST' && path === '/console/invalidations/retry') {
    return retryInvalidation(
      ctx,
      {
        src: String(body.src ?? ''),
        tgt: String(body.tgt ?? ''),
        hashes: Array.isArray(body.hashes) ? body.hashes : [],
      },
      deps,
    );
  }

  if (req.method === 'POST' && path === '/console/translations/accept') {
    return acceptTranslation(
      ctx,
      {
        src: String(body.src ?? ''),
        tgt: String(body.tgt ?? ''),
        hash: String(body.hash ?? ''),
        expectedVersion: Number(body.expectedVersion),
        invalidateCache: Boolean(body.invalidateCache),
      },
      deps,
    );
  }

  if (req.method === 'POST' && path === '/console/translations/restore') {
    return restoreMachineTranslation(
      ctx,
      {
        src: String(body.src ?? ''),
        tgt: String(body.tgt ?? ''),
        hash: String(body.hash ?? ''),
        expectedVersion: Number(body.expectedVersion),
        machineTgtFallback: typeof body.machineTgtFallback === 'string' ? body.machineTgtFallback : undefined,
      },
      deps,
    );
  }

  if (
    (req.method === 'PUT' && path === '/console/translations') ||
    (req.method === 'POST' && path === '/console/translations/publish')
  ) {
    const action = body.action as ReviewActionType | undefined;
    if (action === 'ACCEPT') {
      return acceptTranslation(
        ctx,
        {
          src: String(body.src ?? ''),
          tgt: String(body.tgt ?? ''),
          hash: String(body.hash ?? ''),
          expectedVersion: Number(body.expectedVersion),
          invalidateCache: Boolean(body.invalidateCache),
        },
        deps,
      );
    }
    if (action === 'RESTORE_MACHINE') {
      return restoreMachineTranslation(
        ctx,
        {
          src: String(body.src ?? ''),
          tgt: String(body.tgt ?? ''),
          hash: String(body.hash ?? ''),
          expectedVersion: Number(body.expectedVersion),
          machineTgtFallback: typeof body.machineTgtFallback === 'string' ? body.machineTgtFallback : undefined,
        },
        deps,
      );
    }
    return saveAndPublishTranslation(
      ctx,
      {
        src: String(body.src ?? ''),
        tgt: String(body.tgt ?? ''),
        hash: String(body.hash ?? ''),
        newTgt: String(body.newTgt ?? body.tgtText ?? ''),
        expectedVersion: Number(body.expectedVersion),
      },
      deps,
    );
  }

  throw new AppError('INVALID_REQUEST', `Route hoặc phương thức không được hỗ trợ: ${req.method} ${req.path}`);
}

// ============================================================================
// 7. Kết nối API Gateway Proxy Event & Lambda Handler cho `/console/*` (C6)
// ============================================================================

export interface ReviewApiGatewayEvent {
  httpMethod?: string;
  path?: string;
  rawPath?: string;
  queryStringParameters?: Record<string, string | undefined> | null;
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext?: {
    requestId?: string;
    http?: { method?: string; path?: string };
    authorizer?: {
      claims?: Record<string, unknown>;
      jwt?: { claims?: Record<string, unknown> };
    };
  };
}

export interface ReviewApiGatewayResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

const VALID_ROLES: readonly Role[] = ['TENANT_ADMIN', 'DEVELOPER', 'REVIEWER'];

/**
 * Trích xuất ngữ cảnh `Ctx` từ Cognito User Pool Authorizer claims trên API Gateway (`/console/*`).
 */
export function extractReviewCtxFromEvent(event: ReviewApiGatewayEvent): Ctx {
  const requestId = event.requestContext?.requestId ?? 'req-unknown';
  const claims =
    event.requestContext?.authorizer?.claims ??
    event.requestContext?.authorizer?.jwt?.claims ??
    {};

  const tenantId = String(claims['custom:tenant_id'] ?? claims.tenant_id ?? '').trim();
  const rawRole = String(claims['custom:role'] ?? claims.role ?? '').trim();
  const sub = String(claims.sub ?? '').trim();
  // Cognito lưu custom:role dạng chữ thường (tenant_admin, reviewer...); chuẩn hóa về Role nội bộ.
  const role: Role | null =
    roleFromClaim(rawRole) ?? (VALID_ROLES.includes(rawRole as Role) ? (rawRole as Role) : null);

  if (!tenantId || !sub || !role) {
    throw new AppError(
      'UNAUTHORIZED',
      'Phiên đăng nhập không hợp lệ hoặc thiếu thông tin xác thực (tenant_id, role, sub)',
    );
  }

  return {
    tenantId,
    role,
    sub,
    via: 'JWT',
    requestId,
  };
}

function statusForReviewError(code: string): number {
  switch (code) {
    case 'UNAUTHORIZED':
      return 401;
    case 'FORBIDDEN':
    case 'PERMISSION_DENIED':
    case 'TENANT_SUSPENDED':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'VERSION_CONFLICT':
      return 409;
    case 'INVALID_REQUEST':
    case 'PLACEHOLDER_MISMATCH':
    case 'UNSUPPORTED_LANGUAGE':
      return 400;
    default:
      return 500;
  }
}

function normalizeRoutePath(rawPath: string): string {
  const trimmed = rawPath.replace(/\/+$/, '');
  const idx = trimmed.indexOf('/console/');
  return idx >= 0 ? trimmed.slice(idx) : trimmed;
}

/**
 * Bộ định tuyến mức sự kiện API Gateway cho nhóm `/console/translations*` và `/console/invalidations*`.
 * Trả về `null` nếu đường dẫn không thuộc nhóm F5 để router chung của Console Lambda (`/console/{proxy+}`)
 * chuyển tiếp sang các mô-đun khác (`handlePrewarmRoute`, `handleGlossaryRoute`, ...).
 */
export async function handleReviewApiGatewayRoute(
  event: ReviewApiGatewayEvent,
  ctx: Ctx,
  deps: ReviewDependencies = defaultDependencies,
): Promise<ReviewApiGatewayResponse | null> {
  const rawPath = event.path ?? event.rawPath ?? event.requestContext?.http?.path ?? '';
  const path = normalizeRoutePath(rawPath);

  if (
    path !== '/console/translations' &&
    !path.startsWith('/console/translations/') &&
    !path.startsWith('/console/invalidations/')
  ) {
    return null;
  }

  const requestId = event.requestContext?.requestId ?? ctx.requestId ?? 'req-unknown';
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  };
  const respond = (statusCode: number, payload: Record<string, unknown>): ReviewApiGatewayResponse => ({
    statusCode,
    headers,
    body: JSON.stringify({ request_id: requestId, ...payload }),
  });

  const method = (event.httpMethod ?? event.requestContext?.http?.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'POST' && method !== 'PUT') {
    return respond(400, {
      error: {
        code: 'INVALID_REQUEST',
        message: `Phương thức HTTP không được hỗ trợ: ${method}`,
      },
    });
  }

  try {
    let parsedBody: Record<string, any> = {};
    if (event.body) {
      const rawBody = event.isBase64Encoded
        ? Buffer.from(event.body, 'base64').toString('utf8')
        : event.body;
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        throw new AppError('INVALID_REQUEST', 'Nội dung JSON trong yêu cầu không hợp lệ');
      }
      if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
        throw new AppError('INVALID_REQUEST', 'Nội dung yêu cầu phải là một JSON object');
      }
    }

    const result = await handleReviewRoute(
      ctx,
      {
        method,
        path,
        query: event.queryStringParameters ?? undefined,
        body: parsedBody,
      },
      deps,
    );

    const payload =
      result && typeof result === 'object' && !Array.isArray(result)
        ? (result as Record<string, unknown>)
        : { data: result };

    return respond(200, payload);
  } catch (err) {
    if (err instanceof AppError) {
      return respond(statusForReviewError(err.code), {
        error: {
          code: err.code,
          message: err.message,
          ...(err.details ? { details: err.details } : {}),
        },
      });
    }
    return respond(500, {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Lỗi tạm thời phía hệ thống, vui lòng thử lại.',
      },
    });
  }
}

/**
 * Tạo AWS Lambda handler hoàn chỉnh cho nhóm endpoint Duyệt bản dịch (`/console/translations*`, `/console/invalidations*`).
 */
export function createReviewLambdaHandler(deps: ReviewDependencies = defaultDependencies) {
  return async (event: ReviewApiGatewayEvent): Promise<ReviewApiGatewayResponse> => {
    const requestId = event.requestContext?.requestId ?? 'req-unknown';
    const headers = {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    };
    try {
      const ctx = extractReviewCtxFromEvent(event);
      const response = await handleReviewApiGatewayRoute(event, ctx, deps);
      if (!response) {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({
            request_id: requestId,
            error: { code: 'NOT_FOUND', message: 'Không tìm thấy endpoint.' },
          }),
        };
      }
      return response;
    } catch (err) {
      if (err instanceof AppError) {
        return {
          statusCode: statusForReviewError(err.code),
          headers,
          body: JSON.stringify({
            request_id: requestId,
            error: {
              code: err.code,
              message: err.message,
              ...(err.details ? { details: err.details } : {}),
            },
          }),
        };
      }
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          request_id: requestId,
          error: { code: 'INTERNAL_ERROR', message: 'Lỗi tạm thời phía hệ thống.' },
        }),
      };
    }
  };
}

/**
 * AWS Lambda entrypoint cho nhóm route `/console/translations*` và `/console/invalidations*`.
 */
export const handler = createReviewLambdaHandler();
