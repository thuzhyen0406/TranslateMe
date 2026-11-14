/**
 * extract – tách HTML gốc thành khung HTML + danh sách câu cần dịch (F2 bước 2 – Nhiệm vụ 1.5/1.6, TV2).
 * Chữ ký đúng 100% `extract()` trong interfaces.d.ts.
 *
 * Kết quả:
 *  - skeletonHtml: HTML gốc, mỗi câu được thay bằng một slot (xem htmlDom.ts). rebuild() điền bản dịch vào slot.
 *  - sentences:    câu dạng marker `{n}…{/n}` (đánh số riêng từ 1 trong từng câu -> cùng câu, cùng hash/TM).
 *                  Gồm cả câu trong thuộc tính (alt, title, placeholder, aria-label, meta description/og…).
 *  - placeholders: `s:<i>` = câu gốc thứ i (rebuild dùng khi chưa có bản dịch: trang dịch dở),
 *                  `t:<i>:<n>` = thẻ gốc của marker n trong câu i.
 *
 * Quy tắc:
 *  - Văn bản trong khối được gom thành "đoạn nội tuyến" (text + a/strong/em/span…); thẻ nội tuyến -> {n}…{/n}.
 *  - Phần tử giữ nguyên nằm giữa câu (code, kbd, img, svg, icon rỗng, .notranslate…) -> {n/} mang HTML gốc.
 *  - Thẻ bao trọn cả đoạn (`<p><strong>Toàn câu</strong></p>`) được giữ trong khung, KHÔNG bọc span
 *    (tiết kiệm ký tự tính phí – mục 3.2 Quy ước).
 *  - Không dịch: script, style, noscript, template, textarea, pre, code, svg, math, iframe, video…,
 *    phần tử có translate="no" hoặc class "notranslate", và customExclusionSelectors của website.
 *  - <select> là phần tử khối (5.4): chữ của mỗi <option> là một câu, thuộc tính label của <option>/<optgroup>
 *    được dịch; value giữ nguyên nên dữ liệu gửi đi của biểu mẫu không đổi.
 *  - <br> và phần tử khối ngắt đoạn; câu tách bằng segmenter (chỉ cắt ở chỗ marker cân bằng).
 */
import { parse, serialize, serializeOuter } from 'parse5';
import {
  childrenOf,
  createText,
  getAttr,
  insertChild,
  isElement,
  isText,
  matchesAny,
  openTagOf,
  parseSelectorList,
  removeNode,
  runSlot,
  sourceKey,
  tagKey,
  textSlot,
  attrSlot,
  SLOT_OPEN,
  SLOT_RE,
  type ChildNode,
  type Element,
  type ParentNode,
} from './htmlDom.js';
import type { ExtractOptions, ExtractResult, extract as ContractExtract } from './interfaces.js';
import { escapeHtmlText, escapeMarkerText, renumberMarkers, restoreInlineHtml } from './markers.js';
import { isTranslatable, segmentBlock } from './segmenter.js';

/** Không dịch cả cây con (ở vị trí khối) / giữ nguyên thành {n/} (ở giữa câu). */
export const NON_TRANSLATABLE_TAGS: ReadonlySet<string> = new Set([
  'script', 'style', 'noscript', 'template', 'textarea', 'pre', 'code', 'kbd', 'samp', 'var',
  'svg', 'math', 'iframe', 'object', 'embed', 'canvas', 'video', 'audio',
]);

/** Thẻ nội tuyến có nội dung dịch được -> {n}…{/n}. */
const INLINE_WRAPPERS: ReadonlySet<string> = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'big', 'cite', 'data', 'del', 'dfn', 'em', 'font', 'i', 'ins', 'label',
  'mark', 'nobr', 'q', 's', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'time', 'tt', 'u',
]);

/** Phần tử nội tuyến giữ nguyên khi nằm giữa câu -> {n/}. */
const INLINE_ATOMIC: ReadonlySet<string> = new Set([
  'code', 'kbd', 'samp', 'var', 'img', 'svg', 'math', 'wbr', 'picture',
]);

const META_CONTENT_KEYS: ReadonlySet<string> = new Set([
  'description', 'og:title', 'og:description', 'og:site_name', 'twitter:title', 'twitter:description',
]);

const HTML_WS = /[ \t\n\r\f]+/g;
const LETTER = /\p{L}/u;

type Kind = 'inline' | 'atomic' | 'break';

interface Ctx {
  selectors: ReturnType<typeof parseSelectorList>;
  sentences: string[];
  placeholders: Record<string, string>;
  runs: string[];
  allInlineMemo: WeakMap<Element, boolean>;
}

function isExcluded(el: Element, ctx: Ctx): boolean {
  if (NON_TRANSLATABLE_TAGS.has(el.tagName)) return true;
  if ((getAttr(el, 'translate') ?? '').trim().toLowerCase() === 'no') return true;
  if ((getAttr(el, 'class') ?? '').split(/\s+/).includes('notranslate')) return true;
  return ctx.selectors.length > 0 && matchesAny(el, ctx.selectors);
}

function hasText(el: Element): boolean {
  for (const c of childrenOf(el)) {
    if (isText(c) && c.value.trim()) return true;
    if (isElement(c) && hasText(c)) return true;
  }
  return false;
}

function classify(node: ChildNode, ctx: Ctx): Kind {
  if (!isElement(node)) return node.nodeName === '#documentType' ? 'break' : 'inline'; // text, comment
  const tag = node.tagName;
  if (tag === 'br') return 'break';
  const phrasing = INLINE_WRAPPERS.has(tag) || INLINE_ATOMIC.has(tag);
  if (!phrasing) return 'break';
  if (INLINE_ATOMIC.has(tag) || isExcluded(node, ctx)) return 'atomic';
  if (!allInline(node, ctx)) return 'break';
  return hasText(node) ? 'inline' : 'atomic';
}

function allInline(el: Element, ctx: Ctx): boolean {
  const memo = ctx.allInlineMemo.get(el);
  if (memo !== undefined) return memo;
  const ok = childrenOf(el).every((c) => classify(c, ctx) !== 'break');
  ctx.allInlineMemo.set(el, ok);
  return ok;
}

function addSentence(ctx: Ctx, text: string, tags: Record<string, string>): number {
  const i = ctx.sentences.length;
  ctx.sentences.push(text);
  ctx.placeholders[sourceKey(i)] = text;
  for (const [id, tag] of Object.entries(tags)) ctx.placeholders[tagKey(i, id)] = tag;
  return i;
}

function isTranslatableAttr(el: Element, name: string): boolean {
  switch (name) {
    case 'title':
    case 'aria-label':
    case 'placeholder':
      return true;
    case 'alt':
      return el.tagName === 'img' || el.tagName === 'area' || el.tagName === 'input';
    case 'label':
      return el.tagName === 'option' || el.tagName === 'optgroup';
    case 'value': {
      const type = (getAttr(el, 'type') ?? '').toLowerCase();
      return el.tagName === 'input' && (type === 'submit' || type === 'button' || type === 'reset');
    }
    case 'content': {
      if (el.tagName !== 'meta') return false;
      const key = (getAttr(el, 'name') ?? getAttr(el, 'property') ?? '').toLowerCase();
      return META_CONTENT_KEYS.has(key);
    }
    default:
      return false;
  }
}

/** Thay giá trị thuộc tính dịch được bằng slot. */
function processAttrs(el: Element, ctx: Ctx): void {
  for (const a of el.attrs) {
    if (!isTranslatableAttr(el, a.name) || a.value.includes(SLOT_OPEN)) continue;
    const v = a.value.replace(HTML_WS, ' ').trim();
    if (!LETTER.test(v)) continue;
    a.value = attrSlot(addSentence(ctx, escapeMarkerText(v), {}));
  }
}

/** Thuộc tính của phần tử và mọi phần tử con (bỏ qua vùng không dịch), ví dụ alt của <img> trong <a>. */
function processAttrsDeep(el: Element, ctx: Ctx): void {
  if (isExcluded(el, ctx) && !INLINE_ATOMIC.has(el.tagName)) return;
  if (!isExcluded(el, ctx)) processAttrs(el, ctx);
  for (const c of childrenOf(el)) if (isElement(c)) processAttrsDeep(c, ctx);
}

/** Mã hoá một dãy node nội tuyến thành chuỗi marker; ghi thẻ gốc vào `tags` (id toàn đoạn). */
function encodeNodes(nodes: readonly ChildNode[], ctx: Ctx, tags: Record<string, string>, counter: { n: number }): string {
  let out = '';
  for (const node of nodes) {
    if (isText(node)) {
      out += escapeMarkerText(node.value);
      continue;
    }
    if (!isElement(node)) continue; // comment giữa câu: bỏ
    const kind = classify(node, ctx);
    const id = String(++counter.n);
    if (kind === 'atomic') {
      processAttrsDeep(node, ctx);
      tags[id] = serializeOuter(node);
      out += `{${id}/}`;
    } else {
      processAttrs(node, ctx);
      tags[id] = openTagOf(node);
      out += `{${id}}${encodeNodes(childrenOf(node), ctx, tags, counter)}{/${id}}`;
    }
  }
  return out;
}

function flushRun(parent: ParentNode, run: ChildNode[], ctx: Ctx): void {
  // Khoảng trắng hai đầu đoạn giữ nguyên trong khung
  let a = 0;
  let b = run.length;
  while (a < b && isText(run[a]) && !(run[a] as { value: string }).value.trim()) a++;
  while (b > a && isText(run[b - 1]) && !(run[b - 1] as { value: string }).value.trim()) b--;
  const nodes = run.slice(a, b);
  if (!nodes.length) return;

  // Thẻ bao trọn đoạn: giữ trong khung, xử lý nội dung bên trong
  if (nodes.length === 1 && isElement(nodes[0]) && classify(nodes[0], ctx) === 'inline') {
    processAttrs(nodes[0], ctx);
    processContainer(nodes[0], ctx);
    return;
  }

  // Dãy liên kết kiểu menu ("Home | About | Liên hệ"): văn bản ngoài thẻ không có chữ
  // -> mỗi thẻ là một câu riêng, thẻ giữ trong khung (không tốn span, TM dùng lại tốt hơn)
  const wrappers = nodes.filter((n): n is Element => isElement(n) && classify(n, ctx) === 'inline');
  const looseText = nodes.map((n) => (isText(n) ? n.value : '')).join('');
  if (wrappers.length >= 2 && !LETTER.test(looseText)) {
    for (const w of wrappers) {
      processAttrs(w, ctx);
      processContainer(w, ctx);
    }
    for (const n of nodes) if (isElement(n) && classify(n, ctx) === 'atomic') processAttrsDeep(n, ctx);
    return;
  }

  const tags: Record<string, string> = {};
  const text = encodeNodes(nodes, ctx, tags, { n: 0 });
  const parts = segmentBlock(text);
  if (!parts.some((p) => p.kind === 'sentence' && isTranslatable(p.text))) return; // không có chữ: để nguyên

  let html = '';
  for (const p of parts) {
    if (p.kind === 'gap') {
      html += escapeHtmlText(p.text);
    } else if (!isTranslatable(p.text)) {
      html += restoreInlineHtml(p.text, tags).html;
    } else {
      const { text: local, idMap } = renumberMarkers(p.text.replace(HTML_WS, ' '));
      const localTags: Record<string, string> = {};
      for (const [newId, oldId] of Object.entries(idMap)) localTags[newId] = tags[oldId];
      html += textSlot(addSentence(ctx, local, localTags));
    }
  }

  const index = parent.childNodes.indexOf(nodes[0]);
  for (const n of nodes) removeNode(n);
  ctx.runs.push(html);
  insertChild(parent, index, createText(runSlot(ctx.runs.length - 1), parent));
}

function processContainer(parent: ParentNode, ctx: Ctx): void {
  let run: ChildNode[] = [];
  for (const child of [...childrenOf(parent)]) {
    const kind = classify(child, ctx);
    if (kind !== 'break') {
      run.push(child);
      continue;
    }
    if (run.length) flushRun(run[0].parentNode ?? parent, run, ctx);
    run = [];
    if (isElement(child) && !isExcluded(child, ctx)) {
      processAttrs(child, ctx);
      processContainer(child, ctx);
    }
  }
  if (run.length) flushRun(run[0].parentNode ?? parent, run, ctx);
}

export function extract(html: string, options?: ExtractOptions): ExtractResult {
  const ctx: Ctx = {
    selectors: parseSelectorList((options?.customExclusionSelectors ?? []).join(',')),
    sentences: [],
    placeholders: {},
    runs: [],
    allInlineMemo: new WeakMap(),
  };
  const doc = parse(html);
  processContainer(doc, ctx);
  const skeletonHtml = serialize(doc).replace(SLOT_RE, (all, kind: string, num: string) =>
    kind === 'R' ? (ctx.runs[Number(num)] ?? '') : all,
  );
  return { skeletonHtml, sentences: ctx.sentences, placeholders: ctx.placeholders };
}

// Kiểm tra lúc biên dịch: phải khớp chữ ký đã chốt.
type Assert<T extends true> = T;
type _ContractExtract = Assert<typeof extract extends typeof ContractExtract ? true : false>;
