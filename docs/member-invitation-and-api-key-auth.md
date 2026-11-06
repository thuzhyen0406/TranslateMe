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

The member record is `ACTIVE` so the authentication and API-key checks can find
it after the invitee completes Cognito's required temporary-password change.
Cognito keeps the invited user in `FORCE_CHANGE_PASSWORD` until that challenge
is completed, so the member record alone does not let the invitee sign in.

## Request context and API key checks

`contextFromIdTokenClaims` takes `sub` from the validated ID token, verifies
that `MEMBER#<sub>` exists, is active, and has the role represented by the
token, then includes that `sub` in `Ctx`.

API key creation and rotation retain their own MEMBER check in `keyManager`.
This deliberately provides defense in depth for those operations, including
if they are called outside the normal console request-context path. As a
result, requests for those operations perform a second consistent MEMBER read.

## Tests

The API auth tests verify that:

- validated JWT contexts retain the Cognito `sub`;
- invitations write one correctly keyed MEMBER record with a conditional put;
- an invitation without a Cognito `sub` fails without attempting the MEMBER
  write.
