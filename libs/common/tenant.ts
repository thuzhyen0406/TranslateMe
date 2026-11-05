import { AppError, keys, type Ctx } from './types.js';
import { db } from './db.js';

type TenantConfigStore = {
  get: (ctx: Ctx, key: { PK: string; SK: string }, opts?: { consistent?: boolean }) => Promise<any>;
};

export async function assertTenantWritable(
  ctx: Ctx,
  store: TenantConfigStore = db,
): Promise<void> {
  const config = await store.get(
    ctx,
    keys.config(ctx),
    { consistent: true },
  );

  if (!config) {
    throw new AppError('NOT_FOUND', 'Không tìm thấy tài nguyên');
  }

  if (config.status === 'LOCKED') {
    throw new AppError('TENANT_SUSPENDED', 'Tenant đang bị khóa');
  }
}
