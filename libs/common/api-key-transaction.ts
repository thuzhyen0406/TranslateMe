import { AppError, keys, type Ctx } from './types.js';

/** Kiểm tra giao dịch APIKEY/KEYMAP trước khi ghi; input là Ctx và đúng hai thao tác, output void hoặc AppError. */
export function validateApiKeyTransaction(ctx: Ctx, ops: unknown[]): void {
  if (ctx.via !== 'JWT' || !ctx.tenantId) {
    throw new AppError('PERMISSION_DENIED', 'Chỉ phiên console đã xác thực mới được thay đổi API key.');
  }
  if (!Array.isArray(ops) || ops.length !== 2) {
    throw new AppError('INVALID_REQUEST', 'Giao dịch API key phải gồm đúng hai thao tác.');
  }

  const records = ops.map((value) => value && typeof value === 'object' ? value as Record<string, any> : {});
  const getItem = (op: Record<string, any>) => op.Put?.Item ?? op.Update?.Key ?? op.Delete?.Key ?? op.ConditionCheck?.Key;
  const localOperation = records.find((op) => {
    const item = getItem(op);
    return item?.PK === `TENANT#${ctx.tenantId}#APIKEY` ||
      (typeof item?.PK === 'string' && item.PK.startsWith('TENANT#') && item.PK.endsWith('#APIKEY'));
  });
  const mappingOperation = records.find((op) => {
    const item = getItem(op);
    return typeof item?.PK === 'string' && item.PK.startsWith('TENANT#PLATFORM#KEY#');
  });
  const local = localOperation && getItem(localOperation);
  const mapping = mappingOperation && getItem(mappingOperation);
  const keyId = typeof local?.SK === 'string' && local.SK.startsWith('KEY#') ? local.SK.slice(4) : '';
  const expectedMapping = keyId ? keys.keymap(keyId) : null;

  if (!localOperation || !mappingOperation || localOperation === mappingOperation ||
      local.PK !== `TENANT#${ctx.tenantId}#APIKEY` || !expectedMapping ||
      mapping.PK !== expectedMapping.PK || mapping.SK !== expectedMapping.SK) {
    throw new AppError('PERMISSION_DENIED', 'Cặp APIKEY/KEYMAP không hợp lệ hoặc không thuộc tenant hiện tại.');
  }

  for (const op of records) {
    const operationCount = ['Put', 'Update', 'Delete', 'ConditionCheck'].filter((name) => Boolean(op[name])).length;
    if (operationCount !== 1) throw new AppError('INVALID_REQUEST', 'Mỗi thao tác giao dịch chỉ được chứa một loại lệnh.');
  }

  const isCreate = Boolean(localOperation.Put?.Item && mappingOperation.Put?.Item);
  const isDelete = Boolean(localOperation.Delete?.Key && mappingOperation.Delete?.Key);
  const isRevoke = Boolean(localOperation.Update?.Key && mappingOperation.Delete?.Key);
  if (!isCreate && !isDelete && !isRevoke) {
    throw new AppError('INVALID_REQUEST', 'Kiểu giao dịch APIKEY/KEYMAP không được hỗ trợ.');
  }
  if (isCreate && (mappingOperation.Put.Item.tenantId !== ctx.tenantId || localOperation.Put.Item.keyId !== keyId)) {
    throw new AppError('PERMISSION_DENIED', 'APIKEY và KEYMAP phải cùng thuộc tenant/ngữ cảnh đã xác thực.');
  }
}
