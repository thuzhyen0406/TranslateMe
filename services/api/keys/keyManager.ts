/**
 * Quản lý API key và gói API của tenant.
 * File này tạo, liệt kê, xoay, thu hồi key và chuyển key giữa Usage Plan Basic/Standard.
 * Mã key bí mật chỉ được trả ở phản hồi tạo/xoay; DynamoDB chỉ giữ keyId và bốn ký tự cuối.
 * Mọi thao tác yêu cầu Ctx JWT có role phù hợp và ghi APIKEY/KEYMAP qua lớp data dùng chung.
 */
import {
  APIGatewayClient,
  CreateApiKeyCommand,
  CreateUsagePlanKeyCommand,
  DeleteApiKeyCommand,
  DeleteUsagePlanKeyCommand,
  UpdateApiKeyCommand,
} from '@aws-sdk/client-api-gateway';
import { db, requireRole } from '../../../libs/common/db.js';
import { AppError, keys, type Ctx } from '../../../libs/common/types.js';

export type ApiKeyPlan = 'Basic' | 'Standard';
export type ApiKeyStatus = 'PENDING' | 'ACTIVE' | 'REVOKED';

/** Các lệnh API Gateway cần cho vòng đời API key; interface này cho phép thay bằng mock khi kiểm thử. */
export interface ApiGatewayKeyAdmin {
  createApiKey(input: { name: string; description: string }): Promise<{ id?: string; value?: string }>;
  attachKey(keyId: string, usagePlanId: string): Promise<void>;
  detachKey(keyId: string, usagePlanId: string): Promise<void>;
  setKeyEnabled(keyId: string, enabled: boolean): Promise<void>;
  deleteApiKey(keyId: string): Promise<void>;
}

/** Phụ thuộc ngoài của module; các thao tác DynamoDB vẫn đi qua lớp db dùng chung. */
export interface ApiKeyManagerDependencies {
  db: Pick<typeof db, 'get' | 'query' | 'update' | 'transactApiKey'>;
  apiGateway: ApiGatewayKeyAdmin;
  usagePlanIds: Record<ApiKeyPlan, string>;
  now: () => Date;
  logger?: ApiKeyManagerLogger;
}

/** Logger cấu trúc cho lỗi vòng đời key; mỗi entry chỉ chứa metadata an toàn, không chứa secret. */
export interface ApiKeyManagerLogger {
  error(entry: Record<string, unknown>): void;
}

/** Trả tên lỗi ổn định để log; input là lỗi bất kỳ, output là tên class hoặc UnknownError. */
function getErrorName(error: unknown): string {
  return error instanceof Error && error.name ? error.name : 'UnknownError';
}

/** Ghi lỗi API key theo QC-9 với định danh request/key; không ghi message hoặc giá trị secret. */
function logKeyError(
  ctx: Ctx,
  deps: ApiKeyManagerDependencies,
  action: string,
  keyId: string,
  error: unknown,
  extra: Record<string, unknown> = {},
): void {
  const entry = {
    level: 'ERROR',
    service: 'api-key-manager',
    action,
    errorName: getErrorName(error),
    keyId,
    request_id: ctx.requestId,
    ...extra,
  };
  if (deps.logger) deps.logger.error(entry);
  else console.error(JSON.stringify(entry));
}

/** Dữ liệu an toàn có thể trả về khi liệt kê key, không chứa giá trị bí mật của key. */
export interface ApiKeySummary {
  key_id: string;
  name: string;
  plan: ApiKeyPlan;
  status: ApiKeyStatus;
  last4: string;
  created_at: string;
  rotated_from?: string;
}

/** Khởi tạo một API Gateway client dùng lại giữa các lần gọi Lambda. */
const apiGatewayClient = new APIGatewayClient({});

/** Cấu hình adapter AWS SDK v3 cho thao tác key và Usage Plan. */
const defaultApiGateway: ApiGatewayKeyAdmin = {
  async createApiKey(input) {
    const result = await apiGatewayClient.send(new CreateApiKeyCommand({
      name: input.name,
      description: input.description,
      enabled: false,
    }));
    return { id: result.id, value: result.value };
  },
  async attachKey(keyId, usagePlanId) {
    await apiGatewayClient.send(new CreateUsagePlanKeyCommand({
      keyId,
      keyType: 'API_KEY',
      usagePlanId,
    }));
  },
  async detachKey(keyId, usagePlanId) {
    try {
      await apiGatewayClient.send(new DeleteUsagePlanKeyCommand({ usagePlanId, keyId }));
    } catch (error) {
      if ((error as { name?: string }).name !== 'NotFoundException') throw error;
    }
  },
  async setKeyEnabled(keyId, enabled) {
    await apiGatewayClient.send(new UpdateApiKeyCommand({
      apiKey: keyId,
      patchOperations: [{ op: 'replace', path: '/enabled', value: String(enabled) }],
    }));
  },
  async deleteApiKey(keyId) {
    try {
      await apiGatewayClient.send(new DeleteApiKeyCommand({ apiKey: keyId }));
    } catch (error) {
      if ((error as { name?: string }).name !== 'NotFoundException') throw error;
    }
  },
};

/** Tạo phụ thuộc mặc định từ lớp dữ liệu chung, biến môi trường và AWS SDK. */
function makeDefaultDependencies(): ApiKeyManagerDependencies {
  return {
    db,
    apiGateway: defaultApiGateway,
    usagePlanIds: {
      Basic: process.env.BASIC_USAGE_PLAN_ID ?? '',
      Standard: process.env.STANDARD_USAGE_PLAN_ID ?? '',
    },
    now: () => new Date(),
  };
}

/** Xác thực ngữ cảnh console và giới hạn quản lý key cho Tenant Admin/Developer. */
function requireApiKeyManagerRole(ctx: Ctx): void {
  if (ctx.via !== 'JWT') throw new AppError('UNAUTHORIZED', 'Thao tác quản lý API key yêu cầu phiên console đã đăng nhập.');
  try {
    requireRole(ctx, ['TENANT_ADMIN', 'DEVELOPER']);
  } catch {
    throw new AppError('PERMISSION_DENIED', 'Vai trò hiện tại không được phép quản lý API key.');
  }
}

/** Đọc MEMBER theo Cognito sub và xác nhận còn hiệu lực/đúng role; input là Ctx và DB deps, output void hoặc PERMISSION_DENIED. */
async function requireActiveMember(ctx: Ctx, deps: ApiKeyManagerDependencies): Promise<void> {
  if (!ctx.sub) throw new AppError('PERMISSION_DENIED', 'Không xác định được thành viên hiện tại.');
  const member = await deps.db.get(ctx, keys.member(ctx, ctx.sub), { consistent: true });
  const persistedRoles: Record<NonNullable<Ctx['role']>, string[]> = {
    TENANT_ADMIN: ['Tenant Admin', 'TENANT_ADMIN'],
    DEVELOPER: ['Developer', 'DEVELOPER'],
    REVIEWER: ['Reviewer', 'REVIEWER'],
  };
  if (!member || member.status !== 'ACTIVE' || member.tenantId !== ctx.tenantId ||
      member.userSub !== ctx.sub || !ctx.role || !persistedRoles[ctx.role]?.includes(member.role)) {
    throw new AppError('PERMISSION_DENIED', 'MEMBER không còn hiệu lực hoặc vai trò đã thay đổi.');
  }
}

/** Kiểm tra tenant tồn tại, chưa bị khóa và được phép thực hiện thao tác ghi key. */
async function requireActiveTenant(ctx: Ctx, deps: ApiKeyManagerDependencies): Promise<Record<string, any>> {
  const config = await deps.db.get(ctx, keys.config(ctx), { consistent: true });
  if (!config) throw new AppError('NOT_FOUND', 'Không tìm thấy tenant.');
  if (config.status !== 'ACTIVE') throw new AppError('TENANT_SUSPENDED', 'Tenant đang bị tạm khóa.');
  return config;
}

/** Kiểm tra tên, gói API và điều kiện gói dịch vụ Pro/Business khi chọn Standard. */
function validatePlan(plan: unknown, tenantPlan: unknown): asserts plan is ApiKeyPlan {
  if (plan !== 'Basic' && plan !== 'Standard') {
    throw new AppError('INVALID_REQUEST', 'Gói API phải là Basic hoặc Standard.');
  }
  if (plan === 'Standard' && tenantPlan !== 'Pro' && tenantPlan !== 'Business') {
    throw new AppError('INVALID_REQUEST', 'Gói Standard chỉ dành cho tenant dùng gói Pro hoặc Business.');
  }
}

/** Kiểm tra API Gateway Usage Plan đã được truyền vào Lambda. */
function requireUsagePlanId(plan: ApiKeyPlan, deps: ApiKeyManagerDependencies): string {
  const id = deps.usagePlanIds[plan];
  if (!id) throw new AppError('INTERNAL_ERROR', `Chưa cấu hình Usage Plan ${plan}.`);
  return id;
}

/** Chuẩn hóa và kiểm tra keyId để không nhận khóa tùy ý từ path. */
function validateKeyId(keyId: string): string {
  const clean = keyId.trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(clean)) throw new AppError('INVALID_REQUEST', 'keyId không hợp lệ.');
  return clean;
}

/** Đọc APIKEY trong phạm vi tenant hiện tại; không phân biệt key tenant khác với key không tồn tại. */
async function getTenantApiKey(ctx: Ctx, keyId: string, deps: ApiKeyManagerDependencies): Promise<Record<string, any>> {
  const key = await deps.db.get(ctx, keys.apiKey(ctx, keyId), { consistent: true });
  if (!key) throw new AppError('NOT_FOUND', 'Không tìm thấy API key.');
  return key;
}

/** Tạo cặp APIKEY/KEYMAP trong một TransactWriteItems có điều kiện. */
async function writeNewKeyMapping(
  ctx: Ctx,
  item: Record<string, unknown>,
  deps: ApiKeyManagerDependencies,
): Promise<void> {
  const keyId = String(item.keyId);
  await deps.db.transactApiKey(ctx, [
    {
      Put: {
        Item: item,
        ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
      },
    },
    {
      Put: {
        Item: { ...keys.keymap(keyId), tenantId: ctx.tenantId, createdAt: item.createdAt },
        ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
      },
    },
  ]);
}

/** Dọn API Gateway và bản ghi DB nếu provision key mới bị lỗi giữa các hệ thống. */
async function cleanupProvisionedKey(
  ctx: Ctx,
  keyId: string,
  usagePlanId: string,
  databaseWritten: boolean,
  deps: ApiKeyManagerDependencies,
): Promise<boolean> {
  let cleanupFailed = false;
  try { await deps.apiGateway.setKeyEnabled(keyId, false); } catch (error) {
    cleanupFailed = true;
    logKeyError(ctx, deps, 'API_KEY_CLEANUP_DISABLE_FAILED', keyId, error);
  }
  try { await deps.apiGateway.detachKey(keyId, usagePlanId); } catch (error) {
    cleanupFailed = true;
    logKeyError(ctx, deps, 'API_KEY_CLEANUP_DETACH_FAILED', keyId, error);
  }
  if (databaseWritten) {
    try {
      await deps.db.transactApiKey(ctx, [
        { Delete: { Key: keys.apiKey(ctx, keyId) } },
        { Delete: { Key: keys.keymap(keyId), ConditionExpression: 'attribute_not_exists(PK) OR tenantId = :tenantId', ExpressionAttributeValues: { ':tenantId': ctx.tenantId } } },
      ]);
    } catch (error) {
      cleanupFailed = true;
      logKeyError(ctx, deps, 'API_KEY_CLEANUP_DATABASE_FAILED', keyId, error);
    }
  }
  try { await deps.apiGateway.deleteApiKey(keyId); } catch (error) {
    cleanupFailed = true;
    logKeyError(ctx, deps, 'API_KEY_CLEANUP_DELETE_FAILED', keyId, error);
  }
  return !cleanupFailed;
}

/** Tạo API key disabled, ghi KEYMAP, bật key rồi trả bí mật duy nhất lần này. */
async function provisionApiKey(
  ctx: Ctx,
  input: { name: string; plan: ApiKeyPlan; rotatedFrom?: string },
  deps: ApiKeyManagerDependencies,
): Promise<{ key: ApiKeySummary; value: string }> {
  const usagePlanId = requireUsagePlanId(input.plan, deps);
  let gatewayKey: { id?: string; value?: string };
  try {
    gatewayKey = await deps.apiGateway.createApiKey({
      name: input.name,
      description: `TranslateMe tenant ${ctx.tenantId}`,
    });
  } catch (error) {
    logKeyError(ctx, deps, 'API_KEY_CREATE_FAILED', 'not-issued', error);
    throw new AppError('INTERNAL_ERROR', 'Không thể tạo API key.', { cause: getErrorName(error) });
  }
  const keyId = gatewayKey.id;
  const value = gatewayKey.value;
  if (!keyId || !value) {
    logKeyError(ctx, deps, 'API_KEY_CREATE_RESPONSE_INVALID', keyId ?? 'not-issued', new Error('Missing key id or value'));
    if (keyId) await cleanupProvisionedKey(ctx, keyId, usagePlanId, false, deps);
    throw new AppError('INTERNAL_ERROR', 'API Gateway không trả đủ thông tin tạo key.');
  }

  let databaseWritten = false;
  const createdAt = deps.now().toISOString();
  const item: Record<string, unknown> = {
    ...keys.apiKey(ctx, keyId),
    entityType: 'APIKEY',
    tenantId: ctx.tenantId,
    keyId,
    name: input.name,
    plan: input.plan,
    last4: value.slice(-4),
    status: 'PENDING' satisfies ApiKeyStatus,
    createdAt,
    ...(input.rotatedFrom ? { rotatedFrom: input.rotatedFrom } : {}),
  };

  try {
    await deps.apiGateway.attachKey(keyId, usagePlanId);
    await writeNewKeyMapping(ctx, item, deps);
    databaseWritten = true;
    await deps.db.update(ctx, {
      Key: keys.apiKey(ctx, keyId),
      UpdateExpression: 'SET #status = :active, activatedAt = :now',
      ConditionExpression: '#status = :pending',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':active': 'ACTIVE', ':pending': 'PENDING', ':now': deps.now().toISOString() },
    });
    await deps.apiGateway.setKeyEnabled(keyId, true);
  } catch (error) {
    logKeyError(ctx, deps, 'API_KEY_PROVISION_FAILED', keyId, error);
    const clean = await cleanupProvisionedKey(ctx, keyId, usagePlanId, databaseWritten, deps);
    if (!clean) throw new AppError('INTERNAL_ERROR', 'Không hoàn tất được khởi tạo key; cần kiểm tra trạng thái tài nguyên AWS.', { cause: getErrorName(error), keyId });
    throw new AppError('INTERNAL_ERROR', 'Không thể hoàn tất tạo API key.', { cause: getErrorName(error) });
  }

  const summary: ApiKeySummary = {
    key_id: keyId,
    name: input.name,
    plan: input.plan,
    status: 'ACTIVE',
    last4: value.slice(-4),
    created_at: createdAt,
    ...(input.rotatedFrom ? { rotated_from: input.rotatedFrom } : {}),
  };
  return { key: summary, value };
}

/** Tạo API key mới cho tenant; input là tên/gói, output gồm thông tin key và secret hiện một lần. */
export async function createApiKey(
  ctx: Ctx,
  input: { name: string; plan: ApiKeyPlan },
  deps: ApiKeyManagerDependencies = makeDefaultDependencies(),
): Promise<{ key: ApiKeySummary; value: string }> {
  requireApiKeyManagerRole(ctx);
  const config = await requireActiveTenant(ctx, deps);
  await requireActiveMember(ctx, deps);
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 128) throw new AppError('INVALID_REQUEST', 'Tên API key phải dài từ 1 đến 128 ký tự.');
  validatePlan(input?.plan, config.plan);
  return provisionApiKey(ctx, { name, plan: input.plan }, deps);
}

/** Liệt kê key của tenant mà không trả giá trị bí mật; input là Ctx, output là danh sách an toàn. */
export async function listApiKeys(
  ctx: Ctx,
  deps: ApiKeyManagerDependencies = makeDefaultDependencies(),
): Promise<ApiKeySummary[]> {
  requireApiKeyManagerRole(ctx);
  const rows = await deps.db.query(ctx, `TENANT#${ctx.tenantId}#APIKEY`, 'KEY#');
  return rows.map((row) => ({
    key_id: String(row.keyId ?? String(row.SK).slice(4)),
    name: String(row.name ?? ''),
    plan: row.plan === 'Standard' ? 'Standard' : 'Basic',
    status: row.status as ApiKeyStatus,
    last4: String(row.last4 ?? ''),
    created_at: String(row.createdAt ?? ''),
    ...(typeof row.rotatedFrom === 'string' ? { rotated_from: row.rotatedFrom } : {}),
  }));
}

/** Xoay API key bằng cách tạo key mới cùng gói; key cũ tiếp tục active cho tới khi bị thu hồi. */
export async function rotateApiKey(
  ctx: Ctx,
  keyId: string,
  deps: ApiKeyManagerDependencies = makeDefaultDependencies(),
): Promise<{ key: ApiKeySummary; value: string }> {
  requireApiKeyManagerRole(ctx);
  const config = await requireActiveTenant(ctx, deps);
  await requireActiveMember(ctx, deps);
  const current = await getTenantApiKey(ctx, validateKeyId(keyId), deps);
  if (current.status !== 'ACTIVE') throw new AppError('INVALID_REQUEST', 'Chỉ có thể xoay API key đang hoạt động.');
  validatePlan(current.plan, config.plan);
  return provisionApiKey(ctx, { name: String(current.name), plan: current.plan, rotatedFrom: String(current.keyId) }, deps);
}

/** Thu hồi key bằng cách vô hiệu hóa ở API Gateway rồi xóa KEYMAP/cập nhật trạng thái trong một giao dịch. */
export async function revokeApiKey(
  ctx: Ctx,
  keyId: string,
  deps: ApiKeyManagerDependencies = makeDefaultDependencies(),
): Promise<ApiKeySummary> {
  requireApiKeyManagerRole(ctx);
  await requireActiveTenant(ctx, deps);
  const cleanKeyId = validateKeyId(keyId);
  const current = await getTenantApiKey(ctx, cleanKeyId, deps);
  if (current.status === 'REVOKED') return toSummary(current);
  if (current.plan !== 'Basic' && current.plan !== 'Standard') throw new AppError('INTERNAL_ERROR', 'Bản ghi API key có gói không hợp lệ.');
  const usagePlanId = requireUsagePlanId(current.plan, deps);

  try {
    await deps.apiGateway.setKeyEnabled(cleanKeyId, false);
  } catch (error) {
    logKeyError(ctx, deps, 'API_KEY_REVOKE_DISABLE_FAILED', cleanKeyId, error);
    throw error;
  }
  try {
    await deps.apiGateway.detachKey(cleanKeyId, usagePlanId);
  } catch (error) {
    logKeyError(ctx, deps, 'API_KEY_REVOKE_DETACH_FAILED', cleanKeyId, error);
    throw error;
  }
  const revokedAt = deps.now().toISOString();
  try {
    await deps.db.transactApiKey(ctx, [
      {
        Update: {
          Key: keys.apiKey(ctx, cleanKeyId),
          UpdateExpression: 'SET #status = :revoked, revokedAt = :now',
          ConditionExpression: '#status <> :revoked',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':revoked': 'REVOKED', ':now': revokedAt },
        },
      },
      {
        Delete: {
          Key: keys.keymap(cleanKeyId),
          ConditionExpression: 'attribute_not_exists(PK) OR tenantId = :tenantId',
          ExpressionAttributeValues: { ':tenantId': ctx.tenantId },
        },
      },
    ]);
  } catch (error) {
    logKeyError(ctx, deps, 'API_KEY_REVOKE_DATABASE_FAILED', cleanKeyId, error);
    throw error;
  }

  return toSummary({ ...current, status: 'REVOKED', revokedAt });
}

/** Đổi gói API key; input là keyId/gói mới, output là summary sau khi Usage Plan và DB đồng bộ. */
export async function changeApiKeyPlan(
  ctx: Ctx,
  keyId: string,
  requestedPlan: ApiKeyPlan,
  deps: ApiKeyManagerDependencies = makeDefaultDependencies(),
): Promise<ApiKeySummary> {
  requireApiKeyManagerRole(ctx);
  const config = await requireActiveTenant(ctx, deps);
  const cleanKeyId = validateKeyId(keyId);
  const current = await getTenantApiKey(ctx, cleanKeyId, deps);
  if (current.status !== 'ACTIVE') throw new AppError('INVALID_REQUEST', 'Chỉ có thể đổi gói API key đang hoạt động.');
  validatePlan(requestedPlan, config.plan);
  if (current.plan === requestedPlan) return toSummary(current);
  if (current.plan !== 'Basic' && current.plan !== 'Standard') throw new AppError('INTERNAL_ERROR', 'Bản ghi API key có gói không hợp lệ.');

  const oldPlan = current.plan;
  const oldUsagePlanId = requireUsagePlanId(oldPlan, deps);
  const newUsagePlanId = requireUsagePlanId(requestedPlan, deps);
  let oldPlanDetached = false;
  let newPlanAttached = false;
  try {
    await deps.apiGateway.detachKey(cleanKeyId, oldUsagePlanId);
    oldPlanDetached = true;
    await deps.apiGateway.attachKey(cleanKeyId, newUsagePlanId);
    newPlanAttached = true;
    await deps.db.update(ctx, {
      Key: keys.apiKey(ctx, cleanKeyId),
      UpdateExpression: 'SET #plan = :newPlan, updatedAt = :now',
      ConditionExpression: '#status = :active AND #plan = :oldPlan',
      ExpressionAttributeNames: { '#plan': 'plan', '#status': 'status' },
      ExpressionAttributeValues: { ':newPlan': requestedPlan, ':oldPlan': oldPlan, ':active': 'ACTIVE', ':now': deps.now().toISOString() },
    });
  } catch (error) {
    logKeyError(ctx, deps, 'API_KEY_PLAN_CHANGE_FAILED', cleanKeyId, error);
    let restored = true;
    if (newPlanAttached) {
      try { await deps.apiGateway.detachKey(cleanKeyId, newUsagePlanId); } catch (rollbackError) {
        restored = false;
        logKeyError(ctx, deps, 'API_KEY_PLAN_ROLLBACK_DETACH_FAILED', cleanKeyId, rollbackError, { originalErrorName: getErrorName(error) });
      }
    }
    if (oldPlanDetached) {
      try { await deps.apiGateway.attachKey(cleanKeyId, oldUsagePlanId); } catch (rollbackError) {
        restored = false;
        logKeyError(ctx, deps, 'API_KEY_PLAN_ROLLBACK_ATTACH_FAILED', cleanKeyId, rollbackError, { originalErrorName: getErrorName(error) });
      }
    }
    if (!restored) throw new AppError('INTERNAL_ERROR', 'Không đổi được gói và không khôi phục được Usage Plan cũ.', { cause: getErrorName(error), keyId });
    throw new AppError('INTERNAL_ERROR', 'Không thể hoàn tất đổi gói API key.', { cause: getErrorName(error) });
  }

  return toSummary({ ...current, plan: requestedPlan, updatedAt: deps.now().toISOString() });
}

/** Chuyển bản ghi nội bộ thành DTO an toàn, không trả value hoặc thuộc tính bí mật khác. */
function toSummary(item: Record<string, any>): ApiKeySummary {
  return {
    key_id: String(item.keyId ?? String(item.SK).slice(4)),
    name: String(item.name ?? ''),
    plan: item.plan === 'Standard' ? 'Standard' : 'Basic',
    status: item.status as ApiKeyStatus,
    last4: String(item.last4 ?? ''),
    created_at: String(item.createdAt ?? ''),
    ...(typeof item.rotatedFrom === 'string' ? { rotated_from: item.rotatedFrom } : {}),
  };
}

/** Chuẩn hóa body JSON thành object; input là body API Gateway, output là object hoặc lỗi INVALID_REQUEST. */
function parseRequestBody(body: string | null | undefined): Record<string, unknown> {
  if (!body) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { throw new AppError('INVALID_REQUEST', 'Nội dung JSON không hợp lệ.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new AppError('INVALID_REQUEST', 'Nội dung yêu cầu phải là object JSON.');
  return parsed as Record<string, unknown>;
}

/** Chuyển mã lỗi miền nghiệp vụ thành HTTP status theo hợp đồng API. */
function statusForError(code: string): number {
  if (code === 'UNAUTHORIZED') return 401;
  if (code === 'TENANT_SUSPENDED' || code === 'PERMISSION_DENIED' || code === 'FORBIDDEN') return 403;
  if (code === 'NOT_FOUND') return 404;
  if (code === 'RATE_LIMITED' || code === 'REQUEST_QUOTA_EXCEEDED') return 429;
  if (code === 'INVALID_REQUEST' || code === 'UNSUPPORTED_LANGUAGE') return 400;
  return 500;
}

/** Xử lý các route /console/api-keys; input là event và Ctx đã xác thực, output theo JSON chuẩn có request_id. */
export async function handleApiKeyRoute(
  event: { httpMethod?: string; path?: string; rawPath?: string; body?: string | null; requestContext?: { requestId?: string } },
  ctx: Ctx,
  deps: ApiKeyManagerDependencies = makeDefaultDependencies(),
): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  const requestId = event.requestContext?.requestId ?? ctx.requestId;
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
  const respond = (statusCode: number, payload: Record<string, unknown>) => ({ statusCode, headers, body: JSON.stringify({ request_id: requestId, ...payload }) });

  try {
    const method = (event.httpMethod ?? 'GET').toUpperCase();
    const path = event.path ?? event.rawPath ?? '';
    const route = /\/console\/api-keys(?:\/([^/]+)(?:\/(rotate|revoke))?)?$/.exec(path);
    if (!route) throw new AppError('NOT_FOUND', 'Không tìm thấy endpoint.');
    let keyId: string | undefined;
    try {
      keyId = route[1] ? decodeURIComponent(route[1]) : undefined;
    } catch {
      throw new AppError('INVALID_REQUEST', 'keyId trong đường dẫn không hợp lệ.');
    }
    const action = route[2];
    const body = parseRequestBody(event.body);

    if (method === 'POST' && !keyId) {
      const result = await createApiKey(ctx, { name: String(body.name ?? ''), plan: body.plan as ApiKeyPlan }, deps);
      return respond(201, { api_key: { ...result.key, value: result.value } });
    }
    if (method === 'GET' && !keyId) {
      return respond(200, { api_keys: await listApiKeys(ctx, deps) });
    }
    if (method === 'POST' && keyId && action === 'rotate') {
      const result = await rotateApiKey(ctx, keyId, deps);
      return respond(201, { api_key: { ...result.key, value: result.value } });
    }
    if (method === 'POST' && keyId && action === 'revoke') {
      return respond(200, { api_key: await revokeApiKey(ctx, keyId, deps) });
    }
    if (method === 'PATCH' && keyId && !action) {
      return respond(200, {
        api_key: await changeApiKeyPlan(ctx, keyId, body.plan as ApiKeyPlan, deps),
      });
    }
    throw new AppError('NOT_FOUND', 'Không tìm thấy endpoint.');
  } catch (error) {
    if (error instanceof AppError) return respond(statusForError(error.code), { error: { code: error.code, message: error.message } });
    return respond(500, { error: { code: 'INTERNAL_ERROR', message: 'Lỗi tạm thời khi quản lý API key.' } });
  }
}
