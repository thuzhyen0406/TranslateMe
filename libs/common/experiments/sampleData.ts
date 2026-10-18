/**
 * Bộ dữ liệu mẫu (Sample Corpus) cho 5 thử nghiệm trong Nhiệm vụ 1.12.
 * Có thể chỉnh sửa/bổ sung thêm câu mẫu tại đây trước khi chạy lại script.
 */

import type { TargetLang, TerminologyTerm } from './analyzers.js';

// ============================================================================
// Dữ liệu Thử nghiệm 1 & 2: 12 câu mẫu tiếng Việt có bọc <span data-i="k">
// ============================================================================

export interface SpanSampleSentence {
  id: string;
  category: string;
  description: string;
  /** Câu HTML đã bọc `<span data-i="k">...</span>` ở các phần tử nội tuyến */
  taggedHtml: string;
}

export const SPAN_SAMPLE_SENTENCES: readonly SpanSampleSentence[] = Object.freeze([
  {
    id: 'S01',
    category: 'Câu thường (1 thẻ đơn)',
    description: 'Câu giới thiệu dịch vụ có 1 cụm nhấn mạnh',
    taggedHtml: 'Chào mừng quý khách đến với <span data-i="1">dịch vụ đặt phòng trực tuyến</span> của chúng tôi.',
  },
  {
    id: 'S02',
    category: 'Chữ đậm (strong/b)',
    description: 'Câu thông báo chính sách hoàn tiền có phần chữ đậm',
    taggedHtml: 'Quý khách được <span data-i="1">miễn phí hủy phòng</span> trước 48 giờ so với giờ nhận phòng.',
  },
  {
    id: 'S03',
    category: 'Liên kết (anchor link)',
    description: 'Câu hướng dẫn có chứa liên kết nội tuyến',
    taggedHtml: 'Vui lòng xem chi tiết tại <span data-i="1">trang điều khoản sử dụng</span> hoặc liên hệ bộ phận hỗ trợ.',
  },
  {
    id: 'S04',
    category: 'Nhiều thẻ liên tiếp (3 thẻ)',
    description: 'Câu có 3 thẻ nội tuyến tách biệt dễ bị đảo thứ tự ở tiếng Hàn/Nhật',
    taggedHtml: 'Giá phòng đã bao gồm <span data-i="1">bữa sáng tự chọn</span>, <span data-i="2">xe đưa đón sân bay</span> và <span data-i="3">thuế giá trị gia tăng</span>.',
  },
  {
    id: 'S05',
    category: 'Thẻ lồng nhau (2 cấp)',
    description: 'Thẻ span bên ngoài chứa một thẻ span con bên trong',
    taggedHtml: 'Chương trình <span data-i="1">ưu đãi mùa hè giảm ngay <span data-i="2">30% giá phòng</span> cho khách đặt sớm</span> áp dụng đến hết tháng này.',
  },
  {
    id: 'S06',
    category: 'Thẻ lồng nhau + thẻ rời',
    description: 'Kết hợp thẻ lồng nhau và thẻ độc lập trong cùng câu',
    taggedHtml: 'Nhấn vào <span data-i="1">nút <span data-i="2">Xác nhận đặt chỗ</span> ở góc phải</span> để nhận <span data-i="3">mã giảm giá tức thì</span>.',
  },
  {
    id: 'S07',
    category: 'Số và dấu chấm thập phân',
    description: 'Câu chứa điểm đánh giá thập phân, khoảng cách km và giá tiền',
    taggedHtml: 'Khách sạn đạt điểm đánh giá <span data-i="1">9.4/10</span> từ 1.250 lượt khách và chỉ cách biển <span data-i="2">0.5 km</span>.',
  },
  {
    id: 'S08',
    category: 'Câu rất ngắn (nút bấm / nhãn UI)',
    description: 'Cụm từ ngắn 2-3 từ trên giao diện',
    taggedHtml: '<span data-i="1">Đặt phòng ngay</span>',
  },
  {
    id: 'S09',
    category: 'Câu dài nhiều mệnh đề',
    description: 'Câu mô tả dài có nhiều dấu phẩy và 3 thẻ nội tuyến',
    taggedHtml:
      'Nếu quý khách có nhu cầu <span data-i="1">nhận phòng sớm hơn 14:00</span> hoặc <span data-i="2">trả phòng muộn sau 12:00 trưa</span>, vui lòng thông báo trước cho <span data-i="3">quầy lễ tân trực 24/7</span> để chúng tôi sắp xếp phòng phù hợp nhất.',
  },
  {
    id: 'S10',
    category: 'Tên riêng (Homestay ABC)',
    description: 'Câu chứa tên thương hiệu Homestay ABC và địa danh phố cổ Hội An',
    taggedHtml: '<span data-i="1">Homestay ABC</span> nằm yên bình ngay cạnh khu vực <span data-i="2">phố cổ Hội An</span>.',
  },
  {
    id: 'S11',
    category: 'Tên riêng + ẩm thực địa phương',
    description: 'Câu chứa tên món ăn đặc sản và địa danh trong thẻ',
    taggedHtml: 'Từ <span data-i="1">Homestay ABC</span>, du khách có thể đi bộ thưởng thức <span data-i="2">cao lầu</span> bên bờ <span data-i="3">sông Hoài</span>.',
  },
  {
    id: 'S12',
    category: 'Ký hiệu tiền tệ, giờ giấc và phần trăm',
    description: 'Câu có số thập phân, phần trăm thuế và khung giờ',
    taggedHtml: 'Phụ thu <span data-i="1">15.5% phí dịch vụ</span> cho các đơn đặt ăn đêm từ <span data-i="2">22:30 đến 05:00 sáng</span>.',
  },
]);

// ============================================================================
// Dữ liệu Thử nghiệm 3: Bộ câu thử ký hiệu {n}...{/n}
// ============================================================================

export interface MarkerSampleSentence {
  id: string;
  patternType: 'SINGLE_PAIR' | 'TWO_PAIRS' | 'NESTED_PAIRS';
  description: string;
  textWithMarkers: string;
}

export const MARKER_SAMPLE_SENTENCES: readonly MarkerSampleSentence[] = Object.freeze([
  {
    id: 'M01',
    patternType: 'SINGLE_PAIR',
    description: 'Một cặp {1}...{/1} bao quanh cụm danh từ',
    textWithMarkers: 'Chào mừng quý khách đến với {1}dịch vụ đặt phòng trực tuyến{/1} của chúng tôi.',
  },
  {
    id: 'M02',
    patternType: 'SINGLE_PAIR',
    description: 'Một cặp {1}...{/1} chứa số thập phân',
    textWithMarkers: 'Khách sạn đạt điểm đánh giá {1}9.4/10{/1} từ hơn một nghìn du khách.',
  },
  {
    id: 'M03',
    patternType: 'TWO_PAIRS',
    description: 'Hai cặp {1}...{/1} và {2}...{/2} trong câu có tên riêng',
    textWithMarkers: '{1}Homestay ABC{/1} nằm gần khu vực {2}phố cổ Hội An{/2}.',
  },
  {
    id: 'M04',
    patternType: 'TWO_PAIRS',
    description: 'Hai cặp {1}...{/1} và {2}...{/2} dễ đảo vị trí khi dịch sang tiếng Hàn/Nhật',
    textWithMarkers: 'Giá phòng đã bao gồm {1}bữa sáng tự chọn{/1} và {2}xe đưa đón sân bay{/2}.',
  },
  {
    id: 'M05',
    patternType: 'NESTED_PAIRS',
    description: 'Hai cặp lồng nhau {1}...{2}...{/2}...{/1}',
    textWithMarkers: 'Chương trình {1}ưu đãi mùa hè giảm ngay {2}30% giá phòng{/2} cho khách đặt sớm{/1} đang diễn ra.',
  },
  {
    id: 'M06',
    patternType: 'NESTED_PAIRS',
    description: 'Cặp lồng nhau kèm một cặp độc lập {3}...{/3}',
    textWithMarkers: 'Nhấn vào {1}nút {2}Xác nhận đặt chỗ{/2} ở góc phải{/1} để nhận {3}mã giảm giá{/3}.',
  },
]);

// ============================================================================
// Dữ liệu Thử nghiệm 4: Bộ câu thử Comprehend DetectDominantLanguage
// ============================================================================

export interface ComprehendSampleInput {
  id: string;
  category: 'LONG_SENTENCE' | 'SHORT_1_3_WORDS' | 'MIXED_VI_EN' | 'PROPER_NOUN_OR_NUMBER';
  description: string;
  text: string;
  expectedLangHint: string;
}

export const COMPREHEND_SAMPLES: readonly ComprehendSampleInput[] = Object.freeze([
  {
    id: 'C01',
    category: 'LONG_SENTENCE',
    description: 'Câu tiếng Việt dài, đầy đủ ngữ cảnh du lịch',
    text: 'Homestay ABC nằm yên bình bên bờ sông Hoài, chỉ cách phố cổ Hội An vài phút đi bộ và phục vụ bữa sáng cao lầu truyền thống mỗi ngày.',
    expectedLangHint: 'vi',
  },
  {
    id: 'C02',
    category: 'LONG_SENTENCE',
    description: 'Câu tiếng Anh dài trên trang giới thiệu',
    text: 'Welcome to our online booking platform where travelers can easily compare room rates and reserve boutique stays across Vietnam.',
    expectedLangHint: 'en',
  },
  {
    id: 'C03',
    category: 'SHORT_1_3_WORDS',
    description: 'Cụm tiếng Việt rất ngắn (2 từ)',
    text: 'Đặt phòng',
    expectedLangHint: 'vi',
  },
  {
    id: 'C04',
    category: 'SHORT_1_3_WORDS',
    description: 'Cụm tiếng Việt ngắn không dấu / ít dấu (1-2 từ)',
    text: 'Trang chủ',
    expectedLangHint: 'vi',
  },
  {
    id: 'C05',
    category: 'MIXED_VI_EN',
    description: 'Câu trộn tiếng Việt và thuật ngữ tiếng Anh (Check-in, Wi-Fi, Voucher)',
    text: 'Quý khách vui lòng check-in online trước để nhận free Wi-Fi tốc độ cao và voucher giảm giá.',
    expectedLangHint: 'vi',
  },
  {
    id: 'C06',
    category: 'MIXED_VI_EN',
    description: 'Câu trộn tỷ lệ tiếng Anh nhiều hơn tiếng Việt',
    text: 'Flash Sale Weekend: Đặt Deluxe Double Room ngay hôm nay with Free Airport Pickup!',
    expectedLangHint: 'vi/en',
  },
  {
    id: 'C07',
    category: 'PROPER_NOUN_OR_NUMBER',
    description: 'Chuỗi chỉ gồm tên riêng thương hiệu',
    text: 'Homestay ABC',
    expectedLangHint: 'ambiguous',
  },
  {
    id: 'C08',
    category: 'PROPER_NOUN_OR_NUMBER',
    description: 'Chuỗi chỉ gồm số, giá tiền và ký hiệu',
    text: '1.250.000 VND / 24.50 USD (9.4/10)',
    expectedLangHint: 'ambiguous',
  },
]);

// ============================================================================
// Dữ liệu Thử nghiệm 5: Custom Terminology (CSV + Bộ câu thử nghiệm)
// ============================================================================

export const CUSTOM_TERMINOLOGY_NAME = 'translateme-exp-terminology-v1';

/**
 * Danh sách thuật ngữ dùng để tạo tệp CSV UTF-8 nạp vào `ImportTerminology`.
 *  - "Homestay ABC": loại Giữ nguyên (KEEP)
 *  - "phố cổ Hội An", "cao lầu", "sông Hoài": loại Dịch cố định (FIXED_TRANSLATION)
 * Người chạy có thể chỉnh cột `ja` nếu muốn thử phương án katakana/kanji khác.
 */
export const TERMINOLOGY_ENTRIES: readonly TerminologyTerm[] = Object.freeze([
  {
    vi: 'Homestay ABC',
    en: 'Homestay ABC',
    ko: 'Homestay ABC',
    ja: 'Homestay ABC',
    type: 'KEEP',
  },
  {
    vi: 'phố cổ Hội An',
    en: 'Hoi An Ancient Town',
    ko: '호이안 구시가지',
    ja: 'ホイアン旧市街',
    type: 'FIXED_TRANSLATION',
  },
  {
    vi: 'cao lầu',
    en: 'cao lau noodles',
    ko: '까오러우 국수',
    ja: 'カオラウ麺',
    type: 'FIXED_TRANSLATION',
  },
  {
    vi: 'sông Hoài',
    en: 'Hoai River',
    ko: '호아이 강',
    ja: 'ホアイ川',
    type: 'FIXED_TRANSLATION',
  },
]);

export interface TerminologyTestCase {
  id: string;
  caseType: 'STANDARD' | 'INSIDE_HTML_TAG' | 'CASE_VARIANT' | 'SENTENCE_VARIANT';
  description: string;
  sourceText: string;
  /** Các thuật ngữ gốc kỳ vọng được áp dụng theo bảng TERMINOLOGY_ENTRIES */
  expectedTermsByLang: Record<TargetLang, string[]>;
}

export const TERMINOLOGY_TEST_CASES: readonly TerminologyTestCase[] = Object.freeze([
  {
    id: 'T01',
    caseType: 'STANDARD',
    description: 'Câu mẫu chuẩn 1: Homestay ABC + phố cổ Hội An',
    sourceText: 'Homestay ABC nằm gần phố cổ Hội An.',
    expectedTermsByLang: {
      en: ['Homestay ABC', 'Hoi An Ancient Town'],
      ko: ['Homestay ABC', '호이안 구시가지'],
      ja: ['Homestay ABC', 'ホイアン旧市街'],
    },
  },
  {
    id: 'T02',
    caseType: 'STANDARD',
    description: 'Câu mẫu chuẩn 2: sông Hoài',
    sourceText: 'Phòng có ban công nhìn ra sông Hoài.',
    expectedTermsByLang: {
      en: ['Hoai River'],
      ko: ['호아이 강'],
      ja: ['ホアイ川'],
    },
  },
  {
    id: 'T03',
    caseType: 'STANDARD',
    description: 'Câu mẫu chuẩn 3: cao lầu + phố cổ Hội An',
    sourceText: 'Buổi sáng du khách thường ăn cao lầu khi dạo quanh phố cổ Hội An.',
    expectedTermsByLang: {
      en: ['cao lau noodles', 'Hoi An Ancient Town'],
      ko: ['까오러우 국수', '호이안 구시가지'],
      ja: ['カオラウ麺', 'ホイアン旧市街'],
    },
  },
  {
    id: 'T04',
    caseType: 'INSIDE_HTML_TAG',
    description: 'Thuật ngữ nằm bên trong thẻ <span data-i="k">',
    sourceText: 'Từ <span data-i="1">Homestay ABC</span> chỉ mất 5 phút đi bộ ra <span data-i="2">sông Hoài</span>.',
    expectedTermsByLang: {
      en: ['Homestay ABC', 'Hoai River'],
      ko: ['Homestay ABC', '호아이 강'],
      ja: ['Homestay ABC', 'ホアイ川'],
    },
  },
  {
    id: 'T05',
    caseType: 'CASE_VARIANT',
    description: 'Khác kiểu viết hoa/thường: "Phố Cổ Hội An" và "Cao Lầu" viết hoa chữ cái đầu',
    sourceText: 'Đặc sản Cao Lầu ở Phố Cổ Hội An rất nổi tiếng với du khách quốc tế.',
    expectedTermsByLang: {
      en: ['cao lau noodles', 'Hoi An Ancient Town'],
      ko: ['까오러우 국수', '호이안 구시가지'],
      ja: ['カオラウ麺', 'ホイアン旧市街'],
    },
  },
  {
    id: 'T06',
    caseType: 'SENTENCE_VARIANT',
    description: 'Biến thể câu có từ xen giữa / rút gọn ("khu phố cổ của Hội An", "dòng sông Hoài thơ mộng")',
    sourceText: 'Du khách tại homestay abc rất thích ngắm dòng sông Hoài thơ mộng và khu phố cổ của Hội An.',
    expectedTermsByLang: {
      en: ['Homestay ABC', 'Hoai River', 'Hoi An Ancient Town'],
      ko: ['Homestay ABC', '호아이 강', '호이안 구시가지'],
      ja: ['Homestay ABC', 'ホアイ川', 'ホイアン旧市街'],
    },
  },
]);
