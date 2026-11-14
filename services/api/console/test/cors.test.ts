import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CORS_HEADERS, withCors } from '../../../../libs/common/cors.js';
import { handler as consoleHandler } from '../handler.js';
import { handler as websiteHandler } from '../../sites/handler.js';

describe('CORS cho Lambda được Web Console gọi từ origin khác', () => {
  it('withCors thêm header CORS, giữ nguyên header và nội dung handler tự đặt', async () => {
    const wrapped = withCors(async (_e: unknown) => ({
      statusCode: 201,
      headers: { 'content-type': 'application/json', 'Access-Control-Allow-Origin': 'https://riêng.example' },
      body: '{"ok":true}',
    }));
    const res = await wrapped({});
    const headers = res.headers as Record<string, string>;
    assert.equal(res.statusCode, 201);
    assert.equal(res.body, '{"ok":true}');
    assert.equal(headers['content-type'], 'application/json');
    assert.equal(headers['Access-Control-Allow-Origin'], 'https://riêng.example');
    assert.equal(headers['access-control-allow-origin'], undefined, 'không thêm trùng khi đã có (không phân biệt hoa thường)');
    assert.equal(headers['access-control-allow-methods'], CORS_HEADERS['access-control-allow-methods']);
  });

  it('Điểm vào Lambda console và website trả header CORS cả khi lỗi xác thực', async () => {
    for (const h of [consoleHandler, websiteHandler] as Array<(e: any) => Promise<any>>) {
      const res = await h({ httpMethod: 'GET', path: '/console/me', requestContext: { requestId: 'r-cors' } });
      assert.ok(res.statusCode >= 400, `mong đợi lỗi khi thiếu claims, nhận ${res.statusCode}`);
      assert.equal(res.headers['access-control-allow-origin'], '*');
      assert.match(res.headers['access-control-allow-headers'], /Authorization/);
      assert.match(res.headers['access-control-allow-methods'], /PUT/);
    }
  });
});
