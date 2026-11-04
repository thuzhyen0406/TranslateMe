import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BatchGetCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { createRealtimeHandler, type RealtimeDeps } from '../realtime.js';
import { CharacterQuotaExceededError } from '../../../../libs/common/usage/usage.js';

const TABLE = 'TranslateMe';
const TENANT = 't_test';
const KEY_ID = 'key-test';

/** Tạo event API Gateway dùng chung cho các trường hợp kiểm thử realtime. */
function event(body: unknown) {
  return {
    body: JSON.stringify(body),
    requestContext: {
      requestId: 'req-test-001',
      authorizer: { tenantId: TENANT, keyId: KEY_ID },
    },
  };
}

/** Tạo handler giả cùng các bản ghi nhớ và lệnh AWS đã được gọi trong bài test. */
function setup(options: { memory?: string; locked?: boolean; quotaExceeded?: boolean; tmWriteFails?: boolean; keymapTenantId?: string; detected?: { language?: string; confidence?: number } } = {}) {
  const calls: Array<{ name: string; input: Record<string, any> }> = [];
  const stored: Array<Record<string, any>> = [];
  const translateInputs: Array<Record<string, any>> = [];
  const reservationInputs: Array<{ n: number }> = [];
  const settlements: Array<Record<string, any>> = [];
  let translateCalls = 0;
  const ddb = {
    async send(command: any) {
      const name = command.constructor.name;
      const input = command.input as Record<string, any>;
      calls.push({ name, input });
      if (command instanceof GetCommand) {
        const key = input.Key as { PK?: string; SK?: string } | undefined;
        if (key?.PK === `TENANT#PLATFORM#KEY#${KEY_ID}`) {
          return options.keymapTenantId ? { Item: { tenantId: options.keymapTenantId } } : {};
        }
        return { Item: { status: options.locked ? 'LOCKED' : 'ACTIVE', charLimit: 50_000, glossaryVersion: 7 } };
      }
      if (command instanceof BatchGetCommand) {
        const keys = input.RequestItems[TABLE].Keys as Array<{ PK: string; SK: string }>;
        const rows = keys.flatMap((key) => {
          const found = stored.find((item) => item.PK === key.PK && item.SK === key.SK);
          if (found) return [found];
          if (options.memory) return [{ ...key, tgt: options.memory, label: 'HUMAN', glossaryVersion: 7 }];
          return [];
        });
        return { Responses: { [TABLE]: rows } };
      }
      if (command instanceof UpdateCommand) {
        if (options.tmWriteFails) throw Object.assign(new Error('DynamoDB throttled'), { name: 'ThrottlingException' });
        const key = input.Key as { PK: string; SK: string };
        const item = stored.find((row) => row.PK === key.PK && row.SK === key.SK) ?? { ...key };
        if (item.label === 'HUMAN') {
          throw Object.assign(new Error('Human TM entries cannot be overwritten'), { name: 'ConditionalCheckFailedException' });
        }
        const names = input.ExpressionAttributeNames as Record<string, string>;
        const values = input.ExpressionAttributeValues as Record<string, unknown>;
        const expression = String(input.UpdateExpression);
        const [setExpression, addExpression] = expression.split(' ADD ');
        for (const assignment of setExpression.replace(/^SET /, '').split(', ')) {
          const [nameToken, valueToken] = assignment.split(' = ');
          item[names[nameToken]] = values[valueToken];
        }
        if (addExpression) {
          for (const addition of addExpression.split(', ')) {
            const [nameToken, valueToken] = addition.split(' ');
            const name = names[nameToken];
            item[name] = Number(item[name] ?? 0) + Number(values[valueToken]);
          }
        }
        const existingIndex = stored.findIndex((row) => row.PK === key.PK && row.SK === key.SK);
        if (existingIndex < 0) stored.push(item);
        else stored[existingIndex] = item;
        return {};
      }
      throw new Error(`Lệnh DynamoDB không được giả lập: ${name}`);
    },
  };
  const usage = {
    async reserve(input: { n: number }) {
      reservationInputs.push(input);
      if (options.quotaExceeded && input.n > 0) throw new CharacterQuotaExceededError(input.n, 50_000);
      return { tenantId: TENANT, requestId: 'req-test-001', month: '2026-10', reservedChars: input.n, limit: 50_000, source: { kind: 'API' as const, keyId: KEY_ID }, createdAt: '2026-10-01T00:00:00.000Z' };
    },
    async settle(_ticket: unknown, actual: unknown) { settlements.push(actual as Record<string, any>); },
    async refund(_ticket: unknown) {},
  };
  const translate = {
    async send(command: any) {
      translateCalls++;
      const input = command.input as Record<string, any>;
      translateInputs.push(input);
      const text = String(input.Text);
      return { TranslatedText: text.replace(/(<[^>]+>)|([^<]+)/g, (_all, tag: string | undefined, plain: string | undefined) => tag ?? (plain ?? '').toUpperCase()) };
    },
  };
  const deps = {
    tableName: TABLE,
    ddb: ddb as unknown as RealtimeDeps['ddb'],
    usage: usage as unknown as RealtimeDeps['usage'],
    translate,
    detectLanguage: async () => options.detected ?? { language: 'vi', confidence: 0.99 },
    now: () => new Date('2026-10-29T00:00:00.000Z'),
  } satisfies RealtimeDeps;
  return {
    handler: createRealtimeHandler(deps),
    calls,
    stored,
    translateInputs,
    reservationInputs,
    settlements,
    get translateCalls() { return translateCalls; },
  };
}

/** Giải mã JSON trong phản hồi để kiểm tra schema API. */
function responseBody(response: { body: string }) {
  return JSON.parse(response.body) as Record<string, any>;
}

describe('POST /translate/realtime', () => {
  it('lấy tenant từ KEYMAP và bỏ qua tenant_id giả mạo trong body', async () => {
    const mappedTenant = 't_aaaaaaaaaaaaaaaaaaaaaaaa';
    const test = setup({ keymapTenantId: mappedTenant });
    const response = await test.handler({
      body: JSON.stringify({ text: 'Xin chào.', source_lang: 'vi', target_lang: 'en', tenant_id: 't_bbbbbbbbbbbbbbbbbbbbbbbb' }),
      requestContext: { requestId: 'req-keymap-body', identity: { apiKeyId: KEY_ID } },
    });

    assert.equal(response.statusCode, 200);
    const scopedCalls = test.calls.filter((call) => ['BatchGetCommand', 'UpdateCommand'].includes(call.name));
    assert.ok(scopedCalls.length > 0);
    for (const call of scopedCalls) {
      const key = call.name === 'BatchGetCommand'
        ? call.input.RequestItems[TABLE].Keys[0]
        : call.input.Key;
      assert.ok(String(key.PK).startsWith(`TENANT#${mappedTenant}`));
      assert.ok(!String(key.PK).includes('t_bbbbbbbbbbbbbbbbbbbbbbbb'));
    }
  });

  it('dịch qua cùng translateSentences cho cả vi→en, vi→ko và vi→ja', async () => {
    for (const targetLang of ['en', 'ko', 'ja']) {
      const test = setup();
      const response = await test.handler(event({ text: 'Xin chào.', source_lang: 'vi', target_lang: targetLang }));
      const body = responseBody(response);

      assert.equal(response.statusCode, 200);
      assert.equal(body.source_lang, 'vi');
      assert.equal(body.source_lang_detected, false);
      assert.equal(body.target_lang, targetLang);
      assert.equal(body.translated_text, 'XIN CHÀO.');
      assert.equal(body.characters_machine_translated, 'Xin chào.'.length);
      assert.equal(body.characters_from_memory, 0);
      assert.equal(test.translateCalls, 1);
      assert.equal(test.calls.some((call) => call.name === 'BatchGetCommand'), true);
      assert.equal(test.calls.some((call) => call.name === 'UpdateCommand'), true);
      const batchGet = test.calls.find((call) => call.name === 'BatchGetCommand');
      assert.equal(batchGet?.input.RequestItems[TABLE].Keys[0].PK, `TENANT#${TENANT}#TM#vi#${targetLang}`);
      assert.equal(test.stored[0].PK, `TENANT#${TENANT}#TM#vi#${targetLang}`);
      assert.equal(test.stored[0].GSI3PK, `TENANT#${TENANT}#TM#MACHINE`);
    }
  });

  it('trả 200 khi mọi câu trúng TM kể cả khi quota service báo hết hạn mức', async () => {
    const sentence = 'Xin chào.';
    const test = setup({ memory: 'Hello.', quotaExceeded: true });
    const response = await test.handler(event({ text: sentence, source_lang: 'vi', target_lang: 'en' }));
    const body = responseBody(response);

    assert.equal(response.statusCode, 200);
    assert.equal(body.translated_text, 'Hello.');
    assert.equal(body.characters_machine_translated, 0);
    assert.equal(body.characters_from_memory, sentence.length);
    assert.equal(test.reservationInputs[0].n, 0);
    assert.equal(test.settlements[0].machineChars, 0);
    assert.equal(test.translateCalls, 0);
  });

  it('bỏ qua đọc và ghi TM, đồng thời không gửi Custom Terminology khi use_terminology=false', async () => {
    const test = setup({ memory: 'Không được dùng.' });
    const response = await test.handler(event({ text: 'Xin chào.', source_lang: 'vi', target_lang: 'en', use_terminology: false }));
    assert.equal(response.statusCode, 200);
    assert.equal(test.calls.some((call) => call.name === 'BatchGetCommand'), false);
    assert.equal(test.calls.some((call) => call.name === 'UpdateCommand'), false);
    assert.equal(test.translateCalls, 1);
    assert.equal(test.translateInputs[0].TerminologyNames, undefined);
  });

  it('trả đúng lỗi 403 khi tenant bị khóa trước khi đọc nội dung yêu cầu', async () => {
    const test = setup({ locked: true });
    const response = await test.handler(event({ text: 'Xin chào.', target_lang: 'en' }));

    assert.equal(response.statusCode, 403);
    assert.equal(responseBody(response).error.code, 'TENANT_SUSPENDED');
    assert.equal(test.calls.some((call) => call.name === 'BatchGetCommand'), false);
  });

  it('tự nhận diện ngôn ngữ và trả LANGUAGE_NOT_DETECTED dưới ngưỡng 0,70', async () => {
    const test = setup({ detected: { language: 'vi', confidence: 0.69 } });
    const response = await test.handler(event({ text: 'Xin chào.', target_lang: 'ja' }));

    assert.equal(response.statusCode, 400);
    assert.equal(responseBody(response).error.code, 'LANGUAGE_NOT_DETECTED');
    assert.equal(test.translateCalls, 0);
  });

  it('trả mã lỗi cho API key sai và yêu cầu vượt hạn mức ký tự', async () => {
    const unauthorized = setup();
    const missingKeyResponse = await unauthorized.handler({ body: '{}', requestContext: { requestId: 'req-no-key' } });
    assert.equal(missingKeyResponse.statusCode, 401);
    assert.equal(responseBody(missingKeyResponse).error.code, 'UNAUTHORIZED');

    const overQuota = setup({ quotaExceeded: true });
    const quotaResponse = await overQuota.handler(event({ text: 'Xin chào.', source_lang: 'vi', target_lang: 'en' }));
    assert.equal(quotaResponse.statusCode, 429);
    assert.equal(responseBody(quotaResponse).error.code, 'CHAR_QUOTA_EXCEEDED');
    assert.equal(overQuota.translateCalls, 0);
  });

  it('hoàn hạn mức đặt trước khi Translate lỗi', async () => {
    let refunded = false;
    const deps = {
      tableName: TABLE,
      ddb: { async send(command: any) {
        if (command instanceof GetCommand) return { Item: { status: 'ACTIVE', charLimit: 50_000, glossaryVersion: 0 } };
        if (command instanceof BatchGetCommand) return { Responses: { [TABLE]: [] } };
        throw new Error('Lệnh không mong đợi');
      } } as unknown as RealtimeDeps['ddb'],
      usage: {
        async reserve(input: { n: number }) { return { tenantId: TENANT, requestId: 'req-test-001', month: '2026-10', reservedChars: input.n, limit: 50_000, source: { kind: 'API' as const, keyId: KEY_ID }, createdAt: '2026-10-01T00:00:00.000Z' }; },
        async settle() {},
        async refund() { refunded = true; },
      } as unknown as RealtimeDeps['usage'],
      translate: { async send() { throw new Error('Translate lỗi'); } },
      detectLanguage: async () => ({ language: 'vi', confidence: 0.99 }),
    } satisfies RealtimeDeps;
    const handler = createRealtimeHandler(deps);
    const response = await handler(event({ text: 'Xin chào.', source_lang: 'vi', target_lang: 'en' }));

    assert.equal(response.statusCode, 500);
    assert.equal(responseBody(response).error.code, 'INTERNAL_ERROR');
    assert.equal(refunded, true);
  });

  it('quyết toán bản dịch và trả cảnh báo nếu ghi TM thất bại', async () => {
    const test = setup({ tmWriteFails: true });
    const response = await test.handler(event({ text: 'Xin chào.', source_lang: 'vi', target_lang: 'en' }));
    const body = responseBody(response);

    assert.equal(response.statusCode, 200);
    assert.equal(body.translated_text, 'XIN CHÀO.');
    assert.deepEqual(body.warnings, ['TM_WRITE_FAILED']);
    assert.equal(test.settlements.length, 1);
    assert.equal(test.settlements[0].machineChars, 'Xin chào.'.length);
    assert.equal(test.calls.some((call) => call.name === 'UpdateCommand'), true);
  });
});
