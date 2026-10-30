import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chunk_by_bytes, normalize_hash } from '../text-utils.js';

describe('normalize_hash', () => {
  it('normalizes Unicode to NFC and collapses whitespace', () => {
    const result = normalize_hash('  Cafe\u0301 \n\t au   lait  ');

    assert.equal(result.normalizedText, 'Café au lait');
    assert.equal(result.hash, '793e7643ce558259f6fe71f9ecaaf268acbcd011a2bb4c7f561df05a133d4d08');
  });

  it('returns a SHA-256 hex digest for an empty string', () => {
    const result = normalize_hash(' \n\t ');

    assert.deepEqual(result, {
      normalizedText: '',
      hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    });
  });
});

describe('chunk_by_bytes', () => {
  it('groups sentences without exceeding the UTF-8 byte limit', () => {
    assert.deepEqual(chunk_by_bytes(['one', 'two', 'three'], 7), [
      ['one', 'two'],
      ['three'],
    ]);
  });

  it('normalizes whitespace and skips empty sentences', () => {
    assert.deepEqual(chunk_by_bytes(['  one \n two ', ' ', '\tthree\t'], 20), [
      ['one two', 'three'],
    ]);
  });

  it('splits long sentences at a whitespace boundary when possible', () => {
    assert.deepEqual(chunk_by_bytes(['one two three'], 8), [
      ['one two'],
      ['three'],
    ]);
  });

  it('splits long unbroken text without exceeding the byte limit', () => {
    assert.deepEqual(chunk_by_bytes(['abcdefgh'], 3), [
      ['abc', 'def', 'gh'],
    ]);
  });

  it('counts UTF-8 bytes and never splits a Unicode code point', () => {
    assert.deepEqual(chunk_by_bytes(['😊😊'], 4), [['😊'], ['😊']]);
    assert.deepEqual(chunk_by_bytes(['éé'], 2), [['é'], ['é']]);
  });

  it('uses the default 10000-byte limit', () => {
    const chunks = chunk_by_bytes(['a'.repeat(10_001)]);

    assert.equal(chunks.length, 2);
    assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk.join(' '), 'utf8') <= 10_000));
  });

  it('rejects invalid byte limits', () => {
    for (const maxBytes of [0, -1, 1.5, Number.NaN]) {
      assert.throws(() => chunk_by_bytes(['text'], maxBytes), RangeError);
    }
  });

  it('rejects a limit too small for one Unicode code point', () => {
    assert.throws(() => chunk_by_bytes(['😊'], 3), RangeError);
  });
});
