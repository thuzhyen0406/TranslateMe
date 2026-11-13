export type BatchNotificationStatus = 'PENDING' | 'SUBMITTED' | 'FAILED';

export function shouldPollBatchJob(
  status: string,
  sendEmail: boolean | undefined,
  notificationStatus: BatchNotificationStatus | undefined,
): boolean {
  return status === 'QUEUED' || status === 'RUNNING' ||
    (sendEmail === true && notificationStatus !== 'SUBMITTED' && notificationStatus !== 'FAILED');
}

export function batchNotificationLabel(
  sendEmail: boolean | undefined,
  status: BatchNotificationStatus | undefined,
  error: string | undefined,
): string | undefined {
  if (!sendEmail) return undefined;
  if (status === 'SUBMITTED') return 'SNS đã nhận yêu cầu gửi email';
  if (status === 'FAILED') return error ? `Gửi email thất bại: ${error}` : 'Gửi email thất bại';
  return 'Email đang chờ gửi';
}
