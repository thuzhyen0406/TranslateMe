# Dịch trước theo sitemap (F6, Task 4.5)

Mục 2.5.3 và thông điệp M2, M4 của báo cáo. Tiến độ hiển thị theo phần trăm; ký tự dịch máy tính vào `WEB#<slug>`.

```
Console --POST /console/hosts/{slug}/prewarm--> C6 (prewarmManager) --M2 StartExecution--> PREWARM
PREWARM: ReadSitemap -> Map(lots, MaxConcurrency 2) --M4--> PrewarmPages (C13) -> FinishPrewarm
         lỗi ở bất kỳ bước nào -> MarkFailed -> Fail
Console --GET /console/hosts/{slug}/prewarm hoặc GET /console/jobs/{jobId}--> { job: { status, progress, warnings, ... } }
```

## Mã nguồn

| Phần | Tệp | Ghi chú |
| :--- | :--- | :--- |
| Bản ghi JOB | `libs/common/jobs.ts` | `PK = TENANT#<t>#JOB`, `SK = JOB#<jobId>`, TTL 7 ngày; QUEUED → RUNNING → SUCCEEDED/FAILED; dùng chung cho dịch tệp (FILE) |
| Route C6 | `services/api/prewarm/prewarmManager.ts` | `handlePrewarmRoute(event, ctx, deps)`; trả `null` nếu đường dẫn không thuộc nhóm này |
| Hàm C8, C13 | `services/proxy/prewarm.ts` | `readSitemapHandler`, `prewarmPagesHandler`, `finishPrewarmHandler`, `markPrewarmFailedHandler` |
| State machine | `infra/statemachines/prewarm.asl.json` | `DefinitionSubstitutions`: `ReadSitemapFunctionArn`, `PrewarmPagesFunctionArn`, `FinishPrewarmFunctionArn`, `MarkPrewarmFailedFunctionArn` |

## Hành vi

- **POST** (Tenant Admin): tenant ACTIVE, website ACTIVE; `target_langs` tùy chọn, phải nằm trong các ngôn ngữ đang bật (mặc định tất cả). Tạo JOB (QUEUED) **trước**, rồi mới ghi `HOST.prewarm = {jobId, startedAt}` có điều kiện (HOST vẫn trỏ job cũ), nên `HOST.prewarm` không bao giờ trỏ tới job chưa tồn tại. Ghi HOST lỗi thì job vừa tạo chuyển FAILED: `SUPERSEDED` nếu một yêu cầu đồng thời đã thắng (trả lại job của yêu cầu đó), `HOST_UPDATE_FAILED` nếu lỗi khác. Sau đó `StartExecution` với `name = job_id`. Website đang có lần dịch trước QUEUED/RUNNING (chưa quá 6 giờ) thì trả lại chính job đó (`existing: true`), không chạy thêm lần nữa. Trả `202 { job, existing }`.
- **ReadSitemap**: kiểm tra lại tenant và website theo slug (QC-6). Tải `<trang chủ>/sitemap.xml`, rồi `/sitemap.xml` nếu khác, qua `safeFetch` (chặn SSRF, chỉ nhận `application/xml`, `text/xml`, tối đa 5 MB). Đọc cả sitemap index một cấp (tối đa 20 sitemap con, cùng miền). Chỉ giữ URL cùng origin và nằm trong thư mục trang chủ, loại trùng, bỏ tệp không phải trang (pdf, ảnh…), tối đa 500 URL. Chia lô ghi S3 dưới `tenant/<tenantId>/worker/prewarm/<jobId>/` (nằm trong tiền tố `tenant/<tenantId>/worker/` mà session policy tenant cho phép), mỗi lô tối đa 8 trang (URL × ngôn ngữ). JOB → RUNNING, `total` = số URL × số ngôn ngữ.
- **PrewarmPages** (C13 chế độ trang): mỗi URL × ngôn ngữ chạy lõi proxy F2 (`createProxyHandler` với `countRequests: false`, không gọi worker hoàn tất nền): tải trang, tách câu, tra TM, đặt trước hạn mức, dịch, ghi TM và SEG, `settleUsage` với `{kind: 'WEB', slug}` nhưng `requests = pagesServed = 0`. URL lỗi bị bỏ qua và tính là lỗi. Hết hạn mức ký tự hoặc sắp hết thời gian (ngân sách 240 s) thì dừng lô; trang chưa chạy tính là lỗi. Cập nhật tiến độ JOB sau mỗi lô (ADD nguyên tử, cùng UpdateItem đánh dấu `lots.<lot-NNNN>` với điều kiện lô chưa được đánh dấu): Step Functions chạy lại một lô đã cộng thì không cộng lần nữa, nên `done + failed` không vượt `total`. Chạy lại lô (Retry) không tốn ký tự trùng vì trang đã dịch trúng TM.
- **FinishPrewarm**: JOB → SUCCEEDED kèm cảnh báo `URL_SKIPPED`, `URL_LIMIT`, `SITEMAP_CHILD_FAILED`, `PAGES_FAILED`, `QUOTA`, `LOT_TIMEOUT`. Hết hạn mức giữa chừng vẫn SUCCEEDED (mục 2.4.2).
- **MarkFailed**: JOB → FAILED, `reason` là tên lỗi (`SITEMAP_NOT_FOUND`, `SITEMAP_EMPTY`, `SITE_NOT_ACTIVE`, `TENANT_SUSPENDED`, `NO_TARGET_LANGS`, `States.Timeout`…), không ghi `Cause`.

## Hạ tầng (IaC)

Đã khai báo trong `infra/modules/lambdas.yaml` (cfn-lint sạch). `services/proxy/test/prewarm.test.ts` kiểm tra `DefinitionString` nhúng trong template giống hệt `infra/statemachines/prewarm.asl.json`, handler trỏ tới hàm export có thật, và timeout Lambda nhỏ hơn `TimeoutSeconds` của bước tương ứng. Sửa ASL thì sửa cả hai nơi.

Dữ liệu tenant (JOB, TM, SEG, usage) và S3 đều đi qua phiên STS theo tenant (`TenantDataAccessRole` + session policy `TENANT#<t>…`; `TenantPayloadAccessRole` + S3 `tenant/<t>/worker/*`). Bốn hàm dùng chung gói mã proxy (`ProxyCodeKey`) và role của worker C13 (`WorkerRoleArn`): `dynamodb:GetItem` trên `TENANT#PLATFORM#SLUG#*`, assume hai role tenant, `translate:TranslateText`. Role này đã nằm trong trust policy của `TenantDataAccessRole`.

| Tài nguyên | Handler | Timeout Lambda | Bước ASL |
| :--- | :--- | :--- | :--- |
| `ReadSitemapFunction` (`translateme-<stage>-prewarm-read-sitemap`) | `services/proxy/prewarm.readSitemapHandler` | 90 s | 120 s |
| `PrewarmPagesFunction` (`…-prewarm-pages`) | `services/proxy/prewarm.prewarmPagesHandler` | 270 s (ngân sách lô 240 s) | 300 s |
| `FinishPrewarmFunction` (`…-prewarm-finish`) | `services/proxy/prewarm.finishPrewarmHandler` | 30 s | 60 s |
| `MarkPrewarmFailedFunction` (`…-prewarm-mark-failed`) | `services/proxy/prewarm.markPrewarmFailedHandler` | 30 s | 60 s |
| `PrewarmStateMachine` (`translateme-<stage>-prewarm`, STANDARD) | role `PrewarmStateMachineRole`: chỉ `lambda:InvokeFunction` trên 4 hàm trên | | |
| C6 (route trong `ConsoleFunction`) | `handlePrewarmRoute` | | `PREWARM_STATE_MACHINE_ARN` dựng theo tên cố định; `states:StartExecution` trong `iam.yaml` |

- Biến môi trường bốn hàm: như proxy (`TABLE_NAME`, `PUBLIC_BASE_URL`, `STATE_CACHE_S`, `TRANSLATE_CONCURRENCY`, `WORKER_PAYLOAD_BUCKET`, `TENANT_DATA_ACCESS_ROLE_ARN`, `TENANT_PAYLOAD_BUCKET_ARN`, `TENANT_PAYLOAD_ROLE_ARN`, `DATA_KMS_KEY_ARN`).
- Bucket `WORKER_PAYLOAD_BUCKET`: Lifecycle xoá `tenant/` sau 1 ngày (`data.yaml`), đủ cho các lô dịch trước (lô chỉ được đọc trong lúc state machine chạy; trường hợp xấu nhất 500 URL × 3 ngôn ngữ chạy dưới 8 giờ).
- Tham số thiết kế (hằng trong `prewarm.ts`, đổi được qua deps): 500 URL, 8 trang mỗi lô, ngân sách 20 s mỗi trang, `MaxConcurrency` 2 (chỉnh ở 5.6 theo `ThrottlingException`).
