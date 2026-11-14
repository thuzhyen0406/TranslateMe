// Tham số và thứ tự deploy (hàm thuần, test offline): bootstrap rồi 7 stack theo STACKS, lượt 2 cho identity/api.
import { STACKS } from './aws';

export type AppStack = (typeof STACKS)[number];
export type StackKey = 'bootstrap' | AppStack;
export type Outputs = Record<string, string>;
export type StackOutputs = Partial<Record<StackKey, Outputs>>;
export interface CodeKeys { proxy: string; api: string }

export interface PlanCtx {
  stage: string;
  outputs: StackOutputs;
  codeKeys?: CodeKeys;
  env?: NodeJS.ProcessEnv;
}

/**
 * Tham số của từng stack, lấy từ output các stack đã có. Gọi lại sau lượt 1 để ra tham số lượt 2:
 *  - identity: PostConfirmationFunctionArn (output của api) -> gắn trigger Cognito;
 *  - api: ID usage plan (output của chính nó), DistributionId và PublicBaseUrl (output của edge).
 * Deploy lại khi stack đã đủ (lần chạy sau) thì lượt 1 đã có đủ giá trị, không làm rỗng biến môi trường Lambda.
 */
export function stackParams(stack: StackKey, ctx: PlanCtx): Record<string, string> {
  const o = ctx.outputs;
  const env = ctx.env ?? {};
  switch (stack) {
    case 'data':
      return { DeletionProtection: ctx.stage === 'demo' ? 'true' : 'false' };
    case 'identity':
      return { PostConfirmationFunctionArn: o.api?.PostConfirmationFunctionArn ?? '' };
    case 'api': {
      if (!ctx.codeKeys?.proxy || !ctx.codeKeys?.api) throw new Error('Stack api cần khóa S3 của gói mã proxy và api');
      return {
        ProxyCodeKey: ctx.codeKeys.proxy,
        ApiCodeKey: ctx.codeKeys.api,
        BasicUsagePlanId: o.api?.BasicUsagePlanId ?? '',
        StandardUsagePlanId: o.api?.StandardUsagePlanId ?? '',
        CloudFrontDistributionId: o.edge?.DistributionId ?? '',
        PublicBaseUrl: o.edge?.PublicBaseUrl ?? '',
        ...(env.TM_STATE_CACHE_S ? { StateCacheSeconds: env.TM_STATE_CACHE_S } : {}),
      };
    }
    case 'ops':
      return { AlertEmail: env.TM_ALERT_EMAIL ?? '', MonthlyBudgetUsd: env.TM_MONTHLY_BUDGET_USD ?? '20' };
    default:
      return {};
  }
}

export const toOverrides = (p: Record<string, string>): string[] => Object.entries(p).map(([k, v]) => `${k}=${v}`);

/** Stack nào cần deploy lại ở lượt 2 vì tham số đã khác lượt 1. */
export function pass2Stacks(deployed: Partial<Record<StackKey, Record<string, string>>>, ctx: PlanCtx): StackKey[] {
  const out: StackKey[] = [];
  for (const s of ['identity', 'api'] as const) {
    const before = deployed[s];
    if (!before) continue;
    const now = stackParams(s, ctx);
    if (JSON.stringify(now) !== JSON.stringify(before)) out.push(s);
  }
  return out;
}

/** Dòng cấu hình cho e2e/.env.<stage> từ output các stack. */
export function e2eEnv(o: StackOutputs, meta: { stage: string; region: string; account: string }): string {
  const api = o.api ?? {};
  const apiBase = api.ApiBaseUrl ?? '';
  const lines = [
    `# Sinh bởi npm run demo:deploy (${new Date().toISOString()}) – dán vào e2e/.env.${meta.stage}`,
    `TM_STAGE=${meta.stage}`,
    `TM_ACCOUNT=${meta.account}`,
    `TM_REGION=${meta.region}`,
    `TM_API_BASE=${apiBase}`,
    `TM_PUBLIC_BASE=${o.edge?.PublicBaseUrl ?? ''}`,
    `TM_CF_DISTRIBUTION_ID=${o.edge?.DistributionId ?? ''}`,
    `TM_CONSOLE_CLIENT_ID=${o.identity?.ConsoleClientId ?? ''}`,
    `TM_PLATFORM_CLIENT_ID=${o.identity?.PlatformClientId ?? ''}`,
    `TM_CONSOLE_USER_POOL_ID=${o.identity?.UserPoolId ?? ''}`,
    `TM_PLATFORM_USER_POOL_ID=${o.identity?.UserPoolId ?? ''}`,
    'TM_PLATFORM_GROUP=PlatformAdmins',
    `TM_API_ID=${api.ApiId ?? ''}`,
    `TM_API_STAGE=${meta.stage}`,
    `TM_PLAN_BASIC=${api.BasicUsagePlanId ?? ''}`,
    `TM_TABLE=${o.data?.TableName ?? ''}`,
    `# Web console: ${o.console?.ConsoleUrl ?? '(chưa deploy)'}`,
  ];
  return lines.join('\n') + '\n';
}
