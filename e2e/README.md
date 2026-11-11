# TranslateMe E2E – hạ tầng và nghiệm thu 5.1

Thư mục này là package độc lập dành cho test hộp đen qua HTTP. Nó không thay đổi script build/test unit của API và proxy. Yêu cầu Node.js 20 trở lên; các endpoint được gọi cấu hình trong `e2e/.env.<stage>` dựa trên `.env.example`.

## Cài đặt và tự kiểm tra offline

```sh
cd e2e
npm install
npm run selftest
```

Selftest chạy mock local, không gọi AWS. Các mode lỗi cố ý kiểm tra rò rỉ tenant, sai khác giữa lỗi quyền và `NOT_FOUND`, lộ dữ liệu Platform, lỗi khóa tenant và SSRF. Riêng mode SSRF cho phép xác minh địa chỉ metadata `169.254.169.254`; ca S1 phải thất bại trong chế độ này. Kết quả selftest không thay thế nghiệm thu trên API thật.

## Chạy trên môi trường đã seed dữ liệu

Tạo file `.env.<stage>` từ `.env.example`, nạp biến môi trường rồi chạy các lệnh trong thư mục `e2e/`:

```sh
npm run test:isolation
npm run test:ssrf
TM_ALLOW_MUTATION=1 npm run test:limits
```

Test cần `.state/<stage>.json` có tài khoản tenant A/B/C, Platform Admin, API keys, job và file_key. File state chứa mật khẩu và key, không được commit. Phần tạo dữ liệu demo thuộc nhánh triển khai demo; không có seed AWS trong package của nhánh này.

`limits.test.ts` đổi hạn mức và khóa tenant A. Chỉ bật `TM_ALLOW_MUTATION=1` trên dev/demo, và không chạy song song với isolation. SSRF S7/S8 cần fixture do TV4 cung cấp; nếu thiếu fixture, test đánh dấu SKIP và không được tính là đủ bằng chứng.

## Hợp đồng khớp project hiện tại

- Tạo website gửi `home_url`, `display_name`, `source_lang`, `target_langs`. API tự sinh `slug` từ hostname; mỗi tenant demo cần origin có hostname riêng, duy nhất và có thể xác minh.
- Xác minh website gửi `{ "method": "META" }` hoặc `FILE`.
- Platform Admin thuộc Cognito group `PlatformAdmins`.
- Body/các endpoint nghiệp vụ vẫn được gom ở `lib/contract.ts` để dễ cập nhật.

Project hiện tại chưa đăng ký một số route mà bộ nghiệm thu tuần 5 cần, gồm `/console/me`, `/console/tm`, `/console/usage`, `/console/batch/{id}` và các route quản trị danh sách/chi tiết tenant cùng cấu hình platform. Bộ test giữ các ca đó như tiêu chí đầu-cuối; các ca tương ứng chỉ có thể đạt sau khi các route được tích hợp vào sản phẩm và API Gateway. `GET /console/jobs/{id}` và các route website/batch đang có được gọi theo hợp đồng hiện tại.

## Cấu trúc

- `lib/`: cấu hình, Cognito JWT, HTTP retry, API contract, so sánh lỗi và evidence.
- `tests/`: isolation (kịch bản 4), limits (kịch bản 5), SSRF (kịch bản 6).
- `mock/`, `scripts/selftest.ts`: mock và tự kiểm tra offline.
