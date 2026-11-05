# Bộ phân tích tệp cho dịch hàng loạt (F10, Task 4.4)

Mã nguồn: `libs/common/parsers.ts`. Giao diện theo Bảng 2.11 và mục 2.6.6 của báo cáo.

```ts
import { parse, rebuild, formatFromFileName, translatedFileName } from '../../libs/common/parsers.js';

const format = formatFromFileName(fileName);           // 'TXT' | 'HTML' | 'DOCX' | null
const { blocks, skeleton, warnings } = parse(format!, bytes); // blocks: Sentence[] {id, text}
// blocks đi chung đường với F2: chunkByBytes (≤ 10.000 byte) -> TM -> translateSentences
const out = rebuild(skeleton, translations, { targetLang: 'en' }); // translations[id], thiếu thì giữ câu gốc
// tên tệp kết quả: translatedFileName('gioi-thieu.txt', 'en') = 'gioi-thieu.en.txt'
```

| Mục | Cách làm |
| :--- | :--- |
| `blocks` | Câu cần dịch theo thứ tự, dạng ký hiệu `{n}…{/n}` như F2, nên dùng chung TM và hash với proxy. `id` là vị trí trong `translations`. |
| `skeleton` | Chỉ gồm dữ liệu JSON, để state machine BATCH (4.7) ghi ra S3 giữa các bước rồi đọc lại khi ghép. |
| Thiếu bản dịch | `translations[id]` thiếu hoặc rỗng thì giữ câu gốc. `rebuildDetailed` trả thêm `stats` (`translated`, `keptSource`, `tagFallback`). |
| Lỗi | `UnsupportedFormat` (định dạng không hỗ trợ hoặc chưa cắm vào); `CorruptFile` với `reason`: `NOT_UTF8`, `TOO_LARGE` (mặc định > 10 MB), `INVALID_SKELETON`. JOB nên chuyển FAILED kèm `reason`. |
| `warnings` | `{code, where, count, message}`; TXT và HTML không sinh cảnh báo, DOCX dùng mã của Bảng 2.17. |

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

## Cắm DOCX vào (4.9 – TV4)

Cài đặt `FormatParser` (`parse(bytes, opts)` và `rebuild(skeleton, translations, opts)`), skeleton có `v`, `format: 'DOCX'` và chỉ gồm dữ liệu JSON, rồi thêm `FORMAT_PARSERS.DOCX = docxParser`. Trước khi cắm vào, `parse('DOCX', …)` ném `UnsupportedFormat`.
