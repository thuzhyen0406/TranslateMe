# Review PR #25 — Task 3.1 và 3.2

PR hiện vẫn mở trên revision `4022b98`. Mình không chạy test; GitHub không trả về commit status checks cho revision này.

**Phần tốt:** Các vấn đề cũ về điều kiện `pauseSite`/`resumeSite`, retry invalidation, `dynamoSiteResolver` và lệnh test `libs/common` đã được xử lý trong diff hiện tại. `iam.yaml` tách execution role theo Lambda và giới hạn truy cập DynamoDB theo tenant.

## 🔴 Cần sửa trước khi merge

**`invalidateForSites` có thể chỉ xoá cache cho 15 website đầu tiên (`libs/common/invalidation.ts`)**

Hàm chia danh sách thành từng lô tối đa 15 wildcard rồi gửi lần lượt, nhưng CloudFront xử lý invalidation bất đồng bộ. Lô sau được gửi khi wildcard của lô trước vẫn còn đang chạy; giới hạn CloudFront là 15 wildcard invalidation đang hoạt động. Với tenant có hơn 15 website, các lô tiếp theo có thể lỗi `TooManyInvalidationsInProgress`. Hàm vẫn đổi trạng thái tenant/site trước khi invalidation hoàn tất, nên một phần cache cũ có thể tiếp tục được phục vụ. [AWS ghi giới hạn 15 invalidation wildcard đang hoạt động](https://docs.aws.amazon.com/general/latest/gr/cf_region.html).

→ Chờ invalidation trước đó hoàn tất hoặc xử lý hàng đợi và retry các đường dẫn thất bại; thêm test với hơn 15 website để xác nhận mọi đường dẫn được xoá.

## 🟡 Nên sửa hoặc cần chốt

- **`contextFromIdTokenClaims` chưa được nối vào handler nào (`services/api/auth/context.ts`).** Hàm yêu cầu bản ghi MEMBER đang ACTIVE. Nhưng `inviteMember` chỉ tạo user trên Cognito, không ghi MEMBER vào DynamoDB. Khi hàm này được dùng để xác thực API, thành viên được mời sẽ bị `PERMISSION_DENIED`. Nên thống nhất với PR #23 nơi kiểm tra thành viên, đồng thời tạo MEMBER trong luồng mời hoặc chấp nhận lời mời.
- Chưa có kết quả CI/test cho head hiện tại để xác nhận các thay đổi.

## Kết luận

Request changes vì giới hạn invalidation có thể khiến thao tác lock tenant hoặc pause website chỉ xoá cache một phần.
