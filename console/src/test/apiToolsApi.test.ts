import assert from 'node:assert/strict';
import { it } from 'node:test';
import { submitLiveBatch } from '../services/apiToolsApi.js';
import type { AuthenticatedSession } from '../types/auth.js';

const session = { tenantId: 't1', sub: 'user1', idToken: 'token' } as AuthenticatedSession;
const pendingResponse = () => Response.json({ error: { code: 'WORKFLOW_START_PENDING' } }, { status: 503 });

it('Batch dùng cùng file_key khi retry tự động và khi người dùng bấm gửi lại', async (t) => {
  const file = new File(['Hello.'], 'source.txt');
  const uploadUrl = 'https://bucket.example/upload';
  const bodies: unknown[] = [];
  const delays: number[] = [];
  let signs = 0;
  let uploads = 0;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith('/upload-url')) {
      signs++;
      return Response.json({ file_key: 'batch/t1/input/job.txt', upload_url: uploadUrl, required_headers: {} });
    }
    if (path === uploadUrl) {
      uploads++;
      assert.equal(init?.body, file);
      return new Response(null, { status: 200 });
    }
    assert.ok(path.endsWith('/translate/batch/session'));
    bodies.push(JSON.parse(String(init?.body)));
    if (bodies.length === 1) return new Response('Service unavailable', { status: 503 });
    return bodies.length <= 4 ? pendingResponse() : Response.json({ job_id: 'job-1', status: 'RUNNING', estimated_characters: 6 });
  });
  const submit = () => submitLiveBatch(session, file, 'en', ['fr'], true, async (ms) => { delays.push(ms); });

  await assert.rejects(submit(), { status: 503, code: 'WORKFLOW_START_PENDING' });
  assert.equal((await submit()).job_id, 'job-1');
  assert.deepEqual(delays, [500, 1_000, 2_000]);
  assert.deepEqual([signs, uploads], [1, 1]);
  assert.deepEqual(bodies, Array(5).fill({ file_key: 'batch/t1/input/job.txt', source_lang: 'en', target_langs: ['fr'], send_email: true }));
});
