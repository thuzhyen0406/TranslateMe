# Website mẫu cho 5.4, 5.5 và kịch bản 8

Ba site tĩnh do `tools/build-sites.ts` sinh từ `lib/sampleSites.ts`. Các script đo trong `demo/` đọc cùng catalog đó.

| Site | Biến origin | Dùng cho | Trang |
| :--- | :--- | :--- | :--- |
| A – Homestay Phố Cổ | `TM_DEMO_ORIGIN_A` | 5.4: menu, biểu mẫu, ảnh, iframe, `{n}`, `translate="no"`, trang > 3 MB, trang dài, 404 | `/`, `/phong-nghi/`, `/lien-he/`, `/trang-dai/`, `/qua-lon/`, `sitemap.xml` (F6) |
| B – Đo độ trễ | `TM_DEMO_ORIGIN_B` | 5.5: mỗi trang đúng 100 câu | `/do-tre/lan-01/` … `/do-tre/lan-10/` (TM rỗng), `/do-tre/am/` (trúng TM, trúng cache) |
| C – Nhà hàng Sông Hoài | `TM_DEMO_ORIGIN_C` | Kịch bản 8: câu X ở trang-1 và trang-2 | `/trang-1/`, `/trang-2/`, `/trang-3/` |

**Mỗi site phải có hostname riêng**: `siteManager` sinh slug từ hostname, nên 3 site cùng `<user>.github.io` sẽ trùng slug. GitHub Pages cũng không chạy với repo private ở gói miễn phí.

## Đăng lên host tĩnh (ví dụ Netlify)

1. Chọn 3 tên, ví dụ `tm-mau-a.netlify.app`, `tm-mau-b.netlify.app`, `tm-mau-c.netlify.app`, rồi đặt vào `.env.<stage>`:
   `TM_DEMO_ORIGIN_A=https://tm-mau-a.netlify.app/`, tương tự cho B, C.
2. Build lần đầu (chưa có mã xác minh): `npm run sites:build`. Kết quả nằm ở `e2e/sites/dist/{a,b,c}/` (không commit).
3. Đăng mỗi thư mục lên đúng site của nó (Netlify: Add new site → Deploy manually → kéo thư mục; hoặc `npx netlify deploy --prod --dir sites/dist/a`).
4. `npm run demo:seed -- tenants`: seed tạo website, in mã xác minh của từng tenant rồi dừng vì chưa xác minh được.
5. Build lại với mã: `TM_DEMO_VERIFY_CODE_A=<mã A> TM_DEMO_VERIFY_CODE_B=<mã B> TM_DEMO_VERIFY_CODE_C=<mã C> npm run sites:build`, đăng lại cả 3 thư mục, rồi chạy lại `npm run demo:seed -- tenants`.
   - Trang chủ có `<meta name="translateme-site-verification" content="<mã>">` (META, mặc định).
   - Gốc site có `/translateme-verification.txt` (FILE, `TM_DEMO_VERIFY_METHOD=FILE`).
   - Giữ đúng thứ tự `name` trước `content`, vì `siteManager` so khớp nguyên chuỗi.

Bất kỳ host tĩnh nào có HTTPS và trả `text/html` đều dùng được (Cloudflare Pages, S3 + CloudFront riêng…). Trang `/khong-ton-tai/` cố ý không có, để origin trả 404.

## Đo và kiểm tra (cần stack đã deploy)

Xem phần "5.4, 5.5, kịch bản 8" trong `e2e/README.md`.
