# API Gateway routes and authentication

`api-gateway.yaml` uses a REST API. Console routes use the Cognito User Pool
authorizer. Translation routes use API Gateway API keys, except the explicit
batch web-session resources below.

| Route | Authentication | Integration | Notes |
| --- | --- | --- | --- |
| `POST /translate/batch/upload-url` | API key | Translate Lambda | Existing machine-client flow |
| `POST /translate/batch` | API key | Translate Lambda | Existing machine-client flow |
| `GET /translate/batch/{job_id}` | API key | Translate Lambda | Tenant-scoped job polling; read-only polling is allowed while tenant is locked |
| `POST /translate/batch/session/upload-url` | Cognito ID token | Translate Lambda | Browser session; no API key required |
| `POST /translate/batch/session` | Cognito ID token | Translate Lambda | Browser session; no API key required |
| `GET/POST /console/api-keys` | Cognito ID token | Console Lambda | Member must be active; role checked by key manager |
| `POST /console/api-keys/{keyId}/rotate` | Cognito ID token | Console Lambda | Returns the new secret once |
| `POST /console/api-keys/{keyId}/revoke` | Cognito ID token | Console Lambda | Revoke key |
| `PATCH /console/api-keys/{keyId}` | Cognito ID token | Console Lambda | Change API key plan |

The batch session routes use explicit API Gateway resources so they can use a
Cognito authorizer while the greedy `/translate/{proxy+}` method continues to
require API keys. The browser sends its Cognito ID token in `Authorization`;
the file contents travel directly to S3 with the returned presigned URL.

## API key plan change behavior

API Gateway Usage Plan changes span separate control-plane calls and cannot be
atomic with the DynamoDB update. `changeApiKeyPlan` detaches the old plan before
attaching the new one, so the key can briefly be attached to no Usage Plan. If
a later operation fails, the handler logs the failure and attempts to restore
the old plan. An operator should inspect the key's plan membership when rollback
also reports an error; the log includes `keyId` and `request_id`, never the key
secret.

## Deployment inputs

Pass `BatchFilesBucketName`, `BatchFilesBucketArn`, and `KeyArn` from the data
stack to the Lambda stack as `BatchUploadBucketName`, `BatchUploadBucketArn`,
and `BatchUploadKmsKeyArn`. Pass the tenant-data role ARN and both API Gateway
Usage Plan IDs to `lambdas.yaml`. The Translate Lambda assumes the tenant-data
role for S3 operations; the STS session policy restricts each request to
`batch/<tenantId>/input/*`.

## Batch integration dependencies

The shared parser in this checkout registers TXT and HTML only. Batch upload
therefore rejects DOCX until the DOCX parser from task 4.9 is merged and
registered in `libs/common/parsers.ts`; this keeps the batch estimate aligned
with the workflow parser. Batch creates FILE jobs through the shared
`createJobStore` schema (`total`, `done`, and `failed`) and reserves estimated
machine characters atomically before queueing. The reservation ticket is stored
on the job for the batch workflow to settle against actual usage or refund if
translation fails. Until task 4.7 is integrated, queued jobs remain input
records and do not start a state machine.
