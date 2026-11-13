import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BatchGetCommand, GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
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
function setup(options: {
  memory?: string;
  memoryLabel?: 'MACHINE' | 'HUMAN';
  memoryGlossaryVersion?: number;
  glossaryTerms?: Array<Record<string, any>>;
  /** Chia glossaryTerms thành nhiều trang Query (LastEvaluatedKey) để kiểm thử phân trang */
  glossaryPageSize?: number;
  /** terminologyName đã đồng bộ trong CONFIG (mặc định: chưa đồng bộ) */
  configTerminologyName?: string;
  glossaryQueryFails?: boolean;
  getGlossaryState?: (ctx: any) => Promise<any>;
  locked?: boolean;
  quotaExceeded?: boolean;
  tmWriteFails?: boolean;
  keymapTenantId?: string;
  detected?: { language?: string; confidence?: number };
  translateErrorName?: string;
  translateConcurrency?: number;
} = {}) {
  const calls: Array<{ name: string; input: Record<string, any> }> = [];
  const stored: Array<Record<string, any>> = [];
  const translateInputs: Array<Record<string, any>> = [];
  const reservationInputs: Array<{ n: number }> = [];
  const settlements: Array<Record<string, any>> = [];
  let translateCalls = 0;
  let refunds = 0;
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
        return {
          Item: {
            status: options.locked ? 'LOCKED' : 'ACTIVE',
            charLimit: 50_000,
            glossaryVersion: 7,
            ...(options.configTerminologyName ? { terminologyName: options.configTerminologyName } : {}),
          },
        };
      }
      if (command instanceof QueryCommand) {
        if (options.glossaryQueryFails) throw Object.assign(new Error('DynamoDB query failed'), { name: 'ThrottlingException' });
        const all = options.glossaryTerms ?? [];
        const size = options.glossaryPageSize;
        if (!size) return { Items: all };
        const start = Number((input.ExclusiveStartKey as { offset?: number } | undefined)?.offset ?? 0);
        const next = start + size;
        return {
          Items: all.slice(start, next),
          ...(next < all.length ? { LastEvaluatedKey: { offset: next } } : {}),
        };
      }
      if (command instanceof BatchGetCommand) {
        const keys = input.RequestItems[TABLE].Keys as Array<{ PK: string; SK: string }>;
        const rows = keys.flatMap((key) => {
          const found = stored.find((item) => item.PK === key.PK && item.SK === key.SK);
          if (found) return [found];
          if (options.memory) {
            return [{
              ...key,
              tgt: options.memory,
              label: options.memoryLabel ?? 'HUMAN',
              glossaryVersion: options.memoryGlossaryVersion ?? 7,
            }];
          }
          return [];
        });
        return { Responses: { [TABLE]: rows } };
      }
      if (command instanceof UpdateCommand) {
        if (options.tmWriteFails) throw Object.assign(new Error('DynamoDB throttled'), { name: 'ThrottlingException' });
        const key = input.Key as { PK: string; SK: string };
        const names = input.ExpressionAttributeNames as Record<string, string>;
        const values = input.ExpressionAttributeValues as Record<string, unknown>;
        const existingIndex = stored.findIndex((row) => row.PK === key.PK && row.SK === key.SK);
        const item = existingIndex >= 0 ? stored[existingIndex] : {
          ...key,
          ...(options.memory ? { tgt: options.memory, label: options.memoryLabel ?? 'HUMAN', glossaryVersion: options.memoryGlossaryVersion ?? 7 } : {}),
        };
        if (values[':human'] !== undefined) {
          if (item.label !== 'HUMAN' || item.tgt !== values[':tgt'] || item.needsReview === true) {
            throw Object.assign(new Error('ConditionalCheckFailed'), { name: 'ConditionalCheckFailedException' });
          }
          item.needsReview = true;
          item.GSI3PK = values[':g3pk'];
          item.GSI3SK = item.GSI3SK ?? values[':at'];
          if (existingIndex < 0) stored.push(item);
          return {};
        }
        if (item.label === 'HUMAN') {
          throw Object.assign(new Error('Human TM entries cannot be overwritten'), { name: 'ConditionalCheckFailedException' });
        }
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
    async refund(_ticket: unknown) { refunds++; },
  };
  const translate = {
    async send(command: any) {
      translateCalls++;
      const input = command.input as Record<string, any>;
      translateInputs.push(input);
      if (options.translateErrorName) throw Object.assign(new Error('Translate failed'), { name: options.translateErrorName });
      const text = String(input.Text);
      return { TranslatedText: text.replace(/(<[^>]+>)|([^<]+)/g, (_all, tag: string | undefined, plain: string | undefined) => tag ?? (plain ?? '').toUpperCase()) };
    },
  };
  const deps = {
    tableName: TABLE,
    ddb: ddb as unknown as RealtimeDeps['ddb'],
    usage: usage as unknown as RealtimeDeps['usage'],
    translate,
    translateConcurrency: options.translateConcurrency,
    getGlossaryState: options.getGlossaryState,
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
    get refunds() { return refunds; },
  };
}

/** Giải mã JSON trong phản hồi để kiểm tra schema API. */
function responseBody(response: { body: string }) {
  return JSON.parse(response.body) as Record<string, any>;
}

describe('POST /translate/realtime', () => {
  it('surfaces Translate throttling and refunds the failed request', async () => {
    const test = setup({ translateErrorName: 'ThrottlingException', translateConcurrency: 2 });
    const response = await test.handler(event({ text: 'Xin chào.', source_lang: 'vi', target_lang: 'en' }));
    assert.equal(response.statusCode, 503);
    assert.equal(responseBody(response).error.code, 'TRANSLATE_THROTTLED');
    assert.equal(test.translateCalls, 1);
    assert.equal(test.refunds, 1);
  });

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

  it('coi bản MACHINE lỗi thời theo sinceVersion là trượt, dịch lại và hậu kiểm thuật ngữ gắn Cần xem lại (3.9)', async () => {
    const test = setup({
      memory: 'Near the old town.',
      memoryLabel: 'MACHINE',
      memoryGlossaryVersion: 2,
      glossaryTerms: [
        {
          PK: `TENANT#${TENANT}#GLOSS`,
          SK: 'TERM#phố cổ hội an',
          normalized: 'phố cổ hội an',
          sourceTerm: 'phố cổ Hội An',
          type: 'FIXED',
          translations: { en: 'Hoi An Ancient Town' },
          sinceVersion: 5,
        },
      ],
    });
    const sentence = 'Gần phố cổ Hội An.';
    const response = await test.handler(event({ text: sentence, source_lang: 'vi', target_lang: 'en' }));
    const body = responseBody(response);

    assert.equal(response.statusCode, 200);
    assert.equal(test.translateCalls, 1, 'bản MACHINE cũ phải bị dịch lại');
    assert.equal(body.characters_machine_translated, sentence.length);
    assert.equal(body.characters_from_memory, 0);
    assert.equal(test.stored[0].needsReview, true, 'hậu kiểm phát hiện thiếu Hoi An Ancient Town -> needsReview = true');
    assert.equal(test.stored[0].GSI3PK, `TENANT#${TENANT}#TM#REVIEW`);
  });

  it('tenant chưa đồng bộ Custom Terminology vẫn dịch được và không gửi tên terminology (3.9)', async () => {
    const test = setup();
    const response = await test.handler(event({ text: 'Xin chào.', source_lang: 'vi', target_lang: 'en' }));

    assert.equal(response.statusCode, 200);
    assert.equal(responseBody(response).translated_text, 'XIN CHÀO.');
    assert.equal(test.translateCalls, 1);
    assert.equal(test.translateInputs[0].TerminologyNames, undefined, 'không được gửi tm-<tenantId> dự phòng');
  });

  it('có thuật ngữ hiệu lực và CONFIG đã đồng bộ terminologyName thì gửi đúng tên đó (3.9)', async () => {
    const test = setup({
      configTerminologyName: 'tm-t_test',
      glossaryTerms: [
        { SK: 'TERM#homestay abc', normalized: 'homestay abc', sourceTerm: 'Homestay ABC', type: 'KEEP', sinceVersion: 1 },
      ],
    });
    const response = await test.handler(event({ text: 'Xin chào.', source_lang: 'vi', target_lang: 'en' }));

    assert.equal(response.statusCode, 200);
    assert.deepEqual(test.translateInputs[0].TerminologyNames, ['tm-t_test']);
  });

  it('fallback đọc Glossary phân trang theo LastEvaluatedKey, không bỏ sót thuật ngữ (3.9)', async () => {
    const terms = ['a', 'b', 'c'].map((word, index) => ({
      SK: `TERM#${word}`,
      normalized: word,
      sourceTerm: word,
      type: 'FIXED',
      translations: { en: `T-${word}` },
      sinceVersion: 3 + index,
    }));
    const test = setup({ glossaryTerms: terms, glossaryPageSize: 1, memory: 'Old.', memoryLabel: 'MACHINE', memoryGlossaryVersion: 2 });
    // Câu chỉ chứa thuật ngữ nằm ở trang Query cuối cùng (c) -> bản MACHINE cũ phải bị coi lỗi thời và dịch lại
    const response = await test.handler(event({ text: 'Xin c.', source_lang: 'vi', target_lang: 'en' }));

    assert.equal(response.statusCode, 200);
    assert.equal(test.calls.filter((call) => call.name === 'QueryCommand').length, 3, 'phải đọc đủ 3 trang');
    assert.equal(test.translateCalls, 1, 'thuật ngữ ở trang cuối được nhận ra nên dịch lại');
  });

  it('giữ nguyên bản HUMAN khi thuật ngữ đổi nhưng gắn nhãn Cần xem lại khi tra (3.9)', async () => {
    const test = setup({
      memory: 'Near the old quarter.',
      memoryLabel: 'HUMAN',
      memoryGlossaryVersion: 2,
      glossaryTerms: [
        {
          PK: `TENANT#${TENANT}#GLOSS`,
          SK: 'TERM#phố cổ hội an',
          normalized: 'phố cổ hội an',
          sourceTerm: 'phố cổ Hội An',
          type: 'FIXED',
          translations: { en: 'Hoi An Ancient Town' },
          sinceVersion: 5,
        },
      ],
    });
    const sentence = 'Gần phố cổ Hội An.';
    const response = await test.handler(event({ text: sentence, source_lang: 'vi', target_lang: 'en' }));
    const body = responseBody(response);

    assert.equal(response.statusCode, 200);
    assert.equal(body.translated_text, 'Near the old quarter.');
    assert.equal(test.translateCalls, 0, 'bản HUMAN vẫn được dùng ngay');
    assert.equal(test.stored[0].label, 'HUMAN');
    assert.equal(test.stored[0].needsReview, true);
    assert.equal(test.stored[0].GSI3PK, `TENANT#${TENANT}#TM#REVIEW`);
  });

  it('lỗi đọc Glossary trong fallback -> trả 500 và không lưu TM entry tươi (3.9)', async () => {
    const test = setup({
      glossaryQueryFails: true,
      glossaryTerms: [
        { SK: 'TERM#hội an', normalized: 'hội an', sourceTerm: 'Hội An', type: 'KEEP', sinceVersion: 1 },
      ],
    });
    const response = await test.handler(event({ text: 'Xin chào Hội An.', source_lang: 'vi', target_lang: 'en' }));
    const body = responseBody(response);

    assert.equal(response.statusCode, 500);
    assert.equal(body.error.code, 'INTERNAL_ERROR');
    assert.equal(test.translateCalls, 0, 'không được gọi Translate khi đọc Glossary lỗi');
    assert.equal(test.stored.length, 0, 'không được tạo bản ghi TM mới');
    assert.equal(test.calls.some((call) => call.name === 'UpdateCommand'), false, 'không được gọi UpdateCommand ghi TM');
  });

  it('deps.getGlossaryState ném lỗi -> trả 500 và không lưu TM entry tươi (3.9)', async () => {
    const test = setup({
      getGlossaryState: async () => {
        throw new Error('Glossary reader timeout');
      },
    });
    const response = await test.handler(event({ text: 'Xin chào Hội An.', source_lang: 'vi', target_lang: 'en' }));
    const body = responseBody(response);

    assert.equal(response.statusCode, 500);
    assert.equal(body.error.code, 'INTERNAL_ERROR');
    assert.equal(test.translateCalls, 0, 'không được gọi Translate khi getGlossaryState lỗi');
    assert.equal(test.stored.length, 0, 'không được tạo bản ghi TM mới');
    assert.equal(test.calls.some((call) => call.name === 'UpdateCommand'), false, 'không được gọi UpdateCommand ghi TM');
  });

  it('từ chối vai trò REVIEWER khi gọi qua JWT session (PERMISSION_DENIED)', async () => {
    const test = setup();
    const response = await test.handler({
      body: JSON.stringify({ text: 'Xin chào.', target_lang: 'en' }),
      requestContext: {
        requestId: 'req-reviewer-01',
        authorizer: {
          claims: {
            sub: 'sub-reviewer-1',
            'custom:tenant_id': TENANT,
            'custom:role': 'REVIEWER',
          },
        },
      },
    });
    const body = responseBody(response);
    assert.equal(response.statusCode, 403);
    assert.equal(body.error.code, 'PERMISSION_DENIED');
  });
});
