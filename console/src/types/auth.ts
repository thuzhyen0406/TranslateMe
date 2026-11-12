/**
 * Kiểu dữ liệu xác thực, phân quyền và điều hướng cho TranslateMe Web Console (Hạng mục 2.9 - Q1).
 * Khớp với Hợp đồng giao diện Phần B (B.2, B.6, B.13) và đặc tả Cognito User Pool (Nhiệm vụ 1.11).
 */

export type ConsoleRole = 'TENANT_ADMIN' | 'DEVELOPER' | 'REVIEWER' | 'PLATFORM_ADMIN';

export type InvitableConsoleRole = 'DEVELOPER' | 'REVIEWER';

export type AuthScreenMode =
  | 'SIGN_UP'
  | 'CONFIRM_EMAIL'
  | 'SIGN_IN'
  | 'FORCE_CHANGE_PASSWORD'
  | 'FORGOT_PASSWORD';

export type ConsoleMenuKey =
  | 'website'
  | 'glossary'
  | 'review'
  | 'usage'
  | 'apikey'
  | 'playground'
  | 'doc-translate'
  | 'members'
  | 'platform-tenants'
  | 'platform-pricing';

export interface ConsoleMenuItem {
  key: ConsoleMenuKey;
  label: string;
  allowedRoles: readonly ConsoleRole[];
}

export type MemberStatus = 'ACTIVE' | 'PENDING_FIRST_LOGIN' | 'DISABLED';

export interface TenantMember {
  id: string;
  tenantId: string;
  email: string;
  role: ConsoleRole;
  status: MemberStatus;
  invitedAt?: string;
}

export interface AuthenticatedSession {
  email: string;
  fullName: string;
  sub: string;
  tenantId: string;
  organizationName: string;
  plan: 'FREE' | 'PRO' | 'BUSINESS';
  role: ConsoleRole;
  idToken: string;
  accessToken: string;
  refreshToken: string;
  tokenRefreshedAt: string;
  /** Trạng thái tenant nếu đã biết (GET /console/me); LOCKED -> giao diện chỉ xem */
  tenantStatus?: 'ACTIVE' | 'LOCKED';
}

export interface SignUpFormInput {
  fullName: string;
  email: string;
  password: string;
  organizationName: string;
  acceptedTerms: boolean;
}

export interface ConfirmEmailInput {
  email: string;
  code: string;
  password?: string;
  organizationName?: string;
  fullName?: string;
}

export interface SignInFormInput {
  email: string;
  password: string;
}

export interface ForceChangePasswordInput {
  email: string;
  temporaryPassword: string;
  newPassword: string;
  confirmNewPassword: string;
  challengeSession?: string;
  organizationName?: string;
  invitedRole?: InvitableConsoleRole;
}

export interface ConfirmForgotPasswordInput {
  email: string;
  code: string;
  newPassword: string;
  confirmNewPassword: string;
}

export type SignInOutcome =
  | {
      status: 'AUTHENTICATED';
      session: AuthenticatedSession;
    }
  | {
      status: 'NEW_PASSWORD_REQUIRED';
      email: string;
      challengeSession: string;
      organizationName: string;
      invitedRole: InvitableConsoleRole;
    }
  | {
      status: 'CONFIRMATION_REQUIRED';
      email: string;
      organizationName: string;
    };
