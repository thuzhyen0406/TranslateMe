# Màn Website trên web console (Q2, Task 4.6)

Mã nguồn: `console/src/components/WebsitePage.tsx` (giao diện), `console/src/services/websiteApi.ts` (gọi API và hàm thuần), `console/src/types/website.ts`. Theo Hình 1.7, 1.8 và mục 1.3.2 của báo cáo.

## Luồng

1. **Danh sách website** (mục Website, mặc định khi Tenant Admin đăng nhập): tên, trang chủ, ngôn ngữ đích, trạng thái (Chờ xác minh / Đang hoạt động / Tạm dừng).
2. **Thêm website – bước 1**: địa chỉ trang chủ, tên hiển thị, ngôn ngữ gốc, ngôn ngữ đích, vùng không dịch (bộ chọn CSS). Kiểm tra ngay khi nhập: chỉ `http(s)://` với tên miền công khai; từ chối localhost, tên máy nội bộ, địa chỉ IP, `user:pass@`, cổng lạ. Máy chủ vẫn kiểm tra lại (DNS, SSRF).
3. **Bước 2 – xác minh**: chọn thẻ meta hoặc tệp `translateme-verification.txt` (có nút Sao chép), bấm Kiểm tra. Thất bại thì hiện lý do cụ thể (không truy cập được, không thấy thẻ/tệp, mã không khớp, chuyển hướng quá số lần).
4. **Sau khi xác minh**: bảng đường dẫn bản dịch `{VITE_PUBLIC_BASE_URL}/{slug}/{lang}/` (Sao chép, Mở), nút **Dịch trước toàn bộ website theo sitemap** và thanh tiến độ theo phần trăm số trang (hỏi lại mỗi 3 giây khi đang chạy), cảnh báo hoặc lý do thất bại khi xong.

## Chế độ chạy

| `VITE_AUTH_MODE` | API |
| :--- | :--- |
| `mock` (mặc định) | `createMockWebsiteApi`: giả lập trong trình duyệt, có sẵn website "Homestay ABC Hội An". Xác minh demo luôn thành công, trừ địa chỉ chứa `sai-ma` (mã không khớp) hoặc `khong-truy-cap` (không truy cập được). Dịch trước demo tăng 25% mỗi lần hỏi. |
| `cognito` | `createHttpWebsiteApi`: gọi `VITE_API_BASE_URL` kèm `Authorization: Bearer <idToken>`. |

## Cờ bật ở chế độ Cognito

`VITE_WEBSITE_API_ENABLED=true` khi build console thì màn Website ở chế độ `cognito` gọi API thật (`isWebsiteApiEnabled` trong `websiteApi.ts`); không đặt thì màn Website chỉ hiện "Tính năng quản lý website chưa được bật trên môi trường này" và không gửi request nào. Chế độ `mock` luôn bật.

Từ 14/11 các route đã sẵn sàng nên `console/.env.example` đặt `true`. `services/api/sites/test/consoleContract.test.ts` chạy client `createHttpWebsiteApi` thật trên handler thật để giữ hợp đồng.

## Hợp đồng API (C6)

API Gateway (`infra/modules/api-gateway.yaml`) gắn `/console/hosts`, `/console/hosts/{slug}`, `/console/hosts/{slug}/{proxy+}` cho `WebsiteFunction` (`services/api/sites/handler.ts`), còn `/console/hosts/{slug}/prewarm` cho `ConsoleFunction` (4.5). Request JSON snake_case (QC-1); phản hồi trả bản ghi HOST dạng camelCase, console đọc được cả hai dạng (`websiteFromJson`).

| Route | Phản hồi |
| :--- | :--- |
| `GET /console/hosts` | `{ hosts: Host[] }` (kèm alias `websites`) |
| `POST /console/hosts` (body `home_url`, `display_name`, `source_lang`, `target_langs`, `no_translate_selectors`) | `201 { host }` |
| `GET /console/hosts/{slug}` | `{ host }`; không có hoặc thuộc tenant khác → `404 NOT_FOUND` |
| `POST /console/hosts/{slug}/verify` (body `{ method: 'META' \| 'FILE' }`) | `{ host }`; lỗi `422 VERIFICATION_CODE_MISMATCH` hoặc `422 SITE_UNREACHABLE` (console có thông báo riêng cho từng mã) |
| `POST` / `GET /console/hosts/{slug}/prewarm` | `services/api/prewarm/prewarmManager.ts` (4.5) |

Đặt thẻ META trong `<head>`, hoặc phục vụ mã xác minh dưới dạng `text/plain` tại `/translateme-verification.txt`. Phản hồi xác minh cần có HTTP 2xx và cùng origin với URL đăng ký. Slug công khai chỉ được cấp khi xác minh thành công.

`Host` = `{ slug, display_name, home_url, source_lang, target_langs, status, verification_code, no_translate_selectors, created_at }`. Console cũng hiểu các mã lỗi hiện tại của `siteManager` (`SITE_UNREACHABLE`, `VERIFICATION_CODE_MISMATCH`, `DUPLICATE_SLUG`, `FORBIDDEN`) cho tới khi đổi sang mã của Bảng 2.10.
