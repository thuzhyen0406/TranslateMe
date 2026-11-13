import { aws } from './aws';

const isNotFound = (error: string): boolean =>
  /NotFoundException|NotFound|not found|does not exist|ResourceNotFound/i.test(error);

function required(result: any, action: string): any {
  if (result?.__error) throw new Error(`${action} thất bại: ${result.__error}`);
  return result;
}

function attached(planId: string, keyId: string, region: string[]): boolean {
  const result = aws([
    'apigateway', 'get-usage-plan-key', '--usage-plan-id', planId, '--key-id', keyId, ...region,
  ], { readonly: true, allowFail: true });
  if (result?.__error) {
    if (isNotFound(result.__error)) return false;
    throw new Error(`Không kiểm tra được key ${keyId} trong usage plan ${planId}: ${result.__error}`);
  }
  if (result.id !== keyId) throw new Error(`AWS trả key không khớp khi đọc usage plan ${planId}.`);
  return true;
}

/** Chuyển một API key sang usage plan mới; nếu attach thất bại sẽ phục hồi plan nguồn. */
export function ensureUsagePlanKey(input: {
  keyId: string;
  targetPlanId: string;
  basicPlanId: string;
  previousPlanId?: string;
  region?: string[];
}): void {
  const { keyId, targetPlanId, basicPlanId } = input;
  const region = input.region ?? [];

  const apiKey = aws(['apigateway', 'get-api-key', '--api-key', keyId, '--no-include-value', ...region], {
    readonly: true, allowFail: true,
  });
  if (apiKey?.__error) {
    if (isNotFound(apiKey.__error)) throw new Error(`API key ${keyId} không tồn tại; không thay đổi usage plan nào.`);
    throw new Error(`Không xác minh được API key ${keyId}: ${apiKey.__error}`);
  }
  if (apiKey.id !== keyId) throw new Error(`AWS trả API key không khớp ${keyId}; không thay đổi usage plan nào.`);

  const targetPlan = required(aws(['apigateway', 'get-usage-plan', '--usage-plan-id', targetPlanId, ...region], { readonly: true }),
    `Kiểm tra tiny usage plan ${targetPlanId}`);
  if (targetPlan.id !== targetPlanId) throw new Error(`AWS không xác nhận đúng tiny usage plan ${targetPlanId}; chưa thay đổi association.`);

  const sources = [...new Set([basicPlanId, input.previousPlanId].filter((id): id is string => Boolean(id && id !== targetPlanId)))];
  const targetHasKey = attached(targetPlanId, keyId, region);
  const sourcePlans = sources.filter((planId) => attached(planId, keyId, region));
  if (targetHasKey) {
    // Target đã xác nhận; có thể dọn association cũ còn sót lại.
    for (const planId of sourcePlans) {
      required(aws(['apigateway', 'delete-usage-plan-key', '--usage-plan-id', planId, '--key-id', keyId, ...region]),
        `Gỡ key khỏi usage plan cũ ${planId}`);
    }
    return;
  }

  // API Gateway chỉ cho một usage plan trên mỗi key. Gỡ nguồn sau khi target,
  // API key và mọi association nguồn đã được kiểm tra; nếu attach lỗi thì rollback.
  for (const planId of sourcePlans) {
    required(aws(['apigateway', 'delete-usage-plan-key', '--usage-plan-id', planId, '--key-id', keyId, ...region]),
      `Gỡ key khỏi usage plan nguồn ${planId}`);
  }
  try {
    required(aws(['apigateway', 'create-usage-plan-key', '--usage-plan-id', targetPlanId,
      '--key-id', keyId, '--key-type', 'API_KEY', ...region]), `Gắn key vào tiny usage plan ${targetPlanId}`);
    if (!attached(targetPlanId, keyId, region)) {
      throw new Error(`Không thấy API key ${keyId} trong tiny usage plan ${targetPlanId} sau khi gắn.`);
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const planId of sourcePlans) {
      try {
        required(aws(['apigateway', 'create-usage-plan-key', '--usage-plan-id', planId,
          '--key-id', keyId, '--key-type', 'API_KEY', ...region]), `Phục hồi key vào usage plan ${planId}`);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
      }
    }
    const original = error instanceof Error ? error.message : String(error);
    if (rollbackErrors.length) {
      throw new Error(`${original}; rollback cũng lỗi: ${rollbackErrors.join('; ')}`);
    }
    throw error;
  }
}
