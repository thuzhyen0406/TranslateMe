import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { record } from '../lib/evidence';
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

test('evidence writer rejects unsafe TM_RUN_ID before creating output files', () => {
  const evidenceRoot = resolve(__dirname, '..', 'evidence');
  const targetDir = join(tmpdir(), `translateme-evidence-writer-${process.pid}-${Date.now()}`);
  const unsafeRunId = relative(evidenceRoot, targetDir);
  assert.equal(resolve(evidenceRoot, unsafeRunId), targetDir);
  const previousRunId = process.env.TM_RUN_ID;
  rmSync(targetDir, { recursive: true, force: true });

  try {
    process.env.TM_RUN_ID = unsafeRunId;
    assert.throws(() => record(4, 'P1', 'unsafe path test', 'pass'), /Run ID không an toàn/u);
    assert.equal(existsSync(targetDir), false);
  } finally {
    if (previousRunId === undefined) delete process.env.TM_RUN_ID;
    else process.env.TM_RUN_ID = previousRunId;
    rmSync(targetDir, { recursive: true, force: true });
  }
});
