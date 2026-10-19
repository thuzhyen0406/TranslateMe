/**
 * markers – ký hiệu mỏ neo '{n}…{/n}' cho thẻ nội tuyến (Nhiệm vụ 1.5 – TV2).
 * Dùng chung cho: F2 (proxy: extract/rebuild), TV3 (normalize_hash, TM), F4 (hậu kiểm).
 *
 * Quy ước dạng chuỗi nội bộ (dùng để  băm SHA-256, lưu TM, hiển thị cho Reviewer):
 *  - '{n}' … '{/n}' : cặp thẻ nội tuyến (a, strong, em, code…), n là số nguyên dương.
 *  - '{n/}'         : phần tử rỗng nằm giữa câu (img, br, input…).
 *  - '{{' và '}}'   : dấu ngoặc nhọn có thật trong văn bản (thoát ký tự, xem escapeMarkerText).
 *
 * Khi gửi Amazon Translate (ContentType = text/html) chuỗi được đổi sang:
 *  - '{n}…{/n}' -> '<span data-i="n">…</span>'
 *  - '{n/}'     -> '<span data-i="n" data-v></span>'   (CHƯA kiểm chứng trên AWS thật)
 * và đổi ngược lại bằng spanHtmlToMarkers() sau khi dịch.
 *
 * Nguyên tắc (theo docs/Quy ước trước khi code.md, mục 3.2):
 *  - Khôi phục thẻ theo GIÁ TRỊ id, không theo thứ tự xuất hiện (ko/ja hay đảo vị trí cụm).
 *  - Hàm không throw với dữ liệu xấu: trả về cờ 'ok' + danh sách lỗi để người gọi chọn fallback.
 */

/** Ngưỡng rủi ro 1.5 (Bảng 3.2): quá 5% số câu mất/lệch marker thì phải đổi phương án. */
export const MARKER_LOSS_THRESHOLD = 0.05;

export type MarkerToken =
  | { type: 'text'; value: string }
  | { type: 'open'; id: string }
  | { type: 'close'; id: string }
  | { type: 'void'; id: string };

/** Một marker hợp lệ tại vị trí cho trước: '{n}', '{/n}' hoặc '{n/}' (n từ 1, tối đa 6 chữ số). */
const MARKER_AT = /\{(\/)?([1-9]\d{0,5})(\/)?\}/y;

export type MarkerAt =
  | { kind: 'open' | 'close' | 'void'; id: string; len: number }
  | { kind: 'escape'; char: '{' | '}'; len: 2 }
  | null;

/**
 * Đọc marker (hoặc ký tự thoát '{{'/'}}') bắt đầu đúng tại vị trí 'i'. Trả null nếu tại đó là ký tự thường.
 * Dùng nội bộ cho tokenizeMarkers và segmenter.
 */
export function markerAt(text: string, i: number): MarkerAt {
  const ch = text[i];
  if (ch !== '{' && ch !== '}') return null;
  if (text[i + 1] === ch) return { kind: 'escape', char: ch, len: 2 };
  if (ch === '}') return null;
  MARKER_AT.lastIndex = i;
  const m = MARKER_AT.exec(text);
  if (!m || (m[1] && m[3])) return null; // '{/1/}' không hợp lệ -> coi như văn bản
  const kind = m[1] ? 'close' : m[3] ? 'void' : 'open';
  return { kind, id: m[2], len: m[0].length };
}

/** Thoát dấu ngoặc nhọn có thật trong văn bản thuần trước khi ghép marker: '{' -> '{{', '}' -> '}}'. */
export function escapeMarkerText(plain: string): string {
  return plain.replace(/[{}]/g, (c) => c + c);
}

/** Tách chuỗi marker thành token. Dấu '{'/'}' lẻ không thành marker được giữ nguyên như văn bản. */
export function tokenizeMarkers(text: string): MarkerToken[] {
  const tokens: MarkerToken[] = [];
  let buf = '';
  let i = 0;
  while (i < text.length) {
    const m = markerAt(text, i);
    if (m === null) {
      buf += text[i];
      i++;
      continue;
    }
    if (m.kind === 'escape') {
      buf += m.char;
    } else {
      if (buf) tokens.push({ type: 'text', value: buf });
      buf = '';
      tokens.push({ type: m.kind, id: m.id });
    }
    i += m.len;
  }
  if (buf) tokens.push({ type: 'text', value: buf });
  return tokens;
}

/** Ghép token về chuỗi marker (văn bản được thoát ngoặc nhọn). */
export function serializeMarkers(tokens: readonly MarkerToken[]): string {
  return tokens
    .map((t) => {
      switch (t.type) {
        case 'text':
          return escapeMarkerText(t.value);
        case 'open':
          return '{${t.id}}';
        case 'close':
          return '{/${t.id}}';
        case 'void':
          return '{${t.id}/}';
      }
    })
    .join('');
}

/** Văn bản thuần (bỏ toàn bộ marker, giải thoát ngoặc nhọn). Dùng cho fallback và đếm ký tự. */
export function stripMarkers(text: string): string {
  return tokenizeMarkers(text)
    .filter((t): t is Extract<MarkerToken, { type: 'text' }> => t.type === 'text')
    .map((t) => t.value)
    .join('');
}

// ============================================================================
// Kiểm tra cấu trúc
// ============================================================================

export type MarkerErrorCode = 'UNMATCHED_CLOSE' | 'MISMATCHED_CLOSE' | 'UNCLOSED_OPEN' | 'DUPLICATE_ID';

export interface MarkerError {
  code: MarkerErrorCode;
  id: string;
}

export interface MarkerValidation {
  ok: boolean;
  errors: MarkerError[];
  /** id theo thứ tự xuất hiện của marker mở / marker rỗng */
  ids: string[];
}

interface MarkerStructure extends MarkerValidation {
  /** id -> id của cặp bao ngoài trực tiếp (null nếu ở cấp ngoài cùng) */
  parent: Map<string, string | null>;
  /** id -> số ký tự không phải khoảng trắng nằm bên trong cặp (kể cả cặp con) */
  contentChars: Map<string, number>;
  voidIds: Set<string>;
}

function analyzeStructure(tokens: readonly MarkerToken[]): MarkerStructure {
  const errors: MarkerError[] = [];
  const ids: string[] = [];
  const seen = new Set<string>();
  const parent = new Map<string, string | null>();
  const contentChars = new Map<string, number>();
  const voidIds = new Set<string>();
  const stack: string[] = [];

  const addContent = (n: number): void => {
    for (const id of stack) contentChars.set(id, (contentChars.get(id) ?? 0) + n);
  };

  for (const t of tokens) {
    switch (t.type) {
      case 'text':
        addContent(t.value.replace(/\s+/gu, '').length);
        break;
      case 'open':
      case 'void':
        if (seen.has(t.id)) errors.push({ code: 'DUPLICATE_ID', id: t.id });
        seen.add(t.id);
        ids.push(t.id);
        parent.set(t.id, stack.length ? stack[stack.length - 1] : null);
        if (t.type === 'open') {
          contentChars.set(t.id, 0);
          stack.push(t.id);
        } else {
          voidIds.add(t.id);
          addContent(1);
        }
        break;
      case 'close': {
        if (stack.length && stack[stack.length - 1] === t.id) {
          stack.pop();
        } else if (stack.includes(t.id)) {
          errors.push({ code: 'MISMATCHED_CLOSE', id: t.id });
          while (stack.length && stack.pop() !== t.id) {
            /* đóng lệch cặp: bỏ các cặp đang mở bên trong */
          }
        } else {
          errors.push({ code: 'UNMATCHED_CLOSE', id: t.id });
        }
        break;
      }
    }
  }
  for (const id of stack) errors.push({ code: 'UNCLOSED_OPEN', id });
  return { ok: errors.length === 0, errors, ids, parent, contentChars, voidIds };
}

/** Kiểm tra marker đóng/mở cân bằng, lồng đúng thứ tự và không trùng id. */
export function validateMarkers(text: string): MarkerValidation {
  const { ok, errors, ids } = analyzeStructure(tokenizeMarkers(text));
  return { ok, errors, ids };
}

// ============================================================================
// Đánh số lại id (mỗi câu đánh số riêng từ 1 để cùng một câu trên nhiều trang có cùng hash/TM)
// ============================================================================

/** Đổi tên id theo bảng 'mapping' (id cũ -> id mới). id không có trong bảng giữ nguyên. */
export function remapMarkerIds(text: string, mapping: Readonly<Record<string, string>>): string {
  const tokens = tokenizeMarkers(text).map((t) =>
    t.type === 'text' ? t : { ...t, id: mapping[t.id] ?? t.id },
  );
  return serializeMarkers(tokens);
}

export interface RenumberResult {
  text: string;
  /** id mới -> id cũ (để tra lại thẻ gốc khi rebuild) */
  idMap: Record<string, string>;
}

/** Đánh số lại id thành 1, 2, 3… theo thứ tự xuất hiện lần đầu. */
export function renumberMarkers(text: string): RenumberResult {
  const oldToNew: Record<string, string> = {};
  const idMap: Record<string, string> = {};
  let next = 1;
  for (const t of tokenizeMarkers(text)) {
    if (t.type === 'text' || t.id in oldToNew) continue;
    const id = String(next++);
    oldToNew[t.id] = id;
    idMap[id] = t.id;
  }
  return { text: remapMarkerIds(text, oldToNew), idMap };
}

// ============================================================================
// Chuyển đổi {n} <-> <span data-i="n"> cho Amazon Translate
// ============================================================================

export function escapeHtmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
});

/** Giải mã entity HTML cơ bản mà Amazon Translate có thể trả về. Entity lạ giữ nguyên. */
export function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]+);/g, (all, body: string) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return all;
      return String.fromCodePoint(cp);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? all;
  });
}

/**
 * Chuỗi marker -> HTML gửi TranslateText. Văn bản được escape '& < >'.
 * Tiền điều kiện: validateMarkers(text).ok === true (người gọi kiểm tra trước).
 */
export function markersToSpanHtml(text: string): string {
  return tokenizeMarkers(text)
    .map((t) => {
      switch (t.type) {
        case 'text':
          return escapeHtmlText(t.value);
        case 'open':
          return '<span data-i="${t.id}">';
        case 'close':
          return '</span>';
        case 'void':
          return '<span data-i="${t.id}" data-v></span>';
      }
    })
    .join('');
}

export interface SpanParseResult {
  /** Chuỗi marker thu được (đã thoát ngoặc nhọn) */
  text: string;
  /** true khi không có bất thường nào và marker thu được hợp lệ */
  ok: boolean;
  problems: string[];
}

const TAG_RE = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const DATA_I_RE = /\bdata-i\s*=\s*(?:"\s*([^"]*?)\s*"|'\s*([^']*?)\s*'|([^\s"'>/]+))/i;
const DATA_V_RE = /\bdata-v\b/i;

/**
 * HTML trả về từ TranslateText -> chuỗi marker.
 * Chịu được: thứ tự span bị đảo, nháy đơn/kép, thuộc tính thừa, entity, khoảng trắng thay đổi.
 * Thẻ lạ (không phải span) bị bỏ và ghi vào 'problems'.
 */
export function spanHtmlToMarkers(html: string): SpanParseResult {
  const problems: string[] = [];
  const stack: Array<{ id: string | null; isVoid: boolean }> = [];
  let out = '';
  let last = 0;

  const pushText = (raw: string): void => {
    if (raw) out += escapeMarkerText(decodeHtmlEntities(raw));
  };

  TAG_RE.lastIndex = 0;
  for (let m = TAG_RE.exec(html); m !== null; m = TAG_RE.exec(html)) {
    pushText(html.slice(last, m.index));
    last = TAG_RE.lastIndex;
    if (m[0].startsWith('<!--')) continue;

    const isClose = m[1] === '/';
    const name = m[2].toLowerCase();
    const attrs = m[3] ?? '';
    if (name !== 'span') {
      problems.push('UNEXPECTED_TAG:${name}');
      continue;
    }
    if (isClose) {
      const top = stack.pop();
      if (!top) problems.push('UNMATCHED_SPAN_CLOSE');
      else if (top.id !== null && !top.isVoid) out += '{/${top.id}}';
      continue;
    }
    const dm = DATA_I_RE.exec(attrs);
    const rawId = dm ? (dm[1] ?? dm[2] ?? dm[3] ?? '') : '';
    const id = /^[1-9]\d{0,5}$/.test(rawId) ? rawId : null;
    if (id === null) problems.push(dm ? 'BAD_DATA_I:${rawId}' : 'SPAN_WITHOUT_DATA_I');
    const isVoid = id !== null && DATA_V_RE.test(attrs);
    const selfClosing = /\/\s*$/.test(attrs);
    if (id !== null) out += isVoid ? '{${id}/}' : selfClosing ? '{${id}}{/${id}}' : '{${id}}';
    if (!selfClosing) stack.push({ id, isVoid });
  }
  pushText(html.slice(last));

  for (const s of stack) if (s.id !== null && !s.isVoid) problems.push('UNCLOSED_SPAN:${s.id}');
  const v = validateMarkers(out);
  for (const e of v.errors) problems.push('${e.code}:${e.id}');
  return { text: out, ok: problems.length === 0, problems };
}

// ============================================================================
// So sánh marker trước/sau khi dịch
// ============================================================================

export interface MarkerComparison {
  /** Giữ nguyên hoàn toàn: restorable + không đổi quan hệ lồng nhau + không cặp nào bị rỗng */
  ok: boolean;
  /** Có thể khôi phục thẻ an toàn: cấu trúc hợp lệ, không thiếu, không thừa marker */
  restorable: boolean;
  structureValid: boolean;
  /** Marker có ở câu gốc nhưng thiếu ở bản dịch, ví dụ '["{2}", "{/2}"]' */
  missing: string[];
  /** Marker thừa ở bản dịch */
  extra: string[];
  /** Thứ tự id bị đảo (bình thường với ko/ja, KHÔNG tính là lỗi) */
  reordered: boolean;
  /** id có cặp bao ngoài khác so với câu gốc (ví dụ lồng nhau -> tách rời) */
  nestingChanged: string[];
  /** id có nội dung ở câu gốc nhưng rỗng ở bản dịch */
  emptied: string[];
}

function markerMultiset(tokens: readonly MarkerToken[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of tokens) {
    if (t.type === 'text') continue;
    const key = serializeMarkers([t]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function compareMarkers(source: string, translated: string): MarkerComparison {
  const srcTokens = tokenizeMarkers(source);
  const trTokens = tokenizeMarkers(translated);
  const src = analyzeStructure(srcTokens);
  const tr = analyzeStructure(trTokens);

  const srcCount = markerMultiset(srcTokens);
  const trCount = markerMultiset(trTokens);
  const missing: string[] = [];
  const extra: string[] = [];
  for (const [k, n] of srcCount) for (let i = trCount.get(k) ?? 0; i < n; i++) missing.push(k);
  for (const [k, n] of trCount) for (let i = srcCount.get(k) ?? 0; i < n; i++) extra.push(k);

  const restorable = tr.ok && missing.length === 0 && extra.length === 0;
  const nestingChanged: string[] = [];
  const emptied: string[] = [];
  if (restorable) {
    for (const id of src.ids) {
      if (src.parent.get(id) !== tr.parent.get(id)) nestingChanged.push(id);
      if (!src.voidIds.has(id) && (src.contentChars.get(id) ?? 0) > 0 && (tr.contentChars.get(id) ?? 0) === 0) {
        emptied.push(id);
      }
    }
  }
  const reordered = restorable && src.ids.join(',') !== tr.ids.join(',');
  return {
    ok: restorable && nestingChanged.length === 0 && emptied.length === 0,
    restorable,
    structureValid: tr.ok,
    missing,
    extra,
    reordered,
    nestingChanged,
    emptied,
  };
}

export interface MarkerIntegrityReport {
  total: number;
  /** Số câu mất/lệch marker (compareMarkers(...).ok === false) */
  broken: number;
  rate: number;
  threshold: number;
  exceedsThreshold: boolean;
  brokenIndexes: number[];
}

/** Đo tỷ lệ câu mất/lệch marker trên một bộ bản dịch, so với ngưỡng rủi ro 5%. */
export function measureMarkerIntegrity(
  pairs: ReadonlyArray<{ source: string; translated: string }>,
  threshold: number = MARKER_LOSS_THRESHOLD,
): MarkerIntegrityReport {
  const brokenIndexes: number[] = [];
  pairs.forEach((p, i) => {
    if (!compareMarkers(p.source, p.translated).ok) brokenIndexes.push(i);
  });
  const total = pairs.length;
  const rate = total === 0 ? 0 : brokenIndexes.length / total;
  return { total, broken: brokenIndexes.length, rate, threshold, exceedsThreshold: rate > threshold, brokenIndexes };
}

// ============================================================================
// Khôi phục thẻ nội tuyến gốc
// ============================================================================

/** Phần tử HTML rỗng: không sinh thẻ đóng khi khôi phục. */
const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr',
]);

export interface RestoreResult {
  html: string;
  /** true khi mọi marker đều tìm thấy thẻ gốc và cấu trúc hợp lệ */
  ok: boolean;
  /** id không tìm thấy thẻ gốc (nội dung vẫn giữ, chỉ mất thẻ) */
  missingIds: string[];
  /** true khi cấu trúc marker hỏng và phải trả về văn bản thuần */
  usedFallback: boolean;
}

/**
 * Chuỗi marker (đã dịch) + bảng thẻ gốc -> HTML.
 * @param text  Chuỗi marker, ví dụ 'Xem {2}giá{/2} tại {1}đây{/1}.'
 * @param tags  id -> thẻ MỞ gốc, ví dụ '{ "1": "<a href=\"/docs\">", "2": "<strong>" }'.
 *              Thẻ đóng được suy ra từ tên thẻ. Tra theo id nên thứ tự trong câu dịch không quan trọng.
 */
export function restoreInlineHtml(text: string, tags: Readonly<Record<string, string>>): RestoreResult {
  const tokens = tokenizeMarkers(text);
  if (!analyzeStructure(tokens).ok) {
    return { html: escapeHtmlText(stripMarkers(text)), ok: false, missingIds: [], usedFallback: true };
  }
  const missingIds: string[] = [];
  const closers: string[] = [];
  let html = '';
  for (const t of tokens) {
    if (t.type === 'text') {
      html += escapeHtmlText(t.value);
      continue;
    }
    if (t.type === 'close') {
      html += closers.pop() ?? '';
      continue;
    }
    const tag = tags[t.id];
    const name = tag === undefined ? undefined : /^<([a-zA-Z][a-zA-Z0-9:-]*)[\s/>]/.exec(tag)?.[1]?.toLowerCase();
    if (tag === undefined || name === undefined) {
      missingIds.push(t.id);
      if (t.type === 'open') closers.push('');
      continue;
    }
    html += tag;
    if (t.type === 'open') closers.push(VOID_ELEMENTS.has(name) ? '' : '</${name}>');
  }
  return { html, ok: missingIds.length === 0, missingIds, usedFallback: false };
}
