/**
 * Các hàm phân tích & kiểm tra thuần (Pure Analyzers) cho Nhiệm vụ 1.12:
 *  - Thử nghiệm 1: Kiểm tra bảo toàn thẻ `<span data-i="k">...</span>` (`inspectSpanTags`)
 *  - Thử nghiệm 2: Đếm ký tự theo Unicode code point có thẻ vs không thẻ (`analyzeCharacterBilling`)
 *  - Thử nghiệm 3: Kiểm tra ký hiệu `{n}...{/n}` (`check_markers`)
 *  - Thử nghiệm 4: Đánh giá ngưỡng tin cậy Comprehend (`evaluateLanguageConfidence`)
 *  - Thử nghiệm 5: Kiểm tra áp dụng thuật ngữ Custom Terminology (`checkTerminologyApplied`)
 *
 * Tất cả các hàm trong file này là hàm thuần (không gọi mạng), được unit test độc lập bằng `node:test`.
 */

export type TargetLang = 'en' | 'ko' | 'ja';

export const TARGET_LANGUAGES: readonly TargetLang[] = Object.freeze(['en', 'ko', 'ja']);

// ============================================================================
// THỬ NGHIỆM 1: Kiểm tra thẻ <span data-i="k">...</span>
// ============================================================================

export interface SpanInspectionResult {
  /** Tất cả thẻ mở/đóng và thuộc tính data-i đều nguyên vẹn, hợp lệ */
  tagsIntact: boolean;
  /** Số thẻ mở `<span...>` bằng số thẻ đóng `</span>` */
  openEqualsClose: boolean;
  openCount: number;
  closeCount: number;
  expectedOpenCount: number;
  /** Mọi giá trị `data-i="k"` ở câu gốc đều xuất hiện đúng số lần trong bản dịch */
  dataIValuesIntact: boolean;
  expectedDataI: string[];
  actualDataI: string[];
  missingDataI: string[];
  extraDataI: string[];
  /**
   * Vị trí thẻ hợp lý:
   * - Không có thẻ đóng xuất hiện trước thẻ mở tương ứng
   * - Nội dung bên trong mỗi `<span data-i="k">` không bị rỗng
   * - Với ko/ja (ngôn ngữ SOV có đảo trật tự từ), cho phép thứ tự các cụm `<span data-i="k">` đảo vị trí miễn là cấu trúc lồng nhau hợp lệ.
   */
  positionReasonable: boolean;
  /** Thứ tự xuất hiện của `data-i` có bị đảo so với câu gốc không (thường gặp ở ko/ja) */
  orderReordered: boolean;
  /** Có hiện tượng thêm/bớt khoảng trắng bất thường ngay sát trong hoặc ngoài thẻ `<span>` không */
  whitespaceChanged: boolean;
  whitespaceNotes: string[];
}

/**
 * Phân tích cấu trúc thẻ `<span data-i="k">...</span>` trước và sau khi dịch.
 */
export function inspectSpanTags(sourceHtml: string, translatedHtml: string): SpanInspectionResult {
  const openTagRegex = /<span\b[^>]*>/gi;
  const closeTagRegex = /<\/span\s*>/gi;
  const dataIRegex = /<span\b[^>]*\bdata-i\s*=\s*["']([^"']+)["'][^>]*>/gi;

  const srcOpenMatches = sourceHtml.match(openTagRegex) ?? [];
  const trOpenMatches = translatedHtml.match(openTagRegex) ?? [];
  const trCloseMatches = translatedHtml.match(closeTagRegex) ?? [];

  const expectedDataI = Array.from(sourceHtml.matchAll(dataIRegex), (m) => m[1]);
  const actualDataI = Array.from(translatedHtml.matchAll(dataIRegex), (m) => m[1]);

  const openCount = trOpenMatches.length;
  const closeCount = trCloseMatches.length;
  const expectedOpenCount = srcOpenMatches.length;
  const openEqualsClose = openCount === closeCount && openCount === expectedOpenCount;

  // So sánh đa tập hợp (multiset) của các giá trị data-i
  const expectedSorted = [...expectedDataI].sort();
  const actualSorted = [...actualDataI].sort();
  const missingDataI: string[] = [];
  const extraDataI: string[] = [];

  const expCountMap = new Map<string, number>();
  for (const k of expectedDataI) expCountMap.set(k, (expCountMap.get(k) ?? 0) + 1);
  const actCountMap = new Map<string, number>();
  for (const k of actualDataI) actCountMap.set(k, (actCountMap.get(k) ?? 0) + 1);

  for (const [k, cnt] of expCountMap.entries()) {
    const act = actCountMap.get(k) ?? 0;
    for (let i = 0; i < cnt - act; i++) missingDataI.push(k);
  }
  for (const [k, cnt] of actCountMap.entries()) {
    const exp = expCountMap.get(k) ?? 0;
    for (let i = 0; i < cnt - exp; i++) extraDataI.push(k);
  }

  const dataIValuesIntact =
    expectedSorted.length === actualSorted.length &&
    missingDataI.length === 0 &&
    extraDataI.length === 0 &&
    trOpenMatches.length === actualDataI.length; // mọi thẻ <span ...> đều giữ được thuộc tính data-i

  // Kiểm tra cân bằng đóng/mở theo ngăn xếp (stack) và kiểm tra rỗng
  const tokenRegex = /<span\b[^>]*\bdata-i\s*=\s*["']([^"']+)["'][^>]*>|<span\b[^>]*>|<\/span\s*>/gi;
  let depth = 0;
  let balancedWalk = true;
  for (const match of translatedHtml.matchAll(tokenRegex)) {
    const token = match[0].toLowerCase();
    if (token.startsWith('</span')) {
      depth--;
      if (depth < 0) {
        balancedWalk = false;
        break;
      }
    } else {
      depth++;
    }
  }
  if (depth !== 0) balancedWalk = false;

  // Kiểm tra có thẻ `<span ...></span>` bị rỗng nội dung không
  const emptySpanRegex = /<span\b[^>]*>\s*<\/span\s*>/i;
  const hasEmptySpan = emptySpanRegex.test(translatedHtml);

  const positionReasonable = balancedWalk && !hasEmptySpan && openEqualsClose;
  const orderReordered =
    dataIValuesIntact && expectedDataI.some((val, idx) => actualDataI[idx] !== val);

  // Kiểm tra thêm/bớt khoảng trắng quanh thẻ:
  // 1) Khoảng trắng lọt vào sát bên trong thẻ mở/đóng: `<span data-i="k"> text` hoặc `text </span>`
  // 2) Dính chữ (mất khoảng trắng) giữa từ Latin/Việt và thẻ `<span` (không áp dụng cảnh báo dính chữ cho tiếng Nhật/Hàn vốn không dùng dấu cách như tiếng Anh)
  const whitespaceNotes: string[] = [];
  if (/<span\b[^>]*>\s+\S/i.test(translatedHtml) && !/<span\b[^>]*>\s+\S/i.test(sourceHtml)) {
    whitespaceNotes.push('Thêm khoảng trắng ngay sau thẻ mở <span>');
  }
  if (/\S\s+<\/span\s*>/i.test(translatedHtml) && !/\S\s+<\/span\s*>/i.test(sourceHtml)) {
    whitespaceNotes.push('Thêm khoảng trắng ngay trước thẻ đóng </span>');
  }
  if (/[A-Za-zÀ-ỹ0-9]<span\b/i.test(translatedHtml) && !/[A-Za-zÀ-ỹ0-9]<span\b/i.test(sourceHtml)) {
    whitespaceNotes.push('Mất khoảng trắng trước thẻ mở <span>');
  }
  if (/<\/span\s*>[A-Za-zÀ-ỹ0-9]/i.test(translatedHtml) && !/<\/span\s*>[A-Za-zÀ-ỹ0-9]/i.test(sourceHtml)) {
    whitespaceNotes.push('Mất khoảng trắng sau thẻ đóng </span>');
  }

  const whitespaceChanged = whitespaceNotes.length > 0;
  const tagsIntact = openEqualsClose && dataIValuesIntact && positionReasonable;

  return {
    tagsIntact,
    openEqualsClose,
    openCount,
    closeCount,
    expectedOpenCount,
    dataIValuesIntact,
    expectedDataI,
    actualDataI,
    missingDataI,
    extraDataI,
    positionReasonable,
    orderReordered,
    whitespaceChanged,
    whitespaceNotes,
  };
}

// ============================================================================
// THỬ NGHIỆM 2: Cách tính ký tự (đếm theo Unicode code point)
// ============================================================================

export interface CharacterBillingAnalysis {
  /** Văn bản thuần (đã bỏ mọi thẻ HTML) */
  plainText: string;
  /** Văn bản có bọc thẻ `<span data-i="k">...</span>` */
  taggedHtml: string;
  /** Số Unicode code point khi KHÔNG có thẻ */
  codePointsWithoutTags: number;
  /** Số Unicode code point khi CÓ thẻ (số ký tự gửi sang TranslateText) */
  codePointsWithTags: number;
  /** Số ký tự tăng thêm do thẻ HTML */
  tagOverheadCodePoints: number;
  /** Tỷ lệ tăng ký tự do thẻ (%) */
  overheadPercent: number;
  /** Độ dài byte UTF-8 khi có thẻ (để tham khảo giới hạn 10.000 byte/request) */
  utf8BytesWithTags: number;
}

/** Đếm số Unicode code point của chuỗi (khớp cách Amazon Translate tính ký tự Unicode). */
export function countCodePoints(text: string): number {
  return Array.from(text).length;
}

/** Loại bỏ toàn bộ thẻ HTML để lấy chuỗi thuần. */
export function stripHtmlTags(html: string): string {
  return html.replace(/<\/?[a-zA-Z][^>]*>/g, '');
}

/**
 * So sánh số ký tự (theo code point) của cùng một câu khi CÓ thẻ và KHÔNG thẻ.
 */
export function analyzeCharacterBilling(taggedHtml: string): CharacterBillingAnalysis {
  const plainText = stripHtmlTags(taggedHtml);
  const codePointsWithoutTags = countCodePoints(plainText);
  const codePointsWithTags = countCodePoints(taggedHtml);
  const tagOverheadCodePoints = codePointsWithTags - codePointsWithoutTags;
  const overheadPercent =
    codePointsWithoutTags > 0
      ? Number(((tagOverheadCodePoints / codePointsWithoutTags) * 100).toFixed(2))
      : 0;

  return {
    plainText,
    taggedHtml,
    codePointsWithoutTags,
    codePointsWithTags,
    tagOverheadCodePoints,
    overheadPercent,
    utf8BytesWithTags: Buffer.byteLength(taggedHtml, 'utf8'),
  };
}

// ============================================================================
// THỬ NGHIỆM 3: Kiểm tra ký hiệu {n} ... {/n} (check_markers)
// ============================================================================

export interface MarkerCheckResult {
  /** Tất cả cặp `{n}...{/n}` đều sống sót nguyên vẹn, đóng mở hợp lệ, không biến dạng */
  survived: boolean;
  expectedOpenIds: string[];
  expectedCloseIds: string[];
  actualOpenIds: string[];
  actualCloseIds: string[];
  /** Các marker bị thiếu trong bản dịch (ví dụ `["{1}", "{/1}"]`) */
  missingMarkers: string[];
  /** Các marker xuất hiện thừa trong bản dịch */
  extraMarkers: string[];
  /** Các marker bị biến dạng do dịch máy (ví dụ `{ 1 }`, `{/ 1}`, `｛1｝`, `[1]`) */
  mutatedMarkers: string[];
  /** Cấu trúc đóng mở `{n}` trước `{/n}` có hợp lệ không */
  properlyPaired: boolean;
}

/**
 * Hàm `check_markers`: Kiểm tra sự toàn vẹn của các ký hiệu mỏ neo `{n}` và `{/n}` sau khi dịch.
 * Phát hiện:
 *  - Thiếu hoặc thừa `{n}` / `{/n}`
 *  - Đóng trước khi mở hoặc đóng lệch cặp
 *  - Bị biến dạng do NMT (thêm khoảng trắng `{ 1 }`, `{ /1 }`, đổi sang ngoặc fullwidth `｛1｝` ở tiếng Nhật/Hàn)
 */
export function check_markers(sourceText: string, translatedText: string): MarkerCheckResult {
  const exactOpenRegex = /\{(\d+)\}/g;
  const exactCloseRegex = /\{\/(\d+)\}/g;

  const expectedOpenIds = Array.from(sourceText.matchAll(exactOpenRegex), (m) => m[1]);
  const expectedCloseIds = Array.from(sourceText.matchAll(exactCloseRegex), (m) => m[1]);
  const actualOpenIds = Array.from(translatedText.matchAll(exactOpenRegex), (m) => m[1]);
  const actualCloseIds = Array.from(translatedText.matchAll(exactCloseRegex), (m) => m[1]);

  // Phát hiện các dạng biến dạng phổ biến do engine dịch tạo ra:
  // - Có khoảng trắng bên trong ngoặc nhọn: `{ 1 }`, `{ /1 }`, `{/ 1}`
  // - Ngoặc nhọn fullwidth (CJK): `｛1｝`, `｛/1｝`
  const mutatedMarkers: string[] = [];
  const spacedBraceRegex = /\{\s+\/?\s*\d+\s*\}|\{\s*\/\s+\d+\s*\}|\{\/?\d+\s+\}/g;
  const fullwidthBraceRegex = /［\/?\d+］|｛\s*\/?\s*\d+\s*｝/g;

  for (const m of translatedText.matchAll(spacedBraceRegex)) {
    mutatedMarkers.push(m[0]);
  }
  for (const m of translatedText.matchAll(fullwidthBraceRegex)) {
    mutatedMarkers.push(m[0]);
  }

  // Tìm marker thiếu / thừa
  const missingMarkers: string[] = [];
  const extraMarkers: string[] = [];

  const diffMultiset = (expected: string[], actual: string[], fmt: (id: string) => string) => {
    const expMap = new Map<string, number>();
    for (const id of expected) expMap.set(id, (expMap.get(id) ?? 0) + 1);
    const actMap = new Map<string, number>();
    for (const id of actual) actMap.set(id, (actMap.get(id) ?? 0) + 1);

    for (const [id, cnt] of expMap.entries()) {
      const act = actMap.get(id) ?? 0;
      for (let i = 0; i < cnt - act; i++) missingMarkers.push(fmt(id));
    }
    for (const [id, cnt] of actMap.entries()) {
      const exp = expMap.get(id) ?? 0;
      for (let i = 0; i < cnt - exp; i++) extraMarkers.push(fmt(id));
    }
  };

  diffMultiset(expectedOpenIds, actualOpenIds, (id) => `{${id}}`);
  diffMultiset(expectedCloseIds, actualCloseIds, (id) => `{/${id}}`);

  // Kiểm tra đóng/mở đúng thứ tự cho từng chỉ số n (mỗi {n} phải xuất hiện trước {/n} tương ứng và không rỗng)
  const tokenRegex = /\{(\/?)(\d+)\}/g;
  const openSet = new Set<string>();
  let properlyPaired = true;
  for (const match of translatedText.matchAll(tokenRegex)) {
    const isClose = match[1] === '/';
    const id = match[2];
    if (!isClose) {
      if (openSet.has(id)) {
        properlyPaired = false;
        break;
      }
      openSet.add(id);
    } else {
      if (!openSet.has(id)) {
        properlyPaired = false;
        break;
      }
      openSet.delete(id);
    }
  }
  if (openSet.size !== 0) properlyPaired = false;

  const survived =
    missingMarkers.length === 0 &&
    extraMarkers.length === 0 &&
    mutatedMarkers.length === 0 &&
    properlyPaired;

  return {
    survived,
    expectedOpenIds,
    expectedCloseIds,
    actualOpenIds,
    actualCloseIds,
    missingMarkers,
    extraMarkers,
    mutatedMarkers,
    properlyPaired,
  };
}

// ============================================================================
// THỬ NGHIỆM 4: Đánh giá ngưỡng tin cậy Comprehend (0.70)
// ============================================================================

export const RECOMMENDED_CONFIDENCE_THRESHOLD = 0.7;

export interface DominantLanguageCheck {
  topLanguageCode: string;
  topScore: number;
  belowThreshold: boolean;
  threshold: number;
}

export function evaluateLanguageConfidence(
  languages: ReadonlyArray<{ LanguageCode?: string; Score?: number }> | undefined,
  threshold = RECOMMENDED_CONFIDENCE_THRESHOLD,
): DominantLanguageCheck {
  if (!languages || languages.length === 0) {
    return {
      topLanguageCode: 'unknown',
      topScore: 0,
      belowThreshold: true,
      threshold,
    };
  }
  const sorted = [...languages].sort((a, b) => (b.Score ?? 0) - (a.Score ?? 0));
  const top = sorted[0];
  const score = Number((top.Score ?? 0).toFixed(4));
  return {
    topLanguageCode: top.LanguageCode ?? 'unknown',
    topScore: score,
    belowThreshold: score < threshold,
    threshold,
  };
}

// ============================================================================
// THỬ NGHIỆM 5: Kiểm tra Custom Terminology
// ============================================================================

export interface TerminologyTerm {
  vi: string;
  en: string;
  ko: string;
  ja: string;
  type: 'KEEP' | 'FIXED_TRANSLATION';
}

export interface TerminologyApplicationCheck {
  /** Все thuật ngữ kỳ vọng trong câu đều xuất hiện trong bản dịch */
  allApplied: boolean;
  /** Cờ đánh dấu cho module hậu kiểm (F4): `true` khi có thuật ngữ KHÔNG được áp dụng */
  needsReview: boolean;
  matchedTerms: string[];
  missedTerms: string[];
}

/**
 * Tạo nội dung file CSV UTF-8 cho `ImportTerminology` của Amazon Translate.
 * Dòng đầu là mã ngôn ngữ (`vi,en,ko,ja`), cột đầu là ngôn ngữ nguồn (`vi`).
 */
export function buildTerminologyCsv(terms: readonly TerminologyTerm[]): string {
  const escapeCsvCell = (val: string): string => {
    if (/[",\r\n]/.test(val)) {
      return `"${val.replace(/"/g, '""')}"`;
    }
    return val;
  };
  const lines = ['vi,en,ko,ja'];
  for (const t of terms) {
    lines.push([t.vi, t.en, t.ko, t.ja].map(escapeCsvCell).join(','));
  }
  return lines.join('\n') + '\n';
}

/**
 * Kiểm tra bản dịch có chứa đầy đủ các thuật ngữ đích kỳ vọng hay không.
 * Nếu thiếu bất kỳ thuật ngữ nào -> `needsReview = true` (module hậu kiểm sẽ gắn nhãn "Cần xem lại").
 */
export function checkTerminologyApplied(
  translatedText: string,
  expectedTargetTerms: readonly string[],
): TerminologyApplicationCheck {
  const plain = stripHtmlTags(translatedText);
  const matchedTerms: string[] = [];
  const missedTerms: string[] = [];

  for (const term of expectedTargetTerms) {
    if (plain.includes(term)) {
      matchedTerms.push(term);
    } else {
      missedTerms.push(term);
    }
  }

  const allApplied = missedTerms.length === 0;
  return {
    allApplied,
    needsReview: !allApplied,
    matchedTerms,
    missedTerms,
  };
}
