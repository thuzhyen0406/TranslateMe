# TranslateMe E2E – hạ tầng và nghiệm thu 5.1

Thư mục này là package độc lập dành cho test hộp đen qua HTTP. Nó không thay đổi script build/test unit của API và proxy. Yêu cầu Node.js 20 trở lên; các endpoint được gọi cấu hình trong `e2e/.env.<stage>` dựa trên `.env.example`.

## Cài đặt và tự kiểm tra offline

```sh
cd e2e
npm install
npm run selftest
```

Selftest chạy mock local, không gọi AWS. Các mode lỗi cố ý kiểm tra rò rỉ tenant, sai khác giữa lỗi quyền và `NOT_FOUND`, lộ dữ liệu Platform, lỗi khóa tenant và SSRF. Riêng mode SSRF cho phép xác minh địa chỉ metadata `169.254.169.254`; ca S1 phải thất bại trong chế độ này. Kết quả selftest không thay thế nghiệm thu trên API thật.

## Chạy trên môi trường đã seed dữ liệu

Tạo file `.env.<stage>` từ `.env.example`; test tự nạp file stage. Chạy các lệnh trong thư mục `e2e/`:

```sh
npm run test:isolation
npm run test:ssrf
TM_ALLOW_MUTATION=1 npm run test:limits
npm run typecheck
```

Test cần `.state/<stage>.json` có tài khoản tenant A/B/C, Platform Admin, API keys, job và file_key. File state chứa mật khẩu và key, không được commit. Phần tạo dữ liệu demo thuộc nhánh triển khai demo; không có seed AWS trong package của nhánh này.

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

Preflight chỉ gọi AWS API đọc trạng thái. Deploy xác nhận `TM_ACCOUNT` với `sts get-caller-identity` trước lệnh ghi và chỉ nhận stage `dev` hoặc `demo`. Script deploy cần bảy stack entry-point `data.yaml`, `identity.yaml`, `api.yaml`, `edge.yaml`, `workflow.yaml`, `console.yaml`, `ops.yaml`; có thể cấu hình qua `TM_TEMPLATE_DIR` hoặc `TM_TEMPLATE_<STACK>`.

Repo hiện chưa có bảy entry-point này. `infra/template.yaml` là template dev riêng chỉ tạo budget và Hello Lambda, không chứa hạ tầng TranslateMe; `infra/modules/*.yaml` là module, không thể deploy trực tiếp thành bảy stack. Vì vậy deploy thật vẫn dừng trước mọi lệnh CloudFormation cho đến khi các entry-point đúng phạm vi được cung cấp. Không dùng template Hello Lambda làm bản thay thế cho hạ tầng demo.

Seed tenant yêu cầu `TM_DEMO_ORIGIN_A/B/C` trỏ tới ba hostname riêng, xác minh được. Nếu website chưa `ACTIVE`, seed dừng. Seed chạy tiếp từng tài nguyên còn thiếu, không bỏ qua tenant chỉ vì đã có API key. `seed all` chỉ PUT Platform Config khi `TM_E2E_HAS_PLATFORM_CONFIG=1`; mặc định ghi chú skip vì route `/platform/config` chưa có trong API hiện tại.

Tenant Cognito được tạo bằng `SignUp` rồi `AdminConfirmSignUp` để kích hoạt PostConfirmation và sinh `custom:tenant_id`; seed không đặt password permanent trước bước confirm. API key dùng payload `{ name, plan: "Basic" }` và đọc `key_id`/`value` từ response lồng trong `api_key` theo contract của API hiện tại.

State lưu `fileKey` và trạng thái batch trước khi POST. Khi kết quả request chưa rõ, lần chạy sau query DynamoDB theo tenant và file key để khôi phục job trước khi gửi lại. Cần `TM_TABLE`, quyền `dynamodb:Query`, và thời gian dò ít nhất 90 giây (`TM_BATCH_RECOVERY_WAIT_S`, timeout Lambda 60 giây cộng 30 giây đệm). `npm run test:demo` dùng `AWS_BIN` giả để kiểm tra thao tác usage plan và batch recovery offline.

## Cấu trúc

- `lib/`: cấu hình, Cognito JWT, HTTP retry, API contract, so sánh lỗi và evidence.
- `tests/`: isolation (kịch bản 4), limits (kịch bản 5), SSRF (kịch bản 6).
- `mock/`, `scripts/selftest.ts`: mock và tự kiểm tra offline.
