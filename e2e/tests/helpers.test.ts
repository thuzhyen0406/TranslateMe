import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { lookalike } from '../lib/compare';
import { B, hashSentence, keyIdOf, keyValueOf } from '../lib/contract';

describe('E2E contract helpers', () => {
  it('hashSentence gộp whitespace như normalize_hash của sản phẩm', () => {
    assert.equal(hashSentence('  câu\t thử\nnghiệm  '), hashSentence('câu thử nghiệm'));
  });

  it('lookalike giữ định dạng từng ký tự và luôn khác ID hợp lệ', () => {
    const original = 'job-20261112-a1b2c3';
    const fake = lookalike(original);
    assert.notEqual(fake, original);
    assert.equal(fake.length, original.length);
    for (let i = 0; i < original.length; i++) {
      if (/\d/.test(original[i])) assert.match(fake[i], /\d/);
      else if (/[a-z]/.test(original[i])) assert.match(fake[i], /[a-z]/);
      else assert.equal(fake[i], original[i]);
    }
  });

  it('lookalike từ chối chuỗi không có ký tự thay thế được', () => {
    assert.throws(() => lookalike('---'), /không có ký tự chữ\/số/);
  });

  it('tạo API key theo contract yêu cầu plan và đọc response dạng api_key lồng nhau', () => {
    assert.deepEqual(B.createKey('e2e-A'), { name: 'e2e-A', plan: 'Basic' });
    assert.equal(keyIdOf({ api_key: { key_id: 'key-123', value: 'secret-value' } }), 'key-123');
    assert.equal(keyValueOf({ api_key: { key_id: 'key-123', value: 'secret-value' } }), 'secret-value');
  });
});
