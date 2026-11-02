# Bộ phân tích tệp cho dịch hàng loạt (F10, Task 4.4 & Task 4.9)

Mã nguồn: `libs/common/parsers.ts` và `libs/common/docx.ts`. Giao diện theo Bảng 2.11 và mục 2.6.6 của báo cáo.

```ts
import { parse, rebuild, formatFromFileName, translatedFileName } from '../../libs/common/parsers.js';

const format = formatFromFileName(fileName);           // 'TXT' | 'HTML' | 'DOCX' | null
const { blocks, skeleton, warnings } = parse(format!, bytes); // blocks: Sentence[] {id, text}
// blocks đi chung đường với F2: chunkByBytes (≤ 10.000 byte) -> TM -> translateSentences
const out = rebuild(skeleton, translations, { targetLang: 'en' }); // translations[id], thiếu thì giữ câu gốc
// tên tệp kết quả: translatedFileName('gioi-thieu.docx', 'en') = 'gioi-thieu.en.docx'
```

| Mục | Cách làm |
| :--- | :--- |
| `blocks` | Câu cần dịch theo thứ tự, dạng ký hiệu `{n}…{/n}` như F2, nên dùng chung TM và hash với proxy. `id` là vị trí trong `translations`. |
| `skeleton` | Chỉ gồm dữ liệu JSON, để state machine BATCH (4.7) ghi ra S3 giữa các bước rồi đọc lại khi ghép. |
| Thiếu bản dịch | `translations[id]` thiếu hoặc rỗng thì giữ câu gốc. `rebuildDetailed` trả thêm `stats` (`translated`, `keptSource`, `tagFallback`). |
| Lỗi | `UnsupportedFormat` (định dạng không hỗ trợ); `CorruptFile` với `reason`: `NOT_UTF8`, `TOO_LARGE` (mặc định > 10 MB), `INVALID_SKELETON`, `INVALID_DOCX`, `ZIP_BOMB`, `ZIP_TOO_MANY_ENTRIES`, `XXE_DETECTED`, `REBUILD_VERIFICATION_FAILED`. JOB chuyển FAILED kèm `reason`. |
| `warnings` | `{code, where, count, message}`; TXT và HTML không sinh cảnh báo, DOCX dùng mã của Bảng 2.17 (`UNSUPPORTED_PART`, `UNSUPPORTED_ELEMENT`, `TRACKED_CHANGES`). |

## TXT

- UTF-8, chấp nhận BOM. Tách theo dòng, giữ nguyên dòng trống và kiểu xuống dòng (`\n`, `\r\n`, `\r`); mỗi dòng tách câu bằng segmenter của 1.5.
- Câu không có chữ (chỉ số, ký hiệu) giữ nguyên, không gửi dịch nên không tốn ký tự.
- Dấu `{` `}` có thật trong văn bản được thoát thành `{{` `}}` trong `blocks` (cùng quy ước với F2), rồi trả lại nguyên dạng khi ráp.
- `rebuild(parse(f).skeleton, [])` trùng từng byte với tệp gốc (có kiểm thử thuộc tính với 300 chuỗi ngẫu nhiên).
- Một dòng rất dài có thể là một câu dài hơn 10.000 byte; translator đánh `SENTENCE_TOO_LARGE`. Khi chia khối ở 4.7 cần xử lý câu này (ví dụ cắt bằng `chunkByBytes` của 1.8) hoặc báo trong `warnings`.

## HTML

- Dùng lại `extract` (bước 2 của F2) và `rebuildDocument` (mới trong `rebuild.ts`): không viết lại liên kết, không chèn canonical, hreflang hay nút chọn ngôn ngữ; chỉ đặt `<html lang>` (và `dir="rtl"` với ar, he, fa, ur) theo ngôn ngữ đích.
- Tệp phải là UTF-8. Không dịch script, style, pre, code…, giống F2.
- `rebuild(parse(f).skeleton, [])` cho cùng cây DOM với tệp gốc (so bằng parse5 `serialize`, vì parse5 chuẩn hóa cách viết HTML).

## DOCX (Task 4.9 – TV4)

- **Mở an toàn (chống ZIP bomb & XXE):**
  - Đọc ZIP thuần bằng `node:zlib` trong bộ nhớ; kiểm tra số mục `<= 2.000` (`DOCX_MAX_ZIP_ENTRIES`), tổng kích thước sau giải nén `<= 50 MB` (`DOCX_MAX_UNCOMPRESSED_BYTES`) và tỷ lệ nén `<= 100:1` (`DOCX_MAX_COMPRESSION_RATIO`) cả trên Central Directory lẫn trong lúc giải nén (`maxOutputLength`).
  - Từ chối mọi khai báo `<!DOCTYPE` hoặc `<!ENTITY` trong các phần XML/`.rels` (`CorruptFile('XXE_DETECTED')`).
- **Duyệt thân tài liệu, gộp run & tạo ký hiệu `{n}`:**
  - Duyệt đệ quy `w:body` qua các đoạn `w:p` và bảng `w:tbl -> w:tr -> w:tc -> w:p` (kể cả bảng lồng nhau).
  - Gộp các `w:r` liền kề có cùng `w:rPr` (và cùng `w:hyperlink`) thành một span; bảo toàn `w:tab` (`\t`) và `w:br` (`\n`).
  - Chọn định dạng của span có nhiều ký tự nhất trong đoạn làm định dạng nền (`baseRPrXml`); chỉ bọc `{k}...{/k}` quanh các span khác định dạng nền hoặc liên kết `w:hyperlink`.
- **Dựng lại, phông Đông Á & kiểm tra sau dựng:**
  - Tạo các `w:r` mới với `xml:space="preserve"`, sao chép nguyên vẹn từng byte mọi phần khác của gói ZIP (kiểu, ảnh, đầu trang, chân trang…).
  - Khi `targetLang` là `ko`, `ja` hoặc `zh` (`zh-TW`), tự động bổ sung `w:eastAsia` vào `w:rFonts` và `w:lang` nếu run chưa có.
  - Kiểm tra số lượng `w:p` và `w:tc` sau khi dựng bằng hệt tệp gốc và tệp mới mở lại được bằng `parse('DOCX', ...)`.
