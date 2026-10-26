/**
 * Hạng mục 2.8 – Quản lý Thuật ngữ / Glossary (F4).
 *
 * Bám sát Hợp đồng giao diện Phần B (mục B.3, B.6, B.7) và Mục 1.3.3, 2.2.5, 2.6.5 của Báo cáo Tiến độ 2:
 *  - Bản ghi GLOSS: PK = "TENANT#<t>#GLOSS", SK = "TERM#<từ nguồn đã chuẩn hóa>".
 *  - Hai loại mục: KEEP (giữ nguyên, bản dịch mọi ngôn ngữ tự điền bằng từ nguồn)
 *    và FIXED (nhập bản dịch cho từng ngôn ngữ đích).
 *  - Nhập CSV UTF-8 (PREVIEW / COMMIT, xử lý trùng KEEP_EXISTING / OVERWRITE),
 *    bắt đủ lỗi: không phải UTF-8, thiếu cột ngôn ngữ, từ nguồn trùng, ô trống.
 *  - Tăng `glossaryVersion` ở CONFIG mỗi lần lưu, ghi `sinceVersion` cho các mục thay đổi.
 *  - Khi xóa mục (`deleteTerm`), lưu đánh dấu phiên bản xóa (`deleted: true, sinceVersion = newVersion`)
 *    để các bản dịch MACHINE cũ chứa từ bị xóa bị coi là lỗi thời (`isStale = true`).
 *  - Đồng bộ lên Amazon Translate qua `ImportTerminology` (`MergeStrategy = OVERWRITE`),
 *    mỗi tenant một terminology theo công thức duy nhất `terminologyNameOf(ctx)`.
 */

import {
  ImportTerminologyCommand,
  TranslateClient,
  type ImportTerminologyCommandOutput,
} from '@aws-sdk/client-translate';
import { db, requireRole } from '../../../libs/common/db.js';
import { stripHtmlTags } from '../../../libs/common/experiments/analyzers.js';
import { AppError, keys, type Ctx, type Lang } from '../../../libs/common/types.js';

const TABLE_NAME = process.env.TABLE_NAME || 'translate-data';

/** Các mã ngôn ngữ ISO 639-1 được hệ thống hỗ trợ trong MVP. */
export const SUPPORTED_GLOSSARY_LANGUAGES = Object.freeze([
  'vi',
  'en',
  'ko',
  'ja',
  'zh',
  'fr',
  'de',
  'es',
] as const);

/** Danh sách ngôn ngữ đích mặc định để tự điền khi tạo mục KEEP mà không truyền danh sách ngôn ngữ đích. */
export const DEFAULT_TARGET_LANGUAGES: readonly Lang[] = Object.freeze(['en', 'ko', 'ja', 'zh']);

/** Thời gian lưu đệm tối đa của GlossaryState trong bộ nhớ Lambda (60 giây theo B.7). */
export const GLOSSARY_CACHE_TTL_MS = 60_000;

// ============================================================================
// Kiểu dữ liệu (Khớp B.7 Phần B)
// ============================================================================

export type GlossaryTermType = 'KEEP' | 'FIXED';

export interface GlossaryTermEntry {
  normalized: string;
  sourceTerm: string;
  sourceLang: Lang;
  type: GlossaryTermType;
  translations: Record<Lang, string>;
  sinceVersion: number;
  deleted?: boolean;
  updatedAt?: string;
}

export interface GlossaryState {
  /** glossaryVersion hiện hành ở bản ghi CONFIG của tenant */
  version: number;
  /** Tên Custom Terminology trên Amazon Translate; null khi tenant chưa có thuật ngữ hiệu lực */
  terminologyName: string | null;
  /** Danh sách thuật ngữ (bao gồm cả mục đã đánh dấu xóa để `isStale` phát hiện bản dịch cũ) */
  terms: {
    normalized: string;
    sourceTerm?: string;
    sourceLang?: Lang;
    type: GlossaryTermType;
    translations?: Record<Lang, string>;
    sinceVersion: number;
    deleted?: boolean;
  }[];
}

export interface PutTermInput {
  /** Từ nguồn (ví dụ: "Homestay ABC" hoặc "phố cổ Hội An") */
  sourceTerm: string;
  /** Ngôn ngữ nguồn (mặc định: "vi") */
  sourceLang?: Lang;
  /** Loại mục: KEEP (Giữ nguyên) hoặc FIXED (Dịch cố định) */
  type: GlossaryTermType;
  /** Bản dịch theo từng ngôn ngữ đích (với KEEP sẽ tự động điền bằng chính sourceTerm) */
  translations?: Record<Lang, string>;
  /** Danh sách ngôn ngữ đích cần điền tự động cho loại KEEP (mặc định: en, ko, ja, zh) */
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
}

export interface TranslateTerminologyClient {
  send(
    command: ImportTerminologyCommand,
  ): Promise<Pick<ImportTerminologyCommandOutput, 'TerminologyProperties'> | Record<string, unknown>>;
}

export interface GlossaryDependencies {
  db: Pick<typeof db, 'get' | 'put' | 'query' | 'transact'>;
  translateClient: TranslateTerminologyClient;
  now: () => number;
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
};

// ============================================================================
// Bộ nhớ đệm GlossaryState theo (tenantId, version) trong Lambda (tối đa 60 giây)
// ============================================================================

interface CachedGlossaryState {
  version: number;
  state: GlossaryState;
  expiresAt: number;
}

const glossaryCache = new Map<string, CachedGlossaryState>();

/** Xóa bộ nhớ đệm của một tenant hoặc toàn bộ (dùng sau khi ghi hoặc trong unit test). */
export function clearGlossaryCache(tenantId?: string): void {
  if (tenantId) {
    glossaryCache.delete(tenantId);
  } else {
    glossaryCache.clear();
  }
}

// ============================================================================
// Hàm chuẩn hóa chuỗi & Công thức tên Terminology (B.7 & Mục 2.6.5)
// ============================================================================

/** Chuẩn hóa Unicode NFC, gộp khoảng trắng liên tiếp và cắt 2 đầu (giữ nguyên chữ hoa/thường). */
export function cleanTermText(text: string): string {
  if (typeof text !== 'string') return '';
  return text.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** Chuẩn hóa từ nguồn làm khóa định danh (NFC + gộp khoảng trắng + cắt 2 đầu + chữ thường). */
export function normalizeTerm(text: string): string {
  return cleanTermText(text).toLowerCase();
}

/**
 * Công thức duy nhất tạo tên Custom Terminology trên Amazon Translate cho mỗi tenant (B.7 & Mục 2.6.5).
 * Chỉ chứa các ký tự hợp lệ của AWS Translate `^([A-Za-z0-9-]_?)+$`.
 */
export function terminologyNameOf(ctx: Ctx): string {
  const safeId = ctx.tenantId.replace(/[^A-Za-z0-9-_]/g, '-');
  return `tm-${safeId}`;
}

// ============================================================================
// Đọc trạng thái Thuật ngữ (getGlossaryState) & Danh sách hiệu lực (listGlossary)
// ============================================================================

/**
 * Lấy trạng thái bảng thuật ngữ của tenant (B.7).
 * Đọc `glossaryVersion` từ CONFIG và lưu đệm trong bộ nhớ Lambda theo `version` tối đa 60 giây.
 */
export async function getGlossaryState(
  ctx: Ctx,
  deps: GlossaryDependencies = defaultDependencies,
): Promise<GlossaryState> {
  const config = await deps.db.get(ctx, keys.config(ctx));
  if (config?.status === 'LOCKED') {
    // Theo Bảng 2.14: thao tác đọc vẫn trả trạng thái khi cần hoặc do tầng gọi quyết định
  }

  const currentVersion = Number(config?.glossaryVersion ?? 0);
  const now = deps.now();
  const cached = glossaryCache.get(ctx.tenantId);

  if (cached && cached.version === currentVersion && now < cached.expiresAt) {
    return cached.state;
  }

  if (currentVersion <= 0) {
    const emptyState: GlossaryState = {
      version: 0,
      terminologyName: null,
      terms: [],
    };
    glossaryCache.set(ctx.tenantId, {
      version: 0,
      state: emptyState,
      expiresAt: now + GLOSSARY_CACHE_TTL_MS,
    });
    return emptyState;
  }

  const glossPk = `TENANT#${ctx.tenantId}#GLOSS`;
  const rawItems = await deps.db.query(ctx, glossPk, 'TERM#');

  const terms: GlossaryState['terms'] = rawItems.map((item: Record<string, any>) => ({
    normalized: String(item.normalized ?? String(item.SK ?? '').replace(/^TERM#/, '')),
    sourceTerm: typeof item.sourceTerm === 'string' ? item.sourceTerm : String(item.normalized ?? ''),
    sourceLang: typeof item.sourceLang === 'string' ? item.sourceLang : 'vi',
    type: item.type === 'KEEP' ? 'KEEP' : 'FIXED',
    translations:
      item.translations && typeof item.translations === 'object'
        ? { ...item.translations }
        : {},
    sinceVersion: Number(item.sinceVersion ?? 1),
    deleted: Boolean(item.deleted),
  }));

  const hasActiveTerms = terms.some((t) => !t.deleted);
  const state: GlossaryState = {
    version: currentVersion,
    terminologyName: hasActiveTerms ? terminologyNameOf(ctx) : null,
    terms,
  };

  glossaryCache.set(ctx.tenantId, {
    version: currentVersion,
    state,
    expiresAt: now + GLOSSARY_CACHE_TTL_MS,
  });

  return state;
}

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
// Đồng bộ CSV lên Amazon Translate (ImportTerminology)
// ============================================================================

function escapeCsvCell(val: string): string {
  if (/[",\r\n]/.test(val)) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

/**
 * Tạo nội dung tệp CSV UTF-8 chuẩn của Amazon Translate từ danh sách các mục thuật ngữ đang hiệu lực.
 * Dòng đầu tiên là mã ngôn ngữ (cột đầu là ngôn ngữ nguồn, các cột sau là ngôn ngữ đích).
 */
export function buildTenantTerminologyCsv(activeTerms: readonly GlossaryTermEntry[]): string | null {
  if (activeTerms.length === 0) return null;

  const sourceLang = activeTerms[0].sourceLang || 'vi';
  const targetLangSet = new Set<string>();

  for (const term of activeTerms) {
    if (term.type === 'KEEP') {
      for (const l of DEFAULT_TARGET_LANGUAGES) {
        if (l !== sourceLang) targetLangSet.add(l);
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
    for (const l of DEFAULT_TARGET_LANGUAGES) {
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
        // Nếu một mục FIXED chỉ khai báo một số ngôn ngữ đích, các ngôn ngữ đích khác để trống
        cells.push(translated ?? '');
      }
    }
    rows.push(cells.map(escapeCsvCell).join(','));
  }

  return rows.join('\n') + '\n';
}

async function syncTerminologyToTranslate(
  ctx: Ctx,
  activeTerms: readonly GlossaryTermEntry[],
  deps: GlossaryDependencies,
): Promise<void> {
  const csv = buildTenantTerminologyCsv(activeTerms);
  if (!csv) {
    // Khi không còn thuật ngữ hiệu lực nào, getGlossaryState trả terminologyName = null
    // nên F2/F9/F10 sẽ không truyền TerminologyNames vào TranslateText.
    return;
  }

  await deps.translateClient.send(
    new ImportTerminologyCommand({
      Name: terminologyNameOf(ctx),
      MergeStrategy: 'OVERWRITE',
      Description: `Custom Terminology for tenant ${ctx.tenantId}`,
      TerminologyData: {
        File: Buffer.from(csv, 'utf8'),
        Format: 'CSV',
      },
    }),
  );
}

// ============================================================================
// Thêm / Sửa một thuật ngữ (putTerm) & Xóa một thuật ngữ (deleteTerm)
// ============================================================================

async function loadConfigAndAssertWritable(
  ctx: Ctx,
  deps: GlossaryDependencies,
): Promise<Record<string, any>> {
  const config = (await deps.db.get(ctx, keys.config(ctx))) ?? {
    PK: `TENANT#${ctx.tenantId}`,
    SK: 'CONFIG',
    tenantId: ctx.tenantId,
    status: 'ACTIVE',
    glossaryVersion: 0,
  };

  if (config.status === 'LOCKED') {
    throw new AppError('TENANT_SUSPENDED', 'Tenant đang bị tạm khóa, không thể thay đổi bảng thuật ngữ');
  }
  return config;
}

/**
 * Thêm mới hoặc cập nhật một mục thuật ngữ (B.7).
 *  - Với loại KEEP: bản dịch ở mọi ngôn ngữ đích tự động điền bằng chính từ nguồn.
 *  - Với loại FIXED: yêu cầu bản dịch cố định cho các ngôn ngữ đích.
 *  - Tăng `glossaryVersion` ở CONFIG, ghi `sinceVersion = newVersion` và đồng bộ `ImportTerminology`.
 */
export async function putTerm(
  ctx: Ctx,
  input: PutTermInput,
  deps: GlossaryDependencies = defaultDependencies,
): Promise<{ version: number }> {
  const cleanedSource = cleanTermText(input?.sourceTerm ?? '');
  const normalized = normalizeTerm(cleanedSource);

  if (!cleanedSource || !normalized) {
    throw new AppError('INVALID_REQUEST', 'Từ nguồn không được để trống');
  }

  if (input.type !== 'KEEP' && input.type !== 'FIXED') {
    throw new AppError('INVALID_REQUEST', 'Loại thuật ngữ phải là KEEP hoặc FIXED');
  }

  const sourceLang = cleanTermText(input.sourceLang ?? 'vi').toLowerCase() || 'vi';
  if (!(SUPPORTED_GLOSSARY_LANGUAGES as readonly string[]).includes(sourceLang)) {
    throw new AppError('UNSUPPORTED_LANGUAGE', `Ngôn ngữ nguồn không được hỗ trợ: ${sourceLang}`);
  }

  const translations: Record<Lang, string> = {};

  if (input.type === 'KEEP') {
    const targets =
      input.targetLangs && input.targetLangs.length > 0
        ? input.targetLangs
        : input.translations && Object.keys(input.translations).length > 0
          ? Object.keys(input.translations)
          : DEFAULT_TARGET_LANGUAGES.filter((l) => l !== sourceLang);

    for (const rawLang of targets) {
      const lang = cleanTermText(rawLang).toLowerCase();
      if (!lang || lang === sourceLang) continue;
      if (!(SUPPORTED_GLOSSARY_LANGUAGES as readonly string[]).includes(lang)) {
        throw new AppError('UNSUPPORTED_LANGUAGE', `Ngôn ngữ đích không được hỗ trợ: ${lang}`);
      }
      // Quy tắc KEEP: tự điền bản dịch ở mọi ngôn ngữ đích bằng chính từ nguồn
      translations[lang] = cleanedSource;
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
      throw new AppError('INVALID_REQUEST', 'Thuật ngữ loại FIXED phải có ít nhất một ngôn ngữ đích khác ngôn ngữ nguồn');
    }
  }

  const config = await loadConfigAndAssertWritable(ctx, deps);
  const newVersion = Number(config.glossaryVersion ?? 0) + 1;
  const updatedAt = new Date(deps.now()).toISOString();
  const glossKey = keys.gloss(ctx, normalized);

  await deps.db.transact(ctx, [
    {
      Put: {
        TableName: TABLE_NAME,
        Item: {
          ...config,
          PK: `TENANT#${ctx.tenantId}`,
          SK: 'CONFIG',
          glossaryVersion: newVersion,
          updatedAt,
        },
      },
    },
    {
      Put: {
        TableName: TABLE_NAME,
        Item: {
          PK: glossKey.PK,
          SK: glossKey.SK,
          tenantId: ctx.tenantId,
          normalized,
          sourceTerm: cleanedSource,
          sourceLang,
          type: input.type,
          translations,
          sinceVersion: newVersion,
          deleted: false,
          updatedAt,
        },
      },
    },
  ]);

  clearGlossaryCache(ctx.tenantId);
  const currentList = await listGlossary(ctx, deps);
  await syncTerminologyToTranslate(ctx, currentList.terms, deps);

  return { version: newVersion };
}

/**
 * Xóa một mục thuật ngữ (B.7).
 *  - Tăng `glossaryVersion` ở CONFIG.
 *  - Lưu bản ghi đánh dấu xóa (`deleted: true, sinceVersion = newVersion`) để các bản dịch MACHINE cũ
 *    có chứa từ vừa bị xóa bị `isStale()` coi là lỗi thời và dịch lại ở lần truy cập sau.
 */
export async function deleteTerm(
  ctx: Ctx,
  termOrNormalized: string,
  deps: GlossaryDependencies = defaultDependencies,
): Promise<{ version: number }> {
  const normalized = normalizeTerm(termOrNormalized);
  if (!normalized) {
    throw new AppError('INVALID_REQUEST', 'Từ thuật ngữ cần xóa không hợp lệ');
  }

  const config = await loadConfigAndAssertWritable(ctx, deps);
  const glossKey = keys.gloss(ctx, normalized);
  const existing = await deps.db.get(ctx, glossKey);

  if (!existing || existing.deleted) {
    throw new AppError('NOT_FOUND', `Không tìm thấy thuật ngữ '${termOrNormalized}'`);
  }

  const newVersion = Number(config.glossaryVersion ?? 0) + 1;
  const updatedAt = new Date(deps.now()).toISOString();

  await deps.db.transact(ctx, [
    {
      Put: {
        TableName: TABLE_NAME,
        Item: {
          ...config,
          PK: `TENANT#${ctx.tenantId}`,
          SK: 'CONFIG',
          glossaryVersion: newVersion,
          updatedAt,
        },
      },
    },
    {
      Put: {
        TableName: TABLE_NAME,
        Item: {
          ...existing,
          PK: glossKey.PK,
          SK: glossKey.SK,
          sinceVersion: newVersion,
          deleted: true,
          deletedAtVersion: newVersion,
          updatedAt,
        },
      },
    },
  ]);

  clearGlossaryCache(ctx.tenantId);
  const currentList = await listGlossary(ctx, deps);
  await syncTerminologyToTranslate(ctx, currentList.terms, deps);

  return { version: newVersion };
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

  // Bỏ UTF-8 BOM nếu có ở đầu tệp
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

  if (inQuotes) return null; // Dấu ngoặc kép chưa đóng
  cells.push(current);
  return cells;
}

/**
 * Nhập bảng thuật ngữ từ tệp CSV UTF-8 (B.7 & Mục 2.6.5).
 *  - Dòng đầu là các mã ngôn ngữ (`vi,en,ko,ja`), cột đầu là ngôn ngữ nguồn.
 *  - Mục có mọi bản dịch đích trùng từ nguồn -> KEEP; ngược lại -> FIXED.
 *  - Chế độ `PREVIEW`: trả về số dòng hợp lệ, các dòng lỗi kèm lý do, danh sách trùng với mục đã có.
 *  - Chế độ `COMMIT`: lưu vào DynamoDB theo `onDuplicate` (`KEEP_EXISTING` hoặc `OVERWRITE`),
 *    tăng `glossaryVersion` và gọi `ImportTerminology`.
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

  // Loại bỏ các dòng hoàn toàn rỗng ở cuối tệp
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

  // Đọc danh sách các mục đang hiệu lực hiện có của tenant để phát hiện trùng
  const existingList = await listGlossary(ctx, deps);
  const existingMap = new Map<string, GlossaryTermEntry>();
  for (const item of existingList.terms) {
    existingMap.set(item.normalized, item);
  }

  const errors: ImportCsvErrorItem[] = [];
  const duplicates: { term: string }[] = [];
  const parsedEntries: GlossaryTermEntry[] = [];
  const seenInFile = new Set<string>();

  for (let i = 1; i < rawLines.length; i++) {
    const rowNumber = i + 1; // Dòng 1 là header, dữ liệu bắt đầu từ dòng 2
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

    // Kiểm tra ô trống ở các cột ngôn ngữ đích
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

    // Kiểm tra trùng ngay trong cùng tệp CSV (giữ dòng đầu, báo lỗi các dòng trùng phía sau)
    if (seenInFile.has(normalized)) {
      errors.push({ row: rowNumber, reason: `Trùng từ nguồn '${sourceTerm}' trong tệp CSV` });
      continue;
    }
    seenInFile.add(normalized);

    // Tự động phân loại KEEP vs FIXED theo mục 1.3.3 & 2.6.5:
    // Nếu mọi ô đích đều trùng từ nguồn -> KEEP, ngược lại -> FIXED.
    const isKeep = targetLangs.every((l) => translations[l] === sourceTerm);
    const termType: GlossaryTermType = isKeep ? 'KEEP' : 'FIXED';

    if (existingMap.has(normalized)) {
      duplicates.push({ term: sourceTerm });
    }

    parsedEntries.push({
      normalized,
      sourceTerm,
      sourceLang,
      type: termType,
      translations,
      sinceVersion: existingList.version + 1,
    });
  }

  let addedCount = 0;
  let overwrittenCount = 0;
  let skippedCount = 0;
  const itemsToSave: GlossaryTermEntry[] = [];

  for (const entry of parsedEntries) {
    if (existingMap.has(entry.normalized)) {
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
      version: existingList.version,
    };
  }

  const config = await loadConfigAndAssertWritable(ctx, deps);
  if (itemsToSave.length === 0) {
    return {
      validRows: parsedEntries.length,
      errors,
      duplicates,
      addedCount: 0,
      overwrittenCount: 0,
      skippedCount,
      version: Number(config.glossaryVersion ?? 0),
    };
  }

  const newVersion = Number(config.glossaryVersion ?? 0) + 1;
  const updatedAt = new Date(deps.now()).toISOString();

  // DynamoDB TransactWriteItems giới hạn 100 mục/giao dịch; chia lô nếu số mục lớn
  const configPutOp = {
    Put: {
      TableName: TABLE_NAME,
      Item: {
        ...config,
        PK: `TENANT#${ctx.tenantId}`,
        SK: 'CONFIG',
        glossaryVersion: newVersion,
        updatedAt,
      },
    },
  };

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

  const BATCH_SIZE = 90;
  for (let i = 0; i < glossPutOps.length; i += BATCH_SIZE) {
    const slice = glossPutOps.slice(i, i + BATCH_SIZE);
    const ops = i === 0 ? [configPutOp, ...slice] : slice;
    await deps.db.transact(ctx, ops);
  }

  clearGlossaryCache(ctx.tenantId);
  const updatedGlossary = await listGlossary(ctx, deps);
  await syncTerminologyToTranslate(ctx, updatedGlossary.terms, deps);

  return {
    validRows: parsedEntries.length,
    errors,
    duplicates,
    addedCount,
    overwrittenCount,
    skippedCount,
    version: newVersion,
  };
}

// ============================================================================
// Phát hiện bản dịch lỗi thời (isStale) & Hậu kiểm thuật ngữ (postCheckGlossary)
// ============================================================================

const CJK_REGEX = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Kiểm tra một thuật ngữ (đã chuẩn hóa NFC + chữ thường) có xuất hiện trong văn bản (đã chuẩn hóa NFC + chữ thường) hay không.
 * Theo Mục 2.6.5:
 *  - Với chữ Latin / Quốc ngữ: so khớp theo ranh giới từ chữ Latin/chữ số (`(?<![\p{Script=Latin}\p{M}\p{N}])...(?![\p{Script=Latin}\p{M}\p{N}])`),
 *    cho phép thuật ngữ KEEP ("Homestay ABC") đứng liền trước trợ từ tiếng Nhật/Hàn (như "Homestay ABCは", "Homestay ABC는").
 *  - Với chữ Hán, Nhật, Hàn (CJK): so khớp theo chuỗi con (`includes`).
 */
export function containsTermInText(normalizedHaystack: string, normalizedNeedle: string): boolean {
  if (!normalizedHaystack || !normalizedNeedle) return false;
  if (CJK_REGEX.test(normalizedNeedle)) {
    return normalizedHaystack.includes(normalizedNeedle);
  }
  const pattern = new RegExp(
    `(?<![\\p{Script=Latin}\\p{M}\\p{N}])${escapeRegex(normalizedNeedle)}(?![\\p{Script=Latin}\\p{M}\\p{N}])`,
    'u',
  );
  return pattern.test(normalizedHaystack);
}

/**
 * Kiểm tra một bản ghi trong Translation Memory (TM) có bị lỗi thời theo bảng thuật ngữ hiện tại hay không (B.7 & Mục 2.6.5).
 *  - Quy tắc: Bản dịch bị coi là lỗi thời nếu `sourceText` chứa BẤT KỲ thuật ngữ nào (kể cả mục vừa bị xóa)
 *    có `sinceVersion > entryGlossaryVersion`.
 *  - Với bản MACHINE: lỗi thời -> coi là trượt TM và dịch lại.
 *  - Với bản HUMAN: lỗi thời -> giữ nguyên nội dung nhưng hiển thị nhãn "Cần xem lại" (`needsReview = true`).
 */
export function isStale(
  sourceText: string,
  entryGlossaryVersion: number,
  g: GlossaryState,
): boolean {
  if (!g || g.version <= entryGlossaryVersion || !Array.isArray(g.terms) || g.terms.length === 0) {
    return false;
  }

  // Loại bỏ các ký hiệu placeholder nội tuyến {1}...{/1} hoặc thẻ HTML trước khi dò từ nguồn
  const plainSource = stripHtmlTags(sourceText).replace(/\{\/?\d+\}/g, ' ');
  const normalizedSource = normalizeTerm(plainSource);
  if (!normalizedSource) return false;

  for (const term of g.terms) {
    if (term.sinceVersion <= entryGlossaryVersion) continue;
    const needle = normalizeTerm(term.normalized || term.sourceTerm || '');
    if (containsTermInText(normalizedSource, needle)) {
      return true;
    }
  }

  return false;
}

/**
 * Hậu kiểm thuật ngữ sau khi dịch máy (Mục 2.6.5).
 * Kiểm tra mọi thuật ngữ hiệu lực xuất hiện trong `sourceText` có xuất hiện bản dịch tương ứng
 * trong `translatedText` ở ngôn ngữ `targetLang` hay không.
 * Nếu thiếu bất kỳ thuật ngữ nào -> `needsReview = true` ("Cần xem lại").
 */
export function postCheckGlossary(
  sourceText: string,
  translatedText: string,
  targetLang: Lang,
  g: GlossaryState,
): {
  passed: boolean;
  needsReview: boolean;
  missingTerms: string[];
} {
  if (!g || !Array.isArray(g.terms) || g.terms.length === 0) {
    return { passed: true, needsReview: false, missingTerms: [] };
  }

  const normalizedSource = normalizeTerm(stripHtmlTags(sourceText).replace(/\{\/?\d+\}/g, ' '));
  const normalizedTranslated = normalizeTerm(stripHtmlTags(translatedText).replace(/\{\/?\d+\}/g, ' '));
  const missingTerms: string[] = [];

  for (const term of g.terms) {
    if (term.deleted) continue;
    const sourceNeedle = normalizeTerm(term.normalized || term.sourceTerm || '');
    if (!containsTermInText(normalizedSource, sourceNeedle)) continue;

    const expectedTarget =
      term.type === 'KEEP'
        ? term.sourceTerm ?? term.normalized
        : term.translations?.[targetLang];

    if (!expectedTarget) continue;
    const targetNeedle = normalizeTerm(expectedTarget);
    if (!containsTermInText(normalizedTranslated, targetNeedle)) {
      missingTerms.push(term.sourceTerm ?? term.normalized);
    }
  }

  const passed = missingTerms.length === 0;
  return {
    passed,
    needsReview: !passed,
    missingTerms,
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

/**
 * Xử lý các route `/console/glossary*` theo đúng bảng phân quyền B.6:
 *  - `GET /console/glossary` (hoặc `/console/glossary/terms`): cho phép `TENANT_ADMIN`, `DEVELOPER`, `REVIEWER`.
 *  - `PUT /console/glossary/terms/{term}`: chỉ `TENANT_ADMIN`.
 *  - `DELETE /console/glossary/terms/{term}`: chỉ `TENANT_ADMIN`.
 *  - `POST /console/glossary/import` (preview hoặc commit): chỉ `TENANT_ADMIN`.
 */
export async function handleGlossaryRoute(
  ctx: Ctx,
  req: GlossaryHttpRequest,
  deps: GlossaryDependencies = defaultDependencies,
): Promise<unknown> {
  if (req.method === 'GET') {
    requireRole(ctx, ['TENANT_ADMIN', 'DEVELOPER', 'REVIEWER']);
    return listGlossary(ctx, deps);
  }

  // Mọi thao tác ghi (PUT, DELETE, POST import) chỉ dành cho TENANT_ADMIN
  requireRole(ctx, ['TENANT_ADMIN']);

  if (req.method === 'PUT') {
    const body = req.body ?? {};
    const sourceTerm = String(body.sourceTerm ?? req.termParam ?? '');
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
    const termToDelete = String(req.termParam ?? req.body?.sourceTerm ?? req.body?.term ?? '');
    return deleteTerm(ctx, termToDelete, deps);
  }

  if (req.method === 'POST') {
    const body = req.body ?? {};
    const csv = body.csv ?? '';
    const isPreviewPath = req.path.endsWith('/preview');
    const mode: 'PREVIEW' | 'COMMIT' =
      isPreviewPath || body.mode === 'PREVIEW' ? 'PREVIEW' : 'COMMIT';
    const onDuplicate: 'KEEP_EXISTING' | 'OVERWRITE' =
      body.onDuplicate === 'KEEP_EXISTING' ? 'KEEP_EXISTING' : 'OVERWRITE';
    return importCsv(ctx, csv, mode, onDuplicate, deps);
  }

  throw new AppError('INVALID_REQUEST', `Phương thức HTTP không được hỗ trợ: ${req.method}`);
}
