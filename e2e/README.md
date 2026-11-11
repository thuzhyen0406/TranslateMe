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

Tạo file `.env.<stage>` từ `.env.example`; package tự nạp file tương ứng với `TM_STAGE` (hoặc file được chỉ định bằng `TM_ENV_FILE`). Chạy các lệnh trong thư mục `e2e/`:

```sh
npm run test:isolation
npm run test:ssrf
TM_ALLOW_MUTATION=1 npm run test:limits
```

Test cần `.state/<stage>.json` có tài khoản tenant A/B/C, Platform Admin, API keys, job và file_key. Tạo state bằng `npm run demo:seed -- all` sau khi cấu hình AWS và API. File state chứa mật khẩu và key, không được commit.

`limits.test.ts` đổi hạn mức và khóa tenant A. Chỉ bật `TM_ALLOW_MUTATION=1` trên dev/demo, và không chạy song song với isolation. SSRF S7/S8 cần fixture do TV4 cung cấp; nếu thiếu fixture, test đánh dấu SKIP và không được tính là đủ bằng chứng. Vì API chưa có route xóa website, test sẽ nhận diện slug từ hostname fixture và tái sử dụng bản ghi `PENDING` cùng origin ở lần chạy sau; nếu slug đó đã được dùng bởi origin khác hoặc website không còn `PENDING`, test dừng với thông báo rõ ràng.

## Preflight, deploy và seed demo

Các lệnh nhánh vận hành cũng chạy từ `e2e/`:

```sh
npm run demo:preflight
npm run demo:deploy -- --stage dev --dry-run
npm run demo:seed -- all --dry-run
```

Preflight chỉ gọi API AWS đọc trạng thái; bước kiểm tra Translate dùng `list-terminologies`, không gửi yêu cầu dịch tính phí. Deploy mặc định cần bảy stack entry-point `data.yaml`, `identity.yaml`, `api.yaml`, `edge.yaml`, `workflow.yaml`, `console.yaml`, `ops.yaml` trong `TM_TEMPLATE_DIR`. Có thể chỉ định từng file qua `TM_TEMPLATE_DATA`, `TM_TEMPLATE_IDENTITY`, v.v. Script kiểm tra đủ file trước khi bắt đầu deploy để tránh deploy được vài stack rồi mới gặp file thiếu.

Repo hiện có `infra/modules/{data,iam,lambdas,api-gateway}.yaml` và một `infra/template.yaml`; các file này chưa phải bảy stack entry-point độc lập, và `infra/template.yaml` là template dev riêng. Vì vậy cần cung cấp/ghép các stack templates trước khi deploy thật. `TM_PARAMS_<STACK>` dùng để truyền parameter overrides theo phụ thuộc giữa stack.

Seed tenant yêu cầu `TM_DEMO_ORIGIN_A/B/C` trỏ tới ba hostname khác nhau, có thể truy cập và xác minh bằng META. API tự sinh slug từ hostname. Script lấy `tenant_id` từ ID token Cognito, lưu state trước các thao tác tạo tài nguyên để hỗ trợ chạy lại sau gián đoạn, và tải batch file lên bằng đúng `Content-Type` do API yêu cầu. Seed Platform Config vẫn cần route `/platform/config` được triển khai trong API.

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

## Evidence report (hạng mục 5.2)

Mỗi phép thử ghi một dòng JSONL vào `e2e/evidence/<run-id>/scenario-<n>.jsonl`. Tổng hợp các log sau khi chạy:

```sh
TM_RUN_ID=local npm run test:gate
npm run evidence -- local
```

Lệnh tạo `e2e/evidence/local/summary.md`, giữ kết quả mới nhất của mỗi mã kiểm thử và phân biệt `ĐẠT`, `LỖI`, `BỎ QUA`, `THIẾU`. Mặc định thiếu hoặc skip tiêu chí bắt buộc làm lệnh trả mã khác 0; `--allow-incomplete` chỉ dùng khi rà soát một lần chạy chưa đủ suite và không bỏ qua lỗi thực tế. Có thể chỉ định tập scenario bắt buộc qua `TM_EVIDENCE_REQUIRED_SCENARIOS` (mặc định `4,5,6`). Evidence có thể chứa mã lỗi và dữ liệu quan sát; kiểm tra trước khi chia sẻ ra ngoài nhóm. Thư mục evidence bị gitignore.

## GitHub Actions release gate (hạng mục 5.2)

`.github/workflows/release-gate.yml` chạy sau workflow deploy thành công trên `main`, hoặc thủ công qua `workflow_dispatch`. Nó kiểm tra trạng thái stack `translateme-dev-stack` (có thể đổi bằng Actions variable `TM_DEPLOY_STACK_NAME`) rồi chạy isolation và SSRF; test giới hạn có side effect chỉ chạy khi dispatch và bật `run_limits` trên môi trường dev.

Thiết lập repository secrets:

- `AWS_ROLE_ARN`: role có OIDC trust cho GitHub Actions và quyền đọc trạng thái stack. Workflow deploy hiện dùng ARN cố định; thống nhất role trước khi vận hành gate.
- `TM_CI_ENV`: nội dung dotenv có tối thiểu `TM_API_BASE`, `TM_REGION`, `TM_CONSOLE_CLIENT_ID`, `TM_PLATFORM_CLIENT_ID`, `TM_CONSOLE_USER_POOL_ID`, `TM_PLATFORM_USER_POOL_ID`; thêm `TM_PUBLIC_BASE` và các biến fixture SSRF để chạy đủ ca phụ thuộc fixture.
- `TM_STATE_JSON`: JSON theo schema `e2e/lib/state.ts`, gồm thông tin tenant A/B/C, Platform Admin, API keys và fixture job/file cần cho bộ test.

Thiết lập Actions variables `TM_REGION`, `TM_ACCOUNT` (khuyến nghị) và `TM_DEPLOY_STACK_NAME` nếu stack khác mặc định. Workflow ghi `.env.ci` và `.state/ci.json` tạm thời, không upload chúng; chỉ artifact evidence được lưu 90 ngày. Kịch bản 4 và 6 là bắt buộc trong gate, nên thiếu/skip tiêu chí hoặc lỗi sẽ làm job thất bại. Kịch bản 5 không bắt buộc trong lần chạy tự động; khi bật `run_limits`, nó cũng trở thành tiêu chí bắt buộc.

Deploy hiện hành chỉ triển khai một stack `translateme-dev-stack`. Script demo của nhánh vận hành 5.3 có quy trình bảy stack; workflow gate không gọi `demo:preflight -- --post` vì các stack entry-point đó chưa có trong repo và trạng thái deploy thực tế hiện không khớp. Khi chuyển deploy sang bảy stack, cập nhật xác nhận stack ở workflow này đồng thời với PR deploy.

## Tài liệu nhánh

Xem [BRANCHES.md](../BRANCHES.md) để biết thứ tự phụ thuộc, phạm vi từng PR và script hiển thị trạng thái nhánh.
