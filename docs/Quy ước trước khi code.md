# 📌 Quy Ước Trước Khi Code — TranslateMe
*(Tổng hợp từ Nhiệm vụ 1.10 `safe_fetch`, Nhiệm vụ 1.11 `Cognito Auth` và Nhiệm vụ 1.12 `AWS Translate & Comprehend Experiments`)*

Tài liệu này chốt toàn bộ **chữ ký hàm, hằng số vai trò, cấu trúc bản ghi DynamoDB, biến môi trường và quy tắc xử lý HTML/Terminology** đã được cài đặt sẵn trong repo để các thành viên (**TV1, TV2, TV3, Frontend Console**) gọi và ghép nối thống nhất 100%, không bị lệch kiểu dữ liệu hay tên biến.

---

## MỤC LỤC NHANH THEO THÀNH VIÊN
1. [Quy ước chung toàn dự án (Runtime, Build, Test)](#1-quy-ước-chung-toàn-dự-án)
2. [Dành cho TV1 (IaC Terraform/CDK & CI/CD GitHub Actions)](#2-dành-cho-tv1-iac-terraformcdk--cicd)
3. [Dành cho TV2 (Lambda Proxy `F2`, Xác minh website `F1`, Sitemap `F6`)](#3-dành-cho-tv2-lambda-proxy-f2-xác-minh-f1-sitemap-f6)
4. [Dành cho TV3 (REST API `F9/F10`, Authorizer, Glossary `F4`, Quota & DynamoDB)](#4-dành-cho-tv3-rest-api-authorizer-glossary-f4--dynamodb)
5. [Dành cho Thành viên làm Web Console (Frontend)](#5-dành-cho-thành-viên-làm-web-console-frontend)

---

## 1. Quy ước chung toàn dự án

- **Runtime bắt buộc:** Node.js 20 (`nodejs20.x`), viết bằng TypeScript (`ES2022`, ESM `"type": "module"`).
- **AWS SDK:** Dùng **AWS SDK v3** (`@aws-sdk/client-*`). Không bao giờ hard-code Access Key hay Region trong code.
- **Công cụ Test trên CI:** Dùng `node:test` tích hợp sẵn của Node 20 (không cài Jest/Vitest). Tất cả unit test chạy offline qua Dependency Injection (mock client/resolver/transport).

---

## 2. Dành cho TV1 (IaC Terraform/CDK & CI/CD)

### 2.1. Danh sách Lambda cần khai báo từ phần 1.11
| Tên Lambda | Đường dẫn Handler (sau khi build TS) | Runtime | Biến môi trường cần truyền |
| :--- | :--- | :---: | :--- |
| **Cognito PostConfirmation Trigger** | `services/api/dist/services/api/auth/postConfirmation.handler` | `nodejs20.x` | - `TABLE_NAME`: Tên bảng DynamoDB chính<br/>- `FREE_TIER_CHAR_LIMIT`: `"50000"`<br/>- `TENANT_ID_HMAC_SECRET`: Chuỗi bí mật ngẫu nhiên |
| **REST API (có dùng `inviteMember`)** | *(Theo router của TV3 trong `services/api`)* | `nodejs20.x` | - `TABLE_NAME`: Tên bảng DynamoDB chính<br/>- `USER_POOL_ID`: ID của Cognito User Pool |

> **Mẹo tránh lỗi Vòng lặp phụ thuộc (Circular Dependency) trong Terraform/CDK:**  
> Code trong `services/api/auth/postConfirmation.ts` đã đọc trực tiếp `event.userPoolId` từ sự kiện Cognito truyền vào, nên **TV1 KHÔNG cần truyền biến môi trường `USER_POOL_ID` vào Lambda PostConfirmation Trigger**. Trong IAM Policy của Trigger, TV1 có thể ghép chuỗi ARN `arn:aws:cognito-idp:${region}:${account_id}:userpool/*` hoặc tách `aws_iam_role_policy` thành resource rời tạo sau User Pool.

### 2.2. Cấu hình Cognito User Pool & IAM Policy tối thiểu
Toàn bộ bảng cấu hình chi tiết cho User Pool, App Client và JSON IAM Policy đã đặt sẵn tại [`docs/cognito-auth-spec.md`](./cognito-auth-spec.md). Các thông số cốt lõi TV1 phải giữ đúng:
- **Đăng nhập:** `username_attributes = ["email"]`, `case_sensitive = false`.
- **Xác minh:** Tự xác minh `email` bằng mã 6 chữ số (`CONFIRM_WITH_CODE`).
- **Password Policy:** Tối thiểu `8` ký tự, bắt buộc chữ hoa (`uppercase`), chữ thường (`lowercase`) và chữ số (`numbers`).
- **2 Custom Attributes (Kiểu `String`, `mutable = true`):**
  - Trong block `schema` của Terraform đặt `name = "tenant_id"` và `name = "role"` (khi gọi qua SDK sẽ là **`custom:tenant_id`** và **`custom:role`**).
- **App Client (Web Console):**
  - `generate_secret = false`, bật `ALLOW_USER_SRP_AUTH` và `ALLOW_REFRESH_TOKEN_AUTH`.
  - `prevent_user_existence_errors = "ENABLED"`.
  - `read_attributes`: gồm `email`, `email_verified`, `name`, `custom:tenant_id`, `custom:role`.
  - `write_attributes`: chỉ gồm `email`, `name` — **TUYỆT ĐỐI KHÔNG chứa `custom:tenant_id` và `custom:role`**.
- **Cognito User Group cho Platform Admin:** Tạo group có tên chính xác là **`"PlatformAdmins"`**.

### 2.3. Lệnh chạy CI (GitHub Actions `.github/workflows/`)
```bash
# 1. Build & Test thư viện dùng chung (safe_fetch 1.10 + analyzers/experiments 1.12)
cd libs/common
npm ci
npm test

# 2. Build & Test Auth / API (PostConfirmation + inviteMember 1.11)
cd ../../services/api
npm ci
npm test
```

---

## 3. Dành cho TV2 (Lambda Proxy `F2`, Xác minh `F1`, Sitemap `F6`)

### 3.1. Cách gọi hàm `safe_fetch` chống SSRF (Nhiệm vụ 1.10)
- **File cài đặt thật:** [`libs/common/safeFetch.ts`](../libs/common/safeFetch.ts)
- **File STUB offline (dùng tạm khi chưa cần gọi mạng thật, trả HTML mẫu cố định):** [`libs/common/safeFetch.stub.ts`](../libs/common/safeFetch.stub.ts)
- **Chữ ký hàm:** Giữ đúng 100% chữ ký trong [`libs/common/interfaces.d.ts`](../libs/common/interfaces.d.ts):
  ```ts
  import { safe_fetch, safeFetch } from '../../libs/common/safeFetch.js';
  // Hoặc dùng stub:
  // import { safe_fetch } from '../../libs/common/safeFetch.stub.js';
  ```
- **Quy ước xử lý kết quả trả về (`res.outcome.kind`) trong Proxy `F2`:**
  Hàm `safe_fetch` **không bao giờ throw** với các lỗi mạng/SSRF mà trả về `FetchResult` kèm trường `res.outcome`:

  | Giá trị `res.outcome.kind` | Ý nghĩa | Hành động chuẩn ở Proxy `F2` |
  | :--- | :--- | :--- |
  | `'OK'` | Tải thành công trang HTML (`status`, `res.body`, `res.finalUrl`) | Đưa `res.body` sang `extract(res.body)` để tách câu và dịch |
  | `'NOT_HTML'` | Origin trả về ảnh, CSS, JS, PDF, JSON... (đã hủy stream trước khi đọc body) | Trả HTTP **`302 Found`** với header `Location: res.finalUrl` |
  | `'BLOCKED'` | Vi phạm SSRF (`res.outcome.reason`: `'PRIVATE_IP' \| 'PORT' \| 'SCHEME' \| 'CREDENTIALS' \| ...`) | Trả HTTP **`403 Forbidden`** |
  | `'TOO_LARGE'` | Vượt quá giới hạn `3 MB` (cả dữ liệu thô hoặc sau giải nén gzip/br) | Trả HTTP **`502 Bad Gateway`** |
  | `'TOO_MANY_REDIRECTS'` | Chuyển hướng quá `5` lần | Trả HTTP **`502 Bad Gateway`** |
  | `'TIMEOUT'` | Quá timeout kết nối (`5s`) hoặc timeout tổng (`10s`) | Trả HTTP **`504 Gateway Timeout`** |
  | `'NETWORK_ERROR'` | Lỗi DNS hoặc kết nối tới origin thất bại | Trả HTTP **`502 Bad Gateway`** |

- **Cách gọi riêng cho `F6` (Tải Sitemap XML):**
  Vì mặc định `safe_fetch` chỉ nhận `text/html`, khi tải Sitemap XML hãy gọi hàm mở rộng `safeFetch`:
  ```ts
  const out = await safeFetch(sitemapUrl, {
    allowedContentTypes: ['application/xml', 'text/xml'],
  });
  if (out.kind === 'OK') {
    const xmlContent = out.html;
  }
  ```

### 3.2. Quy ước giữ thẻ nội tuyến & hậu kiểm thẻ khi dịch HTML (từ Nhiệm vụ 1.12)
1. **Dùng thẻ `<span data-i="k">...</span>` cho phần tử nội tuyến:**
   - Khi viết hàm `extract(html)` và `rebuild(...)`, bọc các thẻ nội tuyến (`<a>`, `<strong>`, `<em>`, `<code>`...) bằng `<span data-i="1">...</span>`, `<span data-i="2">...</span>`.
   - **Quy tắc tiết kiệm chi phí ký tự (từ Thử nghiệm 2):** Mỗi cặp thẻ `<span data-i="k">...</span>` làm tăng thêm ~23–24 ký tự Unicode code point (tăng trung bình **+34.48%** chi phí trên bộ mẫu). Vì vậy: **chỉ bọc `<span data-i="k">` quanh các phần tử nội tuyến nằm giữa câu**, không bọc thẻ ngoài toàn bộ câu thuần văn bản.
2. **Hậu kiểm bảo toàn thẻ sau khi gọi Amazon Translate:**
   - Gọi hàm `inspectSpanTags(sourceHtml, translatedHtml)` từ [`libs/common/experiments/analyzers.ts`](../libs/common/experiments/analyzers.ts):
     ```ts
     import { inspectSpanTags, stripHtmlTags } from '../../libs/common/experiments/analyzers.js';

     const check = inspectSpanTags(sourceSentenceHtml, translatedSentenceHtml);
     if (!check.tagsIntact) {
       // Nếu thẻ bị mất/lệch đóng mở: fallback dùng văn bản thuần để không làm vỡ DOM trang web
       const safeFallback = stripHtmlTags(translatedSentenceHtml);
     }
     ```
   - Lưu ý khi `rebuild()`: Với tiếng Hàn (`ko`) và tiếng Nhật (`ja`), thứ tự xuất hiện của `data-i="1"`, `data-i="2"` trong câu dịch **có thể đảo vị trí** (`check.orderReordered === true`) do cấu trúc ngữ pháp SOV. Hàm `rebuild()` phải khôi phục thẻ dựa theo **giá trị thuộc tính `data-i="k"`**, không dựa theo thứ tự xuất hiện tuyến tính.

---

## 4. Dành cho TV3 (REST API, Authorizer, Glossary `F4` & DynamoDB)

### 4.1. Hằng số Vai trò (`Role`) và Thuộc tính Cognito — Import từ [`libs/common/roles.ts`](../libs/common/roles.ts)
TV3 **không gõ tay chuỗi role** mà import trực tiếp từ `libs/common/roles.ts`:
```ts
import {
  ROLES,
  INVITABLE_ROLES,
  isInvitableRole,
  PLATFORM_ADMIN_GROUP,
  COGNITO_CUSTOM_ATTRIBUTES,
} from '../../libs/common/roles.js';
```
- **Quy ước role hiện đang được triển khai:**
  - Vai trò nội bộ trong API và `Ctx`: `TENANT_ADMIN`, `DEVELOPER`, `REVIEWER`.
  - Giá trị `ROLES.TENANT_ADMIN`, `ROLES.DEVELOPER`, `ROLES.REVIEWER` tương ứng chính xác là `TENANT_ADMIN`, `DEVELOPER`, `REVIEWER`; không dùng nhãn hiển thị `"Tenant Admin"`/`"Developer"`/`"Reviewer"`.
- **Giá trị chính xác của 3 vai trò tenant trong `ROLES`:**
  - `ROLES.TENANT_ADMIN` = **`"TENANT_ADMIN"`**
  - `ROLES.DEVELOPER` = **`"DEVELOPER"`**
  - `ROLES.REVIEWER` = **`"REVIEWER"`**
- **Mã role dùng trong ma trận quyền và frontend:** `TENANT_ADMIN`, `DEVELOPER`, `REVIEWER`.
- **Tên claim/attribute trên Cognito User / Token:**
  - `custom:tenant_id` (`COGNITO_CUSTOM_ATTRIBUTES.TENANT_ID`) — định dạng `"t_<24_ky_tu_hex>"` (ví dụ: `"t_8f3a1c9e4b2d7a6f5e0c1b2a"`).
  - `custom:role` (`COGNITO_CUSTOM_ATTRIBUTES.ROLE`) — token claim chứa mã role tương ứng: `TENANT_ADMIN` -> `tenant_admin`, `DEVELOPER` -> `developer`, `REVIEWER` -> `reviewer`.
  - Quản trị viên hệ thống thuộc Cognito Group **`"PlatformAdmins"`** (`PLATFORM_ADMIN_GROUP`) trong claim `cognito:groups` và không có `custom:tenant_id`.

| Vai trò | Role code | Giá trị Cognito claim `custom:role` |
| :--- | :--- | :--- |
| Tenant Admin | `TENANT_ADMIN` | `tenant_admin` |
| Developer | `DEVELOPER` | `developer` |
| Reviewer | `REVIEWER` | `reviewer` |

**Platform Admin không dùng `custom:role`:** nhận diện duy nhất bằng group Cognito `PlatformAdmins` trong claim `cognito:groups`.

#### Quyết định tương thích Cognito hiện có
- **Quyết định:** chưa bỏ tương thích claim cũ; trong giai đoạn chuyển đổi, API và Console đều đọc cả hai dạng:
  - dạng chuẩn mới: `tenant_admin`, `developer`, `reviewer`;
  - dạng cũ hiện đã xuất hiện trong tài liệu vận hành: `Tenant Admin`, `Developer`, `Reviewer`.
- Claim viết hoa theo mã nội bộ như `TENANT_ADMIN`, `DEVELOPER`, `REVIEWER` không được chấp nhận làm `custom:role`.
- **Mọi lần ghi mới** vào Cognito đều dùng duy nhất claim lowercase qua `claimForRole(...)` ở API hoặc ánh xạ tương đương ở Console; không ghi tên hiển thị cũ.
- Khi thực hiện migrate toàn bộ user Cognito hiện có sang claim lowercase, phải cập nhật và chạy lại test contract rồi mới bỏ các nhánh tương thích tên hiển thị khỏi API và Console.

### 4.5. Ma trận route/method/quyền từ Bảng 1.2, 2.8 và 2.9
Các route dưới đây dùng role code ở phần 4.1 (không dùng nhãn hiển thị để authorize). `-` nghĩa là route không tồn tại, không được phép thay thế bằng `DELETE`.

| Route | Method | Quyền |
| :--- | :--- | :--- |
| `/console/me` | `GET` | `TENANT_ADMIN`, `DEVELOPER`, `REVIEWER`; Platform Admin nếu endpoint danh tính nền tảng tương ứng |
| `/console/members` | `GET` | `TENANT_ADMIN` |
| `/console/members/invite` | `POST` | `TENANT_ADMIN` |
| `/console/members/{userSub}` | `PATCH` | `TENANT_ADMIN` |
| `/console/members/{userSub}` | `DELETE` | Không dùng; dùng API revoke/remove do backend quy định |
| `/console/websites` | `GET`, `POST` | `TENANT_ADMIN` |
| `/console/websites/{slug}` | `GET`, `PATCH` | `TENANT_ADMIN` |
| `/console/websites/{slug}/pause` | `PATCH` | `TENANT_ADMIN` |
| `/console/websites/{slug}/resume` | `PATCH` | `TENANT_ADMIN` |
| `/console/glossary` hoặc `/console/glossary/terms` | `GET` | `TENANT_ADMIN`, `DEVELOPER`, `REVIEWER` |
| `/console/glossary/terms/{term}` | `PUT`, `DELETE` | `TENANT_ADMIN`; các role khác bị chặn ghi/xóa |
| `/console/glossary/import/preview` hoặc `POST /console/glossary/import` | `POST` | Preview glossary cho mọi role được phép đọc glossary; commit chỉ `TENANT_ADMIN` |
| `/console/review` | `GET` | `TENANT_ADMIN`, `REVIEWER` |
| `/console/review/{id}` | `PATCH` | `TENANT_ADMIN`, `REVIEWER` |
| `/console/usage` | `GET` | `TENANT_ADMIN`, `DEVELOPER` |
| `/console/api-keys` | `GET`, `POST` | `TENANT_ADMIN`, `DEVELOPER` |
| `/console/api-keys/{keyId}/revoke` | `POST` | `TENANT_ADMIN`, `DEVELOPER` |
| `/console/playground/*` | `POST` | `TENANT_ADMIN`, `DEVELOPER` |
| `/console/documents/translate` | `POST` | `TENANT_ADMIN`, `DEVELOPER` |
| `/console/platform/tenants` | `GET`, `POST` | `PlatformAdmins` |
| `/console/platform/tenants/{tenantId}/lock` | `PATCH` | `PlatformAdmins` |
| `/console/platform/tenants/{tenantId}/unlock` | `PATCH` | `PlatformAdmins` |
| `/console/platform/pricing` | `GET`, `POST`, `PATCH` | `PlatformAdmins` |
| `/console/tm/*` | `GET` | Theo quyền đọc của tenant; không có `DELETE` |

Website chỉ dùng `PATCH` cho pause/resume. API key chỉ dùng thao tác `revoke`; không thêm endpoint `DELETE` cho website, Translation Memory (TM) hoặc API key.

#### Token type và thứ tự xử lý lỗi
- Mọi API dưới `/console/*` dùng **Cognito ID token**, không dùng access token, vì API phải đọc `custom:tenant_id` và `custom:role` (Platform Admin đọc `cognito:groups`).
- Authorizer/API phải xử lý lỗi theo thứ tự: `401` -> `PERMISSION_DENIED` -> `TENANT_SUSPENDED` -> `400` -> `NOT_FOUND`.
- Khi tenant LOCKED, API GET của console vẫn được phép đọc, nhưng mọi thao tác ghi và POST tiêu hạn mức đều bị chặn bằng `TENANT_SUSPENDED`.
- Ngoại lệ bắt buộc của visitor proxy: mặc dù các GET của console được phép đọc khi tenant khóa, proxy visitor **vẫn phải redirect khi tenant khóa** theo quy tắc mục 3.1. Không bỏ redirect này để áp dụng chung quy tắc đọc của console.
- `preview glossary` là thao tác POST có quyền chạy khi tenant LOCKED; mọi POST commit/import hoặc ghi quota khác đều bị chặn.

#### Invalidation cache
Mọi thay đổi lock/unlock tenant và pause/resume website phải gọi invalidation cache. Trạng thái cache hoặc redirect `302` liên quan không được giữ hơn **60 giây** (`Cache-Control: s-maxage=60` hoặc TTL tương đương).

Giới hạn này phải được chứng minh bằng cùng một website cache trên CloudFront sau khi đổi trạng thái và chờ tối đa
60 giây: resolver Lambda cache tối đa 60 giây, CloudFront response của redirect tenant/website phải dùng
`s-maxage=60`, và invalidation wildcard theo từng slug phải hoàn tất. Nếu chưa có báo cáo/thử nghiệm xác
nhận invalidation hoạt động trong cửa sổ 60 giây, không coi tiêu chí visitor redirect mục 3.1 là đạt.

### 4.2. Schema 2 bản ghi DynamoDB do Trigger `PostConfirmation` khởi tạo
Khi người dùng hoàn tất xác nhận đăng ký (`PostConfirmation_ConfirmSignUp`), trigger đã ghi giao dịch `TransactWriteItems` gồm 2 bản ghi sau vào bảng `process.env.TABLE_NAME`:

#### (a) Bản ghi Cấu hình Tenant (`CONFIG`)
```json
{
  "PK": "TENANT#<tenantId>",
  "SK": "CONFIG",
  "tenantId": "<tenantId>",
  "organizationName": "<Tên tổ chức>",
  "plan": "Free",
  "charLimit": 50000,
  "status": "ACTIVE",
  "glossaryVersion": 0,
  "ownerSub": "<cognito_user_sub>",
  "createdAt": "2026-10-18T09:00:00.000Z"
}
```
*(Hạn mức ký tự mặc định của gói Free là **`50000`**, đọc từ hằng số `FREE_TIER_CHAR_LIMIT` trong [`services/api/auth/postConfirmation.ts`](../services/api/auth/postConfirmation.ts)).*

#### (b) Bản ghi Thành viên (`MEMBER`)
```json
{
  "PK": "TENANT#<tenantId>",
  "SK": "MEMBER#<cognito_user_sub>",
  "tenantId": "<tenantId>",
  "userSub": "<cognito_user_sub>",
  "email": "founder@acme.io",
  "role": "Tenant Admin",
  "status": "ACTIVE",
  "createdAt": "2026-10-18T09:00:00.000Z"
}
```

### 4.3. Cách TV3 gọi hàm `inviteMember` trong API Mời thành viên
Khi TV3 viết API mời thành viên vào Tenant:
```ts
import { inviteMember } from './auth/inviteMember.js';

// 1. Gọi hàm inviteMember (hàm này chỉ cho phép role là "Developer" hoặc "Reviewer")
const invited = await inviteMember(tenantId, email, role);
// invited trả về: { username, userSub, userStatus: 'FORCE_CHANGE_PASSWORD', tenantId, email, role }

// 2. TRÁCH NHIỆM CỦA TẦNG API (TV3):
// Dùng `invited.userSub` để ghi bản ghi MEMBER vào DynamoDB với:
//   PK = `TENANT#${tenantId}`
//   SK = `MEMBER#${invited.userSub}`
//   status = "PENDING_FIRST_LOGIN" (chờ đăng nhập lần đầu)
```

### 4.4. Quy ước cho Module Nhận diện ngôn ngữ, Glossary & Hậu kiểm `F4` (từ Nhiệm vụ 1.12)
1. **Cách đếm ký tự tính Quota/Billing:**
   - Amazon Translate tính ký tự theo **Unicode code point** (`Array.from(text).length`), **bao gồm cả các ký tự của thẻ HTML `<span data-i="k">...</span>`** gửi trong trường `Text`.
   - TV3 có thể import trực tiếp hàm `countCodePoints(text)` từ [`libs/common/experiments/analyzers.ts`](../libs/common/experiments/analyzers.ts) để trừ hạn mức `charLimit` của Tenant chính xác như cách AWS tính phí.
2. **Ngưỡng nhận diện ngôn ngữ với Amazon Comprehend (`DetectDominantLanguage`):**
   - Dùng hàm `evaluateLanguageConfidence(languages, 0.70)` trong [`libs/common/experiments/analyzers.ts`](../libs/common/experiments/analyzers.ts).
   - Ngưỡng tin cậy chuẩn: **`Score >= 0.70`** (`RECOMMENDED_CONFIDENCE_THRESHOLD = 0.7`). Nếu `Score < 0.70` hoặc chuỗi ngắn < 20 ký tự -> fallback về ngôn ngữ nguồn mặc định của website.
3. **Định dạng CSV Custom Terminology & Gắn cờ `"Cần xem lại"` (`needsReview`):**
   - Dùng hàm `buildTerminologyCsv(terms)` để xuất CSV UTF-8 có dòng đầu là mã ngôn ngữ (`vi,en,ko,ja`), cột đầu là ngôn ngữ nguồn, nạp lên AWS bằng `ImportTerminology` với `MergeStrategy: 'OVERWRITE'`.
   - Vì Custom Terminology của AWS chỉ khớp chính xác chuỗi ký tự và phân biệt hoa/thường (`case-sensitive`), sau khi dịch xong câu có chứa thuật ngữ trong Glossary, gọi hàm `checkTerminologyApplied(translatedText, expectedTargetTerms)`: nếu `needsReview === true` (thiếu thuật ngữ đích do câu gốc viết hoa khác hoặc biến thể từ) -> lưu bản dịch kèm trạng thái **"Cần xem lại" (`NEEDS_REVIEW`)** để Reviewer duyệt trên Console.

---

## 5. Dành cho Thành viên làm Web Console (Frontend)

1. **Truyền Tên Tổ Chức khi Đăng ký tài khoản (`SignUp`):**
   - Khi gọi Cognito `SignUp` (hoặc `ConfirmSignUp`), truyền tên tổ chức qua `ClientMetadata`:
     ```ts
     ClientMetadata: {
       organization_name: organizationNameInput
     }
     ```
   - *(Hàm `extractOrganizationName` ở backend cũng đã hỗ trợ dự phòng đọc từ `ClientMetadata.organizationName`, `ClientMetadata.orgName`, `userAttributes['custom:organization_name']`, `userAttributes['name']` hoặc tự sinh từ phần trước `@` của email).*
2. **Đọc thông tin Tenant và Role sau khi đăng nhập:**
   - Lấy từ ID Token payload:
     - `payload['custom:tenant_id']` -> Mã Tenant hiện tại.
     - `payload['custom:role']` -> role claim chuẩn: `"tenant_admin"` | `"developer"` | `"reviewer"`.
     - `payload['cognito:groups']` -> Nếu mảng này chứa `"PlatformAdmins"` thì điều hướng sang giao diện Quản trị nền tảng (Platform Admin).
   - Các API `GET/POST/PATCH/...` dưới `/console/*` luôn gửi ID Token; không dùng access token để lấy tenant và role.
3. **Xử lý đăng nhập lần đầu cho Thành viên được mời:**
   - Thành viên được mời qua `inviteMember` sẽ nhận mật khẩu tạm qua email và có trạng thái `FORCE_CHANGE_PASSWORD`.
   - Khi đăng nhập bằng mật khẩu tạm, Cognito trả về challenge **`NEW_PASSWORD_REQUIRED`** -> Console hiển thị màn hình yêu cầu nhập mật khẩu mới (tối thiểu 8 ký tự, gồm chữ hoa, chữ thường và chữ số).
4. **Không gọi `UpdateUserAttributes` để sửa `custom:tenant_id` hoặc `custom:role`:**
   - Hai thuộc tính này đã bị khóa quyền ghi ở App Client (`WriteAttributes`), mọi thao tác đổi vai trò thành viên phải gọi qua REST API của backend.
