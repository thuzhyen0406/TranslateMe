# Week 5 TV1 branch and PR map

Các PR được merge theo thứ tự dependency dưới đây. Tên nhánh có thể khác đôi chút trong repo thực tế; giữ nội dung và thứ tự dependency nhất quán.

| Thứ tự | Nhánh nhiệm vụ | Phạm vi | Dependency |
|---|---|---|---|
| 1 | `test/tv1-harness-and-suites` (hiện có thể là `harness-and-suites`) | `e2e/lib/`, mock/selftest và suite isolation, limits, SSRF | Không |
| 2 | `task/tv1-demo-deploy-and-preflight` (hiện có thể là `demo-deploy-and-preflight`) | `e2e/demo/`, stage env, deploy/preflight/seed và state cho demo | PR 1 |
| 3 | `task/tv1-evidence-report-and-ci` (nhánh hiện tại `evidence-report-and-ci`) | evidence aggregator, GitHub release gate, runbook và bản đồ nhánh | PR 1 và PR 2 |

## Merge và vận hành

1. Merge PR 1 trước; PR 2 và PR 3 dùng helper/contracts và suite đã bổ sung ở đó.
2. Merge PR 2 kế tiếp; PR 3 dựa trên `.env` loader và demo/state conventions của PR 2.
3. Merge PR 3 cuối; workflow mới được kích hoạt sau deploy thành công trên `main`.
4. Nếu đổi tên branch, cập nhật bảng này và xác nhận trigger workflow deploy vẫn có tên `Deploy Infrastructure via CloudFormation`.

Chạy `bash scripts/git-branches.sh` để xem các branch liên quan đang có trong checkout và các lệnh chuyển nhánh tương ứng. Script chỉ đọc, không tạo, checkout, merge hay xóa branch.

## Lưu ý tích hợp

- API hiện tại chưa triển khai một số route được yêu cầu bởi suite (chi tiết ở `e2e/README.md`); release gate sẽ đỏ nếu các tiêu chí bắt buộc này chưa được tích hợp.
- Deploy workflow gốc dùng một CloudFormation stack với role ARN cố định; cấu hình OIDC/role của release gate phải được cung cấp qua secret `AWS_ROLE_ARN` và cùng tài khoản/region.
- Demo 5.3 mô tả bảy stack entry-point nhưng repo hiện mới có `infra/template.yaml` và module templates. Không chạy seed/deploy thật cho đến khi các templates và state/credentials cho môi trường demo sẵn sàng.
- Không đưa `.env.*`, `.state/` hoặc evidence raw vào commit; evidence có thể chứa thông tin nhạy cảm từ response.
