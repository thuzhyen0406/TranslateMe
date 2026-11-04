# Màn Duyệt bản dịch hai cột trên Web Console (Q4, Task 4.10)

Mã nguồn: `console/src/components/ReviewPage.tsx` (giao diện), `console/src/services/reviewApi.ts` (gọi API F5 và hàm kiểm tra thuần), `console/src/types/review.ts`. Theo Hình 1.10, mục 1.3.4, Bảng 2.9 và Bảng 2.10 của báo cáo.

## Luồng màn hình (Q4)

1. **Bộ lọc câu dịch**:
   - Ở chế độ **Demo** (`demoMode = true`): hỗ trợ chọn Website mẫu (`homestay-abc`), lọc theo từng trang cụ thể (`/homestay-abc/en/`, `/homestay-abc/en/bang-gia`, ...) hoặc câu không còn sử dụng (`__UNUSED__`), lọc theo nhãn (**Tất cả**, **Máy dịch**, **Đã duyệt**, **Cần xem lại**) và tìm kiếm từ khóa.
   - Ở chế độ **API thật (Cognito)**: kết nối trực tiếp với backend F5 của tenant, duyệt toàn bộ bộ nhớ dịch (TM) theo cặp ngôn ngữ (`vi -> en`, `vi -> ko`, ...). Bộ lọc Website và Trang được giới hạn và làm mờ hiển thị rõ nhãn chờ dịch vụ chỉ mục câu–trang SEG, không gửi tham số giả lập lên server.
2. **Bảng hai cột song ngữ**:
   - Cột trái (**Bản gốc**): hiển thị câu nguồn với các ký hiệu định dạng nội tuyến `{1}…{/1}` dạng huy hiệu trực quan, kèm danh sách đường dẫn trang chứa câu đó (ở chế độ có metadata trang hoặc demo) hoặc thông báo tra cứu trang khi xuất bản.
   - Cột phải (**Bản dịch**): hiển thị câu dịch hiện tại, nhãn trạng thái (**Máy dịch**, **Đã duyệt**, **Cần xem lại**), số phiên bản `v{version}` và trạng thái làm mới bộ nhớ đệm CloudFront (**Đang làm mới**, **Đã làm mới**, **Lỗi làm mới một phần**, **Lỗi làm mới** kèm nút **Thử lại**).
3. **Khung hiệu đính câu dịch (bên phải)**:
   - Hiển thị đầy đủ câu gốc, danh sách trang xuất hiện, cảnh báo thuật ngữ (`glossaryWarnings`) nếu có, và bản máy dịch gốc để tham chiếu.
   - Kiểm tra tức thời các ký hiệu định dạng `{n}` (`validatePlaceholders`) và có nút chèn nhanh ký hiệu bị thiếu.
   - Ba thao tác chuẩn của F5 (`handleReviewRoute` – Task 3.8):
     - **Chấp nhận nguyên bản** (`POST /console/translations/accept` – F5.1): chuyển `MACHINE -> HUMAN` (hoặc gỡ nhãn **Cần xem lại**), giữ nguyên nội dung.
     - **Lưu và xuất bản** (`PUT /console/translations` với `newTgt` – F5.2): lưu bản sửa, chuyển `HUMAN`, tăng `version` và xóa cache chọn lọc các trang chứa câu đó.
     - **Khôi phục bản máy dịch** (`POST /console/translations/restore` – F5.3): quay về `machineText`, chuyển `MACHINE`, tăng `version` và xóa cache các trang chứa câu đó.
4. **Xử lý trạng thái làm mới bộ nhớ đệm CloudFront**:
   - Khi lưu bản sửa hoặc khôi phục, hệ thống trả về kết quả invalidation ban đầu (`SUBMITTED`, `PARTIAL`, `FAILED` hoặc `SKIPPED_NO_PAGES`).
   - Nếu ở trạng thái `IN_PROGRESS` (`SUBMITTED`), giao diện kích hoạt polling định kỳ (`setInterval` mỗi 1.5 giây, tối đa 20 lần = 30 giây) gọi `GET /console/invalidations/{id}` cho đến khi CloudFront hoàn tất (`Completed`) hoặc thất bại (`Failed`).
   - Toàn bộ timer polling được quản lý trong `useRef` và dọn dẹp sạch sẽ khi component unmount hoặc khi trạng thái chuyển sang hoàn tất.
5. **Xử lý lỗi đặc thù (Bảng 2.10)**:
   - `400 PLACEHOLDER_MISMATCH`: chỉ rõ các ký hiệu bị thiếu (`missing`) và bị thừa (`extra`).
   - `409 VERSION_CONFLICT`: đọc `currentEntry` (hoặc `latest`) trên máy chủ với 2 lựa chọn: **Dùng bản mới nhất** hoặc **Lưu đè bằng bản của tôi**.
   - Lỗi làm mới CloudFront (`FAILED` hoặc `PARTIAL`): bản sửa vẫn được lưu thành **Đã duyệt**, hiển thị trạng thái **Lỗi làm mới** / **Lỗi làm mới một phần** kèm nút **Thử lại** (`POST /console/invalidations/retry`).

## Chế độ chạy

| `VITE_AUTH_MODE` | API | Mô tả |
| :--- | :--- | :--- |
| `mock` (mặc định) | `createMockReviewApi` | Giả lập đầy đủ trong trình duyệt với dữ liệu mẫu của `homestay-abc`, mô phỏng đầy đủ tiến trình polling CloudFront (`InProgress -> Completed`), xung đột `409 VERSION_CONFLICT` và lỗi làm mới CDN. |
| `cognito` | `createHttpReviewApi` | Gọi trực tiếp các endpoint của F5 (`/console/translations`, `/console/translations/accept`, `/console/translations/restore`, `/console/invalidations/retry`, `/console/invalidations/{id}`) tại `VITE_API_BASE_URL` kèm `Authorization: Bearer <idToken>`. Duyệt TM trực tiếp theo cặp ngôn ngữ của tenant. |
