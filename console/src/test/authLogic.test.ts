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
