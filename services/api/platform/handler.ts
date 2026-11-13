import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { isPlatformAdmin, setTenantStatus, validateTenantId } from './tenantStatus.js';
import { db } from '../../../libs/common/db.js';
import { withCors } from '../../../libs/common/cors.js';
import { AppError, keys, PLATFORM_TENANT_INDEX, type Ctx } from '../../../libs/common/types.js';

type PlatformEvent = {
  httpMethod?: string;
  resource?: string;
  path?: string;
  requestContext: {
    requestId?: string;
    authorizer?: { claims?: Record<string, unknown> };
  };
  pathParameters?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined> | null;
  body?: string | null;
};

const directoryDb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

async function listTenantConfigs(after?: string) {
  const page = await directoryDb.send(new QueryCommand({
    TableName: process.env.TABLE_NAME ?? 'translate-data',
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :directory',
    ExpressionAttributeValues: { ':directory': PLATFORM_TENANT_INDEX },
    ProjectionExpression: 'PK, SK, GSI1PK, GSI1SK, tenantId, organizationName, #plan, #status, createdAt, characterLimit, charLimit',
    ExpressionAttributeNames: { '#plan': 'plan', '#status': 'status' },
    Select: 'SPECIFIC_ATTRIBUTES',
    Limit: 100,
    ...(after ? { ExclusiveStartKey: { PK: `TENANT#${after}`, SK: 'CONFIG', GSI1PK: PLATFORM_TENANT_INDEX, GSI1SK: after } } : {}),
  }));
  return { items: page.Items ?? [], next: page.LastEvaluatedKey?.GSI1SK as string | undefined };
}

export interface PlatformHandlerDeps {
  db: Pick<typeof db, 'get' | 'update'>;
  setStatus: typeof setTenantStatus;
  list: typeof listTenantConfigs;
}

const defaults: PlatformHandlerDeps = { db, setStatus: setTenantStatus, list: listTenantConfigs };

function tenantSummary(tenantId: string, item: Record<string, unknown>) {
  const limit = item.characterLimit ?? item.charLimit;
  const orgName =
    typeof item.organizationName === 'string' && item.organizationName.trim()
      ? item.organizationName.trim()
      : typeof item.organization_name === 'string' && item.organization_name.trim()
        ? item.organization_name.trim()
        : undefined;
  return {
    tenant_id: tenantId,
    ...(orgName ? { organization_name: orgName } : {}),
    ...(typeof item.plan === 'string' ? { plan: item.plan } : {}),
    ...(item.status === 'ACTIVE' || item.status === 'LOCKED' ? { status: item.status } : {}),
    ...(typeof item.createdAt === 'string' ? { created_at: item.createdAt } : {}),
    ...(typeof limit === 'number' && Number.isSafeInteger(limit) && limit >= 0 ? { character_limit: limit } : {}),
  };
}

function parseBody(body: string | null | undefined): Record<string, unknown> {
  let input: unknown;
  try { input = JSON.parse(body ?? '{}'); }
  catch { throw new AppError('INVALID_REQUEST', 'Body không hợp lệ'); }
  if (!input || typeof input !== 'object' || Array.isArray(input) || 'tenantId' in input || 'tenant_id' in input) {
    throw new AppError('INVALID_REQUEST', 'Body không hợp lệ hoặc chứa tenant ID');
  }
  return input as Record<string, unknown>;
}

export function createPlatformHandler(deps: PlatformHandlerDeps = defaults) {
  return async (event: PlatformEvent) => {
    const requestId = event.requestContext.requestId;
    try {
      const claims = event.requestContext.authorizer?.claims;
      if (!claims) throw new AppError('UNAUTHORIZED', 'Cần phiên đăng nhập hợp lệ');
      if (!isPlatformAdmin(claims['cognito:groups'])) {
        throw new AppError('PERMISSION_DENIED', 'Vai trò không được phép thực hiện thao tác này');
      }

      const method = (event.httpMethod ?? 'PATCH').toUpperCase();
      const route = (event.resource ?? event.path ?? '/platform/tenants/{tenantId}/status').replace(/\/$/, '');
      if (method === 'GET' && route === '/platform/tenants') {
        const cursor = event.queryStringParameters?.cursor;
        const page = await deps.list(cursor === undefined ? undefined : validateTenantId(cursor));
        return json(200, {
          items: page.items.map((item) => tenantSummary(validateTenantId(item.GSI1SK), item)),
          ...(page.next === undefined ? {} : { next_cursor: page.next }),
        }, requestId);
      }

      const tenantId = validateTenantId(event.pathParameters?.tenantId);
      const ctx: Ctx = { tenantId, via: 'JWT', requestId: requestId ?? 'platform-admin' };
      if (method === 'GET' && /^\/platform\/tenants\/[^/]+$/.test(route)) {
        const config = await deps.db.get(ctx, keys.config(ctx), { consistent: true });
        if (!config) throw new AppError('NOT_FOUND', 'Không tìm thấy tenant');
        return json(200, tenantSummary(tenantId, config), requestId);
      }

      if (method === 'PATCH' && /^\/platform\/tenants\/[^/]+\/status$/.test(route)) {
        const { status } = parseBody(event.body);
        if (status !== 'ACTIVE' && status !== 'LOCKED') throw new AppError('INVALID_REQUEST', 'status không hợp lệ');
        return json(200, await deps.setStatus(tenantId, status), requestId);
      }
      if (method === 'PATCH' && /^\/platform\/tenants\/[^/]+\/limits$/.test(route)) {
        const { character_limit: limit } = parseBody(event.body);
        if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 0) {
          throw new AppError('INVALID_REQUEST', 'character_limit phải là số nguyên không âm');
        }
        try {
          await deps.db.update(ctx, {
            Key: keys.config(ctx),
            UpdateExpression: 'SET characterLimit = :limit',
            ConditionExpression: 'attribute_exists(PK)',
            ExpressionAttributeValues: { ':limit': limit },
          });
        } catch (error) {
          if ((error as { name?: string })?.name === 'ConditionalCheckFailedException') {
            throw new AppError('NOT_FOUND', 'Không tìm thấy tenant');
          }
          throw error;
        }
        return json(200, { tenant_id: tenantId, character_limit: limit }, requestId);
      }
      throw new AppError('NOT_FOUND', 'Không tìm thấy endpoint');
    } catch (error) {
      const appError = error instanceof AppError ? error : new AppError('INTERNAL_ERROR', 'Lỗi hệ thống');
      const statusCodes: Record<string, number> = {
        UNAUTHORIZED: 401,
        PERMISSION_DENIED: 403,
        TENANT_SUSPENDED: 403,
        CACHE_INVALIDATION_FAILED: 503,
        INVALID_REQUEST: 400,
        NOT_FOUND: 404,
      };
      return json(statusCodes[appError.code] ?? 500, { error: { code: appError.code, message: appError.message } }, requestId);
    }
  };
}

function json(statusCode: number, body: Record<string, unknown>, requestId?: string) {
  return { statusCode, headers, body: JSON.stringify({ request_id: requestId, ...body }) };
}

export const handler = withCors(createPlatformHandler());
