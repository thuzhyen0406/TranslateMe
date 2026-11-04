import { randomUUID } from 'node:crypto';
import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import type { Ctx } from './types.js';

const DISTRIBUTION_ID = process.env.CLOUDFRONT_DISTRIBUTION_ID;

export interface CloudFrontInvalidationClient {
  send(command: CreateInvalidationCommand): Promise<{ Invalidation?: { Id?: string } }>;
}

export interface InvalidateCacheOptions {
  slug: string;
  /** Omit to invalidate every language under this website. */
  lang?: string;
  /** CloudFront path below the slug/language prefix; defaults to '*'. */
  path?: string;
}

function log(level: 'info' | 'warn' | 'error', fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ level: level.toUpperCase(), ...fields }));
}

function normalizeSegment(value: string, name: string): string {
  const segment = value.trim().replace(/^\/+|\/+$/g, '');
  if (!segment || segment === '.' || segment === '..' || /[?#]/.test(segment)) {
    throw new TypeError(`Invalid CloudFront invalidation ${name}`);
  }
  return segment;
}

/** Submit a narrowly scoped CloudFront invalidation. Failures are logged and returned as undefined. */
export function createEdgeCacheInvalidator(
  client: CloudFrontInvalidationClient,
  distributionId: string | undefined,
): (ctx: Ctx, options: InvalidateCacheOptions) => Promise<string | undefined> {
  return async (ctx, options) => {
    if (!distributionId) {
      log('warn', {
        step: 'cache_invalidation',
        tenantId: ctx.tenantId,
        message: 'CLOUDFRONT_DISTRIBUTION_ID is not set',
      });
      return undefined;
    }

    let invalidationPath: string;
    try {
      const slug = normalizeSegment(options.slug, 'slug');
      if (!options.lang) {
        invalidationPath = `/${slug}/*`;
      } else {
        const lang = normalizeSegment(options.lang, 'language');
        const path = (options.path ?? '*').trim().replace(/^\/+/, '');
        if (!path || path.includes('?') || path.includes('#')) {
          throw new TypeError('Invalid CloudFront invalidation path');
        }
        invalidationPath = `/${slug}/${lang}/${path}`;
      }
    } catch (error) {
      log('error', {
        step: 'cache_invalidation_failed',
        tenantId: ctx.tenantId,
        error: error instanceof Error ? error.message : 'Invalid invalidation options',
      });
      return undefined;
    }

    try {
      const response = await client.send(new CreateInvalidationCommand({
        DistributionId: distributionId,
        InvalidationBatch: {
          CallerReference: `inv-${ctx.tenantId}-${randomUUID()}`,
          Paths: { Quantity: 1, Items: [invalidationPath] },
        },
      }));

      log('info', {
        step: 'cache_invalidation_success',
        tenantId: ctx.tenantId,
        invalidationId: response.Invalidation?.Id,
        path: invalidationPath,
      });
      return response.Invalidation?.Id;
    } catch (error) {
      log('error', {
        step: 'cache_invalidation_failed',
        tenantId: ctx.tenantId,
        error: error instanceof Error ? error.message : 'CloudFront invalidation failed',
        path: invalidationPath,
      });
      return undefined;
    }
  };
}

const cloudfront = new CloudFrontClient({});
export const invalidateEdgeCache = createEdgeCacheInvalidator(cloudfront, DISTRIBUTION_ID);
