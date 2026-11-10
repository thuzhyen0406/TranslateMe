import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { callerReferencePrefix, createSiteInvalidatorSubmitOnly } from '../../libs/common/invalidation.js';
import type { Ctx } from '../../libs/common/types.js';

const ctx: Ctx = { tenantId: 'tenant-test', via: 'JWT', requestId: 'request-test' };

describe('shared site invalidation contract', () => {
  it('uses the tenant tracking prefix and submits wildcard paths in bounded batches', async () => {
    const submitted: Array<{ callerReference: string; paths: string[] }> = [];
    let completionPolls = 0;
    const invalidate = createSiteInvalidatorSubmitOnly({
      cdn: {
        async createInvalidation(request) {
          submitted.push(request);
          return { id: `invalidation-${submitted.length}` };
        },
        async getInvalidation(id) {
          completionPolls += 1;
          return { id, status: 'Completed', callerReference: '', paths: [] };
        },
      },
      uuid: () => 'uuid-test',
    });

    const result = await invalidate(ctx, {
      slugs: Array.from({ length: 17 }, (_, index) => `site-${index}`),
    });

    assert.equal(submitted.length, 2);
    assert.equal(submitted[0].paths.length, 15);
    assert.equal(submitted[1].paths.length, 2);
    assert.ok(submitted.every(({ callerReference }) => callerReference.startsWith(callerReferencePrefix(ctx.tenantId))));
    assert.equal(result.invalidationIds?.length, 2);
    assert.equal(completionPolls, 0, 'submission returns without polling CloudFront completion');
  });
});
