import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createTenantDocumentClientRouter, tenantSessionPolicy } from '../tenantAws.js';

function findRepositoryRoot(): string {
  let cur = process.cwd();
  while (cur && cur !== resolve(cur, '..')) {
    if (existsSync(resolve(cur, 'infra/modules/iam.yaml'))) return cur;
    cur = resolve(cur, '..');
  }
  return resolve(process.cwd(), '..');
}

describe('tenant-scoped AWS sessions', () => {
  it('session policy limits LeadingKeys to one tenant without platform slug reservations', () => {
    const policy = JSON.parse(tenantSessionPolicy('t_aaaaaaaaaaaaaaaaaaaaaaaa'));
    assert.ok(policy.Statement[0].Action.includes('dynamodb:PutItem'));
    assert.ok(policy.Statement[0].Action.includes('dynamodb:ConditionCheckItem'));
    const keys = policy.Statement[0].Condition['ForAllValues:StringLike']['dynamodb:LeadingKeys'];
    assert.deepEqual(keys, [
      'TENANT#t_aaaaaaaaaaaaaaaaaaaaaaaa',
      'TENANT#t_aaaaaaaaaaaaaaaaaaaaaaaa#*',
    ]);
    assert.equal(policy.Statement[0].Condition.Null['dynamodb:LeadingKeys'], 'false');
    assert.ok(!keys.some((key: string) => key.includes('t_*')));
    assert.throws(() => tenantSessionPolicy('t_bad#other'), /Invalid tenant ID/);
  });

  it('only enables platform slug reservations when explicitly requested', () => {
    const policy = JSON.parse(tenantSessionPolicy('t_aaaaaaaaaaaaaaaaaaaaaaaa', {
      allowPlatformSlugReservation: true,
      platformSlugReservationKey: 'TENANT#PLATFORM#SLUG#example-com',
    }));
    const keys = policy.Statement[0].Condition['ForAllValues:StringLike']['dynamodb:LeadingKeys'];
    assert.deepEqual(keys, [
      'TENANT#t_aaaaaaaaaaaaaaaaaaaaaaaa',
      'TENANT#t_aaaaaaaaaaaaaaaaaaaaaaaa#*',
      'TENANT#PLATFORM#SLUG#example-com',
    ]);
    assert.throws(() => tenantSessionPolicy('t_aaaaaaaaaaaaaaaaaaaaaaaa', {
      allowPlatformSlugReservation: true,
      platformSlugReservationKey: 'TENANT#PLATFORM#SLUG#*',
    }), /Invalid platform slug reservation key/);
  });

  it('IAM tenant role grants transaction item actions and requires session tags', () => {
    const repositoryRoot = findRepositoryRoot();
    const iamTemplate = readFileSync(resolve(repositoryRoot, 'infra/modules/iam.yaml'), 'utf8');
    assert.match(iamTemplate, /dynamodb:ConditionCheckItem/);
    assert.match(iamTemplate, /sts:TagSession/);
    assert.match(iamTemplate, /aws:RequestTag\/TenantId/);
    assert.match(iamTemplate, /dynamodb:TransactWriteItems/);
    
    const websiteTransaction = iamTemplate.match(/Sid: WebsiteTenantAndSlugTransaction[\s\S]*?(?=\n              - Sid:|\n  [A-Z])/);
    assert.ok(websiteTransaction, 'website transaction IAM statement exists');
    assert.match(websiteTransaction[0], /dynamodb:PutItem/);
    assert.match(websiteTransaction[0], /dynamodb:ConditionCheckItem/);
    assert.match(websiteTransaction[0], /dynamodb:TransactWriteItems/);
    assert.match(websiteTransaction[0], /Resource: !Ref TableArn/);
    assert.match(websiteTransaction[0], /TENANT#\$\{aws:PrincipalTag\/TenantId\}#\*/);
    assert.match(websiteTransaction[0], /TENANT#PLATFORM#SLUG#\*/);
    assert.doesNotMatch(websiteTransaction[0], /dynamodb:(?:DeleteItem|UpdateItem)/);
  });

  it('IAM tenant role stays tenant-scoped even without an STS session policy', () => {
    const repositoryRoot = findRepositoryRoot();
    const iamTemplate = readFileSync(resolve(repositoryRoot, 'infra/modules/iam.yaml'), 'utf8');
    const tenantRole = iamTemplate.match(/  TenantDataAccessRole:[\s\S]*?(?=\n  TenantPayloadAccessRole:)/);
    assert.ok(tenantRole, 'TenantDataAccessRole exists');
    // AssumeRole/TagSession bắt buộc session tag TenantId dạng t_*; SetSourceIdentity bắt buộc source identity t_*.
    assert.match(tenantRole[0], /Sid: AssumeWithTenantSessionTag[\s\S]*?- sts:TagSession[\s\S]*?aws:RequestTag\/TenantId: 't_\*'[\s\S]*?aws:TagKeys:\s*\n\s*- TenantId/);
    assert.match(tenantRole[0], /Sid: SetTenantSourceIdentity[\s\S]*?Action: sts:SetSourceIdentity[\s\S]*?sts:SourceIdentity: 't_\*'/);
    assert.match(tenantRole[0], /translateme-\$\{StageName\}-post-confirmation/);
    // Biến ${sts:SourceIdentity} trong điều kiện làm STS trả AccessDenied trên AWS thật: không dùng lại.
    assert.doesNotMatch(iamTemplate, /'\$\{sts:SourceIdentity\}'/);
    assert.match(tenantRole[0], /dynamodb:LeadingKeys:[\s\S]*?'TENANT#\$\{aws:PrincipalTag\/TenantId\}'/);
    // Khóa phải đặt trong ngoặc ('Null':) – không thì YAML hiểu là null và CloudFormation từ chối template
    assert.match(tenantRole[0], /'Null':\s*\n\s*dynamodb:LeadingKeys: 'false'/);
    assert.match(tenantRole[0], /\/batch\/\$\{!aws:PrincipalTag\/TenantId\}\/input\/\*/);
    assert.match(tenantRole[0], /\/batch\/\$\{!aws:PrincipalTag\/TenantId\}\/results\/\*/);
    assert.doesNotMatch(tenantRole[0], /TENANT#t_\*|\/batch\/\*\/\*/);
  });

  it('defines HostSlugResource as a valid child of HostsResource', () => {
    const repositoryRoot = findRepositoryRoot();
    const template = readFileSync(resolve(repositoryRoot, 'infra/modules/api-gateway.yaml'), 'utf8');
    const slugResource = template.match(/  HostSlugResource:\s*([\s\S]*?)(?=\n  [A-Za-z][A-Za-z0-9]+:|\s*$)/);
    assert.ok(slugResource, 'HostSlugResource exists');
    assert.match(slugResource[1], /Type: AWS::ApiGateway::Resource/);
    assert.match(slugResource[1], /ParentId: !Ref HostsResource/);
    assert.match(slugResource[1], /PathPart: '\{slug\}'/);
    assert.doesNotMatch(template, /  HostsProxyResource:/);
  });

  it('keeps application AssumeRole calls behind the tenant-policy helper', () => {
    const repositoryRoot = findRepositoryRoot();
    const sourceRoots = [resolve(repositoryRoot, 'libs'), resolve(repositoryRoot, 'services')];
    const findings: string[] = [];
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory)) {
        const fullPath = resolve(directory, entry);
        if (statSync(fullPath).isDirectory()) {
          if (entry !== 'node_modules' && entry !== 'dist' && entry !== 'test') visit(fullPath);
        } else if (/\.(?:ts|js|mts|cts)$/.test(entry)) {
          if (/new\s+AssumeRoleCommand\s*\(/.test(readFileSync(fullPath, 'utf8'))) findings.push(fullPath);
        }
      }
    };
    sourceRoots.forEach(visit);
    assert.deepEqual(findings, [resolve(repositoryRoot, 'libs/common/tenantAws.ts')]);
    const helper = readFileSync(resolve(repositoryRoot, 'libs/common/tenantAws.ts'), 'utf8');
    assert.match(helper, /function createTenantCredentialsProvider\(/);
    assert.doesNotMatch(helper, /export\s+function\s+createTenantCredentialsProvider\(/);
  });

  it('session policy scopes S3 objects and KMS keys to the requesting tenant', () => {
    const policy = JSON.parse(tenantSessionPolicy('t_aaaaaaaaaaaaaaaaaaaaaaaa', {
      payloadBucketArn: 'arn:aws:s3:::payloads',
      payloadBucketKmsKeyArn: 'arn:aws:kms:ap-southeast-1:123456789012:key/payload',
      batchUploadBucketArn: 'arn:aws:s3:::uploads',
      batchUploadKmsKeyArn: 'arn:aws:kms:ap-southeast-1:123456789012:key/batch',
    }));
    const payloadObjects = policy.Statement.find((statement: any) => statement.Resource === 'arn:aws:s3:::payloads/tenant/t_aaaaaaaaaaaaaaaaaaaaaaaa/worker/*');
    const payloadKms = policy.Statement.find((statement: any) => statement.Resource === 'arn:aws:kms:ap-southeast-1:123456789012:key/payload');
    const batchObjects = policy.Statement.find((statement: any) => statement.Resource === 'arn:aws:s3:::uploads/batch/t_aaaaaaaaaaaaaaaaaaaaaaaa/*');
    const batchKms = policy.Statement.find((statement: any) => statement.Resource === 'arn:aws:kms:ap-southeast-1:123456789012:key/batch');
    assert.deepEqual(payloadObjects.Action, ['s3:GetObject', 's3:PutObject']);
    assert.deepEqual(payloadKms.Action, ['kms:Decrypt', 'kms:GenerateDataKey']);
    assert.equal(payloadKms.Condition.StringEquals['kms:EncryptionContext:aws:s3:arn'], 'arn:aws:s3:::payloads');
    assert.deepEqual(batchObjects.Action, ['s3:GetObject', 's3:GetObjectVersion', 's3:PutObject']);
    assert.deepEqual(batchKms.Action, ['kms:Decrypt', 'kms:GenerateDataKey']);
    assert.equal(batchKms.Condition.StringEquals['kms:EncryptionContext:aws:s3:arn'], 'arn:aws:s3:::uploads');
  });

    it('routes tenant data to an STS session and platform mappings to the execution role', async () => {
    const routed: string[] = [];
    const assumed: string[] = [];
    const assumeInputs: Array<Record<string, any>> = [];
    const router = createTenantDocumentClientRouter({
      async send(command: never) { routed.push('base'); return command; },
    }, {
      roleArn: 'arn:aws:iam::123456789012:role/tenant-data',
      sts: {
        async send(command: never) {
          assumed.push('t_aaaaaaaaaaaaaaaaaaaaaaaa');
          assumeInputs.push((command as any).input);
          return { Credentials: { AccessKeyId: 'a', SecretAccessKey: 's', SessionToken: 't', Expiration: new Date(Date.now() + 60_000) } } as never;
        },
      } as never,
      createClient: (credentials) => ({ async send(command: never) { await credentials(); routed.push('tenant'); return command; } }),
    });

    await router.send({ input: { Key: { PK: 'TENANT#t_aaaaaaaaaaaaaaaaaaaaaaaa', SK: 'CONFIG' } } } as never);
    await router.send({ input: { Key: { PK: 'TENANT#PLATFORM#SLUG#site-a', SK: 'META' } } } as never);
    assert.deepEqual(routed, ['tenant', 'base']);
    assert.deepEqual(assumed, ['t_aaaaaaaaaaaaaaaaaaaaaaaa']);
    assert.equal(assumeInputs[0].SourceIdentity, 't_aaaaaaaaaaaaaaaaaaaaaaaa');
    assert.deepEqual(assumeInputs[0].Tags, [{ Key: 'TenantId', Value: 't_aaaaaaaaaaaaaaaaaaaaaaaa' }]);
    assert.equal(typeof assumeInputs[0].Policy, 'string');
    assert.deepEqual(JSON.parse(String(assumeInputs[0].Policy)).Statement[0].Condition['ForAllValues:StringLike']['dynamodb:LeadingKeys'], [
      'TENANT#t_aaaaaaaaaaaaaaaaaaaaaaaa',
      'TENANT#t_aaaaaaaaaaaaaaaaaaaaaaaa#*',
    ]);
  });

  it('session policy chỉ thêm đúng một KEYMAP khi được yêu cầu, từ chối wildcard', () => {
    const policy = JSON.parse(tenantSessionPolicy('t_aaaaaaaaaaaaaaaaaaaaaaaa', {
      allowPlatformKeyMapping: true,
      platformKeyMappingKey: 'TENANT#PLATFORM#KEY#bnmg6djftd',
    }));
    assert.deepEqual(policy.Statement[0].Condition['ForAllValues:StringLike']['dynamodb:LeadingKeys'], [
      'TENANT#t_aaaaaaaaaaaaaaaaaaaaaaaa',
      'TENANT#t_aaaaaaaaaaaaaaaaaaaaaaaa#*',
      'TENANT#PLATFORM#KEY#bnmg6djftd',
    ]);
    for (const bad of ['TENANT#PLATFORM#KEY#*', 'TENANT#PLATFORM#KEY#', 'TENANT#PLATFORM#SLUG#site-a', undefined]) {
      assert.throws(() => tenantSessionPolicy('t_aaaaaaaaaaaaaaaaaaaaaaaa', {
        allowPlatformKeyMapping: true,
        platformKeyMappingKey: bad,
      }), /Invalid platform key mapping key/);
    }
  });

  it('giao dịch APIKEY + KEYMAP: chỉ khi bật allowPlatformKeyMappings mới kèm KEYMAP vào session policy', async () => {
    const transact = { input: { TransactItems: [
      { Put: { Item: { PK: 'TENANT#t_aaaaaaaaaaaaaaaaaaaaaaaa#APIKEY', SK: 'KEY#bnmg6djftd' } } },
      { Put: { Item: { PK: 'TENANT#PLATFORM#KEY#bnmg6djftd', SK: 'META', tenantId: 't_aaaaaaaaaaaaaaaaaaaaaaaa' } } },
    ] } };
    const leadingKeysFor = async (allowPlatformKeyMappings: boolean) => {
      const policies: string[] = [];
      const router = createTenantDocumentClientRouter({ async send() { assert.fail('không được dùng role thực thi'); } }, {
        roleArn: 'arn:aws:iam::123456789012:role/tenant-data',
        allowPlatformKeyMappings,
        sts: {
          async send(command: never) {
            policies.push(String((command as any).input.Policy));
            return { Credentials: { AccessKeyId: 'a', SecretAccessKey: 's', SessionToken: 't', Expiration: new Date(Date.now() + 60_000) } } as never;
          },
        } as never,
        createClient: (credentials) => ({ async send(command: never) { await credentials(); return command; } }),
      });
      await router.send(transact as never);
      return JSON.parse(policies[0]).Statement[0].Condition['ForAllValues:StringLike']['dynamodb:LeadingKeys'];
    };
    assert.deepEqual(await leadingKeysFor(true), [
      'TENANT#t_aaaaaaaaaaaaaaaaaaaaaaaa',
      'TENANT#t_aaaaaaaaaaaaaaaaaaaaaaaa#*',
      'TENANT#PLATFORM#KEY#bnmg6djftd',
    ]);
    assert.deepEqual(await leadingKeysFor(false), [
      'TENANT#t_aaaaaaaaaaaaaaaaaaaaaaaa',
      'TENANT#t_aaaaaaaaaaaaaaaaaaaaaaaa#*',
    ]);

    const router = createTenantDocumentClientRouter({ async send() { assert.fail('không được gửi lệnh'); } }, {
      roleArn: 'arn:aws:iam::123456789012:role/tenant-data',
      allowPlatformKeyMappings: true,
      sts: { async send() { assert.fail('không được assume role'); } } as never,
      createClient: () => ({ async send() { assert.fail('không được gửi lệnh'); } }),
    });
    await assert.rejects(router.send({ input: { TransactItems: [
      { Put: { Item: { PK: 'TENANT#t_aaaaaaaaaaaaaaaaaaaaaaaa#APIKEY', SK: 'KEY#k1' } } },
      { Put: { Item: { PK: 'TENANT#PLATFORM#KEY#k1', SK: 'META' } } },
      { Put: { Item: { PK: 'TENANT#PLATFORM#KEY#k2', SK: 'META' } } },
    ] } } as never), /cannot span platform key mappings/);
  });

  it('IAM: role tenant-data cho phép KEYMAP, Lambda Console bật ALLOW_PLATFORM_KEY_MAPPING', () => {
    const repositoryRoot = findRepositoryRoot();
    const iamTemplate = readFileSync(resolve(repositoryRoot, 'infra/modules/iam.yaml'), 'utf8');
    const tenantRole = iamTemplate.match(/  TenantDataAccessRole:[\s\S]*?(?=\n  TenantPayloadAccessRole:)/);
    assert.ok(tenantRole);
    assert.match(tenantRole[0], /dynamodb:LeadingKeys:[\s\S]*?- 'TENANT#PLATFORM#KEY#\*'/);
    const lambdas = readFileSync(resolve(repositoryRoot, 'infra/modules/lambdas.yaml'), 'utf8').replace(/\r\n/g, '\n');
    const consoleFn = lambdas.match(/  ConsoleFunction:[\s\S]*?(?=\n  [A-Z][A-Za-z]+:\n)/);
    assert.ok(consoleFn);
    assert.match(consoleFn[0], /ALLOW_PLATFORM_KEY_MAPPING: 'true'/);
    assert.equal((lambdas.match(/ALLOW_PLATFORM_KEY_MAPPING/g) ?? []).length, 1, 'chỉ Lambda Console bật');
  });

  it('từ chối giao dịch có partition key của nhiều tenant', async () => {
    const router = createTenantDocumentClientRouter({ async send() { assert.fail('không được gửi lệnh'); } }, {
      roleArn: 'arn:aws:iam::123456789012:role/tenant-data',
      sts: { async send() { assert.fail('không được assume role'); } } as never,
      createClient: () => ({ async send() { assert.fail('không được gửi lệnh'); } }),
    });
    await assert.rejects(router.send({ input: { TransactItems: [
      { Put: { Item: { PK: 'TENANT#t_aaaaaaaaaaaaaaaaaaaaaaaa', SK: 'CONFIG' } } },
      { Put: { Item: { PK: 'TENANT#t_bbbbbbbbbbbbbbbbbbbbbbbb', SK: 'CONFIG' } } },
    ] } } as never), /cannot span tenant partitions/);
  });
});
