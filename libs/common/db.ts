import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { Ctx, AppError, keys, type Role } from './types.js';

const client = new DynamoDBClient({});
const TABLE_NAME = process.env.TABLE_NAME || 'translate-data';

function toAttrValue(val: unknown): AttributeValue {
  if (val === null || val === undefined) return { NULL: true };
  if (typeof val === 'string') return { S: val };
  if (typeof val === 'number') return { N: String(val) };
  if (typeof val === 'boolean') return { BOOL: val };
  if (Array.isArray(val)) return { L: val.map((item) => toAttrValue(item)) };
  if (typeof val === 'object') {
    const m: Record<string, AttributeValue> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (v !== undefined) {
        m[k] = toAttrValue(v);
      }
    }
    return { M: m };
  }
  return { S: String(val) };
}

function marshallRecord(obj: Record<string, unknown>): Record<string, AttributeValue> {
  const out: Record<string, AttributeValue> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) {
      out[k] = toAttrValue(v);
    }
  }
  return out;
}

function fromAttrValue(attr: AttributeValue): unknown {
  if ('S' in attr && attr.S !== undefined) return attr.S;
  if ('N' in attr && attr.N !== undefined) return Number(attr.N);
  if ('BOOL' in attr && attr.BOOL !== undefined) return attr.BOOL;
  if ('NULL' in attr && attr.NULL) return null;
  if ('L' in attr && attr.L !== undefined) return attr.L.map((item) => fromAttrValue(item));
  if ('M' in attr && attr.M !== undefined) return unmarshallRecord(attr.M);
  return undefined;
}

function unmarshallRecord(item: Record<string, AttributeValue>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(item)) {
    out[k] = fromAttrValue(v);
  }
  return out;
}

// Kiểm tra bảo mật cô lập tenant (B.1, B.3 & B.5 Phần B):
// Cho phép PK = "TENANT#<tenantId>" hoặc "TENANT#<tenantId>#<PHAN_CON>" (như TENANT#<t>#GLOSS, TENANT#<t>#TM#...),
// nhưng từ chối tuyệt đối mọi tenant khác (kể cả khi tenantId là tiền tố của một tenantId khác như tenant-1 vs tenant-10).
function assertTenantAccess(ctx: Ctx, key: { PK: string }) {
  const allowedPrefix = `TENANT#${ctx.tenantId}`;
  if (key.PK !== allowedPrefix && !key.PK.startsWith(`${allowedPrefix}#`)) {
    throw new AppError(
      'FORBIDDEN',
      `Bị từ chối: Ctx Tenant (${ctx.tenantId}) không có quyền truy cập PK (${key.PK})`,
    );
  }
}

/** Kiểm tra vai trò theo ma trận quyền ở máy chủ (B.5 & B.6 Phần B). */
export function requireRole(ctx: Ctx, allowed: readonly Role[]): void {
  if (!ctx.role || !allowed.includes(ctx.role)) {
    throw new AppError(
      'PERMISSION_DENIED',
      `Vai trò ${ctx.role ?? 'NONE'} không được phép thực hiện thao tác này`,
    );
  }
}

export const db = {
  async get(ctx: Ctx, key: { PK: string; SK: string }) {
    assertTenantAccess(ctx, key);
    const res = await client.send(
      new GetItemCommand({
        TableName: TABLE_NAME,
        Key: marshallRecord(key),
      }),
    );
    return res.Item ? unmarshallRecord(res.Item) : null;
  },

  async put(ctx: Ctx, item: Record<string, any>, conditionExpression?: string) {
    assertTenantAccess(ctx, { PK: item.PK });
    await client.send(
      new PutItemCommand({
        TableName: TABLE_NAME,
        Item: marshallRecord(item),
        ConditionExpression: conditionExpression,
      }),
    );
  },

  async query(ctx: Ctx, pk: string, skPrefix?: string) {
    assertTenantAccess(ctx, { PK: pk });
    let expr = 'PK = :pk';
    const values: Record<string, unknown> = { ':pk': pk };

    if (skPrefix) {
      expr += ' AND begins_with(SK, :skPrefix)';
      values[':skPrefix'] = skPrefix;
    }

    const res = await client.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: expr,
        ExpressionAttributeValues: marshallRecord(values),
      }),
    );
    return (res.Items || []).map((item) => unmarshallRecord(item));
  },

  async transact(ctx: Ctx, ops: any[]) {
    // Đảm bảo mọi tác vụ trong transaction thuộc tenant (trừ thao tác tạo SLUG hệ thống)
    for (const op of ops) {
      const item = op.Put?.Item || op.Delete?.Key || op.Update?.Key;
      if (item && !item.PK.startsWith('TENANT#PLATFORM#SLUG#')) {
        assertTenantAccess(ctx, { PK: item.PK });
      }
    }
    const marshalledOps = ops.map((op) => {
      if (op.Put) {
        return {
          Put: {
            ...op.Put,
            Item: marshallRecord(op.Put.Item),
            ...(op.Put.ExpressionAttributeValues
              ? { ExpressionAttributeValues: marshallRecord(op.Put.ExpressionAttributeValues) }
              : {}),
          },
        };
      }
      if (op.Delete) {
        return {
          Delete: {
            ...op.Delete,
            Key: marshallRecord(op.Delete.Key),
          },
        };
      }
      if (op.Update) {
        return {
          Update: {
            ...op.Update,
            Key: marshallRecord(op.Update.Key),
            ...(op.Update.ExpressionAttributeValues
              ? { ExpressionAttributeValues: marshallRecord(op.Update.ExpressionAttributeValues) }
              : {}),
          },
        };
      }
      return op;
    });
    await client.send(new TransactWriteItemsCommand({ TransactItems: marshalledOps }));
  },
};

// Resolver phân giải Tenant từ Slug (Đảm bảo ConsistentRead = true theo B.5)
export async function resolveFromSlug(
  slug: string,
): Promise<{ ctx: Ctx; host: any; config: any } | null> {
  const slugKey = keys.slug(slug);
  const slugRes = await client.send(
    new GetItemCommand({
      TableName: TABLE_NAME,
      Key: marshallRecord(slugKey),
      ConsistentRead: true, // Bắt buộc đọc nhất quán để đọc ngay sau khi xác minh
    }),
  );

  if (!slugRes.Item) return null;
  const unmarshalledSlug = unmarshallRecord(slugRes.Item);
  const tenantId = unmarshalledSlug.tenantId;

  const ctx: Ctx = { tenantId, via: 'SLUG', requestId: 'internal', slug };
  const host = await db.get(ctx, keys.host(ctx, slug));
  const config = await db.get(ctx, keys.config(ctx));

  if (config?.status === 'LOCKED') {
    throw new AppError('TENANT_SUSPENDED', 'Tenant hiện đang bị khóa');
  }

  return { ctx, host, config };
}
