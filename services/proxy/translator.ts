/**
 * translator – dịch danh sách câu {n} bằng Amazon Translate TranslateText (F2 bước 5, bản tuần 1 – Nhiệm vụ 1.6, TV2).
 * Tuần 1 chưa có TM (2.4) và chưa đặt trước hạn mức (2.7): mọi câu đều gửi dịch máy.
 *
 * Cách gửi:
 *  - Câu trùng nhau trên trang chỉ gửi một lần.
 *  - Mỗi câu: {n} -> <span data-i="n"> (markersToSpanHtml), rồi bọc <div data-s="k"> để tách câu trong một khối.
 *    (Không dùng span data-i cho câu vì data-i đã là thẻ nội tuyến theo Quy ước mục 3.2.)
 *  - Gom khối tối đa 10.000 byte UTF-8 (giới hạn một lần gọi TranslateText), gọi song song có giới hạn.
 * Kiểm tra kết quả:
 *  - Thiếu hoặc trùng data-s -> dịch lại riêng từng câu đó.
 *  - Marker {n} hỏng (spanHtmlToMarkers/compareMarkers) -> dịch lại câu dạng văn bản thuần;
 *    rebuild() sẽ dùng văn bản thuần, sau này F4/F5 gắn "Cần xem lại".
 *  - Lỗi Translate ở một khối -> các câu của khối giữ ngôn ngữ gốc (trang dịch dở).
 *  - Hết ngân sách thời gian (deadline) -> không gửi thêm khối mới (trang dịch dở).
 */
import { TranslateTextCommand } from '@aws-sdk/client-translate';
import {
  compareMarkers,
  escapeHtmlText,
  markersToSpanHtml,
  spanHtmlToMarkers,
  stripMarkers,
} from '../../libs/common/markers.js';

export const TRANSLATE_MAX_BYTES = 10_000;
export const DEFAULT_CONCURRENCY = 4;

/** Phần của TranslateClient mà module này dùng (tiêm bản giả khi test). */
export interface TranslateClientLike {
  send(command: TranslateTextCommand): Promise<{ TranslatedText?: string }>;
}

export interface TranslateSentencesOptions {
  sourceLang: string;
  targetLang: string;
  /** Custom Terminology của tenant (F4, tuần 2) */
  terminologyNames?: string[];
  maxBytes?: number;
  concurrency?: number;
  /** Mốc thời gian (ms) không gửi thêm yêu cầu mới sau đó */
  deadline: number;
  now?: () => number;
}

export interface TranslateSentencesResult {
  /** Cùng độ dài với mảng câu đầu vào; undefined = chưa dịch được (giữ câu gốc) */
  translations: Array<string | undefined>;
  uniqueSentences: number;
  /** Số ký tự (code point) đã gửi Translate, gồm cả thẻ – đúng cách AWS tính phí */
  charsSent: number;
  calls: number;
  /** Câu phải dịch lại dạng văn bản thuần vì marker hỏng */
  plainFallbacks: number;
  /** Câu không dịch được (lỗi Translate, câu quá dài, hết giờ) */
  untranslated: number;
  timedOut: boolean;
  errors: string[];
}

const utf8Bytes = (s: string): number => Buffer.byteLength(s, 'utf8');
const codePoints = (s: string): number => Array.from(s).length;
const SENTENCE_DIV_RE = /<div\b[^>]*?\bdata-s\s*=\s*["']?(\d+)["']?[^>]*>([\s\S]*?)<\/div\s*>/gi;

/** Gom các phần tử thành khối, mỗi khối có tổng byte UTF-8 ≤ maxBytes. Phần tử quá lớn đứng riêng một khối. */
export function chunkByBytes<T>(items: readonly T[], size: (item: T) => number, maxBytes: number): T[][] {
  const chunks: T[][] = [];
  let cur: T[] = [];
  let curBytes = 0;
  for (const it of items) {
    const b = size(it);
    if (cur.length && curBytes + b > maxBytes) {
      chunks.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(it);
    curBytes += b;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/** Chạy các tác vụ với số lượng đồng thời giới hạn. */
async function runPool<T>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
    }
  });
  await Promise.all(lanes);
}

export async function translateSentences(
  client: TranslateClientLike,
  sentences: readonly string[],
  opts: TranslateSentencesOptions,
): Promise<TranslateSentencesResult> {
  const now = opts.now ?? Date.now;
  const maxBytes = opts.maxBytes ?? TRANSLATE_MAX_BYTES;
  const result: TranslateSentencesResult = {
    translations: new Array(sentences.length).fill(undefined),
    uniqueSentences: 0,
    charsSent: 0,
    calls: 0,
    plainFallbacks: 0,
    untranslated: 0,
    timedOut: false,
    errors: [],
  };

  // Câu trùng chỉ dịch một lần
  const unique: string[] = [];
  const indexOf = new Map<string, number>();
  const uniqueOf = sentences.map((s) => {
    let k = indexOf.get(s);
    if (k === undefined) {
      k = unique.length;
      unique.push(s);
      indexOf.set(s, k);
    }
    return k;
  });
  result.uniqueSentences = unique.length;
  const out: Array<string | undefined> = new Array(unique.length).fill(undefined);

  const call = async (text: string): Promise<string> => {
    result.calls++;
    result.charsSent += codePoints(text);
    const res = await client.send(
      new TranslateTextCommand({
        Text: text,
        SourceLanguageCode: opts.sourceLang,
        TargetLanguageCode: opts.targetLang,
        ...(opts.terminologyNames?.length ? { TerminologyNames: opts.terminologyNames } : {}),
      }),
    );
    return res.TranslatedText ?? '';
  };
  const timeLeft = (): boolean => {
    if (now() < opts.deadline) return true;
    result.timedOut = true;
    return false;
  };
  const accept = (k: number, translatedHtml: string): boolean => {
    const parsed = spanHtmlToMarkers(translatedHtml.trim());
    if (!parsed.ok || !parsed.text.trim() || !compareMarkers(unique[k], parsed.text).restorable) return false;
    out[k] = parsed.text.trim();
    return true;
  };

  const wrapped = unique.map((s, k) => ({ k, html: `<div data-s="${k}">${markersToSpanHtml(s)}</div>` }));
  const tooBig = wrapped.filter((w) => utf8Bytes(w.html) > maxBytes).map((w) => w.k);
  const chunks = chunkByBytes(
    wrapped.filter((w) => utf8Bytes(w.html) <= maxBytes),
    (w) => utf8Bytes(w.html),
    maxBytes,
  );

  const retrySpan: number[] = [];
  const retryPlain: number[] = [];

  // Lượt 1: gửi theo khối
  await runPool(chunks, opts.concurrency ?? DEFAULT_CONCURRENCY, async (chunk) => {
    if (!timeLeft()) return;
    let translated: string;
    try {
      translated = await call(chunk.map((w) => w.html).join(''));
    } catch (err) {
      result.errors.push(errorName(err));
      return; // các câu của khối giữ ngôn ngữ gốc
    }
    const found = new Map<number, string[]>();
    for (const m of translated.matchAll(SENTENCE_DIV_RE)) {
      const k = Number(m[1]);
      found.set(k, [...(found.get(k) ?? []), m[2]]);
    }
    for (const { k } of chunk) {
      const hits = found.get(k);
      if (!hits || hits.length !== 1) retrySpan.push(k);
      else if (!accept(k, hits[0])) retryPlain.push(k);
    }
  });

  // Lượt 2: thiếu/trùng data-s -> dịch riêng từng câu (vẫn giữ thẻ nội tuyến)
  await runPool(retrySpan, opts.concurrency ?? DEFAULT_CONCURRENCY, async (k) => {
    if (!timeLeft()) return;
    try {
      if (!accept(k, await call(markersToSpanHtml(unique[k])))) retryPlain.push(k);
    } catch (err) {
      result.errors.push(errorName(err));
    }
  });

  // Lượt 3: marker hỏng -> dịch văn bản thuần (rebuild sẽ bỏ thẻ nội tuyến của câu này)
  await runPool(retryPlain, opts.concurrency ?? DEFAULT_CONCURRENCY, async (k) => {
    if (!timeLeft()) return;
    try {
      const plain = spanHtmlToMarkers((await call(escapeHtmlText(stripMarkers(unique[k])))).trim());
      if (plain.text.trim()) {
        out[k] = plain.text.trim();
        result.plainFallbacks++;
      }
    } catch (err) {
      result.errors.push(errorName(err));
    }
  });

  if (tooBig.length) result.errors.push(`SENTENCE_TOO_LARGE x${tooBig.length}`);
  result.translations = uniqueOf.map((k) => out[k]);
  result.untranslated = result.translations.filter((t) => t === undefined).length;
  return result;
}

function errorName(err: unknown): string {
  if (err && typeof err === 'object' && 'name' in err && typeof (err as { name: unknown }).name === 'string') {
    return (err as { name: string }).name;
  }
  return 'UnknownError';
}
