import { createHash } from "node:crypto";
import {
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";

export type UsageSource =
  | { kind: "WEB"; slug: string }
  | { kind: "CONSOLE" }
  | { kind: "API"; keyId: string };

export interface UsageReservation {
  tenantId: string;
  requestId: string;
  month: string; // Tháng UTC YYYY-MM được cố định tại thời điểm đặt trước.
  reservedChars: number;
  limit: number;
  source: UsageSource;
  createdAt: string;
}

export interface ActualUsage {
  /** Số ký tự thực tế được gửi đi dịch máy. */
  machineChars: number;
  /** Số ký tự nguồn được phục vụ từ bộ nhớ dịch (Translation Memory). */
  memoryChars?: number;
  /** Số câu được phục vụ từ TM và số câu phải gửi dịch máy. */
  tmHits?: number;
  tmMisses?: number;
  /** Số trang được phục vụ bởi yêu cầu proxy; mặc định là 1 với WEB. */
  pagesServed?: number;
  /**
   * Số lượt yêu cầu cộng vào bộ đếm requests; mặc định là 1.
   * Proxy đặt 0 cho phần dịch nền (worker) và dịch trước (prewarm) vì đó không phải lượt truy cập.
   */
  requests?: number;
}

export interface UsageServiceOptions {
  tableName: string;
  /** Số lần thử lại khi giao dịch DynamoDB gặp xung đột tạm thời. */
  maxTransactionAttempts?: number;
  /**
   * Số ngày giữ phiếu RESERVATION# trước khi DynamoDB TTL (thuộc tính `ttl`) xoá; mặc định 40.
   * Mỗi lượt dịch tạo một phiếu, nên không có TTL thì bảng phình theo số lượt. Bộ đếm MONTH# không bị xoá.
   */
  reservationTtlDays?: number;
  /** Hàm ghi log tùy chọn khi thao tác quyết toán/hoàn tiền thất bại. */
  onAccountingError?: (event: {
    operation: "settle" | "refund";
    tenantId: string;
    requestId: string;
    error: unknown;
  }) => void;
}

export class CharacterQuotaExceededError extends Error {
  readonly code = "CHAR_QUOTA_EXCEEDED";
  constructor(
    public readonly requested: number,
    public readonly limit: number,
  ) {
    super(`Requested ${requested} machine-translation characters exceeds limit ${limit}.`);
    this.name = "CharacterQuotaExceededError";
  }
}

export class UsageConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageConfigError";
  }
}

export class ReservationStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReservationStateError";
  }
}


/** Phiếu chỉ cần cho tới khi quyết toán/hoàn (vài giây tới vài giờ với batch); giữ thêm để đối soát trong tháng. */
export const DEFAULT_RESERVATION_TTL_DAYS = 40;

const STATUS_RESERVED = "RESERVED";
const STATUS_SETTLED = "SETTLED";
const STATUS_REFUNDED = "REFUNDED";

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer.`);
  }
}

function requireNonEmpty(value: string, field: string): void {
  if (!value || !value.trim()) throw new TypeError(`${field} must not be empty.`);
}

export function monthUtc(date: Date = new Date()): string {
  if (Number.isNaN(date.getTime())) throw new RangeError("Invalid date.");
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function usageKeys(tenantId: string, month: string, source: UsageSource) {
  const usagePk = `TENANT#${tenantId}#USAGE`;
  const total = { PK: usagePk, SK: `MONTH#${month}` };

  if (source.kind === "WEB") {
    return {
      total,
      source: {
        PK: usagePk,
        SK: `MONTH#${month}#WEB#${encodeURIComponent(source.slug)}`,
      },
    };
  }
  if (source.kind === "CONSOLE") {
    return {
      total,
      source: { PK: usagePk, SK: `MONTH#${month}#CONSOLE` },
    };
  }
  return {
    total,
    source: {
      PK: `TENANT#${tenantId}#KEYUSAGE#${encodeURIComponent(source.keyId)}`,
      SK: `MONTH#${month}`,
    },
  };
}

function reservationKey(tenantId: string, requestId: string) {
  return {
    PK: `TENANT#${tenantId}#USAGE`,
    SK: `RESERVATION#${encodeURIComponent(requestId)}`,
  };
}

function stableClientToken(operation: string, requestId: string): string {
  // ClientRequestToken của DynamoDB giới hạn tối đa 36 ký tự.
  return createHash("sha256")
    .update(`${operation}:${requestId}`, "utf8")
    .digest("hex")
    .slice(0, 36);
}

function sameSource(a: UsageSource, b: UsageSource): boolean {
  return a.kind === b.kind &&
    (a.kind !== "WEB" || (b.kind === "WEB" && a.slug === b.slug)) &&
    (a.kind !== "API" || (b.kind === "API" && a.keyId === b.keyId));
}

function isRetryableTransactionError(error: unknown): boolean {
  const e = error as {
    name?: string;
    CancellationReasons?: Array<{ Code?: string }>;
  };
  const transientCodes = new Set([
    "TransactionConflict",
    "ProvisionedThroughputExceeded",
    "ThrottlingError",
    "ItemCollectionSizeLimitExceeded",
  ]);
  if (e?.name === "TransactionInProgressException" ||
      e?.name === "ProvisionedThroughputExceededException" ||
      e?.name === "ThrottlingException" ||
      e?.name === "RequestLimitExceeded" ||
      e?.name === "InternalServerError") {
    return true;
  }
  return e?.name === "TransactionCanceledException" &&
    Boolean(e.CancellationReasons?.some((r) => transientCodes.has(r.Code ?? "")));
}

function cancellationReason(error: unknown, index: number): string | undefined {
  const e = error as { CancellationReasons?: Array<{ Code?: string }> };
  return e?.CancellationReasons?.[index]?.Code;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class UsageService {
  private readonly maxAttempts: number;
  private readonly reservationTtlSeconds: number;

  constructor(
    private readonly ddb: DynamoDBDocumentClient,
    private readonly options: UsageServiceOptions,
  ) {
    if (!options.tableName) throw new TypeError("tableName is required.");
    this.maxAttempts = options.maxTransactionAttempts ?? 18;
    const ttlDays = options.reservationTtlDays ?? DEFAULT_RESERVATION_TTL_DAYS;
    if (!Number.isSafeInteger(ttlDays) || ttlDays < 1) throw new RangeError("reservationTtlDays must be a positive integer.");
    this.reservationTtlSeconds = ttlDays * 86_400;
  }

  /**
  * Đọc gói dịch vụ và giới hạn ký tự của tenant từ mục CONFIG.
  * Mục dự kiến: PK=TENANT#<tenantId>, SK=CONFIG, plan=Free|Pro|Business,
  * characterLimit=200000|1000000|5000000 (ví dụ minh họa; TV1 cấu hình giá trị).
   */
  private async getTenantLimit(tenantId: string): Promise<number> {
    const result = await this.ddb.send(new GetCommand({
      TableName: this.options.tableName,
      Key: { PK: `TENANT#${tenantId}`, SK: "CONFIG" },
      ConsistentRead: true,
      // PostConfirmation và Platform ghi hạn mức vào charLimit; characterLimit được giữ để tương thích.
      ProjectionExpression: "#plan, #limit, #charLimit",
      ExpressionAttributeNames: {
        "#plan": "plan",
        "#limit": "characterLimit",
        "#charLimit": "charLimit",
      },
    }));

    const item = result.Item;
    if (!item) throw new UsageConfigError(`CONFIG not found for tenant ${tenantId}.`);
    const limit = item.characterLimit ?? item.charLimit;
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new UsageConfigError(
        `CONFIG.characterLimit is missing or invalid for tenant ${tenantId}.`,
      );
    }
    return limit as number;
  }

  private async getReservation(tenantId: string, requestId: string) {
    const result = await this.ddb.send(new GetCommand({
      TableName: this.options.tableName,
      Key: reservationKey(tenantId, requestId),
      ConsistentRead: true,
    }));
    return result.Item;
  }

  private async runTransactionWithRetry(input: ConstructorParameters<typeof TransactWriteCommand>[0]) {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      try {
        await this.ddb.send(new TransactWriteCommand(input));
        return;
      } catch (error) {
        lastError = error;
        if (!isRetryableTransactionError(error) || attempt === this.maxAttempts - 1) {
          throw error;
        }
        const exponential = Math.min(500, 8 * 2 ** Math.min(attempt, 6));
        const jitter = Math.floor(Math.random() * 20);
        await sleep(exponential + jitter);
      }
    }
    throw lastError;
  }

  async reserve(input: {
    tenantId: string;
    requestId: string;
    n: number;
    source: UsageSource;
    now?: Date;
  }): Promise<UsageReservation> {
    requireNonEmpty(input.tenantId, "tenantId");
    requireNonEmpty(input.requestId, "requestId");
    assertNonNegativeInteger(input.n, "n");
    if (input.source.kind === "WEB") requireNonEmpty(input.source.slug, "source.slug");
    if (input.source.kind === "API") requireNonEmpty(input.source.keyId, "source.keyId");

    const prior = await this.getReservation(input.tenantId, input.requestId);
    if (prior) {
      const priorSource = prior.source as UsageSource;
      if (prior.reservedChars !== input.n || !sameSource(priorSource, input.source)) {
        throw new ReservationStateError("requestId already exists with different reservation parameters.");
      }
      if (prior.status !== STATUS_RESERVED) {
        throw new ReservationStateError(`Reservation is already ${String(prior.status)}.`);
      }
      return this.toTicket(prior);
    }

    const limit = await this.getTenantLimit(input.tenantId);
    if (input.n > limit) throw new CharacterQuotaExceededError(input.n, limit);

    const reservationTime = input.now ?? new Date();
    const month = monthUtc(reservationTime);
    const createdAt = reservationTime.toISOString();
    const ticket: UsageReservation = {
      tenantId: input.tenantId,
      requestId: input.requestId,
      month,
      reservedChars: input.n,
      limit,
      source: input.source,
      createdAt,
    };
    const keys = usageKeys(input.tenantId, month, input.source);
    const reservation = reservationKey(input.tenantId, input.requestId);

    try {
      await this.runTransactionWithRetry({
        TransactItems: [
          {
            Update: {
              TableName: this.options.tableName,
              Key: keys.total,
              UpdateExpression: "ADD #machineChars :n",
              ConditionExpression:
                "attribute_not_exists(#machineChars) OR #machineChars <= :remaining",
              ExpressionAttributeNames: { "#machineChars": "machineChars" },
              ExpressionAttributeValues: {
                ":n": input.n,
                ":remaining": limit - input.n,
              },
            },
          },
          {
            Put: {
              TableName: this.options.tableName,
              Item: {
                ...reservation,
                entityType: "USAGE_RESERVATION",
                tenantId: input.tenantId,
                requestId: input.requestId,
                month,
                reservedChars: input.n,
                limit,
                source: input.source,
                status: STATUS_RESERVED,
                createdAt,
                ttl: Math.floor(reservationTime.getTime() / 1000) + this.reservationTtlSeconds,
              },
              ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
            },
          },
        ],
      });
      return ticket;
    } catch (error) {
      // Nếu một lần thử đồng thời khác với cùng requestId đã thành công, dùng lại vé đã được cố định.
      const existing = await this.getReservation(input.tenantId, input.requestId);
      if (existing) {
        if (existing.reservedChars === input.n && sameSource(existing.source as UsageSource, input.source) && existing.status === STATUS_RESERVED) {
          return this.toTicket(existing);
        }
        throw new ReservationStateError("requestId exists but does not match an active reservation.");
      }

      // Điều kiện của mục tổng nằm ở vị trí 0; thất bại tại đây nghĩa là vượt hạn ngạch.
      if (cancellationReason(error, 0) === "ConditionalCheckFailed") {
        throw new CharacterQuotaExceededError(input.n, limit);
      }
      if ((error as { name?: string })?.name === "TransactionCanceledException") {
        const read = await this.ddb.send(new GetCommand({
          TableName: this.options.tableName,
          Key: keys.total,
          ConsistentRead: true,
          ProjectionExpression: "#machineChars",
          ExpressionAttributeNames: { "#machineChars": "machineChars" },
        }));
        const used = Number(read.Item?.machineChars ?? 0);
        if (used + input.n > limit) throw new CharacterQuotaExceededError(input.n, limit);
      }
      throw error;
    }
  }

  /**
   * Finalizes a reservation. On the total row, machineChars receives (actual - n)
   * because n was added during reserve(). Source/key counters receive actual usage.
   * All counter changes and the reservation state change commit in one transaction.
   */
  async settle(ticket: UsageReservation, actual: ActualUsage): Promise<void> {
    assertNonNegativeInteger(actual.machineChars, "actual.machineChars");
    const memoryChars = actual.memoryChars ?? 0;
    assertNonNegativeInteger(memoryChars, "actual.memoryChars");
    const tmHits = actual.tmHits ?? 0;
    const tmMisses = actual.tmMisses ?? 0;
    assertNonNegativeInteger(tmHits, "actual.tmHits");
    assertNonNegativeInteger(tmMisses, "actual.tmMisses");
    const pagesServed = actual.pagesServed ?? (ticket.source.kind === "WEB" ? 1 : 0);
    assertNonNegativeInteger(pagesServed, "actual.pagesServed");
    const requests = actual.requests ?? 1;
    assertNonNegativeInteger(requests, "actual.requests");

    const existing = await this.getReservation(ticket.tenantId, ticket.requestId);
    if (!existing) throw new ReservationStateError("Reservation not found.");
    this.assertTicketMatches(existing, ticket);
    if (existing.status === STATUS_SETTLED) {
      this.assertSameSettlement(existing, actual.machineChars, memoryChars, pagesServed, tmHits, tmMisses, requests);
      return;
    }
    if (existing.status !== STATUS_RESERVED) {
      throw new ReservationStateError(`Cannot settle reservation in state ${String(existing.status)}.`);
    }

    const keys = usageKeys(ticket.tenantId, ticket.month, ticket.source);
    const totalCharacters = actual.machineChars + memoryChars;
    const counterValues = {
      ":machineChars": actual.machineChars,
      ":memoryChars": memoryChars,
      ":sentTotal": totalCharacters,
      ":sentFromTM": memoryChars,
      ":requests": requests,
      ":pagesServed": pagesServed,
      ":tmHits": tmHits,
      ":tmMisses": tmMisses,
    };
    const names = {
      "#machineChars": "machineChars",
      "#memoryChars": "memoryChars",
      "#sentTotal": "sentTotal",
      "#sentFromTM": "sentFromTM",
      "#requests": "requests",
      "#pagesServed": "pagesServed",
      "#tmHits": "tmHits",
      "#tmMisses": "tmMisses",
    };

    // Chỉ bộ đếm machineChars của dòng tổng được điều chỉnh theo chênh lệch so với số đã đặt trước.
    const totalUpdate = {
      TableName: this.options.tableName,
      Key: keys.total,
      UpdateExpression: "ADD #machineChars :machineDelta, #memoryChars :memoryChars, #sentTotal :sentTotal, #sentFromTM :sentFromTM, #requests :requests, #pagesServed :pagesServed, #tmHits :tmHits, #tmMisses :tmMisses",
      ExpressionAttributeNames: names,
      // Dòng tổng dùng :machineDelta thay cho :machineChars; DynamoDB từ chối giá trị khai báo mà không dùng
      // (ValidationException "ExpressionAttributeValues unused"), nên bỏ :machineChars khỏi bộ giá trị ở đây.
      ExpressionAttributeValues: {
        ...Object.fromEntries(Object.entries(counterValues).filter(([name]) => name !== ":machineChars")),
        ":machineDelta": actual.machineChars - ticket.reservedChars,
      },
    };
    // Bộ đếm theo nguồn ghi số liệu thực tế, không dùng ước tính lúc đặt trước.
    const sourceUpdate = {
      TableName: this.options.tableName,
      Key: keys.source,
      UpdateExpression: "ADD #machineChars :machineChars, #memoryChars :memoryChars, #sentTotal :sentTotal, #sentFromTM :sentFromTM, #requests :requests, #pagesServed :pagesServed, #tmHits :tmHits, #tmMisses :tmMisses",
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: counterValues,
    };
    const stateUpdate = {
      TableName: this.options.tableName,
      Key: reservationKey(ticket.tenantId, ticket.requestId),
      UpdateExpression: "SET #status = :settled, #actualMachineChars = :actualMachineChars, #actualMemoryChars = :actualMemoryChars, #pagesServed = :pagesServed, #tmHits = :tmHits, #tmMisses = :tmMisses, #requestsCounted = :requestsCounted",
      ConditionExpression: "#status = :reserved",
      ExpressionAttributeNames: {
        "#status": "status",
        "#actualMachineChars": "actualMachineChars",
        "#actualMemoryChars": "actualMemoryChars",
        "#pagesServed": "pagesServed",
        "#tmHits": "tmHits",
        "#tmMisses": "tmMisses",
        "#requestsCounted": "requestsCounted",
      },
      ExpressionAttributeValues: {
        ":settled": STATUS_SETTLED,
        ":reserved": STATUS_RESERVED,
        ":actualMachineChars": actual.machineChars,
        ":actualMemoryChars": memoryChars,
        ":pagesServed": pagesServed,
        ":tmHits": tmHits,
        ":tmMisses": tmMisses,
        ":requestsCounted": requests,
      },
    };

    try {
      await this.runTransactionWithRetry({
        ClientRequestToken: stableClientToken("settle", ticket.requestId),
        TransactItems: [
          { Update: totalUpdate },
          { Update: sourceUpdate },
          { Update: stateUpdate },
        ],
      });
    } catch (error) {
      const latest = await this.getReservation(ticket.tenantId, ticket.requestId);
      if (latest?.status === STATUS_SETTLED) {
        this.assertSameSettlement(latest, actual.machineChars, memoryChars, pagesServed, tmHits, tmMisses, requests);
        return;
      }
      this.options.onAccountingError?.({ operation: "settle", tenantId: ticket.tenantId, requestId: ticket.requestId, error });
      throw error;
    }
  }

  /** Refund the entire reservation if Translate fails. No source usage is recorded. */
  async refund(ticket: UsageReservation): Promise<void> {
    const existing = await this.getReservation(ticket.tenantId, ticket.requestId);
    if (!existing) throw new ReservationStateError("Reservation not found.");
    this.assertTicketMatches(existing, ticket);
    if (existing.status === STATUS_REFUNDED) return;
    if (existing.status !== STATUS_RESERVED) {
      throw new ReservationStateError(`Cannot refund reservation in state ${String(existing.status)}.`);
    }

    const total = usageKeys(ticket.tenantId, ticket.month, ticket.source).total;
    const stateKey = reservationKey(ticket.tenantId, ticket.requestId);
    try {
      await this.runTransactionWithRetry({
        ClientRequestToken: stableClientToken("refund", ticket.requestId),
        TransactItems: [
          {
            Update: {
              TableName: this.options.tableName,
              Key: total,
              UpdateExpression: "ADD #machineChars :refund",
              ExpressionAttributeNames: { "#machineChars": "machineChars" },
              ExpressionAttributeValues: { ":refund": -ticket.reservedChars },
            },
          },
          {
            Update: {
              TableName: this.options.tableName,
              Key: stateKey,
              UpdateExpression: "SET #status = :refunded",
              ConditionExpression: "#status = :reserved",
              ExpressionAttributeNames: {
                "#status": "status",
              },
              ExpressionAttributeValues: {
                ":reserved": STATUS_RESERVED,
                ":refunded": STATUS_REFUNDED,
              },
            },
          },
        ],
      });
    } catch (error) {
      const latest = await this.getReservation(ticket.tenantId, ticket.requestId);
      if (latest?.status === STATUS_REFUNDED) return;
      this.options.onAccountingError?.({ operation: "refund", tenantId: ticket.tenantId, requestId: ticket.requestId, error });
      throw error;
    }
  }

  private toTicket(item: Record<string, any>): UsageReservation {
    return {
      tenantId: item.tenantId,
      requestId: item.requestId,
      month: item.month,
      reservedChars: item.reservedChars,
      limit: item.limit,
      source: item.source as UsageSource,
      createdAt: item.createdAt,
    };
  }

  private assertTicketMatches(item: Record<string, any>, ticket: UsageReservation): void {
    if (item.tenantId !== ticket.tenantId || item.requestId !== ticket.requestId ||
        item.month !== ticket.month || item.reservedChars !== ticket.reservedChars ||
        !sameSource(item.source as UsageSource, ticket.source)) {
      throw new ReservationStateError("Reservation ticket does not match the stored reservation.");
    }
  }

  private assertSameSettlement(
    item: Record<string, any>, machineChars: number, memoryChars: number, pagesServed: number, tmHits: number, tmMisses: number, requests: number,
  ): void {
    if (item.actualMachineChars !== machineChars || item.actualMemoryChars !== memoryChars || item.pagesServed !== pagesServed || (item.tmHits ?? 0) !== tmHits || (item.tmMisses ?? 0) !== tmMisses || (item.requestsCounted ?? 1) !== requests) {
      throw new ReservationStateError("requestId was already settled with different counters.");
    }
  }
}
