# Lambda proxy F2 (C2) – bản tuần 1

Nhiệm vụ 1.6 (TV2). Chạy thông các bước 1, 2, 6, 8 của F2 và gọi TranslateText. Chưa có TM.

Luồng xử lý: tra website → tải trang gốc bằng `safe_fetch` → `extract()` → `translateSentences()` → `rebuildDetailed()` → trả về CloudFront.

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
| IAM | `translate:TranslateText`; quyền ghi log CloudWatch |
| CloudFront | Chỉ cho GET, HEAD; khoá cache gồm đường dẫn và query; tôn trọng `Cache-Control` của origin |

### Biến môi trường

| Biến | Bắt buộc | Ý nghĩa |
| :--- | :---: | :--- |
| `PUBLIC_BASE_URL` | Có | Ví dụ `https://d1abc.cloudfront.net`. Dùng làm URL tuyệt đối của canonical, hreflang, og:url |
| `BASE_MODE` | Không | `path` (mặc định) cho `/{slug}/{lang}/…`; `host` cho `{slug}.<tên miền>/{lang}/…` khi có tên miền riêng |
| `PROXY_SITES_JSON` | Tuần 1 | Danh sách website, xem ví dụ dưới. Từ tuần 2 thay bằng tra DynamoDB (SLUG → HOST + CONFIG) |
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

## Việc của tuần 2

- TM (2.4): tra trước khi dịch, ghi bản MACHINE sau khi dịch.
- Đặt trước hạn mức ký tự và bộ đếm USAGE (2.7).
- Lambda worker hoàn tất nền khi trang dịch dở (2.5).
- Ghi SEG (3.4).
- Tra website từ DynamoDB thay cho `PROXY_SITES_JSON`.
