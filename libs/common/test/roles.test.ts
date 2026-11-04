import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  claimForRole,
  PLATFORM_ADMIN_GROUP,
  roleFromClaim,
  ROLES,
} from '../roles.js';

describe('role claim contract', () => {
  it('maps lowercase Cognito claims to internal tenant roles', () => {
    assert.equal(roleFromClaim('tenant_admin'), ROLES.TENANT_ADMIN);
    assert.equal(roleFromClaim('developer'), ROLES.DEVELOPER);
    assert.equal(roleFromClaim('reviewer'), ROLES.REVIEWER);
  });

  it('creates lowercase Cognito claims from internal tenant roles', () => {
    assert.equal(claimForRole(ROLES.TENANT_ADMIN), 'tenant_admin');
    assert.equal(claimForRole(ROLES.DEVELOPER), 'developer');
    assert.equal(claimForRole(ROLES.REVIEWER), 'reviewer');
  });

  it('accepts legacy display claims temporarily and rejects uppercase claims', () => {
    assert.equal(roleFromClaim('Tenant Admin'), ROLES.TENANT_ADMIN);
    assert.equal(roleFromClaim('Developer'), ROLES.DEVELOPER);
    assert.equal(roleFromClaim('Reviewer'), ROLES.REVIEWER);
    assert.equal(roleFromClaim('TENANT_ADMIN'), null);
    assert.equal(roleFromClaim('platform_admin'), null);
    assert.equal(roleFromClaim('unknown'), null);
    assert.equal(roleFromClaim(null), null);
  });

  it('does not create Platform Admin from custom:role', () => {
    assert.equal(roleFromClaim('Platform Admin'), null);
    assert.equal(roleFromClaim('platform_admin'), null);
    assert.equal(roleFromClaim(PLATFORM_ADMIN_GROUP), null);
    assert.equal(PLATFORM_ADMIN_GROUP, 'PlatformAdmins');
  });
});
