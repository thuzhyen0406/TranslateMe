# Lambda IAM roles

`iam.yaml` is the CloudFormation IAM module for the current TranslateMe Lambda
boundaries. It creates execution roles; it does not grant API Gateway permission
to invoke a Lambda. Invocation is granted separately by the
`AWS::Lambda::Permission` resources in `api-gateway.yaml`.

## Roles and owning handlers

| Output | Attach to | Main AWS access |
| --- | --- | --- |
| `ProxyExecutionRoleArn` | Website proxy Lambda | Tenant data/TM/usage, `GSI2`, proxy payload prefix, async worker invoke, Translate |
| `WorkerExecutionRoleArn` | Async translation worker Lambda | Tenant data/TM/usage, `GSI2`, worker payload prefix, Translate |
| `ConsoleApiExecutionRoleArn` | Console API Lambda | Tenant data, `GSI2`/`GSI3`, invite members, import glossary terminology, cache invalidation |
| `TranslateApiExecutionRoleArn` | API-key translation Lambda | Tenant data/TM/usage, `GSI2`, Translate and Comprehend |
| `PlatformApiExecutionRoleArn` | Platform Admin Lambda | Read site rows, update tenant CONFIG, cache invalidation |
| `PostConfirmationExecutionRoleArn` | Cognito PostConfirmation trigger | Create tenant/mapping records and set Cognito claims |

## Deployment and wiring

1. Deploy the data and identity stacks first.
2. Deploy this template as its own stack with the table ARN, User Pool ARN,
   payload bucket ARN, worker function ARN, and CloudFront distribution ARN.
3. Pass the matching role ARN output to each Lambda's `Role` property in the
   application stack. Do not attach these roles to API Gateway.
4. Keep the role ARN outputs as stack exports/parameters in the application
   deployment; do not copy role ARNs into source code.

There is not yet an application Lambda stack in this repository that declares
all six functions, so the outputs are prepared for that integration. The
current `infra/template.yaml` Hello Lambda remains a sample and should continue
using its own execution role.

## Security boundary and known integration work

- The actual tenant ID format in this project is `t_` followed by the generated
  identifier. DynamoDB IAM `LeadingKeys` therefore limits tenant partition
  keys to `TENANT#t_*`; it does not provide per-tenant isolation for a shared
  Lambda role. Request-level tenant binding and authorization remain mandatory
  in the handlers/data layer. Per-invocation STS session policies are outside
  the current MVP plan.
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
- S3/KMS settings and Lambda environment variables are configured by the
  function/data stacks. DynamoDB uses service-side encryption, so these
  execution roles do not need direct KMS data-key permissions for ordinary
  DynamoDB calls.
- `translate:TranslateText` and `comprehend:DetectDominantLanguage` require
  `Resource: '*'` in their supported IAM authorization model. Keep these
  actions separate from DynamoDB/S3 statements.

Review the policies against the deployed function entry points and the report's
route/action matrix before deployment. This module intentionally does not
create user-pool, table, bucket, distribution, or Lambda resources.
