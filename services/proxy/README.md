# Lambda proxy F2 (C2)

Nhiệm vụ 1.6 và 2.4 (TV2). Chạy các bước 1, 2, 3–4 (Translation Memory), 5 (rút gọn), 6, 8 của F2.

Luồng xử lý: tra website → tải trang gốc bằng `safe_fetch` → `extract()` → băm câu → `getTM()` → `translateSentences()` cho câu trượt → `putMachineTM()` → `rebuildDetailed()` → trả về CloudFront.

## Build và test

```bash
# libs/common phải được cài trước để tsc tìm thấy kiểu của parse5
cd libs/common && npm ci && npm test
cd ../../services/proxy && npm ci && npm test
```

## Thông tin cho IaC (TV1)

| Mục | Giá trị |
| :--- | :--- |
| Handler | `services/proxy/dist/services/proxy/handler.handler` |
| Runtime | `nodejs20.x` |
| Timeout | 25 giây: lớn hơn ngân sách nội bộ 20 giây, nhỏ hơn mốc 30 giây của CloudFront (Bảng 2.6) |
| Bộ nhớ | Đề xuất 1024 MB, vì phân tích HTML tới 3 MB |
| Gói triển khai | Chạy `npm ci --omit=dev && npm run build`, rồi zip `dist/`, `node_modules/` và `package.json` (cần `"type": "module"`) |
| Function URL | `AuthType: AWS_IAM`; chỉ CloudFront gọi được, qua OAC (SigV4) |
| IAM | `translate:TranslateText`; `dynamodb:BatchGetItem` và `dynamodb:UpdateItem` trên bảng chính, giới hạn bằng điều kiện `dynamodb:LeadingKeys` theo tiền tố `TENANT#` (phần TM); quyền ghi log CloudWatch |
| CloudFront | Chỉ cho GET, HEAD; khoá cache gồm đường dẫn và query; tôn trọng `Cache-Control` của origin |

### Biến môi trường

| Biến | Bắt buộc | Ý nghĩa |
| :--- | :---: | :--- |
| `PUBLIC_BASE_URL` | Có | Ví dụ `https://d1abc.cloudfront.net`. Dùng làm URL tuyệt đối của canonical, hreflang, og:url |
| `BASE_MODE` | Không | `path` (mặc định) cho `/{slug}/{lang}/…`; `host` cho `{slug}.<tên miền>/{lang}/…` khi có tên miền riêng |
| `PROXY_SITES_JSON` | Tuần 1 | Danh sách website, xem ví dụ dưới. Từ tuần 2 thay bằng tra DynamoDB (SLUG → HOST + CONFIG) |
| `TABLE_NAME` | Có (bật TM) | Tên bảng DynamoDB chính. Không có thì proxy chạy không TM và ghi log `TM_DISABLED` |
| `TRANSLATE_BUDGET_MS` | Không | Ngân sách dịch, mặc định 20000 |
| `TRANSLATE_CONCURRENCY` | Không | Số lời gọi TranslateText song song, mặc định 4 |
| `USE_FETCH_STUB` | Không | `1` = dùng `safeFetch.stub` (trang mẫu cố định, không gọi mạng) để demo |

```json
[{"slug":"homestay-abc","tenantId":"t_8f3a1c9e4b2d7a6f5e0c1b2a","homeUrl":"https://homestay-abc.vn/",
  "sourceLang":"vi","targetLangs":["en","ko","ja"],"exclusionSelectors":["#booking-widget"],
  "cacheSeconds":86400,"status":"ACTIVE","tenantStatus":"ACTIVE"}]
```

## Mã phản hồi

| Tình huống | Phản hồi |
| :--- | :--- |
| Dịch xong | `200`, `Cache-Control: public, max-age=0, s-maxage=<cacheSeconds>` |
| Còn câu chưa dịch (lỗi Translate hoặc hết 20 giây) | `200`, `s-maxage=60`, `X-TranslateMe-Partial: 1` |
| Đường dẫn sai, slug lạ, ngôn ngữ chưa bật | `404` |
| Phương thức khác GET/HEAD | `405` |
| Website PAUSED/PENDING, tenant LOCKED | `302` về trang tương ứng trên website gốc |
| `safe_fetch`: NOT_HTML / BLOCKED / TOO_LARGE / TIMEOUT / TOO_MANY_REDIRECTS, NETWORK_ERROR | `302` tới tệp gốc / `403` / `302` về trang gốc / `504` / `502` |
| Origin trả mã khác 2xx, chuyển hướng sang tên miền khác, lỗi không lường trước, trang dịch > 5,5 MB | `302` về trang gốc |

## Câu và marker gửi Translate

Mỗi câu được bọc bằng `<div data-s="k">`. Thẻ nội tuyến bên trong câu được giữ dạng `<span data-i="n">` theo Quy ước mục 3.2.

Báo cáo (F2 bước 5) ghi "bọc câu bằng `<span data-i>`". Không dùng cách đó được, vì `data-i` đã dành cho thẻ nội tuyến, nên câu dùng `data-s`.

## Translation Memory (2.4)

- Hash câu: tạm dùng `hashSentenceStub` (`stubs.ts`, cùng quy tắc B.1.3) cho tới khi có `hashSentence` của thư viện 1.8.
- Thuật ngữ: tạm dùng `getGlossaryStateStub` (không có thuật ngữ) cho tới khi có `getGlossaryState` của 2.8.
- Đọc ghi DynamoDB: `createDynamoTmDb` trong `libs/common/tm.ts` (stub của 2.2, tự lặp `UnprocessedKeys`, kiểm tra khoá theo tiền tố tenant) cho tới khi `db.batchGet`/`db.update` của 2.2 dùng được.
- Lỗi TM không làm hỏng trang: tra lỗi thì coi như trượt hết; ghi lỗi thì chỉ ghi log (`tmReadError`, `tmWriteFailed`).
- Đọc thuật ngữ lỗi cũng không làm hỏng trang: xử lý như lỗi tra TM. Proxy bỏ qua TM (không tra, không ghi vì không biết `glossaryVersion` đúng), dịch không kèm terminology và trả `s-maxage=60` để sớm dịch lại (log `glossaryError`).
- Bản HUMAN lỗi thời theo thuật ngữ vẫn được dùng, và được ghi cờ "Cần xem lại" (`markHumanNeedsReview`: `needsReview = true`, chuyển sang nhóm `TM#REVIEW` của GSI3) để vào hàng đợi duyệt. Chỉ ghi khi bản ghi vẫn là HUMAN, `tgt` chưa đổi và chưa có cờ; không tăng `version`. Log: `tmReviewFlagged`, `tmHumanNeedsReview`.

## Việc còn lại

- Đặt trước hạn mức ký tự và bộ đếm USAGE (2.7).
- Đổi `translateSentences` sang đúng chữ ký B.9 (2.5).
- Lambda worker hoàn tất nền khi trang dịch dở (2.5).
- Ghi SEG (3.4).
- Tra website từ DynamoDB thay cho `PROXY_SITES_JSON`.
