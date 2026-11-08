# Bằng Chứng Nghiệm Thu: Bộ Thử Chống SSRF (Kịch bản 6)

> **Căn cứ:** Nhiệm vụ Tuần 5 – TV4 (Phạm Kim Tùng), Bảng 3.2, Phụ lục C (Bảng chứng cứ nghiệm thu) và Báo cáo kiến trúc TranslateMe.
> **Người thực hiện:** TV4 – Phạm Kim Tùng
> **Thời gian nghiệm thu:** 2026-11-08T14:54:08.112Z

## 1. Tiêu chí Đánh giá & Kết quả Tổng quan

- **Số lượng phép thử:** 9 đích bắt buộc
- **Kết quả đạt:** **9/9 PASS** (100.0%)
- **Đích bị chặn:** **9/9**
- **Số kết nối tới IP nội bộ:** **0 (0 kết nối)**
- **Số sự cố rò rỉ Header Cookie/Auth:** **0 (0 sự cố)**
- **Đánh giá chung:** **✅ ĐẠT 100% TIÊU CHÍ AN TOÀN**

## 2. Bảng Tổng Hợp 9 Đích Tấn Công SSRF

| ID | Đích kiểm thử | Mục tiêu tấn công | Kết quả | Lý do chặn | Kết nối nội bộ | Vệ sinh Header |
| :---: | :--- | :--- | :---: | :---: | :---: | :---: |
| **6.1** | `http://169.254.169.254/latest/meta-data/` | AWS Instance Metadata (Link-Local) | ✅ PASS | `PRIVATE_IP` | 0 IP nội bộ (None) | Đã loại bỏ Cookie/Auth |
| **6.2** | `http://localhost/` | Loopback Hostname (DNS) | ✅ PASS | `PRIVATE_IP` | 0 IP nội bộ (None) | Đã loại bỏ Cookie/Auth |
| **6.3** | `http://127.0.0.1/` | IPv4 Loopback (127.0.0.0/8) | ✅ PASS | `PRIVATE_IP` | 0 IP nội bộ (None) | Đã loại bỏ Cookie/Auth |
| **6.4** | `http://10.0.0.1/` | Private Network RFC 1918 Class A | ✅ PASS | `PRIVATE_IP` | 0 IP nội bộ (None) | Đã loại bỏ Cookie/Auth |
| **6.5** | `http://[::1]/` | IPv6 Loopback | ✅ PASS | `PRIVATE_IP` | 0 IP nội bộ (None) | Đã loại bỏ Cookie/Auth |
| **6.6** | `http://[fd00::1]/` | IPv6 Unique Local Address (fc00::/7) | ✅ PASS | `PRIVATE_IP` | 0 IP nội bộ (None) | Đã loại bỏ Cookie/Auth |
| **6.7** | `http://rebind.attacker.test/` | DNS Rebinding Time-of-Check to Time-of-Use | ✅ PASS | `PINNED_LOOKUP_NO_REBIND` | 0 IP nội bộ (93.184.216.34) | Đã loại bỏ Cookie/Auth |
| **6.8** | `http://public.test/redirect-to-private` | Open Redirect Chaining to SSRF | ✅ PASS | `PRIVATE_IP` | 0 IP nội bộ (93.184.216.34) | Đã loại bỏ Cookie/Auth |
| **6.9** | `http://example.test:22/` | Restricted Port Protocol Smuggling | ✅ PASS | `PORT` | 0 IP nội bộ (None) | Đã loại bỏ Cookie/Auth |

## 3. Phân Tích Kỹ Thuật Các Chốt Chặn

### 3.1. Chặn IP Literal Link-Local & Loopback (6.1, 6.3, 6.4, 6.5, 6.6)
- **Nguyên lý:** Phân tích cú pháp URL ngay tại hàm `validateUrl()` và `isBlockedIp()`.
- Các dải địa chỉ bị chặn tuyệt đối gồm: `169.254.0.0/16` (AWS IMDS metadata), `127.0.0.0/8` (IPv4 loopback), `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` (RFC 1918), `::1` (IPv6 loopback), `fc00::/7` (IPv6 ULA).
- **Kết quả:** Bị chặn ngay từ bước kiểm tra URL, **hoàn toàn không gọi DNS và không mở bất kỳ socket TCP nào**.

### 3.2. Chặn Tên Miền Phân Giải Ra IP Nội Bộ (6.2 - localhost)
- **Nguyên lý:** Sau khi kiểm tra tên miền hợp lệ, hệ thống thực hiện phân giải DNS độc lập thông qua `resolver` (lấy tất cả địa chỉ A và AAAA).
- Mọi IP trả về từ DNS đều được đối soát qua hàm `isBlockedIp()`. Nếu có bất kỳ IP nào thuộc dải cấm, toàn bộ yêu cầu bị hủy bỏ.
- **Kết quả:** `localhost` phân giải ra `127.0.0.1` bị từ chối ngay với mã `PRIVATE_IP`, không có kết nối nào được tạo.

### 3.3. Chống Tấn Công DNS Rebinding (6.7)
- **Kỹ thuật tấn công:** Kẻ tấn công cấu hình máy chủ DNS trả về IP công khai ở lần tra cứu 1 (để qua mặt bộ lọc), nhưng trả về `127.0.0.1` ở lần tra cứu 2 khi client tạo kết nối TCP.
- **Giải pháp Pinned Lookup (Ghim IP):** `safeFetch` chỉ hỏi DNS đúng **1 lần duy nhất** cho mỗi lần nhảy. Sau khi IP công khai được kiểm duyệt an toàn, hàm tạo ra một `lookup` function tùy biến ghim trực tiếp IP này vào cấu hình kết nối của Node.js `http`/`https` Agent.
- **Kết quả:** Khi mở kết nối TCP, Node.js sử dụng trực tiếp IP công khai đã ghim, **tuyệt đối không phân giải lại DNS lần 2**. Thêm vào đó, tại tầng lookup ghim có thêm lớp phòng thủ chiều sâu từ chối IP nội bộ nếu có lỗi bất thường.

### 3.4. Chống Tấn Công Chuyển Hướng Kép (6.8 - Open Redirect)
- **Kỹ thuật tấn công:** Lợi dụng một trang web công khai hợp lệ trả về mã chuyển hướng HTTP `302 Found` với header `Location: http://10.0.0.1/`.
- **Giải pháp:** Tắt chế độ tự động chuyển hướng (`follow redirect`) mặc định của thư viện HTTP. `safeFetch` tự kiểm soát vòng lặp chuyển hướng thủ công (tối đa 5 lần). Mỗi khi nhận mã 3xx, URL trong `Location` được bóc tách và chạy lại **toàn bộ quy trình kiểm duyệt an toàn SSRF từ đầu**.
- **Vệ sinh Header:** Khi gửi yêu cầu và khi chuyển hướng, các header nhạy cảm như `Cookie`, `Cookie2`, `Authorization`, `Proxy-Authorization` bị loại bỏ 100% bằng cả bộ lọc Allowlist và Blacklist chủ động.
- **Kết quả:** Yêu cầu chuyển hướng tới `10.0.0.1` bị chặn ngay lập tức; không có bất kỳ kết nối socket nào được mở tới `10.0.0.1`.

### 3.5. Chặn Cổng Dịch Vụ Không Phải Web (6.9 - Cổng 22 SSH)
- **Nguyên lý:** Chỉ cho phép cổng 80 (`http`) và cổng 443 (`https`). Bất kỳ cổng nào khác (cổng 22, 21, 25, 3306, 6379...) đều bị loại ngay tại hàm `validateUrl()`.
- **Kết quả:** URL có cổng 22 bị chặn với mã `PORT` ngay lập tức, không phân giải DNS và không mở kết nối.

## 4. Toàn Văn Nhật Ký Thực Thi (Execution Log)

```text
========================================================================================================
                      BỘ KIỂM THỬ AN TOÀN SSRF (KỊCH BẢN 6 – NHIỆM VỤ TUẦN 5 – TV4)                     
========================================================================================================
Thời gian thực thi: 2026-11-08T14:54:08.112Z
Tổng số phép thử:   9
Đích bị chặn:       9/9 (100%)
Kết nối nội bộ:     0 (0 kết nối)
Header nhạy cảm:    0 rò rỉ (100% được làm sạch)
Trạng thái:         ✅ TẤT CẢ PHÉP THỬ ĐẠT (9/9 PASS)
--------------------------------------------------------------------------------------------------------
[6.1] AWS IMDS Metadata IP (169.254.169.254)
  - URL đích:          http://169.254.169.254/latest/meta-data/
  - Danh mục tấn công: AWS Instance Metadata (Link-Local)
  - Outcome nhận được: BLOCKED (Lý do: PRIVATE_IP)
  - Bị chặn SSRF:      CÓ (Chặn thành công)
  - Kết nối IP nội bộ: KHÔNG (An toàn 100%)
  - Vệ sinh Header:    ĐẠT (Không chuyển tiếp Cookie/Auth)
  - IP đã kết nối:     [Không có kết nối nào]
  - DNS queries:       [Không có DNS query]
  - Kết quả:           ✅ PASS
  - Chi tiết:          IP bị chặn: 169.254.169.254
--------------------------------------------------------------------------------------------------------
[6.2] Tên miền localhost
  - URL đích:          http://localhost/
  - Danh mục tấn công: Loopback Hostname (DNS)
  - Outcome nhận được: BLOCKED (Lý do: PRIVATE_IP)
  - Bị chặn SSRF:      CÓ (Chặn thành công)
  - Kết nối IP nội bộ: KHÔNG (An toàn 100%)
  - Vệ sinh Header:    ĐẠT (Không chuyển tiếp Cookie/Auth)
  - IP đã kết nối:     [Không có kết nối nào]
  - DNS queries:       [localhost]
  - Kết quả:           ✅ PASS
  - Chi tiết:          localhost phân giải ra IP bị chặn: 127.0.0.1
--------------------------------------------------------------------------------------------------------
[6.3] IPv4 Loopback (127.0.0.1)
  - URL đích:          http://127.0.0.1/
  - Danh mục tấn công: IPv4 Loopback (127.0.0.0/8)
  - Outcome nhận được: BLOCKED (Lý do: PRIVATE_IP)
  - Bị chặn SSRF:      CÓ (Chặn thành công)
  - Kết nối IP nội bộ: KHÔNG (An toàn 100%)
  - Vệ sinh Header:    ĐẠT (Không chuyển tiếp Cookie/Auth)
  - IP đã kết nối:     [Không có kết nối nào]
  - DNS queries:       [Không có DNS query]
  - Kết quả:           ✅ PASS
  - Chi tiết:          IP bị chặn: 127.0.0.1
--------------------------------------------------------------------------------------------------------
[6.4] IPv4 Private Class A (10.0.0.1)
  - URL đích:          http://10.0.0.1/
  - Danh mục tấn công: Private Network RFC 1918 Class A
  - Outcome nhận được: BLOCKED (Lý do: PRIVATE_IP)
  - Bị chặn SSRF:      CÓ (Chặn thành công)
  - Kết nối IP nội bộ: KHÔNG (An toàn 100%)
  - Vệ sinh Header:    ĐẠT (Không chuyển tiếp Cookie/Auth)
  - IP đã kết nối:     [Không có kết nối nào]
  - DNS queries:       [Không có DNS query]
  - Kết quả:           ✅ PASS
  - Chi tiết:          IP bị chặn: 10.0.0.1
--------------------------------------------------------------------------------------------------------
[6.5] IPv6 Loopback ([::1])
  - URL đích:          http://[::1]/
  - Danh mục tấn công: IPv6 Loopback
  - Outcome nhận được: BLOCKED (Lý do: PRIVATE_IP)
  - Bị chặn SSRF:      CÓ (Chặn thành công)
  - Kết nối IP nội bộ: KHÔNG (An toàn 100%)
  - Vệ sinh Header:    ĐẠT (Không chuyển tiếp Cookie/Auth)
  - IP đã kết nối:     [Không có kết nối nào]
  - DNS queries:       [Không có DNS query]
  - Kết quả:           ✅ PASS
  - Chi tiết:          IP bị chặn: ::1
--------------------------------------------------------------------------------------------------------
[6.6] IPv6 Unique Local Address ([fd00::1])
  - URL đích:          http://[fd00::1]/
  - Danh mục tấn công: IPv6 Unique Local Address (fc00::/7)
  - Outcome nhận được: BLOCKED (Lý do: PRIVATE_IP)
  - Bị chặn SSRF:      CÓ (Chặn thành công)
  - Kết nối IP nội bộ: KHÔNG (An toàn 100%)
  - Vệ sinh Header:    ĐẠT (Không chuyển tiếp Cookie/Auth)
  - IP đã kết nối:     [Không có kết nối nào]
  - DNS queries:       [Không có DNS query]
  - Kết quả:           ✅ PASS
  - Chi tiết:          IP bị chặn: fd00::1
--------------------------------------------------------------------------------------------------------
[6.7] Tấn công DNS Rebinding
  - URL đích:          http://rebind.attacker.test/
  - Danh mục tấn công: DNS Rebinding Time-of-Check to Time-of-Use
  - Outcome nhận được: OK (Lý do: PINNED_LOOKUP_NO_REBIND)
  - Bị chặn SSRF:      CÓ (Chặn thành công)
  - Kết nối IP nội bộ: KHÔNG (An toàn 100%)
  - Vệ sinh Header:    ĐẠT (Không chuyển tiếp Cookie/Auth)
  - IP đã kết nối:     [93.184.216.34]
  - DNS queries:       [rebind.attacker.test]
  - Kết quả:           ✅ PASS
  - Chi tiết:          DNS chỉ phân giải 1 lần. Socket ghim trực tiếp IP công khai đã kiểm duyệt. Địa chỉ 127.0.0.1 hoàn toàn không bao giờ được kết nối.
--------------------------------------------------------------------------------------------------------
[6.8] URL chuyển hướng HTTP 302 về địa chỉ nội bộ
  - URL đích:          http://public.test/redirect-to-private
  - Danh mục tấn công: Open Redirect Chaining to SSRF
  - Outcome nhận được: BLOCKED (Lý do: PRIVATE_IP)
  - Bị chặn SSRF:      CÓ (Chặn thành công)
  - Kết nối IP nội bộ: KHÔNG (An toàn 100%)
  - Vệ sinh Header:    ĐẠT (Không chuyển tiếp Cookie/Auth)
  - IP đã kết nối:     [93.184.216.34]
  - DNS queries:       [public.test]
  - Kết quả:           ✅ PASS
  - Chi tiết:          Chuyển hướng 302 tới 10.0.0.1 bị chặn ngay lập tức. Header Cookie và Authorization bị xóa bỏ 100%, không chuyển tiếp.
--------------------------------------------------------------------------------------------------------
[6.9] Cổng không hợp lệ (Cổng 22 - SSH)
  - URL đích:          http://example.test:22/
  - Danh mục tấn công: Restricted Port Protocol Smuggling
  - Outcome nhận được: BLOCKED (Lý do: PORT)
  - Bị chặn SSRF:      CÓ (Chặn thành công)
  - Kết nối IP nội bộ: KHÔNG (An toàn 100%)
  - Vệ sinh Header:    ĐẠT (Không chuyển tiếp Cookie/Auth)
  - IP đã kết nối:     [Không có kết nối nào]
  - DNS queries:       [Không có DNS query]
  - Kết quả:           ✅ PASS
  - Chi tiết:          Cổng 22 bị chặn ở bước validateUrl trước khi gọi DNS và trước khi kết nối mạng. Chỉ cho phép cổng 80 và 443.
--------------------------------------------------------------------------------------------------------
KẾT LUẬN: Kịch bản 6: 9/9 đích bị chặn. 0 kết nối socket ra địa chỉ nội bộ. 0 rò rỉ Cookie/Authorization.
========================================================================================================
```
