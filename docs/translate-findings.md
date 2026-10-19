# Báo Cáo Thực Nghiệm AWS Translate & Amazon Comprehend (Nhiệm Vụ 1.12)

> **Trạng thái:** Đã chạy thực nghiệm trên AWS CloudShell. Amazon Translate khả dụng trên tài khoản dùng để chạy.  
> **Lưu ý:** Lần nạp Custom Terminology ban đầu thất bại. Sau đó, terminology được nạp thành công; tuy nhiên, lệnh truy vấn trạng thái trả về `null`, nên trạng thái chưa được xác minh độc lập. Một lần dịch kiểm tra đã cho đầu ra phù hợp với thuật ngữ mong muốn.

## (1) Môi trường thực nghiệm

| Thông số | Giá trị |
| :--- | :--- |
| **AWS Region** | `ap-southeast-1` |
| **Môi trường chạy** | AWS CloudShell |
| **Gói tài khoản AWS** | Không có thông tin trong kết quả |
| **Ngày giờ kiểm tra** | Không có thông tin trong kết quả |
| **Trạng thái TranslateText** | Khả dụng |

## (2) Phương pháp

1. **Thử nghiệm 1:** Dịch 12 câu có thẻ `<span data-i="k">` sang tiếng Anh, Hàn và Nhật; kiểm tra thẻ, thứ tự `data-i` và khoảng trắng.
2. **Thử nghiệm 2:** Đếm Unicode code point của 12 câu có và không có thẻ. Đây là số liệu tính offline, không phải số đo CloudWatch.
3. **Thử nghiệm 3:** Dịch 6 câu có marker `{n}...{/n}` và kiểm tra marker.
4. **Thử nghiệm 4:** Gọi Amazon Comprehend `DetectDominantLanguage` trên 8 mẫu; đối chiếu ngưỡng `0.70`.
5. **Thử nghiệm 5:** Lần nạp Custom Terminology đầu tiên thất bại. Sau đó, nạp lại thành công và thực hiện một lần dịch kiểm tra với terminology. Lệnh truy vấn trạng thái trả về `null`; chưa có kết quả batch mới để xác nhận tỷ lệ áp dụng trên nhiều mẫu.

## (3) Kết quả theo cặp ngôn ngữ

### 3.1. Thẻ `<span data-i="k">` — Thử nghiệm 1

| Cặp ngôn ngữ | Tổng số câu | Giữ nguyên thẻ | Tỷ lệ giữ nguyên | Đảo thứ tự `data-i` | Thay đổi khoảng trắng |
| :---: | :---: | :---: | :---: | :---: | :---: |
| `vi -> en` | 12 | 12 | 100.00% | 0 | 0 |
| `vi -> ko` | 12 | 7 | 58.33% | 5 | 0 |
| `vi -> ja` | 12 | 11 | 91.67% | 1 | 0 |

**Nhận xét:** Kết quả tốt nhất là `vi -> en`. Với tiếng Hàn, 5/12 câu có thứ tự thẻ bị đảo; với tiếng Nhật là 1/12. Không có thay đổi khoảng trắng được ghi nhận. Không nên giả định thứ tự thẻ luôn được giữ nguyên, đặc biệt khi dịch sang tiếng Hàn.

### 3.2. Cách tính ký tự — Thử nghiệm 2

Các số liệu dưới đây được tính offline bằng Unicode code point, không phải số liệu CloudWatch:

| Mã câu | Loại câu | Không thẻ | Có thẻ | Tăng thêm | Tỷ lệ tăng |
| :---: | :--- | :---: | :---: | :---: | :---: |
| `S01` | Câu thường (1 thẻ đơn) | 71 | 95 | +24 | +33.80% |
| `S02` | Chữ đậm | 69 | 93 | +24 | +34.78% |
| `S03` | Liên kết | 79 | 103 | +24 | +30.38% |
| `S04` | Nhiều thẻ liên tiếp (3 thẻ) | 83 | 155 | +72 | +86.75% |
| `S05` | Thẻ lồng nhau (2 cấp) | 95 | 143 | +48 | +50.53% |
| `S06` | Thẻ lồng nhau và thẻ rời | 69 | 141 | +72 | +104.35% |
| `S07` | Số và dấu thập phân | 79 | 127 | +48 | +60.76% |
| `S08` | Câu ngắn / nhãn UI | 14 | 38 | +24 | +171.43% |
| `S09` | Câu dài nhiều mệnh đề | 177 | 249 | +72 | +40.68% |
| `S10` | Tên riêng `Homestay ABC` | 58 | 106 | +48 | +82.76% |
| `S11` | Tên riêng và ẩm thực địa phương | 76 | 148 | +72 | +94.74% |
| `S12` | Tiền tệ, giờ giấc và phần trăm | 73 | 121 | +48 | +65.75% |
| **Tổng** | — | **943** | **1519** | **+576** | **+61.08%** |

- Tổng ký tự dự kiến cho 12 câu dịch sang 3 ngôn ngữ: **4.557** khi có thẻ, so với **2.829** khi không có thẻ.
- Chưa có số đo CloudWatch để đối chiếu. AWS Translate `CharacterCount` cần được kiểm tra riêng sau khi metric cập nhật.

### 3.3. Marker `{n}...{/n}` — Thử nghiệm 3

| Cặp ngôn ngữ | Tổng số câu | Marker sống sót | Tỷ lệ sống sót |
| :---: | :---: | :---: | :---: |
| `vi -> en` | 6 | 5 | 83.33% |
| `vi -> ko` | 6 | 3 | 50.00% |
| `vi -> ja` | 6 | 4 | 66.67% |

**Nhận xét:** Marker văn bản thuần không đáng tin cậy bằng HTML span trong kết quả này. Một đầu ra tiếng Anh (`M01`) mất marker mở `{1}`; các đầu ra khác có hiện tượng chèn khoảng trắng quanh nội dung marker. Nên giữ bước hậu kiểm marker trước khi dựng lại HTML.

### 3.4. Custom Terminology — Thử nghiệm 5

Lần nạp đầu tiên báo lỗi `terminologyData` null. Sau đó, lệnh nạp lại hoàn tất thành công:

| Thuộc tính | Kết quả |
| :--- | :--- |
| Tên | `translateme_custom_glossary` |
| Region | `ap-southeast-1` |
| Định dạng | CSV |
| Ngôn ngữ nguồn | `vi` |
| Ngôn ngữ đích | `en`, `ko`, `ja` |
| Số thuật ngữ | 12 |
| Kích thước | 261 bytes |
| ARN | `arn:aws:translate:ap-southeast-1:941490574112:terminology/translateme_custom_glossary/LATEST` |

Lệnh `get-terminology` truy vấn `TerminologyProperties.Status` trả về `null`. Vì vậy, trạng thái terminology chưa được xác minh qua truy vấn này; kết quả `null` không đủ để kết luận terminology không hoạt động.

**Lần dịch kiểm tra:**

- Văn bản nguồn: `Homestay ABC nằm gần phố cổ Hội An.`
- Đầu ra: `Homestay ABC is located near Hoi An Ancient Town.`

Đầu ra phù hợp với cách viết thuật ngữ mong muốn. Đây là một mẫu kiểm tra đơn lẻ, chưa phải đối chứng đủ để xác định chắc chắn terminology đã tác động đến bản dịch.

Các tỷ lệ batch đã ghi nhận trước đó (`vi -> en`: 4/6, `vi -> ko`: 1/6, `vi -> ja`: 1/6) không được xem là kết quả xác nhận sau lần nạp thành công. Cần chạy lại batch trên cả ba ngôn ngữ và so sánh với bản dịch không dùng terminology trước khi kết luận về hiệu quả.

## (4) Amazon Comprehend — `DetectDominantLanguage`

Ngưỡng đánh giá: **`0.70`**.

| Mã | Phân loại | Ngôn ngữ nhận diện | Score | Đánh giá |
| :---: | :--- | :---: | :---: | :--- |
| `C01` | Câu dài tiếng Việt | `vi` | 1.0000 | Đạt |
| `C02` | Câu dài tiếng Anh | `en` | 0.9873 | Đạt |
| `C03` | Cụm ngắn `Đặt phòng` | `vi` | 1.0000 | Đạt |
| `C04` | Cụm ngắn `Trang chủ` | `vi` | 0.9821 | Đạt |
| `C05` | Câu trộn Việt–Anh | `vi` | 1.0000 | Đạt |
| `C06` | Câu trộn Anh–Việt | `en` | 0.7491 | Đạt, gần ngưỡng |
| `C07` | Tên riêng `Homestay ABC` | `en` | 0.3818 | Dưới ngưỡng |
| `C08` | Chuỗi số và tiền tệ | `de` | 0.2671 | Dưới ngưỡng |

**Nhận xét:** Hai mẫu chỉ gồm tên riêng hoặc số có điểm tin cậy thấp; `C08` còn bị nhận diện thành tiếng Đức. Dù các cụm ngắn `C03` và `C04` có điểm cao, vẫn nên dùng ngôn ngữ mặc định của Tenant cho chuỗi ngắn theo chính sách sản phẩm, thay vì phụ thuộc hoàn toàn vào nhận diện.

## (5) Trả lời Chốt chặn 1 (Gate 1)

1. **Amazon Translate có dùng được trên tài khoản AWS đã chạy thử nghiệm không?**  
   **Có — trạng thái Gate 1 là `KHẢ DỤNG`.**

2. **`TranslateText` có giữ nguyên thẻ span không?**  
   **Không đồng đều giữa các ngôn ngữ:** `vi -> en` đạt 12/12; `vi -> ko` đạt 7/12; `vi -> ja` đạt 11/12. Có đảo thứ tự thẻ ở tiếng Hàn và tiếng Nhật.

## (6) Khuyến nghị cho F2 và F4

1. **F2 — bảo toàn cấu trúc:** Có thể tiếp tục dùng `<span data-i="k">` làm cơ chế chính, nhưng phải kiểm tra cấu trúc và thứ tự thẻ sau dịch. Thử nghiệm này cho thấy không thể coi thẻ luôn được bảo toàn ở mọi ngôn ngữ.
2. **F2 — fallback an toàn:** Nếu hậu kiểm phát hiện thẻ thiếu, hỏng hoặc bị đảo không chấp nhận được, không dựng lại HTML từ đầu ra lỗi. Dùng fallback đã kiểm thử, chẳng hạn dịch phần văn bản an toàn và giữ nguyên cấu trúc DOM gốc.
3. **Chi phí:** Thẻ làm tăng trung bình **61.08%** số code point trong bộ mẫu. Chỉ bọc các cụm nội tuyến cần bảo toàn; tránh bọc thẻ cho văn bản thuần hoặc cả câu nếu không cần.
4. **Marker văn bản thuần:** Không dùng `{n}...{/n}` nếu chưa có bước kiểm tra và xử lý trường hợp mất marker, sai cặp hoặc chèn khoảng trắng.
5. **Comprehend:** Chỉ tin kết quả khi `Score >= 0.70` và văn bản đủ dài (khuyến nghị tối thiểu 20 ký tự). Với chuỗi ngắn, trộn ngôn ngữ, số hoặc tên riêng, ưu tiên ngôn ngữ nguồn mặc định của Tenant.
6. **F4 — terminology:** Lần nạp lại đã thành công và trả về 12 thuật ngữ. Một lần dịch kiểm tra cho đầu ra phù hợp, nhưng truy vấn trạng thái trả về `null` và chưa có batch đối chứng mới. Chạy lại toàn bộ mẫu có/không có terminology trên từng ngôn ngữ; xác minh kết quả trước khi dùng cờ `applied` hoặc gắn `needsReview = true`.

## (7) Kết luận

- AWS Translate khả dụng trên tài khoản thực hiện thử nghiệm.
- Thẻ HTML span hoạt động tốt nhất trong mẫu tiếng Anh, nhưng tỷ lệ giữ nguyên giảm ở tiếng Hàn và Nhật.
- Marker `{n}...{/n}` có tỷ lệ sống sót thấp hơn và cần hậu kiểm nghiêm ngặt.
- Comprehend nhận diện tốt phần lớn câu dài, nhưng không đáng tin với tên riêng và chuỗi số.
- Custom Terminology đã được nạp lại thành công; một mẫu kiểm tra cho kết quả phù hợp, nhưng cần batch đối chứng và xác minh trạng thái để đánh giá hiệu quả chắc chắn.