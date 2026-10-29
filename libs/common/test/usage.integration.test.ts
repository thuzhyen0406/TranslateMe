import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  CharacterQuotaExceededError,
  monthUtc,
  ReservationStateError,
  UsageService,
  type UsageReservation,
  type UsageSource,
  usageKeys,
} from '../usage/usage.js';

type Item = Record<string, unknown>;
type Key = { PK: string; SK: string };
type TransactionItem = Record<string, Record<string, unknown>>;

function itemKey(key: Key): string {
  return `${key.PK}|${key.SK}`;
}

function asRecord(value: unknown): Item {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Item;
}

function asKey(value: unknown): Key {
  const record = asRecord(value);
  assert.equal(typeof record.PK, 'string');
  assert.equal(typeof record.SK, 'string');
  return { PK: record.PK as string, SK: record.SK as string };
}

function asRecordMap(value: unknown): Record<string, unknown> {
  return value === undefined ? {} : asRecord(value);
}

class TransactionCanceledError extends Error {
  readonly CancellationReasons: Array<{ Code: string }>;

  constructor(index: number) {
    super('Transaction cancelled by the in-memory DynamoDB test double.');
    this.name = 'TransactionCanceledException';
    this.CancellationReasons = Array.from({ length: 3 }, (_, i) => ({
      Code: i === index ? 'ConditionalCheckFailed' : 'None',
    }));
  }
}

/** In-memory DynamoDB command fake; tests remain offline and exercise UsageService itself. */
class UsageDynamoMock {
  private readonly items = new Map<string, Item>();

  seed(key: Key, item: Item): void {
    this.items.set(itemKey(key), structuredClone(item));
  }

  get(key: Key): Item | undefined {
    const item = this.items.get(itemKey(key));
    return item && structuredClone(item);
  }

  async send(command: { input: Record<string, unknown> }): Promise<Item> {
    if (command instanceof GetCommand) {
      return { Item: this.get(asKey(command.input.Key)) };
    }

    if (command instanceof TransactWriteCommand) {
      const input = command.input as { TransactItems: TransactionItem[] };
      this.transact(input.TransactItems);
      return {};
    }

    throw new Error(`Unexpected DynamoDB command: ${command.constructor.name}`);
  }

  private transact(operations: TransactionItem[]): void {
    const staged = new Map<string, Item>();
    for (const [key, item] of this.items) staged.set(key, structuredClone(item));

    for (const [index, operation] of operations.entries()) {
      if (operation.Update) {
        this.applyUpdate(staged, operation.Update, index);
      } else if (operation.Put) {
        const put = operation.Put;
        const item = asRecord(put.Item);
        const key = itemKey(asKey(item));
        if (staged.has(key)) throw new TransactionCanceledError(index);
        staged.set(key, structuredClone(item));
      } else {
        throw new Error('Unsupported transaction operation in usage test.');
      }
    }

    this.items.clear();
    for (const [key, item] of staged) this.items.set(key, item);
  }

  private applyUpdate(
    staged: Map<string, Item>,
    update: Record<string, unknown>,
    index: number,
  ): void {
    const key = itemKey(asKey(update.Key));
    const current = staged.get(key) ?? {};
    const names = asRecordMap(update.ExpressionAttributeNames);
    const values = asRecordMap(update.ExpressionAttributeValues);
    const condition = String(update.ConditionExpression ?? '');

    if (condition.includes('attribute_not_exists(#machineChars)')) {
      const used = Number(current.machineChars ?? 0);
      if (current.machineChars !== undefined && used > Number(values[':remaining'])) {
        throw new TransactionCanceledError(index);
      }
    } else if (condition.includes('#status = :reserved') && current.status !== 'RESERVED') {
      throw new TransactionCanceledError(index);
    }

    const expression = String(update.UpdateExpression ?? '');
    if (expression.startsWith('ADD ')) {
      for (const term of expression.slice(4).split(', ')) {
        const [nameToken, valueToken] = term.split(' ');
        const name = names[nameToken];
        if (typeof name !== 'string') throw new Error(`Unknown update field: ${nameToken}`);
        const value = Number(values[valueToken]);
        current[name] = Number(current[name] ?? 0) + value;
      }
    } else if (expression.startsWith('SET ')) {
      for (const assignment of expression.slice(4).split(', ')) {
        const [nameToken, valueToken] = assignment.split(' = ');
        const name = names[nameToken];
        if (typeof name !== 'string') throw new Error(`Unknown update field: ${nameToken}`);
        current[name] = values[valueToken];
      }
    } else {
      throw new Error(`Unsupported update expression: ${expression}`);
    }
    staged.set(key, current);
  }
}

function createUsage(limit: number, tenantId: string) {
  const ddb = new UsageDynamoMock();
  ddb.seed(
    { PK: `TENANT#${tenantId}`, SK: 'CONFIG' },
    { PK: `TENANT#${tenantId}`, SK: 'CONFIG', plan: 'Free', characterLimit: limit },
  );
  const usage = new UsageService(
    ddb as unknown as DynamoDBDocumentClient,
    { tableName: 'TranslateMeUsageTest', maxTransactionAttempts: 1 },
  );
  return { ddb, usage };
}

describe('TranslateMe monthly usage reservation (offline)', () => {
  it('limits concurrent reservations to the configured character quota', async () => {
    const tenantId = `concurrency-${randomUUID()}`;
    const limit = 1_000;
    const { ddb, usage } = createUsage(limit, tenantId);
    const source: UsageSource = { kind: 'CONSOLE' };

    const attempts = await Promise.allSettled(
      Array.from({ length: 50 }, (_, i) => usage.reserve({
        tenantId,
        requestId: `req-${i}-${randomUUID()}`,
        n: 100,
        source,
      })),
    );

    const accepted = attempts.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    const rejected = attempts.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );

    assert.equal(accepted.length, 10);
    assert.equal(rejected.length, 40);
    assert.ok(rejected.every((error) => error instanceof CharacterQuotaExceededError));

    await Promise.all(accepted.map((ticket) =>
      usage.settle(ticket, { machineChars: 100 }),
    ));
    const total = ddb.get(usageKeys(tenantId, accepted[0].month, source).total);
    assert.equal(total?.machineChars, 1_000);
    assert.ok(Number(total?.machineChars) <= limit);
  });

  it('rejects a reservation larger than CONFIG before creating usage counters', async () => {
    const tenantId = `oversized-${randomUUID()}`;
    const { ddb, usage } = createUsage(200, tenantId);

    await assert.rejects(
      usage.reserve({
        tenantId,
        requestId: randomUUID(),
        n: 201,
        source: { kind: 'CONSOLE' },
      }),
      CharacterQuotaExceededError,
    );

    const total = ddb.get(usageKeys(tenantId, monthUtc(), { kind: 'CONSOLE' }).total);
    assert.equal(total?.machineChars, undefined);
  });

  it('refunds a reservation exactly once', async () => {
    const tenantId = `refund-${randomUUID()}`;
    const { ddb, usage } = createUsage(1_000, tenantId);
    const ticket = await usage.reserve({
      tenantId,
      requestId: randomUUID(),
      n: 300,
      source: { kind: 'API', keyId: 'key-refund' },
    });
    const totalKey = usageKeys(tenantId, ticket.month, ticket.source).total;
    assert.equal(ddb.get(totalKey)?.machineChars, 300);

    await usage.refund(ticket);
    assert.equal(ddb.get(totalKey)?.machineChars, 0);
    await usage.refund(ticket);
    assert.equal(ddb.get(totalKey)?.machineChars, 0);
  });

  it('reconciles total and per-source counters across WEB, CONSOLE, and API', async () => {
    const tenantId = `reconcile-${randomUUID()}`;
    const { ddb, usage } = createUsage(10_000, tenantId);
    const rows: Array<{
      requestId: string;
      n: number;
      machineChars: number;
      memoryChars: number;
      source: UsageSource;
    }> = [
      { requestId: randomUUID(), n: 100, machineChars: 90, memoryChars: 10, source: { kind: 'WEB', slug: 'hotel-a' } },
      { requestId: randomUUID(), n: 200, machineChars: 180, memoryChars: 20, source: { kind: 'CONSOLE' } },
      { requestId: randomUUID(), n: 50, machineChars: 50, memoryChars: 0, source: { kind: 'API', keyId: 'key-abc' } },
    ];
    const expectedMachine = rows.reduce((sum, row) => sum + row.machineChars, 0);
    const expectedMemory = rows.reduce((sum, row) => sum + row.memoryChars, 0);
    const expectedTotal = expectedMachine + expectedMemory;

    const tickets = await Promise.all(rows.map((row) => usage.reserve({
      tenantId,
      requestId: row.requestId,
      n: row.n,
      source: row.source,
    })));
    await Promise.all(tickets.map((ticket, i) => usage.settle(ticket, {
      machineChars: rows[i].machineChars,
      memoryChars: rows[i].memoryChars,
    })));

    const month = tickets[0].month;
    const total = ddb.get(usageKeys(tenantId, month, rows[0].source).total);
    assert.equal(total?.machineChars, expectedMachine);
    assert.equal(total?.memoryChars, expectedMemory);
    assert.equal(total?.sentTotal, expectedTotal);
    assert.equal(total?.sentFromTM, expectedMemory);
    assert.equal(total?.requests, rows.length);

    for (const row of rows) {
      const sourceItem = ddb.get(usageKeys(tenantId, month, row.source).source);
      assert.equal(sourceItem?.machineChars, row.machineChars);
      assert.equal(sourceItem?.memoryChars, row.memoryChars);
      assert.equal(sourceItem?.sentTotal, row.machineChars + row.memoryChars);
      assert.equal(sourceItem?.requests, 1);
    }
  });

  it('uses the UTC month stored in the reservation when settling', async () => {
    const tenantId = `month-${randomUUID()}`;
    const { ddb, usage } = createUsage(1_000, tenantId);
    const source: UsageSource = { kind: 'WEB', slug: 'hotel-a' };
    const ticket: UsageReservation = await usage.reserve({
      tenantId,
      requestId: randomUUID(),
      n: 100,
      source,
      now: new Date('2026-10-31T23:59:59.000Z'),
    });

    assert.equal(ticket.month, '2026-10');
    assert.equal(monthUtc(new Date('2026-11-01T00:00:01.000Z')), '2026-11');

    await usage.settle(ticket, { machineChars: 100 });
    const october = ddb.get(usageKeys(tenantId, '2026-10', source).total);
    const november = ddb.get(usageKeys(tenantId, '2026-11', source).total);
    assert.equal(october?.machineChars, 100);
    assert.equal(november?.machineChars, undefined);
  });

  it('rejects settling a refunded reservation', async () => {
    const tenantId = `state-${randomUUID()}`;
    const { usage } = createUsage(1_000, tenantId);
    const ticket = await usage.reserve({
      tenantId,
      requestId: randomUUID(),
      n: 50,
      source: { kind: 'CONSOLE' },
    });
    await usage.refund(ticket);

    await assert.rejects(
      usage.settle(ticket, { machineChars: 50 }),
      ReservationStateError,
    );
  });
});
