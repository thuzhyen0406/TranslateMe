/**
 * Dịch vụ Xác thực, Làm mới Token (B.13), Phân quyền Menu và Quản lý Thành viên cho Màn Q1.
 *
 * Phạm vi trong PR hiện tại:
 *  - Chỉ cài đặt **chế độ giả lập (Local Mock Mode)** tại trình duyệt (bật khi `VITE_AUTH_MODE=mock`, mặc định),
 *    tái hiện đầy đủ các bước nghiệp vụ của Màn Q1:
 *    SignUp -> Mã xác nhận 6 chữ số -> Mô phỏng Trigger PostConfirmation tạo Tenant -> Làm mới JWT
 *    chứa `custom:tenant_id` & `custom:role` -> ForceChangePassword cho lời mời -> Mời thành viên theo từng Tenant.
 *
 * Phần việc còn lại của Hạng mục 2.9 sẽ thực hiện ở bước nối hệ thống thật:
 *  - Gọi trực tiếp Amazon Cognito IDP (`SignUp`, `ConfirmSignUp`, `InitiateAuth`, `RespondToAuthChallenge`,
 *    `ForgotPassword`, `ConfirmForgotPassword`) sử dụng `VITE_AWS_REGION`, `VITE_COGNITO_USER_POOL_ID`, `VITE_COGNITO_CLIENT_ID`.
 *  - Làm mới token thật (`REFRESH_TOKEN_AUTH`) ngay sau khi Lambda `PostConfirmation_ConfirmSignUp` tạo tenant.
 *  - Gọi REST API `GET /console/me` và `GET/POST /console/members` qua `VITE_API_BASE_URL`.
 */

import type {
  AuthenticatedSession,
  ConfirmEmailInput,
  ConfirmForgotPasswordInput,
  ConsoleMenuItem,
  ConsoleRole,
  ForceChangePasswordInput,
  SignInFormInput,
  SignInOutcome,
  SignUpFormInput,
  TenantMember,
} from '../types/auth.js';
/**
 * Cờ bật các công cụ hỗ trợ demo (`VITE_AUTH_MODE === 'mock'`).
 * Khi chuyển sang môi trường kết nối Cognito thật (`VITE_AUTH_MODE=cognito`), toàn bộ thanh chuyển màn hình,
 * nút đổi nhanh vai trò, mã OTP mẫu `481926` và tự tạo tài khoản demo sẽ tự động tắt.
 */
const envAuthMode =
  (typeof import.meta !== 'undefined' &&
    (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_AUTH_MODE) ??
  (typeof process !== 'undefined' ? process.env?.VITE_AUTH_MODE : undefined) ??
  'mock';

export const IS_DEMO_AUTH_MODE = envAuthMode === 'mock';

export const DEFAULT_DEMO_TENANT_ID = 't_01hxyz987654';

// ============================================================================
// 1. Chuẩn hóa Vai trò & Danh sách Menu ẩn/hiện theo `custom:role` (Bảng 1.2 & B.6)
// ============================================================================

export const ROLE_DISPLAY_LABEL: Record<ConsoleRole, string> = Object.freeze({
  TENANT_ADMIN: 'Tenant Admin',
  DEVELOPER: 'Developer',
  REVIEWER: 'Reviewer',
  PLATFORM_ADMIN: 'Platform Admin',
});

/**
 * Chuẩn hóa chuỗi vai trò từ JWT (`custom:role` hoặc `cognito:groups`) về mã chuẩn `ConsoleRole`.
 * Claim Cognito tenant-role có giá trị lowercase; role lưu trong session là mã nội bộ uppercase.
 */
export function normalizeRole(raw?: string | null): ConsoleRole | null {
  if (raw === 'tenant_admin') return 'TENANT_ADMIN';
  if (raw === 'developer') return 'DEVELOPER';
  if (raw === 'reviewer') return 'REVIEWER';
  if (raw === 'Tenant Admin') return 'TENANT_ADMIN';
  if (raw === 'Developer') return 'DEVELOPER';
  if (raw === 'Reviewer') return 'REVIEWER';
  return null;
}

function claimForConsoleRole(role: ConsoleRole): string | undefined {
  if (role === 'TENANT_ADMIN') return 'tenant_admin';
  if (role === 'DEVELOPER') return 'developer';
  if (role === 'REVIEWER') return 'reviewer';
  return undefined;
}

export const CONSOLE_MENU_ITEMS: readonly ConsoleMenuItem[] = Object.freeze([
  {
    key: 'website',
    label: 'Website',
    allowedRoles: ['TENANT_ADMIN'],
  },
  {
    key: 'glossary',
    label: 'Thuật ngữ',
    allowedRoles: ['TENANT_ADMIN', 'DEVELOPER', 'REVIEWER'],
  },
  {
    key: 'review',
    label: 'Duyệt bản dịch',
    allowedRoles: ['TENANT_ADMIN', 'REVIEWER'],
  },
  {
    key: 'usage',
    label: 'Lượng dùng',
    allowedRoles: ['TENANT_ADMIN', 'DEVELOPER'],
  },
  {
    key: 'apikey',
    label: 'API key',
    allowedRoles: ['TENANT_ADMIN', 'DEVELOPER'],
  },
  {
    key: 'playground',
    label: 'Thử dịch',
    allowedRoles: ['TENANT_ADMIN', 'DEVELOPER'],
  },
  {
    key: 'doc-translate',
    label: 'Dịch tệp',
    allowedRoles: ['TENANT_ADMIN', 'DEVELOPER'],
  },
  {
    key: 'members',
    label: 'Thành viên',
    allowedRoles: ['TENANT_ADMIN'],
  },
  {
    key: 'platform-tenants',
    label: 'Quản trị Tenant',
    allowedRoles: ['PLATFORM_ADMIN'],
  },
  {
    key: 'platform-pricing',
    label: 'Đơn giá dịch máy',
    allowedRoles: ['PLATFORM_ADMIN'],
  },
]);

/** Trả về danh sách các mục menu bên trái được phép hiển thị theo vai trò của người dùng. */
export function getVisibleMenuItems(role: ConsoleRole): ConsoleMenuItem[] {
  return CONSOLE_MENU_ITEMS.filter((item) => item.allowedRoles.includes(role));
}

// ============================================================================
// 2. Kiểm tra Chính sách Mật khẩu & Ánh xạ lỗi Cognito sang Tiếng Việt (Mục 2.9)
// ============================================================================

export interface PasswordValidationResult {
  valid: boolean;
  hasMinLength: boolean;
  hasUppercase: boolean;
  hasLowercase: boolean;
  hasDigit: boolean;
  missingConditions: string[];
  message?: string;
}

/**
 * Kiểm tra mật khẩu theo đúng đặc tả Cognito User Pool (Nhiệm vụ 1.11 & Q1 Report 2):
 * Tối thiểu 8 ký tự, có chữ hoa, chữ thường và chữ số; trả kèm danh sách cụ thể các điều kiện còn thiếu.
 */
export function validatePasswordPolicy(password: string): PasswordValidationResult {
  const hasMinLength = password.length >= 8;
  const hasUppercase = /[A-Z]/.test(password);
  const hasLowercase = /[a-z]/.test(password);
  const hasDigit = /\d/.test(password);
  const valid = hasMinLength && hasUppercase && hasLowercase && hasDigit;

  const missingConditions: string[] = [];
  if (!hasMinLength) missingConditions.push('tối thiểu 8 ký tự');
  if (!hasUppercase) missingConditions.push('chữ hoa (A-Z)');
  if (!hasLowercase) missingConditions.push('chữ thường (a-z)');
  if (!hasDigit) missingConditions.push('chữ số (0-9)');

  return {
    valid,
    hasMinLength,
    hasUppercase,
    hasLowercase,
    hasDigit,
    missingConditions,
    message: valid
      ? undefined
      : `Mật khẩu chưa đạt yêu cầu (còn thiếu: ${missingConditions.join(', ')}).`,
  };
}

export class ConsoleAuthError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ConsoleAuthError';
  }
}

/**
 * Chuyển mã lỗi của Amazon Cognito / API sang thông báo tiếng Việt rõ ràng cho người dùng.
 */
export function mapCognitoErrorToVietnamese(err: unknown): string {
  if (err instanceof ConsoleAuthError) {
    return err.message;
  }

  const rawCode =
    err && typeof err === 'object' && ('name' in err || '__type' in err || 'code' in err)
      ? String(
          (err as Record<string, unknown>).code ??
            (err as Record<string, unknown>).__type ??
            (err as Record<string, unknown>).name,
        )
      : '';
  const code = rawCode.includes('#') ? rawCode.split('#').pop()! : rawCode;
  const rawMessage = err instanceof Error ? err.message : String(err ?? '');

  switch (code) {
    case 'UsernameExistsException':
      return 'Email này đã được đăng ký. Vui lòng đăng nhập hoặc đặt lại mật khẩu nếu bạn đã quên.';
    case 'InvalidPasswordException':
      return 'Mật khẩu quá yếu: cần tối thiểu 8 ký tự, có chữ hoa, chữ thường và chữ số.';
    case 'CodeMismatchException':
      return 'Mã xác nhận 6 chữ số không chính xác. Vui lòng kiểm tra lại.';
    case 'ExpiredCodeException':
      return 'Mã xác nhận đã hết hạn. Vui lòng bấm "Gửi lại mã" để nhận mã mới.';
    case 'NotAuthorizedException':
    case 'UserNotFoundException':
      if (/attempt|exceeded|lock/i.test(rawMessage)) {
        return 'Tài khoản tạm thời bị khóa do đăng nhập sai nhiều lần. Vui lòng thử lại sau ít phút.';
      }
      return 'Email hoặc mật khẩu không chính xác.';
    case 'TooManyRequestsException':
    case 'LimitExceededException':
    case 'TooManyFailedAttemptsException':
      return 'Bạn đã thao tác hoặc đăng nhập sai quá nhiều lần. Vui lòng đợi ít phút rồi thử lại.';
    case 'UserNotConfirmedException':
      return 'Tài khoản chưa được xác nhận email. Vui lòng nhập mã xác nhận 6 chữ số.';
    default:
      return rawMessage || 'Đã xảy ra lỗi trong quá trình xác thực. Vui lòng thử lại.';
  }
}

// ============================================================================
// 3. Giải mã & Tạo JWT phục vụ đọc custom:tenant_id và custom:role
// ============================================================================

function base64UrlEncode(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  const b64 =
    typeof btoa === 'function'
      ? btoa(binary)
      : Buffer.from(str, 'utf8').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(segment: string): string {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  const withPad = padded + '='.repeat(padLen);
  if (typeof atob === 'function') {
    const binary = atob(withPad);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  return Buffer.from(withPad, 'base64').toString('utf8');
}

export interface DecodedJwtClaims {
  sub: string;
  email: string;
  name?: string;
  'custom:tenant_id'?: string;
  'custom:role'?: string;
  'cognito:groups'?: string[];
  iat?: number;
  exp?: number;
}

export function decodeJwtClaims(token: string): DecodedJwtClaims | null {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    return JSON.parse(base64UrlDecode(parts[1])) as DecodedJwtClaims;
  } catch {
    return null;
  }
}

export function createMockJwt(claims: DecodedJwtClaims): string {
  const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64UrlEncode(
    JSON.stringify({
      ...claims,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  );
  return `${header}.${payload}.mock-signature`;
}

// ============================================================================
// 4. Kho dữ liệu Giả lập Cognito & Thành viên cô lập theo từng Tenant (Mục 4 Review)
// ============================================================================

interface SimulatedCognitoUser {
  sub: string;
  email: string;
  fullName: string;
  password: string;
  organizationName: string;
  tenantId: string;
  role: ConsoleRole;
  confirmed: boolean;
  confirmationCode: string;
  codeExpiresAt: number;
  forceChangePassword: boolean;
  failedLoginAttempts: number;
}

const initialUsers: SimulatedCognitoUser[] = [
  {
    sub: 'sub-lan-admin-01',
    email: 'lan@homestay-abc.example',
    fullName: 'Nguyễn Thị Lan',
    password: 'Password123',
    organizationName: 'Homestay ABC Hội An',
    tenantId: DEFAULT_DEMO_TENANT_ID,
    role: 'TENANT_ADMIN',
    confirmed: true,
    confirmationCode: '481920',
    codeExpiresAt: Date.now() + 15 * 60_000,
    forceChangePassword: false,
    failedLoginAttempts: 0,
  },
  {
    sub: 'sub-khoa-dev-02',
    email: 'khoa@homestay-abc.example',
    fullName: 'Trần Minh Khoa',
    password: 'Password123',
    organizationName: 'Homestay ABC Hội An',
    tenantId: DEFAULT_DEMO_TENANT_ID,
    role: 'DEVELOPER',
    confirmed: true,
    confirmationCode: '111111',
    codeExpiresAt: Date.now() + 15 * 60_000,
    forceChangePassword: false,
    failedLoginAttempts: 0,
  },
  {
    sub: 'sub-minh-rev-03',
    email: 'minh@homestay-abc.example',
    fullName: 'Lê Quang Minh',
    password: 'TempPassword123',
    organizationName: 'Homestay ABC Hội An',
    tenantId: DEFAULT_DEMO_TENANT_ID,
    role: 'REVIEWER',
    confirmed: true,
    confirmationCode: '222222',
    codeExpiresAt: Date.now() + 15 * 60_000,
    forceChangePassword: true,
    failedLoginAttempts: 0,
  },
];

const initialMembers: TenantMember[] = [
  {
    id: 'sub-lan-admin-01',
    tenantId: DEFAULT_DEMO_TENANT_ID,
    email: 'lan@homestay-abc.example',
    role: 'TENANT_ADMIN',
    status: 'ACTIVE',
  },
  {
    id: 'sub-khoa-dev-02',
    tenantId: DEFAULT_DEMO_TENANT_ID,
    email: 'khoa@homestay-abc.example',
    role: 'DEVELOPER',
    status: 'ACTIVE',
  },
  {
    id: 'sub-minh-rev-03',
    tenantId: DEFAULT_DEMO_TENANT_ID,
    email: 'minh@homestay-abc.example',
    role: 'REVIEWER',
    status: 'PENDING_FIRST_LOGIN',
  },
];

const simulatedUsers = new Map<string, SimulatedCognitoUser>(
  initialUsers.map((u) => [u.email.toLowerCase(), { ...u }]),
);

let simulatedMembers: TenantMember[] = initialMembers.map((m) => ({ ...m }));

export function resetSimulatedAuthStore(): void {
  simulatedUsers.clear();
  for (const u of initialUsers) {
    simulatedUsers.set(u.email.toLowerCase(), { ...u });
  }
  simulatedMembers = initialMembers.map((m) => ({ ...m }));
}

function buildSessionFromUser(user: SimulatedCognitoUser): AuthenticatedSession {
  const idToken = createMockJwt({
    sub: user.sub,
    email: user.email,
    name: user.fullName,
    'custom:tenant_id': user.tenantId,
    'custom:role': claimForConsoleRole(user.role),
  });

  return {
    email: user.email,
    fullName: user.fullName,
    sub: user.sub,
    tenantId: user.tenantId,
    organizationName: user.organizationName,
    plan: 'FREE',
    role: user.role,
    idToken,
    accessToken: `at_mock_${user.sub}_${Date.now()}`,
    refreshToken: `rt_${user.sub}_${Date.now()}`,
    tokenRefreshedAt: new Date().toISOString(),
  };
}

// ============================================================================
// 5. Các hàm Nghiệp vụ Xác thực (SignUp, ConfirmSignUp + RefreshToken, SignIn, ForceChangePassword, ForgotPassword)
// ============================================================================

/**
 * Đăng ký tài khoản mới (Hình 1.2 / `intro.jpg`).
 */
export async function registerAccount(input: SignUpFormInput): Promise<{
  email: string;
  organizationName: string;
  demoConfirmationCode: string;
}> {
  const fullName = input.fullName.trim();
  const email = input.email.trim().toLowerCase();
  const orgName = input.organizationName.trim();

  if (!fullName) {
    throw new ConsoleAuthError('ValidationError', 'Vui lòng nhập họ và tên của bạn.');
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ConsoleAuthError('ValidationError', 'Vui lòng nhập địa chỉ email công việc hợp lệ.');
  }
  if (!orgName) {
    throw new ConsoleAuthError('ValidationError', 'Vui lòng nhập tên tổ chức của bạn.');
  }
  if (!input.acceptedTerms) {
    throw new ConsoleAuthError('ValidationError', 'Bạn cần đồng ý với Điều khoản sử dụng để tạo tài khoản.');
  }

  const pwdCheck = validatePasswordPolicy(input.password);
  if (!pwdCheck.valid) {
    throw new ConsoleAuthError(
      'InvalidPasswordException',
      pwdCheck.message ?? mapCognitoErrorToVietnamese({ code: 'InvalidPasswordException' }),
    );
  }

  if (simulatedUsers.has(email)) {
    throw new ConsoleAuthError(
      'UsernameExistsException',
      mapCognitoErrorToVietnamese({ code: 'UsernameExistsException' }),
    );
  }

  const demoCode = '481926';
  const newUser: SimulatedCognitoUser = {
    sub: `sub-${Math.random().toString(36).slice(2, 10)}`,
    email,
    fullName,
    password: input.password,
    organizationName: orgName,
    tenantId: '', // Chỉ được gán sau khi PostConfirmation trigger chạy ở bước ConfirmSignUp
    role: 'TENANT_ADMIN',
    confirmed: false,
    confirmationCode: demoCode,
    codeExpiresAt: Date.now() + 15 * 60_000,
    forceChangePassword: false,
    failedLoginAttempts: 0,
  };

  simulatedUsers.set(email, newUser);

  return {
    email,
    organizationName: orgName,
    demoConfirmationCode: demoCode,
  };
}

/**
 * Xác nhận email bằng mã 6 chữ số (Hình 1.3 / `Xác nhận email.jpg`) & Làm mới Token (Mục B.13).
 */
export async function confirmEmailAndRefreshSession(
  input: ConfirmEmailInput,
): Promise<AuthenticatedSession> {
  const email = input.email.trim().toLowerCase();
  const code = input.code.trim();

  if (!/^\d{6}$/.test(code)) {
    throw new ConsoleAuthError('CodeMismatchException', 'Vui lòng nhập đủ 6 chữ số của mã xác nhận.');
  }

  if (code === '000000') {
    throw new ConsoleAuthError(
      'ExpiredCodeException',
      mapCognitoErrorToVietnamese({ code: 'ExpiredCodeException' }),
    );
  }

  let user = simulatedUsers.get(email);
  if (!user) {
    if (!IS_DEMO_AUTH_MODE) {
      throw new ConsoleAuthError(
        'UserNotFoundException',
        'Không tìm thấy tài khoản chờ xác nhận với địa chỉ email này.',
      );
    }
    // Chế độ demo (`IS_DEMO_AUTH_MODE`): cho phép mở thẳng màn Xác nhận email để thử nghiệm
    user = {
      sub: `sub-${Math.random().toString(36).slice(2, 10)}`,
      email,
      fullName: input.fullName || 'Nguyễn Thị Lan',
      password: input.password || 'Password123',
      organizationName: input.organizationName || 'Homestay ABC Hội An',
      tenantId: '',
      role: 'TENANT_ADMIN',
      confirmed: false,
      confirmationCode: code,
      codeExpiresAt: Date.now() + 15 * 60_000,
      forceChangePassword: false,
      failedLoginAttempts: 0,
    };
    simulatedUsers.set(email, user);
  }

  if (Date.now() > user.codeExpiresAt) {
    throw new ConsoleAuthError(
      'ExpiredCodeException',
      mapCognitoErrorToVietnamese({ code: 'ExpiredCodeException' }),
    );
  }

  const isCodeValid = code === user.confirmationCode || (IS_DEMO_AUTH_MODE && code === '481926');
  if (!isCodeValid) {
    throw new ConsoleAuthError(
      'CodeMismatchException',
      mapCognitoErrorToVietnamese({ code: 'CodeMismatchException' }),
    );
  }

  // Mô phỏng PostConfirmation_ConfirmSignUp gán custom:tenant_id và custom:role
  user.confirmed = true;
  if (!user.tenantId) {
    user.tenantId = `t_${Math.random().toString(36).slice(2, 12)}`;
  }
  user.role = 'TENANT_ADMIN';

  // Đảm bảo người dùng có mặt trong danh sách MEMBER của đúng tenantId vừa tạo
  if (
    !simulatedMembers.some(
      (m) => m.tenantId === user.tenantId && m.email.toLowerCase() === email,
    )
  ) {
    simulatedMembers.unshift({
      id: user.sub,
      tenantId: user.tenantId,
      email: user.email,
      role: 'TENANT_ADMIN',
      status: 'ACTIVE',
    });
  }

  const refreshedSession = await refreshTokenForTenantClaims(buildSessionFromUser(user));
  return refreshedSession;
}

/**
 * Làm mới bộ JWT sau khi trigger PostConfirmation gán `custom:tenant_id` và `custom:role` (Mục B.13).
 */
export async function refreshTokenForTenantClaims(
  session: AuthenticatedSession,
): Promise<AuthenticatedSession> {
  const claims = decodeJwtClaims(session.idToken);
  const tenantId = claims?.['custom:tenant_id'] || session.tenantId || DEFAULT_DEMO_TENANT_ID;
  const claimRole = normalizeRole(claims?.['custom:role']);
  const role = claimRole ??
    (session.role === 'PLATFORM_ADMIN' ? session.role : (
      session.role === 'TENANT_ADMIN' ||
      session.role === 'DEVELOPER' ||
      session.role === 'REVIEWER'
        ? session.role
        : 'TENANT_ADMIN'
    ));

  const refreshedJwt = createMockJwt({
    sub: session.sub,
    email: session.email,
    name: session.fullName,
    'custom:tenant_id': tenantId,
    'custom:role': claimForConsoleRole(role),
  });

  return {
    ...session,
    tenantId,
    role,
    idToken: refreshedJwt,
    accessToken: `at_mock_${session.sub}_${Date.now()}`,
    tokenRefreshedAt: new Date().toISOString(),
  };
}

/**
 * Gửi lại mã xác nhận 6 chữ số (ResendConfirmationCode).
 */
export async function resendConfirmationCode(email: string): Promise<{ expiresInSeconds: number }> {
  const normalized = email.trim().toLowerCase();
  const user = simulatedUsers.get(normalized);
  if (user) {
    user.confirmationCode = '481926';
    user.codeExpiresAt = Date.now() + 15 * 60_000;
  }
  return { expiresInSeconds: 60 };
}

/**
 * Bước 1 Quên mật khẩu: Yêu cầu gửi mã khôi phục mật khẩu 6 chữ số tới email.
 */
export async function requestPasswordResetCode(emailInput: string): Promise<{
  email: string;
  expiresInSeconds: number;
  demoResetCode: string;
}> {
  const email = emailInput.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ConsoleAuthError('ValidationError', 'Vui lòng nhập địa chỉ email công việc hợp lệ.');
  }

  const demoResetCode = '481926';
  const user = simulatedUsers.get(email);
  if (user) {
    user.confirmationCode = demoResetCode;
    user.codeExpiresAt = Date.now() + 15 * 60_000;
  }

  return {
    email,
    expiresInSeconds: 60,
    demoResetCode,
  };
}

/**
 * Bước 2 Quên mật khẩu: Xác nhận mã khôi phục 6 chữ số và đặt mật khẩu mới.
 */
export async function confirmForgotPasswordReset(
  input: ConfirmForgotPasswordInput,
): Promise<void> {
  const email = input.email.trim().toLowerCase();
  const code = input.code.trim();

  if (!/^\d{6}$/.test(code)) {
    throw new ConsoleAuthError('CodeMismatchException', 'Vui lòng nhập đủ 6 chữ số của mã khôi phục.');
  }

  if (code === '000000') {
    throw new ConsoleAuthError(
      'ExpiredCodeException',
      mapCognitoErrorToVietnamese({ code: 'ExpiredCodeException' }),
    );
  }

  const pwdCheck = validatePasswordPolicy(input.newPassword);
  if (!pwdCheck.valid) {
    throw new ConsoleAuthError(
      'InvalidPasswordException',
      pwdCheck.message ?? mapCognitoErrorToVietnamese({ code: 'InvalidPasswordException' }),
    );
  }

  if (input.newPassword !== input.confirmNewPassword) {
    throw new ConsoleAuthError('ValidationError', 'Mật khẩu nhập lại không khớp với mật khẩu mới.');
  }

  const user = simulatedUsers.get(email);
  if (!user) {
    throw new ConsoleAuthError(
      'CodeMismatchException',
      mapCognitoErrorToVietnamese({ code: 'CodeMismatchException' }),
    );
  }

  const isCodeValid = code === user.confirmationCode || (IS_DEMO_AUTH_MODE && code === '481926');
  if (!isCodeValid) {
    throw new ConsoleAuthError(
      'CodeMismatchException',
      mapCognitoErrorToVietnamese({ code: 'CodeMismatchException' }),
    );
  }

  user.password = input.newPassword;
  user.failedLoginAttempts = 0;
  user.confirmed = true;
}

/**
 * Đăng nhập vào Web Console (Hình 1.4 / `log-in.jpg`).
 */
export async function signInWithEmail(input: SignInFormInput): Promise<SignInOutcome> {
  const email = input.email.trim().toLowerCase();
  const password = input.password;

  if (!email || !password) {
    throw new ConsoleAuthError('ValidationError', 'Vui lòng nhập đầy đủ email và mật khẩu.');
  }

  const user = simulatedUsers.get(email);
  if (!user) {
    throw new ConsoleAuthError(
      'NotAuthorizedException',
      mapCognitoErrorToVietnamese({ code: 'NotAuthorizedException' }),
    );
  }

  if (user.failedLoginAttempts >= 5) {
    throw new ConsoleAuthError(
      'TooManyFailedAttemptsException',
      mapCognitoErrorToVietnamese({ code: 'TooManyFailedAttemptsException' }),
    );
  }

  if (user.password !== password) {
    user.failedLoginAttempts += 1;
    if (user.failedLoginAttempts >= 5) {
      throw new ConsoleAuthError(
        'TooManyFailedAttemptsException',
        mapCognitoErrorToVietnamese({ code: 'TooManyFailedAttemptsException' }),
      );
    }
    throw new ConsoleAuthError(
      'NotAuthorizedException',
      mapCognitoErrorToVietnamese({ code: 'NotAuthorizedException' }),
    );
  }

  user.failedLoginAttempts = 0;

  if (!user.confirmed) {
    return {
      status: 'CONFIRMATION_REQUIRED',
      email: user.email,
      organizationName: user.organizationName,
    };
  }

  if (user.forceChangePassword) {
    return {
      status: 'NEW_PASSWORD_REQUIRED',
      email: user.email,
      challengeSession: `chal_${user.sub}_${Date.now()}`,
      organizationName: user.organizationName,
      invitedRole: user.role === 'DEVELOPER' ? 'DEVELOPER' : 'REVIEWER',
    };
  }

  const session = await refreshTokenForTenantClaims(buildSessionFromUser(user));
  return {
    status: 'AUTHENTICATED',
    session,
  };
}

/**
 * Hoàn tất đặt mật khẩu mới ở lần đăng nhập đầu tiên khi vào bằng lời mời (Hình 1.6 / `Đặt lại mk.jpg`).
 */
export async function completeInvitedMemberPassword(
  input: ForceChangePasswordInput,
): Promise<AuthenticatedSession> {
  const email = input.email.trim().toLowerCase();
  if (!input.temporaryPassword) {
    throw new ConsoleAuthError('ValidationError', 'Vui lòng nhập mật khẩu tạm thời trong email mời.');
  }

  const pwdCheck = validatePasswordPolicy(input.newPassword);
  if (!pwdCheck.valid) {
    throw new ConsoleAuthError(
      'InvalidPasswordException',
      pwdCheck.message ?? mapCognitoErrorToVietnamese({ code: 'InvalidPasswordException' }),
    );
  }

  if (input.newPassword !== input.confirmNewPassword) {
    throw new ConsoleAuthError('ValidationError', 'Mật khẩu nhập lại không khớp với mật khẩu mới.');
  }

  let user = simulatedUsers.get(email);
  if (!user) {
    if (!IS_DEMO_AUTH_MODE) {
      throw new ConsoleAuthError('NotAuthorizedException', 'Email hoặc mật khẩu tạm thời không chính xác.');
    }
    user = {
      sub: `sub-invited-${Math.random().toString(36).slice(2, 8)}`,
      email: email || 'minh@homestay-abc.example',
      fullName: email.split('@')[0] || 'Thành viên mới',
      password: input.temporaryPassword,
      organizationName: input.organizationName || 'Homestay ABC Hội An',
      tenantId: DEFAULT_DEMO_TENANT_ID,
      role: input.invitedRole || 'REVIEWER',
      confirmed: true,
      confirmationCode: '000000',
      codeExpiresAt: Date.now() + 3600_000,
      forceChangePassword: true,
      failedLoginAttempts: 0,
    };
    simulatedUsers.set(user.email, user);
  } else if (user.password !== input.temporaryPassword) {
    throw new ConsoleAuthError('NotAuthorizedException', 'Mật khẩu tạm thời không chính xác.');
  }

  user.password = input.newPassword;
  user.forceChangePassword = false;

  const memberRecord = simulatedMembers.find(
    (m) => m.tenantId === user.tenantId && m.email.toLowerCase() === user.email.toLowerCase(),
  );
  if (memberRecord) {
    memberRecord.status = 'ACTIVE';
  } else {
    simulatedMembers.push({
      id: user.sub,
      tenantId: user.tenantId,
      email: user.email,
      role: user.role,
      status: 'ACTIVE',
    });
  }

  return refreshTokenForTenantClaims(buildSessionFromUser(user));
}

// ============================================================================
// 6. Quản lý danh sách Thành viên & Mời thành viên cô lập theo Tenant (Hình 1.5 / `Mời thành viên.jpg`)
// ============================================================================

/**
 * Lấy danh sách thành viên thuộc đúng `tenantId` của tổ chức hiện tại.
 */
export async function listTenantMembers(
  tenantId: string = DEFAULT_DEMO_TENANT_ID,
): Promise<TenantMember[]> {
  return simulatedMembers
    .filter((m) => m.tenantId === tenantId)
    .map((m) => ({ ...m }));
}

/**
 * Mời thành viên mới vào tổ chức (`POST /console/members/invite`).
 * Chỉ cho phép vai trò `DEVELOPER` hoặc `REVIEWER`, gắn đúng `tenantId` của người mời.
 */
export async function inviteTenantMember(
  actorRole: ConsoleRole,
  emailInput: string,
  invitedRole: string,
  organizationName = 'Homestay ABC Hội An',
  tenantId: string = DEFAULT_DEMO_TENANT_ID,
): Promise<{ member: TenantMember; temporaryPassword: string }> {
  if (actorRole !== 'TENANT_ADMIN') {
    throw new ConsoleAuthError('PERMISSION_DENIED', 'Chỉ Tenant Admin mới có quyền mời thành viên.');
  }

  const email = emailInput.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ConsoleAuthError('ValidationError', 'Địa chỉ email thành viên không hợp lệ.');
  }

  if (invitedRole !== 'DEVELOPER' && invitedRole !== 'REVIEWER') {
    throw new ConsoleAuthError(
      'ValidationError',
      'Chỉ được phép mời thành viên với vai trò Developer hoặc Reviewer.',
    );
  }

  if (
    simulatedMembers.some((m) => m.tenantId === tenantId && m.email.toLowerCase() === email) ||
    simulatedUsers.has(email)
  ) {
    throw new ConsoleAuthError(
      'UsernameExistsException',
      'Thành viên có email này đã tồn tại trên hệ thống hoặc trong tổ chức.',
    );
  }

  const temporaryPassword = 'TempPassword123';
  const sub = `sub-${Math.random().toString(36).slice(2, 10)}`;

  const newMember: TenantMember = {
    id: sub,
    tenantId,
    email,
    role: invitedRole,
    status: 'PENDING_FIRST_LOGIN',
    invitedAt: new Date().toISOString(),
  };

  simulatedMembers.push(newMember);

  simulatedUsers.set(email, {
    sub,
    email,
    fullName: email.split('@')[0],
    password: temporaryPassword,
    organizationName,
    tenantId,
    role: invitedRole,
    confirmed: true,
    confirmationCode: '000000',
    codeExpiresAt: Date.now() + 86400_000,
    forceChangePassword: true,
    failedLoginAttempts: 0,
  });

  return {
    member: { ...newMember },
    temporaryPassword,
  };
}
