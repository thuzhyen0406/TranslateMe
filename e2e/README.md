# TranslateMe E2E – hạ tầng và nghiệm thu 5.1

Thư mục này là package độc lập dành cho test hộp đen qua HTTP. Nó không thay đổi script build/test unit của API và proxy. Yêu cầu Node.js 20 trở lên; các endpoint được gọi cấu hình trong `e2e/.env.<stage>` dựa trên `.env.example`.

## Cài đặt và tự kiểm tra offline

```sh
cd e2e
npm ci
npm run selftest
```

Selftest chạy mock local, không gọi AWS. Các mode lỗi cố ý kiểm tra rò rỉ tenant, sai khác giữa lỗi quyền và `NOT_FOUND`, lộ dữ liệu Platform, lỗi khóa tenant và SSRF. Riêng mode SSRF cho phép xác minh địa chỉ metadata `169.254.169.254`; ca S1 phải thất bại trong chế độ này. Kết quả selftest không thay thế nghiệm thu trên API thật.

## Chạy trên môi trường đã seed dữ liệu

Tạo file `.env.<stage>` từ `.env.example`; package tự nạp file tương ứng với `TM_STAGE` hoặc `TM_ENV_FILE`. Chạy các lệnh trong thư mục `e2e/`:

```sh
npm run test:isolation
npm run test:ssrf
TM_ALLOW_MUTATION=1 npm run test:limits
npm run typecheck
```

Test cần `.state/<stage>.json` có tài khoản tenant A/B/C, Platform Admin, API keys, job và file_key. Tạo state bằng `npm run demo:seed -- all` sau khi cấu hình AWS/API. File state chứa mật khẩu và key, không được commit.

`limits.test.ts` đổi hạn mức và khóa tenant A. Chỉ bật `TM_ALLOW_MUTATION=1` trên dev/demo, và không chạy song song với isolation. SSRF S7/S8 cần fixture do TV4 cung cấp; nếu thiếu fixture, test đánh dấu SKIP và không được tính là đủ bằng chứng. Vì API chưa có route xóa website, test sẽ nhận diện slug từ hostname fixture và tái sử dụng bản ghi `PENDING` cùng origin ở lần chạy sau; nếu slug đó đã được dùng bởi origin khác hoặc website không còn `PENDING`, test dừng với thông báo rõ ràng.

## Hợp đồng khớp project hiện tại

- Tạo website gửi `home_url`, `display_name`, `source_lang`, `target_langs`. API tự sinh `slug` từ hostname; mỗi tenant demo cần origin có hostname riêng, duy nhất và có thể xác minh.
- Xác minh website gửi `{ "method": "META" }` hoặc `FILE`.
- Platform Admin thuộc Cognito group `PlatformAdmins`.
- Body/các endpoint nghiệp vụ vẫn được gom ở `lib/contract.ts` để dễ cập nhật.

Project hiện tại chưa đăng ký một số route mà bộ nghiệm thu tuần 5 cần, gồm `/console/me`, `/console/usage`, `/console/batch/{id}` và các route quản trị danh sách/chi tiết tenant cùng cấu hình platform. Các ca không có route tương đương được ghi `SKIP` kèm lý do; chúng không được tính là đạt. Khi route được tích hợp, bật capability tương ứng trong `.env.<stage>` (`TM_E2E_HAS_CONSOLE_ME`, `TM_E2E_HAS_CONSOLE_USAGE`, `TM_E2E_HAS_CONSOLE_BATCH_RESULT`, `TM_E2E_HAS_PLATFORM_TENANT_DETAIL`, `TM_E2E_HAS_PLATFORM_TENANT_LIST`, `TM_E2E_HAS_PLATFORM_CONFIG`) để suite chạy assertion thay vì bỏ qua.

Các phép thử TM dùng route hiện có `GET /console/translations?tab=MACHINE` và bộ lọc `search`. `/console/tm/{hash}/pages` không được giả lập bằng fallback 404. `GET /console/jobs/{id}` chỉ trả metadata job; không thay cho endpoint tải kết quả batch.

`TM_FLOOD_N` mặc định là 30 để kiểm tra throttling mà không tạo burst quá lớn trên Lambda. Có thể giảm theo quota của môi trường; không tăng nếu chưa xác nhận concurrency limit.

## Bằng chứng SSRF bổ sung

Các test `safeFetch` trong `libs/common/test/safeFetch.test.ts` dùng transport giả có ghi lại mọi IP được kết nối: các IP nội bộ phải có 0 lần gọi transport, redirect về IP private chỉ được gọi transport cho host public. Cùng bộ test xác nhận redirect không mang tiếp `Cookie`, `Authorization`, `Proxy-Authorization` hoặc `X-Forwarded-For`.

Để kiểm tra header của request S8 từ API đang chạy, TV4 có thể cung cấp `TM_SSRF_HEADER_REPORT_URL`. Endpoint này cần trả JSON dạng `{"header_names":["host","accept"]}` mô tả tên header mà fixture redirect nhận ở request S8 gần nhất; không trả giá trị header. Khi biến này được cấu hình, test xác nhận không có cookie/header xác thực; nếu thiếu, evidence ghi riêng `S8H` là `SKIP` thay vì coi tiêu chí đó đã đạt. CloudWatch không có log kết nối outbound theo từng request trong cấu hình hiện tại, nên test không tuyên bố rằng đã kiểm tra log AWS.

Khi nghiệm thu SSRF, cần kiểm tra evidence `S8H` là `pass` và đính kèm bằng chứng log outbound từ môi trường triển khai nếu tiêu chí nghiệm thu yêu cầu. Nếu `S8H` là `skip` hoặc chưa có log AWS, báo cáo chỉ xác nhận những kiểm tra đã chạy; không đánh dấu các tiêu chí header/log là đạt.

## Preflight, deploy và seed demo

Các lệnh vận hành chạy từ `e2e/`:

```sh
npm run demo:preflight
npm run demo:deploy -- --stage dev --dry-run
npm run demo:seed -- all --dry-run
```

Lưu ý: `demo:seed --dry-run` vẫn gọi `sts get-caller-identity` thật để xác nhận account đích. Cần AWS credentials hợp lệ và `TM_ACCOUNT` là ID 12 chữ số khớp với account hiện tại; các lệnh ghi AWS/API được mô phỏng, không thực thi.

Preflight chỉ gọi AWS API đọc trạng thái. Deploy xác nhận `TM_ACCOUNT` với `sts get-caller-identity` trước lệnh ghi và chỉ nhận stage `dev` hoặc `demo`. Script deploy cần bảy stack entry-point `data.yaml`, `identity.yaml`, `api.yaml`, `edge.yaml`, `workflow.yaml`, `console.yaml`, `ops.yaml`; có thể cấu hình qua `TM_TEMPLATE_DIR` hoặc `TM_TEMPLATE_<STACK>`.

Repo hiện chưa có bảy entry-point này. `infra/template.yaml` là template dev riêng chỉ tạo budget và Hello Lambda, không chứa hạ tầng TranslateMe; `infra/modules/*.yaml` là module, không thể deploy trực tiếp thành bảy stack. Vì vậy deploy thật vẫn dừng trước mọi lệnh CloudFormation cho đến khi các entry-point đúng phạm vi được cung cấp. Không dùng template Hello Lambda làm bản thay thế cho hạ tầng demo.

Seed tenant yêu cầu `TM_DEMO_ORIGIN_A/B/C` trỏ tới ba hostname riêng. Nếu website chưa `ACTIVE`, seed thử xác minh bằng `META` mặc định; có thể chọn `FILE` bằng `TM_DEMO_VERIFY_METHOD=FILE`. Script lấy `verification_code` từ response host. Nếu nội dung xác minh chưa được publish tại hostname, seed dừng và in token cùng hướng dẫn chính xác, không đánh dấu website sẵn sàng. Sau khi publish, chạy lại `npm run demo:seed -- tenants`; state đã lưu nên seed tiếp tục các tài nguyên còn thiếu. Seed không thể tự ghi vào website bên ngoài nếu chưa cấu hình quyền/đích hosting của hostname. `seed all` chỉ PUT Platform Config khi `TM_E2E_HAS_PLATFORM_CONFIG=1`; mặc định ghi chú skip vì route `/platform/config` chưa có trong API hiện tại.

### Xác minh hostname demo

API trả `verification_code` trong đối tượng `host` khi tạo website và trong danh sách website. Seed dùng code đó để gọi verify. Nếu hostname chưa xác minh, thông báo lỗi của seed in hướng dẫn chứa token:

- Với `META` (mặc định), đặt `<meta name="translateme-site-verification" content="<token>">` bên trong `<head>` của trang chủ tại `TM_DEMO_ORIGIN_<A|B|C>`.
- Với `FILE`, đặt nội dung tệp chỉ gồm token (text/plain) tại đường dẫn gốc `/translateme-verification.txt`; bật bằng `TM_DEMO_VERIFY_METHOD=FILE`.

Đảm bảo trang/file được phục vụ công khai qua HTTPS và phản hồi GET được, rồi chạy lại `npm run demo:seed -- tenants`. Backend yêu cầu nội dung file khớp token chính xác sau khi trim khoảng trắng. Seed chỉ tiếp tục tạo API key, TM và batch job khi API xác nhận trạng thái website `ACTIVE`.

Tenant Cognito được tạo bằng `SignUp` rồi `AdminConfirmSignUp` để kích hoạt PostConfirmation và sinh `custom:tenant_id`; seed không đặt password permanent trước bước confirm. API key dùng payload `{ name, plan: "Basic" }` và đọc `key_id`/`value` từ response lồng trong `api_key` theo contract của API hiện tại.

State lưu `fileKey` và trạng thái batch trước khi POST. Khi kết quả request chưa rõ, lần chạy sau query DynamoDB theo tenant và file key để khôi phục job trước khi gửi lại. Cần `TM_TABLE`, quyền `dynamodb:Query`, và thời gian dò ít nhất 90 giây (`TM_BATCH_RECOVERY_WAIT_S`, timeout Lambda 60 giây cộng 30 giây đệm). `npm run test:demo` dùng `AWS_BIN` giả để kiểm tra thao tác usage plan và batch recovery offline.

## 5.4, 5.5, kịch bản 8 (TV2)

Ba website mẫu và cách đăng: `sites/README.md`. Mỗi lệnh đọc `.state/<stage>.json` (slug của tenant A/B/C) và `TM_PUBLIC_BASE`, rồi ghi bằng chứng vào `evidence/<TM_RUN_ID>/` dưới dạng `.md` và `.json`.

| Lệnh | Hạng mục | Kiểm tra | Bằng chứng |
| :--- | :--- | :--- | :--- |
| `npm run rehearsal:proxy` | 5.4 (offline) | Cùng các kiểm tra của `demo:proxy-check`, chạy trên lõi proxy thật với Translate và CloudFront giả; cần `npm run build` trong `services/proxy` trước | stdout |
| `npm run demo:proxy-check` | 5.4 | Site A: lang, canonical/hreflang theo `PUBLIC_BASE_URL`, `{n}`, `translate="no"`, iframe, ảnh, biểu mẫu (placeholder, option, textarea), bảng, trang > 3 MB → 302, origin 404 → 404, ngôn ngữ chưa bật → 404, HEAD, trang dịch dở + worker | `proxy-check.md` (có mục "Danh sách lỗi") |
| `npm run demo:latency` | 5.5 / KB3 | Site B, 10 lần × (a) TM rỗng < 30 s, không 5xx; (b) trúng TM sau khi xóa cache, trung vị ≤ 2 s; (c) `x-cache: Hit`, trung vị ≤ 300 ms | `kb3-latency.md` |
| `npm run demo:kb8 -- --prepare` | KB8 | Site C: sửa câu X ở `en` → `CreateInvalidation` đúng 2 đường dẫn; `en/trang-3/` và cả 3 trang `ko` vẫn `Hit`; bản HUMAN không bị ghi đè | `kb8-invalidation.md` |

- (b) xóa cache bằng `CreateInvalidation` khi có `TM_CF_DISTRIBUTION_ID` (cần quyền `cloudfront:CreateInvalidation` / `GetInvalidation`), ngược lại thêm query ngẫu nhiên (`--bust query`, chỉ đúng khi cache key của CloudFront gồm query string). Lượt nào không phải `Miss` bị đánh dấu không hợp lệ và tiêu chí không đạt.
- (a) cần TM rỗng: muốn đo lại thì build site B với `TM_LATENCY_ROUND=<n mới>`, đăng lại rồi chạy lại.
- `--prepare` của KB8 bật thêm ngôn ngữ đối chứng (`--other-lang`, mặc định `ko`) cho website C nếu chưa bật, rồi chờ 65 s cho bộ đệm trạng thái của proxy.
- Muốn thử nhánh trang dịch dở trên stack thật: tạm đặt `TRANSLATE_BUDGET_MS` thấp (ví dụ `1500`) cho Lambda proxy dev. Nếu không, mục PARTIAL chỉ là cảnh báo.

## Cấu trúc

- `lib/`: cấu hình, Cognito JWT, HTTP retry, API contract, so sánh lỗi và evidence.
- `tests/`: isolation (kịch bản 4), limits (kịch bản 5), SSRF (kịch bản 6) và helper/demo tests.
- `mock/`, `scripts/selftest.ts`: mock và tự kiểm tra offline.
- `demo/`: AWS preflight, deploy bảy stack theo thứ tự, seed dữ liệu demo; `proxyCheck.ts`, `latency.ts`, `kb8.ts` cho 5.4, 5.5, KB8.
- `sites/`, `tools/build-sites.ts`, `lib/sampleSites.ts`: ba website mẫu.

## Evidence report (hạng mục 5.2)

Mỗi phép thử ghi JSONL vào `e2e/evidence/<run-id>/scenario-<n>.jsonl`. Tổng hợp sau khi chạy:

Run ID được chọn theo thứ tự đối số CLI, `TM_RUN_ID`, rồi thư mục evidence mới nhất. Aggregator chỉ đọc thư mục đã có; nếu run ID không tồn tại, lệnh báo lỗi thay vì tạo summary rỗng.

```sh
TM_RUN_ID=local npm run test:gate
npm run evidence -- local
```

Summary phân biệt `ĐẠT`, `LỖI`, `BỎ QUA` và `THIẾU`; lỗi luôn làm lệnh thất bại, scenario bắt buộc có ca skip/thiếu cũng trả mã lỗi. Scenario 6 gồm S1–S9 và S8H; bằng chứng header S8 phải đạt riêng, không được coi là đạt nếu fixture report bị thiếu.

## GitHub Actions release gate

`release-gate.yml` hiện chỉ chạy thủ công qua `workflow_dispatch` trên nhánh `main`; các dispatch từ nhánh khác bị từ chối trước khi cấp AWS credentials. Trigger sau deploy được tạm tắt cho tới khi các route, fixture SSRF, state demo và hạ tầng sản phẩm sẵn sàng. Sau khi các dependency này được cung cấp, có thể bật lại trigger deploy.

Trước khi chạy test, workflow kiểm tra secrets `AWS_ROLE_ARN`, `TM_CI_ENV`, `TM_STATE_JSON`; Actions variables `TM_ACCOUNT` (12 chữ số) và `TM_REGION`; state tenant A/B/C; fixtures `TM_SSRF_REBIND_URL`, `TM_SSRF_REDIRECT_URL`, `TM_SSRF_HEADER_REPORT_URL`; và capability flags cho các route bắt buộc. Sau khi assume role, workflow xác nhận account bằng STS trước khi kiểm tra stack. Các capability route chỉ đặt `1` sau khi route đã deploy. Artifact chỉ chứa `summary.md`, đã lược chi tiết lỗi/phản hồi, và được giữ 7 ngày; JSONL thô không được upload.

Thiếu route, fixture hoặc seed state sẽ làm validation/evidence gate thất bại; không dùng kết quả đó làm tín hiệu release. Route/capability chưa sẵn sàng được liệt kê ở phần trên của README. Repo cũng chưa có bảy CloudFormation stack entry-point cho deploy demo.
