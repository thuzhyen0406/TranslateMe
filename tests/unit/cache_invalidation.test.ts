import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createEdgeCacheInvalidator,
  type CloudFrontInvalidationClient,
} from '../../libs/common/cacheInvalidation.js';
import type { Ctx } from '../../libs/common/types.js';

const ctx: Ctx = { tenantId: 'tenant-test', via: 'JWT', requestId: 'request-test' };

function fakeCloudFront(send: CloudFrontInvalidationClient['send']) {
  return { send } satisfies CloudFrontInvalidationClient;
}

describe('invalidateEdgeCache', () => {
  it('gửi đúng pattern /{slug}/{lang}/* tới CloudFront', async () => {
    let submitted: Parameters<CloudFrontInvalidationClient['send']>[0]['input'] | undefined;
    const invalidate = createEdgeCacheInvalidator(fakeCloudFront(async (command) => {
      submitted = command.input;
      return { Invalidation: { Id: 'invalidation-1' } };
    }), 'distribution-test');

    await invalidate(ctx, { slug: 'hotel-demo', lang: 'en', path: '*' });

    assert.deepEqual(submitted?.InvalidationBatch?.Paths?.Items, ['/hotel-demo/en/*']);
  });

  it('tạo CallerReference riêng cho mỗi yêu cầu', async () => {
    const references: string[] = [];
    const invalidate = createEdgeCacheInvalidator(fakeCloudFront(async (command) => {
      references.push(command.input.InvalidationBatch?.CallerReference ?? '');
      return { Invalidation: { Id: `invalidation-${references.length}` } };
    }), 'distribution-test');

    await invalidate(ctx, { slug: 'hotel-demo', lang: 'en' });
    await invalidate(ctx, { slug: 'hotel-demo', lang: 'en' });

    assert.equal(references.length, 2);
    assert.ok(references[0]);
    assert.notEqual(references[0], references[1]);
  });

  it('nuốt lỗi CloudFront để luồng ghi chính có thể tiếp tục', async () => {
    const invalidate = createEdgeCacheInvalidator(fakeCloudFront(async () => {
      throw Object.assign(new Error('Rate exceeded'), { name: 'Throttling' });
    }), 'distribution-test');

    await assert.doesNotReject(async () => {
      assert.equal(await invalidate(ctx, { slug: 'hotel-demo' }), undefined);
    });
  });
});
