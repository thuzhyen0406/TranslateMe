import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createWebsiteHandler, type WebsiteHandlerDependencies } from '../handler.js';
import type { Ctx } from '../../../../libs/common/types.js';

const tenantCtx: Ctx = { tenantId: 't_aaaaaaaaaaaaaaaaaaaaaaaa', via: 'JWT', requestId: 'req-1', role: 'TENANT_ADMIN' };

function setup(overrides: Partial<WebsiteHandlerDependencies> = {}) {
  let createInput: Record<string, unknown> | undefined;
  const dependencies: WebsiteHandlerDependencies = {
    contextFromClaims: async () => tenantCtx,
    listTenantSites: async () => [{ slug: 'example', status: 'ACTIVE' }],
    getHost: async (_ctx, slug) => ({ slug, status: 'ACTIVE', homeUrl: 'https://example.test', displayName: 'Example' }),
    create: async (_ctx, input) => {
      createInput = input as unknown as Record<string, unknown>;
      return { slug: 'example' } as never;
    },
    pause: async () => ({ status: 'PAUSED' }) as never,
    resume: async () => ({ status: 'ACTIVE' }) as never,
    verify: async () => ({ status: 'ACTIVE' as const }),
    update: async () => ({ slug: 'example', status: 'ACTIVE' }) as never,
    ...overrides,
  };
  return { handler: createWebsiteHandler(dependencies), getCreateInput: () => createInput };
}

const claims = { sub: 'member-1', 'custom:tenant_id': tenantCtx.tenantId, 'custom:role': 'TENANT_ADMIN' };

describe('website HTTP handler', () => {
  it('chặn role khác Tenant Admin', async () => {
    const { handler } = setup({
      contextFromClaims: async () => ({ ...tenantCtx, role: 'DEVELOPER' }),
    });
    const response = await handler({ httpMethod: 'GET', path: '/console/hosts', requestContext: { authorizer: { claims } } });
    assert.equal(response.statusCode, 403);
    assert.equal(JSON.parse(response.body).error.code, 'PERMISSION_DENIED');
  });

  it('từ chối tenant_id do client gửi trong body', async () => {
    const { handler } = setup();
    const response = await handler({
      httpMethod: 'POST', path: '/console/hosts', body: JSON.stringify({ tenant_id: tenantCtx.tenantId }),
      requestContext: { authorizer: { claims } },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(JSON.parse(response.body).error.code, 'INVALID_REQUEST');
  });

  it('chuyển snake_case của Console sang createSite và trả host đầy đủ với 201', async () => {
    const { handler, getCreateInput } = setup();
    const response = await handler({
      httpMethod: 'POST', path: '/console/hosts', body: JSON.stringify({
        home_url: 'https://example.test', display_name: 'Example', source_lang: 'en', target_langs: ['fr'],
      }),
      requestContext: { authorizer: { claims } },
    });
    const body = JSON.parse(response.body);
    assert.equal(response.statusCode, 201);
    assert.deepEqual(getCreateInput(), {
      home_url: 'https://example.test', display_name: 'Example', source_lang: 'en', target_langs: ['fr'],
      homeUrl: 'https://example.test', displayName: 'Example', sourceLang: 'en', targetLangs: ['fr'],
    });
    assert.deepEqual(body.host, { slug: 'example', status: 'ACTIVE', homeUrl: 'https://example.test', displayName: 'Example' });
  });

  it('chuẩn hóa path có tiền tố stage khi liệt kê hosts', async () => {
    const { handler } = setup();
    const response = await handler({
      httpMethod: 'GET', path: '/dev/console/hosts', requestContext: { stage: 'dev', authorizer: { claims } },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body).hosts, [{ slug: 'example', status: 'ACTIVE' }]);
  });
});
