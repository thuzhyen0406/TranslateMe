# `GET /translate/batch/{job_id}` (F10 Bước 6 – Tra cứu công việc dịch batch)

> **Trạng thái:** Đã triển khai trong `services/api/batch/batchIngress.ts` và công bố trong [`docs/openapi.yaml`](./openapi.yaml).

---

## 1. Hợp đồng dự kiến (theo Bảng 2.8 & `jobs.ts`)

- **Method & Path:** `GET /translate/batch/{job_id}`
- **Xác thực:** API Gateway API Key → DynamoDB `KEYMAP` (QC-3).
- **Tham số đường dẫn (`job_id`):** Định dạng `job-YYYYMMDD-xxxxxxxxxxxx` (nhận từ `POST /translate/batch`).
- Tenant `LOCKED` vẫn đọc được trạng thái JOB; thao tác ghi vẫn bị chặn. Vai trò `REVIEWER` không được truy cập API batch.

### Phản hồi `200 OK` (dự kiến)

```json
{
  "request_id": "req-poll-01",
  "job": {
    "job_id": "job-20261108-3fa85f645717",
    "status": "SUCCEEDED",
    "total": 1,
    "done": 1,
    "failed": 0,
    "progress": 100,
    "target_langs": ["en"],
    "warnings": [],
    "results": [
      {
        "target_lang": "en",
        "file_name": "gioi-thieu-homestay.en.docx",
        "download_url": "https://translateme-dev-batch-files.s3.ap-southeast-1.amazonaws.com/batch/tenant-u4821/results/job-20261108-3fa85f645717/gioi-thieu-homestay.en.docx?X-Amz-Signature=...",
        "warnings": []
      }
    ]
  }
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

## 2. Quy chuẩn triển khai

- JOB không tồn tại và JOB thuộc tenant khác phải có cùng `404 NOT_FOUND` response (QC-17).
- Chỉ cấp presigned GET URL khi JOB `SUCCEEDED`; URL có thời hạn 15 phút.
- Schema OpenAPI và ví dụ phải khớp với payload thực tế `{ request_id, job: { ... } }`.
