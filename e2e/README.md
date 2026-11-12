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

Tạo file `.env.<stage>` từ `.env.example`; package tự nạp file stage tương ứng với `TM_STAGE` hoặc `TM_ENV_FILE`. Chạy các lệnh trong thư mục `e2e/`:

```sh
npm run test:isolation
npm run test:ssrf
TM_ALLOW_MUTATION=1 npm run test:limits
npm run typecheck
```

Test cần `.state/<stage>.json` có tài khoản tenant A/B/C, Platform Admin, API keys, job và file_key. File state chứa mật khẩu và key, không được commit. Tạo state bằng `npm run demo:seed -- all` sau khi cấu hình AWS/API.

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

## Cấu trúc

- `lib/`: cấu hình, Cognito JWT, HTTP retry, API contract, so sánh lỗi và evidence.
- `tests/`: isolation (kịch bản 4), limits (kịch bản 5), SSRF (kịch bản 6).
- `mock/`, `scripts/selftest.ts`: mock và tự kiểm tra offline.
- `demo/`: AWS preflight, deploy bảy stack theo thứ tự và seed dữ liệu demo.

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

Seed tenant yêu cầu `TM_DEMO_ORIGIN_A/B/C` trỏ tới ba hostname khác nhau, có thể truy cập và xác minh bằng META. API tự sinh slug từ hostname. Script lấy `tenant_id` từ ID token Cognito, lưu state trước các thao tác tạo tài nguyên để hỗ trợ chạy lại sau gián đoạn, và tải batch file lên bằng đúng `Content-Type` do API yêu cầu. Nếu xác minh website lỗi hoặc không trả trạng thái `ACTIVE`, seed dừng ngay và hướng dẫn kiểm tra origin/META; state ghi `websiteStatus` và lần chạy lại tiếp tục từng bước thay vì bỏ qua tenant chỉ vì đã có API key. Các trường còn thiếu như API key, TM text/hash, job/file và tiny key của tenant C sẽ được tạo bổ sung. Trước khi gửi batch, state lưu `fileKey` cùng trạng thái `SUBMITTING`; nếu tiến trình dừng ở thời điểm phản hồi không rõ, lần chạy sau truy vấn DynamoDB theo partition job của tenant và `fileKey` để lấy lại job hiện hữu trước khi gửi lại. Việc đối soát này cần `TM_TABLE`, quyền `dynamodb:Query`, và chờ ít nhất 90 giây (timeout `TranslateFunction` 60 giây cộng 30 giây đệm; mặc định `TM_BATCH_RECOVERY_WAIT_S=90`). Có thể tăng thời gian chờ nhưng giá trị thấp hơn 90 giây bị từ chối; nếu timeout Lambda thay đổi, cập nhật ngưỡng trong `demo/batchRecovery.ts` cùng template. Script không tự gửi lại nếu truy vấn lỗi hoặc có nhiều job khớp. Sau khi sửa origin hoặc cấu hình META, chạy lại `npm run demo:seed -- tenants`. Seed Platform Config vẫn cần route `/platform/config` được triển khai trong API.

`demo:seed -- tiny-plan` xác nhận API key và usage plan đích trước khi di chuyển key. Nếu thao tác gắn vào tiny plan lỗi, script thử khôi phục association nguồn (Basic/plan tiny trước đó). `npm run test:demo` kiểm tra thứ tự AWS CLI offline bằng `AWS_BIN` giả, không gọi AWS thật.

Các stack entry-point vẫn chưa có trong `main` hoặc PR 42: `infra/modules/*.yaml` và `infra/template.yaml` là module/template dev, không thay thế bảy entry-point độc lập. Vì vậy phần deploy hiện là script có kiểm tra an toàn và đang chờ PR cung cấp templates; không thể coi repo hiện tại đã triển khai được bảy stack từ đầu.
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
