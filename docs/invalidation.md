# Xóa cache chọn lọc (F5, Task 3.5)

Mã nguồn: `libs/common/invalidation.ts` (dựa trên chỉ mục SEG của 3.4, `libs/common/seg.ts`). Thuật toán theo mục 2.6.4 của báo cáo, thông điệp M8.

## Giao diện cho 3.8 (đã chốt)

```ts
const inv = createInvalidator({ seg: createSEG({ db: segDb }), cdn });

// Sau khi đã ghi bản sửa vào TM (Chấp nhận nguyên bản, Lưu và xuất bản, Khôi phục bản máy):
const r = await inv.invalidateForSentences(ctx, { src: 'vi', tgt: 'en', hashes: [hash] });
// r.paths: đường dẫn CloudFront đã gửi, ví dụ ['/homestay-abc/en/', '/homestay-abc/en/phong-nghi/']
// r.mode: 'PATHS' | 'WILDCARD'
// r.invalidationId?: id để console theo dõi bằng GET /console/invalidations/{id}

// GET /console/invalidations/{id}:
const s = await inv.getInvalidationStatus(ctx, id); // { id, status: 'IN_PROGRESS' | 'COMPLETED', paths, createdAt? }
```

Phần mở rộng (thêm trường, không đổi chữ ký đã chốt):

| Trường | Ý nghĩa | Console hiển thị |
| :--- | :--- | :--- |
| `status: 'SUBMITTED'` | Đã gửi đủ | "Đang làm mới", rồi "Đã làm mới" khi `getInvalidationStatus` trả `COMPLETED` |
| `status: 'NOTHING_TO_DO'` | Câu không còn trên trang nào (`paths` rỗng), không gọi CloudFront | "Không còn sử dụng" (Q4) |
| `status: 'FAILED' \| 'PARTIAL'` | Tra SEG hoặc CloudFront lỗi; `failedPaths`, `error` | "Lỗi làm mới" + nút Thử lại |
| `invalidationIds` | Mọi id khi phải chia nhiều lô | |

- `invalidateForSentences` **không ném lỗi** vì SEG hay CloudFront: bản sửa đã lưu trước đó luôn được giữ (QC-8). Chỉ ném `AppError('INVALID_REQUEST')` khi đầu vào sai (mã ngôn ngữ, hash không phải SHA-256 hex thường).
- **Thử lại** (`POST /console/invalidations`): gọi lại `invalidateForSentences` với cùng `hashes`. Đường dẫn luôn tính lại từ SEG phía máy chủ; không nhận danh sách đường dẫn từ client (QC-3).
- `getInvalidationStatus` so `CallerReference` với tiền tố `t:<tenantId>:` của người gọi. Lần xóa của tenant khác, id không tồn tại hay sai dạng đều ném `AppError('NOT_FOUND')` như nhau (QC-2, nguyên tắc 1).

## Cách chọn đường dẫn

1. Tra SEG cho từng hash ở ngôn ngữ đích `tgt`, trên **mọi website của tenant**. TM dùng chung cho cả tenant nên sửa một câu là đổi bản dịch ở mọi trang có câu đó, kể cả ở website khác.
2. `<path>` SEG `/<slug>/<phần còn lại>` đổi thành `/<slug>/<tgt>/<phần còn lại>`, loại trùng.
3. Website nào có hơn `INVALIDATION_WILDCARD_THRESHOLD` đường dẫn (mặc định 500) thì dùng một wildcard `/<slug>/<tgt>/*` cho riêng website đó (`mode = 'WILDCARD'`).
4. `CreateInvalidation` theo lô `INVALIDATION_BATCH_SIZE` (mặc định 500, tối đa 3.000), mỗi lô một `CallerReference = t:<tenantId>:<uuid>`.
5. Metric `invalidation.paths` với chiều `mode` (`paths` / `wildcard`) qua `deps.metric` (nối vào `obs.metric` khi có).

## Cấu hình cho C6 (TV1, IaC)

| Mục | Giá trị |
| :--- | :--- |
| Biến môi trường | `CLOUDFRONT_DISTRIBUTION_ID` (bắt buộc), `INVALIDATION_WILDCARD_THRESHOLD` (500), `INVALIDATION_BATCH_SIZE` (500), `TABLE_NAME` |
| IAM | `cloudfront:CreateInvalidation`, `cloudfront:GetInvalidation` trên ARN của distribution; `dynamodb:Query` trên bảng chính (tiền tố `TENANT#`) |
| Phụ thuộc | `services/api` thêm `@aws-sdk/client-cloudfront`; `libs/common` không phụ thuộc gói này |

```ts
import { CloudFrontClient, CreateInvalidationCommand, GetInvalidationCommand } from '@aws-sdk/client-cloudfront';
import { cloudFrontCdn, createInvalidator, invalidationConfigFromEnv } from '../../libs/common/invalidation.js';

const cfg = invalidationConfigFromEnv(process.env);
const cdn = cloudFrontCdn(new CloudFrontClient({}), { CreateInvalidationCommand, GetInvalidationCommand }, cfg.distributionId!);
const inv = createInvalidator({ seg, cdn, wildcardThreshold: cfg.wildcardThreshold, batchSize: cfg.batchSize });
```

Môi trường dev chưa có distribution và kiểm thử của 3.8 dùng `createMemoryCdn()` (CloudFront giả trong bộ nhớ: lần xóa chuyển `Completed` sau một lần `getInvalidation`; `failWith` để giả lập lỗi).

## Xóa cache cả website (3.1/3.2 – khóa tenant, tạm dừng/bật lại website)

`invalidateForSites(ctx, { slugs })` dùng khi trạng thái website hoặc tenant đổi, để QC-3 (hiệu lực ≤ 60 s) không bị cache CloudFront (tới 7 ngày) vô hiệu hóa.

- Mỗi website một wildcard `/<slug>/*` (mọi ngôn ngữ). Bỏ slug sai dạng, loại trùng, sắp xếp.
- Chia lô tối đa 15 wildcard (`CLOUDFRONT_WILDCARD_LIMIT`). `CallerReference = t:<tenantId>:<uuid>` như M8.
- **Khác `invalidateForSentences`:** có lô lỗi thì **ném** `AppError('CACHE_INVALIDATION_FAILED')` (platform handler map 503). Ghi trạng thái rồi xóa cache là thao tác lặp lại được, nên người dùng chỉ cần bấm lại.
- Kết quả: `{ paths, mode: 'WILDCARD', status: 'SUBMITTED' | 'NOTHING_TO_DO' | 'NOT_CONFIGURED', invalidationIds }` (`status`, `invalidationIds` tùy chọn trong kiểu để bản giả cũ vẫn hợp lệ).
- Bản mặc định (hàm export `invalidateForSites`, `siteManager` và `platform/tenantStatus` đang dùng) tự dựng CloudFront từ `CLOUDFRONT_DISTRIBUTION_ID`, nạp `@aws-sdk/client-cloudfront` bằng import động khi có biến này.
  - Thiếu biến khi chạy trong Lambda (`AWS_LAMBDA_FUNCTION_NAME` có giá trị): ném `CACHE_INVALIDATION_FAILED`, không im lặng bỏ qua.
  - Thiếu biến khi chạy local/test: trả `NOT_CONFIGURED`, ghi log `CDN_NOT_CONFIGURED`.
  - `configureSiteInvalidation(cdn | null)` để thay bản mặc định (test hoặc tự truyền `cdn`).
- Cũng có trong `createInvalidator(...).invalidateForSites` (dùng chung `cdn`) và `createSiteInvalidator({ cdn })`.
- **IaC:** Lambda console-api và platform-api cần `CLOUDFRONT_DISTRIBUTION_ID` trong biến môi trường (quyền `cloudfront:CreateInvalidation` đã có trong `iam.yaml`).

## Cần TV1 xác nhận

- **Query string trong khóa cache CloudFront.** Xóa theo đường dẫn chính xác chỉ xóa bản không có query. Nếu cache policy của đường dẫn bản dịch đưa query string vào khóa cache, các biến thể `?page=2`… phải chờ hết `s-maxage`. Đề xuất cache policy cho bản dịch không dùng query string trong khóa cache, hoặc chấp nhận độ trễ này và ghi vào báo cáo.
- CloudFront giới hạn 3.000 đường dẫn và 15 wildcard đang xử lý cho mỗi distribution (dùng chung cho mọi tenant). Vượt giới hạn thì `CreateInvalidation` lỗi `TooManyInvalidationsInProgress`, kết quả trả `FAILED`, Reviewer bấm Thử lại sau.
