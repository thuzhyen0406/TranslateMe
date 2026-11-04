# Lambda IAM roles

`iam.yaml` creates Lambda execution roles plus a tenant-data role. Runtime data
requests assume the tenant-data role with an inline STS session policy bound to
the authenticated/resolved `tenantId`. `lambdas.yaml` attaches each execution
role to its Lambda and supplies `TENANT_DATA_ACCESS_ROLE_ARN`. API Gateway
invocation permissions remain in `api-gateway.yaml`.

## Roles and owning handlers

| Output | Attach to | Main AWS access |
| --- | --- | --- |
| `ProxyExecutionRoleArn` | Website proxy Lambda | Tenant data/TM/usage, `GSI2`, proxy payload prefix, async worker invoke, Translate |
| `WorkerExecutionRoleArn` | Async translation worker Lambda | Tenant data/TM/usage, `GSI2`, worker payload prefix, Translate |
| `ConsoleApiExecutionRoleArn` | Console API Lambda | Tenant data, `GSI2`/`GSI3`, invite members, import glossary terminology, cache invalidation |
| `TranslateApiExecutionRoleArn` | API-key translation Lambda | Tenant data/TM/usage, `GSI2`, Translate and Comprehend |
| `PlatformApiExecutionRoleArn` | Platform Admin Lambda | Read site rows, update tenant CONFIG, cache invalidation |
| `PostConfirmationExecutionRoleArn` | Cognito PostConfirmation trigger | Create tenant/mapping records and set Cognito claims |
| `TenantDataAccessRoleArn` | Assumed per request by tenant-facing functions | DynamoDB access constrained by the STS session policy to one tenant partition |

## Deployment and wiring

1. Deploy data and identity stacks.
2. Deploy `iam.yaml`, supplying the exact worker function ARN.
3. Deploy `lambdas.yaml` with the six code artifacts and the matching role ARN
   outputs, including `TenantDataAccessRoleArn`.
4. Pass the function ARN outputs to `api-gateway.yaml`; do not attach execution
   roles to API Gateway.
5. Configure the Cognito User Pool PostConfirmation trigger to the output Lambda.

## Security boundary and known integration work

- The actual tenant ID format is `t_` followed by the generated identifier.
  The session policy restricts `dynamodb:LeadingKeys` to that exact tenant
  partition (plus the platform slug reservation prefix required by site
  creation). Execution roles have no direct tenant-partition data permissions.
  Data-layer validation remains defense in depth and must not be removed.
- `PlatformApiExecutionRole` must query `HOST#` records so the current lock
  handler can collect slugs for CloudFront invalidation. IAM can scope this to
  tenant partition keys but not the `HOST#` sort-key prefix with
  `LeadingKeys`; keep the handler's platform-admin check and tenant ID
  validation. Revisit this if the platform API is split into narrower Lambdas.
- `ConsoleApiExecutionRole` is shared by multiple console routes. IAM cannot
  express the route matrix on one shared Lambda role. Keep route-level role
  checks in code; split handlers/roles if independent IAM boundaries are
  required. Its `DeleteItem` permission is for implemented tenant operations
  such as glossary deletion/member removal and must not be used to add DELETE
  routes for websites, TM, or API keys.
- API-key create/rotate/revoke code is not present in this checkout. Add the
  exact API Gateway control-plane actions to a dedicated policy only after its
  implementation is known. In particular, do not grant `apigateway:GET` for
  API key resources, which could expose a stored key value.
- `lambdas.yaml` supplies the tenant role ARN and table/bucket settings. S3/KMS
  configuration remains owned by the data stack. DynamoDB uses service-side
  encryption, so ordinary DynamoDB calls do not need direct KMS permissions.
- `translate:TranslateText` and `comprehend:DetectDominantLanguage` require
  `Resource: '*'` in their supported IAM authorization model. Keep these
  actions separate from DynamoDB/S3 statements.

Review the policies against the deployed function entry points and the report's
route/action matrix before deployment. This module intentionally does not
create user-pool, table, bucket, distribution, or Lambda resources.
