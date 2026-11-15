/**
 * translator – dịch khối câu bằng Amazon Translate TranslateText (Nhiệm vụ 2.5 – TV2).
 * Đúng hợp đồng B.9 (Phần B 1.1), dùng chung cho F2 (proxy), F9 (realtime) và worker C13.
 *
 * Hàm thuần: không đụng TM, không đụng hạn mức. Nơi gọi tự làm theo thứ tự
 *   tra TM -> reserveChars -> translateSentences -> putMachineTM -> settleUsage.
 *
 * Bên trong:
 *  - Câu trùng nội dung chỉ gửi một lần.
 *  - Mỗi câu: {n} -> <span data-i="n"> (thẻ nội tuyến, Quy ước 3.2), rồi bọc <div data-s="k"> để tách câu
 *    trong một khối. (B.9 ghi "bọc <span data-i>" cho câu, nhưng data-i đã dành cho thẻ nội tuyến.)
 *  - Gom khối tối đa 10.000 byte UTF-8, cắt ở ranh giới câu; gọi song song có giới hạn.
 *  - Thiếu hoặc trùng data-s -> chia đôi nhóm câu đó rồi dịch lại, tới khi còn một câu.
 *  - Marker {n} hỏng hoặc một câu vẫn thiếu sau khi chia -> dịch lại dạng văn bản thuần, needsReview = true.
 *  - Hết hạn (deadlineAt) -> không gửi thêm, câu chưa gửi nằm trong `pending` (để worker dịch nốt).
 *  - Translate lỗi -> câu của khối đó nằm trong `failed` kèm lý do.
 */
import { TranslateClient, TranslateTextCommand } from '@aws-sdk/client-translate';
import { compareMarkers, escapeHtmlText, hasAtomicMarkers, markersToSpanHtml, serializeMarkers, spanHtmlToMarkers, stripMarkers, tokenizeMarkers } from './markers.js';
import type { Sentence } from './tm.js';
import type { Lang } from './types.js';

export type { Sentence };

export const TRANSLATE_MAX_BYTES = 10_000;
export const DEFAULT_TRANSLATE_CONCURRENCY = 4;

/** B.9 */
export interface TranslateRequest {
  src: Lang;
  tgt: Lang;
  sentences: readonly Sentence[];
  terminologyName: string | null;
  /** epoch ms, tuyệt đối */
  deadlineAt: number;
  concurrency: number;
}

export interface TranslateResult {
  translated: { id: number; tgt: string; needsReview: boolean }[];
  /** id chưa dịch kịp vì hết giờ */
  pending: number[];
  failed: { id: number; reason: string }[];
  /** Mở rộng B.9 để ghi log và đối chiếu chi phí */
  stats: {
    uniqueSentences: number;
    calls: number;
    /** Ký tự (code point) đã gửi Translate, gồm cả thẻ – đúng cách AWS tính phí */
    charsSent: number;
    /** Số lần phải chia đôi nhóm vì thiếu/trùng data-s */
    splits: number;
    plainFallbacks: number;
  };
}

/** Phần của TranslateClient mà module này dùng (tiêm bản giả khi test). */
export interface TranslateClientLike {
  send(command: TranslateTextCommand): Promise<{ TranslatedText?: string }>;
}

export interface TranslatorOptions {
  maxBytes?: number;
  now?: () => number;
}

const utf8Bytes = (s: string): number => Buffer.byteLength(s, 'utf8');
const codePoints = (s: string): number => Array.from(s).length;
const SENTENCE_DIV_RE = /<div\b[^>]*?\bdata-s\s*=\s*["']?(\d+)["']?[^>]*>([\s\S]*?)<\/div\s*>/gi;

export function errorName(err: unknown): string {
  if (err && typeof err === 'object' && 'name' in err && typeof (err as { name: unknown }).name === 'string') {
    return (err as { name: string }).name;
  }
  return 'UnknownError';
}

/** Gom phần tử thành khối, tổng byte mỗi khối ≤ maxBytes (phần tử quá lớn đứng riêng). */
export function groupByBytes<T>(items: readonly T[], size: (item: T) => number, maxBytes: number): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let bytes = 0;
  for (const it of items) {
    const b = size(it);
    if (cur.length && bytes + b > maxBytes) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(it);
    bytes += b;
  }
  if (cur.length) out.push(cur);
  return out;
}

async function runPool<T>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
      while (next < items.length) await worker(items[next++]);
    }),
  );
}

interface Unit {
  k: number;
  text: string;
  html: string;
}

export function createTranslator(client: TranslateClientLike, opts: TranslatorOptions = {}) {
  const maxBytes = opts.maxBytes ?? TRANSLATE_MAX_BYTES;
  const now = opts.now ?? Date.now;

  return async function translateSentences(req: TranslateRequest): Promise<TranslateResult> {
    const stats: TranslateResult['stats'] = { uniqueSentences: 0, calls: 0, charsSent: 0, splits: 0, plainFallbacks: 0 };

    // Câu trùng nội dung chỉ dịch một lần
    const idsOf = new Map<string, number[]>();
    for (const s of req.sentences) idsOf.set(s.text, [...(idsOf.get(s.text) ?? []), s.id]);
    const units: Unit[] = [...idsOf.keys()].map((text, k) => ({ k, text, html: `<div data-s="${k}">${markersToSpanHtml(text)}</div>` }));
    stats.uniqueSentences = units.length;

    const done = new Map<number, { tgt: string; needsReview: boolean }>();
    const failed = new Map<number, string>();
    const pending = new Set<number>();

    const call = async (text: string): Promise<string> => {
      stats.calls++;
      stats.charsSent += codePoints(text);
      const res = await client.send(
        new TranslateTextCommand({
          Text: text,
          SourceLanguageCode: req.src,
          TargetLanguageCode: req.tgt,
          ...(req.terminologyName ? { TerminologyNames: [req.terminologyName] } : {}),
        }),
      );
      return res.TranslatedText ?? '';
    };
    const timeLeft = (): boolean => now() < req.deadlineAt;

    const acceptSpan = (u: Unit, translatedHtml: string): boolean => {
      const parsed = spanHtmlToMarkers(translatedHtml.trim());
      if (!parsed.ok || !parsed.text.trim() || !compareMarkers(u.text, parsed.text).restorable) return false;
      done.set(u.k, { tgt: parsed.text.trim(), needsReview: false });
      return true;
    };

    // If Translate removes a protected span, translate only the surrounding text and
    // reassemble the original marker stream. A partial result would move or lose content.
    const withoutAtomicSpans = async (u: Unit): Promise<void> => {
      let tgt = '';
      try {
        for (const token of tokenizeMarkers(u.text)) {
          if (token.type !== 'text' || !token.value.trim()) {
            tgt += serializeMarkers([token]);
            continue;
          }
          if (!timeLeft()) return void pending.add(u.k);
          const leading = /^\s*/u.exec(token.value)![0];
          const trailing = /\s*$/u.exec(token.value)![0];
          const out = spanHtmlToMarkers(await call(escapeHtmlText(token.value.trim())));
          if (!out.ok || !out.text.trim()) return void failed.set(u.k, 'ATOMIC_TRANSLATION_INCOMPLETE');
          tgt += leading + out.text.trim() + trailing;
        }
        if (!compareMarkers(u.text, tgt).restorable) return void failed.set(u.k, 'ATOMIC_TRANSLATION_INCOMPLETE');
        done.set(u.k, { tgt, needsReview: true });
        stats.plainFallbacks++;
      } catch (err) {
        failed.set(u.k, errorName(err));
      }
    };

    /** Dịch lại một câu dạng văn bản thuần (bỏ thẻ nội tuyến), gắn "Cần xem lại". */
    const plain = async (u: Unit): Promise<void> => {
      if (!timeLeft()) return void pending.add(u.k);
      if (hasAtomicMarkers(u.text)) return withoutAtomicSpans(u);
      try {
        const out = spanHtmlToMarkers((await call(escapeHtmlText(stripMarkers(u.text)))).trim());
        if (out.text.trim()) {
          done.set(u.k, { tgt: out.text.trim(), needsReview: true });
          stats.plainFallbacks++;
        } else failed.set(u.k, 'EMPTY_TRANSLATION');
      } catch (err) {
        failed.set(u.k, errorName(err));
      }
    };

    /** Dịch một nhóm câu trong một lần gọi; câu thiếu/trùng -> chia đôi rồi dịch lại. */
    const attempt = async (group: Unit[]): Promise<void> => {
      if (!timeLeft()) return group.forEach((u) => pending.add(u.k));
      let translated: string;
      try {
        translated = await call(group.map((u) => u.html).join(''));
      } catch (err) {
        const reason = errorName(err);
        return group.forEach((u) => failed.set(u.k, reason));
      }
      const found = new Map<number, string[]>();
      for (const m of translated.matchAll(SENTENCE_DIV_RE)) {
        const k = Number(m[1]);
        found.set(k, [...(found.get(k) ?? []), m[2]]);
      }
      const missing: Unit[] = [];
      const broken: Unit[] = [];
      for (const u of group) {
        const hits = found.get(u.k);
        if (!hits || hits.length !== 1) missing.push(u);
        else if (!acceptSpan(u, hits[0])) broken.push(u);
      }
      if (missing.length > 1) {
        stats.splits++;
        const half = Math.ceil(missing.length / 2);
        await attempt(missing.slice(0, half));
        await attempt(missing.slice(half));
      } else if (missing.length === 1) {
        // Đã thử theo nhóm mà vẫn thiếu: chia tới một câu (nếu nhóm > 1) hoặc chuyển sang văn bản thuần
        if (group.length > 1) {
          stats.splits++;
          await attempt(missing);
        } else broken.push(missing[0]);
      }
      for (const u of broken) await plain(u);
    };

    const fits = units.filter((u) => utf8Bytes(u.html) <= maxBytes);
    for (const u of units) if (utf8Bytes(u.html) > maxBytes) failed.set(u.k, 'SENTENCE_TOO_LARGE');
    const chunks = groupByBytes(fits, (u) => utf8Bytes(u.html), maxBytes);
    await runPool(chunks, req.concurrency > 0 ? req.concurrency : DEFAULT_TRANSLATE_CONCURRENCY, attempt);

    // Mở rộng về từng id
    const result: TranslateResult = { translated: [], pending: [], failed: [], stats };
    for (const u of units) {
      const ids = idsOf.get(u.text) ?? [];
      const d = done.get(u.k);
      if (d) for (const id of ids) result.translated.push({ id, ...d });
      else if (failed.has(u.k)) for (const id of ids) result.failed.push({ id, reason: failed.get(u.k)! });
      else for (const id of ids) result.pending.push(id);
    }
    result.translated.sort((a, b) => a.id - b.id);
    result.pending.sort((a, b) => a - b);
    result.failed.sort((a, b) => a.id - b.id);
    return result;
  };
}

let defaultTranslate: ReturnType<typeof createTranslator> | undefined;

/** B.9: dùng TranslateClient mặc định (region theo môi trường Lambda). */
export function translateSentences(req: TranslateRequest): Promise<TranslateResult> {
  defaultTranslate ??= createTranslator(new TranslateClient({ maxAttempts: 3 }));
  return defaultTranslate(req);
}
