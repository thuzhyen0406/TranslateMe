import { AppError, keys, type Ctx, type Role } from '../../../libs/common/types.js';
import { db } from '../../../libs/common/db.js';
import { ROLES, roleFromClaim } from '../../../libs/common/roles.js';

type Claims = Record<string, unknown>;

type MemberReader = Pick<typeof db, 'get'>;

function memberRole(value: unknown): Role | null {
  if (
    value === ROLES.TENANT_ADMIN ||
    value === ROLES.DEVELOPER ||
    value === ROLES.REVIEWER
  ) {
    return value;
  }
  return roleFromClaim(value);
}

export async function contextFromIdTokenClaims(
  claims: Claims,
  requestId: string,
  deps?: { db?: MemberReader },
): Promise<Ctx> {
  const sub = claims.sub;
  const tenantId = claims['custom:tenant_id'] ?? claims.tenant_id;
  const rawRole = claims['custom:role'] ?? claims.role;
  const role = memberRole(rawRole);

  if (
    typeof sub !== 'string' ||
    !sub ||
    typeof tenantId !== 'string' ||
    !tenantId ||
    tenantId === 'PLATFORM'
  ) {
    throw new AppError('UNAUTHORIZED', 'Thông tin đăng nhập không hợp lệ');
  }

  if (!role) {
    throw new AppError('PERMISSION_DENIED', 'Vai trò không được phép');
  }

  const ctx: Ctx = {
    tenantId: String(tenantId),
    via: 'JWT',
    requestId,
    sub,
    role,
  };

  await requireActiveMember(ctx, deps?.db ?? db);

  return ctx;
}

/** Đọc MEMBER hiện hành theo tenant/sub; input là Ctx JWT và DB tùy chọn, output void hoặc PERMISSION_DENIED. */
export async function requireActiveMember(
  ctx: Ctx,
  memberDb: MemberReader = db,
): Promise<void> {
  if (!ctx.sub || !ctx.role) {
    throw new AppError('PERMISSION_DENIED', 'Không xác định được thành viên hiện tại.');
  }
  const member = await memberDb.get(
    ctx,
    keys.member(ctx, ctx.sub),
    { consistent: true },
  );

  if (
    !member ||
    member.status !== 'ACTIVE' ||
    (member.tenantId !== undefined && member.tenantId !== ctx.tenantId) ||
    (member.userSub !== undefined && member.userSub !== ctx.sub) ||
    memberRole(member.role) !== ctx.role
  ) {
    throw new AppError(
      'PERMISSION_DENIED',
      'Tài khoản không còn quyền hoạt động trong tenant',
    );
  }
}
