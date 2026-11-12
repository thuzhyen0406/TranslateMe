// Đăng nhập Cognito bằng USER_PASSWORD_AUTH qua HTTP (không cần AWS SDK).
// Yêu cầu app client bật ALLOW_USER_PASSWORD_AUTH.
import { cfg } from './config';

const cache = new Map<string, { token: string; at: number }>();

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
