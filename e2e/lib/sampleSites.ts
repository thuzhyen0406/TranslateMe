// Ba website mẫu cho 5.4 (kiểm thử proxy), 5.5 (độ trễ) và kịch bản 8 (xóa cache chọn lọc).
// Nguồn duy nhất cho tools/build-sites.ts (sinh HTML) và demo/proxyCheck.ts, demo/latency.ts, demo/kb8.ts (kiểm tra).
// Mỗi site cần hostname riêng vì slug được sinh từ hostname (siteManager.createSite): A, B, C khớp TM_DEMO_ORIGIN_A/B/C.

export type SiteKey = 'A' | 'B' | 'C';

export const SITE_TITLES: Record<SiteKey, string> = {
  A: 'Homestay Phố Cổ – website mẫu 5.4',
  B: 'Trang đo độ trễ – website mẫu 5.5',
  C: 'Nhà hàng Sông Hoài – website mẫu kịch bản 8',
};

/** Câu X của kịch bản 8: có ở trang-1 và trang-2, không có ở trang-3. */
export const KB8_SHARED_SENTENCE = 'Bữa sáng được phục vụ miễn phí từ sáu giờ đến chín giờ mỗi ngày.';
export const KB8_PAGES = ['trang-1/', 'trang-2/', 'trang-3/'] as const;
export const KB8_PAGES_WITH_SHARED = ['trang-1/', 'trang-2/'] as const;

/** 5.5: số trang TM rỗng cho trường hợp (a), mỗi lần đo một trang có câu chưa từng dịch. */
export const LATENCY_RUNS = 10;
export const LATENCY_SENTENCES = 100;
export const latencyColdPage = (run: number) => `do-tre/lan-${String(run).padStart(2, '0')}/`;
/** Trang dùng cho (b) trúng TM và (c) trúng cache CloudFront. */
export const LATENCY_WARM_PAGE = 'do-tre/am/';

/** 5.4: trang lớn hơn 3 MB (proxy phải 302 về trang gốc) và trang dài để thử trang dịch dở. */
export const A_PAGES = {
  home: '',
  rooms: 'phong-nghi/',
  contact: 'lien-he/',
  missing: 'khong-ton-tai/',
  tooLarge: 'qua-lon/',
  long: 'trang-dai/',
} as const;
export const TOO_LARGE_BYTES = 3_300_000;
export const LONG_PAGE_SENTENCES = 400;

const ROOM_KINDS = ['phòng đôi', 'phòng gia đình', 'phòng đơn', 'căn hộ nhỏ', 'phòng tầng áp mái', 'phòng hướng vườn', 'phòng có bếp', 'phòng hai giường'];
const FEATURES = ['ban công rộng', 'cửa sổ lớn', 'bồn tắm gỗ', 'giường tre', 'bàn làm việc', 'tủ lạnh nhỏ', 'sàn gỗ lim', 'rèm cửa dày', 'quạt trần cũ', 'kệ sách'];
const VIEWS = ['sông Hoài', 'phố cổ', 'vườn rau', 'cánh đồng lúa', 'giếng cổ', 'chợ đêm', 'chùa Cầu', 'bến thuyền'];
const NUMBERS = ['một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín', 'mười'];

/** Số bằng chữ (0–9999) để mọi câu khác nhau mà không chứa chữ số (Translate giữ nguyên chữ số). */
export function vietnameseNumber(n: number): string {
  if (n < 10) return n === 0 ? 'không' : NUMBERS[n - 1];
  const units = ['', 'mươi', 'trăm', 'nghìn'];
  const digits = String(n).split('').map(Number);
  return digits.map((d, i) => `${d === 0 ? 'không' : NUMBERS[d - 1]} ${units[digits.length - 1 - i]}`.trim()).join(' ');
}

/** Câu thứ i của nhóm `group` – xác định, không trùng giữa các nhóm và trong cùng nhóm. */
export function sampleSentence(group: string, i: number): string {
  const room = ROOM_KINDS[i % ROOM_KINDS.length];
  const feature = FEATURES[Math.floor(i / ROOM_KINDS.length) % FEATURES.length];
  const view = VIEWS[(i * 3 + group.length) % VIEWS.length];
  return `Trong khu ${group}, ${room} số ${vietnameseNumber(i + 1)} có ${feature} và nhìn ra ${view}.`;
}

export function sampleSentences(group: string, n: number): string[] {
  const out = Array.from({ length: n }, (_, i) => sampleSentence(group, i));
  if (new Set(out).size !== out.length) throw new Error(`Câu mẫu bị trùng trong nhóm ${group}`);
  return out;
}

/**
 * Nhóm câu của trang đo lần `run` (a) và của trang ấm (b, c). `round` (TM_LATENCY_ROUND, mặc định 1) đổi toàn bộ câu
 * để đo lại (a) với TM rỗng: TM đã có câu của đợt trước nên phải build và đăng lại site B với đợt mới.
 */
export const latencyGroup = (run: number | 'am', round = 1) => {
  const r = round > 1 ? ` đợt ${vietnameseNumber(round)}` : '';
  return run === 'am' ? `đo ấm${r}` : `đo lạnh ${vietnameseNumber(run)}${r}`;
};
