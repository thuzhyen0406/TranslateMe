/**
 * Lớp gọi trực tiếp Amazon Cognito Identity Provider từ trình duyệt (chế độ `VITE_AUTH_MODE=cognito`).
 *
 * - Dùng API JSON công khai `https://cognito-idp.<region>.amazonaws.com/` với header
 *   `X-Amz-Target: AWSCognitoIdentityProviderService.<Thao tác>`; app client công khai (không có client secret)
 *   nên không cần ký SigV4 và không cần thêm thư viện AWS SDK vào bundle.
 * - Chỉ dùng các thao tác dành cho người dùng cuối: SignUp, ConfirmSignUp, ResendConfirmationCode, InitiateAuth,
 *   RespondToAuthChallenge, ForgotPassword, ConfirmForgotPassword, RevokeToken.
 * - Mô-đun này không phụ thuộc giao diện; `cognitoAuth.ts` dịch lỗi sang tiếng Việt.
 */

export type CognitoOperation =
  | 'SignUp'
  | 'ConfirmSignUp'
  | 'ResendConfirmationCode'
  | 'InitiateAuth'
  | 'RespondToAuthChallenge'
  | 'ForgotPassword'
  | 'ConfirmForgotPassword'
  | 'RevokeToken';

export interface CognitoIdpConfig {
  region: string;
  clientId: string;
  /** Ghi đè endpoint (kiểm thử hoặc giả lập cục bộ). Mặc định suy ra từ `region`. */
  endpoint?: string;
  fetchFn?: typeof fetch;
}

/** Lỗi do Cognito trả về (`__type`) hoặc lỗi mạng (`code = 'NETWORK_ERROR'`). */
export class CognitoIdpError extends Error {
  constructor(
    public code: string,
    message: string,
    public httpStatus?: number,
  ) {
    super(message);
    this.name = code;
  }
}

export interface CognitoAuthenticationResult {
  IdToken?: string;
  AccessToken?: string;
  RefreshToken?: string;
  ExpiresIn?: number;
  TokenType?: string;
}

export interface CognitoInitiateAuthResponse {
  AuthenticationResult?: CognitoAuthenticationResult;
  ChallengeName?: string;
  ChallengeParameters?: Record<string, string>;
  Session?: string;
}

export function cognitoEndpoint(cfg: Pick<CognitoIdpConfig, 'region' | 'endpoint'>): string {
  return (cfg.endpoint ?? `https://cognito-idp.${cfg.region}.amazonaws.com/`).replace(/\/*$/, '/');
}

/** Gọi một thao tác Cognito IDP; ném `CognitoIdpError` khi HTTP không thành công hoặc mất mạng. */
export async function callCognito<T = Record<string, unknown>>(
  operation: CognitoOperation,
  body: Record<string, unknown>,
  cfg: CognitoIdpConfig,
): Promise<T> {
  if (!cfg.region && !cfg.endpoint) {
    throw new CognitoIdpError('CONFIG_ERROR', 'Thiếu VITE_AWS_REGION để gọi Amazon Cognito.');
  }
  if (!cfg.clientId) {
    throw new CognitoIdpError('CONFIG_ERROR', 'Thiếu VITE_COGNITO_CLIENT_ID để gọi Amazon Cognito.');
  }
  const doFetch = cfg.fetchFn ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  let res: Response;
  try {
    res = await doFetch(cognitoEndpoint(cfg), {
      method: 'POST',
      ...(operation === 'RevokeToken' ? { keepalive: true } : {}),
      headers: {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': `AWSCognitoIdentityProviderService.${operation}`,
      },
      body: JSON.stringify({ ClientId: cfg.clientId, ...body }),
    });
  } catch {
    throw new CognitoIdpError('NETWORK_ERROR', 'Network error: failed to fetch');
  }

  const text = await res.text().catch(() => '');
  let data: Record<string, unknown> = {};
  if (text) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
    } catch {
      data = {};
    }
  }

  if (!res.ok) {
    const rawType = String(data.__type ?? data.code ?? 'InternalErrorException');
    const code = rawType.includes('#') ? rawType.split('#').pop()! : rawType;
    const message = String(data.message ?? data.Message ?? `HTTP ${res.status}`);
    throw new CognitoIdpError(code, message, res.status);
  }
  return data as T;
}
