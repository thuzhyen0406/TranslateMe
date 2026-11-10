# Lambda IAM roles

`iam.yaml` creates Lambda execution roles plus a tenant-data role. Runtime data
requests assume the tenant-data role with an inline STS session policy bound to
the authenticated/resolved `tenantId`; STS session tags bind the target role's
maximum policy to that same tenant. Website creation uses a separate
`TenantWebsiteDataAccessRoleArn` for the one-time tenant plus platform slug
reservation transaction. `lambdas.yaml` attaches each execution role to its
Lambda and supplies the role ARNs. API Gateway
invocation permissions remain in `api-gateway.yaml`.

## Roles and owning handlers

| Output | Attach to | Main AWS access |
| --- | --- | --- |
| `ProxyExecutionRoleArn` | Website proxy Lambda | Tenant data/TM/usage, `GSI2`, proxy payload prefix, async worker invoke, Translate |
| `WorkerExecutionRoleArn` | Async translation worker Lambda | Tenant data/TM/usage, `GSI2`, worker payload prefix, Translate, KMS |
| `ConsoleApiExecutionRoleArn` | Console API Lambda | Tenant data, `GSI2`/`GSI3`, invite members, API-key operations, import glossary terminology, cache invalidation |
| `WebsiteFunctionRoleArn` | Dedicated website management Lambda | Tenant HOST/CONFIG through assumed tenant-data role; tenant-scoped slug reservation transactions |
| `TenantPayloadAccessRoleArn` | Assumed by Proxy and Worker | S3 payload objects under one `tenant/<tenantId>/worker/` prefix per session |
| `TranslateApiExecutionRoleArn` | API-key translation Lambda | Tenant data/TM/usage, `GSI2`, Translate and Comprehend |
| `PlatformApiExecutionRoleArn` | Platform Admin Lambda | Read site rows, update tenant CONFIG, cache invalidation |
| `PostConfirmationExecutionRoleArn` | Cognito PostConfirmation trigger | Create tenant/mapping records and set Cognito claims |
| `TenantDataAccessRoleArn` | Assumed per request by tenant-facing functions | DynamoDB access constrained by the STS session policy to one tenant partition |
| `TenantWebsiteDataAccessRoleArn` | Assumed only by Website Lambda during website creation | `TransactWriteItems` plus `PutItem`/`ConditionCheckItem` limited to tenant records and the platform slug reservation |

## Deployment and wiring

1. Deploy data and identity stacks.
2. Deploy `iam.yaml`, supplying the exact worker function ARN, data-stack KMS key ARN,
   and batch bucket KMS key ARN (the data key ARN when the bucket uses the data key).
3. Deploy `lambdas.yaml` with the code artifacts and matching role ARN
   outputs, including `TenantDataAccessRoleArn`,
   `TenantWebsiteDataAccessRoleArn`, and `TenantPayloadAccessRoleArn`. Set `PayloadBucketArn`, `PayloadBucketName`,
   `BatchUploadBucketArn`, `BatchUploadBucketName`, `BatchUploadKmsKeyArn`, and `KmsKeyArn` from the data stack outputs.
4. Pass `WebsiteFunctionArn` as well as the other function ARNs to
   `api-gateway.yaml`; `/console/hosts*` management routes are directed to the
   dedicated Lambda, except prewarm routes which remain on the Console API.
   Do not attach execution roles to API Gateway.
5. Configure the Cognito User Pool PostConfirmation trigger to the output Lambda.

## Security boundary and known integration work

- The actual tenant ID format is `t_` followed by the generated identifier.
  Session tags bind each target role's maximum policy to the assumed tenant;
  tenant session policies further restrict `dynamodb:LeadingKeys`. Only the
  website creation client adds the exact platform slug key for its transaction;
  the role's maximum policy still limits that access to the slug prefix.
  Execution roles have no direct tenant-partition data permissions.
  Data-layer validation remains defense in depth and must not be removed.
- Tenant isolation currently relies on the application creating each STS
  session with `libs/common/tenantAws.ts`'s tenant-scoped session policy. The
  module keeps credential creation private; it is the only code path that
  issues `AssumeRole`, and it always derives that policy
  from the same validated tenant ID used for `SourceIdentity` and the session
  tag, so current call sites cannot pass an arbitrary policy. AWS IAM does not
  independently bind a tenant ID in a Cognito request to `SourceIdentity` or
  the session tag; a compromised Lambda execution role/code path with
  `sts:AssumeRole` can choose another tenant ID. If that threat must be blocked
  by IAM alone, this design is insufficient and needs tenant-bound AWS
  identities or a different authorization boundary.
  A `DenyRoleChaining` statement on each tenant role's trust policy prevents
  a caller that already carries a `TenantId` session tag from assuming the role
  again — blocking an already-scoped session from pivoting to another tenant.
  This does not prevent a Lambda execution role from choosing an arbitrary
  tenant on the *first* assume, but it closes the role-chaining vector.
- `PlatformApiExecutionRole` must query `HOST#` records so the current lock
  handler can collect slugs for CloudFront invalidation. IAM can scope this to
  tenant partition keys but not the `HOST#` sort-key prefix with
  `LeadingKeys`; keep the handler's platform-admin check and tenant ID
  validation. Revisit this if the platform API is split into narrower Lambdas.
- `ConsoleApiExecutionRole` is shared by multiple console routes. IAM cannot
  express the route matrix on one shared Lambda role. Keep route-level role
  checks in code; split handlers/roles if independent IAM boundaries are
  required. The `ReserveWebsiteSlug` statement has been removed because
  website creation now runs on the dedicated `WebsiteFunctionRole` via
  `TenantWebsiteDataAccessRole`. Console API no longer needs write access
  to `TENANT#PLATFORM#SLUG#*` keys. Its `DeleteItem` permission is for
  implemented tenant operations such as glossary deletion/member removal
  and must not be used to add DELETE routes for websites, TM, or API keys.
- API-key create/rotate/revoke code is not present in this checkout. Add the
  exact API Gateway control-plane actions to a dedicated policy only after its
  implementation is known. In particular, do not grant `apigateway:GET` for
  API key resources, which could expose a stored key value.
- `lambdas.yaml` supplies the tenant data role, tenant payload role, batch
  bucket, and KMS key settings. The data stack creates the payload bucket with
  public access blocked, default SSE-KMS encryption, a one-day payload lifecycle,
  and a TLS-only bucket policy. Worker payload keys use
  `tenant/<tenantId>/worker/<file>`. Batch uploads use
  `batch/<tenantId>/input/<file>` and the batch bucket's KMS key.
- `TenantDataAccessRole` supplies DynamoDB and batch-upload maximum permissions;
  `TenantPayloadAccessRole` supplies worker-payload maximum permissions. The
  inline session policy narrows each assumed role to the current tenant.
- `translate:TranslateText` and `comprehend:DetectDominantLanguage` require
  `Resource: '*'` in their supported IAM authorization model. Keep these
  actions separate from DynamoDB/S3 statements.

Review the policies against the deployed function entry points and the report's
route/action matrix before deployment. This module intentionally does not
create user-pool, table, bucket, distribution, or Lambda resources.
