/**
 * Hàm mời thành viên vào Tenant trên Cognito User Pool (Nhiệm vụ 1.11 - Mục C).
 *
 * Trách nhiệm của hàm này:
 *  - Tạo user trên Cognito với mật khẩu tạm đủ mạnh,
 *    gán ngay `custom:tenant_id`, `custom:role`, đánh dấu `email_verified = "true"`,
 *    để Cognito tự gửi email mời và đặt trạng thái `FORCE_CHANGE_PASSWORD`.
 *  - Ghi bản ghi MEMBER theo Cognito `sub` để các lần đăng nhập sau xác thực được thành viên.
 *  - Chỉ cho phép vai trò `Developer` hoặc `Reviewer` (từ chối `Tenant Admin`, `Platform Admin` hoặc chuỗi lạ).
 */

import { randomInt } from 'node:crypto';
import {
  AdminCreateUserCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { db } from '../../../libs/common/db.js';
import {
  COGNITO_CUSTOM_ATTRIBUTES,
  INVITABLE_ROLES,
  claimForRole,
  isInvitableRole,
  type InvitableRole,
} from '../../../libs/common/roles.js';
import { keys, type Ctx } from '../../../libs/common/types.js';

export interface CognitoAdminCreateClient {
  send(command: AdminCreateUserCommand): Promise<{
    User?: {
      Username?: string;
      UserStatus?: string;
      Attributes?: Array<{ Name?: string; Value?: string }>;
    };
  }>;
}

export interface InviteMemberDeps {
  cognitoClient?: CognitoAdminCreateClient;
  db?: Pick<typeof db, 'put'>;
  userPoolId?: string;
  tempPasswordGenerator?: () => string;
  now?: () => Date;
  requestId?: string;
}

export interface InviteMemberResult {
  username: string;
  userSub: string;
  userStatus?: string;
  tenantId: string;
  email: string;
  role: InvitableRole;
}

const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const DIGITS = '23456789';
const SYMBOLS = '!@#$%^&*_-+=';
const ALL_CHARS = UPPER + LOWER + DIGITS + SYMBOLS;

/**
 * Sinh mật khẩu tạm ngẫu nhiên mật mã học (16 ký tự), luôn thỏa chính sách mật khẩu của User Pool:
 * tối thiểu 8 ký tự, có chữ hoa, chữ thường, chữ số (và ký tự đặc biệt).
 */
export function generateTemporaryPassword(length = 16): string {
  const safeLen = Math.max(12, length);
  const picks: string[] = [
    UPPER[randomInt(UPPER.length)],
    LOWER[randomInt(LOWER.length)],
    DIGITS[randomInt(DIGITS.length)],
    SYMBOLS[randomInt(SYMBOLS.length)],
  ];
  while (picks.length < safeLen) {
    picks.push(ALL_CHARS[randomInt(ALL_CHARS.length)]);
  }
  // Xáo trộn Fisher–Yates bằng CSPRNG để vị trí các nhóm ký tự không cố định
  for (let i = picks.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    const tmp = picks[i];
    picks[i] = picks[j];
    picks[j] = tmp;
  }
  return picks.join('');
}

let defaultCognitoClient: CognitoIdentityProviderClient | undefined;
function getDefaultCognitoClient(): CognitoIdentityProviderClient {
  if (!defaultCognitoClient) defaultCognitoClient = new CognitoIdentityProviderClient({});
  return defaultCognitoClient;
}

/**
 * Mời thành viên mới vào tenant thông qua Cognito `AdminCreateUser`.
 *
 * @param tenantId Mã tenant của người mời (không được rỗng)
 * @param email    Địa chỉ email của thành viên được mời
 * @param role     Vai trò được mời (chỉ chấp nhận `DEVELOPER` hoặc `REVIEWER`)
 * @param deps     Tham số tùy chọn để tiêm Cognito, DB, thời gian và request ID khi test
 */
export async function inviteMember(
  tenantId: string,
  email: string,
  role: string,
  deps: InviteMemberDeps = {},
): Promise<InviteMemberResult> {
  const cleanTenantId = typeof tenantId === 'string' ? tenantId.trim() : '';
  if (!cleanTenantId) {
    throw new Error('tenantId không hợp lệ');
  }

  const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    throw new Error('Email không hợp lệ');
  }

  // Bảo mật phân quyền: chỉ cho phép mời Developer hoặc Reviewer; chặn leo thang lên Tenant Admin / Platform Admin.
  if (!isInvitableRole(role)) {
    throw new Error(
      `Role không hợp lệ khi mời thành viên: "${String(role)}". Chỉ chấp nhận: ${INVITABLE_ROLES.join(', ')}`,
    );
  }

  const userPoolId = (deps.userPoolId ?? process.env.USER_POOL_ID ?? '').trim();
  if (!userPoolId) {
    throw new Error('Thiếu cấu hình biến môi trường USER_POOL_ID');
  }

  const temporaryPassword = (deps.tempPasswordGenerator ?? generateTemporaryPassword)();
  const cognito = deps.cognitoClient ?? getDefaultCognitoClient();

  // Không đặt MessageAction = 'SUPPRESS' để Cognito tự động gửi email mời kèm mật khẩu tạm;
  // User tạo qua AdminCreateUser sẽ tự động ở trạng thái FORCE_CHANGE_PASSWORD ở lần đăng nhập đầu.
  const output = await cognito.send(
    new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: cleanEmail,
      TemporaryPassword: temporaryPassword,
      DesiredDeliveryMediums: ['EMAIL'],
      UserAttributes: [
        { Name: 'email', Value: cleanEmail },
        { Name: 'email_verified', Value: 'true' },
        { Name: COGNITO_CUSTOM_ATTRIBUTES.TENANT_ID, Value: cleanTenantId },
        { Name: COGNITO_CUSTOM_ATTRIBUTES.ROLE, Value: claimForRole(role) },
      ],
    }),
  );

  const userSub = output.User?.Attributes?.find((a) => a.Name === 'sub')?.Value?.trim();
  if (!userSub) {
    throw new Error('Cognito không trả về sub; không thể tạo bản ghi MEMBER');
  }

  const memberCtx: Ctx = {
    tenantId: cleanTenantId,
    via: 'JWT',
    requestId: deps.requestId ?? 'invite-member',
  };
  await (deps.db ?? db).put(
    memberCtx,
    {
      ...keys.member(memberCtx, userSub),
      tenantId: cleanTenantId,
      userSub,
      email: cleanEmail,
      role,
      status: 'ACTIVE',
      createdAt: (deps.now ?? (() => new Date()))().toISOString(),
    },
    'attribute_not_exists(PK) AND attribute_not_exists(SK)',
  );

  return {
    username: output.User?.Username ?? cleanEmail,
    userSub,
    userStatus: output.User?.UserStatus,
    tenantId: cleanTenantId,
    email: cleanEmail,
    role,
  };
}
