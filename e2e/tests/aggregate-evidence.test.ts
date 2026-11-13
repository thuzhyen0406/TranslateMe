import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseSafeRunId } from '../lib/evidenceRunId';

test('aggregator rejects unsafe IDs from TM_RUN_ID fallback', () => {
  assert.throws(
    () => chooseSafeRunId(undefined, undefined, '../../../../tmp'),
    /Run ID không an toàn/u,
  );
});

test('aggregator validates the selected ID regardless of its source', () => {
  assert.throws(() => chooseSafeRunId('../outside', undefined, undefined), /Run ID không an toàn/u);
  assert.throws(() => chooseSafeRunId(undefined, undefined, '..'), /Run ID không an toàn/u);
  assert.equal(chooseSafeRunId(undefined, 'run-123', '../../../../tmp'), 'run-123');
  assert.equal(chooseSafeRunId(undefined, undefined, 'run-456'), 'run-456');
});
