# Triển khai TranslateMe lên AWS

Một lệnh `npm run demo:deploy` (trong `e2e/`) dựng toàn bộ hệ thống cho stage `dev` hoặc `demo` trong account 941490574112, region `ap-southeast-1`. Script tự build và đóng gói Lambda, deploy bootstrap + 7 stack, chạy lượt 2, build và đăng web console, rồi in cấu hình cho `e2e/.env.<stage>`.

## 1. Chuẩn bị (một lần)

- AWS CLI v2 đăng nhập đúng account: `aws sts get-caller-identity` phải ra `941490574112`.
- Node.js 20+, `npm`, `zip` (hoặc `python3`).
- Trong `e2e/`: `npm ci`, rồi tạo `e2e/.env.dev` tối thiểu:

```sh
TM_STAGE=dev
TM_ACCOUNT=941490574112
TM_REGION=ap-southeast-1
TM_ALERT_EMAIL=<email nhận cảnh báo Budgets/alarm>   # tùy chọn
```

- Kiểm tra điều kiện account (hướng dẫn tuần 5, mục 2.2): Translate dùng được, Service Quotas "Concurrent executions" của Lambda, AWS Budgets. Ghi hạn mức Lambda đồng thời thực tế vào báo cáo.
- Stack cũ `translateme-dev-stack` (Hello Lambda + budget, từ `infra/template.yaml`) không thuộc hệ thống; xóa đi để khỏi trùng budget: `aws cloudformation delete-stack --stack-name translateme-dev-stack`.

## 2. Deploy

```sh
cd e2e
set -a; . ./.env.dev; set +a
npm run demo:deploy -- --stage dev --dry-run   # xem trước các lệnh ghi
npm run demo:deploy -- --stage dev             # lần đầu khoảng 15–25 phút (CloudFront chiếm phần lớn)
```

Script làm theo thứ tự:

| Bước | Stack / việc | Nội dung |
| --- | --- | --- |
| 0 | `translateme-dev-bootstrap` | Bucket chứa gói mã Lambda và template lồng nhau |
| 1 | gói mã | `services/proxy` và `services/api`: `npm ci`, `tsc`, gói `dist` + `node_modules` production, tải lên S3 với khóa theo hash nội dung |
| 2 | `data` | DynamoDB `translateme-dev`, KMS `alias/translateme-dev-data`, bucket payload worker, bucket tệp batch |
| 3 | `identity` | Cognito User Pool, client `console` và `platform`, nhóm `PlatformAdmins` |
| 4 | `api` | IAM (role theo tenant), 13 Lambda, REST API + usage plan Basic/Standard |
| 5 | `edge` | CloudFront → Function URL (AWS_IAM, OAC) của proxy, CloudFront Function kiểm tra slug, cache theo `s-maxage` |
| 6 | `workflow` | State machine BATCH (F10) và PREWARM (F6) |
| 7 | `console` | S3 + CloudFront cho web console |
| 8 | `ops` | Budget theo stage (50 %, 80 %, dự báo 100 %), SNS, alarm proxy/API/state machine |
| 9 | lượt 2 | `identity`: gắn trigger Post confirmation; `api`: ID usage plan, ID CloudFront, `PUBLIC_BASE_URL` |
| 10 | web console | `npm run build` với `VITE_*` lấy từ output, `s3 sync`, xóa cache `/*` |

Lượt 2 cần vì các phụ thuộc vòng: CloudFront cần Lambda proxy có trước, còn Lambda lại cần ID CloudFront (xóa cache) và ID usage plan; Cognito cần ARN Lambda Post confirmation. Từ lần deploy thứ hai, script đọc output các stack có sẵn nên lượt 1 đã đủ tham số và không có lượt 2.

Cuối cùng script in khối `TM_*` (lưu ở `.build/dev/e2e.env`) để dán vào `e2e/.env.dev`, rồi chạy `npm run demo:preflight -- --post`.

### Tùy chọn

| Cờ / biến | Tác dụng |
| --- | --- |
| `--only <stack>` | Chỉ deploy một stack (bootstrap hoặc một trong 7), không lượt 2 |
| `--skip-build` | Dùng lại gói mã Lambda đang chạy (chỉ đổi hạ tầng) |
| `--no-install` | Bỏ `npm ci` (đã cài sẵn) |
| `--skip-console` | Không build/đăng web console |
| `TM_CONSOLE_AUTH_MODE` | `cognito` (mặc định, đăng nhập Cognito thật) hoặc `mock` (kho giả lập trong trình duyệt, chỉ để thử giao diện) |
| `TM_CODE_KEYS="proxy=… api=…"` | Dùng gói mã đã tải sẵn (CI) |
| `TM_STATE_CACHE_S` | Ghi đè `StateCacheSeconds` (mặc định 30) |
| `TM_PARAMS_<STACK>="K=V …"` | Thêm tham số CloudFormation cho một stack |

## 3. Sau khi deploy

1. Dán khối `TM_*` vào `e2e/.env.dev`; tạo Platform Admin: `aws cognito-idp admin-add-user-to-group --user-pool-id <TM_CONSOLE_USER_POOL_ID> --username <email> --group-name PlatformAdmins` (sau khi người đó đăng ký), hoặc để `demo:seed` tạo.
2. Đăng 3 website mẫu và chạy seed: `e2e/sites/README.md`.
3. Kiểm thử và thu bằng chứng: KB4–KB6 (`test:isolation`, `test:limits`, `test:ssrf`, `npm run evidence`), 5.4 (`demo:proxy-check`), KB3 (`demo:latency`), KB8 (`demo:kb8 -- --prepare`).

## 4. Stage demo

Chỉ deploy từ thẻ phát hành sạch, có người duyệt; bảng DynamoDB bật deletion protection:

```sh
git tag v1.0.0 && git push origin v1.0.0
npm run demo:deploy -- --stage demo --approved-by "<tên>"
```

Chạy lại bộ cô lập tenant và SSRF trên demo trước khi thu số liệu (QC-11).

## 5. Gỡ

Xóa theo thứ tự ngược (stack sau import output stack trước): `ops`, `console`, `workflow`, `edge`, `api`, `identity`, `data`, `bootstrap`. Bucket còn object thì xóa object trước (`aws s3 rm s3://<bucket> --recursive`); bucket payload và batch có versioning nên dùng console S3 "Empty". Bảng demo có deletion protection.

## 6. Giới hạn đã biết của hạ tầng

- Không có tên miền riêng: bản dịch ở `https://<dxxxx>.cloudfront.net/{slug}/{lang}/` (BASE_MODE=path).
- `TENANT_ID_HMAC_SECRET` chưa cấu hình cho Lambda Post confirmation: mã tenant sinh bằng khóa ngẫu nhiên theo phiên chạy; nếu Cognito gọi lại trigger ở phiên khác sau khi đã ghi DynamoDB, có thể sinh mã khác.
- Web console mặc định build ở chế độ `cognito`: đăng ký, xác nhận email, đăng nhập, mời thành viên đi qua Cognito và API thật. Mã xác nhận và mật khẩu tạm thời do Cognito gửi bằng email mặc định của Cognito (giới hạn khoảng 50 email/ngày, đủ cho demo).
- Console (CloudFront riêng) gọi API ở `execute-api` khác origin: Lambda console/website trả header CORS (`libs/common/cors.ts`), lỗi do API Gateway tự trả (401/403/429/5XX) có CORS qua `GatewayResponse`. Khi đổi method hoặc gateway response trong `infra/modules/api-gateway.yaml`, phải đổi tên logical ID `ApiDeploymentV<n>` để stage nhận bản deploy mới.
- `dynamodb:TransactWriteItems` trong policy không phải action IAM thật (cfn-lint W3037); quyền giao dịch tính theo từng thao tác trên item nên không ảnh hưởng.
