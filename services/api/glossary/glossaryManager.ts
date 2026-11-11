/**
 * Hạng mục 2.8 – Quản lý Thuật ngữ / Glossary (F4).
 *
 * Bám sát Hợp đồng giao diện Phần B (mục B.3, B.5, B.6, B.7) và Mục 1.3.3, 2.2.5, 2.6.5 của Báo cáo Tiến độ 2:
 *  - Bản ghi GLOSS: PK = "TENANT#<t>#GLOSS", SK = "TERM#<từ nguồn đã chuẩn hóa>".
 *  - Hai loại mục: KEEP (giữ nguyên, bản dịch mọi ngôn ngữ tự điền bằng từ nguồn)
 *    và FIXED (nhập bản dịch cho từng ngôn ngữ đích).
 *  - Nhập CSV UTF-8 (PREVIEW / COMMIT, xử lý trùng KEEP_EXISTING / OVERWRITE, giới hạn tối đa 99 dòng hợp lệ/lần
 *    để đảm bảo giao dịch nguyên tử TransactWriteItems), bắt đủ lỗi: không phải UTF-8, thiếu cột ngôn ngữ,
 *    từ nguồn trùng, ô trống.
 *  - Cập nhật `CONFIG` bằng `Update` có điều kiện (Optimistic Locking `glossaryVersion = :old AND #st <> :locked`)
 *    để không ghi đè toàn bộ `CONFIG` và chặn race condition khi hai admin sửa đồng thời hoặc tenant vừa bị khóa.
 *  - Đồng bộ lên Amazon Translate qua `ImportTerminology` (`MergeStrategy = OVERWRITE`) từ danh sách thuật ngữ
 *    trong bộ nhớ (không đọc lại sau ghi), và chỉ cập nhật `CONFIG.terminologyName` sau khi `ImportTerminology` thành công.
 *  - Phần đọc dùng chung (`getGlossaryState`, `isStale`, `postCheckGlossary`, `terminologyNameOf`, ...) được đặt tại
 *    `libs/common/glossary.ts` và re-export tại đây để tương thích với các caller hiện hữu.
 */

import {
  ImportTerminologyCommand,
  TranslateClient,
  type ImportTerminologyCommandOutput,
} from '@aws-sdk/client-translate';
import { db, requireRole } from '../../../libs/common/db.js';
import {
  getInvalidationStatus as getCloudFrontInvalidationStatus,
  invalidateForSitesSubmitOnly,
  type InvalidationStatus,
  type SiteInvalidationResult,
} from '../../../libs/common/invalidation.js';
import {
  cleanTermText,
  clearGlossaryCache,
  containsTermInText,
  DEFAULT_TARGET_LANGUAGES,
  getGlossaryState,
  GLOSSARY_CACHE_TTL_MS,
  isStale,
  normalizeTerm,
  postCheckGlossary,
  stripTagsAndMarkers,
  SUPPORTED_GLOSSARY_LANGUAGES,
  terminologyNameOf,
  type GlossaryReadDependencies,
  type GlossaryState,
  type GlossaryTermEntry,
  type GlossaryTermType,
} from '../../../libs/common/glossary.js';
import { AppError, keys, type Ctx, type Lang } from '../../../libs/common/types.js';

export {
  cleanTermText,
  clearGlossaryCache,
  containsTermInText,
  DEFAULT_TARGET_LANGUAGES,
  getGlossaryState,
  GLOSSARY_CACHE_TTL_MS,
  isStale,
  normalizeTerm,
  postCheckGlossary,
  stripTagsAndMarkers,
  SUPPORTED_GLOSSARY_LANGUAGES,
  terminologyNameOf,
  type GlossaryReadDependencies,
  type GlossaryState,
  type GlossaryTermEntry,
  type GlossaryTermType,
};

const TABLE_NAME = process.env.TABLE_NAME || 'translate-data';

/**
 * Số dòng hợp lệ tối đa trong một lần nhập CSV (1 Update CONFIG + 99 Put GLOSS = 100 mục
 * trong một giao dịch nguyên tử TransactWriteItems của DynamoDB).
 */
export const MAX_CSV_IMPORT_ROWS = 99;

// ============================================================================
// Kiểu dữ liệu cho các thao tác Ghi & Route Quản trị (B.6, B.7)
// ============================================================================

export interface PutTermInput {
  /** Từ nguồn (ví dụ: "Homestay ABC" hoặc "phố cổ Hội An") */
  sourceTerm: string;
  /** Ngôn ngữ nguồn (mặc định: ngôn ngữ nguồn của tenant hoặc "vi") */
  sourceLang?: Lang;
  /** Loại mục: KEEP (Giữ nguyên) hoặc FIXED (Dịch cố định) */
  type: GlossaryTermType;
  /** Bản dịch theo từng ngôn ngữ đích (với KEEP sẽ tự động điền bằng chính sourceTerm) */
  translations?: Record<Lang, string>;
  /** Danh sách ngôn ngữ đích cần điền tự động cho loại KEEP */
  targetLangs?: Lang[];
}

export interface ImportCsvErrorItem {
  row: number;
  reason: string;
}

export interface ImportCsvResult {
  validRows: number;
  errors: ImportCsvErrorItem[];
  duplicates: { term: string }[];
  addedCount: number;
  overwrittenCount: number;
  skippedCount: number;
  version: number;
  terminologySynced?: boolean;
  cacheInvalidation?: GlossaryCacheInvalidationResult;
}

export type GlossaryCacheInvalidationResult =
  | SiteInvalidationResult
  | { status: 'FAILED'; error: string; paths: string[]; mode: 'WILDCARD'; invalidationIds: string[]; failedPaths: string[] };

export interface TranslateTerminologyClient {
  send(
    command: ImportTerminologyCommand,
  ): Promise<Pick<ImportTerminologyCommandOutput, 'TerminologyProperties'> | Record<string, unknown>>;
}

export interface GlossaryDependencies {
  db: Pick<typeof db, 'get' | 'put' | 'query' | 'transact' | 'listTenantSites'> & Partial<Pick<typeof db, 'update'>>;
  translateClient: TranslateTerminologyClient;
  now: () => number;
  invalidateSites?: typeof invalidateForSitesSubmitOnly;
  getInvalidationStatus?: typeof getCloudFrontInvalidationStatus;
}

let defaultTranslateClient: TranslateClient | undefined;
function getDefaultTranslateClient(): TranslateClient {
  if (!defaultTranslateClient) {
    defaultTranslateClient = new TranslateClient({});
  }
  return defaultTranslateClient;
}

const defaultDependencies: GlossaryDependencies = {
  db,
  translateClient: {
    send: (cmd) => getDefaultTranslateClient().send(cmd),
  },
  now: () => Date.now(),
  invalidateSites: invalidateForSitesSubmitOnly,
  getInvalidationStatus: getCloudFrontInvalidationStatus,
};

async function invalidateGlossarySites(
  ctx: Ctx,
  deps: GlossaryDependencies,
  onlySlugs?: readonly string[],
): Promise<GlossaryCacheInvalidationResult> {
  let paths: string[] = [];
  try {
    const sites = await deps.db.listTenantSites(ctx);
    const activeSlugs = sites
      .filter((site) => site.status === 'ACTIVE' && typeof site.SK === 'string' && site.SK.startsWith('HOST#'))
      .map((site) => String(site.SK).slice('HOST#'.length));
    const requestedSlugs = onlySlugs ? new Set(onlySlugs) : undefined;
    const slugs = requestedSlugs ? activeSlugs.filter((slug) => requestedSlugs.has(slug)) : activeSlugs;
    paths = slugs.map((slug) => `/${slug}/*`);
    return await (deps.invalidateSites ?? invalidateForSitesSubmitOnly)(ctx, { slugs });
  } catch (error) {
    // A cache refresh must not undo a glossary commit.
    console.error(JSON.stringify({
      level: 'ERROR',
      step: 'glossary_cache_invalidation_failed',
      tenantId: ctx.tenantId,
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
    return {
      status: 'FAILED',
      error: error instanceof Error ? error.message : 'Unknown error',
      paths,
      mode: 'WILDCARD',
      invalidationIds: [],
      failedPaths: paths,
    };
  }
}

/** Re-submit a glossary cache refresh without changing glossary data or version. */
export async function retryGlossaryCacheInvalidation(
  ctx: Ctx,
  failedPaths: readonly string[],
  deps: GlossaryDependencies = defaultDependencies,
): Promise<GlossaryCacheInvalidationResult> {
  const failedSlugs = failedPaths.flatMap((path) => {
    const match = /^\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\/\*$/.exec(path);
    return match ? [match[1]] : [];
  });
  return invalidateGlossarySites(ctx, deps, [...new Set(failedSlugs)]);
}

export async function getGlossaryCacheInvalidationStatus(
  ctx: Ctx,
  id: string,
  deps: GlossaryDependencies = defaultDependencies,
): Promise<InvalidationStatus> {
  return (deps.getInvalidationStatus ?? getCloudFrontInvalidationStatus)(ctx, id);
}

// ============================================================================
// Đọc danh sách hiệu lực cho màn hình Quản lý Thuật ngữ (listGlossary)
// ============================================================================

/**
 * Trả về danh sách các mục thuật ngữ đang hiệu lực (không gồm các mục đã xóa) cho màn hình Quản lý Thuật ngữ.
 */
export async function listGlossary(
  ctx: Ctx,
  deps: GlossaryDependencies = defaultDependencies,
): Promise<{
  version: number;
  terminologyName: string | null;
  terms: GlossaryTermEntry[];
}> {
  const state = await getGlossaryState(ctx, deps);
  const activeTerms: GlossaryTermEntry[] = state.terms
    .filter((t) => !t.deleted)
    .map((t) => ({
      normalized: t.normalized,
      sourceTerm: t.sourceTerm ?? t.normalized,
      sourceLang: t.sourceLang ?? 'vi',
      type: t.type,
      translations: t.translations ?? {},
      sinceVersion: t.sinceVersion,
    }));

  return {
    version: state.version,
    terminologyName: state.terminologyName,
    terms: activeTerms,
  };
}

// ============================================================================
// Đọc cấu hình ngôn ngữ của Tenant từ HOST# / CONFIG & Đọc GLOSS nhất quán mạnh
// ============================================================================

interface TenantLanguageProfile {
  /** Ngôn ngữ nguồn đã được thiết lập ở HOST# hoặc các thuật ngữ hiện có (null nếu chưa có) */
  establishedSourceLang: Lang | null;
  /** Tập hợp ngôn ngữ đích cấu hình ở các website HOST# (hoặc DEFAULT_TARGET_LANGUAGES nếu chưa có website) */
  configuredTargetLangs: Lang[];
}

async function loadTenantLanguageProfile(
  ctx: Ctx,
  config: Record<string, any>,
  activeTerms: readonly GlossaryTermEntry[],
  deps: GlossaryDependencies,
): Promise<TenantLanguageProfile> {
  const hostItems = await deps.db.query(ctx, `TENANT#${ctx.tenantId}`, 'HOST#');
  let establishedSourceLang: Lang | null =
    typeof config.sourceLang === 'string' && config.sourceLang.trim() !== ''
      ? cleanTermText(config.sourceLang).toLowerCase()
      : null;

  const targetLangSet = new Set<string>();

  for (const host of hostItems) {
    if (!establishedSourceLang && typeof host.sourceLang === 'string' && host.sourceLang.trim() !== '') {
      establishedSourceLang = cleanTermText(host.sourceLang).toLowerCase();
    }
    if (Array.isArray(host.targetLangs)) {
      for (const rawLang of host.targetLangs) {
        const lang = cleanTermText(String(rawLang)).toLowerCase();
        if (lang && (SUPPORTED_GLOSSARY_LANGUAGES as readonly string[]).includes(lang)) {
          targetLangSet.add(lang);
        }
      }
    }
  }

  if (!establishedSourceLang && activeTerms.length > 0) {
    establishedSourceLang = activeTerms[0].sourceLang || 'vi';
  }

  const configuredTargetLangs =
    targetLangSet.size > 0 ? Array.from(targetLangSet) : [...DEFAULT_TARGET_LANGUAGES];

  return {
    establishedSourceLang,
    configuredTargetLangs,
  };
}

async function loadExistingGlossaryEntriesConsistent(
  ctx: Ctx,
  deps: GlossaryDependencies,
): Promise<Map<string, GlossaryTermEntry>> {
  const glossPk = `TENANT#${ctx.tenantId}#GLOSS`;
  const rawItems = await deps.db.query(ctx, glossPk, 'TERM#', { consistent: true });
  const map = new Map<string, GlossaryTermEntry>();

  for (const item of rawItems) {
    const normalized = String(item.normalized ?? String(item.SK ?? '').replace(/^TERM#/, ''));
    if (!normalized) continue;
    map.set(normalized, {
      normalized,
      sourceTerm: typeof item.sourceTerm === 'string' ? item.sourceTerm : normalized,
      sourceLang: typeof item.sourceLang === 'string' ? item.sourceLang : 'vi',
      type: item.type === 'KEEP' ? 'KEEP' : 'FIXED',
      translations:
        item.translations && typeof item.translations === 'object' ? { ...item.translations } : {},
      sinceVersion: Number(item.sinceVersion ?? 1),
      deleted: Boolean(item.deleted),
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : undefined,
    });
  }

  return map;
}

// ============================================================================
// Đồng bộ CSV lên Amazon Translate (ImportTerminology) & Cập nhật terminologyName an toàn
// ============================================================================

function escapeCsvCell(val: string): string {
  if (/[",\r\n]/.test(val)) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

/**
 * Tạo nội dung tệp CSV UTF-8 chuẩn của Amazon Translate từ danh sách các mục thuật ngữ đang hiệu lực.
 *  - Dòng đầu tiên là mã ngôn ngữ (cột đầu là ngôn ngữ nguồn, các cột sau là ngôn ngữ đích).
 *  - Đảm bảo mọi mục trong tenant có cùng `sourceLang`.
 *  - Với các mục KEEP, tự động điền từ nguồn cho mọi ngôn ngữ đích của tenant (bao gồm cả cấu hình HOST# như fr, de, es).
 */
export function buildTenantTerminologyCsv(
  activeTerms: readonly GlossaryTermEntry[],
  configuredTargetLangs: readonly Lang[] = DEFAULT_TARGET_LANGUAGES,
): string | null {
  if (activeTerms.length === 0) return null;

  const sourceLang = cleanTermText(activeTerms[0].sourceLang || 'vi').toLowerCase() || 'vi';
  const targetLangSet = new Set<string>();

  for (const term of activeTerms) {
    const termSourceLang = cleanTermText(term.sourceLang || 'vi').toLowerCase() || 'vi';
    if (termSourceLang !== sourceLang) {
      throw new AppError(
        'INVALID_REQUEST',
        `Ngôn ngữ nguồn của thuật ngữ '${term.sourceTerm}' (${termSourceLang}) không khớp với ngôn ngữ nguồn của tenant (${sourceLang})`,
      );
    }

    if (term.type === 'KEEP') {
      for (const l of configuredTargetLangs) {
        if (l && l !== sourceLang) targetLangSet.add(l);
      }
      for (const l of DEFAULT_TARGET_LANGUAGES) {
        if (l && l !== sourceLang) targetLangSet.add(l);
      }
    }

    for (const [lang, text] of Object.entries(term.translations ?? {})) {
      if (lang !== sourceLang && typeof text === 'string' && text.trim() !== '') {
        targetLangSet.add(lang);
      }
    }
  }

  const targetLangs = Array.from(targetLangSet);
  if (targetLangs.length === 0) {
    for (const l of configuredTargetLangs.length > 0 ? configuredTargetLangs : DEFAULT_TARGET_LANGUAGES) {
      if (l !== sourceLang) targetLangs.push(l);
    }
  }

  const header = [sourceLang, ...targetLangs].map(escapeCsvCell).join(',');
  const rows: string[] = [header];

  for (const term of activeTerms) {
    const cells: string[] = [term.sourceTerm];
    for (const tgtLang of targetLangs) {
      if (term.type === 'KEEP') {
        cells.push(term.sourceTerm);
      } else {
        const translated = term.translations?.[tgtLang]?.trim();
        cells.push(translated ?? '');
      }
    }
    rows.push(cells.map(escapeCsvCell).join(','));
  }

  return rows.join('\n') + '\n';
}

async function markTerminologySyncedOnConfig(
  ctx: Ctx,
  terminologyName: string | null,
  syncedVersion: number,
  deps: GlossaryDependencies,
): Promise<void> {
  const updatedAt = new Date(deps.now()).toISOString();
  const updateParams = {
    UpdateExpression:
      'SET terminologyName = :tname, terminologySyncedVersion = :v, updatedAt = :now',
    ConditionExpression:
      'attribute_exists(PK) AND (attribute_not_exists(terminologySyncedVersion) OR terminologySyncedVersion < :v)',
    ExpressionAttributeValues: {
      ':tname': terminologyName,
      ':v': syncedVersion,
      ':now': updatedAt,
    },
  };

  try {
    if (typeof deps.db.update === 'function') {
      await deps.db.update(ctx, { Key: keys.config(ctx), ...updateParams });
    } else {
      await deps.db.transact(ctx, [
        {
          Update: {
            TableName: TABLE_NAME,
            Key: keys.config(ctx),
            ...updateParams,
          },
        },
      ]);
    }
  } catch (err: any) {
    if (
      err?.name === 'ConditionalCheckFailedException' ||
      err?.name === 'TransactionCanceledException'
    ) {
      // Đã có một phiên bản mới hơn cập nhật terminologySyncedVersion -> bỏ qua an toàn
      return;
    }
    throw err;
  }
}

async function syncTerminologyToTranslate(
  ctx: Ctx,
  activeTerms: readonly GlossaryTermEntry[],
  newVersion: number,
  configuredTargetLangs: readonly Lang[],
  deps: GlossaryDependencies,
): Promise<boolean> {
  const csv = buildTenantTerminologyCsv(activeTerms, configuredTargetLangs);
  if (!csv) {
    // Khi không còn thuật ngữ hiệu lực nào -> xóa terminologyName trên CONFIG (đặt về null)
    // để F2/F9/F10 không truyền TerminologyNames vào TranslateText.
    await markTerminologySyncedOnConfig(ctx, null, newVersion, deps);
    clearGlossaryCache(ctx.tenantId);
    return true;
  }

  const targetName = terminologyNameOf(ctx);
  try {
    await deps.translateClient.send(
      new ImportTerminologyCommand({
        Name: targetName,
        MergeStrategy: 'OVERWRITE',
        Description: `Custom Terminology for tenant ${ctx.tenantId}`,
        TerminologyData: {
          File: Buffer.from(csv, 'utf8'),
          Format: 'CSV',
        },
      }),
    );
  } catch (err: any) {
    // Nếu ImportTerminology lỗi: ghi log có cấu trúc, KHÔNG gán terminologyName mới lên CONFIG
    // để tránh F2/F9/F10 gọi TranslateText với một terminology chưa tồn tại (ResourceNotFoundException).
    console.error(
      JSON.stringify({
        level: 'ERROR',
        event: 'IMPORT_TERMINOLOGY_FAILED',
        tenantId: ctx.tenantId,
        version: newVersion,
        terminologyName: targetName,
        error: err?.message ?? String(err),
      }),
    );
    clearGlossaryCache(ctx.tenantId);
    return false;
  }

  await markTerminologySyncedOnConfig(ctx, targetName, newVersion, deps);
  clearGlossaryCache(ctx.tenantId);
  return true;
}

// ============================================================================
// Kiểm tra CONFIG & Giao dịch Optimistic Locking (Mục 2 Review PR #15)
// ============================================================================

async function loadConfigAndAssertWritable(
  ctx: Ctx,
  deps: GlossaryDependencies,
): Promise<Record<string, any>> {
  const config = await deps.db.get(ctx, keys.config(ctx));
  if (!config) {
    throw new AppError('NOT_FOUND', 'Không tìm thấy cấu hình tenant');
  }
  if (config.status === 'LOCKED') {
    throw new AppError(
      'TENANT_SUSPENDED',
      'Tenant đang bị tạm khóa, không thể thay đổi bảng thuật ngữ',
    );
  }
  return config;
}

function buildConfigVersionUpdateOp(
  ctx: Ctx,
  oldVersion: number,
  newVersion: number,
  updatedAt: string,
) {
  return {
    Update: {
      TableName: TABLE_NAME,
      Key: keys.config(ctx),
      UpdateExpression: 'SET glossaryVersion = :new, updatedAt = :now',
      ConditionExpression:
        'attribute_exists(PK) AND (attribute_not_exists(glossaryVersion) OR glossaryVersion = :old) AND #st = :active',
      ExpressionAttributeNames: {
        '#st': 'status',
      },
      ExpressionAttributeValues: {
        ':new': newVersion,
        ':old': oldVersion,
        ':now': updatedAt,
        ':active': 'ACTIVE',
      },
    },
  };
}

async function executeGlossaryTransaction(
  ctx: Ctx,
  ops: any[],
  deps: GlossaryDependencies,
): Promise<void> {
  try {
    await deps.db.transact(ctx, ops);
  } catch (err: any) {
    if (
      err?.name === 'TransactionCanceledException' ||
      err?.name === 'ConditionalCheckFailedException'
    ) {
      const latestConfig = await deps.db.get(ctx, keys.config(ctx));
      if (!latestConfig) {
        throw new AppError('NOT_FOUND', 'Không tìm thấy cấu hình tenant');
      }
      if (latestConfig.status === 'LOCKED') {
        throw new AppError(
          'TENANT_SUSPENDED',
          'Tenant đang bị tạm khóa, không thể thay đổi bảng thuật ngữ',
        );
      }
      throw new AppError(
        'VERSION_CONFLICT',
        'Bảng thuật ngữ vừa được cập nhật bởi một yêu cầu khác, vui lòng thử lại',
      );
    }
    throw err;
  }
}

// ============================================================================
// Thêm / Sửa một thuật ngữ (putTerm) & Xóa một thuật ngữ (deleteTerm)
// ============================================================================

/**
 * Thêm mới hoặc cập nhật một mục thuật ngữ (B.7).
 *  - Với loại KEEP: bản dịch ở mọi ngôn ngữ đích tự động điền bằng chính từ nguồn.
 *  - Với loại FIXED: yêu cầu bản dịch cố định cho các ngôn ngữ đích.
 *  - Tăng `glossaryVersion` ở CONFIG bằng `Update` có điều kiện (`glossaryVersion = :old AND #st <> :locked`).
 *  - Đồng bộ `ImportTerminology` từ danh sách trong bộ nhớ và chỉ ghi `terminologyName` sau khi thành công.
 */
export async function putTerm(
  ctx: Ctx,
  input: PutTermInput,
  deps: GlossaryDependencies = defaultDependencies,
): Promise<{ version: number; terminologySynced: boolean; cacheInvalidation: GlossaryCacheInvalidationResult }> {
  const cleanedSource = cleanTermText(input?.sourceTerm ?? '');
  const normalized = normalizeTerm(cleanedSource);

  if (!cleanedSource || !normalized) {
    throw new AppError('INVALID_REQUEST', 'Từ nguồn không được để trống');
  }

  if (input.type !== 'KEEP' && input.type !== 'FIXED') {
    throw new AppError('INVALID_REQUEST', 'Loại thuật ngữ phải là KEEP hoặc FIXED');
  }

  const config = await loadConfigAndAssertWritable(ctx, deps);
  const existingMap = await loadExistingGlossaryEntriesConsistent(ctx, deps);
  const currentActiveTerms = Array.from(existingMap.values()).filter((t) => !t.deleted);
  const langProfile = await loadTenantLanguageProfile(ctx, config, currentActiveTerms, deps);

  const requestedSourceLang = input.sourceLang
    ? cleanTermText(input.sourceLang).toLowerCase()
    : langProfile.establishedSourceLang ?? 'vi';

  if (!(SUPPORTED_GLOSSARY_LANGUAGES as readonly string[]).includes(requestedSourceLang)) {
    throw new AppError('UNSUPPORTED_LANGUAGE', `Ngôn ngữ nguồn không được hỗ trợ: ${requestedSourceLang}`);
  }

  if (
    langProfile.establishedSourceLang &&
    requestedSourceLang !== langProfile.establishedSourceLang
  ) {
    throw new AppError(
      'INVALID_REQUEST',
      `Ngôn ngữ nguồn '${requestedSourceLang}' không khớp với ngôn ngữ nguồn của tenant ('${langProfile.establishedSourceLang}')`,
    );
  }

  const sourceLang = requestedSourceLang;
  const translations: Record<Lang, string> = {};

  if (input.type === 'KEEP') {
    const rawTargets =
      input.targetLangs && input.targetLangs.length > 0
        ? input.targetLangs
        : input.translations && Object.keys(input.translations).length > 0
          ? Object.keys(input.translations)
          : langProfile.configuredTargetLangs.filter((l) => l !== sourceLang);

    for (const rawLang of rawTargets) {
      const lang = cleanTermText(rawLang).toLowerCase();
      if (!lang || lang === sourceLang) continue;
      if (!(SUPPORTED_GLOSSARY_LANGUAGES as readonly string[]).includes(lang)) {
        throw new AppError('UNSUPPORTED_LANGUAGE', `Ngôn ngữ đích không được hỗ trợ: ${lang}`);
      }
      translations[lang] = cleanedSource;
    }

    // Nếu các ngôn ngữ cấu hình ở HOST# chưa có trong translations của mục KEEP và người gọi không truyền targetLangs riêng
    if (!input.targetLangs || input.targetLangs.length === 0) {
      for (const lang of langProfile.configuredTargetLangs) {
        if (lang && lang !== sourceLang) {
          translations[lang] = cleanedSource;
        }
      }
    }
  } else {
    const rawTranslations = input.translations ?? {};
    const entries = Object.entries(rawTranslations);
    if (entries.length === 0) {
      throw new AppError('INVALID_REQUEST', 'Thuật ngữ loại FIXED phải có ít nhất một bản dịch đích');
    }
    for (const [rawLang, rawVal] of entries) {
      const lang = cleanTermText(rawLang).toLowerCase();
      if (!lang || lang === sourceLang) continue;
      if (!(SUPPORTED_GLOSSARY_LANGUAGES as readonly string[]).includes(lang)) {
        throw new AppError('UNSUPPORTED_LANGUAGE', `Ngôn ngữ đích không được hỗ trợ: ${lang}`);
      }
      const cleanedVal = cleanTermText(rawVal ?? '');
      if (!cleanedVal) {
        throw new AppError('INVALID_REQUEST', `Bản dịch cho ngôn ngữ '${lang}' không được để trống`);
      }
      translations[lang] = cleanedVal;
    }
    if (Object.keys(translations).length === 0) {
      throw new AppError(
        'INVALID_REQUEST',
        'Thuật ngữ loại FIXED phải có ít nhất một ngôn ngữ đích khác ngôn ngữ nguồn',
      );
    }
  }

  const oldVersion = Number(config.glossaryVersion ?? 0);
  const newVersion = oldVersion + 1;
  const updatedAt = new Date(deps.now()).toISOString();
  const glossKey = keys.gloss(ctx, normalized);

  const newEntry: GlossaryTermEntry = {
    normalized,
    sourceTerm: cleanedSource,
    sourceLang,
    type: input.type,
    translations,
    sinceVersion: newVersion,
    deleted: false,
    updatedAt,
  };

  await executeGlossaryTransaction(
    ctx,
    [
      buildConfigVersionUpdateOp(ctx, oldVersion, newVersion, updatedAt),
      {
        Put: {
          TableName: TABLE_NAME,
          Item: {
            PK: glossKey.PK,
            SK: glossKey.SK,
            tenantId: ctx.tenantId,
            ...newEntry,
          },
        },
      },
    ],
    deps,
  );

  // Hợp nhất danh sách thuật ngữ hiệu lực ngay trong bộ nhớ (không query lại sau ghi)
  existingMap.set(normalized, newEntry);
  const updatedActiveTerms = Array.from(existingMap.values()).filter((t) => !t.deleted);

  clearGlossaryCache(ctx.tenantId);
  const terminologySynced = await syncTerminologyToTranslate(
    ctx,
    updatedActiveTerms,
    newVersion,
    langProfile.configuredTargetLangs,
    deps,
  );
  const cacheInvalidation = await invalidateGlossarySites(ctx, deps);

  return { version: newVersion, terminologySynced, cacheInvalidation };
}

/**
 * Xóa một mục thuật ngữ (B.7).
 *  - Tăng `glossaryVersion` ở CONFIG bằng `Update` có điều kiện.
 *  - Lưu bản ghi đánh dấu xóa (`deleted: true, sinceVersion = newVersion`) để các bản dịch MACHINE cũ
 *    có chứa từ vừa bị xóa bị `isStale()` coi là lỗi thời và dịch lại ở lần truy cập sau.
 */
export async function deleteTerm(
  ctx: Ctx,
  termOrNormalized: string,
  deps: GlossaryDependencies = defaultDependencies,
): Promise<{ version: number; terminologySynced: boolean; cacheInvalidation: GlossaryCacheInvalidationResult }> {
  const normalized = normalizeTerm(termOrNormalized);
  if (!normalized) {
    throw new AppError('INVALID_REQUEST', 'Từ thuật ngữ cần xóa không hợp lệ');
  }

  const config = await loadConfigAndAssertWritable(ctx, deps);
  const existingMap = await loadExistingGlossaryEntriesConsistent(ctx, deps);
  const existing = existingMap.get(normalized) ?? (await deps.db.get(ctx, keys.gloss(ctx, normalized))) as GlossaryTermEntry | null;

  if (!existing || existing.deleted) {
    throw new AppError('NOT_FOUND', `Không tìm thấy thuật ngữ '${termOrNormalized}'`);
  }

  const currentActiveTerms = Array.from(existingMap.values()).filter((t) => !t.deleted);
  const langProfile = await loadTenantLanguageProfile(ctx, config, currentActiveTerms, deps);

  const oldVersion = Number(config.glossaryVersion ?? 0);
  const newVersion = oldVersion + 1;
  const updatedAt = new Date(deps.now()).toISOString();
  const glossKey = keys.gloss(ctx, normalized);

  await executeGlossaryTransaction(
    ctx,
    [
      buildConfigVersionUpdateOp(ctx, oldVersion, newVersion, updatedAt),
      {
        Put: {
          TableName: TABLE_NAME,
          Item: {
            ...existing,
            PK: glossKey.PK,
            SK: glossKey.SK,
            tenantId: ctx.tenantId,
            normalized,
            sinceVersion: newVersion,
            deleted: true,
            deletedAtVersion: newVersion,
            updatedAt,
          },
        },
      },
    ],
    deps,
  );

  // Cập nhật danh sách hiệu lực ngay trong bộ nhớ
  existingMap.set(normalized, {
    ...existing,
    normalized,
    sinceVersion: newVersion,
    deleted: true,
    updatedAt,
  });
  const updatedActiveTerms = Array.from(existingMap.values()).filter((t) => !t.deleted);

  clearGlossaryCache(ctx.tenantId);
  const terminologySynced = await syncTerminologyToTranslate(
    ctx,
    updatedActiveTerms,
    newVersion,
    langProfile.configuredTargetLangs,
    deps,
  );
  const cacheInvalidation = await invalidateGlossarySites(ctx, deps);

  return { version: newVersion, terminologySynced, cacheInvalidation };
}

// ============================================================================
// Nhập tệp CSV UTF-8 (importCsv: PREVIEW & COMMIT - Mục 1.3.3, 2.6.5 & B.7)
// ============================================================================

/** Giải mã và kiểm tra nghiêm ngặt định dạng UTF-8 (chấp nhận BOM). */
export function decodeUtf8Csv(input: string | Uint8Array | Buffer): string {
  let text: string;
  if (typeof input === 'string') {
    if (input.includes('\uFFFD')) {
      throw new AppError('INVALID_REQUEST', 'Tệp không mã hóa UTF-8 hợp lệ');
    }
    text = input;
  } else if (input instanceof Uint8Array || Buffer.isBuffer(input)) {
    try {
      const decoder = new TextDecoder('utf-8', { fatal: true });
      text = decoder.decode(input);
    } catch {
      throw new AppError('INVALID_REQUEST', 'Tệp không mã hóa UTF-8 hợp lệ');
    }
  } else {
    throw new AppError('INVALID_REQUEST', 'Nội dung tệp CSV không hợp lệ');
  }

  if (text.startsWith('\uFEFF')) {
    text = text.slice(1);
  }
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(text)) {
    throw new AppError('INVALID_REQUEST', 'Tệp chứa ký tự nhị phân không hợp lệ (không phải văn bản UTF-8)');
  }
  return text;
}

/** Tách một dòng CSV theo chuẩn RFC 4180 (hỗ trợ ô bọc trong dấu ngoặc kép). */
export function parseCsvLine(line: string): string[] | null {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      if (current.trim() !== '') {
        current += ch;
      } else {
        inQuotes = true;
      }
    } else if (ch === ',') {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }

  if (inQuotes) return null;
  cells.push(current);
  return cells;
}

/**
 * Nhập bảng thuật ngữ từ tệp CSV UTF-8 (B.7 & Mục 2.6.5).
 *  - Dòng đầu là các mã ngôn ngữ (`vi,en,ko,ja`), cột đầu là ngôn ngữ nguồn.
 *  - Giới hạn tối đa 99 dòng hợp lệ mỗi lần nhập để toàn bộ thao tác COMMIT nằm gọn trong
 *    1 giao dịch nguyên tử `TransactWriteItems` (1 Update CONFIG + tối đa 99 Put GLOSS = 100 mục).
 */
export async function importCsv(
  ctx: Ctx,
  csvInput: string | Uint8Array | Buffer,
  mode: 'PREVIEW' | 'COMMIT',
  onDuplicate: 'KEEP_EXISTING' | 'OVERWRITE' = 'OVERWRITE',
  deps: GlossaryDependencies = defaultDependencies,
): Promise<ImportCsvResult> {
  const csvText = decodeUtf8Csv(csvInput);
  const rawLines = csvText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  while (rawLines.length > 0 && rawLines[rawLines.length - 1].trim() === '') {
    rawLines.pop();
  }

  if (rawLines.length === 0) {
    throw new AppError('INVALID_REQUEST', 'Tệp CSV rỗng');
  }

  const headerCells = parseCsvLine(rawLines[0]);
  if (!headerCells || headerCells.length < 2) {
    throw new AppError(
      'INVALID_REQUEST',
      'Dòng đầu tiên của CSV phải gồm mã ngôn ngữ nguồn và ít nhất một mã ngôn ngữ đích',
    );
  }

  const langColumns = headerCells.map((c) => cleanTermText(c).toLowerCase());
  const seenLangs = new Set<string>();
  for (const lang of langColumns) {
    if (!lang) {
      throw new AppError('INVALID_REQUEST', 'Thiếu mã ngôn ngữ ở dòng tiêu đề CSV');
    }
    if (!(SUPPORTED_GLOSSARY_LANGUAGES as readonly string[]).includes(lang)) {
      throw new AppError('UNSUPPORTED_LANGUAGE', `Mã ngôn ngữ trong tiêu đề CSV không được hỗ trợ: '${lang}'`);
    }
    if (seenLangs.has(lang)) {
      throw new AppError('INVALID_REQUEST', `Cột ngôn ngữ '${lang}' bị lặp lại ở dòng tiêu đề CSV`);
    }
    seenLangs.add(lang);
  }

  const sourceLang = langColumns[0];
  const targetLangs = langColumns.slice(1);

  const config = await loadConfigAndAssertWritable(ctx, deps);
  const fullExistingMap = await loadExistingGlossaryEntriesConsistent(ctx, deps);
  const activeExistingMap = new Map<string, GlossaryTermEntry>();
  for (const [k, item] of fullExistingMap.entries()) {
    if (!item.deleted) {
      activeExistingMap.set(k, item);
    }
  }

  const langProfile = await loadTenantLanguageProfile(
    ctx,
    config,
    Array.from(activeExistingMap.values()),
    deps,
  );

  if (
    langProfile.establishedSourceLang &&
    sourceLang !== langProfile.establishedSourceLang
  ) {
    throw new AppError(
      'INVALID_REQUEST',
      `Ngôn ngữ nguồn trong CSV ('${sourceLang}') không khớp với ngôn ngữ nguồn của tenant ('${langProfile.establishedSourceLang}')`,
    );
  }

  const oldVersion = Number(config.glossaryVersion ?? 0);
  const errors: ImportCsvErrorItem[] = [];
  const duplicates: { term: string }[] = [];
  const parsedEntries: GlossaryTermEntry[] = [];
  const seenInFile = new Set<string>();

  for (let i = 1; i < rawLines.length; i++) {
    const rowNumber = i + 1;
    const rawLine = rawLines[i];
    if (rawLine.trim() === '') {
      errors.push({ row: rowNumber, reason: 'Dòng trống' });
      continue;
    }

    const cells = parseCsvLine(rawLine);
    if (!cells) {
      errors.push({ row: rowNumber, reason: 'Cú pháp CSV không hợp lệ (dấu ngoặc kép chưa đóng)' });
      continue;
    }

    if (cells.length < langColumns.length) {
      const missingCol = langColumns[cells.length];
      errors.push({ row: rowNumber, reason: `Thiếu cột '${missingCol}'` });
      continue;
    }
    if (cells.length > langColumns.length) {
      errors.push({ row: rowNumber, reason: 'Thừa cột dữ liệu so với dòng tiêu đề' });
      continue;
    }

    const sourceTerm = cleanTermText(cells[0]);
    const normalized = normalizeTerm(sourceTerm);
    if (!sourceTerm || !normalized) {
      errors.push({ row: rowNumber, reason: `Ô từ nguồn (${sourceLang}) bị trống` });
      continue;
    }

    const translations: Record<Lang, string> = {};
    let emptyTargetCol: string | null = null;
    for (let colIdx = 1; colIdx < langColumns.length; colIdx++) {
      const tgtLang = langColumns[colIdx];
      const val = cleanTermText(cells[colIdx]);
      if (!val) {
        emptyTargetCol = tgtLang;
        break;
      }
      translations[tgtLang] = val;
    }

    if (emptyTargetCol) {
      errors.push({ row: rowNumber, reason: `Ô trống ở cột ngôn ngữ '${emptyTargetCol}'` });
      continue;
    }

    if (seenInFile.has(normalized)) {
      errors.push({ row: rowNumber, reason: `Trùng từ nguồn '${sourceTerm}' trong tệp CSV` });
      continue;
    }
    seenInFile.add(normalized);

    const isKeep = targetLangs.every((l) => translations[l] === sourceTerm);
    const termType: GlossaryTermType = isKeep ? 'KEEP' : 'FIXED';

    if (activeExistingMap.has(normalized)) {
      duplicates.push({ term: sourceTerm });
    }

    parsedEntries.push({
      normalized,
      sourceTerm,
      sourceLang,
      type: termType,
      translations,
      sinceVersion: oldVersion + 1,
    });
  }

  if (parsedEntries.length > MAX_CSV_IMPORT_ROWS) {
    throw new AppError(
      'INVALID_REQUEST',
      `Mỗi lần nhập CSV chỉ cho phép tối đa ${MAX_CSV_IMPORT_ROWS} dòng hợp lệ (tệp hiện có ${parsedEntries.length} dòng hợp lệ)`,
    );
  }

  let addedCount = 0;
  let overwrittenCount = 0;
  let skippedCount = 0;
  const itemsToSave: GlossaryTermEntry[] = [];

  for (const entry of parsedEntries) {
    if (activeExistingMap.has(entry.normalized)) {
      if (onDuplicate === 'KEEP_EXISTING') {
        skippedCount++;
      } else {
        overwrittenCount++;
        itemsToSave.push(entry);
      }
    } else {
      addedCount++;
      itemsToSave.push(entry);
    }
  }

  if (mode === 'PREVIEW') {
    return {
      validRows: parsedEntries.length,
      errors,
      duplicates,
      addedCount,
      overwrittenCount,
      skippedCount,
      version: oldVersion,
    };
  }

  if (itemsToSave.length === 0) {
    return {
      validRows: parsedEntries.length,
      errors,
      duplicates,
      addedCount: 0,
      overwrittenCount: 0,
      skippedCount,
      version: oldVersion,
      terminologySynced: true,
    };
  }

  const newVersion = oldVersion + 1;
  const updatedAt = new Date(deps.now()).toISOString();

  const glossPutOps = itemsToSave.map((item) => {
    const glossKey = keys.gloss(ctx, item.normalized);
    return {
      Put: {
        TableName: TABLE_NAME,
        Item: {
          PK: glossKey.PK,
          SK: glossKey.SK,
          tenantId: ctx.tenantId,
          normalized: item.normalized,
          sourceTerm: item.sourceTerm,
          sourceLang: item.sourceLang,
          type: item.type,
          translations: item.translations,
          sinceVersion: newVersion,
          deleted: false,
          updatedAt,
        },
      },
    };
  });

  // Giao dịch nguyên tử duy nhất (1 Update CONFIG + tối đa 99 Put GLOSS <= 100 mục)
  await executeGlossaryTransaction(
    ctx,
    [
      buildConfigVersionUpdateOp(ctx, oldVersion, newVersion, updatedAt),
      ...glossPutOps,
    ],
    deps,
  );

  for (const item of itemsToSave) {
    activeExistingMap.set(item.normalized, {
      ...item,
      sinceVersion: newVersion,
      deleted: false,
      updatedAt,
    });
  }

  const updatedActiveTerms = Array.from(activeExistingMap.values());
  clearGlossaryCache(ctx.tenantId);

  const terminologySynced = await syncTerminologyToTranslate(
    ctx,
    updatedActiveTerms,
    newVersion,
    langProfile.configuredTargetLangs,
    deps,
  );
  const cacheInvalidation = await invalidateGlossarySites(ctx, deps);

  return {
    validRows: parsedEntries.length,
    errors,
    duplicates,
    addedCount,
    overwrittenCount,
    skippedCount,
    version: newVersion,
    terminologySynced,
    cacheInvalidation,
  };
}

// ============================================================================
// Bộ định tuyến HTTP cho các Route Console của Thuật ngữ (B.6 Phần B)
// ============================================================================

export interface GlossaryHttpRequest {
  method: 'GET' | 'PUT' | 'DELETE' | 'POST';
  path: string;
  termParam?: string;
  body?: Record<string, any>;
}

function decodeTermPathParam(raw?: string): string {
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Xử lý các route `/console/glossary*` theo đúng bảng phân quyền B.6:
 *  - `GET /console/glossary` (hoặc `/console/glossary/terms`): cho phép `TENANT_ADMIN`, `DEVELOPER`, `REVIEWER`.
 *  - `PUT /console/glossary/terms/{term}`: chỉ `TENANT_ADMIN`.
 *  - `DELETE /console/glossary/terms/{term}`: chỉ `TENANT_ADMIN`.
 *  - `POST /console/glossary/import/preview`: cho phép các role được phép đọc glossary.
 *  - `POST /console/glossary/import` (commit): chỉ `TENANT_ADMIN`.
 */
export async function handleGlossaryRoute(
  ctx: Ctx,
  req: GlossaryHttpRequest,
  deps: GlossaryDependencies = defaultDependencies,
): Promise<unknown> {
  const statusPrefix = '/console/glossary/cache-invalidation/';
  if (req.method === 'GET' && req.path.startsWith(statusPrefix)) {
    requireRole(ctx, ['TENANT_ADMIN']);
    const id = req.path.slice(statusPrefix.length);
    if (!id || id === 'retry' || id.includes('/')) throw new AppError('NOT_FOUND', 'Không tìm thấy lần làm mới');
    return getGlossaryCacheInvalidationStatus(ctx, id, deps);
  }

  if (req.method === 'GET') {
    requireRole(ctx, ['TENANT_ADMIN', 'DEVELOPER', 'REVIEWER']);
    return listGlossary(ctx, deps);
  }

  if (req.method === 'PUT') {
    requireRole(ctx, ['TENANT_ADMIN']);
    const body = req.body ?? {};
    const paramFromPath = req.path.startsWith('/console/glossary/terms/')
      ? req.path.slice('/console/glossary/terms/'.length)
      : '';
    const decodedPathTerm = decodeTermPathParam(req.termParam ?? paramFromPath);
    const bodySourceTerm = typeof body.sourceTerm === 'string' ? body.sourceTerm : '';

    if (
      decodedPathTerm &&
      bodySourceTerm &&
      normalizeTerm(decodedPathTerm) !== normalizeTerm(bodySourceTerm)
    ) {
      throw new AppError(
        'INVALID_REQUEST',
        `Từ nguồn trên đường dẫn ('${decodedPathTerm}') và trong body ('${bodySourceTerm}') không khớp`,
      );
    }

    const sourceTerm = bodySourceTerm || decodedPathTerm;
    return putTerm(
      ctx,
      {
        sourceTerm,
        sourceLang: body.sourceLang,
        type: body.type,
        translations: body.translations,
        targetLangs: body.targetLangs,
      },
      deps,
    );
  }

  if (req.method === 'DELETE') {
    requireRole(ctx, ['TENANT_ADMIN']);
    const paramFromPath = req.path.startsWith('/console/glossary/terms/')
      ? req.path.slice('/console/glossary/terms/'.length)
      : '';
    const termToDelete =
      decodeTermPathParam(req.termParam ?? paramFromPath) ||
      String(req.body?.sourceTerm ?? req.body?.term ?? '');
    return deleteTerm(ctx, termToDelete, deps);
  }

  if (req.method === 'POST') {
    if (req.path === '/console/glossary/cache-invalidation/retry') {
      requireRole(ctx, ['TENANT_ADMIN']);
      const failedPaths = Array.isArray(req.body?.failedPaths)
        ? req.body.failedPaths.filter((path): path is string => typeof path === 'string')
        : [];
      return retryGlossaryCacheInvalidation(ctx, failedPaths, deps);
    }
    const body = req.body ?? {};
    const csv = body.csv ?? '';
    const isPreviewPath = req.path.endsWith('/preview');
    const mode: 'PREVIEW' | 'COMMIT' =
      isPreviewPath || body.mode === 'PREVIEW' ? 'PREVIEW' : 'COMMIT';
    requireRole(
      ctx,
      mode === 'PREVIEW'
        ? ['TENANT_ADMIN', 'DEVELOPER', 'REVIEWER']
        : ['TENANT_ADMIN'],
    );
    const onDuplicate: 'KEEP_EXISTING' | 'OVERWRITE' =
      body.onDuplicate === 'KEEP_EXISTING' ? 'KEEP_EXISTING' : 'OVERWRITE';
    return importCsv(ctx, csv, mode, onDuplicate, deps);
  }

  throw new AppError('INVALID_REQUEST', `Phương thức HTTP không được hỗ trợ: ${req.method}`);
}
