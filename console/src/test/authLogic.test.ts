import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  completeInvitedMemberPassword,
  confirmEmailAndRefreshSession,
  confirmForgotPasswordReset,
  ConsoleAuthError,
  decodeJwtClaims,
  DEFAULT_DEMO_TENANT_ID,
  getVisibleMenuItems,
  inviteTenantMember,
  listTenantMembers,
  mapCognitoErrorToVietnamese,
  normalizeRole,
  registerAccount,
  requestPasswordResetCode,
  resetSimulatedAuthStore,
  signInWithEmail,
  fetchConsoleTenantProfile,
  getDemoTenantStatus,
  hydrateSessionTenantStatus,
  setDemoTenantStatus,
  validatePasswordPolicy,
} from '../services/cognitoAuth.js';

describe('Task 2.9 – Web Console: Khung, Đăng nhập & Màn Q1', () => {
  beforeEach(() => {
    resetSimulatedAuthStore();
  });

  it('kiểm tra chính sách mật khẩu Cognito (>= 8 ký tự, chữ hoa, chữ thường, chữ số) và liệt kê điều kiện còn thiếu', () => {
    const shortRes = validatePasswordPolicy('Short1');
    assert.equal(shortRes.valid, false);
    assert.deepEqual(shortRes.missingConditions, ['tối thiểu 8 ký tự']);

    const noUpperOrDigit = validatePasswordPolicy('alllowercase');
    assert.equal(noUpperOrDigit.valid, false);
    assert.deepEqual(noUpperOrDigit.missingConditions, ['chữ hoa (A-Z)', 'chữ số (0-9)']);

    assert.equal(validatePasswordPolicy('ALLUPPERCASE123').valid, false);
    assert.equal(validatePasswordPolicy('NoDigitsPassword').valid, false);

    const okRes = validatePasswordPolicy('Password123');
    assert.equal(okRes.valid, true);
    assert.deepEqual(okRes.missingConditions, []);
  });

  it('luồng Đăng ký -> Xác nhận mã 6 số -> Làm mới token (B.13) trả JWT có custom:tenant_id và custom:role', async () => {
    const reg = await registerAccount({
      fullName: 'Phạm Kim Tùng',
      email: 'tung@homestay-abc.example',
      password: 'Password123',
      organizationName: 'Homestay ABC Hội An',
      acceptedTerms: true,
    });
    assert.equal(reg.email, 'tung@homestay-abc.example');
    assert.match(reg.demoConfirmationCode, /^\d{6}$/);

    const session = await confirmEmailAndRefreshSession({
      email: reg.email,
      code: reg.demoConfirmationCode,
      organizationName: reg.organizationName,
    });

    assert.equal(session.role, 'TENANT_ADMIN');
    assert.equal(session.tenantStatus, 'ACTIVE');
    assert.ok(session.tenantId.startsWith('t_'));

    const claims = decodeJwtClaims(session.idToken);
    assert.ok(claims);
    assert.equal(claims['custom:tenant_id'], session.tenantId);
    assert.equal(claims['custom:role'], 'tenant_admin');
    assert.notEqual(session.accessToken, session.idToken);
  });

  it('cô lập danh sách thành viên (listTenantMembers & inviteTenantMember) theo từng tenantId riêng biệt', async () => {
    // 1. Đăng ký một tổ chức mới hoàn toàn ("Resort Đà Nẵng")
    const reg = await registerAccount({
      fullName: 'Nguyễn Văn An',
      email: 'an@resort-danang.example',
      password: 'Password123',
      organizationName: 'Resort Đà Nẵng',
      acceptedTerms: true,
    });
    const newTenantSession = await confirmEmailAndRefreshSession({
      email: reg.email,
      code: reg.demoConfirmationCode,
      organizationName: reg.organizationName,
    });

    assert.notEqual(newTenantSession.tenantId, DEFAULT_DEMO_TENANT_ID);

    // 2. Tổ chức mới chỉ nhìn thấy đúng 1 thành viên là chính Tenant Admin vừa tạo (không lẫn Lan/Khoa/Minh của Homestay ABC)
    const initialNewTenantMembers = await listTenantMembers(newTenantSession.tenantId);
    assert.equal(initialNewTenantMembers.length, 1);
    assert.equal(initialNewTenantMembers[0].email, 'an@resort-danang.example');
    assert.equal(initialNewTenantMembers[0].tenantId, newTenantSession.tenantId);

    // 3. Khi mời thành viên mới từ session của tổ chức mới, thành viên đó thuộc đúng tenantId của người mời
    const inviteRes = await inviteTenantMember(
      newTenantSession.role,
      'dev@resort-danang.example',
      'DEVELOPER',
      newTenantSession.organizationName,
      newTenantSession.tenantId,
    );
    assert.equal(inviteRes.member.tenantId, newTenantSession.tenantId);

    const updatedNewTenantMembers = await listTenantMembers(newTenantSession.tenantId);
    assert.equal(updatedNewTenantMembers.length, 2);

    // Danh sách thành viên của Homestay ABC mặc định vẫn giữ nguyên 3 người, không bị lẫn thành viên của Resort Đà Nẵng
    const defaultTenantMembers = await listTenantMembers(DEFAULT_DEMO_TENANT_ID);
    assert.equal(defaultTenantMembers.length, 3);
    assert.equal(
      defaultTenantMembers.some((m) => m.email === 'dev@resort-danang.example'),
      false,
    );
  });

  it('ẩn/hiện đúng danh sách menu bên trái theo từng vai trò (TENANT_ADMIN, DEVELOPER, REVIEWER)', () => {
    assert.equal(normalizeRole('tenant_admin'), 'TENANT_ADMIN');
    assert.equal(normalizeRole('developer'), 'DEVELOPER');
    assert.equal(normalizeRole('reviewer'), 'REVIEWER');
    assert.equal(normalizeRole('Tenant Admin'), 'TENANT_ADMIN');
    assert.equal(normalizeRole('Developer'), 'DEVELOPER');
    assert.equal(normalizeRole('Reviewer'), 'REVIEWER');
    assert.equal(normalizeRole('TENANT_ADMIN'), null);

    const adminMenus = getVisibleMenuItems('TENANT_ADMIN').map((m) => m.key);
    assert.deepEqual(adminMenus, [
      'website',
      'glossary',
      'review',
      'usage',
      'apikey',
      'playground',
      'doc-translate',
      'members',
    ]);

    const devMenus = getVisibleMenuItems('DEVELOPER').map((m) => m.key);
    assert.deepEqual(devMenus, ['glossary', 'usage', 'apikey', 'playground', 'doc-translate']);
    assert.equal(devMenus.includes('members'), false);
    assert.equal(devMenus.includes('website'), false);

    const reviewerMenus = getVisibleMenuItems('REVIEWER').map((m) => m.key);
    assert.deepEqual(reviewerMenus, ['glossary', 'review']);
    assert.equal(reviewerMenus.includes('members'), false);
  });

  it('luồng Mời thành viên -> Đăng nhập bằng mật khẩu tạm -> Đặt mật khẩu mới và chuyển trạng thái sang Hoạt động', async () => {
    const inviteRes = await inviteTenantMember(
      'TENANT_ADMIN',
      'thu@homestay-abc.example',
      'REVIEWER',
      'Homestay ABC Hội An',
      DEFAULT_DEMO_TENANT_ID,
    );
    assert.equal(inviteRes.member.status, 'PENDING_FIRST_LOGIN');
    assert.equal(inviteRes.member.role, 'REVIEWER');
    assert.equal(inviteRes.member.tenantId, DEFAULT_DEMO_TENANT_ID);

    const loginOutcome = await signInWithEmail({
      email: 'thu@homestay-abc.example',
      password: inviteRes.temporaryPassword,
    });
    assert.equal(loginOutcome.status, 'NEW_PASSWORD_REQUIRED');

    const newSession = await completeInvitedMemberPassword({
      email: 'thu@homestay-abc.example',
      temporaryPassword: inviteRes.temporaryPassword,
      newPassword: 'NewSecurePassword123',
      confirmNewPassword: 'NewSecurePassword123',
    });
    assert.equal(newSession.role, 'REVIEWER');
    assert.equal(newSession.tenantStatus, 'ACTIVE');
    assert.equal(newSession.tenantId, DEFAULT_DEMO_TENANT_ID);

    const members = await listTenantMembers(DEFAULT_DEMO_TENANT_ID);
    const thuMember = members.find((m) => m.email === 'thu@homestay-abc.example');
    assert.equal(thuMember?.status, 'ACTIVE');
  });

  it('luồng Quên mật khẩu 2 bước: Gửi mã khôi phục 6 chữ số -> Đặt mật khẩu mới -> Đăng nhập thành công', async () => {
    const resetReq = await requestPasswordResetCode('lan@homestay-abc.example');
    assert.equal(resetReq.email, 'lan@homestay-abc.example');
    assert.match(resetReq.demoResetCode, /^\d{6}$/);

    await confirmForgotPasswordReset({
      email: 'lan@homestay-abc.example',
      code: resetReq.demoResetCode,
      newPassword: 'BrandNewPassword9',
      confirmNewPassword: 'BrandNewPassword9',
    });

    const outcome = await signInWithEmail({
      email: 'lan@homestay-abc.example',
      password: 'BrandNewPassword9',
    });
    assert.equal(outcome.status, 'AUTHENTICATED');
    if (outcome.status === 'AUTHENTICATED') {
      assert.equal(outcome.session.tenantStatus, 'ACTIVE');
    }
  });

  it('quản lý tenantStatus từ chế độ demo (setDemoTenantStatus) và qua GET /console/me (ACTIVE / LOCKED / fail-closed UNKNOWN)', async () => {
    assert.equal(getDemoTenantStatus(DEFAULT_DEMO_TENANT_ID), 'ACTIVE');

    setDemoTenantStatus(DEFAULT_DEMO_TENANT_ID, 'LOCKED');
    assert.equal(getDemoTenantStatus(DEFAULT_DEMO_TENANT_ID), 'LOCKED');

    const lockedSignIn = await signInWithEmail({
      email: 'lan@homestay-abc.example',
      password: 'Password123',
    });
    assert.equal(lockedSignIn.status, 'AUTHENTICATED');
    if (lockedSignIn.status === 'AUTHENTICATED') {
      assert.equal(lockedSignIn.session.tenantStatus, 'LOCKED');
    }

    await assert.rejects(
      inviteTenantMember(
        'TENANT_ADMIN',
        'blocked@homestay-abc.example',
        'DEVELOPER',
        'Homestay ABC Hội An',
        DEFAULT_DEMO_TENANT_ID,
      ),
      (err: unknown) => err instanceof ConsoleAuthError && err.code === 'TENANT_SUSPENDED',
    );

    resetSimulatedAuthStore();
    assert.equal(getDemoTenantStatus(DEFAULT_DEMO_TENANT_ID), 'ACTIVE');

    const baseSession = {
      email: 'lan@homestay-abc.example',
      fullName: 'Nguyễn Thị Lan',
      sub: 'sub-lan-admin-01',
      tenantId: 't_live_1',
      organizationName: 'Old Org',
      plan: 'FREE' as const,
      role: 'TENANT_ADMIN' as const,
      tenantStatus: 'UNKNOWN' as const,
      idToken: 'jwt-live',
      accessToken: 'at-live',
      refreshToken: 'rt-live',
      tokenRefreshedAt: '2026-11-10T00:00:00.000Z',
    };

    const lockedProfile = await hydrateSessionTenantStatus(baseSession, {
      demoMode: false,
      baseUrl: 'https://api.translateme.example/',
      fetchFn: async (url, init) => {
        assert.equal(String(url), 'https://api.translateme.example/console/me');
        assert.equal((init?.headers as Record<string, string>)?.authorization, 'Bearer jwt-live');
        return new Response(
          JSON.stringify({
            tenant_id: 't_live_1',
            role: 'reviewer',
            tenant_status: 'LOCKED',
            tenant_locked: true,
            organization_name: 'New Resort',
            plan: 'PRO',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    assert.equal(lockedProfile.tenantStatus, 'LOCKED');
    assert.equal(lockedProfile.role, 'REVIEWER');
    assert.equal(lockedProfile.organizationName, 'New Resort');
    assert.equal(lockedProfile.plan, 'PRO');

    const activeProfile = await fetchConsoleTenantProfile(baseSession, {
      demoMode: false,
      baseUrl: 'https://api.translateme.example',
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            tenantId: 't_live_1',
            role: 'TENANT_ADMIN',
            tenantStatus: 'ACTIVE',
            tenantLocked: false,
          }),
          { status: 200 },
        ),
    });
    assert.equal(activeProfile.tenantStatus, 'ACTIVE');
    assert.equal(activeProfile.tenantLocked, false);

    // 403 TENANT_SUSPENDED -> hydrate thành LOCKED
    const suspendedSession = await hydrateSessionTenantStatus(baseSession, {
      demoMode: false,
      baseUrl: 'https://api.translateme.example',
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            request_id: 'req-susp',
            error: { code: 'TENANT_SUSPENDED', message: 'Locked' },
          }),
          { status: 403 },
        ),
    });
    assert.equal(suspendedSession.tenantStatus, 'LOCKED');

    // Lỗi 500, phản hồi thiếu trạng thái hoặc lỗi mạng -> giữ UNKNOWN (fail-closed)
    for (const fetchFn of [
      async () =>
        new Response(
          JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Boom' } }),
          { status: 500 },
        ),
      async () => new Response(JSON.stringify({ tenant_id: 't_live_1' }), { status: 200 }),
      async () => {
        throw new TypeError('Failed to fetch');
      },
    ]) {
      const unknownSession = await hydrateSessionTenantStatus(
        { ...baseSession, tenantStatus: 'ACTIVE' },
        {
          demoMode: false,
          baseUrl: 'https://api.translateme.example',
          fetchFn,
        },
      );
      assert.equal(unknownSession.tenantStatus, 'UNKNOWN');
    }
  });

  it('hiển thị rõ các lỗi: email đã dùng, mật khẩu yếu, mã xác nhận sai/hết hạn, đăng nhập sai nhiều lần', async () => {
    // 1. Email đã dùng
    await assert.rejects(
      registerAccount({
        fullName: 'Lan',
        email: 'lan@homestay-abc.example',
        password: 'Password123',
        organizationName: 'Homestay ABC',
        acceptedTerms: true,
      }),
      (err: unknown) =>
        err instanceof ConsoleAuthError &&
        err.code === 'UsernameExistsException' &&
        /đã được đăng ký/.test(mapCognitoErrorToVietnamese(err)),
    );

    // 2. Mật khẩu yếu
    await assert.rejects(
      registerAccount({
        fullName: 'Người mới',
        email: 'new@homestay-abc.example',
        password: 'weak',
        organizationName: 'Homestay ABC',
        acceptedTerms: true,
      }),
      (err: unknown) =>
        err instanceof ConsoleAuthError &&
        err.code === 'InvalidPasswordException' &&
        /còn thiếu/.test(mapCognitoErrorToVietnamese(err)),
    );

    // 3. Mã xác nhận sai & mã hết hạn
    await assert.rejects(
      confirmEmailAndRefreshSession({
        email: 'lan@homestay-abc.example',
        code: '999999',
      }),
      (err: unknown) =>
        err instanceof ConsoleAuthError &&
        err.code === 'CodeMismatchException' &&
        /không chính xác/.test(mapCognitoErrorToVietnamese(err)),
    );

    await assert.rejects(
      confirmEmailAndRefreshSession({
        email: 'lan@homestay-abc.example',
        code: '000000',
      }),
      (err: unknown) =>
        err instanceof ConsoleAuthError &&
        err.code === 'ExpiredCodeException' &&
        /hết hạn/.test(mapCognitoErrorToVietnamese(err)),
    );

    // 4. Đăng nhập sai nhiều lần -> khóa tạm thời
    for (let i = 0; i < 4; i++) {
      await assert.rejects(
        signInWithEmail({ email: 'lan@homestay-abc.example', password: 'WrongPassword1' }),
        (err: unknown) => err instanceof ConsoleAuthError && err.code === 'NotAuthorizedException',
      );
    }
    await assert.rejects(
      signInWithEmail({ email: 'lan@homestay-abc.example', password: 'WrongPassword1' }),
      (err: unknown) =>
        err instanceof ConsoleAuthError &&
        err.code === 'TooManyFailedAttemptsException' &&
        /quá nhiều lần/.test(mapCognitoErrorToVietnamese(err)),
    );
  });
});
