// Đọc cấu hình từ biến môi trường. Gọi cfg() lúc chạy, không đọc lúc import.
import './env';

export interface Cfg {
  stage: string;
  region: string;
  apiBase: string;
  publicBase: string;
  cognitoEndpoint: string;
  consoleClientId: string;
  platformClientId: string;
  authScheme: string;
  lockDeadlineS: number;
  pollMs: number;
  floodN: number;
  allowMutation: boolean;
  platformKeyMonth: string;
}

const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`Thiếu biến môi trường ${k} (xem .env.example)`);
  return v;
};
const opt = (k: string, d = ''): string => process.env[k] ?? d;

export function cfg(): Cfg {
  const region = opt('TM_REGION');
  const endpoint = opt('TM_COGNITO_ENDPOINT') || (region ? `https://cognito-idp.${region}.amazonaws.com/` : '');
  if (!endpoint) throw new Error('Cần TM_REGION hoặc TM_COGNITO_ENDPOINT');
  return {
    stage: opt('TM_STAGE', 'dev'),
    region,
    apiBase: need('TM_API_BASE').replace(/\/+$/, ''),
    publicBase: opt('TM_PUBLIC_BASE').replace(/\/+$/, ''),
    cognitoEndpoint: endpoint,
    consoleClientId: opt('TM_CONSOLE_CLIENT_ID', 'console-client'),
    platformClientId: opt('TM_PLATFORM_CLIENT_ID', 'platform-client'),
    authScheme: opt('TM_AUTH_SCHEME'),
    lockDeadlineS: Number(opt('TM_LOCK_DEADLINE_S', '75')),
    pollMs: Number(opt('TM_POLL_MS', '2000')),
    floodN: Number(opt('TM_FLOOD_N', '200')),
    allowMutation: opt('TM_ALLOW_MUTATION') === '1',
    platformKeyMonth: new Date().toISOString().slice(0, 7),
  };
}
