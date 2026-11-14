/**
 * DynamoDB giả trong bộ nhớ cho UsageService (GetCommand + TransactWriteCommand), dùng trong test usage.test.ts.
 * Khác mock của libs/common/test: tôn trọng ProjectionExpression (bắt lỗi đọc thiếu trường CONFIG) và
 * huỷ cả giao dịch kèm CancellationReasons khi một điều kiện sai, như DynamoDB thật.
 */
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

type Item = Record<string, unknown>;
type Names = Record<string, string>;
type Values = Record<string, unknown>;

const keyOf = (k: { PK?: unknown; SK?: unknown }): string => `${String(k.PK)}|${String(k.SK)}`;

function txCanceled(index: number, count: number): Error {
  return Object.assign(new Error('Transaction cancelled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: Array.from({ length: count }, (_, i) => ({ Code: i === index ? 'ConditionalCheckFailed' : 'None' })),
  });
}

/** Chỉ hiểu các điều kiện mà UsageService dùng; điều kiện lạ -> ném lỗi để test không âm thầm sai. */
function checkCondition(expr: string | undefined, item: Item | undefined, names: Names, values: Values): boolean {
  if (!expr) return true;
  const attr = (token: string) => names[token] ?? token;
  let m: RegExpExecArray | null;
  if ((m = /^attribute_not_exists\((#\w+)\) OR (#\w+) <= (:\w+)$/.exec(expr))) {
    const v = item?.[attr(m[1])];
    return v === undefined || Number(v) <= Number(values[m[3]]);
  }
  if (expr === 'attribute_not_exists(PK) AND attribute_not_exists(SK)') return item === undefined;
  if ((m = /^(#\w+) = (:\w+)$/.exec(expr))) return item !== undefined && item[attr(m[1])] === values[m[2]];
  throw new Error(`Điều kiện chưa hỗ trợ: ${expr}`);
}

function applyUpdate(item: Item, expr: string, names: Names, values: Values): void {
  const m = /^(ADD|SET) (.+)$/.exec(expr);
  if (!m) throw new Error(`UpdateExpression chưa hỗ trợ: ${expr}`);
  for (const part of m[2].split(', ')) {
    const [name, value] = m[1] === 'ADD' ? part.split(' ') : part.split(' = ');
    const field = names[name];
    if (!field || !(value in values)) throw new Error(`Thiếu tên/giá trị: ${part}`);
    item[field] = m[1] === 'ADD' ? Number(item[field] ?? 0) + Number(values[value]) : structuredClone(values[value]);
  }
}

export function memoryUsageDb() {
  const items = new Map<string, Item>();
  const calls: string[] = [];
  return {
    items,
    calls,
    seed(item: Item) {
      items.set(keyOf(item), structuredClone(item));
    },
    get(pk: string, sk: string): Item | undefined {
      return items.get(`${pk}|${sk}`);
    },
    async send(command: unknown): Promise<Item> {
      if (command instanceof GetCommand) {
        calls.push('Get');
        const input = command.input;
        const found = items.get(keyOf(input.Key ?? {}));
        if (!found) return {};
        if (!input.ProjectionExpression) return { Item: structuredClone(found) };
        const names = (input.ExpressionAttributeNames ?? {}) as Names;
        const projected: Item = {};
        for (const token of input.ProjectionExpression.split(',').map((t) => t.trim())) {
          const field = names[token] ?? token;
          if (field in found) projected[field] = structuredClone(found[field]);
        }
        return { Item: projected };
      }
      if (command instanceof TransactWriteCommand) {
        calls.push('TransactWrite');
        const ops = command.input.TransactItems ?? [];
        const staged = new Map([...items].map(([k, v]) => [k, structuredClone(v)]));
        ops.forEach((op, index) => {
          if (op.Put) {
            const item = op.Put.Item as Item;
            const k = keyOf(item);
            if (!checkCondition(op.Put.ConditionExpression, staged.get(k), (op.Put.ExpressionAttributeNames ?? {}) as Names, (op.Put.ExpressionAttributeValues ?? {}) as Values)) {
              throw txCanceled(index, ops.length);
            }
            staged.set(k, structuredClone(item));
          } else if (op.Update) {
            const u = op.Update;
            const k = keyOf(u.Key as Item);
            const names = (u.ExpressionAttributeNames ?? {}) as Names;
            const values = (u.ExpressionAttributeValues ?? {}) as Values;
            const current = staged.get(k);
            if (!checkCondition(u.ConditionExpression, current, names, values)) throw txCanceled(index, ops.length);
            const next: Item = current ?? { ...(u.Key as Item) };
            applyUpdate(next, String(u.UpdateExpression), names, values);
            staged.set(k, next);
          } else {
            throw new Error('Thao tác giao dịch chưa hỗ trợ');
          }
        });
        items.clear();
        for (const [k, v] of staged) items.set(k, v);
        return {};
      }
      throw new Error(`Lệnh DynamoDB chưa hỗ trợ: ${(command as object).constructor.name}`);
    },
  };
}
