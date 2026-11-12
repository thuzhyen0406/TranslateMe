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

  it('stops after a rejected batch and retries only failed plus unattempted paths', async () => {
    let createCalls = 0;
    const firstAttemptPaths: string[][] = [];
    const invalidate = createSiteInvalidatorSubmitOnly({
      cdn: {
        async createInvalidation(request) {
          createCalls += 1;
          firstAttemptPaths.push(request.paths);
          if (createCalls === 2) throw Object.assign(new Error('quota full'), { name: 'TooManyInvalidationsInProgress' });
          return { id: `invalidation-${createCalls}` };
        },
        async getInvalidation(id) {
          return { id, status: 'Completed', callerReference: '', paths: [] };
        },
      },
      uuid: () => `attempt-${createCalls}`,
    });
    const result = await invalidate(ctx, { slugs: Array.from({ length: 31 }, (_, index) => `site-${index}`) });

    assert.equal(result.status, 'PARTIAL');
    assert.equal(createCalls, 2, 'do not submit another batch after quota rejects one');
    assert.deepEqual(result.failedPaths, result.paths.slice(15));
    assert.equal(result.invalidationIds?.length, 1);

    const retryPaths: string[][] = [];
    const retry = createSiteInvalidatorSubmitOnly({
      cdn: {
        async createInvalidation(request) {
          retryPaths.push(request.paths);
          return { id: 'invalidation-retry' };
        },
        async getInvalidation(id) {
          return { id, status: 'Completed', callerReference: '', paths: [] };
        },
      },
      uuid: () => 'retry',
    });
    await retry(ctx, { slugs: result.failedPaths!.map((path) => path.slice(1, -2)) });
    assert.deepEqual(retryPaths.flat(), result.failedPaths);
    assert.equal(retryPaths.flat().some((path) => firstAttemptPaths[0].includes(path)), false);
  });
});
