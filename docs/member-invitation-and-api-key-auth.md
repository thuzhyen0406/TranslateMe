# Member invitations and API key authorization

## Invitation records

`inviteMember` creates the user in Cognito and then writes the corresponding
DynamoDB member record. The member's Cognito `sub` is the canonical identity:

```text
PK = TENANT#<tenantId>
SK = MEMBER#<sub>
```

The record stores `tenantId`, `userSub`, normalized `email`, the invited role,
`status = ACTIVE`, and `createdAt`. It is written with a condition that prevents
overwriting an existing member record. If Cognito does not return a `sub`, or
the DynamoDB write fails, the invitation call fails rather than reporting
success without a usable member record.

If the MEMBER write fails after Cognito created the account, the invitation
handler attempts `AdminDeleteUser` as compensation. If cleanup also fails, it
logs the tenant, request ID, and error names so an operator can remove or repair
the orphaned Cognito user. The log does not contain the email or temporary
password.

The member record is `ACTIVE` so the authentication and API-key checks can find
it after the invitee completes Cognito's required temporary-password change.
Cognito keeps the invited user in `FORCE_CHANGE_PASSWORD` until that challenge
is completed, so the member record alone does not let the invitee sign in.

## Request context and API key checks

`contextFromIdTokenClaims` takes `sub` from the validated ID token, verifies
that `MEMBER#<sub>` exists, is active, and has the role represented by the
token, then includes that `sub` in `Ctx`. It and the API-key manager call the
same `requireActiveMember` function in `services/api/auth/context.ts`.

Every API key operation (create, list, rotate, revoke, and plan change) checks
the active MEMBER record, including when the exported manager function is
called outside the normal console router. Batch session requests use
`contextFromIdTokenClaims` instead of maintaining a separate membership check.

The Console Lambda entry point dispatches `/console/api-keys` to
`handleApiKeyRoute`; the `ConsoleHandler` parameter in `lambdas.yaml` defaults
to that entry point. It requires `BASIC_USAGE_PLAN_ID` and
`STANDARD_USAGE_PLAN_ID` at runtime.

## API key plan changes

API Gateway Usage Plan changes span separate control-plane calls and cannot be
atomic with the DynamoDB update. The implementation detaches the old plan
before attaching the new one, so the key can briefly be attached to no Usage
Plan. On failure, it logs the error and attempts to restore the old plan. If
rollback also fails, inspect the key's Usage Plan membership using the logged
`keyId` and `request_id`; never log or retrieve the key secret for diagnosis.

## Tests

The API auth tests verify that:

- validated JWT contexts retain the Cognito `sub`;
- invitations write one correctly keyed MEMBER record with a conditional put;
- an invitation without a Cognito `sub` fails without attempting the MEMBER
  write.
