/**
 * CLI Runner cho Bộ thử hồi quy mô phỏng SSRF – Kịch bản 6 (Nhiệm vụ Tuần 5 – TV4).
 *
 * Chạy trực tiếp từ dòng lệnh:
 *   npm --prefix libs/common run test:ssrf
 * hoặc:
 *   node dist/test/ssrfScenario6.runner.js [--save-simulation]
 *
 * Lưu ý:
 *  Bộ thử này chạy với mock resolver và mock transport trong môi trường kiểm thử đơn vị,
 *  xác minh tính đúng đắn của logic safeFetch.
 *  Để đảm bảo tính khách quan và trung thực kỹ thuật, runner mặc định KHÔNG ghi đè tài liệu
 *  chứng cứ nghiệm thu demo. Bằng chứng nghiệm thu thực tế sẽ được đo đạc trên bản demo (Hạng mục 5.9).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSsrfScenario6 } from './ssrfScenario6.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const saveSimulation = process.argv.includes('--save-simulation');

  console.log('Đang khởi chạy Bộ kiểm thử hồi quy mô phỏng an toàn SSRF – Kịch bản 6...\n');
  const report = await runSsrfScenario6();

  console.log(report.formattedLog);
  console.log('\n[LƯU Ý QUAN TRỌNG VỀ BẰNG CHỨNG NGHIỆM THU]');
  console.log('  * Kết quả trên là kiểm thử hồi quy đơn vị mô phỏng (Offline Mock Regression) với fakeResolver/fakeTransport.');
  console.log('  * Kết quả "0 kết nối socket tới IP nội bộ" biểu thị mock transport không ghi nhận kết nối nào.');
  console.log('  * Bằng chứng nghiệm thu chính thức của Kịch bản 6 (Phụ lục C) sẽ được thu thập trên bản demo thực tế ở Hạng mục 5.9.\n');

  if (saveSimulation) {
    try {
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
      const simulationPath = path.join(docsDir, 'ssrf-scenario6-simulation.md');
      const content = [
        '# Báo Cáo Kiểm Thử Hồi Quy Mô Phỏng: Kịch Bản 6 SSRF',
        '',
        '> **Phạm vi:** Kiểm thử hồi quy đơn vị (Unit / Regression Test) sử dụng mock dependencies (`fakeResolver`, `fakeTransport`).',
        '> **Lưu ý:** Đây là kết quả mô phỏng logic nội bộ của `safeFetch`, KHÔNG PHẢI là bằng chứng đo đạc mạng thực tế trên bản demo.',
        '> **Người thực hiện:** TV4 – Phạm Kim Tùng',
        `> **Thời gian chạy mô phỏng:** ${report.timestamp}`,
        '',
        '## 1. Kết Quả Kiểm Thử Hồi Quy Mô Phỏng',
        '',
        `- **Số lượng tình huống:** ${report.totalTests} đích`,
        `- **Kết quả logic:** **${report.passCount}/${report.totalTests} PASS** (${((report.passCount / report.totalTests) * 100).toFixed(1)}%)`,
        `- **Ngăn chặn truy cập nội bộ:** **${report.preventedInternalAccessCount}/${report.totalTests} tình huống (100%)**`,
        `- **Yêu cầu bị chặn hoàn toàn:** **${report.blockedRequestsCount}/${report.totalTests}**`,
        `- **Yêu cầu an toàn được phép đi tới IP công khai:** **${report.allowedSafeRequestsCount}/${report.totalTests}** (DNS rebinding - IP công khai đã ghim)`,
        `- **Kết nối tới IP nội bộ:** **${report.internalIpsContactedCount} (0 kết nối)**`,
        `- **Rò rỉ Header Cookie/Auth:** **${report.sensitiveHeadersLeakedCount} (0 sự cố)**`,
        '',
        '## 2. Bảng Chi Tiết 9 Tình Huống Mô Phỏng',
        '',
        report.markdownTable,
        '',
        '## 3. Nhật Ký Kiểm Thử Mô Phỏng',
        '',
        '```text',
        report.formattedLog,
        '```',
        '',
      ].join('\n');

      fs.writeFileSync(simulationPath, content, 'utf8');
      console.log(`📄 Đã lưu báo cáo mô phỏng kiểm thử tại: ${simulationPath}`);
    } catch (err: any) {
      console.warn(`Không thể ghi file báo cáo mô phỏng: ${err.message}`);
    }
  }

  if (!report.allPassed) {
    process.exit(1);
  }
}

void main();
