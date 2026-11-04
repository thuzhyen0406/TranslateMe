import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createTenantDocumentClientRouter, tenantSessionPolicy } from '../tenantAws.js';

describe('tenant-scoped AWS sessions', () => {
  it('session policy limits LeadingKeys to one tenant plus slug reservations', () => {
    const policy = JSON.parse(tenantSessionPolicy('t_aaaaaaaaaaaaaaaaaaaaaaaa'));
    assert.ok(policy.Statement[0].Action.includes('dynamodb:TransactWriteItems'));
    const keys = policy.Statement[0].Condition['ForAllValues:StringLike']['dynamodb:LeadingKeys'];
    assert.deepEqual(keys, [
      'TENANT#t_aaaaaaaaaaaaaaaaaaaaaaaa',
      'TENANT#t_aaaaaaaaaaaaaaaaaaaaaaaa#*',
      'TENANT#PLATFORM#SLUG#*',
    ]);
    assert.ok(!keys.some((key: string) => key.includes('t_*')));
    assert.throws(() => tenantSessionPolicy('t_bad#other'), /Invalid tenant ID/);
  });

  it('IAM tenant role grants TransactWriteItems', () => {
    const iamTemplate = readFileSync(resolve(process.cwd(), '../../infra/modules/iam.yaml'), 'utf8');
    assert.match(iamTemplate, /dynamodb:TransactWriteItems/);
  });

  it('session policy scopes S3 objects to the requesting tenant prefix', () => {
    const policy = JSON.parse(tenantSessionPolicy('t_aaaaaaaaaaaaaaaaaaaaaaaa', {
      payloadBucketArn: 'arn:aws:s3:::payloads',
      batchUploadBucketArn: 'arn:aws:s3:::uploads',
    }));
    assert.equal(policy.Statement[1].Resource, 'arn:aws:s3:::payloads/worker/t_aaaaaaaaaaaaaaaaaaaaaaaa/*');
    assert.equal(policy.Statement[2].Resource, 'arn:aws:s3:::uploads/batch/t_aaaaaaaaaaaaaaaaaaaaaaaa/*');
  });

  it('routes tenant data to an STS session and platform mappings to the execution role', async () => {
    const routed: string[] = [];
    const assumed: string[] = [];
    const router = createTenantDocumentClientRouter({
      async send(command: never) { routed.push('base'); return command; },
    }, {
      roleArn: 'arn:aws:iam::123456789012:role/tenant-data',
      sts: {
        async send(command: never) {
          assumed.push('t_aaaaaaaaaaaaaaaaaaaaaaaa');
          return { Credentials: { AccessKeyId: 'a', SecretAccessKey: 's', SessionToken: 't', Expiration: new Date(Date.now() + 60_000) } } as never;
        },
      } as never,
      createClient: (credentials) => ({ async send(command: never) { await credentials(); routed.push('tenant'); return command; } }),
    });

    await router.send({ input: { Key: { PK: 'TENANT#t_aaaaaaaaaaaaaaaaaaaaaaaa', SK: 'CONFIG' } } } as never);
    await router.send({ input: { Key: { PK: 'TENANT#PLATFORM#SLUG#site-a', SK: 'META' } } } as never);
    assert.deepEqual(routed, ['tenant', 'base']);
    assert.deepEqual(assumed, ['t_aaaaaaaaaaaaaaaaaaaaaaaa']);
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
