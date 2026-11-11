// Đăng nhập Cognito bằng USER_PASSWORD_AUTH qua HTTP (không cần AWS SDK).
// Yêu cầu app client bật ALLOW_USER_PASSWORD_AUTH.
import { cfg } from './config';

const cache = new Map<string, { token: string; at: number }>();

/** Đọc claim từ ID token Cognito vừa nhận qua TLS để seed có thể lưu tenant_id. */
export function idTokenClaims(token: string): Record<string, unknown> {
  const payload = token.split('.')[1];
  if (!payload) throw new Error('ID token Cognito không đúng định dạng JWT');
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!claims || typeof claims !== 'object' || Array.isArray(claims)) throw new Error('payload không phải object');
    return claims as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Không đọc được claim từ ID token Cognito: ${(error as Error).message}`);
  }
}

export async function login(clientId: string, username: string, password: string): Promise<string> {
  const k = `${clientId}:${username}`;
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < 20 * 60_000) return hit.token;
  const res = await fetch(cfg().cognitoEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth',
    },
    body: JSON.stringify({
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: clientId,
      AuthParameters: { USERNAME: username, PASSWORD: password },
    }),
  });
  const body: any = await res.json().catch(() => ({}));
  // ID token vì claim custom:tenant_id và custom:role nằm trong ID token
  const token = body?.AuthenticationResult?.IdToken;
  if (!token) throw new Error(`Đăng nhập thất bại (${username}): ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  cache.set(k, { token, at: Date.now() });
  return token;
}
