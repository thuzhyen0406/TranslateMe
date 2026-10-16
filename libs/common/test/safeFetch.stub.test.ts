import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { STUB_HTML, safe_fetch } from '../safeFetch.stub.js';

describe('safe_fetch STUB (không gọi mạng)', () => {
  it('URL hợp lệ -> trả HTML cố định', async () => {
    const r = await safe_fetch('https://customer.example/page');
    assert.equal(r.status, 200);
    assert.equal(r.isHtml, true);
    assert.equal(r.body, STUB_HTML);
    assert.equal(r.finalUrl, 'https://customer.example/page');
    assert.equal(r.outcome.kind, 'OK');
  });

  it('IP nội bộ / cổng lạ vẫn bị chặn như bản thật', async () => {
    for (const u of ['http://169.254.169.254/', 'http://[::1]/', 'http://example.test:22/', 'file:///etc/passwd']) {
      const r = await safe_fetch(u);
      assert.equal(r.outcome.kind, 'BLOCKED', u);
      assert.equal(r.status, 0);
    }
  });
});
