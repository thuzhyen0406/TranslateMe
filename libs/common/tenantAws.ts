import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';

type SendClient = Pick<DynamoDBDocumentClient, 'send'>;
type AwsCommand = { input?: Record<string, unknown> };
type TenantCredentials = { accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration?: Date };
type TenantCredentialsProvider = () => Promise<TenantCredentials>;

function tenantFromPartitionKey(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.startsWith('TENANT#')) return undefined;
  const id = value.slice('TENANT#'.length).split('#', 1)[0];
  return /^t_[A-Za-z0-9_-]{1,64}$/.test(id) ? id : undefined;
}

function collectPartitionKeys(value: unknown, keys: Set<string>): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectPartitionKeys(item, keys);
    return;
  }
  for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
    if (name === 'PK' || name === ':pk' || name === ':gsi2pk' || name === ':gsi3pk') {
      const partitionKey = child && typeof child === 'object' && 'S' in child
        ? (child as { S?: unknown }).S
        : child;
      const tenant = tenantFromPartitionKey(partitionKey);
      if (tenant) keys.add(tenant);
    }
    collectPartitionKeys(child, keys);
  }
}

/** Restricts an STS session to one tenant partition and its payload object prefixes. */
export function tenantSessionPolicy(
  tenantId: string,
  buckets: { payloadBucketArn?: string; batchUploadBucketArn?: string; batchUploadKmsKeyArn?: string } = {},
): string {
  if (!/^t_[A-Za-z0-9_-]{1,64}$/.test(tenantId)) throw new TypeError('Invalid tenant ID');
  const statements: Array<Record<string, unknown>> = [{
    Effect: 'Allow',
    Action: [
      'dynamodb:GetItem', 'dynamodb:BatchGetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem',
      'dynamodb:DeleteItem', 'dynamodb:Query', 'dynamodb:ConditionCheckItem', 'dynamodb:BatchWriteItem',
      'dynamodb:TransactWriteItems',
    ],
    Resource: '*',
    Condition: {
      'ForAllValues:StringLike': {
        'dynamodb:LeadingKeys': [`TENANT#${tenantId}`, `TENANT#${tenantId}#*`, 'TENANT#PLATFORM#SLUG#*'],
      },
    },
  }];
  if (buckets.payloadBucketArn) {
    statements.push({ Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject'], Resource: `${buckets.payloadBucketArn}/worker/${tenantId}/*` });
  }
  if (buckets.batchUploadBucketArn) {
    statements.push({
      Effect: 'Allow',
      Action: ['s3:GetObject', 's3:PutObject'],
      Resource: `${buckets.batchUploadBucketArn}/batch/${tenantId}/input/*`,
    });
    if (buckets.batchUploadKmsKeyArn) {
      statements.push({
        Effect: 'Allow',
        Action: ['kms:Decrypt', 'kms:GenerateDataKey'],
        Resource: buckets.batchUploadKmsKeyArn,
        Condition: {
          StringEquals: {
            'kms:ViaService': `s3.${process.env.AWS_REGION ?? 'ap-southeast-1'}.amazonaws.com`,
            'kms:EncryptionContext:aws:s3:arn': buckets.batchUploadBucketArn,
          },
        },
      });
    }
  }
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: statements,
  });
}

export function createTenantCredentialsProvider(
  roleArn: string,
  tenantId: string,
  policy: string,
  sts: Pick<STSClient, 'send'> = new STSClient({}),
  sessionName = 'tenant',
): TenantCredentialsProvider {
  let cached: TenantCredentials | undefined;
  let refreshing: Promise<TenantCredentials> | undefined;
  return async () => {
    if (cached?.expiration && cached.expiration.getTime() > Date.now() + 60_000) return cached;
    refreshing ??= (async () => {
      const result = await sts.send(new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: `${sessionName}-${tenantId}`.slice(0, 64),
        SourceIdentity: tenantId,
        Tags: [{ Key: 'tenantId', Value: tenantId }],
        Policy: policy,
      })) as { Credentials?: { AccessKeyId?: string; SecretAccessKey?: string; SessionToken?: string; Expiration?: Date } };
      const c = result.Credentials;
      if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) throw new Error('STS AssumeRole returned incomplete credentials');
      cached = { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken, expiration: c.Expiration };
      return cached;
    })().finally(() => { refreshing = undefined; });
    return refreshing;
  };
}

/**
 * Routes tenant-partition DynamoDB commands through short-lived STS sessions whose
 * session policy is restricted to the tenant in the command's partition key.
 * Platform mapping lookups stay on the Lambda execution role.
 */
export function createTenantDocumentClientRouter(
  base: SendClient,
  options: {
    roleArn?: string;
    sessionName?: string;
    localFallback?: boolean;
    payloadBucketArn?: string;
    batchUploadBucketArn?: string;
    sts?: Pick<STSClient, 'send'>;
    createClient?: (credentials: TenantCredentialsProvider) => SendClient;
  } = {},
): SendClient {
  const roleArn = options.roleArn?.trim();
  const localFallback = options.localFallback ?? !process.env.AWS_LAMBDA_FUNCTION_NAME;
  const sts = options.sts ?? new STSClient({});
  const clients = new Map<string, Promise<SendClient>>();

  const clientFor = (tenantId: string): Promise<SendClient> => {
    let pending = clients.get(tenantId);
    if (!pending) {
      pending = (async () => {
        if (!roleArn) throw new Error('TENANT_DATA_ACCESS_ROLE_ARN is required in Lambda');
        const credentials = createTenantCredentialsProvider(
          roleArn,
          tenantId,
          tenantSessionPolicy(tenantId, options),
          sts,
          options.sessionName,
        );
        return options.createClient?.(credentials) ?? DynamoDBDocumentClient.from(new DynamoDBClient({ credentials }));
      })();
      clients.set(tenantId, pending);
      pending.catch(() => clients.delete(tenantId));
    }
    return pending;
  };

  return {
    async send(command: never): Promise<never> {
      const keys = new Set<string>();
      collectPartitionKeys((command as AwsCommand).input, keys);
      if (keys.size > 1) throw new Error('DynamoDB request cannot span tenant partitions');
      const tenantId = keys.values().next().value as string | undefined;
      if (!tenantId) return base.send(command);
      if (!roleArn && localFallback) return base.send(command);
      return (await clientFor(tenantId)).send(command);
    },
  } as SendClient;
}

export function createTenantS3Client(
  roleArn: string,
  tenantId: string,
  bucketArn: string,
  prefix: 'worker' | 'batch',
  sessionName = 'tenant-s3',
  batchUploadKmsKeyArn?: string,
): S3Client {
  const buckets = prefix === 'worker'
    ? { payloadBucketArn: bucketArn }
    : { batchUploadBucketArn: bucketArn, batchUploadKmsKeyArn };
  const policy = tenantSessionPolicy(tenantId, buckets);
  return new S3Client({ credentials: createTenantCredentialsProvider(roleArn, tenantId, policy, undefined, sessionName) });
}
