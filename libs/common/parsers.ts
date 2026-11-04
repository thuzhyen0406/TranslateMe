/**
 * parsers – phân tích và dựng lại tệp cho F10 (dịch tệp hàng loạt). Nhiệm vụ 4.4 (TXT, HTML – TV2);
 * DOCX (4.9 – TV4) cắm vào qua cùng giao diện FormatParser. Mục 2.3.3 (Bảng 2.11) và 2.6.6 của báo cáo.
 *
 *   parse(format, bytes)          -> { blocks, skeleton, warnings }
 *   rebuild(skeleton, translations, { targetLang }) -> bytes
 *
 *  - blocks: các câu cần dịch theo thứ tự (Sentence {id, text}, id = vị trí trong `translations`), dạng marker
 *    `{n}…{/n}` như F2, nên đi chung đường dịch (chunkByBytes, TM, translateSentences) với proxy.
 *  - skeleton: phần còn lại của tệp, **chỉ gồm dữ liệu JSON** để state machine BATCH (4.7) ghi ra S3 giữa các bước.
 *  - translations[id] thiếu hoặc rỗng -> giữ câu gốc (như trang dịch dở của F2).
 *  - Bất biến (QC-11): rebuild(parse(f).skeleton, []) cho tệp tương đương tệp gốc:
 *      TXT: trùng từng byte (kể cả BOM, kiểu xuống dòng, khoảng trắng);
 *      HTML: cùng cây DOM (so bằng parse5 serialize, vì parse5 chuẩn hóa cách viết HTML).
 *
 * TXT: UTF-8 (chấp nhận BOM). Tách theo dòng, giữ nguyên dòng trống và kiểu xuống dòng (\n, \r\n, \r); mỗi dòng
 *      tách câu bằng segmenter của 1.5; câu không có chữ (chỉ số, ký hiệu) giữ nguyên, không gửi dịch.
 *      Dấu { } có thật trong văn bản được thoát thành {{ }} (markers.escapeMarkerText) để không thành ký hiệu.
 * HTML: dùng lại extract (bước 2 của F2) và rebuildDocument: không viết lại liên kết, không canonical/hreflang/nút
 *      chọn ngôn ngữ; chỉ đặt <html lang> theo ngôn ngữ đích. Tệp phải là UTF-8.
 */
import { extract } from './extract.js';
import { escapeMarkerText, stripMarkers } from './markers.js';
import { rebuildDocument } from './rebuild.js';
import { isTranslatable, segmentBlock } from './segmenter.js';

export type DocFormat = 'TXT' | 'HTML' | 'DOCX';

/** B.2 */
export interface Sentence {
  id: number;
  text: string;
}

/** Mục 2.6.6: mỗi cảnh báo là {code, where, count, message}; công việc có cảnh báo vẫn SUCCEEDED */
export interface ParseWarning {
  code: string;
  where: string;
  count: number;
  message: string;
}

export interface TxtSkeleton {
  v: 1;
  format: 'TXT';
  bom: boolean;
  /** Chuỗi = phần giữ nguyên (khoảng trắng, xuống dòng, câu không dịch); số = id câu trong blocks */
  parts: Array<string | number>;
  /** Câu gốc dạng văn bản thuần theo id, dùng khi thiếu bản dịch */
  sources: string[];
}

export interface HtmlSkeleton {
  v: 1;
  format: 'HTML';
  skeletonHtml: string;
  placeholders: Record<string, string>;
}

/** DOCX (4.9) thêm kiểu skeleton của mình; chỉ cần có `v` và `format` và là dữ liệu JSON */
export interface OtherSkeleton {
  v: number;
  format: DocFormat;
  [k: string]: unknown;
}

export type Skeleton = TxtSkeleton | HtmlSkeleton | OtherSkeleton;

export interface ParsedDocument<S extends Skeleton = Skeleton> {
  blocks: Sentence[];
  skeleton: S;
  warnings: ParseWarning[];
}

export interface RebuildStats {
  sentences: number;
  translated: number;
  keptSource: number;
  /** Bản dịch lệch ký hiệu {n} nên dùng văn bản thuần của bản dịch */
  tagFallback: number;
}

export interface ParseOptions {
  /** Kích thước tối đa của tệp (mặc định 10 MB, như F10) */
  maxBytes?: number;
}

export interface RebuildOptions {
  /** Ngôn ngữ đích (HTML: đặt <html lang>; DOCX: phông Đông Á). Không truyền = giữ nguyên. */
  targetLang?: string;
}

/** Giao diện một định dạng. DOCX (4.9) cài đặt rồi thêm vào FORMAT_PARSERS. */
export interface FormatParser {
  parse(bytes: Uint8Array, opts: Required<ParseOptions>): ParsedDocument;
  rebuild(skeleton: Skeleton, translations: readonly (string | null | undefined)[], opts: RebuildOptions): { bytes: Uint8Array; stats: RebuildStats };
}

export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Định dạng không hỗ trợ (hoặc chưa cắm vào) */
export class UnsupportedFormat extends Error {
  override name = 'UnsupportedFormat';
  constructor(public format: string) {
    super(`Định dạng không hỗ trợ: ${format}`);
  }
}

/** Tệp hỏng hoặc vi phạm giới hạn; reason dùng làm lý do FAILED của JOB */
export class CorruptFile extends Error {
  override name = 'CorruptFile';
  constructor(
    public reason: 'NOT_UTF8' | 'TOO_LARGE' | 'INVALID_SKELETON' | string,
    message: string,
  ) {
    super(message);
  }
}

const UTF8_BOM = '﻿';

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new CorruptFile('NOT_UTF8', 'Tệp không phải văn bản UTF-8 hợp lệ');
  }
}

const encodeUtf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

// ============================================================================
// TXT
// ============================================================================

export const txtParser: FormatParser = {
  parse(bytes) {
    let text = decodeUtf8(bytes);
    const bom = text.startsWith(UTF8_BOM);
    if (bom) text = text.slice(1);

    const blocks: Sentence[] = [];
    const sources: string[] = [];
    const parts: Array<string | number> = [];
    const literal = (s: string) => {
      if (!s) return;
      const last = parts[parts.length - 1];
      if (typeof last === 'string') parts[parts.length - 1] = last + s;
      else parts.push(s);
    };
    // Giữ dấu xuống dòng trong phần chẵn/lẻ: ["dòng", "\r\n", "dòng", "\n", ...]
    const pieces = text.split(/(\r\n|\n|\r)/);
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i];
      if (i % 2 === 1) {
        literal(piece);
        continue;
      }
      if (!piece) continue;
      // Thoát { } có thật rồi mới tách câu: segmenter hiểu {{ }} là ký tự thường
      for (const part of segmentBlock(escapeMarkerText(piece))) {
        if (part.kind === 'sentence' && isTranslatable(part.text)) {
          parts.push(blocks.length);
          sources.push(stripMarkers(part.text));
          blocks.push({ id: blocks.length, text: part.text });
        } else {
          literal(stripMarkers(part.text));
        }
      }
    }
    const skeleton: TxtSkeleton = { v: 1, format: 'TXT', bom, parts, sources };
    return { blocks, skeleton, warnings: [] };
  },

  rebuild(skeleton, translations) {
    const sk = skeleton as TxtSkeleton;
    if (sk.format !== 'TXT' || sk.v !== 1 || !Array.isArray(sk.parts) || !Array.isArray(sk.sources)) {
      throw new CorruptFile('INVALID_SKELETON', 'Skeleton TXT không hợp lệ');
    }
    const stats: RebuildStats = { sentences: 0, translated: 0, keptSource: 0, tagFallback: 0 };
    let out = sk.bom ? UTF8_BOM : '';
    for (const p of sk.parts) {
      if (typeof p === 'string') {
        out += p;
        continue;
      }
      stats.sentences++;
      if (!Number.isInteger(p) || p < 0 || p >= sk.sources.length) throw new CorruptFile('INVALID_SKELETON', 'Skeleton TXT không hợp lệ');
      const tr = translations[p];
      if (typeof tr === 'string' && tr.trim() !== '') {
        stats.translated++;
        out += stripMarkers(tr);
      } else {
        stats.keptSource++;
        out += sk.sources[p];
      }
    }
    return { bytes: encodeUtf8(out), stats };
  },
};

// ============================================================================
// HTML
// ============================================================================

export const htmlParser: FormatParser = {
  parse(bytes) {
    const html = decodeUtf8(bytes).replace(/^﻿/, '');
    const ex = extract(html);
    const skeleton: HtmlSkeleton = { v: 1, format: 'HTML', skeletonHtml: ex.skeletonHtml, placeholders: ex.placeholders };
    return { blocks: ex.sentences.map((text, id) => ({ id, text })), skeleton, warnings: [] };
  },

  rebuild(skeleton, translations, opts) {
    const sk = skeleton as HtmlSkeleton;
    if (sk.format !== 'HTML' || sk.v !== 1 || typeof sk.skeletonHtml !== 'string' || !sk.placeholders || typeof sk.placeholders !== 'object') {
      throw new CorruptFile('INVALID_SKELETON', 'Skeleton HTML không hợp lệ');
    }
    const { html, stats } = rebuildDocument(sk.skeletonHtml, translations, sk.placeholders, { targetLang: opts.targetLang });
    return { bytes: encodeUtf8(html), stats };
  },
};

// ============================================================================
// Giao diện chung (Bảng 2.11)
// ============================================================================

/** DOCX (4.9 – TV4) thêm: FORMAT_PARSERS.DOCX = docxParser */
export const FORMAT_PARSERS: Partial<Record<DocFormat, FormatParser>> = { TXT: txtParser, HTML: htmlParser };

function parserFor(format: string): FormatParser {
  const p = (FORMAT_PARSERS as Record<string, FormatParser | undefined>)[format];
  if (!p) throw new UnsupportedFormat(format);
  return p;
}

/** Định dạng theo phần mở rộng tên tệp (.txt, .html, .htm, .docx); null nếu không hỗ trợ */
export function formatFromFileName(name: string): DocFormat | null {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase();
  if (ext === 'txt') return 'TXT';
  if (ext === 'html' || ext === 'htm') return 'HTML';
  if (ext === 'docx') return 'DOCX';
  return null;
}

/** Tên tệp kết quả: tên-gốc.mã-ngôn-ngữ.phần-mở-rộng (F10), ví dụ gioi-thieu.en.docx */
export function translatedFileName(name: string, lang: string): string {
  const m = /^(.*?)(\.[A-Za-z0-9]+)?$/.exec(name)!;
  return `${m[1]}.${lang}${m[2] ?? ''}`;
}

export function parse(format: DocFormat | string, bytes: Uint8Array, opts: ParseOptions = {}): ParsedDocument {
  const p = parserFor(format);
  const maxBytes = opts.maxBytes ?? MAX_FILE_BYTES;
  if (bytes.byteLength > maxBytes) throw new CorruptFile('TOO_LARGE', `Tệp vượt ${maxBytes} byte`);
  return p.parse(bytes, { maxBytes });
}

export function rebuildDetailed(
  skeleton: Skeleton,
  translations: readonly (string | null | undefined)[],
  opts: RebuildOptions = {},
): { bytes: Uint8Array; stats: RebuildStats } {
  if (!skeleton || typeof skeleton !== 'object' || typeof (skeleton as { format?: unknown }).format !== 'string') {
    throw new CorruptFile('INVALID_SKELETON', 'Skeleton không hợp lệ');
  }
  return parserFor(skeleton.format).rebuild(skeleton, translations, opts);
}

export function rebuild(skeleton: Skeleton, translations: readonly (string | null | undefined)[], opts: RebuildOptions = {}): Uint8Array {
  return rebuildDetailed(skeleton, translations, opts).bytes;
}
