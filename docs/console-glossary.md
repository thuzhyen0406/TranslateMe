# Màn hình Thuật ngữ và nhập CSV – Q3 (Task 4.11)

Tài liệu mô tả màn **Thuật ngữ** (Q3) trên web console cho **Tenant Admin**, **Developer** và **Reviewer** theo **Hình 1.9** và mục **1.3.3** của báo cáo: xem danh sách thuật ngữ kèm số phiên bản, thêm/sửa/xóa thuật ngữ (`KEEP` / `FIXED`), tải CSV mẫu và nhập CSV UTF-8 hàng loạt có bước xem trước và xử lý trùng lặp.

---

## 1. Luồng màn hình

1. **Danh sách thuật ngữ & Phiên bản**:
   - Đầu màn hình hiển thị nhãn phiên bản hiện tại của bảng thuật ngữ (`Phiên bản hiện tại: v{version}`). Mỗi thao tác lưu (thêm, sửa, xóa, nhập CSV thành công) tự động tăng số phiên bản và dùng trong khóa bộ nhớ đệm để áp dụng ngay cho bản dịch mới.
   - Bảng thuật ngữ liệt kê: **Từ nguồn**, **Hành động** (`Giữ nguyên` = `KEEP`, `Dịch cố định` = `FIXED`), các cột **bản dịch đích** (`EN`, `JA`, `ZH`, ...), **Ghi chú** và **Thao tác** (`Sửa`, `Xóa`).
   - Hỗ trợ tìm kiếm theo từ nguồn/bản dịch/ghi chú và lọc theo hành động (`ALL` / `KEEP` / `FIXED`).
2. **Phân quyền theo vai trò** (Bảng 1.2):
   - `TENANT_ADMIN`: được thêm, sửa, xóa thuật ngữ và nhập CSV hàng loạt.
   - `DEVELOPER`, `REVIEWER`: chỉ xem danh sách thuật ngữ và tải tệp CSV mẫu (ẩn các nút Thêm/Sửa/Xóa/Nhập CSV và hiển thị thông báo chế độ chỉ xem).
3. **Thêm / Sửa thuật ngữ**:
   - Khi chọn hành động **Giữ nguyên (`KEEP`)**: các ô bản dịch đích tự động điền bằng chính từ nguồn và khóa lại để đảm bảo nhất quán.
   - Khi chọn hành động **Dịch cố định (`FIXED`)**: nhập ít nhất một bản dịch đích cho các ngôn ngữ (`en`, `ja`, `zh`, ...).
   - Giới hạn kiểm tra ngay trên giao diện: từ nguồn không rỗng, tối đa `200` ký tự; tối đa `500` thuật ngữ trên mỗi khách hàng.
4. **Nhập CSV UTF-8 hàng loạt** (Hình 1.9):
   - Nút **Tải CSV mẫu** tạo tệp `glossary-sample.csv` chuẩn UTF-8 (`source_term,action,en,ja,zh,notes`).
   - Khi chọn tệp `.csv`, trình duyệt kiểm tra nghiêm ngặt mã hóa **UTF-8** bằng `TextDecoder('utf-8', { fatal: true })`; nếu tệp dùng bảng mã khác (Windows-1252, Shift-JIS...) sẽ báo lỗi ngay (`INVALID_CSV_ENCODING`).
   - Gọi bước **Xem trước (`PREVIEW`)** và hiển thị khung xác nhận:
     - **Số dòng hợp lệ** sẽ được nhập.
     - **Các dòng lỗi** (số dòng + lý do cụ thể: thiếu cột, `action` khác `KEEP`/`FIXED`, `FIXED` thiếu bản dịch đích, từ nguồn rỗng hoặc quá 200 ký tự).
     - **Từ trùng lặp** với bảng thuật ngữ hiện có hoặc trùng trong chính tệp CSV, kèm tùy chọn: **Ghi đè từ trùng (`OVERWRITE`)** hoặc **Giữ nguyên từ cũ (`KEEP_EXISTING`)**.
   - Bấm **Lưu các dòng hợp lệ** để gọi bước **Lưu (`COMMIT`)**, cập nhật danh sách và tăng số phiên bản bảng thuật ngữ.

---

## 2. Cấu trúc mã nguồn

| File | Nội dung |
| :--- | :--- |
| `console/src/types/glossary.ts` | Kiểu `GlossaryTerm`, `GlossaryAction`, `GlossaryListResponse`, `UpsertGlossaryTermInput`, `DuplicateHandling`, `CsvImportRowError`, `CsvImportResult`, giao diện `GlossaryApi` |
| `console/src/services/glossaryApi.ts` | Hàm thuần: `validateUpsertTermInput`, `buildSampleGlossaryCsv`, `decodeCsvUtf8Bytes`, `parseCsvRowsRfc4180`, `analyzeGlossaryCsv`, `glossaryErrorMessage`, `glossaryTermFromJson`, `csvImportResultFromJson`. Hai bản API: `createHttpGlossaryApi` (gọi F4 `/console/glossary/...` kèm `Authorization: Bearer <idToken>`) và `createMockGlossaryApi` (giả lập demo trong trình duyệt) |
| `console/src/components/GlossaryPage.tsx` | Giao diện danh sách thuật ngữ, huy hiệu phiên bản `v{version}`, biểu mẫu thêm/sửa, tải CSV mẫu, hộp thoại xem trước & nhập CSV UTF-8 |
| `console/src/components/ConsoleLayout.tsx` | Mục `glossary` hiển thị `GlossaryPage` |
| `console/src/test/glossary.test.ts` | Kiểm thử đơn vị cho hàm thuần, kiểm tra UTF-8, phân tích CSV, ánh xạ lỗi và bản mock |

---

## 3. Chế độ chạy

| `VITE_AUTH_MODE` | API |
| :--- | :--- |
| `mock` (mặc định) | Giả lập trong trình duyệt với bộ thuật ngữ mẫu của **Homestay ABC Hội An** (`v3`: `Homestay ABC`, `Check-in`, `Hội An`, ` phòng đôi`, `bữa sáng miễn phí`). Hỗ trợ đầy đủ thêm, sửa, xóa, tải CSV mẫu và nhập CSV UTF-8 kèm xem trước. |
| `cognito` | Gọi `VITE_API_BASE_URL` thật kèm `Authorization: Bearer <idToken>` tới dịch vụ F4 (`services/api/glossary/glossaryManager.ts` – Task 2.8). |

---

## 4. Hợp đồng API kết nối dịch vụ F4 (`services/api/glossary/glossaryManager.ts`)

| Route | Phương thức | Phản hồi |
| :--- | :--- | :--- |
| `/console/glossary/terms` | `GET` | `{ terms: GlossaryTerm[], glossary_version: number }` |
| `/console/glossary/terms/{term}` | `PUT` | `{ term: GlossaryTerm, glossary_version: number }` |
| `/console/glossary/terms/{term}` | `DELETE` | `{ deleted: true, glossary_version: number }` |
| `/console/glossary/import/preview` | `POST` | `{ mode: 'PREVIEW', valid_count, skipped_count, duplicate_count, duplicates, errors }` |
| `/console/glossary/import` | `POST` | `{ mode: 'COMMIT', valid_count, imported_count, skipped_count, duplicate_count, duplicates, errors, glossary_version }` |
