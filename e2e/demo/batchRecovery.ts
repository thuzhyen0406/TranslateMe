import { aws } from './aws';

// Keep in sync with TranslateFunction.Timeout in infra/modules/lambdas.yaml (60s)
// plus a 30s margin for Lambda completion and DynamoDB visibility.
export const MIN_BATCH_RECOVERY_WAIT_SECONDS = 90;
const MAX_BATCH_RECOVERY_WAIT_SECONDS = 1200;
const MAX_BATCH_RECOVERY_POLL_INTERVAL_MS = 10_000;

export function batchRecoveryPollDelayMs(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 0) throw new Error('Số lần dò batch phải là số nguyên không âm.');
  return Math.min(1000 * (2 ** attempt), MAX_BATCH_RECOVERY_POLL_INTERVAL_MS);
}

const need = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Thiếu biến môi trường ${name}; không thể đối soát batch chưa rõ kết quả.`);
  return value;
};

export function findBatchJobByFileKey(tenantId: string, fileKey: string, region: string[] = []): string | undefined {
  const matches: any[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const args = [
      'dynamodb', 'query', '--table-name', need('TM_TABLE'),
      '--key-condition-expression', 'PK = :pk',
      '--filter-expression', 'fileKey = :fileKey AND #type = :type',
      '--expression-attribute-names', JSON.stringify({ '#type': 'type' }),
      '--expression-attribute-values', JSON.stringify({
        ':pk': { S: `TENANT#${tenantId}#JOB` },
        ':fileKey': { S: fileKey },
        ':type': { S: 'FILE' },
      }),
      '--consistent-read',
      ...(exclusiveStartKey ? ['--exclusive-start-key', JSON.stringify(exclusiveStartKey)] : []),
      ...region,
    ];
    const response = aws(args, { readonly: true });
    matches.push(...(response.Items ?? []).filter((item: any) =>
      item?.fileKey?.S === fileKey && item?.type?.S === 'FILE'));
    exclusiveStartKey = response.LastEvaluatedKey;
  } while (exclusiveStartKey && Object.keys(exclusiveStartKey).length > 0);

  if (matches.length > 1) {
    throw new Error(`Tìm thấy nhiều batch job cùng fileKey ${fileKey}; cần đối soát thủ công, không gửi lại.`);
  }
  if (!matches.length) return undefined;
  const item = matches[0];
  const jobId = item.jobId?.S ?? (typeof item.SK?.S === 'string' ? item.SK.S.replace(/^JOB#/u, '') : undefined);
  if (typeof jobId !== 'string' || !jobId) {
    throw new Error(`Tìm thấy batch job cho ${fileKey} nhưng thiếu jobId; cần đối soát thủ công.`);
  }
  return jobId;
}

export function batchRecoveryWaitSeconds(raw = process.env.TM_BATCH_RECOVERY_WAIT_S): number {
  const waitSeconds = Number(raw ?? String(MIN_BATCH_RECOVERY_WAIT_SECONDS));
  if (!Number.isFinite(waitSeconds) || waitSeconds < MIN_BATCH_RECOVERY_WAIT_SECONDS || waitSeconds > MAX_BATCH_RECOVERY_WAIT_SECONDS) {
    throw new Error(`TM_BATCH_RECOVERY_WAIT_S phải nằm trong khoảng ${MIN_BATCH_RECOVERY_WAIT_SECONDS}–${MAX_BATCH_RECOVERY_WAIT_SECONDS} giây; không được ngắn hơn timeout Lambda cộng khoảng đệm.`);
  }
  return waitSeconds;
}

export async function recoverBatchJob(tenantId: string, fileKey: string, region: string[] = []): Promise<string | undefined> {
  const waitSeconds = batchRecoveryWaitSeconds();
  const deadline = Date.now() + waitSeconds * 1000;
  let attempt = 0;
  do {
    const found = findBatchJobByFileKey(tenantId, fileKey, region);
    if (found) return found;
    if (Date.now() >= deadline) break;
    const delayMs = Math.min(batchRecoveryPollDelayMs(attempt), deadline - Date.now());
    attempt++;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  } while (true);
  return undefined;
}
