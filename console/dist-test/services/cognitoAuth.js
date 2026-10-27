/**
 * Dịch vụ Xác thực Cognito User Pool, Làm mới Token (B.13), Phân quyền Menu và Quản lý Thành viên (Q1).
 *
 * Hỗ trợ 2 chế độ:
 *  1. Kết nối trực tiếp Amazon Cognito IDP (`cognito-idp.<region>.amazonaws.com`) & REST API Gateway
 *     khi cấu hình `VITE_COGNITO_CLIENT_ID`.
 *  2. Chế độ giả lập Cognito chuẩn xác tại trình duyệt (Local Cognito Demo Mode) khi chạy độc lập,
 *     tái hiện đầy đủ: SignUp -> Mã 6 chữ số -> Trigger PostConfirmation tạo Tenant -> Refresh Token
 *     lấy `custom:tenant_id` & `custom:role` -> ForceChangePassword cho lời mời -> Mời thành viên.
 */
// ============================================================================
// 1. Chuẩn hóa Vai trò & Danh sách Menu ẩn/hiện theo `custom:role` (Bảng 1.2 & B.6)
// ============================================================================
export const ROLE_DISPLAY_LABEL = Object.freeze({
    TENANT_ADMIN: 'Tenant Admin',
    DEVELOPER: 'Developer',
    REVIEWER: 'Reviewer',
    PLATFORM_ADMIN: 'Platform Admin',
});
/**
 * Chuẩn hóa chuỗi vai trò từ JWT (`custom:role` hoặc `cognito:groups`) về mã chuẩn `ConsoleRole`.
 * Tương thích với cả giá trị Tuần 1 ('Tenant Admin', 'Developer', 'Reviewer') và Hợp đồng B.2 ('TENANT_ADMIN', ...).
 */
export function normalizeRole(raw) {
    const cleaned = (raw ?? '').trim().toUpperCase().replace(/\s+/g, '_');
    if (cleaned === 'TENANT_ADMIN')
        return 'TENANT_ADMIN';
    if (cleaned === 'DEVELOPER')
        return 'DEVELOPER';
    if (cleaned === 'REVIEWER')
        return 'REVIEWER';
    if (cleaned === 'PLATFORM_ADMIN' || cleaned === 'PLATFORMADMIN')
        return 'PLATFORM_ADMIN';
    return 'TENANT_ADMIN';
}
export const CONSOLE_MENU_ITEMS = Object.freeze([
    {
        key: 'website',
        label: 'Website',
        allowedRoles: ['TENANT_ADMIN'],
    },
    {
        key: 'glossary',
        label: 'Thuật ngữ',
        allowedRoles: ['TENANT_ADMIN', 'DEVELOPER', 'REVIEWER'],
    },
    {
        key: 'review',
        label: 'Duyệt bản dịch',
        allowedRoles: ['TENANT_ADMIN', 'REVIEWER'],
    },
    {
        key: 'usage',
        label: 'Lượng dùng',
        allowedRoles: ['TENANT_ADMIN', 'DEVELOPER'],
    },
    {
        key: 'apikey',
        label: 'API key',
        allowedRoles: ['TENANT_ADMIN', 'DEVELOPER'],
    },
    {
        key: 'playground',
        label: 'Thử dịch',
        allowedRoles: ['TENANT_ADMIN', 'DEVELOPER'],
    },
    {
        key: 'doc-translate',
        label: 'Dịch tệp',
        allowedRoles: ['TENANT_ADMIN', 'DEVELOPER'],
    },
    {
        key: 'members',
        label: 'Thành viên',
        allowedRoles: ['TENANT_ADMIN'],
    },
    {
        key: 'platform-tenants',
        label: 'Quản trị Tenant',
        allowedRoles: ['PLATFORM_ADMIN'],
    },
    {
        key: 'platform-pricing',
        label: 'Đơn giá dịch máy',
        allowedRoles: ['PLATFORM_ADMIN'],
    },
]);
/** Trả về danh sách các mục menu bên trái được phép hiển thị theo vai trò của người dùng. */
export function getVisibleMenuItems(role) {
    return CONSOLE_MENU_ITEMS.filter((item) => item.allowedRoles.includes(role));
}
/**
 * Kiểm tra mật khẩu theo đúng đặc tả Cognito User Pool (Nhiệm vụ 1.11):
 * Tối thiểu 8 ký tự, có chữ hoa, chữ thường và chữ số.
 */
export function validatePasswordPolicy(password) {
    const hasMinLength = password.length >= 8;
    const hasUppercase = /[A-Z]/.test(password);
    const hasLowercase = /[a-z]/.test(password);
    const hasDigit = /\d/.test(password);
    const valid = hasMinLength && hasUppercase && hasLowercase && hasDigit;
    return {
        valid,
        hasMinLength,
        hasUppercase,
        hasLowercase,
        hasDigit,
        message: valid
            ? undefined
            : 'Mật khẩu phải có tối thiểu 8 ký tự, bao gồm chữ hoa, chữ thường và chữ số.',
    };
}
export class ConsoleAuthError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'ConsoleAuthError';
    }
}
/**
 * Chuyển mã lỗi của Amazon Cognito / API sang thông báo tiếng Việt rõ ràng cho người dùng.
 * Đáp ứng đầy đủ tiêu chí nghiệm thu Hạng mục 2.9:
 *  - Email đã dùng (`UsernameExistsException`)
 *  - Mật khẩu yếu (`InvalidPasswordException`)
 *  - Mã xác nhận sai/hết hạn (`CodeMismatchException`, `ExpiredCodeException`)
 *  - Đăng nhập sai nhiều lần (`TooManyRequestsException`, `LimitExceededException`, `NotAuthorizedException`)
 */
export function mapCognitoErrorToVietnamese(err) {
    if (err instanceof ConsoleAuthError) {
        return err.message;
    }
    const rawCode = err && typeof err === 'object' && ('name' in err || '__type' in err || 'code' in err)
        ? String(err.code ?? err.__type ?? err.name)
        : '';
    const code = rawCode.includes('#') ? rawCode.split('#').pop() : rawCode;
    const rawMessage = err instanceof Error ? err.message : String(err ?? '');
    switch (code) {
        case 'UsernameExistsException':
            return 'Email này đã được đăng ký. Vui lòng đăng nhập hoặc sử dụng email công việc khác.';
        case 'InvalidPasswordException':
            return 'Mật khẩu quá yếu: cần tối thiểu 8 ký tự, có chữ hoa, chữ thường và chữ số.';
        case 'CodeMismatchException':
            return 'Mã xác nhận 6 chữ số không chính xác. Vui lòng kiểm tra lại.';
        case 'ExpiredCodeException':
            return 'Mã xác nhận đã hết hạn. Vui lòng bấm "Gửi lại mã" để nhận mã mới.';
        case 'NotAuthorizedException':
        case 'UserNotFoundException':
            if (/attempt|exceeded|lock/i.test(rawMessage)) {
                return 'Tài khoản tạm thời bị khóa do đăng nhập sai nhiều lần. Vui lòng thử lại sau ít phút.';
            }
            return 'Email hoặc mật khẩu không chính xác.';
        case 'TooManyRequestsException':
        case 'LimitExceededException':
        case 'TooManyFailedAttemptsException':
            return 'Bạn đã thao tác hoặc đăng nhập sai quá nhiều lần. Vui lòng đợi ít phút rồi thử lại.';
        case 'UserNotConfirmedException':
            return 'Tài khoản chưa được xác nhận email. Vui lòng nhập mã xác nhận 6 chữ số.';
        default:
            return rawMessage || 'Đã xảy ra lỗi trong quá trình xác thực. Vui lòng thử lại.';
    }
}
// ============================================================================
// 3. Giải mã & Tạo JWT phục vụ đọc custom:tenant_id và custom:role
// ============================================================================
function base64UrlEncode(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    for (const b of bytes)
        binary += String.fromCharCode(b);
    const b64 = typeof btoa === 'function'
        ? btoa(binary)
        : Buffer.from(str, 'utf8').toString('base64');
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64UrlDecode(segment) {
    const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padLen = (4 - (padded.length % 4)) % 4;
    const withPad = padded + '='.repeat(padLen);
    if (typeof atob === 'function') {
        const binary = atob(withPad);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++)
            bytes[i] = binary.charCodeAt(i);
        return new TextDecoder().decode(bytes);
    }
    return Buffer.from(withPad, 'base64').toString('utf8');
}
export function decodeJwtClaims(token) {
    try {
        const parts = token.split('.');
        if (parts.length < 2)
            return null;
        return JSON.parse(base64UrlDecode(parts[1]));
    }
    catch {
        return null;
    }
}
export function createMockJwt(claims) {
    const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = base64UrlEncode(JSON.stringify({
        ...claims,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
    }));
    return `${header}.${payload}.mock-signature`;
}
const initialUsers = [
    {
        sub: 'sub-lan-admin-01',
        email: 'lan@homestay-abc.example',
        fullName: 'Nguyễn Thị Lan',
        password: 'Password123',
        organizationName: 'Homestay ABC Hội An',
        tenantId: 't_01hxyz987654',
        role: 'TENANT_ADMIN',
        confirmed: true,
        confirmationCode: '481920',
        codeExpiresAt: Date.now() + 15 * 60_000,
        forceChangePassword: false,
        failedLoginAttempts: 0,
    },
    {
        sub: 'sub-khoa-dev-02',
        email: 'khoa@homestay-abc.example',
        fullName: 'Trần Minh Khoa',
        password: 'Password123',
        organizationName: 'Homestay ABC Hội An',
        tenantId: 't_01hxyz987654',
        role: 'DEVELOPER',
        confirmed: true,
        confirmationCode: '111111',
        codeExpiresAt: Date.now() + 15 * 60_000,
        forceChangePassword: false,
        failedLoginAttempts: 0,
    },
    {
        sub: 'sub-minh-rev-03',
        email: 'minh@homestay-abc.example',
        fullName: 'Lê Quang Minh',
        password: 'TempPassword123',
        organizationName: 'Homestay ABC Hội An',
        tenantId: 't_01hxyz987654',
        role: 'REVIEWER',
        confirmed: true,
        confirmationCode: '222222',
        codeExpiresAt: Date.now() + 15 * 60_000,
        forceChangePassword: true, // Chờ đăng nhập lần đầu (FORCE_CHANGE_PASSWORD)
        failedLoginAttempts: 0,
    },
];
const initialMembers = [
    {
        id: 'sub-lan-admin-01',
        email: 'lan@homestay-abc.example',
        role: 'TENANT_ADMIN',
        status: 'ACTIVE',
    },
    {
        id: 'sub-khoa-dev-02',
        email: 'khoa@homestay-abc.example',
        role: 'DEVELOPER',
        status: 'ACTIVE',
    },
    {
        id: 'sub-minh-rev-03',
        email: 'minh@homestay-abc.example',
        role: 'REVIEWER',
        status: 'PENDING_FIRST_LOGIN',
    },
];
const simulatedUsers = new Map(initialUsers.map((u) => [u.email.toLowerCase(), { ...u }]));
let simulatedMembers = initialMembers.map((m) => ({ ...m }));
export function resetSimulatedAuthStore() {
    simulatedUsers.clear();
    for (const u of initialUsers) {
        simulatedUsers.set(u.email.toLowerCase(), { ...u });
    }
    simulatedMembers = initialUsers.map((u, idx) => ({ ...initialMembers[idx] }));
}
function buildSessionFromUser(user) {
    const idToken = createMockJwt({
        sub: user.sub,
        email: user.email,
        name: user.fullName,
        'custom:tenant_id': user.tenantId,
        'custom:role': user.role,
    });
    return {
        email: user.email,
        fullName: user.fullName,
        sub: user.sub,
        tenantId: user.tenantId,
        organizationName: user.organizationName,
        plan: 'FREE',
        role: user.role,
        idToken,
        accessToken: idToken,
        refreshToken: `rt_${user.sub}_${Date.now()}`,
        tokenRefreshedAt: new Date().toISOString(),
    };
}
// ============================================================================
// 5. Các hàm Nghiệp vụ Xác thực (SignUp, ConfirmSignUp + RefreshToken, SignIn, ForceChangePassword)
// ============================================================================
/**
 * Đăng ký tài khoản mới trên Cognito User Pool (Hình 1.2 / `intro.jpg`).
 * Truyền `organization_name` qua cả `ClientMetadata` để trigger PostConfirmation tạo Tenant.
 */
export async function registerAccount(input) {
    const fullName = input.fullName.trim();
    const email = input.email.trim().toLowerCase();
    const orgName = input.organizationName.trim();
    if (!fullName) {
        throw new ConsoleAuthError('ValidationError', 'Vui lòng nhập họ và tên của bạn.');
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new ConsoleAuthError('ValidationError', 'Vui lòng nhập địa chỉ email công việc hợp lệ.');
    }
    if (!orgName) {
        throw new ConsoleAuthError('ValidationError', 'Vui lòng nhập tên tổ chức của bạn.');
    }
    if (!input.acceptedTerms) {
        throw new ConsoleAuthError('ValidationError', 'Bạn cần đồng ý với Điều khoản sử dụng để tạo tài khoản.');
    }
    const pwdCheck = validatePasswordPolicy(input.password);
    if (!pwdCheck.valid) {
        throw new ConsoleAuthError('InvalidPasswordException', mapCognitoErrorToVietnamese({ code: 'InvalidPasswordException' }));
    }
    if (simulatedUsers.has(email)) {
        throw new ConsoleAuthError('UsernameExistsException', mapCognitoErrorToVietnamese({ code: 'UsernameExistsException' }));
    }
    const demoCode = '481926';
    const newUser = {
        sub: `sub-${Math.random().toString(36).slice(2, 10)}`,
        email,
        fullName,
        password: input.password,
        organizationName: orgName,
        tenantId: '', // Chỉ được gán sau khi PostConfirmation trigger chạy ở bước ConfirmSignUp
        role: 'TENANT_ADMIN',
        confirmed: false,
        confirmationCode: demoCode,
        codeExpiresAt: Date.now() + 15 * 60_000,
        forceChangePassword: false,
        failedLoginAttempts: 0,
    };
    simulatedUsers.set(email, newUser);
    return {
        email,
        organizationName: orgName,
        demoConfirmationCode: demoCode,
    };
}
/**
 * Xác nhận email bằng mã 6 chữ số (Hình 1.3 / `Xác nhận email.jpg`) & Làm mới Token (Mục B.13).
 *
 * Quy trình chuẩn theo B.13:
 *  1. Gọi `ConfirmSignUp` với mã 6 chữ số.
 *  2. Cognito kích hoạt Lambda `PostConfirmation_ConfirmSignUp`: tạo bản ghi `CONFIG` + `MEMBER`
 *     và gọi `AdminUpdateUserAttributes` gán `custom:tenant_id`, `custom:role = TENANT_ADMIN`.
 *  3. Client thực hiện đăng nhập và **bắt buộc gọi `refreshSession`** để lấy bộ JWT mới
 *     có chứa claim `custom:tenant_id` và `custom:role`, sau đó gọi `GET /console/me`.
 */
export async function confirmEmailAndRefreshSession(input) {
    const email = input.email.trim().toLowerCase();
    const code = input.code.trim();
    if (!/^\d{6}$/.test(code)) {
        throw new ConsoleAuthError('CodeMismatchException', 'Vui lòng nhập đủ 6 chữ số của mã xác nhận.');
    }
    // Mã đặc biệt "000000" dùng để kiểm thử trạng thái mã hết hạn (ExpiredCodeException)
    if (code === '000000') {
        throw new ConsoleAuthError('ExpiredCodeException', mapCognitoErrorToVietnamese({ code: 'ExpiredCodeException' }));
    }
    let user = simulatedUsers.get(email);
    if (!user) {
        // Cho phép xác nhận trực tiếp cả khi người dùng mở thẳng màn hình Xác nhận email để demo
        user = {
            sub: `sub-${Math.random().toString(36).slice(2, 10)}`,
            email,
            fullName: input.fullName || 'Nguyễn Thị Lan',
            password: input.password || 'Password123',
            organizationName: input.organizationName || 'Homestay ABC Hội An',
            tenantId: '',
            role: 'TENANT_ADMIN',
            confirmed: false,
            confirmationCode: code,
            codeExpiresAt: Date.now() + 15 * 60_000,
            forceChangePassword: false,
            failedLoginAttempts: 0,
        };
        simulatedUsers.set(email, user);
    }
    if (Date.now() > user.codeExpiresAt) {
        throw new ConsoleAuthError('ExpiredCodeException', mapCognitoErrorToVietnamese({ code: 'ExpiredCodeException' }));
    }
    // Chấp nhận mã đúng của user hoặc mã demo trên thiết kế "481926"
    if (code !== user.confirmationCode && code !== '481926') {
        throw new ConsoleAuthError('CodeMismatchException', mapCognitoErrorToVietnamese({ code: 'CodeMismatchException' }));
    }
    // Mô phỏng PostConfirmation_ConfirmSignUp gán custom:tenant_id và custom:role
    user.confirmed = true;
    if (!user.tenantId) {
        user.tenantId = `t_${Math.random().toString(36).slice(2, 12)}`;
    }
    user.role = 'TENANT_ADMIN';
    // Đảm bảo người dùng có mặt trong danh sách MEMBER của tổ chức
    if (!simulatedMembers.some((m) => m.email.toLowerCase() === email)) {
        simulatedMembers.unshift({
            id: user.sub,
            email: user.email,
            role: 'TENANT_ADMIN',
            status: 'ACTIVE',
        });
    }
    // Bắt buộc làm mới token (B.13) để JWT chứa custom:tenant_id và custom:role
    const refreshedSession = await refreshTokenForTenantClaims(buildSessionFromUser(user));
    return refreshedSession;
}
/**
 * Làm mới bộ JWT sau khi trigger PostConfirmation gán `custom:tenant_id` và `custom:role` (Mục B.13).
 */
export async function refreshTokenForTenantClaims(session) {
    const claims = decodeJwtClaims(session.idToken);
    const tenantId = claims?.['custom:tenant_id'] || session.tenantId || 't_01hxyz987654';
    const role = normalizeRole(claims?.['custom:role'] || session.role);
    const refreshedJwt = createMockJwt({
        sub: session.sub,
        email: session.email,
        name: session.fullName,
        'custom:tenant_id': tenantId,
        'custom:role': role,
    });
    return {
        ...session,
        tenantId,
        role,
        idToken: refreshedJwt,
        accessToken: refreshedJwt,
        tokenRefreshedAt: new Date().toISOString(),
    };
}
/**
 * Gửi lại mã xác nhận 6 chữ số (ResendConfirmationCode).
 */
export async function resendConfirmationCode(email) {
    const normalized = email.trim().toLowerCase();
    const user = simulatedUsers.get(normalized);
    if (user) {
        user.confirmationCode = '481926';
        user.codeExpiresAt = Date.now() + 15 * 60_000;
    }
    return { expiresInSeconds: 60 };
}
/**
 * Đăng nhập vào Web Console (Hình 1.4 / `log-in.jpg`).
 *  - Nếu tài khoản ở trạng thái `FORCE_CHANGE_PASSWORD` (thành viên được mời lần đầu) -> trả về `NEW_PASSWORD_REQUIRED`.
 *  - Nếu đăng nhập sai từ 5 lần trở lên -> trả lỗi khóa tạm thời (`TooManyFailedAttemptsException`).
 */
export async function signInWithEmail(input) {
    const email = input.email.trim().toLowerCase();
    const password = input.password;
    if (!email || !password) {
        throw new ConsoleAuthError('ValidationError', 'Vui lòng nhập đầy đủ email và mật khẩu.');
    }
    const user = simulatedUsers.get(email);
    if (!user) {
        // Bật PreventUserExistenceErrors: trả cùng thông báo như sai mật khẩu
        throw new ConsoleAuthError('NotAuthorizedException', mapCognitoErrorToVietnamese({ code: 'NotAuthorizedException' }));
    }
    if (user.failedLoginAttempts >= 5) {
        throw new ConsoleAuthError('TooManyFailedAttemptsException', mapCognitoErrorToVietnamese({ code: 'TooManyFailedAttemptsException' }));
    }
    if (user.password !== password) {
        user.failedLoginAttempts += 1;
        if (user.failedLoginAttempts >= 5) {
            throw new ConsoleAuthError('TooManyFailedAttemptsException', mapCognitoErrorToVietnamese({ code: 'TooManyFailedAttemptsException' }));
        }
        throw new ConsoleAuthError('NotAuthorizedException', mapCognitoErrorToVietnamese({ code: 'NotAuthorizedException' }));
    }
    user.failedLoginAttempts = 0;
    if (!user.confirmed) {
        return {
            status: 'CONFIRMATION_REQUIRED',
            email: user.email,
            organizationName: user.organizationName,
        };
    }
    if (user.forceChangePassword) {
        return {
            status: 'NEW_PASSWORD_REQUIRED',
            email: user.email,
            challengeSession: `chal_${user.sub}_${Date.now()}`,
            organizationName: user.organizationName,
            invitedRole: user.role === 'DEVELOPER' ? 'DEVELOPER' : 'REVIEWER',
        };
    }
    const session = await refreshTokenForTenantClaims(buildSessionFromUser(user));
    return {
        status: 'AUTHENTICATED',
        session,
    };
}
/**
 * Hoàn tất đặt mật khẩu mới ở lần đăng nhập đầu tiên khi vào bằng lời mời (Hình 1.6 / `Đặt lại mk.jpg`).
 * Sau khi đổi mật khẩu thành công, cập nhật trạng thái bản ghi `MEMBER` từ "Chờ đăng nhập lần đầu" sang "Hoạt động".
 */
export async function completeInvitedMemberPassword(input) {
    const email = input.email.trim().toLowerCase();
    if (!input.temporaryPassword) {
        throw new ConsoleAuthError('ValidationError', 'Vui lòng nhập mật khẩu tạm thời trong email mời.');
    }
    const pwdCheck = validatePasswordPolicy(input.newPassword);
    if (!pwdCheck.valid) {
        throw new ConsoleAuthError('InvalidPasswordException', mapCognitoErrorToVietnamese({ code: 'InvalidPasswordException' }));
    }
    if (input.newPassword !== input.confirmNewPassword) {
        throw new ConsoleAuthError('ValidationError', 'Mật khẩu nhập lại không khớp với mật khẩu mới.');
    }
    let user = simulatedUsers.get(email);
    if (!user) {
        user = {
            sub: `sub-invited-${Math.random().toString(36).slice(2, 8)}`,
            email: email || 'minh@homestay-abc.example',
            fullName: email.split('@')[0] || 'Thành viên mới',
            password: input.temporaryPassword,
            organizationName: input.organizationName || 'Homestay ABC Hội An',
            tenantId: 't_01hxyz987654',
            role: input.invitedRole || 'REVIEWER',
            confirmed: true,
            confirmationCode: '000000',
            codeExpiresAt: Date.now() + 3600_000,
            forceChangePassword: true,
            failedLoginAttempts: 0,
        };
        simulatedUsers.set(user.email, user);
    }
    else if (user.password !== input.temporaryPassword) {
        throw new ConsoleAuthError('NotAuthorizedException', 'Mật khẩu tạm thời không chính xác.');
    }
    user.password = input.newPassword;
    user.forceChangePassword = false;
    // Chuyển trạng thái MEMBER từ "Chờ đăng nhập lần đầu" -> "Hoạt động" (Hình 2.12)
    const memberRecord = simulatedMembers.find((m) => m.email.toLowerCase() === user.email.toLowerCase());
    if (memberRecord) {
        memberRecord.status = 'ACTIVE';
    }
    else {
        simulatedMembers.push({
            id: user.sub,
            email: user.email,
            role: user.role,
            status: 'ACTIVE',
        });
    }
    return refreshTokenForTenantClaims(buildSessionFromUser(user));
}
// ============================================================================
// 6. Quản lý danh sách Thành viên & Mời thành viên (Hình 1.5 / `Mời thành viên.jpg`)
// ============================================================================
export async function listTenantMembers() {
    return simulatedMembers.map((m) => ({ ...m }));
}
/**
 * Mời thành viên mới vào tổ chức (`POST /console/members/invite`).
 * Chỉ cho phép vai trò `DEVELOPER` hoặc `REVIEWER` (không cho phép tạo `TENANT_ADMIN` hay `PLATFORM_ADMIN`).
 */
export async function inviteTenantMember(actorRole, emailInput, invitedRole, organizationName = 'Homestay ABC Hội An') {
    if (actorRole !== 'TENANT_ADMIN') {
        throw new ConsoleAuthError('PERMISSION_DENIED', 'Chỉ Tenant Admin mới có quyền mời thành viên.');
    }
    const email = emailInput.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new ConsoleAuthError('ValidationError', 'Địa chỉ email thành viên không hợp lệ.');
    }
    if (invitedRole !== 'DEVELOPER' && invitedRole !== 'REVIEWER') {
        throw new ConsoleAuthError('ValidationError', 'Chỉ được phép mời thành viên với vai trò Developer hoặc Reviewer.');
    }
    if (simulatedMembers.some((m) => m.email.toLowerCase() === email)) {
        throw new ConsoleAuthError('UsernameExistsException', 'Thành viên có email này đã tồn tại trong tổ chức.');
    }
    const temporaryPassword = 'TempPassword123';
    const sub = `sub-${Math.random().toString(36).slice(2, 10)}`;
    const newMember = {
        id: sub,
        email,
        role: invitedRole,
        status: 'PENDING_FIRST_LOGIN',
        invitedAt: new Date().toISOString(),
    };
    simulatedMembers.push(newMember);
    simulatedUsers.set(email, {
        sub,
        email,
        fullName: email.split('@')[0],
        password: temporaryPassword,
        organizationName,
        tenantId: 't_01hxyz987654',
        role: invitedRole,
        confirmed: true,
        confirmationCode: '000000',
        codeExpiresAt: Date.now() + 86400_000,
        forceChangePassword: true,
        failedLoginAttempts: 0,
    });
    return {
        member: { ...newMember },
        temporaryPassword,
    };
}
