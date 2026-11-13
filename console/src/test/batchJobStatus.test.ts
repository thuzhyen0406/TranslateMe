import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { batchNotificationLabel, shouldPollBatchJob } from '../services/batchJobStatus.js';

describe('batch job notification status', () => {
  it('continues polling after translation completes until notification is recorded', () => {
    assert.equal(shouldPollBatchJob('SUCCEEDED', true, 'PENDING'), true);
    assert.equal(shouldPollBatchJob('SUCCEEDED', true, undefined), true);
    assert.equal(shouldPollBatchJob('SUCCEEDED', true, 'SUBMITTED'), false);
    assert.equal(shouldPollBatchJob('FAILED', true, 'FAILED'), false);
    assert.equal(shouldPollBatchJob('SUCCEEDED', false, undefined), false);
  });

  it('describes notification submission and failure accurately', () => {
    assert.equal(batchNotificationLabel(true, 'PENDING', undefined), 'Email đang chờ gửi');
    assert.equal(batchNotificationLabel(true, 'SUBMITTED', undefined), 'SNS đã nhận yêu cầu gửi email');
    assert.equal(batchNotificationLabel(true, 'FAILED', 'EMAIL_NOT_CONFIRMED'), 'Gửi email thất bại: EMAIL_NOT_CONFIRMED');
    assert.equal(batchNotificationLabel(false, undefined, undefined), undefined);
  });
});
