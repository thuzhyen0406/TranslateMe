export const ROLES = Object.freeze({
    TENANT_ADMIN: 'TENANT_ADMIN',
    DEVELOPER: 'DEVELOPER',
    REVIEWER: 'REVIEWER',
});
/** Chỉ cho phép mời thành viên với 2 vai trò này (không cho tạo Tenant Admin hay Platform Admin qua inviteMember). */
export const INVITABLE_ROLES = Object.freeze([ROLES.DEVELOPER, ROLES.REVIEWER]);
/** Kiểm tra một chuỗi bất kỳ có phải là vai trò được phép mời hay không. */
export function isInvitableRole(role) {
    return typeof role === 'string' && INVITABLE_ROLES.includes(role);
}
/** Tên nhóm Cognito dành riêng cho quản trị viên nền tảng (không gắn với tenant nào). */
export const PLATFORM_ADMIN_GROUP = 'PlatformAdmins';
/** Tên thuộc tính tùy chỉnh trên Cognito User Pool (lưu ý: không sửa/xóa được sau khi tạo). */
export const COGNITO_CUSTOM_ATTRIBUTES = Object.freeze({
    TENANT_ID: 'custom:tenant_id',
    ROLE: 'custom:role',
});
const CLAIM_TO_ROLE = {
    tenant_admin: ROLES.TENANT_ADMIN,
    developer: ROLES.DEVELOPER,
    reviewer: ROLES.REVIEWER,
};
const ROLE_TO_CLAIM = {
    TENANT_ADMIN: 'tenant_admin',
    DEVELOPER: 'developer',
    REVIEWER: 'reviewer',
};
export function roleFromClaim(value) {
    if (typeof value !== 'string')
        return null;
    return CLAIM_TO_ROLE[value] ?? null;
}
export function claimForRole(role) {
    return ROLE_TO_CLAIM[role];
}
