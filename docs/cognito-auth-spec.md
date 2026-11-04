# Đặc Tả Cấu Hình Cognito User Pool, IAM Policy & Kịch Bản Kiểm Thử (Nhiệm Vụ 1.11)

Tài liệu này dành cho **TV1 (IaC Terraform/CDK)** và **TV3 (REST API / Authorizer)** để triển khai hệ thống xác thực & quản lý Tenant của **TranslateMe**.

---

## A. Đặc tả cấu hình Amazon Cognito User Pool (Giao TV1 chuyển thành Terraform/CDK)

> **Lưu ý bắt buộc:** Không tạo tài nguyên bằng tay trên AWS Console. Đặc biệt, **thuộc tính tùy chỉnh (`custom:*`) của Cognito không thể sửa đổi kiểu dữ liệu hoặc xóa sau khi User Pool đã tạo**, nên cần khai báo chính xác tên và kiểu ngay từ lần `terraform apply` / `cdk deploy` đầu tiên.

### 1. Bảng thông số User Pool (`aws_cognito_user_pool`)

| Nhóm cấu hình | Tham số IaC (Terraform / CDK) | Giá trị bắt buộc | Ghi chú kỹ thuật / Lý do bảo mật |
| :--- | :--- | :--- | :--- |
| **Đăng nhập (Sign-in)** | `username_attributes` | `["email"]` | Người dùng đăng nhập trực tiếp bằng địa chỉ email. |
| **Phân biệt chữ hoa/thường** | `username_configuration.case_sensitive` | `false` | Tránh tạo 2 tài khoản trùng email chỉ khác chữ hoa/thường (`User@x.com` vs `user@x.com`). |
| **Tự xác minh (Auto-verify)** | `auto_verified_attributes` | `["email"]` | Tự động gửi mã xác minh qua email khi đăng ký. |
| **Phương thức xác minh** | `verification_message_template.default_email_option` | `"CONFIRM_WITH_CODE"` | Xác minh email bằng **mã 6 chữ số** (OTP), không dùng link. |
| **Chính sách mật khẩu** | `password_policy` | - `minimum_length = 8`<br/>- `require_uppercase = true`<br/>- `require_lowercase = true`<br/>- `require_numbers = true`<br/>- `require_symbols = false`<br/>- `temporary_password_validity_days = 7` | Đúng yêu cầu: tối thiểu 8 ký tự, có chữ hoa, chữ thường và chữ số. Mật khẩu tạm khi mời thành viên có hạn 7 ngày. |
| **Tự đăng ký & Admin tạo user** | `admin_create_user_config.allow_admin_create_user_only` | `false` | `false` để vừa cho phép khách hàng tự đăng ký (SignUp), vừa cho phép hàm `inviteMember` gọi `AdminCreateUser`. |
| **Khôi phục tài khoản** | `account_recovery_setting` | `verified_email` (priority `1`) | Khôi phục mật khẩu qua email đã xác minh. |
| **Lambda Trigger** | `lambda_config.post_confirmation` | ARN của Lambda `postConfirmation` | Gắn trigger Post Confirmation để khởi tạo Tenant & gán quyền `Tenant Admin`. |

### 2. Bảng thuộc tính tùy chỉnh (Custom Schema Attributes)

> **CẢNH BÁO QUAN TRỌNG CHO IaC:** Khi khai báo trong Terraform (`schema` block), Cognito tự động thêm tiền tố `custom:` khi đọc/ghi qua SDK, nên trong cấu hình `schema.name` của Terraform chỉ viết `"tenant_id"` và `"role"`. Khi đọc/ghi từ SDK hoặc cấu hình `read_attributes`, tên đầy đủ là `"custom:tenant_id"` và `"custom:role"`.

| Tên đầy đủ khi dùng SDK | Tên trong `schema` IaC | `attribute_data_type` | `mutable` | `required` | Ràng buộc độ dài (`string_attribute_constraints`) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `custom:tenant_id` | `tenant_id` | `"String"` | `true` | `false` | `min_length = 1`, `max_length = 64` |
| `custom:role` | `role` | `"String"` | `true` | `false` | `min_length = 1`, `max_length = 32` |

*(Lưu ý: Custom attribute trong Cognito bắt buộc `required = false`; `mutable = true` để Lambda Trigger và Admin API cập nhật được vai trò/tenant).*

### 3. Cấu hình App Client cho Web Console (`aws_cognito_user_pool_client`)

| Tham số IaC | Giá trị bắt buộc | Giải thích bảo mật |
| :--- | :--- | :--- |
| `generate_secret` | `false` | Ứng dụng SPA/Web Console chạy trên trình duyệt không thể giữ bí mật `client_secret`. |
| `explicit_auth_flows` | `["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]` | Sử dụng giao thức SRP (`USER_SRP_AUTH`), mật khẩu không bao giờ đi qua mạng dạng rõ. |
| `prevent_user_existence_errors` | `"ENABLED"` | **Bắt buộc:** Chống dò tài khoản (User Enumeration) — trả cùng thông báo lỗi khi sai email hoặc sai mật khẩu. |
| `read_attributes` | `["email", "email_verified", "name", "custom:tenant_id", "custom:role"]` | Cho phép Web Console đọc `custom:tenant_id` và `custom:role`. |
| `write_attributes` | `["email", "name"]` | **TUYỆT ĐỐI KHÔNG chứa `custom:tenant_id` và `custom:role`**. Ngăn người dùng dùng Access Token tự nâng quyền (`UpdateUserAttributes`) lên `Tenant Admin` hoặc nhảy sang tenant khác. |

### 4. Nhóm người dùng cho Platform Admin (`aws_cognito_user_group`)

| Tham số | Giá trị | Ghi chú |
| :--- | :--- | :--- |
| `name` | `"PlatformAdmins"` | Nhóm riêng cho quản trị viên hệ thống TranslateMe. |
| `description` | `"Platform Administrators (no tenant association)"` | Người dùng trong nhóm này được tạo bởi quản trị hệ thống, **không có `custom:tenant_id`**, được Authorizer nhận diện qua claim `cognito:groups` chứa `"PlatformAdmins"`. |

---

## D. Chính sách IAM Tối thiểu (Least-Privilege IAM Policies) & Cách tránh vòng lặp phụ thuộc IaC

### 1. IAM Policy cho Lambda Trigger `PostConfirmation`

Lambda Trigger chỉ được phép:
- Ghi giao dịch (`dynamodb:TransactWriteItems`, `dynamodb:PutItem`) trên **đúng ARN của bảng DynamoDB**.
- Sử dụng khóa KMS (`kms:Decrypt`, `kms:GenerateDataKey`) của bảng đó (nếu bảng dùng Customer Managed CMK).
- Gán thuộc tính (`cognito-idp:AdminUpdateUserAttributes`) trên **đúng ARN của User Pool** (hoặc ghép theo pattern `arn:aws:cognito-idp:${Region}:${Account}:userpool/*` để tránh circular dependency — xem mục D.3).

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowDynamoDBTenantInitTransaction",
      "Effect": "Allow",
      "Action": [
        "dynamodb:TransactWriteItems",
        "dynamodb:PutItem"
      ],
      "Resource": "arn:aws:dynamodb:${AWS_REGION}:${AWS_ACCOUNT_ID}:table/${TABLE_NAME}"
    },
    {
      "Sid": "AllowTableKmsKeyIfCustomerManaged",
      "Effect": "Allow",
      "Action": [
        "kms:Decrypt",
        "kms:GenerateDataKey"
      ],
      "Resource": "arn:aws:kms:${AWS_REGION}:${AWS_ACCOUNT_ID}:key/${DYNAMODB_KMS_KEY_ID}",
      "Condition": {
        "StringEquals": {
          "kms:ViaService": "dynamodb.${AWS_REGION}.amazonaws.com"
        }
      }
    },
    {
      "Sid": "AllowSetTenantAttributesOnUserPool",
      "Effect": "Allow",
      "Action": [
        "cognito-idp:AdminUpdateUserAttributes"
      ],
      "Resource": "arn:aws:cognito-idp:${AWS_REGION}:${AWS_ACCOUNT_ID}:userpool/${USER_POOL_ID}"
    }
  ]
}
```

### 2. IAM Policy cho Lambda Mời Thành Viên (`inviteMember` trong REST API)

Lambda xử lý API mời thành viên chỉ cần quyền `cognito-idp:AdminCreateUser` trên đúng User Pool (cộng với quyền ghi bản ghi `MEMBER` chờ đăng nhập vào bảng DynamoDB ở tầng API):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowAdminCreateInvitedUser",
      "Effect": "Allow",
      "Action": [
        "cognito-idp:AdminCreateUser"
      ],
      "Resource": "arn:aws:cognito-idp:${AWS_REGION}:${AWS_ACCOUNT_ID}:userpool/${USER_POOL_ID}"
    }
  ]
}
```

### 3. Cách tránh lỗi Vòng lặp phụ thuộc (Circular Dependency) trong Terraform / CDK

**Nguyên nhân gây vòng lặp:**
1. `Cognito User Pool` cần ARN của `PostConfirmation Lambda` trong `lambda_config.post_confirmation`.
2. `PostConfirmation Lambda` (hoặc IAM Role của nó) lại tham chiếu tới `UserPool.arn` / `UserPool.id` trong IAM Policy hoặc biến môi trường, đồng thời `aws_lambda_permission` cần `source_arn = UserPool.arn`.

**Cách giải quyết chuẩn cho TV1:**
- **Trong code Lambda (`postConfirmation.ts`):** Đã lấy trực tiếp `event.userPoolId` từ payload sự kiện Cognito truyền vào, nên **Lambda Trigger KHÔNG cần biến môi trường `USER_POOL_ID`**.
- **Trong IAM Role Policy của Lambda Trigger:** Không tham chiếu trực tiếp `aws_cognito_user_pool.main.arn` nếu tạo Role trước User Pool. Thay vào đó:
  - **Cách 1 (Ghép chuỗi ARN bằng biến Region & Account):** Đặt `Resource = "arn:aws:cognito-idp:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:userpool/*"`, hoặc giới hạn thêm bằng tag `aws:ResourceTag/Project = "TranslateMe"`.
  - **Cách 2 (Tách `aws_iam_role_policy` rời):** Tạo `aws_iam_role` -> tạo `aws_lambda_function` -> tạo `aws_cognito_user_pool` (gắn `lambda_config`) -> sau cùng mới tạo `aws_iam_role_policy` (gắn vào Role) và `aws_lambda_permission` (gắn vào Lambda). Khi đó đồ thị phụ thuộc là một chiều (DAG), không bao giờ bị chu trình.

---

## E. Kịch bản Kiểm thử Thủ công sau khi Triển khai (Post-Deployment Manual Checklist)

Sau khi TV1 deploy hạ tầng lên AWS, chạy lần lượt 6 kịch bản dưới đây để nghiệm thu:

- [ ] **1. Đăng ký -> Nhập mã OTP -> Kiểm tra DynamoDB & Cognito Attributes:**
  - Thực hiện `SignUp` với email thật, mật khẩu hợp lệ (ví dụ `TransMe2026`) và `ClientMetadata = { organization_name: "Demo Org" }`.
  - Nhập mã 6 chữ số nhận qua email vào `ConfirmSignUp`.
  - Mở bảng DynamoDB kiểm tra có **đúng 2 bản ghi** cùng `PK = "TENANT#t_..."`:
    - Bản ghi `SK = "CONFIG"` có `organizationName = "Demo Org"`, `plan = "Free"`, `status = "ACTIVE"`, `glossaryVersion = 0`.
    - Bản ghi `SK = "MEMBER#<sub>"` có `email`, `role = "Tenant Admin"`, `status = "ACTIVE"`.
  - Kiểm tra user trên Cognito đã có `custom:tenant_id = "t_..."` và `custom:role = "tenant_admin"` (các deployment cũ có thể đang lưu `Tenant Admin` và được đọc tương thích).

- [ ] **2. Đăng ký trùng email:**
  - Gọi lại `SignUp` với cùng địa chỉ email vừa xác nhận (thử cả viết hoa `USER@domain.com`).
  - Xác nhận Cognito từ chối đăng ký trùng và bảng DynamoDB không phát sinh thêm bản ghi nào.

- [ ] **3. Mật khẩu yếu bị từ chối:**
  - Thử `SignUp` với các mật khẩu: `< 8 ký tự` (`Abc123`), thiếu chữ hoa (`transme123`), thiếu chữ thường (`TRANSME123`), thiếu chữ số (`TransMeAbc`).
  - Xác nhận tất cả đều bị Cognito từ chối với lỗi `InvalidPasswordException`.

- [ ] **4. Chặn leo thang đặc quyền từ App Client (`WriteAttributes`):**
  - Đăng nhập lấy `AccessToken` hợp lệ từ Web Console App Client.
  - Dùng AWS CLI gọi:
    ```bash
    aws cognito-idp update-user-attributes \
      --access-token "<ACCESS_TOKEN>" \
      --user-attributes Name=custom:role,Value="Platform Admin" Name=custom:tenant_id,Value="t_other"
    ```
  - **Kết quả bắt buộc:** Bị từ chối với lỗi `NotAuthorizedException: A client attempted to write unauthorized attribute`.

- [ ] **5. Chống dò tài khoản (`PreventUserExistenceErrors = ENABLED`):**
  - Thử đăng nhập với một email **chưa từng tồn tại** (`nonexistent_999@example.com`) và một email **đã tồn tại nhưng nhập sai mật khẩu**.
  - **Kết quả bắt buộc:** Cả hai trường hợp đều trả về cùng một mã lỗi và thông điệp giống hệt nhau (`NotAuthorizedException: Incorrect username or password.`), không tiết lộ lỗi `UserNotFoundException`.

- [ ] **6. Mời thành viên -> Đăng nhập mật khẩu tạm -> Buộc đổi mật khẩu:**
  - Gọi hàm `inviteMember(tenantId, "reviewer1@example.com", "REVIEWER")`.
  - Kiểm tra hộp thư `reviewer1@example.com` nhận được email chứa mật khẩu tạm; trạng thái user trên Cognito là `FORCE_CHANGE_PASSWORD`, có sẵn `custom:tenant_id` và `custom:role = "reviewer"`.
  - Dùng mật khẩu tạm đăng nhập trên Web Console -> Cognito trả về challenge `NEW_PASSWORD_REQUIRED` buộc người dùng đặt mật khẩu mới trước khi cấp token.
