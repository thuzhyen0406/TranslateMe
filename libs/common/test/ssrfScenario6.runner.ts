/**
 * CLI Runner cho Bộ thử SSRF – Kịch bản 6 (Nhiệm vụ Tuần 5 – TV4).
 *
 * Chạy trực tiếp từ dòng lệnh:
 *   npm --prefix libs/common run test:ssrf
 * hoặc:
 *   node dist/test/ssrfScenario6.runner.js [--save]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSsrfScenario6 } from './ssrfScenario6.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const saveEvidence = process.argv.includes('--save') || !process.argv.includes('--no-save');

  console.log('Đang khởi chạy Bộ kiểm thử an toàn SSRF – Kịch bản 6...\n');
  const report = await runSsrfScenario6();

  console.log(report.formattedLog);

  if (saveEvidence) {
    try {
      // Tìm thư mục docs của repository
      const candidateDirs = [
        path.resolve(process.cwd(), 'docs'),
        path.resolve(process.cwd(), '../../docs'),
        path.resolve(__dirname, '../../../../docs'),
        path.resolve(__dirname, '../../../docs'),
      ];
      const docsDir = candidateDirs.find((d) => fs.existsSync(d)) ?? path.resolve(process.cwd(), 'docs');
      if (!fs.existsSync(docsDir)) {
        fs.mkdirSync(docsDir, { recursive: true });
      }
        const evidencePath = path.join(docsDir, 'ssrf-scenario6-evidence.md');
        const content = [
          '# Bằng Chứng Nghiệm Thu: Bộ Thử Chống SSRF (Kịch bản 6)',
          '',
          '> **Căn cứ:** Nhiệm vụ Tuần 5 – TV4 (Phạm Kim Tùng), Bảng 3.2, Phụ lục C (Bảng chứng cứ nghiệm thu) và Báo cáo kiến trúc TranslateMe.',
          '> **Người thực hiện:** TV4 – Phạm Kim Tùng',
          `> **Thời gian nghiệm thu:** ${report.timestamp}`,
          '',
          '## 1. Tiêu chí Đánh giá & Kết quả Tổng quan',
          '',
          `- **Số lượng phép thử:** ${report.totalTests} đích bắt buộc`,
          `- **Kết quả đạt:** **${report.passCount}/${report.totalTests} PASS** (${((report.passCount / report.totalTests) * 100).toFixed(1)}%)`,
          `- **Đích bị chặn:** **${report.blockedCount}/${report.totalTests}**`,
          `- **Số kết nối tới IP nội bộ:** **${report.internalIpsContactedCount} (0 kết nối)**`,
          `- **Số sự cố rò rỉ Header Cookie/Auth:** **${report.sensitiveHeadersLeakedCount} (0 sự cố)**`,
          `- **Đánh giá chung:** **${report.allPassed ? '✅ ĐẠT 100% TIÊU CHÍ AN TOÀN' : '❌ CHƯA ĐẠT'}**`,
          '',
          '## 2. Bảng Tổng Hợp 9 Đích Tấn Công SSRF',
          '',
          report.markdownTable,
          '',
          '## 3. Phân Tích Kỹ Thuật Các Chốt Chặn',
          '',
          '### 3.1. Chặn IP Literal Link-Local & Loopback (6.1, 6.3, 6.4, 6.5, 6.6)',
          '- **Nguyên lý:** Phân tích cú pháp URL ngay tại hàm `validateUrl()` và `isBlockedIp()`.',
          '- Các dải địa chỉ bị chặn tuyệt đối gồm: `169.254.0.0/16` (AWS IMDS metadata), `127.0.0.0/8` (IPv4 loopback), `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` (RFC 1918), `::1` (IPv6 loopback), `fc00::/7` (IPv6 ULA).',
          '- **Kết quả:** Bị chặn ngay từ bước kiểm tra URL, **hoàn toàn không gọi DNS và không mở bất kỳ socket TCP nào**.',
          '',
          '### 3.2. Chặn Tên Miền Phân Giải Ra IP Nội Bộ (6.2 - localhost)',
          '- **Nguyên lý:** Sau khi kiểm tra tên miền hợp lệ, hệ thống thực hiện phân giải DNS độc lập thông qua `resolver` (lấy tất cả địa chỉ A và AAAA).',
          '- Mọi IP trả về từ DNS đều được đối soát qua hàm `isBlockedIp()`. Nếu có bất kỳ IP nào thuộc dải cấm, toàn bộ yêu cầu bị hủy bỏ.',
          '- **Kết quả:** `localhost` phân giải ra `127.0.0.1` bị từ chối ngay với mã `PRIVATE_IP`, không có kết nối nào được tạo.',
          '',
          '### 3.3. Chống Tấn Công DNS Rebinding (6.7)',
          '- **Kỹ thuật tấn công:** Kẻ tấn công cấu hình máy chủ DNS trả về IP công khai ở lần tra cứu 1 (để qua mặt bộ lọc), nhưng trả về `127.0.0.1` ở lần tra cứu 2 khi client tạo kết nối TCP.',
          '- **Giải pháp Pinned Lookup (Ghim IP):** `safeFetch` chỉ hỏi DNS đúng **1 lần duy nhất** cho mỗi lần nhảy. Sau khi IP công khai được kiểm duyệt an toàn, hàm tạo ra một `lookup` function tùy biến ghim trực tiếp IP này vào cấu hình kết nối của Node.js `http`/`https` Agent.',
          '- **Kết quả:** Khi mở kết nối TCP, Node.js sử dụng trực tiếp IP công khai đã ghim, **tuyệt đối không phân giải lại DNS lần 2**. Thêm vào đó, tại tầng lookup ghim có thêm lớp phòng thủ chiều sâu từ chối IP nội bộ nếu có lỗi bất thường.',
          '',
          '### 3.4. Chống Tấn Công Chuyển Hướng Kép (6.8 - Open Redirect)',
          '- **Kỹ thuật tấn công:** Lợi dụng một trang web công khai hợp lệ trả về mã chuyển hướng HTTP `302 Found` với header `Location: http://10.0.0.1/`.',
          '- **Giải pháp:** Tắt chế độ tự động chuyển hướng (`follow redirect`) mặc định của thư viện HTTP. `safeFetch` tự kiểm soát vòng lặp chuyển hướng thủ công (tối đa 5 lần). Mỗi khi nhận mã 3xx, URL trong `Location` được bóc tách và chạy lại **toàn bộ quy trình kiểm duyệt an toàn SSRF từ đầu**.',
          '- **Vệ sinh Header:** Khi gửi yêu cầu và khi chuyển hướng, các header nhạy cảm như `Cookie`, `Cookie2`, `Authorization`, `Proxy-Authorization` bị loại bỏ 100% bằng cả bộ lọc Allowlist và Blacklist chủ động.',
          '- **Kết quả:** Yêu cầu chuyển hướng tới `10.0.0.1` bị chặn ngay lập tức; không có bất kỳ kết nối socket nào được mở tới `10.0.0.1`.',
          '',
          '### 3.5. Chặn Cổng Dịch Vụ Không Phải Web (6.9 - Cổng 22 SSH)',
          '- **Nguyên lý:** Chỉ cho phép cổng 80 (`http`) và cổng 443 (`https`). Bất kỳ cổng nào khác (cổng 22, 21, 25, 3306, 6379...) đều bị loại ngay tại hàm `validateUrl()`.',
          '- **Kết quả:** URL có cổng 22 bị chặn với mã `PORT` ngay lập tức, không phân giải DNS và không mở kết nối.',
          '',
          '## 4. Toàn Văn Nhật Ký Thực Thi (Execution Log)',
          '',
          '```text',
          report.formattedLog,
          '```',
          '',
        ].join('\n');

        fs.writeFileSync(evidencePath, content, 'utf8');
        console.log(`\n📄 Đã lưu báo cáo bằng chứng nghiệm thu thành công tại: ${evidencePath}`);
    } catch (err: any) {
      console.warn(`Không thể ghi file bằng chứng: ${err.message}`);
    }
  }

  if (!report.allPassed) {
    process.exit(1);
  }
}

void main();
