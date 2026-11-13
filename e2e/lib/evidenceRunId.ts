export const isSafeRunId = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(value) && value !== '.' && value !== '..';

export function chooseSafeRunId(
  cliRunId: string | undefined,
  latestExistingRunId: string | undefined,
  envRunId: string | undefined,
): string {
  const runId = cliRunId || envRunId || latestExistingRunId || 'local';
  if (!isSafeRunId(runId)) throw new Error(`Run ID không an toàn: ${runId}`);
  return runId;
}
