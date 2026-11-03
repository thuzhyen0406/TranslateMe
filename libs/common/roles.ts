import type { Role } from './types.js';

export const ROLES = Object.freeze({
  TENANT_ADMIN: 'TENANT_ADMIN',
  DEVELOPER: 'DEVELOPER',
  REVIEWER: 'REVIEWER',
} as const);

/** Chỉ cho phép mời thành viên với 2 vai trò này (không cho tạo Tenant Admin hay Platform Admin qua inviteMember). */
export const INVITABLE_ROLES = Object.freeze([ROLES.DEVELOPER, ROLES.REVIEWER] as const);

export type InvitableRole = (typeof INVITABLE_ROLES)[number];

/** Kiểm tra một chuỗi bất kỳ có phải là vai trò được phép mời hay không. */
export function isInvitableRole(role: unknown): role is InvitableRole {
  return typeof role === 'string' && (INVITABLE_ROLES as readonly string[]).includes(role);
}

/** Tên nhóm Cognito dành riêng cho quản trị viên nền tảng (không gắn với tenant nào). */
export const PLATFORM_ADMIN_GROUP = 'PlatformAdmins';

/** Tên thuộc tính tùy chỉnh trên Cognito User Pool (lưu ý: không sửa/xóa được sau khi tạo). */
export const COGNITO_CUSTOM_ATTRIBUTES = Object.freeze({
  TENANT_ID: 'custom:tenant_id',
  ROLE: 'custom:role',
} as const);

const CLAIM_TO_ROLE: Record<string, Role> = {
  tenant_admin: ROLES.TENANT_ADMIN,
  developer: ROLES.DEVELOPER,
  reviewer: ROLES.REVIEWER,
  'Tenant Admin': ROLES.TENANT_ADMIN,
  Developer: ROLES.DEVELOPER,
  Reviewer: ROLES.REVIEWER,
};

const ROLE_TO_CLAIM: Record<Role, string> = {
  TENANT_ADMIN: 'tenant_admin',
  DEVELOPER: 'developer',
  REVIEWER: 'reviewer',
};

export function roleFromClaim(value: unknown): Role | null {
  if (typeof value !== 'string') return null;
  return CLAIM_TO_ROLE[value] ?? null;
}

export function claimForRole(role: Role): string {
  return ROLE_TO_CLAIM[role];
}
