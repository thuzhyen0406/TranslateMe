import { AppError, keys, type Ctx, type Role } from '../../../libs/common/types.js';
import { db } from '../../../libs/common/db.js';
import { roleFromClaim } from '../../../libs/common/roles.js';

type Claims = Record<string, unknown>;

function memberRole(value: unknown): Role | null {
  if (typeof value !== 'string') return null;

  const normalized = value.trim().toUpperCase().replace(/\s+/g, '_');
  switch (normalized) {
    case 'TENANT_ADMIN':
      return 'TENANT_ADMIN';
    case 'DEVELOPER':
      return 'DEVELOPER';
    case 'REVIEWER':
      return 'REVIEWER';
    default:
      return roleFromClaim(value);
  }
}

export async function contextFromIdTokenClaims(
  claims: Claims,
  requestId: string,
): Promise<Ctx> {
  const sub = claims.sub;
  const tenantId = claims['custom:tenant_id'];
  const role = roleFromClaim(claims['custom:role']);

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
    tenantId,
    via: 'JWT',
    requestId,
    role,
  };

  const member = await db.get(
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
