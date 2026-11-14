// 5.4: kiểm thử proxy trên website mẫu A (menu, biểu mẫu, ảnh, iframe, {n}, translate="no", hreflang/canonical theo
// PUBLIC_BASE_URL, trang dịch dở, trang > 3 MB, 404). Danh sách lỗi đi vào evidence/<runId>/proxy-check.md.
//
//   npm run demo:proxy-check                     # tenant A trong .state/<stage>.json, lang=en
//   npm run demo:proxy-check -- --lang ko
//
// Cảnh báo (CẢNH BÁO) không làm lệnh thất bại: ví dụ còn chữ tiếng Việt do Translate giữ tên riêng, hoặc trang dài
// không thành trang dịch dở (muốn thử nhánh dịch dở: tạm đặt TRANSLATE_BUDGET_MS thấp, ví dụ 1500, cho proxy dev).
import { arg } from './aws';
import { cfg } from '../lib/config';
import { loadState } from '../lib/state';
import { A_PAGES } from '../lib/sampleSites';
import { getPage, mdTable, translatedUrl, untilComplete, writeReport, sleep, type PageGetter, type PageResult } from '../lib/visitor';

export type Severity = 'fail' | 'warn';
export interface CheckRow { id: string; page: string; title: string; pass: boolean; severity: Severity; detail: string }

/** Chữ cái chỉ tiếng Việt mới có (bản dịch sang en/ko không nên còn, trừ tên riêng). */
const VI_CHARS = /[ăâđêôơưàảãạáằẳẵặắầẩẫậấèẻẽẹéềểễệếìỉĩịíòỏõọóồổỗộốờởỡợớùủũụúừửữựứỳỷỹỵý]/i;
const MARKER = /\{\/?\d+\/?\}/;
const SLOT = /TM[SAR]\d+/;

export interface PageCtx { publicBase: string; slug: string; lang: string; origin: string }

const attr = (html: string, re: RegExp) => re.exec(html)?.[1];
const textOf = (html: string) => html
  .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<textarea[\s\S]*?<\/textarea>|<pre[\s\S]*?<\/pre>/gi, ' ')
  .replace(/<nav[^>]*class="[^"]*translateme[^"]*"[\s\S]*?<\/nav>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&[a-z]+;|&#\d+;/gi, ' ')
  .replace(/\s+/g, ' ');

/** Kiểm tra chung cho mọi trang dịch: lang, canonical, hreflang, không sót marker/slot. */
export function commonChecks(page: string, r: PageResult, c: PageCtx, rest: string): CheckRow[] {
  const html = r.body;
  const self = translatedUrl(c.publicBase, c.slug, c.lang, rest);
  const originUrl = new URL(rest, c.origin).toString();
  const rows: CheckRow[] = [];
  const add = (id: string, title: string, pass: boolean, detail: string, severity: Severity = 'fail') => rows.push({ id, page, title, pass, severity, detail });
  add('HTTP', 'Trả 200 và đã dịch đủ', r.status === 200 && !r.partial, `HTTP ${r.status}, partial=${r.partial || '–'}, x-cache "${r.xCache}"`);
  add('LANG', `<html lang="${c.lang}">`, new RegExp(`<html[^>]*\\slang="${c.lang}"`).test(html), attr(html, /<html([^>]*)>/) ?? '');
  const canon = attr(html, /<link rel="canonical" href="([^"]+)">/);
  add('CANONICAL', 'canonical trỏ về chính trang dịch dưới PUBLIC_BASE_URL', canon === self, `${canon} (cần ${self})`);
  const hrefOf = (l: string) => attr(html, new RegExp(`<link rel="alternate" hreflang="${l}" href="([^"]+)">`));
  add('HREFLANG', 'hreflang ngôn ngữ gốc trỏ về origin, x-default về origin, ngôn ngữ đích trỏ PUBLIC_BASE_URL',
    hrefOf('vi') === originUrl && hrefOf('x-default') === originUrl && hrefOf(c.lang) === self,
    `vi=${hrefOf('vi')} x-default=${hrefOf('x-default')} ${c.lang}=${hrefOf(c.lang)}`);
  add('MARKER', 'Không sót ký hiệu {n} hay slot TM* trong HTML', !MARKER.test(html) && !SLOT.test(html),
    (MARKER.exec(html) ?? SLOT.exec(html))?.[0] ?? 'sạch');
  return rows;
}

/** Chữ tiếng Việt còn sót trong nội dung hiển thị (bỏ vùng không dịch đã biết). */
export function vietnameseResidue(html: string, exempt: readonly string[]): string[] {
  let t = textOf(html);
  for (const e of exempt) t = t.split(e).join(' ');
  return [...new Set(t.split(' ').filter((w) => VI_CHARS.test(w)))].slice(0, 20);
}

export function homeChecks(r: PageResult, c: PageCtx): CheckRow[] {
  const page = '/';
  const html = r.body;
  const rows = commonChecks(page, r, c, '');
  const add = (id: string, title: string, pass: boolean, detail: string, severity: Severity = 'fail') => rows.push({ id, page, title, pass, severity, detail });
  add('NO_TRANSLATE', 'Phần tử translate="no" giữ nguyên', html.includes('<span translate="no">Phố Cổ Homestay</span>'), '');
  add('IFRAME', 'iframe giữ nguyên src', html.includes('src="https://www.openstreetmap.org/export/embed.html?bbox=108.3240%2C15.8750%2C108.3340%2C15.8810&amp;layer=mapnik"'), '');
  add('CODE', '<pre><code> giữ nguyên', html.includes('<pre><code>giờ nhận phòng = 14:00; giờ trả phòng = 12:00</code></pre>'), '');
  const room = `/${c.slug}/${c.lang}/${A_PAGES.rooms}`;
  add('LINK', 'Liên kết nội bộ trỏ sang trang dịch', html.includes(`href="${room}"`) || html.includes(`href="${translatedUrl(c.publicBase, c.slug, c.lang, A_PAGES.rooms)}"`), `cần href="${room}"`);
  add('INLINE', 'Thẻ nội tuyến ({n}) được ráp lại: <strong>, <em>, <a>', /<strong>[^<]+<\/strong>/.test(html) && /<em>[^<]+<\/em>/.test(html) && !html.includes('<strong>chùa Cầu</strong>'),
    attr(html, /(<strong>[^<]*<\/strong>)/) ?? 'không thấy <strong>');
  // rebuild đổi src ảnh thành URL tuyệt đối về origin, nên tìm thẻ <img> theo tên tệp
  const img = /<img\b[^>]*san-vuon\.svg[^>]*>/.exec(html)?.[0] ?? '';
  const alt = attr(img, /\balt="([^"]*)"/);
  const title = attr(img, /\btitle="([^"]*)"/);
  add('ALT', 'alt và title của ảnh được dịch', !!alt && !VI_CHARS.test(alt) && !!title && !VI_CHARS.test(title), img ? `alt="${alt}" title="${title}"` : 'không thấy <img>');
  const desc = attr(html, /<meta name="description" content="([^"]*)"/);
  add('META', 'meta description được dịch', !!desc && !VI_CHARS.test(desc), `"${desc}"`);
  const residue = vietnameseResidue(html, ['Phố Cổ Homestay', 'Tiếng Việt (gốc)', 'Tiếng Việt']);
  add('RESIDUE', 'Không còn chữ tiếng Việt trong nội dung (trừ vùng không dịch)', residue.length === 0, residue.join(', ') || 'sạch', 'warn');
  return rows;
}

export function roomsChecks(r: PageResult, c: PageCtx): CheckRow[] {
  const page = `/${A_PAGES.rooms}`;
  const rows = commonChecks(page, r, c, A_PAGES.rooms);
  const html = r.body;
  rows.push({ id: 'TABLE', page, title: 'Ô bảng và danh sách được dịch', severity: 'fail',
    pass: !html.includes('<th>Sức chứa</th>') && !html.includes('<li>Khăn tắm được thay mỗi ngày.</li>'), detail: attr(html, /(<th>[^<]*<\/th>)/) ?? '' });
  return rows;
}

export function contactChecks(r: PageResult, c: PageCtx): CheckRow[] {
  const page = `/${A_PAGES.contact}`;
  const rows = commonChecks(page, r, c, A_PAGES.contact);
  const html = r.body;
  const add = (id: string, title: string, pass: boolean, detail: string) => rows.push({ id, page, title, pass, severity: 'fail', detail });
  const ph = attr(html, /id="ten" name="ten" placeholder="([^"]*)"/);
  add('PLACEHOLDER', 'placeholder và aria-label được dịch', !!ph && !VI_CHARS.test(ph) && !html.includes('aria-label="Địa chỉ thư điện tử"'), `placeholder="${ph}"`);
  const opt = attr(html, /<option value="doi">([^<]*)<\/option>/);
  add('OPTION', '<option> được dịch, value giữ nguyên', !!opt && !VI_CHARS.test(opt), `<option value="doi">${opt ?? '(không thấy value="doi")'}`);
  add('BUTTON', 'Nút và input submit được dịch', !html.includes('>Gửi yêu cầu<') && !html.includes('value="Gửi nhanh"'), '');
  add('TEXTAREA', 'Nội dung textarea giữ nguyên', html.includes('>Nội dung trong ô nhập không được dịch.</textarea>'), '');
  add('FORM', 'action của biểu mẫu giữ nguyên', html.includes('action="https://example.invalid/dat-phong"'), '');
  return rows;
}

export interface ProxyCheckDeps extends PageCtx { get: PageGetter; wait?: (ms: number) => Promise<void>; disabledLang?: string }

export async function runProxyCheck(d: ProxyCheckDeps): Promise<CheckRow[]> {
  const u = (rest: string, lang = d.lang) => translatedUrl(d.publicBase, d.slug, lang, rest);
  const wait = d.wait ?? sleep;
  const rows: CheckRow[] = [];
  rows.push(...homeChecks(await untilComplete(d.get, u(''), { wait }), d));
  rows.push(...roomsChecks(await untilComplete(d.get, u(A_PAGES.rooms), { wait }), d));
  rows.push(...contactChecks(await untilComplete(d.get, u(A_PAGES.contact), { wait }), d));

  const big = await d.get(u(A_PAGES.tooLarge));
  const bigOrigin = new URL(A_PAGES.tooLarge, d.origin).toString();
  rows.push({ id: 'TOO_LARGE', page: `/${A_PAGES.tooLarge}`, title: 'HTML gốc > 3 MB -> 302 về trang gốc', severity: 'fail',
    pass: big.status === 302 && big.location === bigOrigin, detail: `HTTP ${big.status} location=${big.location}` });
  const missing = await d.get(u(A_PAGES.missing));
  rows.push({ id: 'ORIGIN_404', page: `/${A_PAGES.missing}`, title: 'Origin 404 -> 404 (QC-2), không chuyển hướng', severity: 'fail',
    pass: missing.status === 404 && !missing.location, detail: `HTTP ${missing.status}${missing.location ? ` location=${missing.location}` : ''}` });
  const off = d.disabledLang ?? 'ja';
  const disabled = await d.get(u('', off));
  rows.push({ id: 'LANG_OFF', page: `/${off}/`, title: 'Ngôn ngữ chưa bật -> 404', severity: 'fail', pass: disabled.status === 404, detail: `HTTP ${disabled.status}` });
  const head = await d.get(u(A_PAGES.rooms), { method: 'HEAD' });
  rows.push({ id: 'HEAD', page: `/${A_PAGES.rooms}`, title: 'HEAD trả 200, không có body', severity: 'fail', pass: head.status === 200 && head.bytes === 0, detail: `HTTP ${head.status}, ${head.bytes} byte` });

  const first = await d.get(u(A_PAGES.long));
  const final = first.partial ? await untilComplete(d.get, u(A_PAGES.long), { wait, attempts: 24 }) : first;
  rows.push({ id: 'PARTIAL', page: `/${A_PAGES.long}`, title: 'Trang dài: lượt đầu là trang dịch dở (X-TranslateMe-Partial, s-maxage=60)', severity: 'warn',
    pass: first.status === 200 && first.partial === '1' && /s-maxage=60/.test(first.cacheControl), detail: `HTTP ${first.status} partial=${first.partial || '–'} cache-control="${first.cacheControl}" ${first.ms} ms` });
  rows.push({ id: 'WORKER', page: `/${A_PAGES.long}`, title: 'Worker dịch nốt: lượt sau đủ bản dịch', severity: 'fail',
    pass: final.status === 200 && !final.partial, detail: `HTTP ${final.status} partial=${final.partial || '–'}` });
  return rows;
}

export function proxyCheckMarkdown(rows: readonly CheckRow[], meta: Record<string, string>): string {
  const fails = rows.filter((r) => !r.pass && r.severity === 'fail');
  const warns = rows.filter((r) => !r.pass && r.severity === 'warn');
  return [
    '# 5.4 – Kiểm thử proxy trên website mẫu A', '',
    ...Object.entries(meta).map(([k, v]) => `- ${k}: \`${v}\``), '',
    `**${fails.length ? 'CÓ LỖI' : 'ĐẠT'}** – ${rows.filter((r) => r.pass).length}/${rows.length} đạt, ${fails.length} lỗi, ${warns.length} cảnh báo.`, '',
    mdTable(['Trang', 'Mã', 'Kiểm tra', 'Kết quả', 'Chi tiết'],
      rows.map((r) => [r.page, r.id, r.title, r.pass ? 'ĐẠT' : r.severity === 'fail' ? 'LỖI' : 'CẢNH BÁO', r.detail])), '',
    '## Danh sách lỗi (điền bản sửa)', '',
    ...(fails.length ? fails.map((r) => `- [ ] ${r.page} ${r.id}: ${r.title} – ${r.detail} → bản sửa: …`) : ['- Không có.']), '',
  ].join('\n');
}

async function main(): Promise<void> {
  const c = cfg();
  const t = loadState(c.stage).tenants.A;
  const ctx = { publicBase: c.publicBase, slug: arg('slug') ?? t.slug, lang: arg('lang') ?? 'en', origin: t.origin };
  const rows = await runProxyCheck({ ...ctx, get: getPage, disabledLang: arg('disabled-lang') });
  const meta = { PUBLIC_BASE: c.publicBase, slug: ctx.slug, lang: ctx.lang, origin: ctx.origin, 'Thời điểm': new Date().toISOString() };
  const dir = writeReport('proxy-check', { meta, rows }, proxyCheckMarkdown(rows, meta));
  for (const r of rows) if (!r.pass) console.log(`${r.severity === 'fail' ? 'LỖI     ' : 'CẢNH BÁO'} ${r.page} ${r.id}: ${r.title} – ${r.detail}`);
  console.log(`${rows.filter((r) => r.pass).length}/${rows.length} đạt. Bằng chứng: ${dir}/proxy-check.{md,json}`);
  if (rows.some((r) => !r.pass && r.severity === 'fail')) process.exitCode = 1;
}

if (require.main === module) main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
