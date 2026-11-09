/**
 * Dịch vụ màn Quản lý Thuật ngữ và Nhập CSV (Q3, Nhiệm vụ 4.11 – TV4).
 * Kết nối với dịch vụ F4 (Task 2.8 – services/api/glossary/glossaryManager.ts) và Bảng 2.9 / Bảng 2.10 của báo cáo.
 *
 * Route (Bảng 2.9 & handleGlossaryRoute):
 *   GET    /console/glossary/terms          -> { version, terminology_name?, terms: GlossaryTermEntry[] }
 *   PUT    /console/glossary/terms/{term}   -> { term, version, terminology_synced? }
 *   DELETE /console/glossary/terms/{term}   -> { deleted, version, terminology_synced? }
 *   POST   /console/glossary/import/preview -> CsvImportPreviewOrCommitResult (mode = PREVIEW)
 *   POST   /console/glossary/import         -> CsvImportPreviewOrCommitResult (mode = COMMIT)
 *
 * Hai bản cài đặt cùng giao diện GlossaryApi:
 *  - createHttpGlossaryApi: gọi REST API thật kèm Authorization: Bearer <idToken> (khi VITE_AUTH_MODE=cognito);
 *  - createMockGlossaryApi: giả lập đầy đủ trong trình duyệt (khi VITE_AUTH_MODE=mock) với dữ liệu mẫu Mục 1.3.3.
 */
import {
  extractApiErrorPayload,
  resolveConsoleError,
  type KnownConsoleErrorCode,
} from './errorMapping.js';
import type {
  CsvImportPreviewOrCommitResult,
  CsvImportRowError,
  DeleteGlossaryTermResponse,
  DuplicateHandlingMode,
  GlossaryStateResponse,
  GlossaryTermEntry,
  GlossaryTermType,
  UpsertGlossaryTermInput,
  UpsertGlossaryTermResponse,
} from '../types/glossary.js';

// ============================================================================
// Hằng số & Nhãn hiển thị
// ============================================================================

export const SUPPORTED_GLOSSARY_LANGS: readonly { code: string; label: string }[] = Object.freeze([
  { code: 'vi', label: 'Tiếng Việt (vi)' },
  { code: 'en', label: 'Tiếng Anh (en)' },
  { code: 'ko', label: 'Tiếng Hàn (ko)' },
  { code: 'ja', label: 'Tiếng Nhật (ja)' },
  { code: 'zh', label: 'Tiếng Trung (zh)' },
  { code: 'fr', label: 'Tiếng Pháp (fr)' },
  { code: 'de', label: 'Tiếng Đức (de)' },
  { code: 'es', label: 'Tiếng Tây Ban Nha (es)' },
]);

export const DEFAULT_GLOSSARY_TARGET_LANGS: readonly string[] = Object.freeze([
  'en',
  'ko',
  'ja',
  'zh',
  'fr',
]);

export function glossaryLangLabel(code: string): string {
  const norm = cleanTermText(code).toLowerCase();
  const found = SUPPORTED_GLOSSARY_LANGS.find((l) => l.code === norm);
  return found ? found.label : norm.toUpperCase();
}

export const MAX_CSV_IMPORT_ROWS = 99;

export const TERM_TYPE_LABELS: Readonly<Record<GlossaryTermType, string>> = Object.freeze({
  KEEP: 'Giữ nguyên',
  FIXED: 'Dịch cố định',
});

export class GlossaryApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public requestId?: string,
    public httpStatus?: number,
  ) {
    super(message);
    this.name = 'GlossaryApiError';
  }
}

// ============================================================================
// Hàm thuần chuẩn hóa, kiểm tra đầu vào và phân tích CSV UTF-8 (Mục 1.3.3 & Task 2.8)
// ============================================================================

export function cleanTermText(raw: string): string {
  return raw.normalize('NFC').replace(/\s+/g, ' ').trim();
}

export function normalizeGlossaryTerm(raw: string): string {
  return cleanTermText(raw).toLowerCase();
}

export function hasForbiddenTermContent(text: string): boolean {
  if (/[\u0000-\u001F\u007F]/.test(text)) return true;
  if (/<\/?[a-zA-Z][^>]*>/.test(text)) return true;
  if (/\{\/?\d+\/?\}/.test(text)) return true;
  return false;
}

/**
 * Kiểm tra thông tin khi Thêm / Sửa một thuật ngữ trên giao diện Q3.
 * Với loại KEEP, bản dịch ở mọi ngôn ngữ đích được tự điền bằng chính từ nguồn.
 */
const DEFAULT_TARGET_ORDER = new Map<string, number>([
  ['en', 0],
  ['ko', 1],
  ['ja', 2],
  ['zh', 3],
  ['fr', 4],
  ['de', 5],
  ['es', 6],
  ['vi', 7],
]);

function sortGlossaryLangCodes(codes: Iterable<string>): string[] {
  return [...new Set(codes)].sort((a, b) => {
    const oa = DEFAULT_TARGET_ORDER.get(a);
    const ob = DEFAULT_TARGET_ORDER.get(b);
    if (oa !== undefined && ob !== undefined) return oa - ob;
    if (oa !== undefined) return -1;
    if (ob !== undefined) return 1;
    return a.localeCompare(b);
  });
}

/**
 * Xác định toàn bộ danh sách ngôn ngữ đích cần hiển thị và giữ lại trong form Thêm / Sửa thuật ngữ:
 * gồm 5 ngôn ngữ đích chuẩn (en, ko, ja, zh, fr) và mọi ngôn ngữ đã có sẵn trong mục đang sửa (ví dụ de, es...), trừ ngôn ngữ nguồn.
 */
export function getEditableGlossaryTargetLangs(
  sourceLang: string,
  existingTranslations?: Readonly<Record<string, string>>,
  extraTargetLangs?: readonly string[],
): string[] {
  const src = cleanTermText(sourceLang || 'vi').toLowerCase() || 'vi';
  const langs = new Set<string>();

  for (const lang of DEFAULT_GLOSSARY_TARGET_LANGS) {
    if (lang !== src) langs.add(lang);
  }
  if (existingTranslations) {
    for (const [rawLang, val] of Object.entries(existingTranslations)) {
      const lang = cleanTermText(rawLang).toLowerCase();
      if (lang && lang !== src && typeof val === 'string' && cleanTermText(val).length > 0) {
        langs.add(lang);
      }
    }
  }
  if (extraTargetLangs) {
    for (const rawLang of extraTargetLangs) {
      const lang = cleanTermText(rawLang).toLowerCase();
      if (lang && lang !== src) langs.add(lang);
    }
  }
  return sortGlossaryLangCodes(langs);
}

/**
 * Xác định danh sách cột ngôn ngữ đích hiển thị trên bảng Q3:
 * gồm 5 ngôn ngữ chuẩn (en, ko, ja, zh, fr) cộng thêm mọi ngôn ngữ đích đang có dữ liệu trong danh sách thuật ngữ.
 */
export function getGlossaryTableLangs(terms: readonly GlossaryTermEntry[]): string[] {
  const langs = new Set<string>(DEFAULT_GLOSSARY_TARGET_LANGS);
  for (const entry of terms) {
    const src = cleanTermText(entry.sourceLang || 'vi').toLowerCase() || 'vi';
    for (const [rawLang, val] of Object.entries(entry.translations ?? {})) {
      const lang = cleanTermText(rawLang).toLowerCase();
      if (lang && lang !== src && typeof val === 'string' && cleanTermText(val).length > 0) {
        langs.add(lang);
      }
    }
  }
  return sortGlossaryLangCodes(langs);
}

/**
 * Khởi tạo map giá trị ô nhập bản dịch khi mở form Thêm mới hoặc Sửa một mục thuật ngữ,
 * bảo đảm nạp đủ toàn bộ ngôn ngữ hiện có (en, ko, ja, zh, fr và bất kỳ ngôn ngữ nào khác).
 */
export function initGlossaryFormTranslations(
  entry?: GlossaryTermEntry | null,
  overrideSourceLang?: string,
  extraTargetLangs?: readonly string[],
): Record<string, string> {
  const src = cleanTermText(overrideSourceLang ?? entry?.sourceLang ?? 'vi').toLowerCase() || 'vi';
  const editableLangs = getEditableGlossaryTargetLangs(src, entry?.translations, extraTargetLangs);
  const existingNorm: Record<string, string> = {};
  if (entry?.translations) {
    for (const [rawLang, val] of Object.entries(entry.translations)) {
      const lang = cleanTermText(rawLang).toLowerCase();
      if (lang && lang !== src && typeof val === 'string') {
        existingNorm[lang] = val;
      }
    }
  }

  const out: Record<string, string> = {};
  for (const lang of editableLangs) {
    out[lang] = existingNorm[lang] ?? (entry?.type === 'KEEP' ? entry.sourceTerm : '');
  }
  for (const [lang, val] of Object.entries(existingNorm)) {
    if (!(lang in out)) out[lang] = val;
  }
  return out;
}

export interface BuildUpsertGlossaryParams {
  sourceTerm: string;
  sourceLang: string;
  type: GlossaryTermType;
  formTranslations: Readonly<Record<string, string>>;
  targetLangs?: readonly string[];
  /** Bản dịch gốc của mục đang sửa; mọi key chưa xuất hiện trong formTranslations sẽ được giữ lại */
  existingTranslations?: Readonly<Record<string, string>>;
}

/**
 * Dựng payload PUT /console/glossary/terms/{term} gửi lên F4:
 * - Giữ nguyên mọi ngôn ngữ đã có khi sửa (en, ko, ja, zh, fr, de, ...);
 * - Loại bỏ các ô còn trống đối với loại FIXED để khớp ràng buộc kiểm tra của F4.
 */
export function buildUpsertGlossaryInput(params: BuildUpsertGlossaryParams): UpsertGlossaryTermInput {
  const src = cleanTermText(params.sourceLang || 'vi').toLowerCase() || 'vi';
  const cleanedSource = cleanTermText(params.sourceTerm ?? '');

  const mergedRaw: Record<string, string> = {};
  for (const [rawLang, val] of Object.entries(params.existingTranslations ?? {})) {
    const lang = cleanTermText(rawLang).toLowerCase();
    if (!lang || lang === src || typeof val !== 'string') continue;
    mergedRaw[lang] = val;
  }
  for (const [rawLang, val] of Object.entries(params.formTranslations ?? {})) {
    const lang = cleanTermText(rawLang).toLowerCase();
    if (!lang || lang === src || typeof val !== 'string') continue;
    mergedRaw[lang] = val;
  }

  if (params.type === 'KEEP') {
    const keepLangs = getEditableGlossaryTargetLangs(src, mergedRaw, params.targetLangs);
    const translations: Record<string, string> = {};
    for (const lang of keepLangs) {
      translations[lang] = cleanedSource;
    }
    return {
      sourceTerm: cleanedSource,
      sourceLang: src,
      type: 'KEEP',
      translations,
      targetLangs: keepLangs,
    };
  }

  const translations: Record<string, string> = {};
  for (const lang of sortGlossaryLangCodes(Object.keys(mergedRaw))) {
    if (lang === src) continue;
    const cleanedVal = cleanTermText(mergedRaw[lang] ?? '');
    if (cleanedVal) {
      translations[lang] = cleanedVal;
    }
  }
  const activeTargets = sortGlossaryLangCodes(Object.keys(translations));

  return {
    sourceTerm: cleanedSource,
    sourceLang: src,
    type: 'FIXED',
    translations,
    targetLangs: activeTargets,
  };
}

export function validateUpsertTermInput(input: UpsertGlossaryTermInput): string | null {
  const cleanedSource = cleanTermText(input.sourceTerm ?? '');
  if (!cleanedSource) {
    return 'Vui lòng nhập từ nguồn (không được để trống).';
  }
  if (hasForbiddenTermContent(cleanedSource)) {
    return 'Từ nguồn không được chứa thẻ HTML, ký hiệu định dạng {n} hoặc ký tự điều khiển.';
  }
  if (input.type !== 'KEEP' && input.type !== 'FIXED') {
    return 'Loại thuật ngữ phải là Giữ nguyên (KEEP) hoặc Dịch cố định (FIXED).';
  }
  if (input.type === 'FIXED') {
    const nonEmptyTargets = Object.entries(input.translations ?? {}).filter(
      ([lang, val]) => lang !== input.sourceLang && cleanTermText(val).length > 0,
    );
    if (nonEmptyTargets.length === 0) {
      return 'Với loại "Dịch cố định", vui lòng nhập bản dịch cho ít nhất một ngôn ngữ đích.';
    }
    for (const [lang, val] of nonEmptyTargets) {
      if (hasForbiddenTermContent(val)) {
        return `Bản dịch của ngôn ngữ "${lang}" chứa thẻ HTML hoặc ký hiệu {n} không hợp lệ.`;
      }
    }
  }
  return null;
}

/**
 * Sinh nội dung tệp CSV UTF-8 mẫu theo đúng ví dụ tại Mục 1.3.3 của báo cáo.
 */
export function buildSampleGlossaryCsv(): string {
  return [
    'vi,en,ko',
    'Homestay ABC,Homestay ABC,Homestay ABC',
    'phố cổ Hội An,Hoi An Ancient Town,호이안 구시가지',
    'cao lầu,cao lau noodles,까오러우 국수',
    'sông Hoài,Hoai River,호아이 강',
  ].join('\n');
}

/**
 * Giải mã mảng byte của tệp CSV tải lên với kiểm tra nghiêm ngặt chuẩn UTF-8 (Mục 1.3.3).
 * Nếu tệp mã hóa Windows-1252 / Latin-1 hoặc chứa byte lỗi (\uFFFD) thì ném GlossaryApiError('INVALID_REQUEST').
 */
export function decodeCsvUtf8Bytes(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new GlossaryApiError(
      'INVALID_REQUEST',
      'Tệp CSV không được mã hóa chuẩn UTF-8. Vui lòng lưu tệp ở định dạng UTF-8 trước khi tải lên.',
    );
  }
  if (text.includes('\uFFFD')) {
    throw new GlossaryApiError(
      'INVALID_REQUEST',
      'Tệp CSV chứa ký tự lỗi mã hóa (\uFFFD), không phải UTF-8 hợp lệ.',
    );
  }
  return text.replace(/^\uFEFF+/, '');
}

export interface ParsedCsvRow {
  rowNumber: number;
  cells: string[];
}

/**
 * Phân tích cú pháp CSV theo chuẩn RFC 4180 (hỗ trợ dấu ngoặc kép, dấu phẩy trong ngoặc kép, CRLF/LF).
 */
export function parseCsvRowsRfc4180(csvText: string): {
  rows: ParsedCsvRow[];
  unclosedQuoteRow?: number;
} {
  const cleaned = csvText.replace(/^\uFEFF/, '');
  const rows: ParsedCsvRow[] = [];
  let currentCells: string[] = [];
  let currentCell = '';
  let inQuotes = false;
  let currentRowNumber = 1;
  let rowStartNumber = 1;

  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    const next = cleaned[i + 1];

    if (inQuotes) {
      if (ch === '"') {
        if (next === '"') {
          currentCell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n') currentRowNumber++;
        currentCell += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ',') {
      currentCells.push(currentCell);
      currentCell = '';
      continue;
    }
    if (ch === '\r' && next === '\n') {
      currentCells.push(currentCell);
      rows.push({ rowNumber: rowStartNumber, cells: currentCells });
      currentCells = [];
      currentCell = '';
      i++;
      currentRowNumber++;
      rowStartNumber = currentRowNumber;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      currentCells.push(currentCell);
      rows.push({ rowNumber: rowStartNumber, cells: currentCells });
      currentCells = [];
      currentCell = '';
      currentRowNumber++;
      rowStartNumber = currentRowNumber;
      continue;
    }

    currentCell += ch;
  }

  if (inQuotes) {
    return { rows, unclosedQuoteRow: rowStartNumber };
  }
  if (currentCells.length > 0 || currentCell.length > 0) {
    currentCells.push(currentCell);
    rows.push({ rowNumber: rowStartNumber, cells: currentCells });
  }
  return { rows };
}

const VALID_LANG_CODE_SET = new Set(SUPPORTED_GLOSSARY_LANGS.map((l) => l.code));

/**
 * Phân tích nội dung CSV và trả về kết quả xem trước (PREVIEW) giống hệt quy tắc của F4 (Task 2.8):
 *  - Kiểm tra dòng đầu là mã ngôn ngữ (cột đầu là ngôn ngữ nguồn, các cột sau là ngôn ngữ đích);
 *  - Bắt đủ lỗi: không phải UTF-8, thiếu cột ngôn ngữ, từ nguồn bị trùng, ô trống, vượt 99 dòng;
 *  - Tự động nhận diện loại KEEP (nếu mọi cột đích trùng với từ nguồn) hoặc FIXED.
 */
export function analyzeGlossaryCsv(
  csvText: string,
  existingTerms: ReadonlyMap<string, GlossaryTermEntry>,
  onDuplicate: DuplicateHandlingMode,
  currentVersion = 1,
): {
  parsedEntries: Array<{
    normalizedTerm: string;
    sourceTerm: string;
    sourceLang: string;
    type: GlossaryTermType;
    translations: Record<string, string>;
  }>;
  result: CsvImportPreviewOrCommitResult;
} {
  if (typeof csvText !== 'string' || csvText.trim().length === 0) {
    throw new GlossaryApiError('INVALID_REQUEST', 'Nội dung CSV trống.');
  }
  if (csvText.includes('\uFFFD') || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(csvText)) {
    throw new GlossaryApiError(
      'INVALID_REQUEST',
      'Tệp CSV chứa ký tự nhị phân hoặc không phải văn bản UTF-8 hợp lệ.',
    );
  }

  const { rows, unclosedQuoteRow } = parseCsvRowsRfc4180(csvText);
  if (unclosedQuoteRow !== undefined) {
    return {
      parsedEntries: [],
      result: {
        validRows: 0,
        errors: [
          {
            row: unclosedQuoteRow,
            reason: 'Cấu trúc CSV lỗi: dấu ngoặc kép (") mở nhưng không được đóng.',
          },
        ],
        duplicates: [],
        addedCount: 0,
        overwrittenCount: 0,
        skippedCount: 0,
        version: currentVersion,
      },
    };
  }

  const nonEmptyRows = rows.filter((r) => !(r.cells.length === 1 && r.cells[0].trim() === ''));
  if (nonEmptyRows.length === 0) {
    throw new GlossaryApiError('INVALID_REQUEST', 'Tệp CSV không có dữ liệu.');
  }

  const headerRow = nonEmptyRows[0];
  const headerLangs = headerRow.cells.map((c) => c.trim().toLowerCase());
  const errors: CsvImportRowError[] = [];

  if (headerLangs.length < 2) {
    errors.push({
      row: headerRow.rowNumber,
      reason: 'Dòng tiêu đề thiếu cột ngôn ngữ: cần tối thiểu 1 cột ngôn ngữ nguồn và 1 cột ngôn ngữ đích (ví dụ: vi,en,ko).',
    });
  } else {
    const seenHeader = new Set<string>();
    for (const lang of headerLangs) {
      if (!lang) {
        errors.push({ row: headerRow.rowNumber, reason: 'Dòng tiêu đề có cột mã ngôn ngữ bị để trống.' });
      } else if (!VALID_LANG_CODE_SET.has(lang)) {
        errors.push({
          row: headerRow.rowNumber,
          reason: `Mã ngôn ngữ "${lang}" trên dòng tiêu đề không nằm trong danh sách hỗ trợ.`,
        });
      } else if (seenHeader.has(lang)) {
        errors.push({
          row: headerRow.rowNumber,
          reason: `Cột ngôn ngữ "${lang}" bị lặp lại trên dòng tiêu đề.`,
        });
      }
      seenHeader.add(lang);
    }
  }

  if (errors.length > 0) {
    return {
      parsedEntries: [],
      result: {
        validRows: 0,
        errors,
        duplicates: [],
        addedCount: 0,
        overwrittenCount: 0,
        skippedCount: 0,
        version: currentVersion,
      },
    };
  }

  const sourceLang = headerLangs[0];
  const targetLangs = headerLangs.slice(1);
  const seenSourceInFile = new Map<string, number>();
  const parsedEntries: Array<{
    normalizedTerm: string;
    sourceTerm: string;
    sourceLang: string;
    type: GlossaryTermType;
    translations: Record<string, string>;
  }> = [];

  for (let i = 1; i < nonEmptyRows.length; i++) {
    const r = nonEmptyRows[i];
    if (r.cells.length !== headerLangs.length) {
      errors.push({
        row: r.rowNumber,
        reason: `Số cột (${r.cells.length}) không khớp với dòng tiêu đề (${headerLangs.length} cột).`,
      });
      continue;
    }

    const rawSource = cleanTermText(r.cells[0]);
    if (!rawSource) {
      errors.push({ row: r.rowNumber, reason: `Ô từ nguồn (${sourceLang}) bị để trống.` });
      continue;
    }
    if (hasForbiddenTermContent(rawSource)) {
      errors.push({
        row: r.rowNumber,
        reason: 'Từ nguồn chứa thẻ HTML, ký hiệu {n} hoặc ký tự điều khiển không hợp lệ.',
      });
      continue;
    }

    const norm = normalizeGlossaryTerm(rawSource);
    const prevRow = seenSourceInFile.get(norm);
    if (prevRow !== undefined) {
      errors.push({
        row: r.rowNumber,
        reason: `Từ nguồn "${rawSource}" bị trùng lặp ngay trong tệp CSV (đã xuất hiện ở dòng ${prevRow}).`,
      });
      continue;
    }
    seenSourceInFile.set(norm, r.rowNumber);

    const translations: Record<string, string> = {};
    let rowHasError = false;
    for (let c = 0; c < targetLangs.length; c++) {
      const lang = targetLangs[c];
      const cellVal = cleanTermText(r.cells[c + 1]);
      if (!cellVal) {
        errors.push({
          row: r.rowNumber,
          reason: `Ô bản dịch cho ngôn ngữ đích "${lang}" bị để trống.`,
        });
        rowHasError = true;
        break;
      }
      if (hasForbiddenTermContent(cellVal)) {
        errors.push({
          row: r.rowNumber,
          reason: `Ô bản dịch "${lang}" chứa thẻ HTML hoặc ký hiệu {n} không hợp lệ.`,
        });
        rowHasError = true;
        break;
      }
      translations[lang] = cellVal;
    }
    if (rowHasError) continue;

    // Mục 1.3.3: nếu bản dịch ở mọi ngôn ngữ đích trùng với từ nguồn -> KEEP, ngược lại -> FIXED
    const isKeep = targetLangs.every((lang) => translations[lang] === rawSource);
    parsedEntries.push({
      normalizedTerm: norm,
      sourceTerm: rawSource,
      sourceLang,
      type: isKeep ? 'KEEP' : 'FIXED',
      translations,
    });
  }

  if (parsedEntries.length > MAX_CSV_IMPORT_ROWS) {
    errors.push({
      row: nonEmptyRows[nonEmptyRows.length - 1].rowNumber,
      reason: `Số dòng hợp lệ (${parsedEntries.length}) vượt giới hạn tối đa ${MAX_CSV_IMPORT_ROWS} dòng cho mỗi lần nhập.`,
    });
  }

  const duplicates: { term: string }[] = [];
  let addedCount = 0;
  let overwrittenCount = 0;
  let skippedCount = 0;

  for (const item of parsedEntries) {
    if (existingTerms.has(item.normalizedTerm)) {
      duplicates.push({ term: item.sourceTerm });
      if (onDuplicate === 'OVERWRITE') overwrittenCount++;
      else skippedCount++;
    } else {
      addedCount++;
    }
  }

  return {
    parsedEntries,
    result: {
      validRows: parsedEntries.length,
      errors,
      duplicates,
      addedCount,
      overwrittenCount,
      skippedCount,
      version: currentVersion,
    },
  };
}

const GLOSSARY_ERROR_OVERRIDES: Partial<Record<KnownConsoleErrorCode, string>> = Object.freeze({
  INVALID_REQUEST: 'Dữ liệu thuật ngữ hoặc tệp CSV chưa hợp lệ.',
  FORBIDDEN: 'Chỉ Tenant Admin mới có quyền thêm, sửa, xóa thuật ngữ hoặc nhập CSV.',
  PERMISSION_DENIED: 'Chỉ Tenant Admin mới có quyền thêm, sửa, xóa thuật ngữ hoặc nhập CSV.',
  TENANT_SUSPENDED: 'Tổ chức đang bị tạm khóa (chế độ chỉ xem); không thể thay đổi bảng thuật ngữ.',
  VERSION_CONFLICT: 'Bảng thuật ngữ vừa được cập nhật từ phiên khác. Vui lòng tải lại và thử lại.',
  NOT_FOUND: 'Không tìm thấy thuật ngữ cần xóa hoặc chỉnh sửa.',
  UNAUTHORIZED: 'Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại.',
  NETWORK_ERROR: 'Không kết nối được tới máy chủ, vui lòng kiểm tra mạng và thử lại.',
});

export function glossaryErrorMessage(err: unknown): string {
  if (!(err instanceof GlossaryApiError)) {
    return 'Có lỗi tạm thời khi xử lý bảng thuật ngữ, vui lòng thử lại.';
  }
  return resolveConsoleError(err, {
    scope: 'glossary',
    overrides: GLOSSARY_ERROR_OVERRIDES,
  }).message;
}

// ============================================================================
// Chuyển đổi JSON (hỗ trợ cả snake_case chuẩn Bảng 2.9 và camelCase của glossaryManager)
// ============================================================================

type Json = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

export function glossaryTermFromJson(raw: Json): GlossaryTermEntry {
  const sourceTerm = str(raw.source_term ?? raw.sourceTerm);
  const normalizedTerm =
    str(raw.normalized_term ?? raw.normalizedTerm ?? raw.normalized) || normalizeGlossaryTerm(sourceTerm);
  const type: GlossaryTermType = str(raw.type) === 'KEEP' ? 'KEEP' : 'FIXED';
  const rawTranslations =
    raw.translations && typeof raw.translations === 'object' ? (raw.translations as Json) : {};
  const translations: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawTranslations)) {
    if (typeof v === 'string') translations[k] = v;
  }

  return {
    normalizedTerm,
    sourceTerm,
    sourceLang: str(raw.source_lang ?? raw.sourceLang) || 'vi',
    type,
    translations,
    updatedInVersion: num(raw.updated_in_version ?? raw.updatedInVersion ?? raw.sinceVersion, 1),
    updatedAt: str(raw.updated_at ?? raw.updatedAt) || new Date().toISOString(),
  };
}

export function csvImportResultFromJson(raw: Json): CsvImportPreviewOrCommitResult {
  const errorsRaw = Array.isArray(raw.errors) ? (raw.errors as Json[]) : [];
  const duplicatesRaw = Array.isArray(raw.duplicates) ? (raw.duplicates as Json[]) : [];

  return {
    validRows: num(raw.valid_rows ?? raw.validRows, 0),
    errors: errorsRaw.map((e) => ({
      row: num(e.row, 1),
      reason: str(e.reason),
    })),
    duplicates: duplicatesRaw.map((d) => ({
      term: str(d.term),
    })),
    addedCount: num(raw.added_count ?? raw.addedCount, 0),
    overwrittenCount: num(raw.overwritten_count ?? raw.overwrittenCount, 0),
    skippedCount: num(raw.skipped_count ?? raw.skippedCount, 0),
    version: num(raw.version, 0),
    ...(raw.terminology_synced !== undefined || raw.terminologySynced !== undefined
      ? { terminologySynced: Boolean(raw.terminology_synced ?? raw.terminologySynced) }
      : {}),
  };
}

// ============================================================================
// Giao diện GlossaryApi
// ============================================================================

export interface GlossaryApi {
  listGlossary(): Promise<GlossaryStateResponse>;
  upsertTerm(input: UpsertGlossaryTermInput): Promise<UpsertGlossaryTermResponse>;
  deleteTerm(sourceTerm: string): Promise<DeleteGlossaryTermResponse>;
  previewImportCsv(
    csvText: string,
    onDuplicate: DuplicateHandlingMode,
  ): Promise<CsvImportPreviewOrCommitResult>;
  commitImportCsv(
    csvText: string,
    onDuplicate: DuplicateHandlingMode,
  ): Promise<CsvImportPreviewOrCommitResult>;
}

// ============================================================================
// Bản gọi REST API thật (VITE_AUTH_MODE=cognito)
// ============================================================================

export interface HttpGlossaryApiOptions {
  baseUrl: string;
  getToken: () => string;
  fetchFn?: typeof fetch;
}

export function createHttpGlossaryApi(opts: HttpGlossaryApiOptions): GlossaryApi {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const doFetch = opts.fetchFn ?? ((...a: Parameters<typeof fetch>) => fetch(...a));

  async function request(
    method: 'GET' | 'PUT' | 'DELETE' | 'POST',
    path: string,
    body?: Json,
  ): Promise<Json> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${opts.getToken()}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new GlossaryApiError('NETWORK_ERROR', 'Không kết nối được tới máy chủ.');
    }

    let data: Json = {};
    try {
      data = (await res.json()) as Json;
    } catch {
      data = {};
    }

    if (!res.ok) {
      const extracted = extractApiErrorPayload(data, res.status);
      throw new GlossaryApiError(
        extracted.code,
        extracted.message,
        extracted.requestId,
        extracted.httpStatus,
      );
    }
    return data;
  }

  return {
    async listGlossary() {
      const data = await request('GET', '/console/glossary/terms');
      const termsRaw = Array.isArray(data.terms) ? (data.terms as Json[]) : [];
      const terminologyName = str(data.terminology_name ?? data.terminologyName) || undefined;
      return {
        version: num(data.version, 0),
        ...(terminologyName ? { terminologyName } : {}),
        terms: termsRaw.map(glossaryTermFromJson),
      };
    },

    async upsertTerm(input) {
      const encoded = encodeURIComponent(input.sourceTerm);
      const data = await request('PUT', `/console/glossary/terms/${encoded}`, {
        sourceTerm: input.sourceTerm,
        sourceLang: input.sourceLang,
        type: input.type,
        translations: input.translations,
        targetLangs: input.targetLangs,
      });
      return {
        term: glossaryTermFromJson(
          (data.term as Json | undefined) ?? {
            sourceTerm: input.sourceTerm,
            sourceLang: input.sourceLang,
            type: input.type,
            translations: input.translations ?? {},
            sinceVersion: data.version,
          },
        ),
        version: num(data.version, 1),
        ...(data.terminology_synced !== undefined || data.terminologySynced !== undefined
          ? { terminologySynced: Boolean(data.terminology_synced ?? data.terminologySynced) }
          : {}),
      };
    },

    async deleteTerm(sourceTerm) {
      const encoded = encodeURIComponent(sourceTerm);
      const data = await request('DELETE', `/console/glossary/terms/${encoded}`);
      return {
        deleted: data.deleted !== false,
        version: num(data.version, 1),
        ...(data.terminology_synced !== undefined || data.terminologySynced !== undefined
          ? { terminologySynced: Boolean(data.terminology_synced ?? data.terminologySynced) }
          : {}),
      };
    },

    async previewImportCsv(csvText, onDuplicate) {
      const data = await request('POST', '/console/glossary/import/preview', {
        csv: csvText,
        mode: 'PREVIEW',
        onDuplicate,
      });
      return csvImportResultFromJson(data);
    },

    async commitImportCsv(csvText, onDuplicate) {
      const data = await request('POST', '/console/glossary/import', {
        csv: csvText,
        mode: 'COMMIT',
        onDuplicate,
      });
      return csvImportResultFromJson(data);
    },
  };
}

// ============================================================================
// Bản giả lập cho chế độ demo (VITE_AUTH_MODE=mock)
// ============================================================================

const INITIAL_DEMO_TERMS: readonly GlossaryTermEntry[] = Object.freeze([
  {
    normalizedTerm: 'homestay abc',
    sourceTerm: 'Homestay ABC',
    sourceLang: 'vi',
    type: 'KEEP',
    translations: {
      en: 'Homestay ABC',
      ko: 'Homestay ABC',
      ja: 'Homestay ABC',
      zh: 'Homestay ABC',
      fr: 'Homestay ABC',
    },
    updatedInVersion: 1,
    updatedAt: '2026-10-25T08:00:00.000Z',
  },
  {
    normalizedTerm: 'phố cổ hội an',
    sourceTerm: 'phố cổ Hội An',
    sourceLang: 'vi',
    type: 'FIXED',
    translations: {
      en: 'Hoi An Ancient Town',
      ko: '호이안 구시가지',
      ja: 'ホイアン旧市街',
      zh: '会安古镇',
      fr: 'Vieille ville de Hoi An',
    },
    updatedInVersion: 2,
    updatedAt: '2026-10-26T09:30:00.000Z',
  },
  {
    normalizedTerm: 'cao lầu',
    sourceTerm: 'cao lầu',
    sourceLang: 'vi',
    type: 'FIXED',
    translations: {
      en: 'cao lau noodles',
      ko: '까오러우 국수',
      ja: 'カオラウ',
      zh: '高楼面',
      fr: 'nouilles cao lau',
    },
    updatedInVersion: 2,
    updatedAt: '2026-10-26T09:30:00.000Z',
  },
  {
    normalizedTerm: 'sông hoài',
    sourceTerm: 'sông Hoài',
    sourceLang: 'vi',
    type: 'FIXED',
    translations: {
      en: 'Hoai River',
      ko: '호아이 강',
      ja: 'ホアイ川',
      zh: '怀河',
      fr: 'rivière Hoai',
    },
    updatedInVersion: 2,
    updatedAt: '2026-10-26T09:30:00.000Z',
  },
]);

export interface MockGlossaryApiOptions {
  tenantId?: string;
  now?: () => string;
}

export function createMockGlossaryApi(opts: MockGlossaryApiOptions = {}): GlossaryApi {
  const tenantId = opts.tenantId ?? 't_01hxyz987654';
  const now = opts.now ?? (() => new Date().toISOString());
  let version = 2;
  const terms = new Map<string, GlossaryTermEntry>();

  for (const t of INITIAL_DEMO_TERMS) {
    terms.set(t.normalizedTerm, {
      ...t,
      translations: { ...t.translations },
    });
  }

  const terminologyNameOf = (v: number) => (v > 0 ? `tm-${tenantId}-v${v}` : undefined);

  const sortedTerms = (): GlossaryTermEntry[] =>
    [...terms.values()]
      .sort((a, b) => a.normalizedTerm.localeCompare(b.normalizedTerm, 'vi'))
      .map((t) => ({ ...t, translations: { ...t.translations } }));

  return {
    async listGlossary() {
      return {
        version,
        ...(version > 0 ? { terminologyName: terminologyNameOf(version) } : {}),
        terms: sortedTerms(),
      };
    },

    async upsertTerm(input) {
      const validationErr = validateUpsertTermInput(input);
      if (validationErr) {
        throw new GlossaryApiError('INVALID_REQUEST', validationErr);
      }

      const srcLang = cleanTermText(input.sourceLang || 'vi').toLowerCase() || 'vi';
      const cleanedSource = cleanTermText(input.sourceTerm);
      const norm = normalizeGlossaryTerm(cleanedSource);

      const translations: Record<string, string> = {};
      if (input.type === 'KEEP') {
        const keepLangs =
          input.targetLangs && input.targetLangs.length > 0
            ? sortGlossaryLangCodes(
                [...input.targetLangs, ...Object.keys(input.translations ?? {})]
                  .map((l) => cleanTermText(l).toLowerCase())
                  .filter((l) => l && l !== srcLang),
              )
            : input.translations && Object.keys(input.translations).length > 0
              ? sortGlossaryLangCodes(
                  Object.keys(input.translations)
                    .map((l) => cleanTermText(l).toLowerCase())
                    .filter((l) => l && l !== srcLang),
                )
              : [...DEFAULT_GLOSSARY_TARGET_LANGS].filter((l) => l !== srcLang);
        for (const lang of keepLangs) {
          translations[lang] = cleanedSource;
        }
      } else {
        for (const [rawLang, val] of Object.entries(input.translations)) {
          const lang = cleanTermText(rawLang).toLowerCase();
          const cleanedVal = cleanTermText(val);
          if (lang && lang !== srcLang && cleanedVal) {
            translations[lang] = cleanedVal;
          }
        }
      }

      version += 1;
      const entry: GlossaryTermEntry = {
        normalizedTerm: norm,
        sourceTerm: cleanedSource,
        sourceLang: srcLang,
        type: input.type,
        translations,
        updatedInVersion: version,
        updatedAt: now(),
      };
      terms.set(norm, entry);

      return {
        term: { ...entry, translations: { ...entry.translations } },
        version,
        terminologySynced: true,
      };
    },

    async deleteTerm(sourceTerm) {
      const norm = normalizeGlossaryTerm(sourceTerm);
      if (!terms.has(norm)) {
        throw new GlossaryApiError('NOT_FOUND', `Không tìm thấy thuật ngữ "${sourceTerm}".`);
      }
      terms.delete(norm);
      version += 1;
      return {
        deleted: true,
        version,
        terminologySynced: true,
      };
    },

    async previewImportCsv(csvText, onDuplicate) {
      const { result } = analyzeGlossaryCsv(csvText, terms, onDuplicate, version);
      return result;
    },

    async commitImportCsv(csvText, onDuplicate) {
      const { parsedEntries, result } = analyzeGlossaryCsv(csvText, terms, onDuplicate, version);
      if (result.errors.length > 0 && result.validRows === 0) {
        throw new GlossaryApiError(
          'INVALID_REQUEST',
          result.errors[0]?.reason ?? 'Tệp CSV không có dòng hợp lệ để nhập.',
        );
      }
      if (result.validRows > MAX_CSV_IMPORT_ROWS) {
        throw new GlossaryApiError(
          'INVALID_REQUEST',
          `Vượt quá giới hạn ${MAX_CSV_IMPORT_ROWS} dòng hợp lệ mỗi lần nhập.`,
        );
      }

      const toWrite = parsedEntries.filter(
        (item) => !terms.has(item.normalizedTerm) || onDuplicate === 'OVERWRITE',
      );

      if (toWrite.length === 0) {
        return {
          ...result,
          version,
          terminologySynced: false,
        };
      }

      version += 1;
      const ts = now();
      for (const item of toWrite) {
        terms.set(item.normalizedTerm, {
          normalizedTerm: item.normalizedTerm,
          sourceTerm: item.sourceTerm,
          sourceLang: item.sourceLang,
          type: item.type,
          translations: { ...item.translations },
          updatedInVersion: version,
          updatedAt: ts,
        });
      }

      return {
        ...result,
        version,
        terminologySynced: true,
      };
    },
  };
}
