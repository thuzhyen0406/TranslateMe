# TranslateMe E2E – hạ tầng và nghiệm thu 5.1

Thư mục này là package độc lập dành cho test hộp đen qua HTTP. Nó không thay đổi script build/test unit của API và proxy. Yêu cầu Node.js 20 trở lên; các endpoint được gọi cấu hình trong `e2e/.env.<stage>` dựa trên `.env.example`.

## Cài đặt và tự kiểm tra offline

```sh
cd e2e
npm install
npm run selftest
```

Selftest chạy mock local, không gọi AWS. Mock có các lỗi cố ý để xác nhận test phát hiện rò rỉ tenant, sai so sánh `NOT_FOUND`, SSRF và lỗi khóa tenant. Kết quả selftest không thay thế nghiệm thu trên API thật.

## Chạy trên môi trường đã seed dữ liệu

Tạo file `.env.<stage>` từ `.env.example`; package tự nạp file tương ứng với `TM_STAGE` (hoặc file được chỉ định bằng `TM_ENV_FILE`). Chạy các lệnh trong thư mục `e2e/`:

```sh
npm run test:isolation
npm run test:ssrf
TM_ALLOW_MUTATION=1 npm run test:limits
```

Test cần `.state/<stage>.json` có tài khoản tenant A/B/C, Platform Admin, API keys, job và file_key. Tạo state bằng `npm run demo:seed -- all` sau khi cấu hình AWS và API. File state chứa mật khẩu và key, không được commit.

`limits.test.ts` đổi hạn mức và khóa tenant A. Chỉ bật `TM_ALLOW_MUTATION=1` trên dev/demo, và không chạy song song với isolation. SSRF S7/S8 cần fixture do TV4 cung cấp; nếu thiếu fixture, test đánh dấu SKIP và không được tính là đủ bằng chứng.

## Preflight, deploy và seed demo

Các lệnh nhánh vận hành cũng chạy từ `e2e/`:

```sh
npm run demo:preflight
npm run demo:deploy -- --stage dev --dry-run
npm run demo:seed -- all --dry-run
```

Preflight chỉ gọi API AWS đọc trạng thái; bước kiểm tra Translate dùng `list-terminologies`, không gửi yêu cầu dịch tính phí. Deploy mặc định cần bảy stack entry-point `data.yaml`, `identity.yaml`, `api.yaml`, `edge.yaml`, `workflow.yaml`, `console.yaml`, `ops.yaml` trong `TM_TEMPLATE_DIR`. Có thể chỉ định từng file qua `TM_TEMPLATE_DATA`, `TM_TEMPLATE_IDENTITY`, v.v. Script kiểm tra đủ file trước khi bắt đầu deploy để tránh deploy được vài stack rồi mới gặp file thiếu.

`demo:deploy` chỉ nhận stage `dev` hoặc `demo`, bắt buộc `TM_ACCOUNT` là account ID 12 chữ số, rồi gọi `sts get-caller-identity` và dừng nếu credentials hiện hành không khớp. Kiểm tra này chạy ngay trong lệnh deploy, kể cả khi người chạy bỏ qua preflight; `--dry-run` cũng cần credentials để xác nhận đúng account.

Repo hiện có `infra/modules/{data,iam,lambdas,api-gateway}.yaml` và một `infra/template.yaml`; các file này chưa phải bảy stack entry-point độc lập, và `infra/template.yaml` là template dev riêng. Vì vậy cần cung cấp/ghép các stack templates trước khi deploy thật. `TM_PARAMS_<STACK>` dùng để truyền parameter overrides theo phụ thuộc giữa stack.

Seed tenant yêu cầu `TM_DEMO_ORIGIN_A/B/C` trỏ tới ba hostname khác nhau, có thể truy cập và xác minh bằng META. API tự sinh slug từ hostname. Script lấy `tenant_id` từ ID token Cognito, lưu state trước các thao tác tạo tài nguyên để hỗ trợ chạy lại sau gián đoạn, và tải batch file lên bằng đúng `Content-Type` do API yêu cầu. Nếu xác minh website lỗi hoặc không trả trạng thái `ACTIVE`, seed dừng ngay và hướng dẫn kiểm tra origin/META; state ghi `websiteStatus` và lần chạy lại tiếp tục từng bước thay vì bỏ qua tenant chỉ vì đã có API key. Các trường còn thiếu như API key, TM text/hash, job/file và tiny key của tenant C sẽ được tạo bổ sung. Sau khi sửa origin hoặc cấu hình META, chạy lại `npm run demo:seed -- tenants`. Seed Platform Config vẫn cần route `/platform/config` được triển khai trong API.

Các stack entry-point vẫn chưa có trong `main` hoặc PR 42: `infra/modules/*.yaml` và `infra/template.yaml` là module/template dev, không thay thế bảy entry-point độc lập. Vì vậy phần deploy hiện là script có kiểm tra an toàn và đang chờ PR cung cấp templates; không thể coi repo hiện tại đã triển khai được bảy stack từ đầu.

## Hợp đồng khớp project hiện tại

- Tạo website gửi `home_url`, `display_name`, `source_lang`, `target_langs`. API tự sinh `slug` từ hostname; mỗi tenant demo cần origin có hostname riêng, duy nhất và có thể xác minh.
- Xác minh website gửi `{ "method": "META" }` hoặc `FILE`.
- Platform Admin thuộc Cognito group `PlatformAdmins`.
- Body/các endpoint nghiệp vụ vẫn được gom ở `lib/contract.ts` để dễ cập nhật.

Project hiện tại chưa đăng ký một số route mà bộ nghiệm thu tuần 5 cần, gồm `/console/me`, `/console/tm`, `/console/usage`, `/console/batch/{id}` và các route quản trị danh sách/chi tiết tenant cùng cấu hình platform. Bộ test giữ các ca đó như tiêu chí đầu-cuối; các ca tương ứng chỉ có thể đạt sau khi các route được tích hợp vào sản phẩm và API Gateway. `GET /console/jobs/{id}` và các route website/batch đang có được gọi theo hợp đồng hiện tại.

## Cấu trúc

- `lib/`: cấu hình, Cognito JWT, HTTP retry, API contract, so sánh lỗi và evidence.
- `tests/`: isolation (kịch bản 4), limits (kịch bản 5), SSRF (kịch bản 6).
- `mock/`, `scripts/selftest.ts`: mock và tự kiểm tra offline.
- `demo/`: AWS preflight, deploy bảy stack theo thứ tự và seed tài khoản/dữ liệu demo.
