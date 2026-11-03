/**
 * Lambda Trigger: Cognito Post Confirmation (Nhiệm vụ 1.11 - Mục B).
 *
 * Chức năng:
 *  1. Chỉ xử lý khi `triggerSource === "PostConfirmation_ConfirmSignUp"`; nguồn khác trả lại event ngay.
 *  2. Trích xuất `sub`, `email` và `organizationName` (hỗ trợ cả `clientMetadata` và `userAttributes`).
 *  3. Sinh `tenant_id` duy nhất, không đoán được (kết hợp cơ chế idempotent theo `sub`).
 *  4. Ghi MỘT giao dịch DynamoDB (`TransactWriteItems`) gồm đúng 2 bản ghi:
 *     - CONFIG: PK = "TENANT#<t>", SK = "CONFIG"
 *     - MEMBER: PK = "TENANT#<t>", SK = "MEMBER#<sub>"
 *     với `ConditionExpression: "attribute_not_exists(PK)"` để idempotent khi Cognito gọi lại.
 *  5. Gọi `AdminUpdateUserAttributes` gán `custom:tenant_id` và `custom:role = tenant_admin`.
 *  6. Khi lỗi: ghi log JSON có cấu trúc (tuyệt đối không log mật khẩu/mã xác nhận) và ném lỗi
 *     để tránh trạng thái user đã xác nhận nhưng không có tenant.
 *
 * Cách khôi phục khi bước 4 hoặc 5 gặp sự cố tạm thời (DynamoDB/Cognito throttling):
 *  - Vì handler ném lỗi, Cognito coi bước PostConfirmation chưa hoàn tất; hoặc khi quản trị viên/luồng
 *    bù (reconciliation) kích hoạt lại handler với cùng `sub`, hàm `deriveTenantId` sinh lại đúng mã
 *    tenant_id (hoặc đọc từ `userAttributes['custom:tenant_id']` nếu đã có).
 *  - Nếu bước 4 đã ghi thành công ở lần 1 nhưng bước 5 lỗi: ở lần chạy lại, `TransactWriteItems` trả về
 *    `TransactionCanceledException` với lý do `ConditionalCheckFailed` ở cả 2 mục; handler nhận diện
 *    đây là lần gọi lại hợp lệ (idempotent), bỏ qua lỗi trùng lặp, giữ nguyên dữ liệu cũ và chạy tiếp
 *    bước 5 (`AdminUpdateUserAttributes`) để hoàn tất gắn `custom:tenant_id` và `custom:role`.
 */

import { createHmac, randomBytes } from 'node:crypto';
import {
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  DynamoDBClient,
  TransactWriteItemsCommand,
  type TransactWriteItemsCommandInput,
} from '@aws-sdk/client-dynamodb';
import { COGNITO_CUSTOM_ATTRIBUTES, ROLES, claimForRole } from '../../../libs/common/roles.js';
import { createTenantDocumentClientRouter } from '../../../libs/common/tenantAws.js';

// ============================================================================
// Hằng số cấu hình & Kiểu sự kiện Cognito PostConfirmation
// ============================================================================

export const CONFIRM_SIGN_UP_TRIGGER_SOURCE = 'PostConfirmation_ConfirmSignUp';

export const DEFAULT_PLAN_NAME = 'Free';
export const TENANT_STATUS_ACTIVE = 'ACTIVE';
export const MEMBER_STATUS_ACTIVE = 'ACTIVE';
export const INITIAL_GLOSSARY_VERSION = 0;

/**
 * Hạn mức ký tự mặc định của gói Free.
 * TODO(nhóm - xác nhận với TV3): Chốt chính xác con số hạn mức ký tự gói Free (ví dụ 50_000 hay 100_000 ký tự/tháng).
 */
export const FREE_TIER_CHAR_LIMIT = Number(process.env.FREE_TIER_CHAR_LIMIT ?? 50_000);

export interface CognitoPostConfirmationEvent {
  version: string;
  triggerSource: string;
  region: string;
  userPoolId: string;
  userName: string;
  callerContext?: {
    awsSdkVersion?: string;
    clientId?: string;
  };
  request: {
    userAttributes: Record<string, string | undefined>;
    clientMetadata?: Record<string, string | undefined>;
  };
  response: Record<string, unknown>;
}

/** Giao diện tối thiểu cho client DynamoDB và Cognito để dễ mock/inject trong unit test. */
export interface DynamoDBTransactClient {
  send(command: TransactWriteItemsCommand): Promise<unknown>;
}

export interface CognitoAdminUpdateClient {
  send(command: AdminUpdateUserAttributesCommand): Promise<unknown>;
}

export interface PostConfirmationLogger {
  info(entry: Record<string, unknown>): void;
  warn(entry: Record<string, unknown>): void;
  error(entry: Record<string, unknown>): void;
}

export interface PostConfirmationDeps {
  ddbClient?: DynamoDBTransactClient;
  cognitoClient?: CognitoAdminUpdateClient;
  tableName?: string;
  freeTierCharLimit?: number;
  /** Hàm sinh tenant_id (nhận `sub` và `userPoolId`); mặc định dùng HMAC-SHA256 không đoán được + idempotent theo `sub`. */
  tenantIdGenerator?: (sub: string, userPoolId: string) => string;
  now?: () => string;
  logger?: PostConfirmationLogger;
}

// ============================================================================
// Logger JSON có cấu trúc (ẩn mọi trường nhạy cảm nếu vô tình xuất hiện)
// ============================================================================

const SENSITIVE_KEY_PATTERN = /password|secret|code|token|authorization/i;

export function sanitizeLogFields(fields: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (SENSITIVE_KEY_PATTERN.test(k)) continue; // Bảo mật: không bao giờ ghi mật khẩu hay mã xác nhận vào log
    safe[k] = v;
  }
  return safe;
}

export const defaultLogger: PostConfirmationLogger = {
  info(entry) {
    console.log(JSON.stringify({ level: 'INFO', service: 'cognito-post-confirmation', ...sanitizeLogFields(entry) }));
  },
  warn(entry) {
    console.warn(JSON.stringify({ level: 'WARN', service: 'cognito-post-confirmation', ...sanitizeLogFields(entry) }));
  },
  error(entry) {
    console.error(JSON.stringify({ level: 'ERROR', service: 'cognito-post-confirmation', ...sanitizeLogFields(entry) }));
  },
};

// ============================================================================
// Tách riêng hàm lấy Tên Tổ Chức & Sinh Tenant ID
// ============================================================================

/**
 * Lấy tên tổ chức từ sự kiện Cognito PostConfirmation.
 *
 * TODO(nhóm - xác nhận với người làm Web Console): Chốt chính thức cách truyền tên tổ chức lúc SignUp:
 *  - Phương án 1 (khuyên dùng): truyền qua `ClientMetadata.organization_name` (hoặc `orgName`) trong `SignUp` / `ConfirmSignUp`.
 *  - Phương án 2: truyền qua thuộc tính chuẩn ghi được của Cognito như `name` hoặc `custom:org_name`.
 * Hàm này hỗ trợ cả hai nguồn và có giá trị dự phòng theo phần tên của email nếu đều trống.
 */
export function extractOrganizationName(event: CognitoPostConfirmationEvent): string {
  const meta = event.request?.clientMetadata ?? {};
  const attrs = event.request?.userAttributes ?? {};

  const candidates = [
    meta.organization_name,
    meta.organizationName,
    meta.orgName,
    attrs['custom:organization_name'],
    attrs['custom:org_name'],
    attrs.name,
  ];

  for (const raw of candidates) {
    if (typeof raw === 'string' && raw.trim().length > 0) {
      return raw.trim().slice(0, 128);
    }
  }

  // Dự phòng an toàn nếu frontend chưa truyền kịp: lấy phần trước '@' của email.
  const email = (attrs.email ?? '').trim();
  const localPart = email.split('@')[0]?.trim();
  return localPart && localPart.length > 0 ? `${localPart}'s Organization` : 'Default Organization';
}

// Khóa bí mật trong vòng đời runtime dùng để dẫn xuất tenant_id không đoán được nhưng idempotent cho cùng 1 `sub`.
const RUNTIME_TENANT_SEED =
  process.env.TENANT_ID_HMAC_SECRET ?? `translateme-runtime-${randomBytes(32).toString('hex')}`;

/**
 * Sinh `tenant_id` duy nhất, độ dài 24 ký tự hex (96-bit), không đoán được từ bên ngoài.
 * Bảo mật & Idempotency:
 *  - Dùng HMAC-SHA256(secret, `${userPoolId}:${sub}`) để:
 *    (1) Kẻ tấn công không thể đoán trước hay vét cạn `tenant_id` của tenant khác.
 *    (2) Nếu Cognito gọi lại trigger lần 2 cho CÙNG `sub`, hàm trả về cùng `tenant_id`,
 *        kết hợp với `attribute_not_exists(PK)` trong DynamoDB để đảm bảo không tạo tenant thứ hai.
 */
export function generateTenantId(sub: string, userPoolId: string): string {
  const digest = createHmac('sha256', RUNTIME_TENANT_SEED)
    .update(`${userPoolId}:${sub}`)
    .digest('hex')
    .slice(0, 24);
  return `t_${digest}`;
}

// ============================================================================
// Kiểm tra lỗi ConditionalCheckFailed khi gọi lại (Idempotency)
// ============================================================================

function isIdempotentDuplicateError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as {
    name?: string;
    CancellationReasons?: Array<{ Code?: string }>;
  };
  if (e.name !== 'TransactionCanceledException') return false;
  if (!Array.isArray(e.CancellationReasons) || e.CancellationReasons.length === 0) {
    return true;
  }
  return e.CancellationReasons.every((r) => r?.Code === 'ConditionalCheckFailed');
}

// ============================================================================
// Nhà máy tạo Handler (hỗ trợ DI cho test) & Handler mặc định cho Lambda
// ============================================================================

let defaultDdbClient: DynamoDBClient | undefined;
let defaultCognitoClient: CognitoIdentityProviderClient | undefined;

function getDefaultDdbClient(): DynamoDBClient {
  if (!defaultDdbClient) {
    const base = new DynamoDBClient({});
    defaultDdbClient = createTenantDocumentClientRouter(base as never, {
      roleArn: process.env.TENANT_DATA_ACCESS_ROLE_ARN,
      sessionName: 'post-confirmation',
      createClient: (credentials) => new DynamoDBClient({ credentials }) as never,
    }) as never as DynamoDBClient;
  }
  return defaultDdbClient;
}

function getDefaultCognitoClient(): CognitoIdentityProviderClient {
  if (!defaultCognitoClient) defaultCognitoClient = new CognitoIdentityProviderClient({});
  return defaultCognitoClient;
}

export function createPostConfirmationHandler(deps: PostConfirmationDeps = {}) {
  const logger = deps.logger ?? defaultLogger;

  return async function postConfirmationHandler(
    event: CognitoPostConfirmationEvent,
  ): Promise<CognitoPostConfirmationEvent> {
    // 1. Chỉ xử lý khi triggerSource là PostConfirmation_ConfirmSignUp
    if (event.triggerSource !== CONFIRM_SIGN_UP_TRIGGER_SOURCE) {
      logger.info({
        action: 'SKIP_NON_SIGNUP_TRIGGER',
        triggerSource: event.triggerSource,
        userPoolId: event.userPoolId,
      });
      return event;
    }

    const attrs = event.request?.userAttributes ?? {};
    const sub = (attrs.sub ?? '').trim();
    const email = (attrs.email ?? '').trim().toLowerCase();

    if (!sub || !email) {
      logger.error({
        action: 'MISSING_USER_ATTRIBUTES',
        hasSub: Boolean(sub),
        hasEmail: Boolean(email),
        userPoolId: event.userPoolId,
      });
      throw new Error('PostConfirmation event thiếu thuộc tính bắt buộc: sub hoặc email');
    }

    const tableName = (deps.tableName ?? process.env.TABLE_NAME ?? '').trim();
    if (!tableName) {
      logger.error({ action: 'MISSING_TABLE_NAME', sub, userPoolId: event.userPoolId });
      throw new Error('Thiếu cấu hình biến môi trường TABLE_NAME');
    }

    // 2. Lấy tên tổ chức và sinh (hoặc lấy lại) tenant_id
    const organizationName = extractOrganizationName(event);
    const existingTenantId = attrs[COGNITO_CUSTOM_ATTRIBUTES.TENANT_ID]?.trim();
    const tenantId =
      existingTenantId && existingTenantId.length > 0
        ? existingTenantId
        : (deps.tenantIdGenerator ?? generateTenantId)(sub, event.userPoolId);

    const createdAt = (deps.now ?? (() => new Date().toISOString()))();
    const charLimit = deps.freeTierCharLimit ?? FREE_TIER_CHAR_LIMIT;
    const tenantPk = `TENANT#${tenantId}`;
    const memberSk = `MEMBER#${sub}`;

    // 4. Chuẩn bị giao dịch DynamoDB (TransactWriteItems) gồm ĐÚNG 2 bản ghi: CONFIG và MEMBER
    const transactInput: TransactWriteItemsCommandInput = {
      TransactItems: [
        {
          Put: {
            TableName: tableName,
            // Bảo mật & Idempotency: không ghi đè nếu tenant CONFIG đã tồn tại
            ConditionExpression: 'attribute_not_exists(PK)',
            Item: {
              PK: { S: tenantPk },
              SK: { S: 'CONFIG' },
              tenantId: { S: tenantId },
              organizationName: { S: organizationName },
              plan: { S: DEFAULT_PLAN_NAME },
              charLimit: { N: String(charLimit) },
              status: { S: TENANT_STATUS_ACTIVE },
              glossaryVersion: { N: String(INITIAL_GLOSSARY_VERSION) },
              ownerSub: { S: sub },
              createdAt: { S: createdAt },
            },
          },
        },
        {
          Put: {
            TableName: tableName,
            // Bảo mật & Idempotency: không ghi đè nếu MEMBER đã tồn tại
            ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
            Item: {
              PK: { S: tenantPk },
              SK: { S: memberSk },
              tenantId: { S: tenantId },
              userSub: { S: sub },
              email: { S: email },
              role: { S: ROLES.TENANT_ADMIN },
              status: { S: MEMBER_STATUS_ACTIVE },
              createdAt: { S: createdAt },
            },
          },
        },
      ],
    };

    const ddb = deps.ddbClient ?? getDefaultDdbClient();
    const cognito = deps.cognitoClient ?? getDefaultCognitoClient();

    try {
      await ddb.send(new TransactWriteItemsCommand(transactInput));
      logger.info({
        action: 'TENANT_CREATED',
        tenantId,
        sub,
        userPoolId: event.userPoolId,
      });
    } catch (err) {
      // Nếu cả 2 điều kiện attribute_not_exists đều báo đã tồn tại -> đây là lần gọi lại (retry) cùng sub
      if (isIdempotentDuplicateError(err)) {
        logger.warn({
          action: 'IDEMPOTENT_REPLAY_DETECTED',
          tenantId,
          sub,
          userPoolId: event.userPoolId,
        });
      } else {
        logger.error({
          action: 'DYNAMODB_TRANSACT_FAILED',
          tenantId,
          sub,
          userPoolId: event.userPoolId,
          errorName: err instanceof Error ? err.name : 'UnknownError',
          errorMessage: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    }

    // 5. Gán custom:tenant_id và custom:role = tenant_admin trên Cognito User Pool
    try {
      await cognito.send(
        new AdminUpdateUserAttributesCommand({
          UserPoolId: event.userPoolId,
          Username: event.userName,
          UserAttributes: [
            { Name: COGNITO_CUSTOM_ATTRIBUTES.TENANT_ID, Value: tenantId },
            { Name: COGNITO_CUSTOM_ATTRIBUTES.ROLE, Value: claimForRole(ROLES.TENANT_ADMIN) },
          ],
        }),
      );
      logger.info({
        action: 'USER_ATTRIBUTES_UPDATED',
        tenantId,
        sub,
        role: ROLES.TENANT_ADMIN,
        userPoolId: event.userPoolId,
      });
    } catch (err) {
      logger.error({
        action: 'COGNITO_UPDATE_ATTRIBUTES_FAILED',
        tenantId,
        sub,
        userPoolId: event.userPoolId,
        errorName: err instanceof Error ? err.name : 'UnknownError',
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    return event;
  };
}

/** Handler xuất ra cho AWS Lambda runtime. */
export const handler = createPostConfirmationHandler();
