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
- **ReadSitemap**: kiểm tra lại tenant và website theo slug (QC-6). Tải `<trang chủ>/sitemap.xml`, rồi `/sitemap.xml` nếu khác, qua `safeFetch` (chặn SSRF, chỉ nhận `application/xml`, `text/xml`, tối đa 5 MB). Đọc cả sitemap index một cấp (tối đa 20 sitemap con, cùng miền). Chỉ giữ URL cùng origin và nằm trong thư mục trang chủ, loại trùng, bỏ tệp không phải trang (pdf, ảnh…), tối đa 500 URL. Chia lô ghi S3 dưới `worker/<tenantId>/prewarm/<jobId>/` (nằm trong tiền tố `worker/<tenantId>/` mà session policy tenant cho phép), mỗi lô tối đa 8 trang (URL × ngôn ngữ). JOB → RUNNING, `total` = số URL × số ngôn ngữ.
- **PrewarmPages** (C13 chế độ trang): mỗi URL × ngôn ngữ chạy lõi proxy F2 (`createProxyHandler` với `countRequests: false`, không gọi worker hoàn tất nền): tải trang, tách câu, tra TM, đặt trước hạn mức, dịch, ghi TM và SEG, `settleUsage` với `{kind: 'WEB', slug}` nhưng `requests = pagesServed = 0`. URL lỗi bị bỏ qua và tính là lỗi. Hết hạn mức ký tự hoặc sắp hết thời gian (ngân sách 240 s) thì dừng lô; trang chưa chạy tính là lỗi. Cập nhật tiến độ JOB sau mỗi lô (ADD nguyên tử, cùng UpdateItem đánh dấu `lots.<lot-NNNN>` với điều kiện lô chưa được đánh dấu): Step Functions chạy lại một lô đã cộng thì không cộng lần nữa, nên `done + failed` không vượt `total`. Chạy lại lô (Retry) không tốn ký tự trùng vì trang đã dịch trúng TM.
- **FinishPrewarm**: JOB → SUCCEEDED kèm cảnh báo `URL_SKIPPED`, `URL_LIMIT`, `SITEMAP_CHILD_FAILED`, `PAGES_FAILED`, `QUOTA`, `LOT_TIMEOUT`. Hết hạn mức giữa chừng vẫn SUCCEEDED (mục 2.4.2).
- **MarkFailed**: JOB → FAILED, `reason` là tên lỗi (`SITEMAP_NOT_FOUND`, `SITEMAP_EMPTY`, `SITE_NOT_ACTIVE`, `TENANT_SUSPENDED`, `NO_TARGET_LANGS`, `States.Timeout`…), không ghi `Cause`.

## Cấu hình cho TV1 (IaC)

Dữ liệu tenant (JOB, TM, SEG, usage) và S3 đều đi qua phiên STS theo tenant (`TenantDataAccessRole` + session policy `TENANT#<t>…`, S3 `worker/<t>/*`), giống proxy và worker sau PR #25. Role của từng hàm chỉ cần quyền gốc như bảng dưới.

| Hàm | Handler | Timeout | Quyền của role Lambda |
| :--- | :--- | :--- | :--- |
| ReadSitemap | `services/proxy/dist/services/proxy/prewarm.readSitemapHandler` | 120 s | như proxy: `dynamodb:GetItem` trên `TENANT#PLATFORM#SLUG#*`, `sts:AssumeRole` trên `TenantDataAccessRole`; Internet công khai qua safeFetch |
| PrewarmPages | `…/prewarm.prewarmPagesHandler` | 300 s | như proxy (thêm `translate:TranslateText`) |
| FinishPrewarm, MarkFailed | `…/prewarm.finishPrewarmHandler`, `…/prewarm.markPrewarmFailedHandler` | 60 s | `sts:AssumeRole` trên `TenantDataAccessRole` |
| C6 (route) | gọi `handlePrewarmRoute` | | như console-api + `states:StartExecution` trên state machine PREWARM |

- Biến môi trường các hàm C8/C13: như proxy (`TABLE_NAME`, `PUBLIC_BASE_URL`, `WORKER_PAYLOAD_BUCKET`, `TENANT_DATA_ACCESS_ROLE_ARN`, `TENANT_PAYLOAD_BUCKET_ARN`, `TRANSLATE_CONCURRENCY`). C6: `PREWARM_STATE_MACHINE_ARN`; `services/api` thêm `@aws-sdk/client-sfn` rồi dùng `stepFunctionsStarter(new SFNClient({}), StartExecutionCommand, arn)`.
- Bucket `WORKER_PAYLOAD_BUCKET`: Lifecycle xoá `worker/` sau 1 ngày đã đủ cho các lô dịch trước (lô chỉ được đọc trong lúc state machine chạy; trường hợp xấu nhất 500 URL × 3 ngôn ngữ chạy dưới 8 giờ).
- Tham số thiết kế (hằng trong `prewarm.ts`, đổi được qua deps): 500 URL, 8 trang mỗi lô, ngân sách 20 s mỗi trang, `MaxConcurrency` 2 (chỉnh ở 5.6 theo `ThrottlingException`).
