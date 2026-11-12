# Thiết kế dự kiến: `GET /translate/batch/{job_id}` (F10 Bước 6 – Tra cứu công việc dịch batch)

> **Trạng thái hiện tại:** **Chưa triển khai** trên `services/api/batch/batchIngress.ts` ở nhánh `main`.
>
> Trong handler hiện tại, `createBatchIngressHandler` chỉ xử lý `POST /translate/batch/upload-url` và `POST /translate/batch`, đồng thời gọi `parseBody(event.body)` trước khi phân nhánh route nên yêu cầu `GET` không có body sẽ nhận `400 INVALID_REQUEST`. Do đó, endpoint này **chưa được công bố trong `paths` của [`docs/openapi.yaml`](./openapi.yaml)** để tránh sinh SDK gọi route chưa tồn tại.

---

## 1. Hợp đồng dự kiến (theo Bảng 2.8 & `jobs.ts`)

- **Method & Path:** `GET /translate/batch/{job_id}`
- **Xác thực:** `x-api-key` (API Gateway API Key → DynamoDB `KEYMAP`, QC-3) hoặc Cognito ID token cho session Console tương ứng khi tích hợp.
- **Tham số đường dẫn (`job_id`):** Định dạng `job-YYYYMMDD-xxxxxxxxxxxx` (nhận từ `POST /translate/batch`).

### Phản hồi `200 OK` (dự kiến)

```json
{
  "request_id": "req-poll-01",
  "job_id": "job-20261108-3fa85f645717",
  "status": "SUCCEEDED",
  "progress": 100,
  "results": [
    {
      "target_lang": "en",
      "file_name": "gioi-thieu-homestay.en.docx",
      "download_url": "https://translateme-dev-batch-files.s3.ap-southeast-1.amazonaws.com/batch/tenant-u4821/results/gioi-thieu-homestay.en.docx?X-Amz-Signature=...",
      "warnings": []
    }
  ]
}
```

- `status`: `QUEUED` | `RUNNING` | `SUCCEEDED` | `FAILED`.
- `progress`: số nguyên `0`–`100`.
- `results`: khi `status === "SUCCEEDED"`, trả Presigned GET URL (S3) cho từng ngôn ngữ đích kèm `warnings` (nếu có).

### Quy chuẩn cô lập Tenant (QC-17)

- Nếu `job_id` không tồn tại hoặc thuộc về tenant khác, trả về cùng mã lỗi **`404 NOT_FOUND`** với thông báo đồng nhất:

```json
{
  "request_id": "req-404-job",
  "error": {
    "code": "NOT_FOUND",
    "message": "Không tìm thấy công việc batch."
  }
}
```

---

## 2. Việc cần làm khi Hạng mục 4.7 / 5.7 tích hợp route polling

1. Cập nhật `services/api/batch/batchIngress.ts` bỏ qua `parseBody` cho `GET` và bổ sung handler `GET /translate/batch/{job_id}` (chú ý cấu trúc payload trả về thực tế `job` / `downloads` hoặc phẳng theo thống nhất với Console/Client).
2. Bổ sung test kiểm tra cô lập tenant theo **QC-17** trên route thật (`404 NOT_FOUND` cho cả job không tồn tại lẫn job của tenant khác).
3. Đưa operation `GET /translate/batch/{job_id}` và schema response tương ứng quay lại [`docs/openapi.yaml`](./openapi.yaml) khớp 100% với implementation đã kiểm thử.
