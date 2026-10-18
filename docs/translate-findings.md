# Báo Cáo Thực Nghiệm AWS Translate & Amazon Comprehend (Nhiệm Vụ 1.12)

> **Trạng thái báo cáo:** CHƯA CHẠY TRÊN AWS THẬT (Khung báo cáo tự sinh — số liệu Thử nghiệm 2 đã tính sẵn offline; các mục gọi API sẽ tự điền khi chạy lệnh trên môi trường có AWS credentials)

## (1) Môi trường thực nghiệm

| Thông số | Giá trị |
| :--- | :--- |
| **AWS Region** | `ap-southeast-1` |
| **Gói tài khoản AWS** | Chưa khai báo (chạy ở chế độ --template) |
| **Ngày giờ kiểm tra** | `2026-10-18T09:39:46.558Z` |
| **Trạng thái kiểm tra TranslateText ban đầu** | Chưa khả dụng (`TEMPLATE_MODE`: Báo cáo được tạo ở chế độ mẫu (--template), chưa gọi AWS API thật.) |

## (2) Phương pháp và Bộ câu mẫu

1. **Thử nghiệm 1 (Giữ thẻ `<span data-i="k">`):** Dịch 12 câu tiếng Việt (câu thường, chữ đậm, liên kết, 3 thẻ liên tiếp, thẻ lồng nhau 2 cấp, số thập phân `9.4/10`, câu ngắn UI, câu dài nhiều mệnh đề, tên riêng `Homestay ABC`, `phố cổ Hội An`, `cao lầu`, `sông Hoài`) sang 3 ngôn ngữ đích `vi -> en`, `vi -> ko`, `vi -> ja`. Kiểm tra tự động bằng hàm `inspectSpanTags()`.
2. **Thử nghiệm 2 (Cách tính ký tự):** Đếm Unicode code point (`Array.from(text).length`) của cùng 12 câu khi **không có thẻ** và **có thẻ `<span data-i="k">`** để tính tỷ lệ tăng ký tự tính phí, đối chiếu với CloudWatch metric `CharacterCount`.
3. **Thử nghiệm 3 (Ký hiệu `{n}...{/n}`):** Dịch 6 câu mẫu có 1 cặp, 2 cặp và cặp lồng nhau `{1}...{2}...{/2}...{/1}` qua 3 cặp ngôn ngữ; kiểm tra bằng hàm `check_markers()` để phát hiện mất marker, thừa marker hoặc biến dạng (`{ 1 }`, `｛1｝`).
4. **Thử nghiệm 4 (`Comprehend DetectDominantLanguage`):** Thử 8 mẫu đầu vào (câu dài, cụm ngắn 1–3 từ, câu trộn Việt–Anh, chuỗi chỉ gồm tên riêng hoặc số) và đánh dấu các mẫu có điểm tin cậy dưới ngưỡng `0.70`.
5. **Thử nghiệm 5 (`Custom Terminology`):** Nạp tệp CSV UTF-8 (`vi,en,ko,ja`) bằng `ImportTerminology` (`MergeStrategy = OVERWRITE`), sau đó dịch đối chứng cùng bộ 6 câu (chuẩn, nằm trong thẻ `<span>`, viết hoa khác, biến thể câu) khi **không gắn** và **có gắn** Terminology.

## (3) Bảng kết quả theo từng cặp ngôn ngữ (`vi->en`, `vi->ko`, `vi->ja`)

### 3.1. Tỷ lệ giữ nguyên thẻ `<span data-i="k">` (Thử nghiệm 1)

| Cặp ngôn ngữ | Tổng số câu | Số câu giữ nguyên thẻ | Tỷ lệ giữ nguyên (%) | Số câu đảo thứ tự `data-i` | Số câu thay đổi khoảng trắng |
| :---: | :---: | :---: | :---: | :---: | :---: |
| `vi -> en` | 12 | *chưa chạy* | *chưa chạy* | *chưa chạy* | *chưa chạy* |
| `vi -> ko` | 12 | *chưa chạy* | *chưa chạy* | *chưa chạy* | *chưa chạy* |
| `vi -> ja` | 12 | *chưa chạy* | *chưa chạy* | *chưa chạy* | *chưa chạy* |

### 3.2. Cách tính ký tự và tỷ lệ tăng do thẻ `<span data-i="k">` (Thử nghiệm 2)

| Mã câu | Loại câu | Ký tự KHÔNG thẻ (code point) | Ký tự CÓ thẻ (code point) | Ký tự tăng thêm | Tỷ lệ tăng do thẻ (%) |
| :---: | :--- | :---: | :---: | :---: | :---: |
| `S01` | Câu thường (1 thẻ đơn) | 71 | 95 | +24 | **+33.8%** |
| `S02` | Chữ đậm (strong/b) | 69 | 93 | +24 | **+34.78%** |
| `S03` | Liên kết (anchor link) | 79 | 103 | +24 | **+30.38%** |
| `S04` | Nhiều thẻ liên tiếp (3 thẻ) | 83 | 155 | +72 | **+86.75%** |
| `S05` | Thẻ lồng nhau (2 cấp) | 95 | 143 | +48 | **+50.53%** |
| `S06` | Thẻ lồng nhau + thẻ rời | 69 | 141 | +72 | **+104.35%** |
| `S07` | Số và dấu chấm thập phân | 79 | 127 | +48 | **+60.76%** |
| `S08` | Câu rất ngắn (nút bấm / nhãn UI) | 14 | 38 | +24 | **+171.43%** |
| `S09` | Câu dài nhiều mệnh đề | 177 | 249 | +72 | **+40.68%** |
| `S10` | Tên riêng (Homestay ABC) | 58 | 106 | +48 | **+82.76%** |
| `S11` | Tên riêng + ẩm thực địa phương | 76 | 148 | +72 | **+94.74%** |
| `S12` | Ký hiệu tiền tệ, giờ giấc và phần trăm | 73 | 121 | +48 | **+65.75%** |
| **TỔNG (12 câu)** | — | **943** | **1519** | **+576** | **+61.08%** |

- **Tổng ký tự dự kiến bị tính phí khi dịch 12 câu sang cả 3 ngôn ngữ (`en, ko, ja`):** `4557` ký tự (nếu không có thẻ là `2829` ký tự).
- **Ghi chú đối chiếu CloudWatch:** LƯU Ý ĐỐI CHIẾU CLOUDWATCH: Amazon Translate tính phí theo mọi Unicode code point gửi trong trường Text (bao gồm cả các ký tự của thẻ <span data-i="k">...</span>). Sau khi chạy Thử nghiệm 1, người chạy mở CloudWatch -> Metrics -> AWS/Translate -> CharacterCount (Sum, Period 1m/5m) để đối chiếu với con số dự kiến. Metric trên CloudWatch có thể trễ từ 3 đến 15 phút.

### 3.3. Tỷ lệ sống sót của ký hiệu `{n}...{/n}` (Thử nghiệm 3)

| Cặp ngôn ngữ | Tổng số câu thử | Số câu sống sót nguyên vẹn | Tỷ lệ sống sót (%) |
| :---: | :---: | :---: | :---: |
| `vi -> en` | 6 | *chưa chạy* | *chưa chạy* |
| `vi -> ko` | 6 | *chưa chạy* | *chưa chạy* |
| `vi -> ja` | 6 | *chưa chạy* | *chưa chạy* |

### 3.4. Kết quả Custom Terminology (Thử nghiệm 5)

**Nội dung tệp CSV UTF-8 nạp vào `ImportTerminology`:**
```csv
vi,en,ko,ja
Homestay ABC,Homestay ABC,Homestay ABC,Homestay ABC
phố cổ Hội An,Hoi An Ancient Town,호이안 구시가지,ホイアン旧市街
cao lầu,cao lau noodles,까오러우 국수,カオラウ麺
sông Hoài,Hoai River,호아이 강,ホアイ川
```

- **Trạng thái `ImportTerminology`:** *chưa chạy trên AWS thật*

| Cặp ngôn ngữ | Tổng số ca thử | Số ca áp dụng đúng | Số ca KHÔNG áp dụng đủ (`"Cần xem lại"`) | Ghi chú cơ chế khớp của Amazon Translate |
| :---: | :---: | :---: | :---: | :--- |
| `vi -> en` | 6 | *chưa chạy* | *chưa chạy* | Custom Terminology chỉ khớp chính xác chuỗi ký tự và phân biệt hoa/thường (case-sensitive) -> ca `T05` (khác hoa/thường) và `T06` (biến thể từ xen giữa) cần module hậu kiểm F4 gắn cờ **"Cần xem lại"** |
| `vi -> ko` | 6 | *chưa chạy* | *chưa chạy* | Custom Terminology chỉ khớp chính xác chuỗi ký tự và phân biệt hoa/thường (case-sensitive) -> ca `T05` (khác hoa/thường) và `T06` (biến thể từ xen giữa) cần module hậu kiểm F4 gắn cờ **"Cần xem lại"** |
| `vi -> ja` | 6 | *chưa chạy* | *chưa chạy* | Custom Terminology chỉ khớp chính xác chuỗi ký tự và phân biệt hoa/thường (case-sensitive) -> ca `T05` (khác hoa/thường) và `T06` (biến thể từ xen giữa) cần module hậu kiểm F4 gắn cờ **"Cần xem lại"** |

## (4) Kết quả Amazon Comprehend (`DetectDominantLanguage`) và Ngưỡng đề xuất

- **Ngưỡng độ tin cậy đề xuất:** **`0.70`** (mọi kết quả có `Score < 0.70` hoặc chuỗi quá ngắn/chỉ gồm số & tên riêng được đánh dấu dưới ngưỡng và giữ nguyên ngôn ngữ cấu hình mặc định của website).

| Mã mẫu | Phân loại | Chuỗi đầu vào | Ngôn ngữ nhận diện | Điểm tin cậy (`Score`) | Đánh giá so với ngưỡng `0.70` |
| :---: | :--- | :--- | :---: | :---: | :--- |
| `C01` | `LONG_SENTENCE` | Homestay ABC nằm yên bình bên bờ sông Hoài, chỉ cách phố cổ Hội An vài phút đi bộ và phục vụ bữa sáng cao lầu truyền thống mỗi ngày. | *chưa chạy* | *chưa chạy* | *chưa chạy* |
| `C02` | `LONG_SENTENCE` | Welcome to our online booking platform where travelers can easily compare room rates and reserve boutique stays across Vietnam. | *chưa chạy* | *chưa chạy* | *chưa chạy* |
| `C03` | `SHORT_1_3_WORDS` | Đặt phòng | *chưa chạy* | *chưa chạy* | *chưa chạy* |
| `C04` | `SHORT_1_3_WORDS` | Trang chủ | *chưa chạy* | *chưa chạy* | *chưa chạy* |
| `C05` | `MIXED_VI_EN` | Quý khách vui lòng check-in online trước để nhận free Wi-Fi tốc độ cao và voucher giảm giá. | *chưa chạy* | *chưa chạy* | *chưa chạy* |
| `C06` | `MIXED_VI_EN` | Flash Sale Weekend: Đặt Deluxe Double Room ngay hôm nay with Free Airport Pickup! | *chưa chạy* | *chưa chạy* | *chưa chạy* |
| `C07` | `PROPER_NOUN_OR_NUMBER` | Homestay ABC | *chưa chạy* | *chưa chạy* | *chưa chạy* |
| `C08` | `PROPER_NOUN_OR_NUMBER` | 1.250.000 VND / 24.50 USD (9.4/10) | *chưa chạy* | *chưa chạy* | *chưa chạy* |

## (5) Trả lời hai câu hỏi Chốt chặn 1 (Gate 1)

1. **Amazon Translate có dùng được trên gói tài khoản AWS hiện tại không?**  
   - **Trả lời:** **`CHƯA CHẠY`** *(chỉ điền sau khi chạy script với thông tin xác thực AWS thật; tuyệt đối không tự bịa số liệu)*.
2. **`TranslateText` có giữ nguyên thẻ `<span data-i="k">` ở `vi->en`, `vi->ko`, `vi->ja` không?**  
   - **Trả lời:** **`CHƯA CHẠY`** *(chỉ điền tỷ lệ % thật sau khi chạy `npm run exp:run` trên tài khoản AWS của nhóm)*.

## (6) Khuyến nghị thiết kế cho Module Dịch Proxy (F2) và Hậu kiểm / Glossary (F4)

1. **Lựa chọn giữa thẻ `<span data-i="k">` và ký hiệu `{n}...{/n}` cho F2:**
   - **Khuyến nghị dùng `<span data-i="k">...</span>` (hoặc thẻ HTML nội tuyến)** làm cơ chế chính khi gọi `TranslateText` vì Amazon Translate hỗ trợ dịch tài liệu HTML nguyên bản: engine hiểu ranh giới thẻ đóng/mở và tự động di chuyển toàn bộ cụm `<span data-i="k">...</span>` theo trật tự ngữ pháp SOV của tiếng Hàn (`ko`) và tiếng Nhật (`ja`).
   - Ngược lại, ký hiệu văn bản thuần `{1}...{/1}` dễ bị bộ dịch máy NMT chèn thêm khoảng trắng (`{ 1 }`), đổi sang ngoặc fullwidth (`｛1｝`) hoặc làm lệch cặp đóng/mở khi câu có cấu trúc đảo ngữ phức tạp. Tuy nhiên, vẫn giữ hàm `check_markers` / `inspectSpanTags` làm lớp hậu kiểm trước khi `rebuild()` HTML.
2. **Chiến lược giảm chi phí ký tự & chia nhỏ khối khi thẻ bị xáo trộn:**
   - Qua Thử nghiệm 2, thẻ `<span data-i="k">...</span>` làm tăng trung bình **+61.08%** số ký tự tính phí (mỗi cặp thẻ tốn thêm 23 ký tự code point). Do đó, trong hàm `extract()`: **chỉ bọc `<span data-i="k">` quanh các thẻ nội tuyến thực sự nằm giữa câu**, tuyệt đối không bọc thẻ cho câu thuần văn bản hoặc thẻ bao toàn bộ câu.
   - Nếu sau khi dịch một câu phức tạp mà `inspectSpanTags()` phát hiện `tagsIntact === false` (mất hoặc hỏng thẻ): F2 thực hiện **fallback an toàn** bằng cách dịch lại văn bản thuần (đã strip thẻ) của câu đó để trang web không bao giờ bị vỡ cấu trúc DOM.
3. **Ngưỡng nhận diện ngôn ngữ nguồn (Amazon Comprehend):**
   - Áp dụng ngưỡng **`Score >= 0.70`** và độ dài văn bản tối thiểu **>= 20 ký tự** trước khi tin vào kết quả `DetectDominantLanguage`. Với các chuỗi ngắn 1–3 từ (nút bấm, menu), chuỗi trộn Việt–Anh hoặc chỉ gồm số/tên riêng, dùng trực tiếp ngôn ngữ nguồn mặc định đã khai báo trong cấu hình Tenant.
4. **Cơ chế hậu kiểm thuật ngữ (F4 - Custom Terminology & "Cần xem lại"):**
   - Vì `Custom Terminology` của Amazon Translate so khớp chính xác theo chuỗi ký tự và phân biệt chữ hoa/thường (`case-sensitive`), các câu có thuật ngữ viết hoa khác chuẩn hoặc bị biến thể từ vựng sẽ không được áp dụng tự động. Module F4 cần chạy hàm `checkTerminologyApplied()` sau khi dịch: nếu câu gốc có chứa thuật ngữ trong Glossary (so khớp không phân biệt hoa/thường) nhưng bản dịch thiếu thuật ngữ đích tương ứng -> gắn cờ **`needsReview = true` ("Cần xem lại")** cho Reviewer kiểm duyệt trên Console.

## (7) Phụ lục: Mẫu đầu vào và đầu ra thô

### Mẫu đầu vào chuẩn (Thử nghiệm 1, 3, 5) — Đầu ra sẽ được ghi tự động khi chạy trên AWS
```json
{
  "note": "Chưa có đầu ra từ AWS Translate. Chạy `npm run exp:run` với AWS credentials để ghi đầu ra thực tế.",
  "sampleSpanInputs": [
    {
      "id": "S01",
      "category": "Câu thường (1 thẻ đơn)",
      "description": "Câu giới thiệu dịch vụ có 1 cụm nhấn mạnh",
      "taggedHtml": "Chào mừng quý khách đến với <span data-i=\"1\">dịch vụ đặt phòng trực tuyến</span> của chúng tôi."
    },
    {
      "id": "S02",
      "category": "Chữ đậm (strong/b)",
      "description": "Câu thông báo chính sách hoàn tiền có phần chữ đậm",
      "taggedHtml": "Quý khách được <span data-i=\"1\">miễn phí hủy phòng</span> trước 48 giờ so với giờ nhận phòng."
    },
    {
      "id": "S03",
      "category": "Liên kết (anchor link)",
      "description": "Câu hướng dẫn có chứa liên kết nội tuyến",
      "taggedHtml": "Vui lòng xem chi tiết tại <span data-i=\"1\">trang điều khoản sử dụng</span> hoặc liên hệ bộ phận hỗ trợ."
    }
  ],
  "sampleMarkerInputs": [
    {
      "id": "M01",
      "patternType": "SINGLE_PAIR",
      "description": "Một cặp {1}...{/1} bao quanh cụm danh từ",
      "textWithMarkers": "Chào mừng quý khách đến với {1}dịch vụ đặt phòng trực tuyến{/1} của chúng tôi."
    },
    {
      "id": "M02",
      "patternType": "SINGLE_PAIR",
      "description": "Một cặp {1}...{/1} chứa số thập phân",
      "textWithMarkers": "Khách sạn đạt điểm đánh giá {1}9.4/10{/1} từ hơn một nghìn du khách."
    }
  ],
  "sampleTerminologyCases": [
    {
      "id": "T01",
      "caseType": "STANDARD",
      "description": "Câu mẫu chuẩn 1: Homestay ABC + phố cổ Hội An",
      "sourceText": "Homestay ABC nằm gần phố cổ Hội An.",
      "expectedTermsByLang": {
        "en": [
          "Homestay ABC",
          "Hoi An Ancient Town"
        ],
        "ko": [
          "Homestay ABC",
          "호이안 구시가지"
        ],
        "ja": [
          "Homestay ABC",
          "ホイアン旧市街"
        ]
      }
    },
    {
      "id": "T02",
      "caseType": "STANDARD",
      "description": "Câu mẫu chuẩn 2: sông Hoài",
      "sourceText": "Phòng có ban công nhìn ra sông Hoài.",
      "expectedTermsByLang": {
        "en": [
          "Hoai River"
        ],
        "ko": [
          "호아이 강"
        ],
        "ja": [
          "ホアイ川"
        ]
      }
    }
  ]
}
```
