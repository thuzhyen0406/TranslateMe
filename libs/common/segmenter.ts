/**
 * segmenter – tách câu trên chuỗi marker `{n}…{/n}` (Nhiệm vụ 1.5 – TV2).
 *
 * Đầu vào là văn bản của MỘT khối (đoạn p, li, h1…) đã đổi thẻ nội tuyến thành marker.
 * Quy tắc:
 *  1. Chỉ cắt câu ở chỗ marker đã cân bằng (độ sâu 0). Câu nằm trọn trong `{1}…{/1}` không bị cắt.
 *     Nếu dấu câu nằm ngay trước marker đóng (`{1}đây.{/1} Tiếp`), điểm cắt dời ra sau marker đóng.
 *  2. Dấu kết câu Latin (. ! ? …) phải đi sau là khoảng trắng hoặc hết chuỗi -> không cắt 9.99, 1.250.000,
 *     9.4/10, email, URL. Dấu CJK (。！？) cắt luôn, không cần khoảng trắng.
 *  3. Không cắt sau chữ viết tắt (Mr., Dr., TP., ThS., …), chữ cái đơn (J. K. Rowling, Q. 1)
 *     và khi chữ tiếp theo là chữ thường (approx. ten, v.v. và…).
 *  4. Chuỗi marker hỏng -> trả nguyên khối thành 1 câu (an toàn, không làm vỡ DOM).
 * Ưu tiên cắt THIẾU hơn cắt THỪA: câu dài hơn vẫn dịch đúng, câu bị cắt nhầm làm sai nghĩa.
 *
 * Bất biến: segmentBlock(text).map(p => p.text).join('') === text.
 */
import { markerAt, stripMarkers, validateMarkers } from './markers.js';

export type SegmentPart = { kind: 'sentence' | 'gap'; text: string };

export interface SegmentOptions {
  /** Danh sách chữ viết tắt (không có dấu chấm cuối, không phân biệt hoa/thường). Mặc định: DEFAULT_ABBREVIATIONS */
  abbreviations?: readonly string[];
}

export const DEFAULT_ABBREVIATIONS: readonly string[] = Object.freeze([
  // en
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'fig', 'approx', 'e.g', 'i.e', 'a.m', 'p.m',
  // vi
  'tp', 'ths', 'th.s', 'ts', 'pgs', 'gs', 'bs', 'ks', 'tr', 'gđ', 'pgđ', 'đ/c',
]);

const LATIN_TERMINALS = new Set(['.', '!', '?', '…', '‽']);
const CJK_TERMINALS = new Set(['。', '！', '？', '｡']);
const CLOSERS = new Set(['"', "'", '”', '’', '»', ')', ']', '）', '」', '』', '】', '〉', '》']);
const OPENERS = new Set(['"', "'", '“', '‘', '«', '(', '[', '（', '「', '『', '【', '〈', '《']);
const WS = /\s/u;
const LOWER = /\p{Ll}/u;
const WORD_CHAR = /[\p{L}\p{N}./]/u;

function isTerminal(ch: string | undefined): boolean {
  return ch !== undefined && (LATIN_TERMINALS.has(ch) || CJK_TERMINALS.has(ch));
}

/** Từ đứng ngay trước dấu chấm tại `i` (gồm chữ, số, dấu chấm, gạch chéo). */
function wordBefore(text: string, i: number): string {
  let s = i;
  while (s > 0 && WORD_CHAR.test(text[s - 1])) s--;
  return text.slice(s, i);
}

/** Ký tự có nghĩa đầu tiên từ `k`: bỏ qua khoảng trắng, marker mở/rỗng, dấu mở ngoặc/nháy. */
function nextSignificantChar(text: string, k: number): string | undefined {
  let i = k;
  while (i < text.length) {
    const m = markerAt(text, i);
    if (m && (m.kind === 'open' || m.kind === 'void')) {
      i += m.len;
      continue;
    }
    if (m && m.kind === 'escape') return m.char;
    const ch = text[i];
    if (WS.test(ch) || OPENERS.has(ch)) {
      i++;
      continue;
    }
    return ch;
  }
  return undefined;
}

/** Vị trí kết thúc (exclusive) của từng câu trong khối. */
function findBoundaries(text: string, abbreviations: ReadonlySet<string>): number[] {
  const boundaries: number[] = [];
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const m = markerAt(text, i);
    if (m) {
      if (m.kind === 'open') depth++;
      else if (m.kind === 'close') depth--;
      i += m.len;
      continue;
    }
    if (!isTerminal(text[i])) {
      i++;
      continue;
    }

    // Chuỗi dấu kết câu liên tiếp: "?!", "...", "。」"
    let j = i;
    let lastTerminal = text[i];
    while (j < text.length && isTerminal(text[j])) lastTerminal = text[j++];
    const singleDot = j - i === 1 && text[i] === '.';

    // Dấu đóng ngoặc/nháy và marker đóng ngay sau dấu câu
    let k = j;
    let d = depth;
    for (;;) {
      if (k < text.length && CLOSERS.has(text[k])) {
        k++;
        continue;
      }
      const c = markerAt(text, k);
      if (c && c.kind === 'close') {
        d--;
        k += c.len;
        continue;
      }
      break;
    }

    let boundary = d === 0;
    if (boundary && !CJK_TERMINALS.has(lastTerminal)) {
      if (k < text.length && !WS.test(text[k])) boundary = false;
      else if (singleDot) {
        const w = wordBefore(text, i);
        if (/^\p{L}$/u.test(w) || abbreviations.has(w.toLowerCase())) boundary = false;
      }
      if (boundary && (lastTerminal === '.' || lastTerminal === '…')) {
        const next = nextSignificantChar(text, k);
        if (next !== undefined && LOWER.test(next)) boundary = false;
      }
    }

    if (boundary) {
      if (k < text.length) boundaries.push(k);
      depth = d;
      i = k;
    } else {
      i = j; // marker đóng (nếu có) sẽ được vòng lặp chính xử lý để cập nhật depth
    }
  }
  return boundaries;
}

/**
 * Tách một khối thành các phần câu và khoảng trắng xen giữa.
 * Khoảng trắng đầu/cuối và giữa các câu nằm trong phần `gap` để rebuild giữ nguyên.
 */
export function segmentBlock(text: string, options: SegmentOptions = {}): SegmentPart[] {
  const abbreviations = new Set((options.abbreviations ?? DEFAULT_ABBREVIATIONS).map((a) => a.toLowerCase()));
  const cuts = validateMarkers(text).ok ? findBoundaries(text, abbreviations) : [];
  cuts.push(text.length);

  const parts: SegmentPart[] = [];
  const push = (kind: SegmentPart['kind'], s: string): void => {
    if (!s) return;
    const prev = parts[parts.length - 1];
    if (kind === 'gap' && prev?.kind === 'gap') prev.text += s;
    else parts.push({ kind, text: s });
  };

  // Tách khoảng trắng đầu/cuối bằng vòng lặp (không dùng regex lazy để tránh O(n²) khi trang có chuỗi khoảng trắng rất dài)
  let start = 0;
  for (const end of cuts) {
    let a = start;
    let b = end;
    while (a < b && WS.test(text[a])) a++;
    while (b > a && WS.test(text[b - 1])) b--;
    push('gap', text.slice(start, a));
    push('sentence', text.slice(a, b));
    push('gap', text.slice(b, end));
    start = end;
  }
  return parts;
}

/** Chỉ lấy các câu (bỏ khoảng trắng xen giữa). */
export function splitSentences(text: string, options?: SegmentOptions): string[] {
  return segmentBlock(text, options)
    .filter((p) => p.kind === 'sentence')
    .map((p) => p.text);
}

/** Câu có chữ để dịch không (bỏ qua câu chỉ gồm số, ký hiệu hoặc marker). */
export function isTranslatable(sentence: string): boolean {
  return /\p{L}/u.test(stripMarkers(sentence));
}
