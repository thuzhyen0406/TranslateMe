/**
 * Bản giả trong bộ nhớ của lớp data (db.get / db.put / db.update / db.query) cho kiểm thử.
 * Hiểu đủ cú pháp mà jobs.ts và prewarmManager.ts dùng:
 *  - UpdateExpression: SET a = :v[, ...] và ADD a :v[, ...] (tên #x hoặc tên thường, có thể a.b)
 *  - ConditionExpression: attribute_not_exists(x), x = :v, x <> :v, x IN (:a, :b), x < :v, nối bằng AND / OR (AND ưu tiên hơn)
 * Kiểm tra khóa thuộc tenant như db.ts (TENANT#<t> hoặc TENANT#<t>#...).
 */
import type { Ctx } from '../types.js';

type Item = Record<string, unknown>;
type Names = Record<string, string> | undefined;
type Values = Record<string, unknown> | undefined;

function assertTenant(ctx: Ctx, pk: string): void {
  const base = `TENANT#${ctx.tenantId}`;
  if (pk !== base && !pk.startsWith(`${base}#`)) throw Object.assign(new Error('tenant'), { name: 'FORBIDDEN' });
}

const pathOf = (raw: string, names: Names): string[] => raw.trim().split('.').map((p) => (p.startsWith('#') ? (names?.[p] ?? p) : p));

function getPath(item: Item | undefined, path: string[]): unknown {
  let cur: unknown = item;
  for (const p of path) cur = cur && typeof cur === 'object' ? (cur as Item)[p] : undefined;
  return cur;
}

function setPath(item: Item, path: string[], v: unknown): void {
  let cur: Item = item;
  for (const p of path.slice(0, -1)) {
    if (!cur[p] || typeof cur[p] !== 'object') cur[p] = {};
    cur = cur[p] as Item;
  }
  cur[path[path.length - 1]] = v;
}

function evalAtom(item: Item | undefined, atom: string, names: Names, values: Values): boolean {
  const a = atom.trim();
  let m = /^attribute_not_exists\((.+)\)$/.exec(a);
  if (m) return getPath(item, pathOf(m[1], names)) === undefined;
  m = /^attribute_exists\((.+)\)$/.exec(a);
  if (m) return getPath(item, pathOf(m[1], names)) !== undefined;
  m = /^(.+?)\s+IN\s*\((.+)\)$/.exec(a);
  if (m) {
    const v = getPath(item, pathOf(m[1], names));
    return m[2].split(',').some((k) => values?.[k.trim()] === v);
  }
  m = /^(.+?)\s*(<>|=|<|>)\s*(:\w+)$/.exec(a);
  if (m) {
    const v = getPath(item, pathOf(m[1], names));
    const w = values?.[m[3]];
    if (m[2] === '=') return v === w;
    if (m[2] === '<>') return v !== w;
    if (m[2] === '<') return v !== undefined && (v as number) < (w as number);
    return v !== undefined && (v as number) > (w as number);
  }
  throw new Error(`memoryDataDb: điều kiện không hỗ trợ: ${a}`);
}

function evalCondition(item: Item | undefined, expr: string | undefined, names: Names, values: Values): boolean {
  if (!expr) return true;
  // Bỏ ngoặc thừa do tách theo OR/AND (ví dụ "(a" và "b)"), giữ ngoặc của hàm và IN (...)
  const balance = (s: string): string => {
    let t = s.trim();
    const count = (c: string) => [...t].filter((x) => x === c).length;
    while (t.startsWith('(') && count('(') > count(')')) t = t.slice(1).trim();
    while (t.endsWith(')') && count(')') > count('(')) t = t.slice(0, -1).trim();
    return t;
  };
  return expr.split(/\s+OR\s+/).some((orPart) => orPart.split(/\s+AND\s+/).every((atom) => evalAtom(item, balance(atom), names, values)));
}

const conditionFailed = () => Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });

export function memoryDataDb() {
  const store = new Map<string, Item>();
  const id = (k: { PK: string; SK: string }) => `${k.PK}|${k.SK}`;
  const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));
  return {
    store,
    async get(ctx: Ctx, key: { PK: string; SK: string }, _opts?: { consistent?: boolean }) {
      assertTenant(ctx, key.PK);
      return clone(store.get(id(key))) ?? null;
    },
    async put(ctx: Ctx, item: Record<string, unknown>, conditionExpression?: string) {
      assertTenant(ctx, String(item.PK));
      const key = { PK: String(item.PK), SK: String(item.SK) };
      if (!evalCondition(store.get(id(key)), conditionExpression, undefined, undefined)) throw conditionFailed();
      store.set(id(key), clone(item));
    },
    async update(
      ctx: Ctx,
      params: {
        Key: { PK: string; SK: string };
        UpdateExpression: string;
        ConditionExpression?: string;
        ExpressionAttributeNames?: Record<string, string>;
        ExpressionAttributeValues?: Record<string, unknown>;
      },
    ) {
      assertTenant(ctx, params.Key.PK);
      const cur = store.get(id(params.Key));
      const names = params.ExpressionAttributeNames;
      const values = params.ExpressionAttributeValues;
      if (!evalCondition(cur, params.ConditionExpression, names, values)) throw conditionFailed();
      const next: Item = clone(cur) ?? { ...params.Key };
      for (const clause of params.UpdateExpression.split(/\s+(?=SET\s|ADD\s)/)) {
        const [kw, ...rest] = clause.trim().split(/\s+/);
        const body = rest.join(' ');
        for (const part of body.split(',')) {
          if (kw === 'SET') {
            const [lhs, rhs] = part.split('=');
            setPath(next, pathOf(lhs, names), clone(values?.[rhs.trim()]));
          } else if (kw === 'ADD') {
            const [lhs, rhs] = part.trim().split(/\s+/);
            const p = pathOf(lhs, names);
            setPath(next, p, Number(getPath(next, p) ?? 0) + Number(values?.[rhs]));
          }
        }
      }
      store.set(id(params.Key), next);
    },
    async query(ctx: Ctx, pk: string, skPrefix?: string) {
      assertTenant(ctx, pk);
      return [...store.values()].filter((i) => i.PK === pk && (!skPrefix || String(i.SK).startsWith(skPrefix))).map((i) => clone(i));
    },
  };
}
