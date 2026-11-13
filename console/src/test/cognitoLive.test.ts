import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applySessionRefresh, cognitoLive, ConsoleAuthError, createMockJwt, decodeJwtClaims, signOutSession, type CognitoLiveOptions } from '../services/cognitoAuth.js';
import { callCognito, cognitoEndpoint, CognitoIdpError } from '../services/cognitoIdp.js';

// Cognito + REST API giả lập qua fetchFn: kiểm tra đúng thao tác, đúng tham số, và cách dựng phiên từ token.
interface FakeUser {
  sub: string;
  password: string;
  status: 'UNCONFIRMED' | 'CONFIRMED' | 'FORCE_CHANGE_PASSWORD';
  attrs: Record<string, string>;
  groups?: string[];
  code?: string;
}

interface Call {
  url: string;
  target?: string;
  body: Record<string, any>;
  headers: Record<string, string>;
  method: string;
}

function fakeBackend(opts: { triggerFails?: boolean; meStatus?: number } = {}) {
  const users = new Map<string, FakeUser>();
  const calls: Call[] = [];
  const sessions = new Map<string, string>();
  const refreshTokens = new Map<string, string>();
  let seq = 0;

  const tokensFor = (email: string) => {
    const u = users.get(email)!;
    const rt = `rt-${++seq}`;
    refreshTokens.set(rt, email);
    return {
      IdToken: createMockJwt({ sub: u.sub, email, ...u.attrs, 'cognito:groups': u.groups, jti: `j${seq}` } as never),
      AccessToken: `at-${seq}`,
      RefreshToken: rt,
      ExpiresIn: 3600,
      TokenType: 'Bearer',
    };
  };
  const err = (status: number, type: string, message: string) =>
    new Response(JSON.stringify({ __type: type, message }), { status });
  const ok = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });

  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const target = headers['x-amz-target']?.split('.').pop();
    calls.push({ url, target, body, headers, method: init?.method ?? 'GET' });

    if (url.startsWith('https://api.test')) {
      const auth = headers.authorization ?? '';
      if (!auth.startsWith('Bearer ')) return err(401, 'x', 'Unauthorized');
      if (url.endsWith('/console/me')) {
        if (opts.meStatus) {
          return new Response(
            JSON.stringify({ error: { code: 'TENANT_SUSPENDED', message: 'Tổ chức đang bị tạm khóa.' } }),
            { status: opts.meStatus },
          );
        }
        // Giống API thật: vai trò lấy từ claim custom:role của ID token đã được authorizer xác thực.
        const claims = decodeJwtClaims(auth.slice('Bearer '.length));
        const role = String(claims?.['custom:role'] ?? '').toUpperCase();
        return ok({ tenant_id: 't_real', role, tenant_status: 'ACTIVE', organization_name: 'Homestay Thật', plan: 'FREE' });
      }
      if (url.endsWith('/console/members') && init?.method === 'GET') {
        return ok({
          items: [
            { PK: 'TENANT#t_real', SK: 'MEMBER#s1', tenantId: 't_real', userSub: 's1', email: 'lan@x.vn', role: 'TENANT_ADMIN', status: 'ACTIVE', createdAt: '2026-11-14T00:00:00Z' },
            { tenantId: 't_real', userSub: 's2', email: 'khoa@x.vn', role: 'DEVELOPER', status: 'ACTIVE' },
            { email: 'hong@x.vn' },
          ],
        });
      }
      if (url.endsWith('/console/members/invite')) {
        return ok({ request_id: 'r1', username: 'u-9', userSub: 's9', userStatus: 'FORCE_CHANGE_PASSWORD', tenantId: 't_real', email: body.email, role: body.role });
      }
      return err(404, 'x', 'not found');
    }

    switch (target) {
      case 'SignUp': {
        if (users.has(body.Username)) return err(400, 'UsernameExistsException', 'User already exists');
        const attrs: Record<string, string> = {};
        for (const a of body.UserAttributes) attrs[a.Name] = a.Value;
        users.set(body.Username, { sub: `sub-${++seq}`, password: body.Password, status: 'UNCONFIRMED', attrs, code: '123456' });
        return ok({ UserConfirmed: false, UserSub: `sub-${seq}` });
      }
      case 'ConfirmSignUp': {
        const u = users.get(body.Username);
        if (!u) return err(400, 'UserNotFoundException', 'User does not exist.');
        if (u.status === 'CONFIRMED') return err(400, 'NotAuthorizedException', 'User cannot be confirmed. Current status is CONFIRMED');
        if (body.ConfirmationCode !== u.code) return err(400, 'CodeMismatchException', 'Invalid verification code provided, please try again.');
        if (opts.triggerFails) return err(400, 'UserLambdaValidationException', 'PostConfirmation failed with error boom.');
        u.status = 'CONFIRMED';
        // Mô phỏng Lambda PostConfirmation gán claim tenant (client không ghi được hai thuộc tính này).
        u.attrs['custom:tenant_id'] = 't_real';
        u.attrs['custom:role'] = 'tenant_admin';
        return ok({});
      }
      case 'ResendConfirmationCode':
        return ok({ CodeDeliveryDetails: { DeliveryMedium: 'EMAIL' } });
      case 'InitiateAuth': {
        if (body.AuthFlow === 'REFRESH_TOKEN_AUTH') {
          const email = refreshTokens.get(body.AuthParameters.REFRESH_TOKEN);
          if (!email) return err(400, 'NotAuthorizedException', 'Refresh Token has been revoked');
          const t = tokensFor(email);
          return ok({ AuthenticationResult: { IdToken: t.IdToken, AccessToken: t.AccessToken, ExpiresIn: 3600 } });
        }
        const u = users.get(body.AuthParameters.USERNAME);
        if (!u || u.password !== body.AuthParameters.PASSWORD) return err(400, 'NotAuthorizedException', 'Incorrect username or password.');
        if (u.status === 'UNCONFIRMED') return err(400, 'UserNotConfirmedException', 'User is not confirmed.');
        if (u.status === 'FORCE_CHANGE_PASSWORD') {
          const s = `sess-${++seq}`;
          sessions.set(s, body.AuthParameters.USERNAME);
          return ok({
            ChallengeName: 'NEW_PASSWORD_REQUIRED',
            Session: s,
            ChallengeParameters: {
              USER_ID_FOR_SRP: u.sub,
              requiredAttributes: '["userAttributes.name"]',
              userAttributes: JSON.stringify({ email: body.AuthParameters.USERNAME, 'custom:role': u.attrs['custom:role'] }),
            },
          });
        }
        return ok({ AuthenticationResult: tokensFor(body.AuthParameters.USERNAME), ChallengeParameters: {} });
      }
      case 'RespondToAuthChallenge': {
        const email = sessions.get(body.Session);
        if (!email) return err(400, 'NotAuthorizedException', 'Invalid session for the user.');
        const u = users.get(email)!;
        if (body.ChallengeResponses.USERNAME !== u.sub) return err(400, 'NotAuthorizedException', 'wrong user');
        if (!body.ChallengeResponses['userAttributes.name']) return err(400, 'InvalidParameterException', 'Missing required attribute name');
        u.password = body.ChallengeResponses.NEW_PASSWORD;
        u.status = 'CONFIRMED';
        return ok({ AuthenticationResult: tokensFor(email) });
      }
      case 'ForgotPassword':
        return ok({ CodeDeliveryDetails: {} });
      case 'ConfirmForgotPassword': {
        const u = users.get(body.Username);
        if (!u || body.ConfirmationCode !== '654321') return err(400, 'CodeMismatchException', 'Invalid code');
        u.password = body.Password;
        return ok({});
      }
      case 'RevokeToken':
        refreshTokens.delete(body.Token);
        return ok({});
      default:
        return err(400, 'InvalidAction', `unknown ${target}`);
    }
  }) as typeof fetch;

  const live: CognitoLiveOptions = { region: 'ap-southeast-1', clientId: 'client-abc', fetchFn, baseUrl: 'https://api.test/dev' };
  return { users, calls, fetchFn, live };
}

const ops = (calls: Call[]) => calls.map((c) => c.target ?? `${c.method} ${new URL(c.url).pathname}`);
const confirmedAdmin = (password = 'Password123'): FakeUser => ({
  sub: 's1', password, status: 'CONFIRMED', attrs: { 'custom:tenant_id': 't_real', 'custom:role': 'tenant_admin' },
});

describe('Web Console – chế độ Cognito thật (VITE_AUTH_MODE=cognito)', () => {
  it('cognitoIdp gọi đúng endpoint, header X-Amz-Target và gắn ClientId', async () => {
    const { calls, fetchFn } = fakeBackend();
    await callCognito('ForgotPassword', { Username: 'a@b.vn' }, { region: 'ap-southeast-1', clientId: 'c1', fetchFn });
    assert.equal(calls[0].url, 'https://cognito-idp.ap-southeast-1.amazonaws.com/');
    assert.equal(calls[0].headers['x-amz-target'], 'AWSCognitoIdentityProviderService.ForgotPassword');
    assert.equal(calls[0].headers['content-type'], 'application/x-amz-json-1.1');
    assert.deepEqual(calls[0].body, { ClientId: 'c1', Username: 'a@b.vn' });
    assert.equal(cognitoEndpoint({ region: 'x', endpoint: 'http://localhost:9229' }), 'http://localhost:9229/');
    await assert.rejects(
      callCognito('SignUp', {}, { region: 'ap-southeast-1', clientId: '' }),
      (e: unknown) => e instanceof CognitoIdpError && e.code === 'CONFIG_ERROR',
    );
  });

  it('Đăng ký → xác nhận email → đăng nhập: tenant lấy từ ID token sau PostConfirmation, trạng thái từ /console/me', async () => {
    const { calls, live } = fakeBackend();
    const reg = await cognitoLive.registerAccount('Nguyễn Thị Lan', 'lan@x.vn', 'Password123', 'Homestay Thật', live);
    assert.deepEqual(reg, { email: 'lan@x.vn', organizationName: 'Homestay Thật', demoConfirmationCode: '' });
    const signUp = calls.find((c) => c.target === 'SignUp')!;
    const attrNames = signUp.body.UserAttributes.map((a: { Name: string }) => a.Name);
    assert.deepEqual(attrNames, ['email', 'name', 'custom:organization_name']);
    assert.ok(!attrNames.includes('custom:tenant_id') && !attrNames.includes('custom:role'), 'QC-3: client không gửi tenant/role');

    const session = await cognitoLive.confirmEmail('lan@x.vn', '123456', {
      email: 'lan@x.vn', code: '123456', password: 'Password123', organizationName: 'Homestay Thật', fullName: 'Nguyễn Thị Lan',
    }, live);
    const confirm = calls.find((c) => c.target === 'ConfirmSignUp')!;
    assert.deepEqual(confirm.body.ClientMetadata, { organization_name: 'Homestay Thật' });
    assert.equal(session.tenantId, 't_real');
    assert.equal(session.role, 'TENANT_ADMIN');
    assert.equal(session.tenantStatus, 'ACTIVE');
    assert.equal(session.organizationName, 'Homestay Thật');
    assert.equal(session.fullName, 'Nguyễn Thị Lan');
    assert.match(session.refreshToken, /^rt-/);
    const me = calls.find((c) => c.url.endsWith('/console/me'))!;
    assert.equal(me.headers.authorization, `Bearer ${session.idToken}`);
    assert.deepEqual(ops(calls), ['SignUp', 'ConfirmSignUp', 'InitiateAuth', 'GET /dev/console/me']);
  });

  it('Xác nhận lại tài khoản đã CONFIRMED vẫn đăng nhập được; thiếu mật khẩu thì yêu cầu đăng nhập', async () => {
    const { users, live } = fakeBackend();
    await cognitoLive.registerAccount('Lan', 'lan@x.vn', 'Password123', 'Org', live);
    await cognitoLive.confirmEmail('lan@x.vn', '123456', { email: 'lan@x.vn', code: '123456', password: 'Password123' }, live);
    assert.equal(users.get('lan@x.vn')!.status, 'CONFIRMED');
    const again = await cognitoLive.confirmEmail('lan@x.vn', '123456', { email: 'lan@x.vn', code: '123456', password: 'Password123' }, live);
    assert.equal(again.tenantId, 't_real');
    await assert.rejects(
      cognitoLive.confirmEmail('lan@x.vn', '123456', { email: 'lan@x.vn', code: '123456' }, live),
      (e: unknown) => e instanceof ConsoleAuthError && e.code === 'SIGN_IN_REQUIRED',
    );
  });

  it('Lỗi Cognito được dịch sang tiếng Việt (sai mã, trùng email, trigger lỗi, mất mạng, thiếu cấu hình)', async () => {
    const { live } = fakeBackend();
    await cognitoLive.registerAccount('Lan', 'lan@x.vn', 'Password123', 'Org', live);
    await assert.rejects(
      cognitoLive.confirmEmail('lan@x.vn', '999999', { email: 'lan@x.vn', code: '999999', password: 'Password123' }, live),
      (e: unknown) => e instanceof ConsoleAuthError && e.code === 'CodeMismatchException' && /không chính xác/.test(e.message),
    );
    await assert.rejects(
      cognitoLive.registerAccount('Lan', 'lan@x.vn', 'Password123', 'Org', live),
      (e: unknown) => e instanceof ConsoleAuthError && e.code === 'UsernameExistsException' && /đã được đăng ký/.test(e.message),
    );

    const broken = fakeBackend({ triggerFails: true });
    await cognitoLive.registerAccount('Lan', 'lan@x.vn', 'Password123', 'Org', broken.live);
    await assert.rejects(
      cognitoLive.confirmEmail('lan@x.vn', '123456', { email: 'lan@x.vn', code: '123456', password: 'Password123' }, broken.live),
      (e: unknown) => e instanceof ConsoleAuthError && /Không khởi tạo được tổ chức/.test(e.message),
    );

    const offline: CognitoLiveOptions = { ...live, fetchFn: (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch };
    await assert.rejects(
      cognitoLive.signIn('lan@x.vn', 'x', offline),
      (e: unknown) => e instanceof ConsoleAuthError && e.code === 'NETWORK_ERROR' && !/Exception|fetch/i.test(e.message),
    );
    await assert.rejects(
      cognitoLive.signIn('lan@x.vn', 'x', { ...live, clientId: '' }),
      (e: unknown) => e instanceof ConsoleAuthError && e.code === 'CONFIG_ERROR' && /chưa được cấu hình/.test(e.message),
    );
  });

  it('Đăng nhập: chưa xác nhận → gửi lại mã và chuyển màn xác nhận; sai mật khẩu báo lỗi', async () => {
    const { calls, live } = fakeBackend();
    await cognitoLive.registerAccount('Lan', 'lan@x.vn', 'Password123', 'Org', live);
    const out = await cognitoLive.signIn('lan@x.vn', 'Password123', live);
    assert.equal(out.status, 'CONFIRMATION_REQUIRED');
    assert.ok(calls.some((c) => c.target === 'ResendConfirmationCode'));
    await assert.rejects(
      cognitoLive.signIn('lan@x.vn', 'Sai12345', live),
      (e: unknown) => e instanceof ConsoleAuthError && e.message === 'Email hoặc mật khẩu không chính xác.',
    );
  });

  it('Thành viên được mời: NEW_PASSWORD_REQUIRED → đặt mật khẩu mới bằng Session mới và USER_ID_FOR_SRP', async () => {
    const { users, calls, live } = fakeBackend();
    users.set('khoa@x.vn', {
      sub: 'sub-khoa', password: 'TmpPass#2026', status: 'FORCE_CHANGE_PASSWORD',
      attrs: { 'custom:tenant_id': 't_real', 'custom:role': 'developer' },
    });
    const first = await cognitoLive.signIn('khoa@x.vn', 'TmpPass#2026', live);
    assert.equal(first.status, 'NEW_PASSWORD_REQUIRED');
    assert.equal(first.status === 'NEW_PASSWORD_REQUIRED' && first.invitedRole, 'DEVELOPER');

    const session = await cognitoLive.completeInvitedPassword('khoa@x.vn', {
      email: 'khoa@x.vn', temporaryPassword: 'TmpPass#2026', newPassword: 'NewPass123', confirmNewPassword: 'NewPass123',
    }, live);
    const respond = calls.find((c) => c.target === 'RespondToAuthChallenge')!;
    assert.equal(respond.body.ChallengeResponses.USERNAME, 'sub-khoa');
    assert.equal(respond.body.ChallengeResponses['userAttributes.name'], 'khoa');
    assert.equal(session.role, 'DEVELOPER');
    assert.equal(session.tenantId, 't_real');
    assert.equal(users.get('khoa@x.vn')!.password, 'NewPass123');

    await assert.rejects(
      cognitoLive.completeInvitedPassword('khoa@x.vn', {
        email: 'khoa@x.vn', temporaryPassword: 'sai', newPassword: 'NewPass123', confirmNewPassword: 'NewPass123',
      }, live),
      (e: unknown) => e instanceof ConsoleAuthError && /mật khẩu tạm thời không chính xác/.test(e.message),
    );
  });

  it('Token thiếu custom:tenant_id bị từ chối (không tự gán tenant phía client)', async () => {
    const { users, live } = fakeBackend();
    users.set('x@x.vn', { sub: 's', password: 'Password123', status: 'CONFIRMED', attrs: {} });
    await assert.rejects(
      cognitoLive.signIn('x@x.vn', 'Password123', live),
      (e: unknown) => e instanceof ConsoleAuthError && e.code === 'TENANT_NOT_LINKED',
    );
  });

  it('Platform Admin đăng nhập và làm mới phiên bằng nhóm Cognito, bỏ qua /console/me', async () => {
    const { users, calls, live } = fakeBackend();
    users.set('platform@x.vn', {
      sub: 'platform-admin',
      password: 'Password123',
      status: 'CONFIRMED',
      attrs: {},
      groups: ['PlatformAdmins'],
    });

    const out = await cognitoLive.signIn('platform@x.vn', 'Password123', live);
    assert.equal(out.status, 'AUTHENTICATED');
    const refreshed = await cognitoLive.refreshSession(out.session, live);

    for (const session of [out.session, refreshed]) {
      assert.equal(session.role, 'PLATFORM_ADMIN');
      assert.equal(session.tenantId, '');
      assert.equal(session.tenantStatus, 'ACTIVE');
    }
    assert.notEqual(refreshed.idToken, out.session.idToken);
    assert.equal(calls.some((call) => call.url.endsWith('/console/me')), false);
  });

  it('Làm mới token giữ refresh token cũ; đăng xuất thu hồi refresh token', async () => {
    const { users, calls, live } = fakeBackend();
    users.set('lan@x.vn', confirmedAdmin());
    const out = await cognitoLive.signIn('lan@x.vn', 'Password123', live);
    assert.equal(out.status, 'AUTHENTICATED');
    if (out.status !== 'AUTHENTICATED') return;
    const refreshed = await cognitoLive.refreshSession(out.session, live);
    assert.equal(refreshed.refreshToken, out.session.refreshToken);
    assert.notEqual(refreshed.idToken, out.session.idToken);
    assert.equal(calls.filter((c) => c.target === 'InitiateAuth').at(-1)!.body.AuthFlow, 'REFRESH_TOKEN_AUTH');

    let revokeAttempts = 0;
    await signOutSession(refreshed, {
      ...live,
      fetchFn: (input, init) => {
        const target = new Headers(init?.headers).get('x-amz-target');
        if (target?.endsWith('.RevokeToken')) {
          assert.equal(init?.keepalive, true);
          if (++revokeAttempts === 1) return Promise.resolve(Response.json({}, { status: 503 }));
        }
        return live.fetchFn!(input, init);
      },
    });
    assert.equal(revokeAttempts, 2);
    assert.equal(calls.at(-1)!.target, 'RevokeToken');
    await assert.rejects(
      cognitoLive.refreshSession(refreshed, live),
      (e: unknown) => e instanceof ConsoleAuthError && /hết hạn/.test(e.message),
    );
  });

  it('bỏ cả kết quả lẫn lỗi từ refresh đang chạy sau khi phiên đã đăng xuất', async () => {
    const { users, live } = fakeBackend();
    users.set('lan@x.vn', confirmedAdmin());
    const result = await cognitoLive.signIn('lan@x.vn', 'Password123', live);
    assert.equal(result.status, 'AUTHENTICATED');
    if (result.status !== 'AUTHENTICATED') return;

    const session = result.session;
    let current = true;
    const unexpected = () => assert.fail('Refresh của phiên cũ đã cập nhật Console');
    let finish!: (next: typeof session) => void;
    let fail!: (reason: Error) => void;
    const pendingSuccess = new Promise<typeof session>((resolve) => { finish = resolve; });
    const pendingError = new Promise<typeof session>((_resolve, reject) => { fail = reject; });
    const refreshes = [pendingSuccess, pendingError].map((refresh) =>
      applySessionRefresh(refresh, () => current, unexpected, unexpected),
    );
    current = false;
    finish(session);
    fail(new Error('Expired refresh token'));
    await Promise.all(refreshes);
  });

  it('Tenant bị khóa: /console/me trả TENANT_SUSPENDED → phiên LOCKED (khóa thao tác ghi)', async () => {
    const { users, live } = fakeBackend({ meStatus: 403 });
    users.set('lan@x.vn', confirmedAdmin());
    const out = await cognitoLive.signIn('lan@x.vn', 'Password123', live);
    assert.equal(out.status === 'AUTHENTICATED' && out.session.tenantStatus, 'LOCKED');
  });

  it('Thành viên: GET /console/members chuẩn hóa bản ghi MEMBER; mời qua POST /console/members/invite', async () => {
    const { calls, live } = fakeBackend();
    const members = await cognitoLive.listTenantMembers('t_real', 'id-token', live);
    assert.deepEqual(members, [
      { id: 's1', tenantId: 't_real', email: 'lan@x.vn', role: 'TENANT_ADMIN', status: 'ACTIVE', invitedAt: '2026-11-14T00:00:00Z' },
      { id: 's2', tenantId: 't_real', email: 'khoa@x.vn', role: 'DEVELOPER', status: 'ACTIVE' },
    ]);
    const res = await cognitoLive.inviteTenantMember('minh@x.vn', 'REVIEWER', 't_real', 'id-token', live);
    const post = calls.at(-1)!;
    assert.equal(post.method, 'POST');
    assert.deepEqual(post.body, { email: 'minh@x.vn', role: 'REVIEWER' });
    assert.equal(post.headers.authorization, 'Bearer id-token');
    assert.equal(res.member.status, 'PENDING_FIRST_LOGIN');
    assert.equal(res.member.id, 's9');
    assert.equal(res.temporaryPassword, '', 'mật khẩu tạm do Cognito gửi qua email, không trả về client');
    await assert.rejects(
      cognitoLive.listTenantMembers('t_real', undefined, live),
      (e: unknown) => e instanceof ConsoleAuthError && e.code === 'UNAUTHORIZED',
    );
  });

  it('Quên mật khẩu: ForgotPassword rồi ConfirmForgotPassword', async () => {
    const { users, calls, live } = fakeBackend();
    users.set('lan@x.vn', { sub: 's1', password: 'Old12345', status: 'CONFIRMED', attrs: {} });
    const r = await cognitoLive.requestPasswordReset('lan@x.vn', live);
    assert.equal(r.demoResetCode, '');
    await cognitoLive.confirmPasswordReset('lan@x.vn', '654321', 'NewPass123', live);
    assert.equal(users.get('lan@x.vn')!.password, 'NewPass123');
    assert.deepEqual(ops(calls), ['ForgotPassword', 'ConfirmForgotPassword']);
  });
});
