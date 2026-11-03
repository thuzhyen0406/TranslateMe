# Màn Duyệt bản dịch hai cột trên Web Console (Q4, Task 4.10)

Mã nguồn: `console/src/components/ReviewPage.tsx` (giao diện), `console/src/services/reviewApi.ts` (gọi API F5 và hàm kiểm tra thuần), `console/src/types/review.ts`. Theo Hình 1.10, mục 1.3.4, Bảng 2.9 và Bảng 2.10 của báo cáo.

## Luồng màn hình (Q4)

1. **Bộ lọc câu dịch**: chọn Website, cặp ngôn ngữ (`vi -> en`, `vi -> ko`, `vi -> ja`), lọc theo trang (hoặc câu **Không còn sử dụng**), lọc theo nhãn (**Tất cả**, **Máy dịch**, **Đã duyệt**, **Cần xem lại**) và tìm kiếm theo từ khóa.
2. **Bảng hai cột song ngữ**:
   - Cột trái (**Bản gốc**): hiển thị câu nguồn với các ký hiệu định dạng nội tuyến `{1}…{/1}` dạng huy hiệu trực quan, kèm danh sách đường dẫn trang chứa câu đó (hoặc nhãn **Không còn sử dụng** khi `pages.length === 0`).
   - Cột phải (**Bản dịch**): hiển thị câu dịch hiện tại, nhãn trạng thái (**Máy dịch**, **Đã duyệt**, **Cần xem lại**), số phiên bản `v{version}` và trạng thái làm mới bộ nhớ đệm CloudFront (**Đang làm mới**, **Đã làm mới**, **Lỗi làm mới** kèm nút **Thử lại**).
3. **Khung hiệu đính câu dịch (bên phải)**:
   - Hiển thị đầy đủ câu gốc, danh sách trang xuất hiện, cảnh báo thuật ngữ (`glossaryWarnings`) nếu có, và bản máy dịch gốc để tham chiếu.
   - Kiểm tra tức thời các ký hiệu định dạng `{n}` (`validatePlaceholders`) và có nút chèn nhanh ký hiệu bị thiếu.
   - Ba thao tác chuẩn của F5:
     - **Chấp nhận nguyên bản** (`acceptTranslation` – F5.1): chuyển `MACHINE -> HUMAN` (hoặc gỡ nhãn **Cần xem lại**), giữ nguyên nội dung.
     - **Lưu và xuất bản** (`saveAndPublishTranslation` – F5.2): lưu bản sửa, chuyển `HUMAN`, tăng `version` và xóa cache chọn lọc các trang chứa câu đó.
     - **Khôi phục bản máy dịch** (`restoreMachineTranslation` – F5.3): quay về `machineText`, chuyển `MACHINE`, tăng `version` và xóa cache các trang chứa câu đó.
4. **Xử lý lỗi đặc thù (Bảng 2.10)**:
   - `400 PLACEHOLDER_MISMATCH`: chỉ rõ các ký hiệu bị thiếu (`missing`) và bị thừa (`extra`).
   - `409 VERSION_CONFLICT`: hiển thị khung so sánh bản mới nhất trên máy chủ (`latest.tgtText`, `v{latest.version}`, `latest.reviewerId`) với 2 lựa chọn: **Dùng bản mới nhất** hoặc **Lưu đè bằng bản của tôi**.
   - Lỗi làm mới CloudFront (`FAILED`): bản sửa vẫn được lưu thành **Đã duyệt**, hiển thị trạng thái **Lỗi làm mới** kèm nút **Thử lại** (`retryInvalidation`).

## Chế độ chạy

| `VITE_AUTH_MODE` | API |
| :--- | :--- |
| `mock` (mặc định) | `createMockReviewApi`: giả lập đầy đủ trong trình duyệt với dữ liệu mẫu của `homestay-abc`, có nút mô phỏng nhanh xung đột `409 VERSION_CONFLICT` và lỗi làm mới CloudFront. |
| `cognito` | `createHttpReviewApi`: gọi REST API F5 (`services/api/review/reviewManager.ts`) tại `VITE_API_BASE_URL` kèm `Authorization: Bearer <idToken>`. |
