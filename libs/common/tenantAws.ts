import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';

type SendClient = Pick<DynamoDBDocumentClient, 'send'>;
type AwsCommand = { input?: Record<string, unknown> };
type TenantCredentials = { accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration?: Date };
type TenantCredentialsProvider = () => Promise<TenantCredentials>;
type TenantPolicyOptions = Parameters<typeof tenantSessionPolicy>[1];

export class TenantAssumeRoleError extends Error {
  constructor(
    public readonly awsCode: string,
    public readonly requestId: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'TenantAssumeRoleError';
  }
}

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
  buckets: {
    payloadBucketArn?: string;
    batchUploadBucketArn?: string;
    batchUploadKmsKeyArn?: string;
    dataKmsKeyArn?: string;
    dataTableName?: string;
    allowPlatformSlugReservation?: boolean;
  } = {},
): string {
  if (!/^t_[A-Za-z0-9_-]{1,64}$/.test(tenantId)) throw new TypeError('Invalid tenant ID');
  const leadingKeys = [`TENANT#${tenantId}`, `TENANT#${tenantId}#*`];
  if (buckets.allowPlatformSlugReservation) leadingKeys.push('TENANT#PLATFORM#SLUG#*');
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
        'dynamodb:LeadingKeys': leadingKeys,
      },
    },
  }];
  if (buckets.allowPlatformSlugReservation) {
    statements.push({
      Effect: 'Allow',
      Action: ['dynamodb:PutItem', 'dynamodb:ConditionCheckItem', 'dynamodb:TransactWriteItems'],
      Resource: '*',
      Condition: {
        'ForAllValues:StringLike': {
          'dynamodb:LeadingKeys': [
            `TENANT#${tenantId}`,
            `TENANT#${tenantId}#*`,
            'TENANT#PLATFORM#SLUG#*',
          ],
        },
      },
    });
  }
  if (buckets.dataKmsKeyArn && buckets.dataTableName) {
    statements.push({
      Effect: 'Allow',
      Action: ['kms:Decrypt', 'kms:Encrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:DescribeKey', 'kms:CreateGrant'],
      Resource: buckets.dataKmsKeyArn,
      Condition: {
        StringEquals: {
          'kms:ViaService': `dynamodb.${process.env.AWS_REGION ?? 'ap-southeast-1'}.amazonaws.com`,
          'kms:EncryptionContext:aws:dynamodb:tableName': buckets.dataTableName,
        },
      },
    });
  }
  if (buckets.payloadBucketArn) {
    statements.push({ Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject'], Resource: `${buckets.payloadBucketArn}/tenant/${tenantId}/worker/*` });
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

function createTenantCredentialsProvider(
  roleArn: string,
  tenantId: string,
  policyOptions: TenantPolicyOptions = {},
  allowPlatformSlugReservations = false,
  sts: Pick<STSClient, 'send'> = new STSClient({}),
  sessionName = 'tenant',
  logger: (message: Record<string, unknown>) => void = (message) => console.error(JSON.stringify(message)),
  metric: (name: string) => void = () => undefined,
): TenantCredentialsProvider {
  let cached: TenantCredentials | undefined;
  let refreshing: Promise<TenantCredentials> | undefined;
  return async () => {
    if (cached?.expiration && cached.expiration.getTime() > Date.now() + 60_000) return cached;
    refreshing ??= (async () => {
      let result: { Credentials?: { AccessKeyId?: string; SecretAccessKey?: string; SessionToken?: string; Expiration?: Date } };
      try {
        const policy = tenantSessionPolicy(
          tenantId,
          {
            ...policyOptions,
            dataKmsKeyArn: policyOptions.dataKmsKeyArn ?? process.env.DATA_KMS_KEY_ARN,
            dataTableName: policyOptions.dataTableName ?? process.env.TABLE_NAME,
          },
          allowPlatformSlugReservations,
        );
        result = await sts.send(new AssumeRoleCommand({
          RoleArn: roleArn,
          RoleSessionName: `${sessionName}-${tenantId}`.slice(0, 64),
          SourceIdentity: tenantId,
          Tags: [{ Key: 'TenantId', Value: tenantId }],
          Policy: policy,
        })) as typeof result;
      } catch (error) {
        const awsError = error as { name?: string; Code?: string; $metadata?: { requestId?: string } };
        const awsCode = awsError.name ?? awsError.Code ?? 'UnknownError';
        try {
          metric('tenant.assume_role.failed');
          logger({ event: 'TENANT_ASSUME_ROLE_FAILED', tenantId, roleArn, sessionName, awsCode, requestId: awsError.$metadata?.requestId });
        } catch {
          // Telemetry failures must not mask the security failure.
        }
        throw new TenantAssumeRoleError(awsCode, awsError.$metadata?.requestId, 'Không thể tạo phiên truy cập dữ liệu tenant');
      }
      const c = result.Credentials;
      if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) {
        try { metric('tenant.assume_role.incomplete_credentials'); } catch {}
        throw new TenantAssumeRoleError('IncompleteCredentials', undefined, 'STS AssumeRole returned incomplete credentials');
      }
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
    payloadBucketKmsKeyArn?: string;
    batchUploadKmsKeyArn?: string;
    dataKmsKeyArn?: string;
    dataTableName?: string;
    allowPlatformSlugReservations?: boolean;
    sts?: Pick<STSClient, 'send'>;
    createClient?: (credentials: TenantCredentialsProvider) => SendClient;
    logger?: (message: Record<string, unknown>) => void;
    metric?: (name: string) => void;
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
        const policyOptions: TenantPolicyOptions = {
          payloadBucketArn: options.payloadBucketArn,
          payloadBucketKmsKeyArn: options.payloadBucketKmsKeyArn,
          batchUploadBucketArn: options.batchUploadBucketArn,
          batchUploadKmsKeyArn: options.batchUploadKmsKeyArn,
        };
        const credentials = createTenantCredentialsProvider(
          roleArn,
          tenantId,
          policyOptions,
          options.allowPlatformSlugReservations,
          sts,
          options.sessionName,
          options.logger,
          options.metric,
        );
        return options.createClient?.(credentials) ?? DynamoDBDocumentClient.from(
          new DynamoDBClient({ credentials }),
          { marshallOptions: { removeUndefinedValues: true } },
        );
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
  batchUploadKmsKeyArn = process.env.TENANT_BATCH_UPLOAD_KMS_KEY_ARN,
): S3Client {
  const buckets = prefix === 'worker'
    ? { payloadBucketArn: bucketArn, payloadBucketKmsKeyArn: kmsKeyArn }
    : { batchUploadBucketArn: bucketArn, batchUploadKmsKeyArn: kmsKeyArn };
  return new S3Client({ credentials: createTenantCredentialsProvider(roleArn, tenantId, buckets, false, undefined, sessionName) });
}
