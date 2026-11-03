import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
  TransactWriteCommand,
  BatchGetCommand,
} from '@aws-sdk/lib-dynamodb';
import { Ctx, AppError, keys, type Role } from './types.js';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.TABLE_NAME || 'translate-data';

function assertTenantAccess(ctx: Ctx, key: { PK: string }): void {
  const tenantId = ctx.tenantId;
  const base = `TENANT#${tenantId}`;

  if (
    !tenantId ||
    tenantId === 'PLATFORM' ||
    (key.PK !== base && !key.PK.startsWith(`${base}#`))
  ) {
    throw new AppError('NOT_FOUND', 'Không tìm thấy tài nguyên');
  }
}

/** Kiểm tra vai trò theo ma trận quyền ở máy chủ. */
export function requireRole(ctx: Ctx, allowed: readonly Role[]): void {
  if (!ctx.role || !allowed.includes(ctx.role)) {
    throw new AppError(
      'PERMISSION_DENIED',
      'Vai trò không được phép thực hiện thao tác này',
    );
  }
}

export const db = {
  async get(ctx: Ctx, key: { PK: string; SK: string }, opts?: { consistent?: boolean }) {
    assertTenantAccess(ctx, key);
    const res = await docClient.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: key,
        ...(opts?.consistent ? { ConsistentRead: true } : {}),
      }),
    );
    return res.Item || null;
  },

  async put(ctx: Ctx, item: Record<string, any>, conditionExpression?: string) {
    assertTenantAccess(ctx, { PK: item.PK });
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: item,
      ConditionExpression: conditionExpression,
    }));
  },

  async update(
    ctx: Ctx,
    params: {
      Key: { PK: string; SK: string };
      UpdateExpression: string;
      ConditionExpression?: string;
      ExpressionAttributeNames?: Record<string, string>;
      ExpressionAttributeValues?: Record<string, any>;
    },
  ) {
    assertTenantAccess(ctx, params.Key);
    await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: params.Key,
        UpdateExpression: params.UpdateExpression,
        ConditionExpression: params.ConditionExpression,
        ExpressionAttributeNames: params.ExpressionAttributeNames,
        ExpressionAttributeValues: params.ExpressionAttributeValues,
      }),
    );
  },

  async query(ctx: Ctx, pk: string, skPrefix?: string, opts?: { consistent?: boolean }) {
    assertTenantAccess(ctx, { PK: pk });
    let expr = 'PK = :pk';
    const values: Record<string, any> = { ':pk': pk };

    if (skPrefix) {
      expr += ' AND begins_with(SK, :skPrefix)';
      values[':skPrefix'] = skPrefix;
    }

    const allItems: Record<string, any>[] = [];
    let exclusiveStartKey: Record<string, any> | undefined;

    do {
      const res = await docClient.send(
        new QueryCommand({
          TableName: TABLE_NAME,
          KeyConditionExpression: expr,
          ExpressionAttributeValues: values,
          ...(opts?.consistent ? { ConsistentRead: true } : {}),
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        }),
      );
      if (res.Items) {
        allItems.push(...res.Items);
      }
      exclusiveStartKey = res.LastEvaluatedKey;
    } while (exclusiveStartKey);

    return allItems;
  },

  async updateTenantStatus(ctx: Ctx, tenantId: string, status: 'ACTIVE' | 'LOCKED') {
    if (!tenantId || tenantId === 'PLATFORM' || ctx.tenantId !== tenantId) {
      throw new AppError('NOT_FOUND', 'Không tìm thấy tài nguyên');
    }

    const key = keys.config(ctx);
    try {
      await docClient.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: key,
        UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':status': status,
          ':updatedAt': new Date().toISOString(),
        },
      }));
    } catch (error: any) {
      if (error?.name === 'ConditionalCheckFailedException') {
        throw new AppError('NOT_FOUND', 'Không tìm thấy tài nguyên');
      }
      throw error;
    }
  },

  async updateSiteStatus(
    ctx: Ctx,
    slug: string,
    expectedStatus: 'ACTIVE' | 'PAUSED',
    nextStatus: 'ACTIVE' | 'PAUSED',
  ) {
    const key = keys.host(ctx, slug);
    assertTenantAccess(ctx, key);

    try {
      await docClient.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: key,
        UpdateExpression: 'SET #status = :next, updatedAt = :updatedAt',
        ConditionExpression: 'attribute_exists(PK) AND #status = :expected',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':expected': expectedStatus,
          ':next': nextStatus,
          ':updatedAt': new Date().toISOString(),
        },
      }));
    } catch (error: any) {
      if (error?.name === 'ConditionalCheckFailedException') {
        throw new AppError('VERSION_CONFLICT', 'Trạng thái website đã thay đổi');
      }
      throw error;
    }
  },

  async listTenantSites(ctx: Ctx): Promise<Array<Record<string, any>>> {
    return db.query(ctx, `TENANT#${ctx.tenantId}`, 'HOST#', { consistent: true });
  },

  async transact(
    ctx: Ctx,
    ops: any[],
    options?: { platformSlugReservation?: boolean },
  ) {
    for (const op of ops) {
      const item = op.Put?.Item || op.Delete?.Key || op.Update?.Key || op.ConditionCheck?.Key;
      const isPlatformSlug =
        options?.platformSlugReservation === true &&
        item?.PK?.startsWith('TENANT#PLATFORM#SLUG#');

      if (item && !isPlatformSlug) {
        assertTenantAccess(ctx, { PK: item.PK });
      } else if (isPlatformSlug) {
        if (
          !ctx.tenantId ||
          ctx.tenantId === 'PLATFORM' ||
          item.tenantId !== ctx.tenantId
        ) {
          throw new AppError('NOT_FOUND', 'Không tìm thấy tài nguyên');
        }
      }
    }
    await docClient.send(new TransactWriteCommand({ TransactItems: ops }));
  },
};

// Resolver phân giải Tenant từ Slug (Đảm bảo ConsistentRead = true theo B.5)
export async function resolveFromSlug(slug: string): Promise<{ ctx: Ctx; host: any; config: any } | null> {
  const slugKey = keys.slug(slug);
  const slugRes = await docClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: slugKey,
    ConsistentRead: true, // Bắt buộc đọc nhất quán để đọc ngay sau khi xác minh
  }));

  if (!slugRes.Item) return null;
  const tenantId = slugRes.Item.tenantId;

  const ctx: Ctx = { tenantId, via: 'SLUG', requestId: 'internal', slug };
  const host = await db.get(ctx, keys.host(ctx, slug));
  const config = await db.get(ctx, keys.config(ctx));

  if (config?.status === 'LOCKED') {
    throw new AppError('TENANT_SUSPENDED', 'Tenant hiện đang bị khóa');
  }

  return { ctx, host, config };
}
