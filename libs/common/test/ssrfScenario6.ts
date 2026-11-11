/**
 * Bộ kiểm thử hồi quy mô phỏng an toàn SSRF – Kịch bản 6 (Nhiệm vụ Tuần 5 – TV4: Phạm Kim Tùng).
 *
 * LƯU Ý QUAN TRỌNG VỀ PHẠM VI (SCOPE) & TIÊU CHÍ NGHIỆM THU:
 *  - Bộ thử này sử dụng `fakeResolver` và `fakeTransport` (Dependency Injection) phục vụ
 *    kiểm thử hồi quy đơn vị (Unit / Regression Testing) đối với logic của `safeFetch`.
 *  - Kết quả "0 kết nối socket tới IP nội bộ" ở đây phản ánh rằng mock transport không ghi nhận
 *    bất kỳ kết nối nào tới dải nội bộ (URL/IP nguy hiểm bị chặn trước transport, hoặc ca 6.7
 *    ghim chặt IP công khai đã kiểm duyệt và tuyệt đối không tra cứu/kết nối tới 127.0.0.1).
 *  - Tiêu chí đo của bộ thử hồi quy này là **9/9 tình huống ngăn chặn kết nối IP nội bộ**
 *    (gồm 8 yêu cầu bị `BLOCKED` hoàn toàn và 1 yêu cầu `6.7` kết nối `OK` tới IP công khai đã ghim)
 *    cùng **0 rò rỉ header nhạy cảm** trên các request thực tế gửi tới mock transport.
 *  - ĐÂY LÀ KẾT QUẢ MÔ PHỎNG KIỂM THỬ ĐƠN VỊ, KHÔNG DÙNG LÀM BẰNG CHỨNG NGHIỆM THU TRÊN MÔI TRƯỜNG THỰC TẾ.
 *  - Bằng chứng nghiệm thu chính thức của Kịch bản 6 (Phụ lục C) sẽ được đo đạc và thu thập
 *    trên bản demo đã triển khai thực tế (Hạng mục 5.9).
 *
 * Danh sách 9 tình huống thử nghiệm SSRF (Kịch bản 6):
 *  [6.1] 169.254.169.254 (AWS IMDS metadata) -> BLOCKED (PRIVATE_IP)
 *  [6.2] localhost (Tên miền loopback) -> BLOCKED (PRIVATE_IP)
 *  [6.3] 127.0.0.1 (IPv4 loopback) -> BLOCKED (PRIVATE_IP)
 *  [6.4] 10.0.0.1 (IPv4 dải riêng RFC 1918 Class A) -> BLOCKED (PRIVATE_IP)
 *  [6.5] [::1] (IPv6 loopback) -> BLOCKED (PRIVATE_IP)
 *  [6.6] [fd00::1] (IPv6 Unique Local Address - ULA) -> BLOCKED (PRIVATE_IP)
 *  [6.7] DNS rebinding 1 bước (lần 1 IP công khai, lần 2 127.0.0.1) -> OK (PINNED_LOOKUP_PUBLIC_ALLOWED, 0 kết nối 127.0.0.1)
 *  [6.8] URL chuyển hướng (HTTP 302) về địa chỉ nội bộ -> BLOCKED (PRIVATE_IP)
 *  [6.9] Cổng không hợp lệ (Cổng 22 - SSH) -> BLOCKED (PORT)
 */
import {
  buildNodeRequestOptions,
  isBlockedIp,
  safeFetch,
  type TransportRequest,
} from '../safeFetch.js';
import {
  contactedIps,
  fakeResolver,
  fakeTransport,
  html,
  PUBLIC_IP,
  redirect,
} from './helpers.js';

export const SSRF_TEST_SENSITIVE_HEADERS = Object.freeze({
  Cookie: 'session_id=super_secret_cookie_token',
  Authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.confidential',
  'Proxy-Authorization': 'Basic YWRtaW46cGFzc3dvcmQxMjM=',
  'X-Custom-Secret': 'internal_key',
  'Accept-Language': 'vi,en;q=0.9',
  'User-Agent': 'TranslateMe-Verifier/1.0',
});

const FORBIDDEN_OUTGOING_TEST_KEYS = [
  'cookie',
  'cookie2',
  'authorization',
  'proxy-authorization',
  'x-custom-secret',
] as const;

export type HeaderAuditStatus = 'SANITIZED_AT_TRANSPORT' | 'NOT_SENT_BLOCKED_BEFORE_TRANSPORT' | 'LEAKED';

export interface HeaderAuditResult {
  status: HeaderAuditStatus;
  /** `true`/`false` khi có request thực tế qua transport; `null` nếu đã chặn trước khi tạo request */
  headersSanitized: boolean | null;
  /** `true` chỉ khi có ít nhất 1 request tới transport và toàn bộ đã xác minh làm sạch header nhạy cảm */
  verifiedAtTransport: boolean;
  /** `true` khi không có header nhạy cảm nào rò rỉ tới transport (bị chặn trước hoặc đã loại bỏ) */
  noSensitiveHeadersLeaked: boolean;
  transportRequestsCount: number;
  leakedHeaderNames: string[];
}

export interface SsrfTestCaseDefinition {
  id: string;
  name: string;
  targetUrl: string;
  category: string;
  expectedOutcome: 'BLOCKED' | 'OK';
  expectedReason: string;
  description: string;
}

export interface SsrfTestCaseResult {
  index: number;
  id: string;
  name: string;
  targetUrl: string;
  category: string;
  expectedOutcome: 'BLOCKED' | 'OK';
  expectedReason: string;
  actualOutcome: string;
  actualReason?: string;
  /** Yêu cầu có bị safeFetch trả outcome BLOCKED hay không */
  blocked: boolean;
  /** Tình huống có ngăn chặn thành công việc kết nối tới IP nội bộ / cổng cấm hay không */
  preventedInternalAccess: boolean;
  /** Yêu cầu an toàn có được phép kết nối tới IP công khai đã ghim hay không (ca 6.7) */
  allowedSafeConnection: boolean;
  /** Không có bất kỳ kết nối nào tới IP nội bộ */
  noInternalConnection: boolean;
  /** `true`/`false` theo kiểm tra request thực tế gửi tới transport; `null` khi chặn trước transport (0 request) */
  headersSanitized: boolean | null;
  headerAuditStatus: HeaderAuditStatus;
  headersVerifiedAtTransport: boolean;
  noSensitiveHeadersLeaked: boolean;
  transportRequestsCount: number;
  leakedHeaderNames: string[];
  contactedIps: string[];
  dnsCalls: string[];
  passed: boolean;
  detail: string;
}

export interface SsrfScenario6Report {
  timestamp: string;
  totalTests: number;
  passCount: number;
  failCount: number;
  /** 9/9 tình huống ngăn kết nối tới IP nội bộ (tiêu chí nghiệm thu chính) */
  preventedInternalAccessCount: number;
  /** 8/9 yêu cầu bị safeFetch trả BLOCKED */
  blockedRequestsCount: number;
  /** 1/9 yêu cầu an toàn (6.7) kết nối OK tới IP công khai đã ghim */
  allowedSafeRequestsCount: number;
  /** Tổng số kết nối tới IP nội bộ bị rò rỉ (yêu cầu = 0) */
  internalIpsContactedCount: number;
  /** Tổng số request thực tế đi tới mock transport across 9 cases (6.7 + 6.8 = 2) */
  transportRequestsCount: number;
  /** Số tình huống có gửi request tới transport và đã xác minh làm sạch header (2: 6.7 và 6.8) */
  headersVerifiedAtTransportCount: number;
  /** Số tình huống bị chặn trước transport nên 0 request/header rời khỏi client (7: 6.1–6.6, 6.9) */
  blockedBeforeTransportCount: number;
  /** Số tình huống làm rò rỉ header nhạy cảm tới transport (yêu cầu = 0) */
  sensitiveHeadersLeakedCount: number;
  allPassed: boolean;
  results: SsrfTestCaseResult[];
  formattedLog: string;
  markdownTable: string;
}

export const SCENARIO_6_TARGETS: readonly SsrfTestCaseDefinition[] = Object.freeze([
  {
    id: '6.1',
    name: 'AWS IMDS Metadata IP (169.254.169.254)',
    targetUrl: 'http://169.254.169.254/latest/meta-data/',
    category: 'AWS Instance Metadata (Link-Local)',
    expectedOutcome: 'BLOCKED',
    expectedReason: 'PRIVATE_IP',
    description: 'Truy cập endpoint metadata EC2/Lambda để trích xuất IAM credential tạm thời',
  },
  {
    id: '6.2',
    name: 'Tên miền localhost',
    targetUrl: 'http://localhost/',
    category: 'Loopback Hostname (DNS)',
    expectedOutcome: 'BLOCKED',
    expectedReason: 'PRIVATE_IP',
    description: 'Tên miền localhost phân giải về địa chỉ loopback nội bộ 127.0.0.1',
  },
  {
    id: '6.3',
    name: 'IPv4 Loopback (127.0.0.1)',
    targetUrl: 'http://127.0.0.1/',
    category: 'IPv4 Loopback (127.0.0.0/8)',
    expectedOutcome: 'BLOCKED',
    expectedReason: 'PRIVATE_IP',
    description: 'Truy cập trực tiếp dịch vụ nội bộ qua địa chỉ loopback 127.0.0.1',
  },
  {
    id: '6.4',
    name: 'IPv4 Private Class A (10.0.0.1)',
    targetUrl: 'http://10.0.0.1/',
    category: 'Private Network RFC 1918 Class A',
    expectedOutcome: 'BLOCKED',
    expectedReason: 'PRIVATE_IP',
    description: 'Quét và truy cập mạng con nội bộ VPC 10.0.0.0/8',
  },
  {
    id: '6.5',
    name: 'IPv6 Loopback ([::1])',
    targetUrl: 'http://[::1]/',
    category: 'IPv6 Loopback',
    expectedOutcome: 'BLOCKED',
    expectedReason: 'PRIVATE_IP',
    description: 'Bỏ qua bộ lọc IPv4 bằng cách dùng địa chỉ loopback IPv6 [::1]',
  },
  {
    id: '6.6',
    name: 'IPv6 Unique Local Address ([fd00::1])',
    targetUrl: 'http://[fd00::1]/',
    category: 'IPv6 Unique Local Address (fc00::/7)',
    expectedOutcome: 'BLOCKED',
    expectedReason: 'PRIVATE_IP',
    description: 'Truy cập dải mạng nội bộ IPv6 ULA (fc00::/7)',
  },
  {
    id: '6.7',
    name: 'Tấn công DNS Rebinding',
    targetUrl: 'http://rebind.attacker.test/',
    category: 'DNS Rebinding Time-of-Check to Time-of-Use',
    expectedOutcome: 'OK',
    expectedReason: 'PINNED_LOOKUP_PUBLIC_ALLOWED',
    description: 'DNS trả về IP công khai ở lần tra cứu 1, nếu hỏi lần 2 sẽ trả 127.0.0.1; safeFetch ghim IP công khai và không phân giải lại',
  },
  {
    id: '6.8',
    name: 'URL chuyển hướng HTTP 302 về địa chỉ nội bộ',
    targetUrl: 'http://public.test/redirect-to-private',
    category: 'Open Redirect Chaining to SSRF',
    expectedOutcome: 'BLOCKED',
    expectedReason: 'PRIVATE_IP',
    description: 'Host công khai hợp lệ trả HTTP 302 với Location trỏ tới http://10.0.0.1/',
  },
  {
    id: '6.9',
    name: 'Cổng không hợp lệ (Cổng 22 - SSH)',
    targetUrl: 'http://example.test:22/',
    category: 'Restricted Port Protocol Smuggling',
    expectedOutcome: 'BLOCKED',
    expectedReason: 'PORT',
    description: 'Tấn công cổng dịch vụ khác cổng web (cổng 22 SSH); chỉ cho phép cổng 80 và 443',
  },
]);

/**
 * Kiểm tra xem một danh sách IP có chứa bất kỳ IP nội bộ nào không.
 */
export function hasInternalIp(ips: readonly string[]): boolean {
  for (const ip of ips) {
    if (isBlockedIp(ip)) {
      return true;
    }
  }
  return false;
}

/**
 * Kiểm tra thực tế các header đã gửi trên mọi request mà mock transport nhận được.
 */
export function auditHeaderSanitization(calls: readonly TransportRequest[]): HeaderAuditResult {
  if (calls.length === 0) {
    return {
      status: 'NOT_SENT_BLOCKED_BEFORE_TRANSPORT',
      headersSanitized: null,
      verifiedAtTransport: false,
      noSensitiveHeadersLeaked: true,
      transportRequestsCount: 0,
      leakedHeaderNames: [],
    };
  }

  const leaked = new Set<string>();
  let allowedPreservedOnAll = true;
  for (const call of calls) {
    const lowerKeys = new Set(Object.keys(call.headers).map((k) => k.toLowerCase()));
    for (const forbidden of FORBIDDEN_OUTGOING_TEST_KEYS) {
      if (lowerKeys.has(forbidden)) {
        leaked.add(forbidden);
      }
    }
    if (
      call.headers['accept-language'] !== SSRF_TEST_SENSITIVE_HEADERS['Accept-Language'] ||
      call.headers['user-agent'] !== SSRF_TEST_SENSITIVE_HEADERS['User-Agent']
    ) {
      allowedPreservedOnAll = false;
    }
  }

  const leakedHeaderNames = [...leaked];
  const sanitized = leakedHeaderNames.length === 0 && allowedPreservedOnAll;
  return {
    status: sanitized ? 'SANITIZED_AT_TRANSPORT' : 'LEAKED',
    headersSanitized: sanitized,
    verifiedAtTransport: sanitized,
    noSensitiveHeadersLeaked: leakedHeaderNames.length === 0,
    transportRequestsCount: calls.length,
    leakedHeaderNames,
  };
}

function formatHeaderAuditColumn(r: SsrfTestCaseResult): string {
  switch (r.headerAuditStatus) {
    case 'SANITIZED_AT_TRANSPORT':
      return `✅ Đã kiểm chứng trên ${r.transportRequestsCount} request (xóa Cookie/Auth)`;
    case 'NOT_SENT_BLOCKED_BEFORE_TRANSPORT':
      return '➖ Không gửi request (chặn trước transport)';
    case 'LEAKED':
      return `❌ Rò rỉ (${r.leakedHeaderNames.join(', ') || 'sai header'})`;
  }
}

function formatHeaderAuditLog(r: SsrfTestCaseResult): string {
  switch (r.headerAuditStatus) {
    case 'SANITIZED_AT_TRANSPORT':
      return `ĐẠT – Đã gửi header nhạy cảm và kiểm chứng xóa bỏ trên ${r.transportRequestsCount} request tới mock transport`;
    case 'NOT_SENT_BLOCKED_BEFORE_TRANSPORT':
      return 'KHÔNG GỬI – Đã truyền header kiểm thử nhưng bị chặn trước transport (0 request gửi đi)';
    case 'LEAKED':
      return `KHÔNG ĐẠT – Rò rỉ header nhạy cảm [${r.leakedHeaderNames.join(', ')}] hoặc mất header hợp lệ`;
  }
}

/**
 * Chạy toàn bộ Bộ kiểm thử SSRF – Kịch bản 6 và trả về báo cáo chi tiết.
 */
export async function runSsrfScenario6(): Promise<SsrfScenario6Report> {
  const results: SsrfTestCaseResult[] = [];
  const timestamp = new Date().toISOString();

  // Helper dùng chung cho các tình huống kỳ vọng bị chặn ngay trước transport (6.1–6.6, 6.9)
  const runBlockedBeforeTransportCase = async (
    index: number,
    def: SsrfTestCaseDefinition,
    dnsTable: Record<string, string[]>,
    expectedDnsCalls: readonly string[],
  ) => {
    const resolver = fakeResolver(dnsTable);
    const transport = fakeTransport({});
    const outcome = await safeFetch(
      def.targetUrl,
      { headers: { ...SSRF_TEST_SENSITIVE_HEADERS } },
      { resolver, transport },
    );
    const blocked = outcome.kind === 'BLOCKED';
    const reason = outcome.kind === 'BLOCKED' ? outcome.reason : outcome.kind;
    const contacted = contactedIps(transport);
    const noInternalConnection = !hasInternalIp(contacted) && contacted.length === 0;
    const preventedInternalAccess = blocked && noInternalConnection && transport.calls.length === 0;
    const headerAudit = auditHeaderSanitization(transport.calls);
    const dnsMatched =
      resolver.calls.length === expectedDnsCalls.length &&
      expectedDnsCalls.every((host, idx) => resolver.calls[idx] === host);
    const passed =
      blocked &&
      reason === def.expectedReason &&
      preventedInternalAccess &&
      dnsMatched &&
      headerAudit.noSensitiveHeadersLeaked &&
      headerAudit.transportRequestsCount === 0;

    results.push({
      index,
      id: def.id,
      name: def.name,
      targetUrl: def.targetUrl,
      category: def.category,
      expectedOutcome: def.expectedOutcome,
      expectedReason: def.expectedReason,
      actualOutcome: outcome.kind,
      actualReason: reason,
      blocked,
      preventedInternalAccess,
      allowedSafeConnection: false,
      noInternalConnection,
      headersSanitized: headerAudit.headersSanitized,
      headerAuditStatus: headerAudit.status,
      headersVerifiedAtTransport: headerAudit.verifiedAtTransport,
      noSensitiveHeadersLeaked: headerAudit.noSensitiveHeadersLeaked,
      transportRequestsCount: headerAudit.transportRequestsCount,
      leakedHeaderNames: headerAudit.leakedHeaderNames,
      contactedIps: contacted,
      dnsCalls: resolver.calls,
      passed,
      detail: outcome.kind === 'BLOCKED' ? outcome.detail : `Outcome: ${outcome.kind}`,
    });
  };

  // Test 6.1 – 6.6: Các đích nội bộ trực tiếp (IP metadata, localhost DNS, IPv4/IPv6 loopback & ULA)
  await runBlockedBeforeTransportCase(1, SCENARIO_6_TARGETS[0], {}, []);
  await runBlockedBeforeTransportCase(2, SCENARIO_6_TARGETS[1], { localhost: ['127.0.0.1'] }, ['localhost']);
  await runBlockedBeforeTransportCase(3, SCENARIO_6_TARGETS[2], {}, []);
  await runBlockedBeforeTransportCase(4, SCENARIO_6_TARGETS[3], {}, []);
  await runBlockedBeforeTransportCase(5, SCENARIO_6_TARGETS[4], {}, []);
  await runBlockedBeforeTransportCase(6, SCENARIO_6_TARGETS[5], {}, []);

  // Test 6.7: DNS Rebinding (lần 1 PUBLIC_IP, lần 2 127.0.0.1 -> ghim IP công khai, 0 kết nối 127.0.0.1)
  {
    const def = SCENARIO_6_TARGETS[6];
    const resolver = fakeResolver({
      'rebind.attacker.test': (i) => (i === 0 ? [PUBLIC_IP] : ['127.0.0.1']),
    });
    const transport = fakeTransport({
      'http://rebind.attacker.test/': () => html('<p>public web page</p>'),
    });
    const outcome = await safeFetch(
      def.targetUrl,
      { headers: { ...SSRF_TEST_SENSITIVE_HEADERS } },
      { resolver, transport },
    );
    const contacted = contactedIps(transport);

    // Kiểm tra Pinned Lookup: transport thật nhận lookup function ghim đúng PUBLIC_IP
    let lookupVerified = false;
    if (transport.calls.length === 1) {
      const opts = buildNodeRequestOptions(transport.calls[0]);
      if (typeof opts.lookup === 'function') {
        const lookupResult = await new Promise<string>((resolve, reject) => {
          opts.lookup!('rebind.attacker.test', {}, (err, address) => {
            if (err) reject(err);
            else resolve(String(address));
          });
        });
        lookupVerified = lookupResult === PUBLIC_IP;
      }
    }

    const noInternalConnection = !contacted.includes('127.0.0.1') && !hasInternalIp(contacted);
    const headerAudit = auditHeaderSanitization(transport.calls);
    const blocked = outcome.kind === 'BLOCKED';
    const preventedInternalAccess =
      noInternalConnection &&
      lookupVerified &&
      resolver.calls.length === 1 &&
      contacted.length === 1 &&
      contacted[0] === PUBLIC_IP;
    const allowedSafeConnection = outcome.kind === 'OK' && preventedInternalAccess;
    const passed =
      allowedSafeConnection &&
      headerAudit.verifiedAtTransport &&
      headerAudit.noSensitiveHeadersLeaked;

    results.push({
      index: 7,
      id: def.id,
      name: def.name,
      targetUrl: def.targetUrl,
      category: def.category,
      expectedOutcome: def.expectedOutcome,
      expectedReason: def.expectedReason,
      actualOutcome: outcome.kind,
      actualReason: outcome.kind === 'OK' ? 'PINNED_LOOKUP_PUBLIC_ALLOWED' : outcome.kind,
      blocked,
      preventedInternalAccess,
      allowedSafeConnection,
      noInternalConnection,
      headersSanitized: headerAudit.headersSanitized,
      headerAuditStatus: headerAudit.status,
      headersVerifiedAtTransport: headerAudit.verifiedAtTransport,
      noSensitiveHeadersLeaked: headerAudit.noSensitiveHeadersLeaked,
      transportRequestsCount: headerAudit.transportRequestsCount,
      leakedHeaderNames: headerAudit.leakedHeaderNames,
      contactedIps: contacted,
      dnsCalls: resolver.calls,
      passed,
      detail:
        'DNS chỉ phân giải 1 lần. Socket ghim trực tiếp IP công khai 93.184.216.34 (kết nối an toàn OK, 0 kết nối tới 127.0.0.1) và đã xác minh xóa Cookie/Authorization trên request gửi tới transport.',
    });
  }

  // Test 6.8: URL chuyển hướng (HTTP 302) về địa chỉ nội bộ 10.0.0.1 kèm kiểm tra vệ sinh Header
  {
    const def = SCENARIO_6_TARGETS[7];
    const resolver = fakeResolver({
      'public.test': [PUBLIC_IP],
    });
    const transport = fakeTransport({
      'http://public.test/redirect-to-private': () => redirect(302, 'http://10.0.0.1/secret-internal'),
    });

    const outcome = await safeFetch(
      def.targetUrl,
      { headers: { ...SSRF_TEST_SENSITIVE_HEADERS } },
      { resolver, transport },
    );

    const blocked = outcome.kind === 'BLOCKED';
    const reason = outcome.kind === 'BLOCKED' ? outcome.reason : outcome.kind;
    const contacted = contactedIps(transport);
    const noInternalConnection = !contacted.includes('10.0.0.1') && !hasInternalIp(contacted);
    const headerAudit = auditHeaderSanitization(transport.calls);
    const preventedInternalAccess =
      blocked && noInternalConnection && contacted.length === 1 && contacted[0] === PUBLIC_IP;

    const passed =
      blocked &&
      reason === def.expectedReason &&
      preventedInternalAccess &&
      headerAudit.verifiedAtTransport &&
      headerAudit.noSensitiveHeadersLeaked;

    results.push({
      index: 8,
      id: def.id,
      name: def.name,
      targetUrl: def.targetUrl,
      category: def.category,
      expectedOutcome: def.expectedOutcome,
      expectedReason: def.expectedReason,
      actualOutcome: outcome.kind,
      actualReason: reason,
      blocked,
      preventedInternalAccess,
      allowedSafeConnection: false,
      noInternalConnection,
      headersSanitized: headerAudit.headersSanitized,
      headerAuditStatus: headerAudit.status,
      headersVerifiedAtTransport: headerAudit.verifiedAtTransport,
      noSensitiveHeadersLeaked: headerAudit.noSensitiveHeadersLeaked,
      transportRequestsCount: headerAudit.transportRequestsCount,
      leakedHeaderNames: headerAudit.leakedHeaderNames,
      contactedIps: contacted,
      dnsCalls: resolver.calls,
      passed,
      detail:
        'Chuyển hướng 302 tới 10.0.0.1 bị chặn ngay lập tức. Đã kiểm chứng request đầu tới IP công khai không chứa Cookie/Authorization/Proxy-Authorization.',
    });
  }

  // Test 6.9: Cổng không hợp lệ (Cổng 22 - SSH)
  await runBlockedBeforeTransportCase(9, SCENARIO_6_TARGETS[8], { 'example.test': [PUBLIC_IP] }, []);

  const passCount = results.filter((r) => r.passed).length;
  const failCount = results.length - passCount;
  const preventedInternalAccessCount = results.filter((r) => r.preventedInternalAccess).length;
  const blockedRequestsCount = results.filter((r) => r.blocked).length;
  const allowedSafeRequestsCount = results.filter((r) => r.allowedSafeConnection).length;
  const internalIpsContactedCount = results.filter((r) => !r.noInternalConnection).length;
  const transportRequestsCount = results.reduce((sum, r) => sum + r.transportRequestsCount, 0);
  const transportContactedCasesCount = results.filter((r) => r.transportRequestsCount > 0).length;
  const headersVerifiedAtTransportCount = results.filter((r) => r.headersVerifiedAtTransport).length;
  const blockedBeforeTransportCount = results.filter(
    (r) => r.headerAuditStatus === 'NOT_SENT_BLOCKED_BEFORE_TRANSPORT',
  ).length;
  const sensitiveHeadersLeakedCount = results.filter((r) => !r.noSensitiveHeadersLeaked).length;

  const allPassed =
    passCount === 9 &&
    preventedInternalAccessCount === 9 &&
    blockedRequestsCount === 8 &&
    allowedSafeRequestsCount === 1 &&
    internalIpsContactedCount === 0 &&
    transportContactedCasesCount === 2 &&
    headersVerifiedAtTransportCount === transportContactedCasesCount &&
    blockedBeforeTransportCount === 7 &&
    sensitiveHeadersLeakedCount === 0;

  const markdownLines: string[] = [
    '| ID | Đích kiểm thử | Mục tiêu tấn công | Kết quả mô phỏng | Phân loại xử lý | Ngăn truy cập nội bộ | Vệ sinh Header |',
    '| :---: | :--- | :--- | :---: | :---: | :---: | :---: |',
  ];

  const logLines: string[] = [
    '========================================================================================================',
    '             BỘ KIỂM THỬ HỒI QUY MÔ PHỎNG AN TOÀN SSRF (KỊCH BẢN 6 – MOCK SIMULATION)                  ',
    '========================================================================================================',
    `Thời gian thực thi:          ${timestamp}`,
    'Chế độ kiểm thử:             Mô phỏng đơn vị (Mock Dependencies: fakeResolver + fakeTransport)',
    'Phạm vi áp dụng:             Kiểm thử hồi quy logic safeFetch (Không dùng làm bằng chứng nghiệm thu demo)',
    `Tổng số tình huống:          ${results.length}`,
    `Ngăn chặn truy cập nội bộ:   ${preventedInternalAccessCount}/${results.length} tình huống (tiêu chí 0 kết nối tới IP nội bộ)`,
    `  + Yêu cầu bị chặn BLOCKED:       ${blockedRequestsCount}/${results.length} (6.1–6.6, 6.8, 6.9)`,
    `  + Yêu cầu ghim IP công khai OK:  ${allowedSafeRequestsCount}/${results.length} (6.7 DNS rebinding, 0 kết nối nội bộ)`,
    `Kết nối tới IP nội bộ:       ${internalIpsContactedCount} kết nối (Mock transport không nhận kết nối nào tới IP nội bộ)`,
    `Kiểm chứng vệ sinh Header:   ${headersVerifiedAtTransportCount}/${transportContactedCasesCount} tình huống qua transport (6.7, 6.8) xác minh xóa Cookie/Auth; ${blockedBeforeTransportCount}/${results.length} ca dừng trước transport (0 request)`,
    `Rò rỉ header nhạy cảm:       ${sensitiveHeadersLeakedCount} rò rỉ trên ${transportRequestsCount} request tới mock transport`,
    `Trạng thái:                  ${allPassed ? '✅ TẤT CẢ PHÉP THỬ MÔ PHỎNG ĐẠT (9/9 PASS)' : '❌ CÓ PHÉP THỬ THẤT BẠI'}`,
    '--------------------------------------------------------------------------------------------------------',
  ];

  for (const r of results) {
    const statusIcon = r.passed ? '✅ PASS' : '❌ FAIL';
    const classification = r.allowedSafeConnection
      ? `Cho phép IP công khai ghim (${r.contactedIps.join(', ') || 'Public IP'})`
      : `Bị chặn hoàn toàn (\`${r.actualReason}\`)`;
    const internalAccessCell = r.noInternalConnection ? '✅ Đạt (0 IP nội bộ)' : '❌ Rò rỉ IP nội bộ';

    markdownLines.push(
      `| **${r.id}** | \`${r.targetUrl}\` | ${r.category} | ${statusIcon} | ${classification} | ${internalAccessCell} | ${formatHeaderAuditColumn(r)} |`,
    );

    logLines.push(
      `[${r.id}] ${r.name}`,
      `  - URL đích:                  ${r.targetUrl}`,
      `  - Danh mục tấn công:         ${r.category}`,
      `  - Outcome mong đợi / thực tế:${` ${r.expectedOutcome} (${r.expectedReason}) / ${r.actualOutcome} (${r.actualReason})`}`,
      `  - Phân loại xử lý:           ${r.allowedSafeConnection ? 'Cho phép kết nối an toàn tới IP công khai đã ghim' : 'Bị chặn hoàn toàn bởi safeFetch'}`,
      `  - Ngăn truy cập nội bộ:      ${r.noInternalConnection ? 'ĐẠT (Mock transport không nhận kết nối nội bộ)' : 'KHÔNG ĐẠT (NGUY HIỂM)'}`,
      `  - Vệ sinh Header:            ${formatHeaderAuditLog(r)}`,
      `  - Request tới mock transport:${` ${r.transportRequestsCount}`}`,
      `  - IP mock kết nối:           [${r.contactedIps.join(', ') || 'Không có kết nối nào tới transport'}]`,
      `  - DNS mock queries:          [${r.dnsCalls.join(', ') || 'Không có DNS query'}]`,
      `  - Kết quả mô phỏng:          ${statusIcon}`,
      `  - Chi tiết:                  ${r.detail}`,
      '--------------------------------------------------------------------------------------------------------',
    );
  }

  const summary = `Kịch bản 6 (Mô phỏng hồi quy): ${preventedInternalAccessCount}/${results.length} tình huống ngăn kết nối tới IP nội bộ (gồm ${blockedRequestsCount} yêu cầu bị chặn BLOCKED và ${allowedSafeRequestsCount} yêu cầu an toàn ghim IP công khai). 0 kết nối socket tới IP nội bộ. ${headersVerifiedAtTransportCount}/${transportContactedCasesCount} tình huống gửi request tới transport (6.7, 6.8) xác minh không rò rỉ Cookie/Authorization (${blockedBeforeTransportCount} ca dừng trước transport). Lưu ý: Bằng chứng nghiệm thu chính thức sẽ được đo đạc trên bản demo (Hạng mục 5.9).`;
  logLines.push(`KẾT LUẬN: ${summary}`, '========================================================================================================');

  return {
    timestamp,
    totalTests: results.length,
    passCount,
    failCount,
    preventedInternalAccessCount,
    blockedRequestsCount,
    allowedSafeRequestsCount,
    internalIpsContactedCount,
    transportRequestsCount,
    headersVerifiedAtTransportCount,
    blockedBeforeTransportCount,
    sensitiveHeadersLeakedCount,
    allPassed,
    results,
    formattedLog: logLines.join('\n'),
    markdownTable: markdownLines.join('\n'),
  };
}
