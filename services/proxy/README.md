# Lambda proxy F2 (C2)

Nhiệm vụ 1.6, 2.4 và 2.5 (TV2). Chạy các bước 1–6 và 8 của F2, cùng Lambda worker C13 hoàn tất nền.

Luồng xử lý (B.10): tra website → tải trang gốc bằng `safe_fetch` → `extract()` → băm câu → `getTM()` → `reserveChars()` cho câu trượt → `translateSentences()` (B.9, `libs/common/translator.ts`) → `putMachineTM()` → `rebuildDetailed()` → `settleUsage()` → gửi câu chưa dịch kịp cho worker → trả về CloudFront.

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
| IAM | `translate:TranslateText`; `dynamodb:BatchGetItem`, `dynamodb:UpdateItem` (TM) và `dynamodb:BatchWriteItem` (SEG) trên bảng chính, giới hạn bằng điều kiện `dynamodb:LeadingKeys` theo tiền tố `TENANT#`; `lambda:InvokeFunction` trên worker; `s3:PutObject` trên `worker/*` của bucket tải trọng; quyền ghi log CloudWatch |
| CloudFront | Chỉ cho GET, HEAD; khoá cache gồm đường dẫn và query; tôn trọng `Cache-Control` của origin |

### Biến môi trường

| Biến | Bắt buộc | Ý nghĩa |
| :--- | :---: | :--- |
| `PUBLIC_BASE_URL` | Có | Ví dụ `https://d1abc.cloudfront.net`. Dùng làm URL tuyệt đối của canonical, hreflang, og:url |
| `BASE_MODE` | Không | `path` (mặc định) cho `/{slug}/{lang}/…`; `host` cho `{slug}.<tên miền>/{lang}/…` khi có tên miền riêng |
| `PROXY_SITES_JSON` | Tuần 1 | Danh sách website, xem ví dụ dưới. Từ tuần 2 thay bằng tra DynamoDB (SLUG → HOST + CONFIG) |
| `TABLE_NAME` | Có (bật TM và SEG) | Tên bảng DynamoDB chính. Không có thì proxy chạy không TM, không ghi SEG và ghi log `TM_DISABLED`, `SEG_DISABLED` |
| `TRANSLATE_BUDGET_MS` | Không | Ngân sách dịch, mặc định 20000 |
| `TRANSLATE_CONCURRENCY` | Không | Số lời gọi TranslateText song song, mặc định 4 |
| `WORKER_FUNCTION_NAME` | Không | Tên Lambda worker C13. Không có thì không hoàn tất nền, ghi log `WORKER_DISABLED` |
| `WORKER_PAYLOAD_BUCKET` | Không | Bucket S3 chứa danh sách câu lớn gửi worker (khoá `worker/<tenantId>/…`). Nên đặt Lifecycle xoá sau 1 ngày |
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
| Dịch xong nhưng đọc thuật ngữ lỗi hoặc ghi SEG lỗi | `200`, `s-maxage=60` (không có `X-TranslateMe-Partial`) |
| Còn câu chưa dịch (lỗi Translate hoặc hết 20 giây) | `200`, `s-maxage=60`, `X-TranslateMe-Partial: 1`; phần còn lại gửi worker |
| Tenant hết hạn mức ký tự (`CHAR_QUOTA_EXCEEDED`) | `200`, `s-maxage=300`, `X-TranslateMe-Partial: quota`; câu có trong TM vẫn dịch, câu trượt giữ gốc |
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
- Đọc thuật ngữ lỗi cũng không làm hỏng trang: xử lý như lỗi tra TM. Proxy bỏ qua TM (không tra, không ghi và không gọi worker vì không biết `glossaryVersion` đúng), dịch không kèm terminology và trả `s-maxage=60` để sớm dịch lại (log `glossaryError`).
- Bản HUMAN lỗi thời theo thuật ngữ vẫn được dùng, và được ghi cờ "Cần xem lại" (`markHumanNeedsReview`: `needsReview = true`, chuyển sang nhóm `TM#REVIEW` của GSI3) để vào hàng đợi duyệt. Chỉ ghi khi bản ghi vẫn là HUMAN, `tgt` chưa đổi và chưa có cờ; không tăng `version`. Log: `tmReviewFlagged`, `tmHumanNeedsReview`.

## Dịch song song, trang dịch dở, hạn mức (2.5)

- `translateSentences` (B.9) là hàm thuần trong `libs/common/translator.ts`: bỏ trùng câu, gom khối ≤ 10.000 byte theo ranh giới câu, gọi song song tối đa `concurrency`, ráp lại theo `data-s`.
  - Thiếu hoặc trùng `data-s`: chia đôi nhóm câu thiếu rồi gọi lại; còn một câu vẫn thiếu thì dịch dạng văn bản thuần.
  - Marker hỏng: dịch lại dạng văn bản thuần, đánh dấu `needsReview`.
  - Lỗi Translate ở một khối: câu của khối đó vào `failed` kèm lý do; hết hạn chót: các khối chưa gọi vào `pending`.
- `countChars` tạm dùng `countCharsStub` (`stubs.ts`): số code point sau chuẩn hoá NFC, không tính ký hiệu `{n}` (đề xuất mục 7.1 Phần A). Số ký tự AWS tính phí (gồm thẻ) ghi riêng ở log `charsSent`.
- Hạn mức: tạm dùng `quotaStub` (`usage.ts`, B.14: luôn đủ, settle chỉ ghi log) cho tới khi có `reserveChars`/`releaseChars`/`settleUsage` của 2.7. Không có câu trượt thì không gọi `reserveChars`.
- Câu trong `pending` và `failed` (trừ `SENTENCE_TOO_LARGE`) được gửi worker qua `lambda:InvokeFunction` (InvocationType `Event`). Chỉ gửi khi bật TM, vì worker chỉ ghi kết quả vào TM. Lỗi gọi worker chỉ ghi log.

Sự kiện `FINISH_PAGE` gửi worker (`workerEvents.ts`): mỗi sự kiện ≤ 200 KB. Danh sách câu dài thì chia nhiều sự kiện; quá 4 sự kiện, hoặc có câu mà riêng nó đã vượt 200 KB, thì ghi danh sách câu ra S3 và sự kiện chỉ mang `sentencesS3Key`. Không cấu hình `WORKER_PAYLOAD_BUCKET` mà có câu như vậy thì bỏ câu đó và ghi log `workerDropped`. Thực tế câu gửi worker luôn ≤ 10.000 byte, vì câu lớn hơn đã bị translator đánh `SENTENCE_TOO_LARGE`.

## Chỉ mục câu–trang SEG (3.4)

Thư viện: `libs/common/seg.ts`. Bước 7 của F2: mỗi lần dựng trang, proxy ghi (bằng `BatchWriteItem`, lô 25, song song với ghi TM) một bản ghi SEG cho **mọi** câu của trang, kể cả câu chưa dịch:

| Thuộc tính | Giá trị |
| :--- | :--- |
| `PK` / `SK` | `TENANT#<t>#SEG#<sha256>` / `PAGE#<lang>#<path>` |
| `GSI2PK` / `GSI2SK` | `TENANT#<t>#PAGE#<lang>#<path>` / `HASH#<sha256>` |
| `ttl` | 30 ngày sau lần ghi gần nhất (lớn hơn thời gian lưu đệm tối đa của website) |

- `<path>` luôn gồm slug (QC-5): `segPath('homestay-abc', 'phong-nghi/')` = `/homestay-abc/phong-nghi/`, trang chủ là `/homestay-abc/`. Không có query; giữ nguyên dạng mã hóa `%`. `<lang>` là ngôn ngữ đích của trang.
- Đọc: `sentencesOfPage(ctx, lang, path)` qua GSI2; `pagesOfSentence(ctx, hash, lang)` qua bảng chính (dùng cho xóa cache chọn lọc 3.5).
- TTL của SEG (30 ngày) luôn dài hơn thời gian CloudFront giữ trang: `cacheSeconds` của website tối đa 7 ngày (`MAX_PAGE_CACHE_SECONDS`, kiểm tra khi xác thực cấu hình website; proxy cũng chặn trên `s-maxage` bằng giá trị này). Trang được dựng lại ít nhất mỗi 7 ngày và mỗi lần dựng đều làm mới `ttl`, nên SEG không bao giờ hết hạn trước cache.
- Ghi lại cùng trang chỉ làm mới `ttl`. Câu đã bị gỡ khỏi trang còn bản ghi tới khi hết `ttl`, nên xóa cache có thể thừa một trang nhưng không sót.
- Ghi SEG lỗi không làm hỏng trang, nhưng trang trả `s-maxage=60` để không bị CloudFront giữ lâu khi chỉ mục còn thiếu. Log: `segWritten`, `segWriteFailed`, `segWriteErrors`, `segWriteError`.
- Đọc ghi DynamoDB tạm qua `createDynamoSegDb` (stub của 2.2, giống TM) cho tới khi lớp `data` có `batchWrite` và query GSI.

## Lambda worker C13 (`worker.ts`)

| Mục | Giá trị |
| :--- | :--- |
| Handler | `services/proxy/dist/services/proxy/worker.handler` (cùng gói triển khai với proxy) |
| Timeout | 300 giây (ngân sách nội bộ `WORKER_BUDGET_MS`, mặc định 240000) |
| Lời gọi lại tự động | Đặt `MaximumRetryAttempts: 0` cho lời gọi bất đồng bộ, tránh dịch và tính phí trùng |
| Biến môi trường | `TABLE_NAME` (bắt buộc), `PROXY_SITES_JSON`, `WORKER_PAYLOAD_BUCKET`, `TRANSLATE_CONCURRENCY`, `WORKER_BUDGET_MS` |
| IAM | `translate:TranslateText`; `dynamodb:BatchGetItem`, `dynamodb:UpdateItem` (như proxy); `s3:GetObject` trên `worker/*`; ghi log |

Worker kiểm tra lại sự kiện và tenant (B.1.1): slug thuộc đúng `tenantId`, website `ACTIVE`, tenant không `LOCKED`, ngôn ngữ đã bật, khoá S3 nằm dưới `worker/<tenantId>/`. Sau đó tra lại TM, tự đặt trước hạn mức cho phần mình dịch, dịch, ghi bản `MACHINE` và `settleUsage` với `{ kind: 'WEB', slug }`. Worker không throw; kết quả (`DONE`, `NOTHING_TO_DO`, `QUOTA_EXCEEDED`, `REJECTED`, `ERROR`) nằm trong log.

## Việc còn lại

- Thay `quotaStub`, `countCharsStub`, `hashSentenceStub`, `getGlossaryStateStub` khi 2.7, 1.8, 2.8 xong.
- Khai báo Lambda worker và bucket tải trọng trong IaC (TV1).
- Đo thời gian: lần tải đầu < 30 giây, lần hai trúng TM (mốc 4).
- Xóa cache chọn lọc dựa trên SEG (3.5).
- Worker ở chế độ trang (4.5, dịch trước) ghi SEG như proxy.
- Tra website từ DynamoDB thay cho `PROXY_SITES_JSON`.
