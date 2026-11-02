import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AdminCreateUserCommand,
  AdminUpdateUserAttributesCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { TransactWriteItemsCommand } from '@aws-sdk/client-dynamodb';
import {
  COGNITO_CUSTOM_ATTRIBUTES,
  INVITABLE_ROLES,
  ROLES,
  claimForRole,
  isInvitableRole,
} from '../../../../libs/common/roles.js';
import { generateTemporaryPassword, inviteMember } from '../inviteMember.js';
import {
  CONFIRM_SIGN_UP_TRIGGER_SOURCE,
  DEFAULT_PLAN_NAME,
  FREE_TIER_CHAR_LIMIT,
  INITIAL_GLOSSARY_VERSION,
  MEMBER_STATUS_ACTIVE,
  TENANT_STATUS_ACTIVE,
  createPostConfirmationHandler,
  extractOrganizationName,
  generateTenantId,
  sanitizeLogFields,
  type CognitoPostConfirmationEvent,
  type PostConfirmationLogger,
} from '../postConfirmation.js';

// ============================================================================
// Công cụ giả lập (Mock) DynamoDB, Cognito và Logger (không dùng mạng/AWS)
// ============================================================================

function makeEvent(overrides: Partial<CognitoPostConfirmationEvent> = {}): CognitoPostConfirmationEvent {
  return {
    version: '1',
    triggerSource: CONFIRM_SIGN_UP_TRIGGER_SOURCE,
    region: 'ap-southeast-1',
    userPoolId: 'ap-southeast-1_TestPool123',
    userName: 'user-sub-001',
    request: {
      userAttributes: {
        sub: 'user-sub-001',
        email: 'Founder@Acme.io',
        email_verified: 'true',
      },
      clientMetadata: {
        organization_name: 'Acme Corp',
      },
    },
    response: {},
    ...overrides,
  };
}

function createFakeLogger(): PostConfirmationLogger & {
  infos: Array<Record<string, unknown>>;
  warns: Array<Record<string, unknown>>;
  errors: Array<Record<string, unknown>>;
} {
  const infos: Array<Record<string, unknown>> = [];
  const warns: Array<Record<string, unknown>> = [];
  const errors: Array<Record<string, unknown>> = [];
  return {
    infos,
    warns,
    errors,
    info: (e) => infos.push(sanitizeLogFields(e)),
    warn: (e) => warns.push(sanitizeLogFields(e)),
    error: (e) => errors.push(sanitizeLogFields(e)),
  };
}

/**
 * Bảng DynamoDB giả lập trong bộ nhớ để kiểm tra đúng hành vi `attribute_not_exists`
 * của `TransactWriteItems` khi gọi lần 1 và khi gọi lại lần 2 (idempotent).
 */
function createStatefulMockDdb() {
  const store = new Map<string, Record<string, unknown>>();
  const commands: TransactWriteItemsCommand[] = [];

  return {
    store,
    commands,
    async send(cmd: TransactWriteItemsCommand) {
      commands.push(cmd);
      const items = cmd.input.TransactItems ?? [];
      const reasons: Array<{ Code: string }> = [];
      let hasFailure = false;

      for (const entry of items) {
        const put = entry.Put;
        if (!put || !put.Item) continue;
        const pk = put.Item.PK?.S ?? '';
        const sk = put.Item.SK?.S ?? '';
        const key = `${pk}::${sk}`;
        if (put.ConditionExpression?.includes('attribute_not_exists') && store.has(key)) {
          hasFailure = true;
          reasons.push({ Code: 'ConditionalCheckFailed' });
        } else {
          reasons.push({ Code: 'None' });
        }
      }

      if (hasFailure) {
        const err = Object.assign(new Error('Transaction cancelled, please refer cancellation reasons'), {
          name: 'TransactionCanceledException',
          CancellationReasons: reasons,
        });
        throw err;
      }

      for (const entry of items) {
        const put = entry.Put;
        if (!put || !put.Item) continue;
        const pk = put.Item.PK?.S ?? '';
        const sk = put.Item.SK?.S ?? '';
        store.set(`${pk}::${sk}`, put.Item);
      }
      return {};
    },
  };
}

// ============================================================================
// 1. Test PostConfirmation Trigger
// ============================================================================

describe('PostConfirmation Trigger Handler', () => {
  it('[E.1] nguồn PostConfirmation_ConfirmSignUp -> ghi đúng 2 bản ghi (CONFIG + MEMBER) và gọi AdminUpdateUserAttributes', async () => {
    const ddb = createStatefulMockDdb();
    const cognitoCalls: AdminUpdateUserAttributesCommand[] = [];
    const cognito = {
      async send(cmd: AdminUpdateUserAttributesCommand) {
        cognitoCalls.push(cmd);
        return {};
      },
    };
    const logger = createFakeLogger();

    const handler = createPostConfirmationHandler({
      ddbClient: ddb,
      cognitoClient: cognito,
      tableName: 'TranslateMeTable',
      now: () => '2026-10-16T15:00:00.000Z',
      logger,
    });

    const event = makeEvent();
    const result = await handler(event);

    assert.equal(result, event, 'Handler phải trả lại đúng đối tượng event cho Cognito');
    assert.equal(ddb.commands.length, 1, 'Phải gọi đúng 1 giao dịch TransactWriteItems');

    const transactItems = ddb.commands[0].input.TransactItems ?? [];
    assert.equal(transactItems.length, 2, 'Giao dịch phải gồm đúng 2 bản ghi: CONFIG và MEMBER');

    const configPut = transactItems[0].Put!;
    const memberPut = transactItems[1].Put!;

    const expectedTenantId = generateTenantId('user-sub-001', 'ap-southeast-1_TestPool123');
    const expectedPk = `TENANT#${expectedTenantId}`;

    // Kiểm tra bản ghi CONFIG
    assert.equal(configPut.TableName, 'TranslateMeTable');
    assert.ok(configPut.ConditionExpression?.includes('attribute_not_exists'));
    assert.equal(configPut.Item?.PK?.S, expectedPk);
    assert.equal(configPut.Item?.SK?.S, 'CONFIG');
    assert.equal(configPut.Item?.organizationName?.S, 'Acme Corp');
    assert.equal(configPut.Item?.plan?.S, DEFAULT_PLAN_NAME);
    assert.equal(configPut.Item?.charLimit?.N, String(FREE_TIER_CHAR_LIMIT));
    assert.equal(configPut.Item?.status?.S, TENANT_STATUS_ACTIVE);
    assert.equal(configPut.Item?.glossaryVersion?.N, String(INITIAL_GLOSSARY_VERSION));

    // Kiểm tra bản ghi MEMBER
    assert.equal(memberPut.TableName, 'TranslateMeTable');
    assert.ok(memberPut.ConditionExpression?.includes('attribute_not_exists'));
    assert.equal(memberPut.Item?.PK?.S, expectedPk);
    assert.equal(memberPut.Item?.SK?.S, 'MEMBER#user-sub-001');
    assert.equal(memberPut.Item?.email?.S, 'founder@acme.io');
    assert.equal(memberPut.Item?.role?.S, ROLES.TENANT_ADMIN);
    assert.equal(memberPut.Item?.status?.S, MEMBER_STATUS_ACTIVE);

    // Kiểm tra lệnh gọi AdminUpdateUserAttributes
    assert.equal(cognitoCalls.length, 1);
    const cognitoInput = cognitoCalls[0].input;
    assert.equal(cognitoInput.UserPoolId, 'ap-southeast-1_TestPool123');
    assert.equal(cognitoInput.Username, 'user-sub-001');
    assert.deepEqual(cognitoInput.UserAttributes, [
      { Name: COGNITO_CUSTOM_ATTRIBUTES.TENANT_ID, Value: expectedTenantId },
      { Name: COGNITO_CUSTOM_ATTRIBUTES.ROLE, Value: claimForRole(ROLES.TENANT_ADMIN) },
    ]);
  });

  it('[E.2] nguồn khác (PostConfirmation_ConfirmForgotPassword) -> không ghi DynamoDB, không gọi Cognito', async () => {
    const ddb = createStatefulMockDdb();
    const cognitoCalls: AdminUpdateUserAttributesCommand[] = [];
    const cognito = {
      async send(cmd: AdminUpdateUserAttributesCommand) {
        cognitoCalls.push(cmd);
        return {};
      },
    };
    const logger = createFakeLogger();

    const handler = createPostConfirmationHandler({
      ddbClient: ddb,
      cognitoClient: cognito,
      tableName: 'TranslateMeTable',
      logger,
    });

    const event = makeEvent({ triggerSource: 'PostConfirmation_ConfirmForgotPassword' });
    const returned = await handler(event);

    assert.equal(returned, event);
    assert.equal(ddb.commands.length, 0, 'Không được ghi DynamoDB với nguồn khác ConfirmSignUp');
    assert.equal(cognitoCalls.length, 0, 'Không được gọi AdminUpdateUserAttributes');
  });

  it('[E.3] gọi lại lần 2 cùng sub (Idempotent) -> không tạo tenant thứ hai, không làm hỏng dữ liệu cũ', async () => {
    const ddb = createStatefulMockDdb();
    const cognitoCalls: AdminUpdateUserAttributesCommand[] = [];
    const cognito = {
      async send(cmd: AdminUpdateUserAttributesCommand) {
        cognitoCalls.push(cmd);
        return {};
      },
    };
    const logger = createFakeLogger();

    const handler = createPostConfirmationHandler({
      ddbClient: ddb,
      cognitoClient: cognito,
      tableName: 'TranslateMeTable',
      logger,
    });

    const firstEvent = makeEvent();
    await handler(firstEvent);
    assert.equal(ddb.store.size, 2, 'Sau lần 1 bảng chỉ có đúng 2 bản ghi (1 CONFIG + 1 MEMBER)');

    // Lần 2: giả sử Cognito retry cùng sub (thậm chí clientMetadata khác đi), không được ghi đè hay sinh tenant thứ 2
    const retryEvent = makeEvent({
      request: {
        userAttributes: { sub: 'user-sub-001', email: 'Founder@Acme.io' },
        clientMetadata: { organization_name: 'Corrupted Org Name On Retry' },
      },
    });
    await handler(retryEvent);

    assert.equal(ddb.store.size, 2, 'Sau lần gọi thứ 2 vẫn chỉ có đúng 2 bản ghi, không tạo tenant thứ hai');
    const tenantId = generateTenantId('user-sub-001', 'ap-southeast-1_TestPool123');
    const savedConfig = ddb.store.get(`TENANT#${tenantId}::CONFIG`) as {
      organizationName?: { S?: string };
    };
    assert.equal(savedConfig.organizationName?.S, 'Acme Corp', 'Dữ liệu cũ của tenant không bị ghi đè');
    assert.equal(logger.warns.length, 1);
    assert.equal(logger.warns[0].action, 'IDEMPOTENT_REPLAY_DETECTED');

    // Cả 2 lần gọi AdminUpdateUserAttributes đều gắn cùng 1 tenant_id
    assert.equal(cognitoCalls.length, 2);
    assert.deepEqual(cognitoCalls[0].input.UserAttributes, cognitoCalls[1].input.UserAttributes);
  });

  it('[E.4] DynamoDB lỗi (ví dụ ProvisionedThroughputExceeded / AccessDenied) -> handler ném lỗi và ghi log JSON có cấu trúc', async () => {
    const ddbError = Object.assign(new Error('ProvisionedThroughputExceededException: Rate exceeded'), {
      name: 'ProvisionedThroughputExceededException',
    });
    const ddb = {
      async send(): Promise<never> {
        throw ddbError;
      },
    };
    const cognitoCalls: AdminUpdateUserAttributesCommand[] = [];
    const cognito = {
      async send(cmd: AdminUpdateUserAttributesCommand) {
        cognitoCalls.push(cmd);
        return {};
      },
    };
    const logger = createFakeLogger();

    const handler = createPostConfirmationHandler({
      ddbClient: ddb,
      cognitoClient: cognito,
      tableName: 'TranslateMeTable',
      logger,
    });

    await assert.rejects(() => handler(makeEvent()), /ProvisionedThroughputExceededException/);

    assert.equal(cognitoCalls.length, 0, 'Khi DynamoDB thất bại thì không được gán tenant_id rỗng/lỗi lên Cognito');
    assert.equal(logger.errors.length, 1, 'Phải ghi log lỗi có cấu trúc');
    assert.equal(logger.errors[0].action, 'DYNAMODB_TRANSACT_FAILED');
    assert.equal(logger.errors[0].errorName, 'ProvisionedThroughputExceededException');
  });

  it('Cognito AdminUpdateUserAttributes lỗi -> handler ném lỗi và ghi log lỗi', async () => {
    const ddb = createStatefulMockDdb();
    const cognito = {
      async send(): Promise<never> {
        throw Object.assign(new Error('TooManyRequestsException'), { name: 'TooManyRequestsException' });
      },
    };
    const logger = createFakeLogger();

    const handler = createPostConfirmationHandler({
      ddbClient: ddb,
      cognitoClient: cognito,
      tableName: 'TranslateMeTable',
      logger,
    });

    await assert.rejects(() => handler(makeEvent()), /TooManyRequestsException/);
    assert.equal(logger.errors.length, 1);
    assert.equal(logger.errors[0].action, 'COGNITO_UPDATE_ATTRIBUTES_FAILED');
  });

  it('extractOrganizationName hỗ trợ cả clientMetadata lẫn userAttributes và fallback theo email', () => {
    const fromMeta = makeEvent({
      request: {
        userAttributes: { sub: '1', email: 'a@b.com', name: 'Attr Name' },
        clientMetadata: { organization_name: 'Meta Org' },
      },
    });
    assert.equal(extractOrganizationName(fromMeta), 'Meta Org');

    const fromAttr = makeEvent({
      request: {
        userAttributes: { sub: '1', email: 'a@b.com', 'custom:org_name': 'Custom Attr Org' },
        clientMetadata: {},
      },
    });
    assert.equal(extractOrganizationName(fromAttr), 'Custom Attr Org');

    const fallback = makeEvent({
      request: {
        userAttributes: { sub: '1', email: 'alice@company.vn' },
        clientMetadata: {},
      },
    });
    assert.equal(extractOrganizationName(fallback), "alice's Organization");
  });

  it('sanitizeLogFields loại bỏ hoàn toàn password / confirmationCode / secret nếu có', () => {
    const cleaned = sanitizeLogFields({
      sub: 'user-1',
      password: 'SecretPassword123',
      confirmationCode: '123456',
      accessToken: 'jwt-token',
      tenantId: 't_abc',
    });
    assert.deepEqual(cleaned, { sub: 'user-1', tenantId: 't_abc' });
  });
});

// ============================================================================
// 2. Test inviteMember (Mục C & E.5)
// ============================================================================

describe('inviteMember', () => {
  it('[E.5a] sai role (Tenant Admin, Platform Admin, role lạ) -> bị từ chối, không gọi Cognito', async () => {
    const calls: AdminCreateUserCommand[] = [];
    const cognito = {
      async send(cmd: AdminCreateUserCommand) {
        calls.push(cmd);
        return {};
      },
    };

    for (const invalidRole of [ROLES.TENANT_ADMIN, 'PLATFORM_ADMIN', 'SuperAdmin', '', 'admin']) {
      await assert.rejects(
        () =>
          inviteMember('t_123456', 'dev@acme.io', invalidRole, {
            cognitoClient: cognito,
            userPoolId: 'ap-southeast-1_Pool',
          }),
        /Role không hợp lệ/,
        `Phải từ chối role: ${invalidRole}`,
      );
    }

    assert.equal(calls.length, 0, 'Không được gọi AdminCreateUser khi role không hợp lệ');
  });

  it('[E.5b] đúng role (Developer / Reviewer) -> gọi AdminCreateUser đúng tham số', async () => {
    for (const validRole of INVITABLE_ROLES) {
      const calls: AdminCreateUserCommand[] = [];
      const cognito = {
        async send(cmd: AdminCreateUserCommand) {
          calls.push(cmd);
          return {
            User: {
              Username: 'member@acme.io',
              UserStatus: 'FORCE_CHANGE_PASSWORD',
              Attributes: [{ Name: 'sub', Value: 'invited-sub-999' }],
            },
          };
        },
      };

      const res = await inviteMember('t_tenant_abc', '  Member@Acme.io ', validRole, {
        cognitoClient: cognito,
        userPoolId: 'ap-southeast-1_Pool',
        tempPasswordGenerator: () => 'TempPass#2026Abc',
      });

      assert.equal(calls.length, 1);
      const input = calls[0].input;
      assert.equal(input.UserPoolId, 'ap-southeast-1_Pool');
      assert.equal(input.Username, 'member@acme.io');
      assert.equal(input.TemporaryPassword, 'TempPass#2026Abc');
      assert.equal(input.MessageAction, undefined, 'Không được đặt SUPPRESS để Cognito gửi email mời');
      assert.deepEqual(input.DesiredDeliveryMediums, ['EMAIL']);
      assert.deepEqual(input.UserAttributes, [
        { Name: 'email', Value: 'member@acme.io' },
        { Name: 'email_verified', Value: 'true' },
        { Name: COGNITO_CUSTOM_ATTRIBUTES.TENANT_ID, Value: 't_tenant_abc' },
        { Name: COGNITO_CUSTOM_ATTRIBUTES.ROLE, Value: claimForRole(validRole) },
      ]);

      assert.equal(res.userSub, 'invited-sub-999');
      assert.equal(res.userStatus, 'FORCE_CHANGE_PASSWORD');
      assert.equal(res.role, validRole);
      assert.equal(res.tenantId, 't_tenant_abc');
    }
  });

  it('generateTemporaryPassword luôn sinh mật khẩu >= 12 ký tự gồm chữ hoa, chữ thường, chữ số', () => {
    for (let i = 0; i < 20; i++) {
      const pwd = generateTemporaryPassword();
      assert.ok(pwd.length >= 12);
      assert.match(pwd, /[A-Z]/, 'Phải có chữ hoa');
      assert.match(pwd, /[a-z]/, 'Phải có chữ thường');
      assert.match(pwd, /[0-9]/, 'Phải có chữ số');
    }
  });

  it('isInvitableRole chỉ trả true cho Developer và Reviewer', () => {
    assert.equal(isInvitableRole(ROLES.DEVELOPER), true);
    assert.equal(isInvitableRole(ROLES.REVIEWER), true);
    assert.equal(isInvitableRole(ROLES.TENANT_ADMIN), false);
    assert.equal(isInvitableRole('PLATFORM_ADMIN'), false);
  });
});
