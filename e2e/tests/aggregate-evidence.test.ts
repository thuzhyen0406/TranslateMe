import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { record } from '../lib/evidence';
import { chooseSafeRunId } from '../lib/evidenceRunId';

test('aggregator rejects unsafe IDs from TM_RUN_ID fallback', () => {
  assert.throws(
    () => chooseSafeRunId(undefined, undefined, '../../../../tmp'),
    /Run ID không an toàn/u,
  );
});

test('aggregator validates the selected ID regardless of its source', () => {
  assert.equal(chooseSafeRunId('cli-run', 'latest-run', 'env-run'), 'cli-run');
  assert.throws(() => chooseSafeRunId('../outside', undefined, undefined), /Run ID không an toàn/u);
  assert.throws(() => chooseSafeRunId(undefined, undefined, '..'), /Run ID không an toàn/u);
  assert.throws(() => chooseSafeRunId(undefined, 'run-123', '../../../../tmp'), /Run ID không an toàn/u);
  assert.equal(chooseSafeRunId(undefined, 'run-123', 'env-run'), 'env-run');
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

test('aggregator rejects missing or invalid timestamps instead of retaining an older pass', () => {
  const e2eRoot = resolve(__dirname, '..');
  const evidenceRoot = join(e2eRoot, 'evidence');
  const cases: Array<{ at?: string }> = [
    { at: 'not-a-timestamp' },
    {},
  ];

  for (const [index, badTimestamp] of cases.entries()) {
    const runId = `invalid-timestamp-${process.pid}-${Date.now()}-${index}`;
    const runDir = join(evidenceRoot, runId);
    mkdirSync(runDir, { recursive: true });
    const first = { ...(badTimestamp.at === undefined ? {} : { at: badTimestamp.at }), scenario: 5, id: 'L1', title: 'old pass', status: 'pass' };
    const later = { at: '2026-11-14T00:00:00.000Z', scenario: 5, id: 'L1', title: 'new failure', status: 'fail' };
    writeFileSync(join(runDir, 'scenario-5.jsonl'), `${JSON.stringify(first)}\n${JSON.stringify(later)}\n`, 'utf8');

    try {
      const result = spawnSync(process.execPath, [
        '--require', 'ts-node/register/transpile-only', 'tools/aggregate-evidence.ts', runId,
      ], { cwd: e2eRoot, encoding: 'utf8' });
      assert.notEqual(result.status, 0);
      assert.match(`${result.stderr}${result.stdout}`, /timestamp evidence thiếu hoặc không hợp lệ/u);
      assert.equal(existsSync(join(runDir, 'summary.md')), false);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  }
});

test('aggregator errors for an unknown run ID without creating an empty evidence directory', () => {
  const e2eRoot = resolve(__dirname, '..');
  const runId = `missing-run-${process.pid}-${Date.now()}`;
  const runDir = join(e2eRoot, 'evidence', runId);
  rmSync(runDir, { recursive: true, force: true });

  const result = spawnSync(process.execPath, [
    '--require', 'ts-node/register/transpile-only', 'tools/aggregate-evidence.ts', runId,
  ], { cwd: e2eRoot, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /Không tìm thấy thư mục evidence/u);
  assert.equal(existsSync(runDir), false);
});
