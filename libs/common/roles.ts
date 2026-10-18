/**
 * Hằng số vai trò (Role) và trạng thái dùng chung cho Cognito Trigger, Authorizer và REST API.
 *
 * TODO(nhóm - xác nhận với TV3): Thống nhất chính xác giá trị chuỗi của ROLES với TV3
 * vì Lambda Authorizer và tầng API sẽ đọc trực tiếp `custom:role` / Cognito Group theo đúng các chuỗi này.
 */

export const ROLES = Object.freeze({
  TENANT_ADMIN: 'Tenant Admin',
  DEVELOPER: 'Developer',
  REVIEWER: 'Reviewer',
  PLATFORM_ADMIN: 'Platform Admin',
} as const);

export type Role = (typeof ROLES)[keyof typeof ROLES];

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
