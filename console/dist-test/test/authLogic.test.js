import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { completeInvitedMemberPassword, confirmEmailAndRefreshSession, ConsoleAuthError, decodeJwtClaims, getVisibleMenuItems, inviteTenantMember, listTenantMembers, mapCognitoErrorToVietnamese, normalizeRole, registerAccount, resetSimulatedAuthStore, signInWithEmail, validatePasswordPolicy, } from '../services/cognitoAuth.js';
describe('Task 2.9 – Web Console: Khung, Đăng nhập & Màn Q1', () => {
    beforeEach(() => {
        resetSimulatedAuthStore();
    });
    it('kiểm tra chính sách mật khẩu Cognito (>= 8 ký tự, chữ hoa, chữ thường, chữ số)', () => {
        assert.equal(validatePasswordPolicy('Short1').valid, false);
        assert.equal(validatePasswordPolicy('alllowercase123').valid, false);
        assert.equal(validatePasswordPolicy('ALLUPPERCASE123').valid, false);
        assert.equal(validatePasswordPolicy('NoDigitsPassword').valid, false);
        assert.equal(validatePasswordPolicy('Password123').valid, true);
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
        assert.equal(claims['custom:role'], 'TENANT_ADMIN');
    });
    it('ẩn/hiện đúng danh sách menu bên trái theo từng vai trò (TENANT_ADMIN, DEVELOPER, REVIEWER)', () => {
        assert.equal(normalizeRole('Tenant Admin'), 'TENANT_ADMIN');
        assert.equal(normalizeRole('TENANT_ADMIN'), 'TENANT_ADMIN');
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
        const inviteRes = await inviteTenantMember('TENANT_ADMIN', 'thu@homestay-abc.example', 'REVIEWER', 'Homestay ABC Hội An');
        assert.equal(inviteRes.member.status, 'PENDING_FIRST_LOGIN');
        assert.equal(inviteRes.member.role, 'REVIEWER');
        // Khi thành viên được mời đăng nhập lần đầu bằng mật khẩu tạm -> nhận challenge NEW_PASSWORD_REQUIRED
        const loginOutcome = await signInWithEmail({
            email: 'thu@homestay-abc.example',
            password: inviteRes.temporaryPassword,
        });
        assert.equal(loginOutcome.status, 'NEW_PASSWORD_REQUIRED');
        // Hoàn tất đặt mật khẩu mới -> vào thẳng Web Console và chuyển trạng thái thành ACTIVE ("Hoạt động")
        const newSession = await completeInvitedMemberPassword({
            email: 'thu@homestay-abc.example',
            temporaryPassword: inviteRes.temporaryPassword,
            newPassword: 'NewSecurePassword123',
            confirmNewPassword: 'NewSecurePassword123',
        });
        assert.equal(newSession.role, 'REVIEWER');
        const members = await listTenantMembers();
        const thuMember = members.find((m) => m.email === 'thu@homestay-abc.example');
        assert.equal(thuMember?.status, 'ACTIVE');
    });
    it('hiển thị rõ các lỗi: email đã dùng, mật khẩu yếu, mã xác nhận sai/hết hạn, đăng nhập sai nhiều lần', async () => {
        // 1. Email đã dùng
        await assert.rejects(registerAccount({
            fullName: 'Lan',
            email: 'lan@homestay-abc.example',
            password: 'Password123',
            organizationName: 'Homestay ABC',
            acceptedTerms: true,
        }), (err) => err instanceof ConsoleAuthError &&
            err.code === 'UsernameExistsException' &&
            /đã được đăng ký/.test(mapCognitoErrorToVietnamese(err)));
        // 2. Mật khẩu yếu
        await assert.rejects(registerAccount({
            fullName: 'Người mới',
            email: 'new@homestay-abc.example',
            password: 'weak',
            organizationName: 'Homestay ABC',
            acceptedTerms: true,
        }), (err) => err instanceof ConsoleAuthError &&
            err.code === 'InvalidPasswordException' &&
            /tối thiểu 8 ký tự/.test(mapCognitoErrorToVietnamese(err)));
        // 3. Mã xác nhận sai & mã hết hạn
        await assert.rejects(confirmEmailAndRefreshSession({
            email: 'lan@homestay-abc.example',
            code: '999999',
        }), (err) => err instanceof ConsoleAuthError &&
            err.code === 'CodeMismatchException' &&
            /không chính xác/.test(mapCognitoErrorToVietnamese(err)));
        await assert.rejects(confirmEmailAndRefreshSession({
            email: 'lan@homestay-abc.example',
            code: '000000',
        }), (err) => err instanceof ConsoleAuthError &&
            err.code === 'ExpiredCodeException' &&
            /hết hạn/.test(mapCognitoErrorToVietnamese(err)));
        // 4. Đăng nhập sai nhiều lần -> khóa tạm thời
        for (let i = 0; i < 4; i++) {
            await assert.rejects(signInWithEmail({ email: 'lan@homestay-abc.example', password: 'WrongPassword1' }), (err) => err instanceof ConsoleAuthError && err.code === 'NotAuthorizedException');
        }
        await assert.rejects(signInWithEmail({ email: 'lan@homestay-abc.example', password: 'WrongPassword1' }), (err) => err instanceof ConsoleAuthError &&
            err.code === 'TooManyFailedAttemptsException' &&
            /quá nhiều lần/.test(mapCognitoErrorToVietnamese(err)));
    });
});
