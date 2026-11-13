/**
 * Dịch vụ Xác thực, Làm mới Token (B.13), Phân quyền Menu và Quản lý Thành viên cho Màn Q1.
 *
 * Hai chế độ:
 *  - `VITE_AUTH_MODE=cognito`: gọi Amazon Cognito thật (Mục 7, lớp HTTP ở `cognitoIdp.ts`) và REST API Console.
 *  - **Chế độ giả lập (Local Mock Mode)** tại trình duyệt (bật khi `VITE_AUTH_MODE=mock`, mặc định),
 *    tái hiện đầy đủ các bước nghiệp vụ của Màn Q1:
 *    SignUp -> Mã xác nhận 6 chữ số -> Mô phỏng Trigger PostConfirmation tạo Tenant -> Làm mới JWT
 *    chứa `custom:tenant_id` & `custom:role` -> ForceChangePassword cho lời mời -> Mời thành viên theo từng Tenant.
 *
 * Chế độ Cognito thật (Mục 7):
 *  - Gọi trực tiếp Amazon Cognito IDP (`SignUp`, `ConfirmSignUp`, `InitiateAuth`, `RespondToAuthChallenge`,
 *    `ForgotPassword`, `ConfirmForgotPassword`) sử dụng `VITE_AWS_REGION`, `VITE_COGNITO_USER_POOL_ID`, `VITE_COGNITO_CLIENT_ID`.
 *  - Làm mới token thật (`REFRESH_TOKEN_AUTH`) ngay sau khi Lambda `PostConfirmation_ConfirmSignUp` tạo tenant.
 *  - Gọi REST API `GET /console/me` và `GET/POST /console/members` qua `VITE_API_BASE_URL`.
 */

import {
  extractApiErrorPayload,
  isKnownConsoleErrorCode,
  isNetworkErrorMessage,
  isSafeToRetryOperation,
  parseKnownUpperErrorCode,
  resolveConsoleError,
  sanitizeClientSafeMessage,
  type ResolveConsoleErrorOptions,
} from './errorMapping.js';
import {
  callCognito,
  CognitoIdpError,
  type CognitoAuthenticationResult,
  type CognitoIdpConfig,
  type CognitoInitiateAuthResponse,
  type CognitoOperation,
} from './cognitoIdp.js';
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
  TenantStatus,
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

const envApiBaseUrl =
  (typeof import.meta !== 'undefined'
    ? (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_API_BASE_URL
    : undefined) ??
  (typeof process !== 'undefined' ? process.env?.VITE_API_BASE_URL : undefined) ??
  '';

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
 * Chuẩn hóa vai trò tenant từ claim `custom:role` về mã chuẩn `ConsoleRole`.
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
    public requestId?: string,
    public httpStatus?: number,
  ) {
    super(message);
    this.name = 'ConsoleAuthError';
  }
}

/**
 * Chuyển mã lỗi của Amazon Cognito / API (Bảng 2.10) sang thông báo tiếng Việt rõ ràng cho người dùng.
 */
export function mapCognitoErrorToVietnamese(
  err: unknown,
  opts: ResolveConsoleErrorOptions = {},
): string {
  const rawCode =
    err && typeof err === 'object' && ('name' in err || '__type' in err || 'code' in err)
      ? String(
          (err as Record<string, unknown>).code ??
            (err as Record<string, unknown>).__type ??
            (err as Record<string, unknown>).name,
        )
      : '';
  const code = rawCode.includes('#')
    ? rawCode.split('#').pop()!
    : rawCode || (parseKnownUpperErrorCode(err) ?? '');
  const rawMessage = err instanceof Error ? err.message : String(err ?? '');

  if (
    err instanceof ConsoleAuthError &&
    !isKnownConsoleErrorCode(err.code) &&
    (err.code === 'ValidationError' || /[À-ỹ]/u.test(err.message))
  ) {
    const safe = sanitizeClientSafeMessage(err.message);
    if (safe) return safe;
  }

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
      if (isKnownConsoleErrorCode(code)) {
        return resolveConsoleError(err, {
          ...opts,
          scope: opts.scope ?? 'auth',
          overrides: {
            PERMISSION_DENIED: 'Chỉ Tenant Admin mới có quyền quản lý và mời thành viên.',
            TENANT_SUSPENDED: 'Tổ chức đang bị tạm khóa (chế độ chỉ xem); không thể thay đổi thành viên.',
            ...opts.overrides,
          },
        }).message;
      }
      if (isNetworkErrorMessage(rawMessage)) {
        return resolveConsoleError(err, { ...opts, scope: opts.scope ?? 'auth' }).message;
      }
      if (err && typeof err === 'object' && 'httpStatus' in err) {
        return resolveConsoleError(err, { ...opts, scope: opts.scope ?? 'auth' }).message;
      }
      const safeFallback = isSafeToRetryOperation(opts.operation)
        ? 'Đã xảy ra lỗi trong quá trình xác thực. Vui lòng thử lại.'
        : 'Đã xảy ra lỗi khi gửi yêu cầu. Vui lòng kiểm tra trạng thái hiện tại trước khi gửi lại.';
      return sanitizeClientSafeMessage(rawMessage) ?? safeFallback;
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

const simulatedTenantStatuses = new Map<string, 'ACTIVE' | 'LOCKED'>([
  [DEFAULT_DEMO_TENANT_ID, 'ACTIVE'],
]);

export function getDemoTenantStatus(tenantId: string = DEFAULT_DEMO_TENANT_ID): 'ACTIVE' | 'LOCKED' {
  return simulatedTenantStatuses.get(tenantId) ?? 'ACTIVE';
}

export function setDemoTenantStatus(tenantId: string, status: 'ACTIVE' | 'LOCKED'): void {
  simulatedTenantStatuses.set(tenantId || DEFAULT_DEMO_TENANT_ID, status);
}

export interface FetchConsoleTenantProfileOptions {
  demoMode?: boolean;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

export interface ConsoleTenantProfile {
  tenantId: string;
  role: ConsoleRole;
  tenantStatus: 'ACTIVE' | 'LOCKED';
  tenantLocked: boolean;
  organizationName?: string;
  plan?: AuthenticatedSession['plan'];
  characterLimit?: number;
}

function parseTenantStatusFromProfilePayload(
  data: Record<string, unknown>,
): 'ACTIVE' | 'LOCKED' | null {
  const rawStatus =
    typeof (data.tenant_status ?? data.tenantStatus ?? data.status) === 'string'
      ? String(data.tenant_status ?? data.tenantStatus ?? data.status)
          .trim()
          .toUpperCase()
      : '';
  if (rawStatus === 'LOCKED' || rawStatus === 'SUSPENDED') return 'LOCKED';
  if (rawStatus === 'ACTIVE') return 'ACTIVE';

  const rawLocked = data.tenant_locked ?? data.tenantLocked;
  if (rawLocked === true) return 'LOCKED';
  if (rawLocked === false) return 'ACTIVE';
  return null;
}

function normalizeConsolePlan(raw: unknown): AuthenticatedSession['plan'] | undefined {
  if (typeof raw !== 'string') return undefined;
  const upper = raw.trim().toUpperCase();
  if (upper === 'PRO' || upper === 'BUSINESS' || upper === 'FREE') return upper;
  return undefined;
}

/**
 * Truy vấn `GET /console/me` (hoặc kho demo khi `demoMode = true`) để xác minh trạng thái `ACTIVE` / `LOCKED`
 * của tổ chức trước khi bật thao tác ghi trên Web Console.
 */
export async function fetchConsoleTenantProfile(
  session: Pick<
    AuthenticatedSession,
    'tenantId' | 'role' | 'idToken' | 'organizationName' | 'plan' | 'characterLimit'
  >,
  opts: FetchConsoleTenantProfileOptions = {},
): Promise<ConsoleTenantProfile> {
  const demoMode = opts.demoMode ?? IS_DEMO_AUTH_MODE;
  if (demoMode) {
    const status = getDemoTenantStatus(session.tenantId);
    return {
      tenantId: session.tenantId,
      role: session.role,
      tenantStatus: status,
      tenantLocked: status === 'LOCKED',
      organizationName: session.organizationName,
      plan: session.plan,
      ...(typeof session.characterLimit === 'number'
        ? { characterLimit: session.characterLimit }
        : {}),
    };
  }

  const base = (opts.baseUrl ?? envApiBaseUrl).replace(/\/+$/, '');
  const doFetch = opts.fetchFn ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  if (!base && !opts.fetchFn) {
    throw new ConsoleAuthError(
      'NETWORK_ERROR',
      'Chưa cấu hình địa chỉ API (VITE_API_BASE_URL) để kiểm tra trạng thái tổ chức.',
    );
  }

  let res: Response;
  try {
    res = await doFetch(`${base}/console/me`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${session.idToken}`,
      },
    });
  } catch {
    throw new ConsoleAuthError('NETWORK_ERROR', 'Không kết nối được tới máy chủ.');
  }

  let data: Record<string, unknown> = {};
  try {
    const parsed = (await res.json()) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    data = {};
  }

  if (!res.ok) {
    const extracted = extractApiErrorPayload(data, res.status);
    throw new ConsoleAuthError(
      extracted.code,
      extracted.message,
      extracted.requestId,
      extracted.httpStatus,
    );
  }

  const tenantStatus = parseTenantStatusFromProfilePayload(data);
  if (!tenantStatus) {
    throw new ConsoleAuthError(
      'INTERNAL_ERROR',
      'Phản hồi trạng thái tổ chức không hợp lệ.',
      undefined,
      500,
    );
  }

  const resolvedRole = normalizeRole(
    typeof data.role === 'string' ? data.role : undefined,
  );
  const role: ConsoleRole =
    resolvedRole ??
    (data.role === 'TENANT_ADMIN' ||
    data.role === 'DEVELOPER' ||
    data.role === 'REVIEWER' ||
    data.role === 'PLATFORM_ADMIN'
      ? (data.role as ConsoleRole)
      : session.role);

  const orgNameRaw = data.organization_name ?? data.organizationName;
  const organizationName =
    typeof orgNameRaw === 'string' && orgNameRaw.trim()
      ? orgNameRaw.trim()
      : undefined;
  const plan = normalizeConsolePlan(data.plan);
  const rawLimit = data.character_limit ?? data.characterLimit ?? data.charLimit;
  const characterLimit =
    typeof rawLimit === 'number' && Number.isSafeInteger(rawLimit) && rawLimit >= 0
      ? rawLimit
      : undefined;

  return {
    tenantId:
      typeof (data.tenant_id ?? data.tenantId) === 'string' &&
      String(data.tenant_id ?? data.tenantId).trim()
        ? String(data.tenant_id ?? data.tenantId).trim()
        : session.tenantId,
    role,
    tenantStatus,
    tenantLocked: tenantStatus === 'LOCKED',
    ...(organizationName ? { organizationName } : {}),
    ...(plan ? { plan } : {}),
    ...(characterLimit !== undefined ? { characterLimit } : {}),
  };
}

/**
 * Nạp trạng thái tenant (`ACTIVE` | `LOCKED` | `UNKNOWN`) vào phiên làm việc ngay sau khi đăng nhập / làm mới token.
 * Lỗi `TENANT_SUSPENDED` ánh xạ sang `'LOCKED'`; lỗi khác giữ `'UNKNOWN'` để giao diện khóa ghi fail-closed.
 */
export async function hydrateSessionTenantStatus(
  session: AuthenticatedSession,
  opts: FetchConsoleTenantProfileOptions = {},
): Promise<AuthenticatedSession> {
  if (session.role === 'PLATFORM_ADMIN') {
    return {
      ...session,
      tenantStatus: 'ACTIVE',
    };
  }
  try {
    const profile = await fetchConsoleTenantProfile(session, opts);
    return {
      ...session,
      tenantId: profile.tenantId || session.tenantId,
      role: profile.role,
      tenantStatus: profile.tenantStatus,
      ...(profile.organizationName ? { organizationName: profile.organizationName } : {}),
      ...(profile.plan ? { plan: profile.plan } : {}),
      ...(profile.characterLimit !== undefined ? { characterLimit: profile.characterLimit } : {}),
    };
  } catch (err) {
    if (err instanceof ConsoleAuthError && err.code === 'TENANT_SUSPENDED') {
      return {
        ...session,
        tenantStatus: 'LOCKED',
      };
    }
    return {
      ...session,
      tenantStatus: 'UNKNOWN',
    };
  }
}

export function resetSimulatedAuthStore(): void {
  simulatedUsers.clear();
  for (const u of initialUsers) {
    simulatedUsers.set(u.email.toLowerCase(), { ...u });
  }
  simulatedMembers = initialMembers.map((m) => ({ ...m }));
  simulatedTenantStatuses.clear();
  simulatedTenantStatuses.set(DEFAULT_DEMO_TENANT_ID, 'ACTIVE');
}

function buildSessionFromUser(
  user: SimulatedCognitoUser,
  tenantStatus?: TenantStatus,
): AuthenticatedSession {
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
    tenantStatus: tenantStatus ?? (IS_DEMO_AUTH_MODE ? getDemoTenantStatus(user.tenantId) : 'UNKNOWN'),
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

  if (!IS_DEMO_AUTH_MODE) {
    return cognitoLive.registerAccount(fullName, email, input.password, orgName);
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
  opts?: FetchConsoleTenantProfileOptions,
): Promise<AuthenticatedSession> {
  const email = input.email.trim().toLowerCase();
  const code = input.code.trim();

  if (!/^\d{6}$/.test(code)) {
    throw new ConsoleAuthError('CodeMismatchException', 'Vui lòng nhập đủ 6 chữ số của mã xác nhận.');
  }

  if (!IS_DEMO_AUTH_MODE) {
    return cognitoLive.confirmEmail(email, code, input, opts);
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
  if (!simulatedTenantStatuses.has(user.tenantId)) {
    simulatedTenantStatuses.set(user.tenantId, 'ACTIVE');
  }

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

  const refreshedSession = await refreshTokenForTenantClaims(buildSessionFromUser(user), opts);
  return refreshedSession;
}

/**
 * Làm mới bộ JWT sau khi trigger PostConfirmation gán `custom:tenant_id` và `custom:role` (Mục B.13).
 */
export async function refreshTokenForTenantClaims(
  session: AuthenticatedSession,
  opts: FetchConsoleTenantProfileOptions = {},
): Promise<AuthenticatedSession> {
  if (!IS_DEMO_AUTH_MODE) {
    return cognitoLive.refreshSession(session, opts);
  }
  const claims = decodeJwtClaims(session.idToken);
  const tenantId = claims?.['custom:tenant_id'] || session.tenantId || DEFAULT_DEMO_TENANT_ID;
  const claimRole = normalizeRole(claims?.['custom:role']);
  const role = claimRole ??
    (session.role === 'PLATFORM_ADMIN' ? session.role : (
      session.role === 'TENANT_ADMIN' ||
      session.role === 'DEVELOPER' ||
      session.role === 'REVIEWER'
        ? session.role
        : 'REVIEWER'
    ));

  const refreshedJwt = createMockJwt({
    sub: session.sub,
    email: session.email,
    name: session.fullName,
    'custom:tenant_id': tenantId,
    'custom:role': claimForConsoleRole(role),
  });

  const updatedSession: AuthenticatedSession = {
    ...session,
    tenantId,
    role,
    idToken: refreshedJwt,
    accessToken: `at_mock_${session.sub}_${Date.now()}`,
    tokenRefreshedAt: new Date().toISOString(),
    tenantStatus: session.tenantStatus ?? 'UNKNOWN',
  };
  return hydrateSessionTenantStatus(updatedSession, opts);
}

/**
 * Gửi lại mã xác nhận 6 chữ số (ResendConfirmationCode).
 */
export async function resendConfirmationCode(email: string): Promise<{ expiresInSeconds: number }> {
  const normalized = email.trim().toLowerCase();
  if (!IS_DEMO_AUTH_MODE) {
    return cognitoLive.resendConfirmationCode(normalized);
  }
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

  if (!IS_DEMO_AUTH_MODE) {
    return cognitoLive.requestPasswordReset(email);
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

  if (IS_DEMO_AUTH_MODE && code === '000000') {
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

  if (!IS_DEMO_AUTH_MODE) {
    return cognitoLive.confirmPasswordReset(email, code, input.newPassword);
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
export async function signInWithEmail(
  input: SignInFormInput,
  opts?: FetchConsoleTenantProfileOptions,
): Promise<SignInOutcome> {
  const email = input.email.trim().toLowerCase();
  const password = input.password;

  if (!email || !password) {
    throw new ConsoleAuthError('ValidationError', 'Vui lòng nhập đầy đủ email và mật khẩu.');
  }

  if (!IS_DEMO_AUTH_MODE) {
    return cognitoLive.signIn(email, password, opts);
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

  const session = await refreshTokenForTenantClaims(buildSessionFromUser(user), opts);
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
  opts?: FetchConsoleTenantProfileOptions,
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

  if (!IS_DEMO_AUTH_MODE) {
    return cognitoLive.completeInvitedPassword(email, input, opts);
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

  return refreshTokenForTenantClaims(buildSessionFromUser(user), opts);
}

// ============================================================================
// 6. Quản lý danh sách Thành viên & Mời thành viên cô lập theo Tenant (Hình 1.5 / `Mời thành viên.jpg`)
// ============================================================================

/**
 * Lấy danh sách thành viên thuộc đúng `tenantId` của tổ chức hiện tại.
 */
export async function listTenantMembers(
  tenantId: string = DEFAULT_DEMO_TENANT_ID,
  idToken?: string,
): Promise<TenantMember[]> {
  if (!IS_DEMO_AUTH_MODE) {
    return cognitoLive.listTenantMembers(tenantId, idToken);
  }
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
  idToken?: string,
): Promise<{ member: TenantMember; temporaryPassword: string }> {
  if (actorRole !== 'TENANT_ADMIN') {
    throw new ConsoleAuthError('PERMISSION_DENIED', 'Chỉ Tenant Admin mới có quyền mời thành viên.');
  }
  if (getDemoTenantStatus(tenantId) === 'LOCKED') {
    throw new ConsoleAuthError(
      'TENANT_SUSPENDED',
      'Tổ chức đang bị tạm khóa (chế độ chỉ xem); không thể thay đổi thành viên.',
    );
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

  if (!IS_DEMO_AUTH_MODE) {
    return cognitoLive.inviteTenantMember(email, invitedRole, tenantId, idToken);
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

// ============================================================================
// 7. Chế độ kết nối Amazon Cognito thật (`VITE_AUTH_MODE=cognito`)
//    Các hàm nghiệp vụ ở Mục 5–6 chuyển sang nhánh này khi `IS_DEMO_AUTH_MODE = false`.
//    Đăng nhập bằng USER_PASSWORD_AUTH (app client công khai); tenant_id và role chỉ đọc từ ID token
//    do Cognito ký (PostConfirmation / AdminCreateUser gán), không bao giờ lấy từ dữ liệu client gửi (QC-3).
// ============================================================================

/** Tùy chọn cho chế độ Cognito thật; mặc định đọc `VITE_AWS_REGION`, `VITE_COGNITO_CLIENT_ID`, `VITE_API_BASE_URL`. */
export interface CognitoLiveOptions extends FetchConsoleTenantProfileOptions {
  region?: string;
  clientId?: string;
  cognitoEndpoint?: string;
}

const liveViteEnv: Record<string, string | undefined> =
  (typeof import.meta !== 'undefined'
    ? (import.meta as unknown as { env?: Record<string, string | undefined> }).env
    : undefined) ?? {};

function liveEnv(name: string): string {
  const fromNode = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  return (liveViteEnv[name] ?? fromNode ?? '').trim();
}

function liveIdpConfig(opts: CognitoLiveOptions = {}): CognitoIdpConfig {
  return {
    region: opts.region ?? liveEnv('VITE_AWS_REGION'),
    clientId: opts.clientId ?? liveEnv('VITE_COGNITO_CLIENT_ID'),
    endpoint: opts.cognitoEndpoint,
    fetchFn: opts.fetchFn,
  };
}

/** Thông báo riêng cho các lỗi Cognito mà bảng ánh xạ chung chưa có. */
function liveCognitoMessage(err: CognitoIdpError): string | null {
  const msg = err.message ?? '';
  switch (err.code) {
    case 'CONFIG_ERROR':
      return 'Web Console chưa được cấu hình Amazon Cognito (thiếu Region hoặc App client). Vui lòng liên hệ quản trị viên.';
    case 'UserLambdaValidationException':
    case 'UnexpectedLambdaException':
    case 'InvalidLambdaResponseException':
      return 'Không khởi tạo được tổ chức cho tài khoản này. Vui lòng thử lại sau ít phút hoặc liên hệ quản trị viên.';
    case 'CodeDeliveryFailureException':
      return 'Không gửi được mã xác nhận tới email. Vui lòng kiểm tra lại địa chỉ email hoặc thử lại sau.';
    case 'PasswordResetRequiredException':
      return 'Tài khoản cần đặt lại mật khẩu. Vui lòng dùng chức năng Quên mật khẩu.';
    case 'InvalidParameterException':
      if (/verified email|registered\/verified/i.test(msg)) {
        return 'Tài khoản chưa có email đã xác minh nên không thể đặt lại mật khẩu.';
      }
      return 'Thông tin gửi lên chưa hợp lệ. Vui lòng kiểm tra lại email và mật khẩu.';
    case 'NotAuthorizedException':
      if (/temporary password has expired/i.test(msg)) {
        return 'Mật khẩu tạm thời đã hết hạn. Vui lòng nhờ Tenant Admin mời lại.';
      }
      if (/refresh token/i.test(msg)) {
        return 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.';
      }
      return null;
    default:
      return null;
  }
}

function toConsoleAuthError(err: unknown): ConsoleAuthError {
  if (err instanceof ConsoleAuthError) return err;
  if (err instanceof CognitoIdpError) {
    const message = liveCognitoMessage(err) ?? mapCognitoErrorToVietnamese(err);
    return new ConsoleAuthError(err.code, message, undefined, err.httpStatus);
  }
  return new ConsoleAuthError('INTERNAL_ERROR', mapCognitoErrorToVietnamese(err));
}

async function liveIdp<T>(
  operation: CognitoOperation,
  body: Record<string, unknown>,
  opts: CognitoLiveOptions = {},
  tolerate?: (err: CognitoIdpError) => boolean,
): Promise<T | undefined> {
  try {
    return await callCognito<T>(operation, body, liveIdpConfig(opts));
  } catch (err) {
    if (tolerate && err instanceof CognitoIdpError && tolerate(err)) return undefined;
    throw toConsoleAuthError(err);
  }
}

function parseJsonValue(raw: string | undefined): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** Dựng phiên Console từ bộ token Cognito rồi nạp trạng thái tenant qua `GET /console/me`. */
async function liveSessionFromTokens(
  result: CognitoAuthenticationResult | undefined,
  opts: CognitoLiveOptions,
  previous?: Partial<AuthenticatedSession>,
): Promise<AuthenticatedSession> {
  const idToken = result?.IdToken ?? '';
  const claims = idToken ? (decodeJwtClaims(idToken) as (DecodedJwtClaims & Record<string, unknown>) | null) : null;
  if (!claims) {
    throw new ConsoleAuthError('INVALID_AUTH_RESPONSE', 'Phản hồi đăng nhập từ Amazon Cognito không hợp lệ. Vui lòng thử lại.');
  }
  const groups = claims['cognito:groups'];
  const isPlatformAdmin = Array.isArray(groups) && groups.includes('PlatformAdmins');
  const tenantId = isPlatformAdmin ? '' : String(claims['custom:tenant_id'] ?? '').trim();
  const role = isPlatformAdmin ? 'PLATFORM_ADMIN' : normalizeRole(claims['custom:role']);
  if (!role || (!isPlatformAdmin && !tenantId)) {
    throw new ConsoleAuthError(
      'TENANT_NOT_LINKED',
      'Tài khoản chưa được gắn với tổ chức nào. Nếu bạn vừa xác nhận email, vui lòng đợi vài giây rồi đăng nhập lại.',
    );
  }
  const email = String(claims.email ?? previous?.email ?? '');
  const orgClaim = claims['custom:organization_name'];
  const session: AuthenticatedSession = {
    email,
    fullName: String(claims.name ?? previous?.fullName ?? (email.split('@')[0] || email)),
    sub: String(claims.sub ?? previous?.sub ?? ''),
    tenantId,
    organizationName: typeof orgClaim === 'string' && orgClaim ? orgClaim : previous?.organizationName ?? '',
    plan: previous?.plan ?? 'FREE',
    role,
    idToken,
    accessToken: result?.AccessToken ?? '',
    // REFRESH_TOKEN_AUTH không trả refresh token mới: giữ token cũ.
    refreshToken: result?.RefreshToken ?? previous?.refreshToken ?? '',
    tokenRefreshedAt: new Date().toISOString(),
    tenantStatus: 'UNKNOWN',
  };
  return hydrateSessionTenantStatus(session, { ...opts, demoMode: false });
}

function livePasswordAuth(email: string, password: string, opts: CognitoLiveOptions) {
  return callCognito<CognitoInitiateAuthResponse>(
    'InitiateAuth',
    { AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: email, PASSWORD: password } },
    liveIdpConfig(opts),
  );
}

async function liveRegisterAccount(
  fullName: string,
  email: string,
  password: string,
  organizationName: string,
  opts: CognitoLiveOptions = {},
): Promise<{ email: string; organizationName: string; demoConfirmationCode: string }> {
  await liveIdp('SignUp', {
    Username: email,
    Password: password,
    UserAttributes: [
      { Name: 'email', Value: email },
      { Name: 'name', Value: fullName },
      { Name: 'custom:organization_name', Value: organizationName },
    ],
  }, opts);
  return { email, organizationName, demoConfirmationCode: '' };
}

async function liveConfirmEmail(
  email: string,
  code: string,
  input: ConfirmEmailInput,
  opts: CognitoLiveOptions = {},
): Promise<AuthenticatedSession> {
  const organizationName = input.organizationName?.trim();
  await liveIdp(
    'ConfirmSignUp',
    {
      Username: email,
      ConfirmationCode: code,
      // PostConfirmation đọc tên tổ chức từ ClientMetadata, dự phòng bằng thuộc tính custom:organization_name.
      ...(organizationName ? { ClientMetadata: { organization_name: organizationName } } : {}),
    },
    opts,
    // Đã xác nhận từ trước (bấm lại, hoặc mở lại màn hình): đi tiếp sang đăng nhập.
    (err) => err.code === 'NotAuthorizedException' && /current status is confirmed/i.test(err.message),
  );

  if (!input.password) {
    throw new ConsoleAuthError('SIGN_IN_REQUIRED', 'Email đã được xác nhận. Vui lòng đăng nhập để tiếp tục.');
  }
  let auth: CognitoInitiateAuthResponse;
  try {
    auth = await livePasswordAuth(email, input.password, opts);
  } catch (err) {
    throw toConsoleAuthError(err);
  }
  return liveSessionFromTokens(auth.AuthenticationResult, opts, {
    email,
    fullName: input.fullName,
    organizationName: organizationName ?? '',
  });
}

async function liveSignIn(email: string, password: string, opts: CognitoLiveOptions = {}): Promise<SignInOutcome> {
  let res: CognitoInitiateAuthResponse;
  try {
    res = await livePasswordAuth(email, password, opts);
  } catch (err) {
    if (err instanceof CognitoIdpError && err.code === 'UserNotConfirmedException') {
      // Cognito không tự gửi lại mã khi đăng nhập: gửi lại để người dùng có mã còn hạn (bỏ qua lỗi gửi lại).
      await callCognito('ResendConfirmationCode', { Username: email }, liveIdpConfig(opts)).catch(() => undefined);
      return { status: 'CONFIRMATION_REQUIRED', email, organizationName: '' };
    }
    throw toConsoleAuthError(err);
  }

  if (res.AuthenticationResult) {
    return { status: 'AUTHENTICATED', session: await liveSessionFromTokens(res.AuthenticationResult, opts, { email }) };
  }
  if (res.ChallengeName === 'NEW_PASSWORD_REQUIRED') {
    const attrsRaw = parseJsonValue(res.ChallengeParameters?.userAttributes);
    const attrs = attrsRaw && typeof attrsRaw === 'object' ? (attrsRaw as Record<string, unknown>) : {};
    const role = normalizeRole(typeof attrs['custom:role'] === 'string' ? attrs['custom:role'] : undefined);
    const org = attrs['custom:organization_name'];
    return {
      status: 'NEW_PASSWORD_REQUIRED',
      email,
      challengeSession: res.Session ?? '',
      organizationName: typeof org === 'string' ? org : '',
      invitedRole: role === 'DEVELOPER' ? 'DEVELOPER' : 'REVIEWER',
    };
  }
  throw new ConsoleAuthError(
    'UNSUPPORTED_CHALLENGE',
    `Tài khoản yêu cầu một bước xác thực Web Console chưa hỗ trợ (${res.ChallengeName ?? 'không rõ'}).`,
  );
}

async function liveCompleteInvitedPassword(
  email: string,
  input: ForceChangePasswordInput,
  opts: CognitoLiveOptions = {},
): Promise<AuthenticatedSession> {
  // Luôn lấy Session challenge mới (Session của Cognito chỉ sống vài phút) bằng mật khẩu tạm thời.
  let first: CognitoInitiateAuthResponse;
  try {
    first = await livePasswordAuth(email, input.temporaryPassword, opts);
  } catch (err) {
    if (err instanceof CognitoIdpError && err.code === 'NotAuthorizedException' && !liveCognitoMessage(err)) {
      throw new ConsoleAuthError('NotAuthorizedException', 'Email hoặc mật khẩu tạm thời không chính xác.', undefined, err.httpStatus);
    }
    throw toConsoleAuthError(err);
  }
  if (first.AuthenticationResult) {
    // Mật khẩu đã được đổi từ trước: dùng luôn phiên vừa đăng nhập.
    return liveSessionFromTokens(first.AuthenticationResult, opts, { email });
  }
  if (first.ChallengeName !== 'NEW_PASSWORD_REQUIRED') {
    throw new ConsoleAuthError(
      'UNSUPPORTED_CHALLENGE',
      `Tài khoản yêu cầu một bước xác thực Web Console chưa hỗ trợ (${first.ChallengeName ?? 'không rõ'}).`,
    );
  }

  const params = first.ChallengeParameters ?? {};
  const responses: Record<string, string> = {
    USERNAME: params.USER_ID_FOR_SRP || email,
    NEW_PASSWORD: input.newPassword,
  };
  const required = parseJsonValue(params.requiredAttributes);
  if (Array.isArray(required) && required.includes('userAttributes.name')) {
    responses['userAttributes.name'] = email.split('@')[0] || email;
  }
  const out = await liveIdp<CognitoInitiateAuthResponse>(
    'RespondToAuthChallenge',
    { ChallengeName: 'NEW_PASSWORD_REQUIRED', Session: first.Session, ChallengeResponses: responses },
    opts,
  );
  return liveSessionFromTokens(out?.AuthenticationResult, opts, {
    email,
    organizationName: input.organizationName ?? '',
  });
}

async function liveRefreshSession(
  session: AuthenticatedSession,
  opts: CognitoLiveOptions = {},
): Promise<AuthenticatedSession> {
  if (!session.refreshToken) {
    throw new ConsoleAuthError('SIGN_IN_REQUIRED', 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
  }
  const out = await liveIdp<CognitoInitiateAuthResponse>(
    'InitiateAuth',
    { AuthFlow: 'REFRESH_TOKEN_AUTH', AuthParameters: { REFRESH_TOKEN: session.refreshToken } },
    opts,
  );
  return liveSessionFromTokens(out?.AuthenticationResult, opts, session);
}

/**
 * Đăng xuất: thu hồi refresh token trên Cognito (bỏ qua lỗi, phiên phía trình duyệt luôn bị xóa).
 * Chế độ demo không làm gì.
 */
export async function signOutSession(
  session: Pick<AuthenticatedSession, 'refreshToken'> | null | undefined,
  opts: CognitoLiveOptions = {},
): Promise<void> {
  if (IS_DEMO_AUTH_MODE && !opts.region && !opts.clientId) return;
  if (!session?.refreshToken) return;
  const config = liveIdpConfig(opts);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await callCognito('RevokeToken', { Token: session.refreshToken }, config);
      return;
    } catch (error) {
      const retryable = error instanceof CognitoIdpError &&
        (error.code === 'NETWORK_ERROR' || error.code === 'TooManyRequestsException' || (error.httpStatus ?? 0) >= 500);
      if (!retryable || attempt === 2) return;
      await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
    }
  }
}

/** Apply a refresh result only while the session that requested it is still current. */
export async function applySessionRefresh(
  refresh: Promise<AuthenticatedSession>,
  isCurrent: () => boolean,
  onRefresh: (session: AuthenticatedSession) => void,
  onFailure: () => void,
): Promise<void> {
  const next = await refresh.catch(() => null);
  if (!isCurrent()) return;
  if (next) onRefresh(next);
  else onFailure();
}

/** Gọi REST API Console bằng ID token của phiên; lỗi chuyển thành `ConsoleAuthError` theo Bảng 2.10. */
async function liveConsoleApi(
  path: string,
  init: { method: 'GET' | 'POST'; body?: Record<string, unknown> },
  idToken: string | undefined,
  opts: CognitoLiveOptions = {},
): Promise<Record<string, unknown>> {
  if (!idToken) {
    throw new ConsoleAuthError('UNAUTHORIZED', 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.', undefined, 401);
  }
  const base = (opts.baseUrl ?? envApiBaseUrl).replace(/\/+$/, '');
  if (!base && !opts.fetchFn) {
    throw new ConsoleAuthError('NETWORK_ERROR', 'Chưa cấu hình địa chỉ API (VITE_API_BASE_URL).');
  }
  const doFetch = opts.fetchFn ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  let res: Response;
  try {
    res = await doFetch(`${base}${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${idToken}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch {
    throw new ConsoleAuthError('NETWORK_ERROR', 'Không kết nối được tới máy chủ.');
  }
  let data: Record<string, unknown> = {};
  try {
    const parsed = (await res.json()) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
  } catch {
    data = {};
  }
  if (!res.ok) {
    const extracted = extractApiErrorPayload(data, res.status);
    throw new ConsoleAuthError(extracted.code, extracted.message, extracted.requestId, extracted.httpStatus);
  }
  return data;
}

const LIVE_MEMBER_ROLES: readonly ConsoleRole[] = ['TENANT_ADMIN', 'DEVELOPER', 'REVIEWER'];
const LIVE_MEMBER_STATUSES: readonly TenantMember['status'][] = ['ACTIVE', 'PENDING_FIRST_LOGIN', 'DISABLED'];

function liveMemberRole(raw: unknown): ConsoleRole | null {
  if (typeof raw !== 'string') return null;
  const upper = raw.trim().toUpperCase().replace(/\s+/g, '_');
  return (LIVE_MEMBER_ROLES as readonly string[]).includes(upper) ? (upper as ConsoleRole) : normalizeRole(raw);
}

/** Chuẩn hóa bản ghi MEMBER (`userSub`, `email`, `role`, `status`, `createdAt`) từ `GET /console/members`. */
function liveTenantMember(item: unknown, fallbackTenantId: string): TenantMember | null {
  if (!item || typeof item !== 'object') return null;
  const r = item as Record<string, unknown>;
  const id = String(r.userSub ?? r.sub ?? r.id ?? '').trim();
  const email = String(r.email ?? '').trim();
  const role = liveMemberRole(r.role);
  if (!id || !email || !role) return null;
  const rawStatus = typeof r.status === 'string' ? r.status.trim().toUpperCase() : '';
  const status = (LIVE_MEMBER_STATUSES as readonly string[]).includes(rawStatus)
    ? (rawStatus as TenantMember['status'])
    : 'ACTIVE';
  const invitedAt = typeof r.createdAt === 'string' ? r.createdAt : typeof r.invitedAt === 'string' ? r.invitedAt : undefined;
  return {
    id,
    tenantId: String(r.tenantId ?? r.tenant_id ?? fallbackTenantId),
    email,
    role,
    status,
    ...(invitedAt ? { invitedAt } : {}),
  };
}

async function liveListTenantMembers(
  tenantId: string,
  idToken: string | undefined,
  opts: CognitoLiveOptions = {},
): Promise<TenantMember[]> {
  const data = await liveConsoleApi('/console/members', { method: 'GET' }, idToken, opts);
  const items = Array.isArray(data.items) ? data.items : [];
  return items.map((it) => liveTenantMember(it, tenantId)).filter((m): m is TenantMember => m !== null);
}

async function liveInviteTenantMember(
  email: string,
  invitedRole: 'DEVELOPER' | 'REVIEWER',
  tenantId: string,
  idToken: string | undefined,
  opts: CognitoLiveOptions = {},
): Promise<{ member: TenantMember; temporaryPassword: string }> {
  const data = await liveConsoleApi('/console/members/invite', { method: 'POST', body: { email, role: invitedRole } }, idToken, opts);
  const userStatus = typeof data.userStatus === 'string' ? data.userStatus : '';
  return {
    member: {
      id: String(data.userSub ?? data.username ?? email),
      tenantId: String(data.tenantId ?? tenantId),
      email: String(data.email ?? email),
      role: liveMemberRole(data.role) ?? invitedRole,
      status: userStatus && userStatus !== 'FORCE_CHANGE_PASSWORD' ? 'ACTIVE' : 'PENDING_FIRST_LOGIN',
      invitedAt: new Date().toISOString(),
    },
    // Cognito tự gửi mật khẩu tạm thời qua email mời; Web Console không bao giờ nhận được mật khẩu này.
    temporaryPassword: '',
  };
}

/** Bộ hàm chế độ Cognito thật, xuất ra để kiểm thử với `fetchFn` giả (không phụ thuộc `VITE_AUTH_MODE`). */
export const cognitoLive = Object.freeze({
  registerAccount: liveRegisterAccount,
  confirmEmail: liveConfirmEmail,
  signIn: liveSignIn,
  completeInvitedPassword: liveCompleteInvitedPassword,
  refreshSession: liveRefreshSession,
  resendConfirmationCode: async (email: string, opts: CognitoLiveOptions = {}) => {
    await liveIdp('ResendConfirmationCode', { Username: email }, opts);
    return { expiresInSeconds: 60 };
  },
  requestPasswordReset: async (email: string, opts: CognitoLiveOptions = {}) => {
    await liveIdp('ForgotPassword', { Username: email }, opts);
    return { email, expiresInSeconds: 60, demoResetCode: '' };
  },
  confirmPasswordReset: async (email: string, code: string, newPassword: string, opts: CognitoLiveOptions = {}) => {
    await liveIdp('ConfirmForgotPassword', { Username: email, ConfirmationCode: code, Password: newPassword }, opts);
  },
  listTenantMembers: liveListTenantMembers,
  inviteTenantMember: liveInviteTenantMember,
});
