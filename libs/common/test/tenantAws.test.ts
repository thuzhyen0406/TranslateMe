import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createTenantDocumentClientRouter, tenantSessionPolicy } from '../tenantAws.js';

describe('tenant-scoped AWS sessions', () => {
  it('session policy limits LeadingKeys to one tenant without platform slug reservations', () => {
    const policy = JSON.parse(tenantSessionPolicy('t_aaaaaaaaaaaaaaaaaaaaaaaa'));
    assert.ok(policy.Statement[0].Action.includes('dynamodb:PutItem'));
    assert.ok(policy.Statement[0].Action.includes('dynamodb:ConditionCheckItem'));
    assert.ok(!policy.Statement[0].Action.includes('dynamodb:TransactWriteItems'));
    const keys = policy.Statement[0].Condition['ForAllValues:StringLike']['dynamodb:LeadingKeys'];
    assert.deepEqual(keys, [
      'TENANT#t_aaaaaaaaaaaaaaaaaaaaaaaa',
      'TENANT#t_aaaaaaaaaaaaaaaaaaaaaaaa#*',
    ]);
    assert.ok(!keys.some((key: string) => key.includes('t_*')));
    assert.throws(() => tenantSessionPolicy('t_bad#other'), /Invalid tenant ID/);
  });

  it('only enables platform slug reservations when explicitly requested', () => {
    const policy = JSON.parse(tenantSessionPolicy('t_aaaaaaaaaaaaaaaaaaaaaaaa', {
      allowPlatformSlugReservation: true,
    }));
    assert.deepEqual(policy.Statement[1], {
      Effect: 'Allow',
      Action: 'dynamodb:TransactWriteItems',
      Resource: '*',
      Condition: {
        'ForAllValues:StringLike': {
          'dynamodb:LeadingKeys': [
            'TENANT#t_aaaaaaaaaaaaaaaaaaaaaaaa',
            'TENANT#t_aaaaaaaaaaaaaaaaaaaaaaaa#*',
            'TENANT#PLATFORM#SLUG#*',
          ],
        },
      },
    });
  });

  it('IAM tenant role grants TransactWriteItems and requires session tags', () => {
    const iamTemplate = readFileSync(resolve(process.cwd(), '../../infra/modules/iam.yaml'), 'utf8');
    assert.match(iamTemplate, /dynamodb:TransactWriteItems/);
    assert.match(iamTemplate, /sts:TagSession/);
    assert.match(iamTemplate, /aws:RequestTag\/TenantId/);
    
    const websiteTransaction = iamTemplate.match(/Sid: WebsiteTenantAndSlugTransaction[\s\S]*?(?=\n              - Sid:|\n  [A-Z])/);
    assert.ok(websiteTransaction, 'website transaction IAM statement exists');
    assert.match(websiteTransaction[0], /dynamodb:PutItem/);
    assert.match(websiteTransaction[0], /dynamodb:ConditionCheckItem/);
    assert.doesNotMatch(websiteTransaction[0], /dynamodb:(?:DeleteItem|UpdateItem)/);
  });
  });

  it('session policy scopes S3 objects to the requesting tenant prefix', () => {
    const policy = JSON.parse(tenantSessionPolicy('t_aaaaaaaaaaaaaaaaaaaaaaaa', {
      payloadBucketArn: 'arn:aws:s3:::payloads',
      batchUploadBucketArn: 'arn:aws:s3:::uploads',
      batchUploadKmsKeyArn: 'arn:aws:kms:ap-southeast-1:123456789012:key/batch',
    }));
    assert.equal(policy.Statement[1].Resource, 'arn:aws:s3:::payloads/tenant/t_aaaaaaaaaaaaaaaaaaaaaaaa/worker/*');
    assert.equal(policy.Statement[2].Resource, 'arn:aws:s3:::uploads/batch/t_aaaaaaaaaaaaaaaaaaaaaaaa/input/*');
    assert.deepEqual(policy.Statement[2].Action, ['s3:GetObject', 's3:PutObject']);
    assert.equal(policy.Statement[3].Resource, 'arn:aws:kms:ap-southeast-1:123456789012:key/batch');
    assert.deepEqual(policy.Statement[3].Action, ['kms:Decrypt', 'kms:GenerateDataKey']);
  });

  it('routes tenant data to an STS session and platform mappings to the execution role', async () => {
    const routed: string[] = [];
    const assumed: string[] = [];
    const assumeCommands: Array<{ input: { SourceIdentity?: string; Tags?: Array<{ Key: string; Value: string }>; Policy?: string } }> = [];
    const router = createTenantDocumentClientRouter({
      async send(command: never) { routed.push('base'); return command; },
    }, {
      roleArn: 'arn:aws:iam::123456789012:role/tenant-data',
      sts: {
        async send(command: never) {
          assumed.push('t_aaaaaaaaaaaaaaaaaaaaaaaa');
          assumeCommands.push(command as typeof assumeCommands[number]);
          return { Credentials: { AccessKeyId: 'a', SecretAccessKey: 's', SessionToken: 't', Expiration: new Date(Date.now() + 60_000) } } as never;
        },
      } as never,
      createClient: (credentials) => ({ async send(command: never) { await credentials(); routed.push('tenant'); return command; } }),
    });

    await router.send({ input: { Key: { PK: 'TENANT#t_aaaaaaaaaaaaaaaaaaaaaaaa', SK: 'CONFIG' } } } as never);
    await router.send({ input: { Key: { PK: 'TENANT#PLATFORM#SLUG#site-a', SK: 'META' } } } as never);
    assert.deepEqual(routed, ['tenant', 'base']);
        assert.deepEqual(assumed, ['t_aaaaaaaaaaaaaaaaaaaaaaaa']);
    assert.equal(assumeCommands[0].input.SourceIdentity, 't_aaaaaaaaaaaaaaaaaaaaaaaa');
    assert.deepEqual(assumeCommands[0].input.Tags, [{ Key: 'TenantId', Value: 't_aaaaaaaaaaaaaaaaaaaaaaaa' }]);
    assert.ok(assumeCommands[0].input.Policy);
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
