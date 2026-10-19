/**
 * rebuild – ráp HTML đã dịch từ khung của extract() (F2 bước 6 – Nhiệm vụ 1.6, TV2).
 * Chữ ký đúng 100% `rebuild()` trong interfaces.d.ts; các tuỳ chọn thêm đều không bắt buộc.
 *
 * Việc làm:
 *  1. Điền bản dịch vào slot. Câu chưa có bản dịch (hết ngân sách 20 s, lỗi Translate) -> giữ câu gốc.
 *     Bản dịch mất/thừa marker (compareMarkers.restorable = false) -> dùng văn bản thuần của bản dịch
 *     để không làm vỡ DOM (mục 3.2 Quy ước). Thẻ được khôi phục theo id, không theo thứ tự.
 *  2. <html lang>, <link rel="canonical"> trỏ về chính trang dịch, <link rel="alternate" hreflang> cho mọi
 *     ngôn ngữ đang bật + ngôn ngữ gốc + x-default (cả hai trỏ về website gốc).
 *  3. Liên kết nội bộ -> /{lang}/…; ảnh, CSS, JS, phông chữ, iframe, action của form -> URL tuyệt đối về
 *     website gốc (proxy không chuyển tiếp dữ liệu form). url(...) trong style cũng được đổi. <base> bị bỏ.
 *  4. Chèn nút chọn ngôn ngữ cố định đầu trang bằng <details> (HTML + CSS, không JavaScript),
 *     có mục "Tiếng Việt (gốc)" dẫn về website gốc.
 */
import { parse, serialize } from 'parse5';
import {
  SLOT_RE,
  createText,
  escapeAttr,
  findAll,
  findFirst,
  getAttr,
  insertChild,
  removeAttr,
  removeNode,
  setAttr,
  sourceKey,
  tagKey,
  walkElements,
  appendChild,
  createElement,
  isText,
  type Document,
} from './htmlDom.js';
import type { RebuildOptions, rebuild as ContractRebuild } from './interfaces.js';
import { compareMarkers, escapeHtmlText, restoreInlineHtml, stripMarkers, validateMarkers } from './markers.js';

export const DEFAULT_PROXY_BASE_DOMAIN = 'translateme.example';
export const DEFAULT_SOURCE_LANG = 'vi';

export interface RebuildOptionsExt extends RebuildOptions {
  /** Ngôn ngữ gốc của website (mặc định 'vi') */
  sourceLang?: string;
  /** Các ngôn ngữ đích đang bật, dùng cho hreflang và nút chọn ngôn ngữ (mặc định [targetLang]) */
  languages?: readonly string[];
  /** Trang chủ website gốc (bản ghi HOST). Mặc định: gốc tên miền của originalUrl */
  siteHomeUrl?: string;
  /** Tên miền proxy: trang dịch ở https://{slug}.{proxyBaseDomain}/{lang}/… (mặc định translateme.example) */
  proxyBaseDomain?: string;
  /** Chèn nút chọn ngôn ngữ (mặc định true) */
  languageSwitcher?: boolean;
}

export interface RebuildStats {
  sentences: number;
  /** Câu dùng bản dịch */
  translated: number;
  /** Câu giữ nguyên ngôn ngữ gốc vì chưa có bản dịch */
  keptSource: number;
  /** Câu dùng văn bản thuần vì marker trong bản dịch bị hỏng */
  tagFallback: number;
}

export const LANGUAGE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  vi: 'Tiếng Việt', en: 'English', ko: '한국어', ja: '日本語', zh: '中文', 'zh-TW': '中文（繁體）',
  fr: 'Français', de: 'Deutsch', es: 'Español', th: 'ไทย', id: 'Bahasa Indonesia', ru: 'Русский', ar: 'العربية',
});

const RTL_LANGS: ReadonlySet<string> = new Set(['ar', 'he', 'fa', 'ur']);

/** Đuôi tệp không phải trang HTML: liên kết tới chúng trỏ thẳng về website gốc. */
const NON_PAGE_EXT = /\.(pdf|zip|rar|7z|gz|tar|docx?|xlsx?|pptx?|csv|txt|xml|json|jpe?g|png|gif|webp|avif|svg|ico|mp[34]|webm|mov|avi|js|css|woff2?|ttf|otf|eot|exe|dmg|apk)$/i;

/** Thuộc tính chứa URL tài nguyên theo thẻ -> đổi thành URL tuyệt đối về website gốc. */
const ASSET_ATTRS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  img: ['src', 'srcset'],
  source: ['src', 'srcset'],
  script: ['src'],
  link: ['href'],
  iframe: ['src'],
  embed: ['src'],
  object: ['data'],
  video: ['src', 'poster'],
  audio: ['src'],
  track: ['src'],
  input: ['src', 'formaction'],
  button: ['formaction'],
  form: ['action'],
  image: ['href', 'xlink:href'],
  use: ['href', 'xlink:href'],
});

const SWITCHER_TOKEN = 'TMW';
const SWITCHER_CSS =
  '#tm-lang{position:fixed;top:12px;right:12px;z-index:2147483647;font:14px/1.4 system-ui,sans-serif;' +
  'background:#fff;color:#111;border:1px solid #ccc;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.15)}' +
  '#tm-lang summary{cursor:pointer;padding:6px 12px;list-style:none}' +
  '#tm-lang summary::-webkit-details-marker{display:none}' +
  '#tm-lang ul{margin:0;padding:4px 0;list-style:none;border-top:1px solid #eee}' +
  '#tm-lang a{display:block;padding:6px 12px;color:inherit;text-decoration:none}' +
  '#tm-lang a[aria-current]{font-weight:600}';

export interface UrlCtx {
  base: URL;
  homeOrigin: string;
  homePath: string; // luôn kết thúc bằng '/'
  lang: string;
}

function tryUrl(value: string, base: URL | string): URL | null {
  try {
    return new URL(value, base);
  } catch {
    return null;
  }
}

function isSpecialRef(v: string): boolean {
  const s = v.trim();
  return s === '' || s.startsWith('#') || /^(data|javascript|mailto|tel|sms|blob|about):/i.test(s);
}

/** Phần đường dẫn sau trang chủ, hoặc null nếu URL không thuộc website. */
function restOf(u: URL, ctx: UrlCtx): string | null {
  if (u.origin !== ctx.homeOrigin) return null;
  if (u.pathname === ctx.homePath.slice(0, -1) || u.pathname === ctx.homePath) return '';
  if (!u.pathname.startsWith(ctx.homePath)) return null;
  return u.pathname.slice(ctx.homePath.length);
}

function absolute(v: string, ctx: UrlCtx): string {
  if (isSpecialRef(v)) return v;
  return tryUrl(v.trim(), ctx.base)?.href ?? v;
}

function rewriteNav(v: string, ctx: UrlCtx): string {
  if (isSpecialRef(v)) return v;
  const u = tryUrl(v.trim(), ctx.base);
  if (!u) return v;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return u.href;
  const rest = restOf(u, ctx);
  if (rest === null || NON_PAGE_EXT.test(u.pathname)) return u.href;
  return `/${ctx.lang}/${rest}${u.search}${u.hash}`;
}

/**
 * srcset theo đặc tả HTML: URL là chuỗi không có khoảng trắng (có thể chứa dấu phẩy, ví dụ Cloudinary
 * "w_400,h_300"); ứng viên ngăn bằng dấu phẩy sau phần mô tả (1x, 480w).
 */
export function rewriteSrcset(v: string, ctx: UrlCtx): string {
  const out: string[] = [];
  let i = 0;
  while (i < v.length) {
    while (i < v.length && /[\s,]/.test(v[i])) i++;
    if (i >= v.length) break;
    let j = i;
    while (j < v.length && !/\s/.test(v[j])) j++;
    let url = v.slice(i, j);
    let descriptor = '';
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '');
    } else {
      let k = j;
      let depth = 0;
      while (k < v.length && (v[k] !== ',' || depth > 0)) {
        if (v[k] === '(') depth++;
        else if (v[k] === ')') depth = Math.max(0, depth - 1);
        k++;
      }
      descriptor = v.slice(j, k).trim();
      j = k;
    }
    out.push(descriptor ? `${absolute(url, ctx)} ${descriptor}` : absolute(url, ctx));
    i = j;
  }
  return out.join(', ');
}

function rewriteCssUrls(css: string, ctx: UrlCtx): string {
  return css
    .replace(/url\(\s*(['"]?)([^'")]+?)\1\s*\)/gi, (all, q: string, u: string) =>
      isSpecialRef(u) ? all : `url(${q}${absolute(u, ctx)}${q})`,
    )
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (all, q: string, u: string) => `@import ${q}${absolute(u, ctx)}${q}`);
}

function rewriteUrls(doc: Document, ctx: UrlCtx): void {
  walkElements(doc, (el) => {
    const tag = el.tagName;
    if (tag === 'a' || tag === 'area') {
      const href = getAttr(el, 'href');
      if (href !== undefined) setAttr(el, 'href', rewriteNav(href, ctx));
    }
    for (const name of ASSET_ATTRS[tag] ?? []) {
      const v = getAttr(el, name);
      if (v === undefined) continue;
      setAttr(el, name, name === 'srcset' ? rewriteSrcset(v, ctx) : absolute(v, ctx));
    }
    if (tag === 'form' && getAttr(el, 'action') === undefined) setAttr(el, 'action', ctx.base.href);
    const style = getAttr(el, 'style');
    if (style !== undefined && /url\(/i.test(style)) setAttr(el, 'style', rewriteCssUrls(style, ctx));
    if (tag === 'style') {
      for (const c of el.childNodes) if (isText(c)) c.value = rewriteCssUrls(c.value, ctx);
    }
  });
}

function fillSlots(
  skeletonHtml: string,
  translations: readonly (string | null | undefined)[],
  placeholders: Readonly<Record<string, string>>,
  stats: RebuildStats,
): string {
  const seen = new Set<number>();
  const pick = (i: number): { src: string; text: string; fromSource: boolean } | null => {
    const src = placeholders[sourceKey(i)];
    if (src === undefined) return null;
    const tr = translations[i];
    const fromSource = typeof tr !== 'string' || tr.trim() === '';
    if (!seen.has(i)) {
      seen.add(i);
      stats.sentences++;
      if (fromSource) stats.keptSource++;
      else stats.translated++;
    }
    return { src, text: fromSource ? src : (tr as string), fromSource };
  };

  // Lượt 1: câu trong nội dung (có thể chèn thẻ gốc chứa slot thuộc tính, ví dụ title của <a>)
  const withText = skeletonHtml.replace(SLOT_RE, (all, kind: string, num: string) => {
    if (kind !== 'S') return all;
    const i = Number(num);
    const p = pick(i);
    if (!p) return '';
    if (!p.fromSource && !compareMarkers(p.src, p.text).restorable) {
      stats.tagFallback++;
      return escapeHtmlText(stripMarkers(p.text));
    }
    const tags: Record<string, string> = {};
    for (const id of validateMarkers(p.src).ids) {
      const t = placeholders[tagKey(i, id)];
      if (t !== undefined) tags[id] = t;
    }
    return restoreInlineHtml(p.text, tags).html;
  });
  // Lượt 2: câu trong thuộc tính
  return withText.replace(SLOT_RE, (all, kind: string, num: string) => {
    if (kind !== 'A') return '';
    const p = pick(Number(num));
    return p ? escapeAttr(stripMarkers(p.text)) : '';
  });
}

function buildSwitcherHtml(current: string, sourceLang: string, langs: readonly string[], originalUrl: string, rest: string): string {
  const name = (l: string) => LANGUAGE_NAMES[l] ?? l;
  const items = [
    `<li><a href="${escapeAttr(originalUrl)}" hreflang="${escapeAttr(sourceLang)}" lang="${escapeAttr(sourceLang)}">${escapeHtmlText(name(sourceLang))} (gốc)</a></li>`,
    ...langs.map((l) => {
      const cur = l === current ? ' aria-current="page"' : '';
      return `<li><a href="${escapeAttr(`/${l}/${rest}`)}" hreflang="${escapeAttr(l)}" lang="${escapeAttr(l)}"${cur}>${escapeHtmlText(name(l))}</a></li>`;
    }),
  ].join('');
  return (
    `<details id="tm-lang" class="notranslate" translate="no"><style>${SWITCHER_CSS}</style>` +
    `<summary>🌐 ${escapeHtmlText(name(current))}</summary><ul>${items}</ul></details>`
  );
}

export function rebuildDetailed(
  skeletonHtml: string,
  translations: readonly (string | null | undefined)[],
  placeholders: Readonly<Record<string, string>>,
  options: RebuildOptionsExt,
): { html: string; stats: RebuildStats } {
  const stats: RebuildStats = { sentences: 0, translated: 0, keptSource: 0, tagFallback: 0 };
  const lang = options.targetLang;
  const sourceLang = options.sourceLang ?? DEFAULT_SOURCE_LANG;
  const langs = [...new Set([...(options.languages ?? []), lang])].filter((l) => l !== sourceLang);
  const domain = options.proxyBaseDomain ?? DEFAULT_PROXY_BASE_DOMAIN;
  const pageUrl = new URL(options.originalUrl);
  const home = tryUrl(options.siteHomeUrl ?? '/', pageUrl) ?? new URL('/', pageUrl);
  const homePath = home.pathname.endsWith('/') ? home.pathname : `${home.pathname}/`;

  const doc = parse(fillSlots(skeletonHtml, translations, placeholders, stats));
  const htmlEl = findFirst(doc, (el) => el.tagName === 'html');
  const head = findFirst(doc, (el) => el.tagName === 'head');
  const body = findFirst(doc, (el) => el.tagName === 'body');

  // <base>: dùng để phân giải URL tương đối rồi bỏ đi (nếu giữ, liên kết /{lang}/… sẽ trỏ sai tên miền)
  const baseEl = findAll(doc, (el) => el.tagName === 'base');
  const baseHref = baseEl.map((b) => getAttr(b, 'href')).find((h) => h !== undefined);
  const base = (baseHref !== undefined ? tryUrl(baseHref, pageUrl) : null) ?? pageUrl;
  for (const b of baseEl) removeNode(b);

  const ctx: UrlCtx = { base, homeOrigin: home.origin, homePath, lang };
  const pageRest = restOf(pageUrl, ctx) ?? pageUrl.pathname.replace(/^\//, '');
  const proxyUrl = (l: string) => `https://${options.slug}.${domain}/${l}/${pageRest}${pageUrl.search}`;

  if (htmlEl) {
    setAttr(htmlEl, 'lang', lang);
    if (RTL_LANGS.has(lang.split('-')[0])) setAttr(htmlEl, 'dir', 'rtl');
    else if (getAttr(htmlEl, 'dir') === 'rtl') removeAttr(htmlEl, 'dir');
  }

  // Bỏ canonical/hreflang cũ trước khi đổi URL, rồi thêm bộ mới
  for (const link of findAll(doc, (el) => el.tagName === 'link')) {
    const rel = (getAttr(link, 'rel') ?? '').toLowerCase().split(/\s+/);
    if (rel.includes('canonical') || (rel.includes('alternate') && getAttr(link, 'hreflang') !== undefined)) removeNode(link);
  }
  rewriteUrls(doc, ctx);
  for (const m of findAll(doc, (el) => el.tagName === 'meta' && getAttr(el, 'property') === 'og:url')) {
    setAttr(m, 'content', proxyUrl(lang));
  }

  if (head) {
    const add = (attrs: Record<string, string>) => appendChild(head, createElement('link', attrs));
    add({ rel: 'canonical', href: proxyUrl(lang) });
    for (const l of langs) add({ rel: 'alternate', hreflang: l, href: proxyUrl(l) });
    add({ rel: 'alternate', hreflang: sourceLang, href: pageUrl.href });
    add({ rel: 'alternate', hreflang: 'x-default', href: pageUrl.href });
  }

  const withSwitcher = options.languageSwitcher !== false && body !== undefined;
  if (withSwitcher) insertChild(body, 0, createText(SWITCHER_TOKEN, body));
  let html = serialize(doc);
  if (withSwitcher) {
    html = html.replace(SWITCHER_TOKEN, buildSwitcherHtml(lang, sourceLang, langs, pageUrl.href, `${pageRest}${pageUrl.search}`));
  }
  return { html, stats };
}

export function rebuild(
  skeletonHtml: string,
  translations: string[],
  placeholders: Record<string, string>,
  options: RebuildOptionsExt,
): string {
  return rebuildDetailed(skeletonHtml, translations, placeholders, options).html;
}

// Kiểm tra lúc biên dịch: phải khớp chữ ký đã chốt.
type Assert<T extends true> = T;
type _ContractRebuild = Assert<typeof rebuild extends typeof ContractRebuild ? true : false>;
