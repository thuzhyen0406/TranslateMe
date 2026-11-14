// Sinh ba website mẫu tĩnh (A: 5.4, B: 5.5, C: kịch bản 8) vào e2e/sites/dist/<a|b|c>/ để đăng lên host tĩnh có HTTPS
// (mỗi site một hostname riêng, ví dụ Netlify/Cloudflare Pages; xem e2e/sites/README.md).
//
//   npm run sites:build                              # chưa có mã xác minh
//   TM_DEMO_VERIFY_CODE_A=<mã> ... npm run sites:build # chèn thẻ META và tệp FILE vào trang chủ
//
// TM_DEMO_ORIGIN_A/B/C (nếu có) dùng cho sitemap.xml. Không gọi mạng, không gọi AWS.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  A_PAGES,
  KB8_SHARED_SENTENCE,
  LATENCY_RUNS,
  LATENCY_SENTENCES,
  LONG_PAGE_SENTENCES,
  SITE_TITLES,
  TOO_LARGE_BYTES,
  latencyColdPage,
  latencyGroup,
  sampleSentences,
  type SiteKey,
  LATENCY_WARM_PAGE,
} from '../lib/sampleSites';

const VERIFY_TOKEN_RE = /^[A-Za-z0-9._-]{1,200}$/;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface BuildOptions {
  outDir: string;
  /** TM_LATENCY_ROUND: đợt đo 5.5 (đổi câu của site B để (a) lại có TM rỗng) */
  latencyRound?: number;
  origins: Partial<Record<SiteKey, string>>;
  verifyCodes: Partial<Record<SiteKey, string>>;
}

type Files = Map<string, string>;

function page(o: { title: string; body: string; description?: string; verify?: string; css?: boolean }): string {
  const meta = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    // siteManager so khớp nguyên chuỗi: name phải đứng trước content
    o.verify ? `<meta name="translateme-site-verification" content="${esc(o.verify)}">` : '',
    o.description ? `<meta name="description" content="${esc(o.description)}">` : '',
    `<title>${esc(o.title)}</title>`,
    o.css === false ? '' : '<link rel="stylesheet" href="/assets/site.css">',
  ].filter(Boolean).join('\n  ');
  return `<!DOCTYPE html>\n<html lang="vi">\n<head>\n  ${meta}\n</head>\n<body>\n${o.body}\n</body>\n</html>\n`;
}

const CSS = `body{font-family:system-ui,sans-serif;max-width:820px;margin:0 auto;padding:16px;line-height:1.55;color:#1d2a33}
nav a{margin-right:12px}img{max-width:100%;height:auto}table{border-collapse:collapse}td,th{border:1px solid #ccd;padding:4px 8px}
form label{display:block;margin-top:8px}#booking-widget{border:1px dashed #889;padding:8px;margin:12px 0}`;

const svg = (label: string, color: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="240" viewBox="0 0 640 240"><rect width="640" height="240" fill="${color}"/><text x="320" y="130" font-size="28" text-anchor="middle" fill="#fff" font-family="sans-serif">${label}</text></svg>\n`;

function sitemap(origin: string | undefined, paths: readonly string[]): string | undefined {
  if (!origin) return undefined;
  const base = origin.endsWith('/') ? origin : `${origin}/`;
  const urls = paths.map((p) => `  <url><loc>${esc(new URL(p, base).toString())}</loc></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

function common(files: Files, verify: string | undefined): void {
  files.set('assets/site.css', CSS);
  files.set('robots.txt', 'User-agent: *\nAllow: /\n');
  if (verify) files.set('translateme-verification.txt', verify);
}

function siteA(o: BuildOptions): Files {
  const f: Files = new Map();
  const verify = o.verifyCodes.A;
  common(f, verify);
  f.set('img/san-vuon.svg', svg('San vuon', '#4f7a5a'));
  f.set('img/phong-doi.svg', svg('Phong doi', '#7a5a4f'));
  const nav = `<header>
  <nav aria-label="Điều hướng chính"><a href="/">Trang chủ</a><a href="/${A_PAGES.rooms}">Phòng nghỉ</a><a href="/${A_PAGES.contact}">Liên hệ</a><a href="/${A_PAGES.long}">Trang dài</a></nav>
</header>`;
  f.set('index.html', page({
    title: 'Homestay Phố Cổ – nghỉ dưỡng bên sông Hoài',
    description: 'Homestay nhỏ trong phố cổ, có vườn rau và xe đạp miễn phí.',
    verify,
    body: `${nav}
<main>
  <h1>Chào mừng đến với <span translate="no">Phố Cổ Homestay</span></h1>
  <img src="/img/san-vuon.svg" alt="Sân vườn rợp bóng cây trước nhà" title="Sân vườn buổi sáng">
  <p>Nhà chúng tôi cách <strong>chùa Cầu</strong> năm phút đi bộ. Xem <a href="/${A_PAGES.rooms}">danh sách phòng</a> để chọn chỗ ở phù hợp.</p>
  <p>Mỗi sáng, chủ nhà pha <em>cà phê phin</em> và chuẩn bị bánh mì nóng cho khách.</p>
  <p>Xe đạp được cho mượn miễn phí; hãy hỏi lễ tân trước khi ra ngoài.</p>
  <div id="booking-widget">Đặt phòng ngay – công cụ đặt phòng của đối tác (vùng này nên được khai báo trong bộ chọn không dịch).</div>
  <pre><code>giờ nhận phòng = 14:00; giờ trả phòng = 12:00</code></pre>
  <h2>Bản đồ</h2>
  <iframe src="https://www.openstreetmap.org/export/embed.html?bbox=108.3240%2C15.8750%2C108.3340%2C15.8810&amp;layer=mapnik" width="600" height="300" title="Bản đồ khu phố cổ" loading="lazy"></iframe>
</main>
<footer><p>Liên hệ qua <a href="mailto:chu-nha@example.invalid">thư điện tử</a> hoặc gọi số điện thoại ở trang liên hệ.</p></footer>`,
  }));
  f.set(`${A_PAGES.rooms}index.html`, page({
    title: 'Phòng nghỉ – Homestay Phố Cổ',
    body: `${nav}
<main>
  <h1>Phòng nghỉ</h1>
  <img src="/img/phong-doi.svg" alt="Phòng đôi có ban công nhìn ra sông">
  <table>
    <thead><tr><th>Loại phòng</th><th>Sức chứa</th><th>Ghi chú</th></tr></thead>
    <tbody>
      <tr><td>Phòng đôi</td><td>Hai người lớn</td><td>Có ban công nhìn ra sông.</td></tr>
      <tr><td>Phòng gia đình</td><td>Bốn người</td><td>Có thêm giường phụ cho trẻ em.</td></tr>
    </tbody>
  </table>
  <ul><li>Điều hòa và quạt trần trong mọi phòng.</li><li>Khăn tắm được thay mỗi ngày.</li></ul>
  <p>Giá phòng đã gồm bữa sáng; xem <a href="/${A_PAGES.contact}">trang liên hệ</a> để đặt trước.</p>
</main>`,
  }));
  f.set(`${A_PAGES.contact}index.html`, page({
    title: 'Liên hệ – Homestay Phố Cổ',
    body: `${nav}
<main>
  <h1>Liên hệ đặt phòng</h1>
  <form action="https://example.invalid/dat-phong" method="post">
    <label for="ten">Họ và tên</label>
    <input id="ten" name="ten" placeholder="Nhập họ và tên của bạn" required>
    <label for="email">Thư điện tử</label>
    <input id="email" name="email" type="email" placeholder="ban@example.com" aria-label="Địa chỉ thư điện tử">
    <label for="loai">Loại phòng</label>
    <select id="loai" name="loai"><option value="doi">Phòng đôi</option><option value="gia-dinh">Phòng gia đình</option></select>
    <label for="loi-nhan">Lời nhắn</label>
    <textarea id="loi-nhan" name="loi-nhan" placeholder="Cho chúng tôi biết ngày đến và số khách">Nội dung trong ô nhập không được dịch.</textarea>
    <label><input type="checkbox" name="dong-y"> Tôi đồng ý nhận thông tin khuyến mãi.</label>
    <button type="submit">Gửi yêu cầu</button>
    <input type="submit" value="Gửi nhanh">
  </form>
</main>`,
  }));
  const long = sampleSentences('trang dài', LONG_PAGE_SENTENCES).map((s) => `  <p>${esc(s)}</p>`).join('\n');
  f.set(`${A_PAGES.long}index.html`, page({ title: 'Trang dài – thử trang dịch dở', body: `${nav}\n<main>\n  <h1>Trang dài</h1>\n${long}\n</main>` }));
  // > 3 MB: lặp một đoạn cố định (câu trùng nên nếu proxy lỡ dịch cũng không tốn nhiều ký tự)
  const chunk = '  <p>Đoạn văn lặp lại để trang gốc vượt quá ba megabyte.</p>\n';
  const big = page({ title: 'Trang quá lớn', body: `<main>\n${chunk.repeat(Math.ceil(TOO_LARGE_BYTES / Buffer.byteLength(chunk)))}</main>` });
  f.set(`${A_PAGES.tooLarge}index.html`, big);
  const sm = sitemap(o.origins.A, [A_PAGES.home, A_PAGES.rooms, A_PAGES.contact]);
  if (sm) f.set('sitemap.xml', sm);
  return f;
}

function sentencePage(title: string, h1: string, sentences: readonly string[]): string {
  return page({ title, css: false, body: `<main>\n  <h1>${esc(h1)}</h1>\n${sentences.map((s) => `  <p>${esc(s)}</p>`).join('\n')}\n</main>` });
}

function siteB(o: BuildOptions): Files {
  const f: Files = new Map();
  common(f, o.verifyCodes.B);
  // Tiêu đề + h1 + 98 đoạn = 100 câu
  const body = LATENCY_SENTENCES - 2;
  const links: string[] = [];
  for (let run = 1; run <= LATENCY_RUNS; run++) {
    const p = latencyColdPage(run);
    f.set(`${p}index.html`, sentencePage(`Đo độ trễ lần ${run}`, `Trang đo lạnh số ${run}`, sampleSentences(latencyGroup(run, o.latencyRound), body)));
    links.push(`<li><a href="/${p}">Lần ${run}</a></li>`);
  }
  f.set(`${LATENCY_WARM_PAGE}index.html`, sentencePage('Đo độ trễ – trang ấm', 'Trang đo ấm', sampleSentences(latencyGroup('am', o.latencyRound), body)));
  f.set('index.html', page({
    title: SITE_TITLES.B,
    verify: o.verifyCodes.B,
    body: `<main>\n  <h1>Trang đo độ trễ</h1>\n  <p>Mỗi trang có đúng một trăm câu.</p>\n  <ul>${links.join('')}<li><a href="/${LATENCY_WARM_PAGE}">Trang ấm</a></li></ul>\n</main>`,
  }));
  return f;
}

function siteC(o: BuildOptions): Files {
  const f: Files = new Map();
  common(f, o.verifyCodes.C);
  const nav = '<nav><a href="/">Trang chủ</a><a href="/trang-1/">Thực đơn</a><a href="/trang-2/">Phòng</a><a href="/trang-3/">Đường đi</a></nav>';
  const own = (k: string) => sampleSentences(`kịch bản tám ${k}`, 5);
  const mk = (title: string, sentences: string[]) =>
    page({ title, body: `${nav}\n<main>\n  <h1>${esc(title)}</h1>\n${sentences.map((s) => `  <p>${esc(s)}</p>`).join('\n')}\n</main>` });
  f.set('trang-1/index.html', mk('Thực đơn', [...own('một'), KB8_SHARED_SENTENCE]));
  f.set('trang-2/index.html', mk('Phòng', [KB8_SHARED_SENTENCE, ...own('hai')]));
  f.set('trang-3/index.html', mk('Đường đi', own('ba')));
  f.set('index.html', page({ title: SITE_TITLES.C, verify: o.verifyCodes.C, body: `${nav}\n<main>\n  <h1>Nhà hàng Sông Hoài</h1>\n  <p>Website ba trang dùng cho kịch bản xóa cache chọn lọc.</p>\n</main>` }));
  return f;
}

export function buildSites(o: BuildOptions): Record<SiteKey, Files> {
  if (o.latencyRound !== undefined && !(Number.isSafeInteger(o.latencyRound) && o.latencyRound >= 1)) {
    throw new Error('TM_LATENCY_ROUND phải là số nguyên ≥ 1');
  }
  for (const [k, v] of Object.entries(o.verifyCodes)) {
    if (v !== undefined && !VERIFY_TOKEN_RE.test(v)) throw new Error(`TM_DEMO_VERIFY_CODE_${k} có ký tự không hợp lệ`);
  }
  return { A: siteA(o), B: siteB(o), C: siteC(o) };
}

export function writeSites(o: BuildOptions): string[] {
  const sites = buildSites(o);
  const written: string[] = [];
  rmSync(o.outDir, { recursive: true, force: true });
  for (const [key, files] of Object.entries(sites)) {
    for (const [rel, content] of files) {
      const path = join(o.outDir, key.toLowerCase(), rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, 'utf8');
      written.push(path);
    }
  }
  return written;
}

if (require.main === module) {
  const env = process.env;
  const opt = (k: string) => env[k]?.trim() || undefined;
  const outDir = resolve(process.argv[2] ?? join(__dirname, '..', 'sites', 'dist'));
  const written = writeSites({
    outDir,
    origins: { A: opt('TM_DEMO_ORIGIN_A'), B: opt('TM_DEMO_ORIGIN_B'), C: opt('TM_DEMO_ORIGIN_C') },
    verifyCodes: { A: opt('TM_DEMO_VERIFY_CODE_A'), B: opt('TM_DEMO_VERIFY_CODE_B'), C: opt('TM_DEMO_VERIFY_CODE_C') },
    latencyRound: opt('TM_LATENCY_ROUND') ? Number(opt('TM_LATENCY_ROUND')) : undefined,
  });
  console.log(`Đã ghi ${written.length} tệp vào ${outDir} (a/, b/, c/). Đăng mỗi thư mục lên một hostname riêng.`);
}
