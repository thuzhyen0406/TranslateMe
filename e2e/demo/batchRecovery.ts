import { aws } from './aws';

const need = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Thiếu biến môi trường ${name}; không thể đối soát batch chưa rõ kết quả.`);
  return value;
};

export function findBatchJobByFileKey(tenantId: string, fileKey: string, region: string[] = []): string | undefined {
  const response = aws([
    'dynamodb', 'query', '--table-name', need('TM_TABLE'),
    '--key-condition-expression', 'PK = :pk',
    '--filter-expression', 'fileKey = :fileKey AND #type = :type',
    '--expression-attribute-names', JSON.stringify({ '#type': 'type' }),
    '--expression-attribute-values', JSON.stringify({
      ':pk': { S: `TENANT#${tenantId}#JOB` },
      ':fileKey': { S: fileKey },
      ':type': { S: 'FILE' },
    }),
    '--consistent-read', ...region,
  ], { readonly: true });
  const matches = (response.Items ?? []).filter((item: any) =>
    item?.fileKey?.S === fileKey && item?.type?.S === 'FILE');
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

export async function recoverBatchJob(
  tenantId: string,
  fileKey: string,
  options: { region?: string[]; waitSeconds?: number } = {},
): Promise<string | undefined> {
  const waitSeconds = options.waitSeconds ?? Number(process.env.TM_BATCH_RECOVERY_WAIT_S ?? '35');
  if (!Number.isFinite(waitSeconds) || waitSeconds < 0 || waitSeconds > 300) {
    throw new Error('TM_BATCH_RECOVERY_WAIT_S phải nằm trong khoảng 0–300 giây.');
  }
  const deadline = Date.now() + waitSeconds * 1000;
  do {
    const found = findBatchJobByFileKey(tenantId, fileKey, options.region);
    if (found) return found;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000, deadline - Date.now())));
  } while (true);
  return undefined;
}
