import { AppError, keys, type Ctx, type Role } from '../../../libs/common/types.js';
import { db } from '../../../libs/common/db.js';
import { ROLES, roleFromClaim } from '../../../libs/common/roles.js';

type Claims = Record<string, unknown>;

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
  deps?: { db?: Pick<typeof db, 'get'> },
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
    role,
    sub,
  };

  const dbClient = deps?.db ?? db;
  const member = await dbClient.get(
    ctx,
    keys.member(ctx, sub),
    { consistent: true },
  );

  if (
    !member ||
    member.status !== 'ACTIVE' ||
    memberRole(member.role) !== role
  ) {
    throw new AppError(
      'PERMISSION_DENIED',
      'Tài khoản không còn quyền hoạt động trong tenant',
    );
  }

  return ctx;
}
