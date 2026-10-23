/**
 * htmlDom – tiện ích DOM (parse5) dùng chung cho extract() và rebuild() (Nhiệm vụ 1.5/1.6 – TV2).
 * Gồm: kiểu node, đọc/ghi thuộc tính, escape, ký hiệu ô trống (slot) trong khung HTML,
 * và bộ khớp CSS selector rút gọn cho danh sách "vùng không dịch" của website.
 */
import type { DefaultTreeAdapterMap } from 'parse5';

export type Node = DefaultTreeAdapterMap['node'];
export type Document = DefaultTreeAdapterMap['document'];
export type ParentNode = DefaultTreeAdapterMap['parentNode'];
export type ChildNode = DefaultTreeAdapterMap['childNode'];
export type Element = DefaultTreeAdapterMap['element'];
export type TextNode = DefaultTreeAdapterMap['textNode'];
export type Template = DefaultTreeAdapterMap['template'];

export const HTML_NS = 'http://www.w3.org/1999/xhtml';

// ============================================================================
// Slot trong khung HTML (skeletonHtml)
// Dùng ký tự vùng riêng (Private Use Area) U+E000/U+E001: serializer của parse5 không escape,
// và gần như không xuất hiện trong nội dung thật của trang.
// ============================================================================

export const SLOT_OPEN = 'TM';
export const SLOT_CLOSE = '';
/** Câu nằm trong nội dung (thay bằng HTML đã khôi phục thẻ) */
export const textSlot = (i: number): string => `${SLOT_OPEN}S${i}${SLOT_CLOSE}`;
/** Câu nằm trong giá trị thuộc tính (thay bằng văn bản đã escape cho thuộc tính) */
export const attrSlot = (i: number): string => `${SLOT_OPEN}A${i}${SLOT_CLOSE}`;
/** Cả một đoạn nội tuyến được thay bằng HTML dựng sẵn (chỉ dùng nội bộ trong extract) */
export const runSlot = (i: number): string => `${SLOT_OPEN}R${i}${SLOT_CLOSE}`;
export const SLOT_RE = /TM([SAR])(\d+)/g;

/** Khóa trong `placeholders`: câu gốc thứ i và thẻ gốc của marker id L trong câu i. */
export const sourceKey = (i: number): string => `s:${i}`;
export const tagKey = (i: number, localId: string): string => `t:${i}:${localId}`;

// ============================================================================
// Node helpers
// ============================================================================

export function isElement(n: Node): n is Element {
  return 'tagName' in n;
}

export function isText(n: Node): n is TextNode {
  return n.nodeName === '#text';
}

export function getAttr(el: Element, name: string): string | undefined {
  return el.attrs.find((a) => a.name === name)?.value;
}

export function setAttr(el: Element, name: string, value: string): void {
  const a = el.attrs.find((x) => x.name === name);
  if (a) a.value = value;
  else el.attrs.push({ name, value });
}

export function removeAttr(el: Element, name: string): void {
  el.attrs = el.attrs.filter((a) => a.name !== name);
}

export function createText(value: string, parentNode: ParentNode | null = null): TextNode {
  return { nodeName: '#text', value, parentNode };
}

export function createElement(tagName: string, attrs: Record<string, string> = {}): Element {
  return {
    nodeName: tagName,
    tagName,
    attrs: Object.entries(attrs).map(([name, value]) => ({ name, value })),
    namespaceURI: HTML_NS as Element['namespaceURI'],
    parentNode: null,
    childNodes: [],
  };
}

export function appendChild(parent: ParentNode, child: ChildNode): void {
  child.parentNode = parent;
  parent.childNodes.push(child);
}

export function insertChild(parent: ParentNode, index: number, child: ChildNode): void {
  child.parentNode = parent;
  parent.childNodes.splice(index, 0, child);
}

export function removeNode(node: ChildNode): void {
  const parent = node.parentNode;
  if (!parent) return;
  const i = parent.childNodes.indexOf(node);
  if (i >= 0) parent.childNodes.splice(i, 1);
  node.parentNode = null;
}

/** Con trực tiếp của node (với <template> là nội dung bên trong). */
export function childrenOf(n: Node): ChildNode[] {
  if (isElement(n) && n.tagName === 'template' && 'content' in n) return (n as Template).content.childNodes;
  return 'childNodes' in n ? n.childNodes : [];
}

/** Duyệt toàn bộ phần tử theo thứ tự tài liệu. `visit` trả false để bỏ qua cây con. */
export function walkElements(root: Node, visit: (el: Element) => boolean | void): void {
  for (const c of [...childrenOf(root)]) {
    if (!isElement(c)) continue;
    if (visit(c) === false) continue;
    walkElements(c, visit);
  }
}

export function findFirst(root: Node, pred: (el: Element) => boolean): Element | undefined {
  let found: Element | undefined;
  walkElements(root, (el) => {
    if (found) return false;
    if (pred(el)) {
      found = el;
      return false;
    }
    return true;
  });
  return found;
}

export function findAll(root: Node, pred: (el: Element) => boolean): Element[] {
  const out: Element[] = [];
  walkElements(root, (el) => {
    if (pred(el)) out.push(el);
  });
  return out;
}

// ============================================================================
// Escape
// ============================================================================

export function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/ /g, '&nbsp;');
}

/** Thẻ mở của phần tử, ví dụ `<a href="/x" class="y">`. */
export function openTagOf(el: Element): string {
  const attrs = el.attrs.map((a) => ` ${a.prefix ? `${a.prefix}:` : ''}${a.name}="${escapeAttr(a.value)}"`).join('');
  return `<${el.tagName}${attrs}>`;
}

// ============================================================================
// CSS selector rút gọn (cho customExclusionSelectors của website)
// Hỗ trợ: tag, *, #id, .class (nhiều), [attr], [attr=v], [attr~=v], [attr^=v], [attr$=v], [attr*=v],
// tổ hợp con cháu (khoảng trắng) và con trực tiếp (>), danh sách phân tách bằng dấu phẩy.
// Không hỗ trợ: pseudo-class (:not, :nth-child…), + và ~. Selector không hợp lệ bị bỏ qua.
// ============================================================================

interface AttrTest {
  name: string;
  op: '' | '=' | '~=' | '^=' | '$=' | '*=';
  value: string;
}

interface Compound {
  tag: string | null;
  id: string | null;
  classes: string[];
  attrs: AttrTest[];
}

interface ComplexSelector {
  /** compounds[0] là phần tử ngoài cùng; combinators[i] nối compounds[i] với compounds[i+1] */
  compounds: Compound[];
  combinators: Array<' ' | '>'>;
}

const COMPOUND_PART = /^(?:([a-zA-Z][a-zA-Z0-9-]*|\*)|#([\w-]+)|\.([\w-]+)|\[\s*([\w:-]+)\s*(?:([~^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*)?\])/;

function parseCompound(src: string): Compound | null {
  const c: Compound = { tag: null, id: null, classes: [], attrs: [] };
  let rest = src;
  if (!rest) return null;
  while (rest) {
    const m = COMPOUND_PART.exec(rest);
    if (!m) return null;
    if (m[1]) {
      if (rest !== src) return null; // tên thẻ chỉ được đứng đầu compound
      c.tag = m[1] === '*' ? null : m[1].toLowerCase();
    } else if (m[2]) c.id = m[2];
    else if (m[3]) c.classes.push(m[3]);
    else if (m[4]) {
      c.attrs.push({
        name: m[4].toLowerCase(),
        op: (m[5] ?? '') as AttrTest['op'],
        value: m[6] ?? m[7] ?? m[8] ?? '',
      });
    }
    rest = rest.slice(m[0].length);
  }
  return c;
}

export function parseSelectorList(selector: string): ComplexSelector[] {
  const out: ComplexSelector[] = [];
  for (const part of selector.split(',')) {
    const tokens = part.trim().replace(/\s*>\s*/g, ' > ').split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    const compounds: Compound[] = [];
    const combinators: Array<' ' | '>'> = [];
    let pending: ' ' | '>' | null = null;
    let ok = true;
    for (const t of tokens) {
      if (t === '>') {
        if (!compounds.length || pending === '>') ok = false;
        pending = '>';
        continue;
      }
      const c = parseCompound(t);
      if (!c) {
        ok = false;
        break;
      }
      if (compounds.length) combinators.push(pending ?? ' ');
      compounds.push(c);
      pending = null;
    }
    if (ok && compounds.length && pending === null) out.push({ compounds, combinators });
  }
  return out;
}

function matchCompound(el: Element, c: Compound): boolean {
  if (c.tag !== null && el.tagName !== c.tag) return false;
  if (c.id !== null && getAttr(el, 'id') !== c.id) return false;
  if (c.classes.length) {
    const cls = (getAttr(el, 'class') ?? '').split(/\s+/);
    if (!c.classes.every((x) => cls.includes(x))) return false;
  }
  for (const a of c.attrs) {
    const v = getAttr(el, a.name);
    if (v === undefined) return false;
    switch (a.op) {
      case '=':
        if (v !== a.value) return false;
        break;
      case '~=':
        if (!v.split(/\s+/).includes(a.value)) return false;
        break;
      case '^=':
        if (!a.value || !v.startsWith(a.value)) return false;
        break;
      case '$=':
        if (!a.value || !v.endsWith(a.value)) return false;
        break;
      case '*=':
        if (!a.value || !v.includes(a.value)) return false;
        break;
    }
  }
  return true;
}

function parentElement(el: Element): Element | null {
  const p = el.parentNode;
  return p && isElement(p) ? p : null;
}

function matchComplex(el: Element, sel: ComplexSelector, idx = sel.compounds.length - 1): boolean {
  if (!matchCompound(el, sel.compounds[idx])) return false;
  if (idx === 0) return true;
  const comb = sel.combinators[idx - 1];
  if (comb === '>') {
    const p = parentElement(el);
    return p !== null && matchComplex(p, sel, idx - 1);
  }
  for (let p = parentElement(el); p; p = parentElement(p)) {
    if (matchComplex(p, sel, idx - 1)) return true;
  }
  return false;
}

export function matchesAny(el: Element, selectors: readonly ComplexSelector[]): boolean {
  return selectors.some((s) => matchComplex(el, s));
}
