# Đặc Tả Kịch Bản 6 & Báo Cáo Kiểm Thử Hồi Quy Mô Phỏng SSRF

> [!IMPORTANT]
> **LƯU Ý VỀ PHẠM VI & CHỨNG CỨ NGHIỆM THU (ĐÃ THỐNG NHẤT THEO REVIEW PR #36):**
> - Báo cáo trong tài liệu này là kết quả **kiểm thử hồi quy đơn vị mô phỏng (Offline Mock Regression Test)** trên môi trường phát triển cục bộ và CI, sử dụng `fakeResolver` và `fakeTransport` để xác minh tính đúng đắn trong logic kiểm duyệt của `safeFetch`.
> - **Tiêu chí đo chính thức của bộ kiểm thử đơn vị Kịch bản 6**: **9/9 tình huống ngăn kết nối tới IP nội bộ / cổng cấm (`0` kết nối socket tới IP nội bộ)** và **0 rò rỉ header nhạy cảm trên các request ra ngoài**, gồm `8/9` yêu cầu bị `BLOCKED` hoàn toàn và `1/9` yêu cầu (`6.7`) được phép hoàn tất an toàn tới IP công khai đã ghim (không gọi là *"9/9 yêu cầu bị `BLOCKED`"*).
> - Kết quả *"0 kết nối socket tới IP nội bộ"* trong bộ thử này phản ánh việc mock transport không nhận được kết nối nào tới địa chỉ nội bộ. **Đây chưa phải là kết quả đo đạc kết nối mạng thực tế trên môi trường demo**.
> - **Bằng chứng nghiệm thu chính thức** cho Kịch bản 6 trong Bảng chứng cứ (Phụ lục C) sẽ được thực hiện và thu thập trên **bản demo đã triển khai thực tế** trong **Hạng mục 5.9** với cách ghi nhận phù hợp (CloudWatch Logs, VPC Flow Logs và phản hồi HTTP của API Gateway / Proxy).

---

## 1. Bảng Tiêu Chí Nghiệm Thu & Đặc Tả 9 Tình Huống (Kịch bản 6)

### 1.1. Tiêu chí đánh giá thống nhất

| Tiêu chí nghiệm thu | Ngưỡng đạt | Kết quả mô phỏng hiện tại | Phạm vi áp dụng |
| :--- | :---: | :---: | :--- |
| **Ngăn chặn kết nối tới IP nội bộ / cổng cấm** | **9/9 tình huống (`0` kết nối IP nội bộ)** | **9/9 PASS** (`0` socket tới IP nội bộ) | Cả 9 tình huống (`6.1`–`6.9`) |
| **Phân loại outcome ở tầng `safeFetch`** | `8/9 BLOCKED` + `1/9 OK` (ghim IP công khai) | **8 BLOCKED + 1 OK** | `6.1`–`6.6`, `6.8`, `6.9` trả `BLOCKED`; `6.7` trả `OK (PINNED_LOOKUP_PUBLIC_ALLOWED)` |
| **Vệ sinh header nhạy cảm (`Cookie`, `Authorization`, `Proxy-Authorization`, `X-Custom-Secret`)** | **0 rò rỉ** trên mọi request ra ngoài | **2/2 request qua transport sạch 100%** (`0` rò rỉ) | Kiểm chứng thực tế trên `transport.calls` ở `6.7` và `6.8`; `6.1`–`6.6`, `6.9` dừng trước transport (`0` request) |
| **Đồng bộ bộ đếm kiểm thử đơn vị** | Không đếm ca `OK` (`6.7`) vào bộ đếm `BLOCKED` | Đã tách rõ biến đếm | [`safeFetch.test.ts`](../libs/common/test/safeFetch.test.ts) & [`ssrfScenario6.test.ts`](../libs/common/test/ssrfScenario6.test.ts) |

> **Giải thích vì sao không tính 6.7 vào nhóm `BLOCKED`:** Ở tình huống tấn công DNS Rebinding 1 bước (`6.7`), lần phân giải DNS đầu tiên trả về IP công khai hợp lệ (`93.184.216.34`). `safeFetch` chống tấn công TOCTOU bằng cách **chỉ phân giải DNS đúng 1 lần** và ghim IP công khai này qua `createPinnedLookup`, nên socket không bao giờ tái phân giải ra `127.0.0.1` và hoàn tất kết nối tới IP công khai với `OK`. Các kịch bản rebinding trả kèm IP nội bộ trong bản ghi DNS (`[PUBLIC_IP, '10.0.0.5']`) hoặc rebinding qua bước chuyển hướng 302 đều trả `BLOCKED (PRIVATE_IP)` và đã có unit test riêng trong [`libs/common/test/safeFetch.test.ts`](../libs/common/test/safeFetch.test.ts).

### 1.2. Đặc tả 9 tình huống thử nghiệm SSRF

| ID | Đích kiểm thử | Mục tiêu tấn công | Cơ chế kiểm duyệt của safeFetch | Outcome mong đợi | Ngăn kết nối IP nội bộ |
| :---: | :--- | :--- | :--- | :---: | :---: |
| **6.1** | `http://169.254.169.254/latest/meta-data/` | Đánh cắp IAM credential từ AWS IMDSv1/v2 metadata | Chặn dải link-local `169.254.0.0/16` tại `validateUrl` | `BLOCKED (PRIVATE_IP)` | 0 kết nối (dừng trước transport) |
| **6.2** | `http://localhost/` | Tên miền loopback trỏ về dịch vụ nội bộ | Phân giải DNS và chặn IP `127.0.0.1` tại `isBlockedIp` | `BLOCKED (PRIVATE_IP)` | 0 kết nối (dừng trước transport) |
| **6.3** | `http://127.0.0.1/` | Địa chỉ IPv4 Loopback (`127.0.0.0/8`) | Chặn IP literal loopback tại `validateUrl` | `BLOCKED (PRIVATE_IP)` | 0 kết nối (dừng trước transport) |
| **6.4** | `http://10.0.0.1/` | Dải mạng riêng nội bộ VPC RFC 1918 Class A | Chặn IP literal dải riêng `10.0.0.0/8` tại `validateUrl` | `BLOCKED (PRIVATE_IP)` | 0 kết nối (dừng trước transport) |
| **6.5** | `http://[::1]/` | Địa chỉ IPv6 Loopback `::1` | Chặn IP literal IPv6 loopback tại `validateUrl` | `BLOCKED (PRIVATE_IP)` | 0 kết nối (dừng trước transport) |
| **6.6** | `http://[fd00::1]/` | Địa chỉ IPv6 Unique Local Address (ULA) | Chặn dải IPv6 ULA `fc00::/7` tại `validateUrl` | `BLOCKED (PRIVATE_IP)` | 0 kết nối (dừng trước transport) |
| **6.7** | `http://rebind.attacker.test/` | Tấn công DNS Rebinding (TOCTOU) | DNS chỉ gọi 1 lần; ghim IP công khai qua `createPinnedLookup`, không tái phân giải về `127.0.0.1` | `OK (PINNED_LOOKUP_PUBLIC_ALLOWED)` | 0 kết nối tới `127.0.0.1` (chỉ nối `93.184.216.34`) |
| **6.8** | `http://public.test/redirect-to-private` | Chuỗi chuyển hướng HTTP 302 về IP nội bộ | Chặn chuyển hướng tự động, kiểm duyệt lại URL `Location` | `BLOCKED (PRIVATE_IP)` | 0 kết nối tới `10.0.0.1` (chỉ nối bước 1 `93.184.216.34`) |
| **6.9** | `http://example.test:22/` | Tấn công quét cổng dịch vụ (SSH port 22) | Chỉ cho phép cổng `80` và `443`; chặn các cổng khác | `BLOCKED (PORT)` | 0 kết nối (dừng trước transport) |

---

## 2. Kết Quả Kiểm Thử Hồi Quy Mô Phỏng (Offline Mock Regression)

Bộ kiểm thử đơn vị hồi quy được thực thi thông qua module [`libs/common/test/ssrfScenario6.ts`](../libs/common/test/ssrfScenario6.ts) với `fakeResolver`, `fakeTransport` và truyền bộ header kiểm thử (`Cookie`, `Authorization`, `Proxy-Authorization`, `X-Custom-Secret`, `Accept-Language`, `User-Agent`) vào **cả 9 tình huống**; trạng thái vệ sinh header được tính trực tiếp từ `transport.calls` thực tế:

| ID | Đích kiểm thử | Mục tiêu tấn công | Kết quả mô phỏng | Phân loại xử lý | Ngăn truy cập nội bộ | Vệ sinh Header |
| :---: | :--- | :--- | :---: | :---: | :---: | :---: |
| **6.1** | `http://169.254.169.254/latest/meta-data/` | AWS Instance Metadata (Link-Local) | ✅ PASS | Bị chặn hoàn toàn (`PRIVATE_IP`) | ✅ Đạt (0 IP nội bộ) | ➖ Không gửi request (chặn trước transport) |
| **6.2** | `http://localhost/` | Loopback Hostname (DNS) | ✅ PASS | Bị chặn hoàn toàn (`PRIVATE_IP`) | ✅ Đạt (0 IP nội bộ) | ➖ Không gửi request (chặn trước transport) |
| **6.3** | `http://127.0.0.1/` | IPv4 Loopback (127.0.0.0/8) | ✅ PASS | Bị chặn hoàn toàn (`PRIVATE_IP`) | ✅ Đạt (0 IP nội bộ) | ➖ Không gửi request (chặn trước transport) |
| **6.4** | `http://10.0.0.1/` | Private Network RFC 1918 Class A | ✅ PASS | Bị chặn hoàn toàn (`PRIVATE_IP`) | ✅ Đạt (0 IP nội bộ) | ➖ Không gửi request (chặn trước transport) |
| **6.5** | `http://[::1]/` | IPv6 Loopback | ✅ PASS | Bị chặn hoàn toàn (`PRIVATE_IP`) | ✅ Đạt (0 IP nội bộ) | ➖ Không gửi request (chặn trước transport) |
| **6.6** | `http://[fd00::1]/` | IPv6 Unique Local Address (fc00::/7) | ✅ PASS | Bị chặn hoàn toàn (`PRIVATE_IP`) | ✅ Đạt (0 IP nội bộ) | ➖ Không gửi request (chặn trước transport) |
| **6.7** | `http://rebind.attacker.test/` | DNS Rebinding Time-of-Check to Time-of-Use | ✅ PASS | Cho phép IP công khai ghim (`93.184.216.34`) | ✅ Đạt (0 IP nội bộ) | ✅ Đã kiểm chứng trên 1 request (xóa Cookie/Auth) |
| **6.8** | `http://public.test/redirect-to-private` | Open Redirect Chaining to SSRF | ✅ PASS | Bị chặn hoàn toàn (`PRIVATE_IP`) | ✅ Đạt (0 IP nội bộ) | ✅ Đã kiểm chứng trên 1 request (xóa Cookie/Auth) |
| **6.9** | `http://example.test:22/` | Restricted Port Protocol Smuggling | ✅ PASS | Bị chặn hoàn toàn (`PORT`) | ✅ Đạt (0 IP nội bộ) | ➖ Không gửi request (chặn trước transport) |

- **Tổng số tình huống mô phỏng:** 9/9 tình huống (`passCount = 9`, `failCount = 0`).
- **Ngăn chặn kết nối IP nội bộ (tiêu chí chính):** **9/9 tình huống đạt (0 kết nối socket tới IP nội bộ)**.
- **Yêu cầu bị chặn hoàn toàn (`BLOCKED`):** **8/9** (`6.1`–`6.6`, `6.8`, `6.9` với lý do `PRIVATE_IP` hoặc `PORT`).
- **Yêu cầu an toàn được phép (`OK`):** **1/9** (`6.7` DNS rebinding kết nối tới IP công khai đã ghim `93.184.216.34`, không phân giải lại DNS lần 2 và không chạm `127.0.0.1`).
- **Kiểm chứng vệ sinh Header nhạy cảm:**
  - **2/2 tình huống có request gửi tới mock transport (`6.7`, `6.8`):** đã kiểm tra toàn bộ `transport.calls` (tổng 2 request) và xác minh loại bỏ 100% `cookie`, `cookie2`, `authorization`, `proxy-authorization`, `x-custom-secret`, đồng thời giữ nguyên `accept-language` và `user-agent`.
  - **7/9 tình huống còn lại (`6.1`–`6.6`, `6.9`):** bị chặn trước tầng `transport` nên `0` request rời khỏi client (không gắn nhãn đã làm sạch ở transport cho các ca không phát sinh request).

---

## 3. Kế Hoạch Thu Thập Bằng Chứng Thực Tế Trên Môi Trường Demo (Hạng mục 5.9)

Khi môi trường demo được triển khai hoàn chỉnh (khi các hạng mục 5.1, 5.4–5.7 hoàn tất), nhóm sẽ tiến hành đo đạc và lập bằng chứng nghiệm thu chính thức theo quy trình sau:

1. **Thực thi trên endpoint API thật:**
   - Sử dụng API xác minh website `POST /console/hosts/{slug}/verify` hoặc Proxy `/proxy/*` trên bản demo với 9 URL kiểm thử trong Bảng 1.2.
   - Lưu ý phối hợp E2E (`e2e/tests/ssrf.test.ts`): ở tầng API xác minh website, fixture cho ca DNS rebinding (`S7`) phải trỏ tới domain test không chứa thẻ meta/file xác minh hoặc chuyển hướng/phân giải về IP nội bộ để đảm bảo `siteManager` trả lỗi `4xx` (`SITE_UNREACHABLE` / `VERIFICATION_FAILED`) thay vì cho phép `ACTIVE`.
2. **Thu thập phản hồi HTTP:**
   - Xác nhận không có website SSRF nào chuyển sang trạng thái `ACTIVE`, và không có nội dung metadata/dịch vụ nội bộ nào lọt vào phản hồi.
3. **Trích xuất nhật ký CloudWatch Logs:**
   - Trích xuất CloudWatch Logs của Lambda hàm `siteManager` và `proxy` để chứng minh log ghi nhận `BLOCKED PRIVATE_IP` / `BLOCKED PORT` và không có outbound socket nào tới IP nội bộ (`169.254.169.254`, `127.0.0.1`, `10.0.0.1`...).
4. **Đóng gói bằng chứng Phụ lục C:**
   - Đưa kết quả HTTP response + log CloudWatch thực tế vào Báo cáo cuối (Hạng mục 5.2) và Bảng chứng cứ nghiệm thu (Hạng mục 5.9).

---

## 4. Phân Tích Kỹ Thuật Các Chốt Chặn của `safeFetch`

### 4.1. Chặn IP Literal Link-Local & Loopback (`6.1`, `6.3`, `6.4`, `6.5`, `6.6`)
- **Nguyên lý:** Phân tích cú pháp URL ngay tại hàm `validateUrl()` và `isBlockedIp()`.
- Các dải địa chỉ bị chặn tuyệt đối gồm: `169.254.0.0/16` (AWS IMDS metadata), `127.0.0.0/8` (IPv4 loopback), `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` (RFC 1918), `::1` (IPv6 loopback), `fc00::/7` (IPv6 ULA).
- **Kết quả:** Bị chặn ngay trước tầng DNS (cho IP literal) và trước tầng `transport` (`0` request được gửi đi).

### 4.2. Chặn Tên Miền Phân Giải Ra IP Nội Bộ (`6.2` - localhost)
- **Nguyên lý:** Sau khi kiểm tra tên miền hợp lệ, hệ thống thực hiện phân giải DNS độc lập thông qua `resolver` (lấy tất cả địa chỉ A và AAAA).
- Mọi IP trả về từ DNS đều được đối soát qua hàm `isBlockedIp()`. Nếu có bất kỳ IP nào thuộc dải cấm, toàn bộ yêu cầu bị hủy bỏ ngay lập tức (`0` request tới `transport`).

### 4.3. Chống Tấn Công DNS Rebinding (`6.7`)
- **Kỹ thuật tấn công:** Kẻ tấn công cấu hình máy chủ DNS trả về IP công khai ở lần tra cứu 1 (để qua mặt bộ lọc), nhưng trả về `127.0.0.1` ở lần tra cứu 2 khi client tạo kết nối TCP.
- **Giải pháp Pinned Lookup (Ghim IP):** `safeFetch` chỉ hỏi DNS đúng **1 lần duy nhất** cho mỗi lần nhảy. Sau khi IP công khai được kiểm duyệt an toàn, hàm tạo ra một `lookup` function tùy biến (`createPinnedLookup`) ghim trực tiếp IP này vào cấu hình kết nối của Node.js `http`/`https` Agent.
- **Phân loại xử lý & Kết quả:**
  - Kết nối tới IP công khai hợp lệ đã kiểm duyệt (`93.184.216.34`) hoàn tất với `outcome: OK`, và toàn bộ header nhạy cảm (`Cookie`, `Authorization`, `Proxy-Authorization`, `X-Custom-Secret`) đã được xác minh loại bỏ trên request gửi tới `transport`.
  - Tuyệt đối **không kết nối tới `127.0.0.1`**: Khi mở kết nối TCP, Node.js sử dụng trực tiếp IP công khai đã ghim, **tuyệt đối không phân giải lại DNS lần 2**. Tại tầng lookup ghim vẫn kiểm tra lại `isBlockedIp` như lớp phòng thủ chiều sâu.

### 4.4. Chống Tấn Công Chuyển Hướng Kép (`6.8` - Open Redirect)
- **Kỹ thuật tấn công:** Lợi dụng một trang web công khai hợp lệ trả về mã chuyển hướng HTTP `302 Found` với header `Location: http://10.0.0.1/`.
- **Giải pháp:** Tắt chế độ tự động chuyển hướng mặc định của thư viện HTTP. `safeFetch` tự kiểm soát vòng lặp chuyển hướng thủ công (tối đa 5 lần). Mỗi khi nhận mã 3xx, URL trong `Location` được chạy lại toàn bộ quy trình kiểm duyệt SSRF từ đầu.
- **Vệ sinh Header:** Xác minh thực tế trên request gửi tới `public.test` (`93.184.216.34`) rằng mọi header nhạy cảm (`Cookie`, `Authorization`, `Proxy-Authorization`, `X-Custom-Secret`) đã bị xóa sạch trước khi gửi, còn request chuyển hướng tới `10.0.0.1` bị chặn ngay lập tức.

### 4.5. Chặn Cổng Dịch Vụ Không Phải Web (`6.9` - Cổng 22 SSH)
- **Nguyên lý:** Chỉ cho phép cổng `80` (`http`) và cổng `443` (`https`). Mọi cổng khác bị loại ngay tại `validateUrl()` trước khi gọi DNS và trước khi gọi `transport`.

---

## 5. Nhật Ký Kiểm Thử Mô Phỏng (`npm --prefix libs/common run test:ssrf`)

```text
========================================================================================================
             BỘ KIỂM THỬ HỒI QUY MÔ PHỎNG AN TOÀN SSRF (KỊCH BẢN 6 – MOCK SIMULATION)                  
========================================================================================================
Thời gian thực thi:          2026-11-11T14:50:06.285Z
Chế độ kiểm thử:             Mô phỏng đơn vị (Mock Dependencies: fakeResolver + fakeTransport)
Phạm vi áp dụng:             Kiểm thử hồi quy logic safeFetch (Không dùng làm bằng chứng nghiệm thu demo)
Tổng số tình huống:          9
Ngăn chặn truy cập nội bộ:   9/9 tình huống (tiêu chí 0 kết nối tới IP nội bộ)
  + Yêu cầu bị chặn BLOCKED:       8/9 (6.1–6.6, 6.8, 6.9)
  + Yêu cầu ghim IP công khai OK:  1/9 (6.7 DNS rebinding, 0 kết nối nội bộ)
Kết nối tới IP nội bộ:       0 kết nối (Mock transport không nhận kết nối nào tới IP nội bộ)
Kiểm chứng vệ sinh Header:   2/2 tình huống qua transport (6.7, 6.8) xác minh xóa Cookie/Auth; 7/9 ca dừng trước transport (0 request)
Rò rỉ header nhạy cảm:       0 rò rỉ trên 2 request tới mock transport
Trạng thái:                  ✅ TẤT CẢ PHÉP THỬ MÔ PHỎNG ĐẠT (9/9 PASS)
--------------------------------------------------------------------------------------------------------
[6.1] AWS IMDS Metadata IP (169.254.169.254)
  - URL đích:                  http://169.254.169.254/latest/meta-data/
  - Danh mục tấn công:         AWS Instance Metadata (Link-Local)
  - Outcome mong đợi / thực tế: BLOCKED (PRIVATE_IP) / BLOCKED (PRIVATE_IP)
  - Phân loại xử lý:           Bị chặn hoàn toàn bởi safeFetch
  - Ngăn truy cập nội bộ:      ĐẠT (Mock transport không nhận kết nối nội bộ)
  - Vệ sinh Header:            KHÔNG GỬI – Đã truyền header kiểm thử nhưng bị chặn trước transport (0 request gửi đi)
  - Request tới mock transport: 0
  - IP mock kết nối:           [Không có kết nối nào tới transport]
  - DNS mock queries:          [Không có DNS query]
  - Kết quả mô phỏng:          ✅ PASS
  - Chi tiết:                  IP bị chặn: 169.254.169.254
--------------------------------------------------------------------------------------------------------
[6.2] Tên miền localhost
  - URL đích:                  http://localhost/
  - Danh mục tấn công:         Loopback Hostname (DNS)
  - Outcome mong đợi / thực tế: BLOCKED (PRIVATE_IP) / BLOCKED (PRIVATE_IP)
  - Phân loại xử lý:           Bị chặn hoàn toàn bởi safeFetch
  - Ngăn truy cập nội bộ:      ĐẠT (Mock transport không nhận kết nối nội bộ)
  - Vệ sinh Header:            KHÔNG GỬI – Đã truyền header kiểm thử nhưng bị chặn trước transport (0 request gửi đi)
  - Request tới mock transport: 0
  - IP mock kết nối:           [Không có kết nối nào tới transport]
  - DNS mock queries:          [localhost]
  - Kết quả mô phỏng:          ✅ PASS
  - Chi tiết:                  localhost phân giải ra IP bị chặn: 127.0.0.1
--------------------------------------------------------------------------------------------------------
[6.3] IPv4 Loopback (127.0.0.1)
  - URL đích:                  http://127.0.0.1/
  - Danh mục tấn công:         IPv4 Loopback (127.0.0.0/8)
  - Outcome mong đợi / thực tế: BLOCKED (PRIVATE_IP) / BLOCKED (PRIVATE_IP)
  - Phân loại xử lý:           Bị chặn hoàn toàn bởi safeFetch
  - Ngăn truy cập nội bộ:      ĐẠT (Mock transport không nhận kết nối nội bộ)
  - Vệ sinh Header:            KHÔNG GỬI – Đã truyền header kiểm thử nhưng bị chặn trước transport (0 request gửi đi)
  - Request tới mock transport: 0
  - IP mock kết nối:           [Không có kết nối nào tới transport]
  - DNS mock queries:          [Không có DNS query]
  - Kết quả mô phỏng:          ✅ PASS
  - Chi tiết:                  IP bị chặn: 127.0.0.1
--------------------------------------------------------------------------------------------------------
[6.4] IPv4 Private Class A (10.0.0.1)
  - URL đích:                  http://10.0.0.1/
  - Danh mục tấn công:         Private Network RFC 1918 Class A
  - Outcome mong đợi / thực tế: BLOCKED (PRIVATE_IP) / BLOCKED (PRIVATE_IP)
  - Phân loại xử lý:           Bị chặn hoàn toàn bởi safeFetch
  - Ngăn truy cập nội bộ:      ĐẠT (Mock transport không nhận kết nối nội bộ)
  - Vệ sinh Header:            KHÔNG GỬI – Đã truyền header kiểm thử nhưng bị chặn trước transport (0 request gửi đi)
  - Request tới mock transport: 0
  - IP mock kết nối:           [Không có kết nối nào tới transport]
  - DNS mock queries:          [Không có DNS query]
  - Kết quả mô phỏng:          ✅ PASS
  - Chi tiết:                  IP bị chặn: 10.0.0.1
--------------------------------------------------------------------------------------------------------
[6.5] IPv6 Loopback ([::1])
  - URL đích:                  http://[::1]/
  - Danh mục tấn công:         IPv6 Loopback
  - Outcome mong đợi / thực tế: BLOCKED (PRIVATE_IP) / BLOCKED (PRIVATE_IP)
  - Phân loại xử lý:           Bị chặn hoàn toàn bởi safeFetch
  - Ngăn truy cập nội bộ:      ĐẠT (Mock transport không nhận kết nối nội bộ)
  - Vệ sinh Header:            KHÔNG GỬI – Đã truyền header kiểm thử nhưng bị chặn trước transport (0 request gửi đi)
  - Request tới mock transport: 0
  - IP mock kết nối:           [Không có kết nối nào tới transport]
  - DNS mock queries:          [Không có DNS query]
  - Kết quả mô phỏng:          ✅ PASS
  - Chi tiết:                  IP bị chặn: ::1
--------------------------------------------------------------------------------------------------------
[6.6] IPv6 Unique Local Address ([fd00::1])
  - URL đích:                  http://[fd00::1]/
  - Danh mục tấn công:         IPv6 Unique Local Address (fc00::/7)
  - Outcome mong đợi / thực tế: BLOCKED (PRIVATE_IP) / BLOCKED (PRIVATE_IP)
  - Phân loại xử lý:           Bị chặn hoàn toàn bởi safeFetch
  - Ngăn truy cập nội bộ:      ĐẠT (Mock transport không nhận kết nối nội bộ)
  - Vệ sinh Header:            KHÔNG GỬI – Đã truyền header kiểm thử nhưng bị chặn trước transport (0 request gửi đi)
  - Request tới mock transport: 0
  - IP mock kết nối:           [Không có kết nối nào tới transport]
  - DNS mock queries:          [Không có DNS query]
  - Kết quả mô phỏng:          ✅ PASS
  - Chi tiết:                  IP bị chặn: fd00::1
--------------------------------------------------------------------------------------------------------
[6.7] Tấn công DNS Rebinding
  - URL đích:                  http://rebind.attacker.test/
  - Danh mục tấn công:         DNS Rebinding Time-of-Check to Time-of-Use
  - Outcome mong đợi / thực tế: OK (PINNED_LOOKUP_PUBLIC_ALLOWED) / OK (PINNED_LOOKUP_PUBLIC_ALLOWED)
  - Phân loại xử lý:           Cho phép kết nối an toàn tới IP công khai đã ghim
  - Ngăn truy cập nội bộ:      ĐẠT (Mock transport không nhận kết nối nội bộ)
  - Vệ sinh Header:            ĐẠT – Đã gửi header nhạy cảm và kiểm chứng xóa bỏ trên 1 request tới mock transport
  - Request tới mock transport: 1
  - IP mock kết nối:           [93.184.216.34]
  - DNS mock queries:          [rebind.attacker.test]
  - Kết quả mô phỏng:          ✅ PASS
  - Chi tiết:                  DNS chỉ phân giải 1 lần. Socket ghim trực tiếp IP công khai 93.184.216.34 (kết nối an toàn OK, 0 kết nối tới 127.0.0.1) và đã xác minh xóa Cookie/Authorization trên request gửi tới transport.
--------------------------------------------------------------------------------------------------------
[6.8] URL chuyển hướng HTTP 302 về địa chỉ nội bộ
  - URL đích:                  http://public.test/redirect-to-private
  - Danh mục tấn công:         Open Redirect Chaining to SSRF
  - Outcome mong đợi / thực tế: BLOCKED (PRIVATE_IP) / BLOCKED (PRIVATE_IP)
  - Phân loại xử lý:           Bị chặn hoàn toàn bởi safeFetch
  - Ngăn truy cập nội bộ:      ĐẠT (Mock transport không nhận kết nối nội bộ)
  - Vệ sinh Header:            ĐẠT – Đã gửi header nhạy cảm và kiểm chứng xóa bỏ trên 1 request tới mock transport
  - Request tới mock transport: 1
  - IP mock kết nối:           [93.184.216.34]
  - DNS mock queries:          [public.test]
  - Kết quả mô phỏng:          ✅ PASS
  - Chi tiết:                  Chuyển hướng 302 tới 10.0.0.1 bị chặn ngay lập tức. Đã kiểm chứng request đầu tới IP công khai không chứa Cookie/Authorization/Proxy-Authorization.
--------------------------------------------------------------------------------------------------------
[6.9] Cổng không hợp lệ (Cổng 22 - SSH)
  - URL đích:                  http://example.test:22/
  - Danh mục tấn công:         Restricted Port Protocol Smuggling
  - Outcome mong đợi / thực tế: BLOCKED (PORT) / BLOCKED (PORT)
  - Phân loại xử lý:           Bị chặn hoàn toàn bởi safeFetch
  - Ngăn truy cập nội bộ:      ĐẠT (Mock transport không nhận kết nối nội bộ)
  - Vệ sinh Header:            KHÔNG GỬI – Đã truyền header kiểm thử nhưng bị chặn trước transport (0 request gửi đi)
  - Request tới mock transport: 0
  - IP mock kết nối:           [Không có kết nối nào tới transport]
  - DNS mock queries:          [Không có DNS query]
  - Kết quả mô phỏng:          ✅ PASS
  - Chi tiết:                  Cổng không được phép: 22
--------------------------------------------------------------------------------------------------------
KẾT LUẬN: Kịch bản 6 (Mô phỏng hồi quy): 9/9 tình huống ngăn kết nối tới IP nội bộ (gồm 8 yêu cầu bị chặn BLOCKED và 1 yêu cầu an toàn ghim IP công khai). 0 kết nối socket tới IP nội bộ. 2/2 tình huống gửi request tới transport (6.7, 6.8) xác minh không rò rỉ Cookie/Authorization (7 ca dừng trước transport). Lưu ý: Bằng chứng nghiệm thu chính thức sẽ được đo đạc trên bản demo (Hạng mục 5.9).
========================================================================================================
```
