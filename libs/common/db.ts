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

// Kiểm tra bảo mật cô lập tenant (B.1 & B.5 Phần B):
// Cho phép PK === "TENANT#<t>" hoặc bắt đầu bằng "TENANT#<t>#", chặn truy cập chéo (kể cả tenant-1 vs tenant-10).
function assertTenantAccess(ctx: Ctx, key: { PK: string }) {
  const allowedPrefix = `TENANT#${ctx.tenantId}`;
  if (key.PK !== allowedPrefix && !key.PK.startsWith(`${allowedPrefix}#`)) {
    throw new AppError('FORBIDDEN', `Bị từ chối: Ctx Tenant (${ctx.tenantId}) không có quyền truy cập PK (${key.PK})`);
  }
}

/** Kiểm tra vai trò theo ma trận quyền ở máy chủ (B.5 Phần B: ném FORBIDDEN). */
export function requireRole(ctx: Ctx, allowed: readonly Role[]): void {
  if (!ctx.role || !allowed.includes(ctx.role)) {
    throw new AppError('FORBIDDEN', `Vai trò ${ctx.role ?? 'NONE'} không được phép thực hiện thao tác này`);
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

  async transact(ctx: Ctx, ops: any[]) {
    // Đảm bảo mọi tác vụ trong transaction thuộc tenant (trừ thao tác tạo SLUG hệ thống)
    for (const op of ops) {
      const item = op.Put?.Item || op.Delete?.Key || op.Update?.Key || op.ConditionCheck?.Key;
      if (item && !item.PK.startsWith('TENANT#PLATFORM#SLUG#')) {
        assertTenantAccess(ctx, { PK: item.PK });
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
