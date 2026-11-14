import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateLatency, runLatency, type LatencyRow } from '../demo/latency';
import { expectedPaths, runKb8, type Api } from '../demo/kb8';
import { commonChecks, contactChecks, vietnameseResidue } from '../demo/proxyCheck';
import { hashSentence } from '../lib/contract';
import { KB8_SHARED_SENTENCE } from '../lib/sampleSites';
import { median, type PageResult } from '../lib/visitor';

const res = (o: Partial<PageResult>): PageResult => ({ url: o.url ?? 'u', status: 200, ms: 10, xCache: 'Miss from cloudfront', partial: '', cacheControl: '', location: '', age: '', bytes: 0, body: '', ...o });
const noWait = async () => {};

test('median/evaluateLatency: tiêu chí (a) < 30 s không 5xx, (b) ≤ 2 s, (c) ≤ 300 ms và mọi lượt phải hợp lệ', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  const mk = (c: 'a' | 'b' | 'c', ms: number, o: Partial<LatencyRow> = {}): LatencyRow => ({ case: c, run: 1, url: '', status: 200, ms, xCache: '', partial: '', valid: true, ...o });
  const ok = [...Array(10)].flatMap(() => [mk('a', 9000), mk('b', 1500), mk('c', 120)]);
  assert.ok(evaluateLatency(ok).every((s) => s.pass));
  const aSlow = ok.map((r, i) => (i === 0 ? { ...r, ms: 31_000 } : r));
  assert.equal(evaluateLatency(aSlow)[0].pass, false);
  const a5xx = ok.map((r, i) => (i === 0 ? { ...r, status: 504 } : r));
  assert.match(evaluateLatency(a5xx)[0].reason!, /504/);
  const bSlow = ok.map((r) => (r.case === 'b' ? { ...r, ms: 2500 } : r));
  assert.equal(evaluateLatency(bSlow)[1].pass, false);
  const cInvalid = ok.map((r, i) => (r.case === 'c' && i < 10 ? { ...r, valid: false } : r));
  assert.match(evaluateLatency(cInvalid)[2].reason!, /hợp lệ/);
});

test('runLatency: (a) từng trang lạnh, (b) xóa cache trước mỗi lần, (c) chỉ tính lượt trúng cache', async () => {
  const cache = new Set<string>();
  const invalidated: string[][] = [];
  const get = async (url: string) => {
    const key = new URL(url).pathname;
    const hit = cache.has(key) && !url.includes('?');
    cache.add(key);
    return res({ url, xCache: hit ? 'Hit from cloudfront' : 'Miss from cloudfront', ms: hit ? 50 : 900 });
  };
  const rows = await runLatency({
    get, publicBase: 'https://cf.example', slug: 'b-site', lang: 'en', bust: 'invalidate',
    invalidate: async (p) => { invalidated.push(p); for (const x of p) cache.delete(x); },
  });
  assert.equal(rows.length, 30);
  assert.equal(invalidated.length, 10);
  assert.deepEqual(invalidated[0], ['/b-site/en/do-tre/am/']);
  assert.ok(rows.every((r) => r.valid), JSON.stringify(rows.filter((r) => !r.valid)));
  assert.ok(evaluateLatency(rows).every((s) => s.pass));
  // (a) chạy lại khi trang đã nằm trong cache -> không hợp lệ, phải đổi TM_LATENCY_ROUND
  const again = await runLatency({ get, publicBase: 'https://cf.example', slug: 'b-site', lang: 'en', bust: 'query' });
  assert.ok(again.filter((r) => r.case === 'a').every((r) => !r.valid && /TM_LATENCY_ROUND/.test(r.note!)));
});

test('proxyCheck: bắt canonical sai, marker sót, option không dịch', () => {
  const c = { publicBase: 'https://cf.example', slug: 'a', lang: 'en', origin: 'https://a.example/' };
  const good = '<html lang="en"><head><link rel="canonical" href="https://cf.example/a/en/lien-he/"><link rel="alternate" hreflang="vi" href="https://a.example/lien-he/"><link rel="alternate" hreflang="x-default" href="https://a.example/lien-he/"><link rel="alternate" hreflang="en" href="https://cf.example/a/en/lien-he/"></head></html>';
  assert.ok(commonChecks('/lien-he/', res({ body: good }), c, 'lien-he/').every((r) => r.pass));
  const bad = good.replace('https://cf.example/a/en/lien-he/">', 'https://a.example/lien-he/">').replace('</head>', '</head><p>{1}x{/1}</p>');
  const failed = commonChecks('/lien-he/', res({ body: bad }), c, 'lien-he/').filter((r) => !r.pass).map((r) => r.id);
  assert.deepEqual(failed.sort(), ['CANONICAL', 'MARKER']);
  const form = '<input id="ten" name="ten" placeholder="Enter your full name"><option value="doi">Phòng đôi</option>';
  assert.equal(contactChecks(res({ body: good + form }), c).find((r) => r.id === 'OPTION')?.pass, false);
  assert.deepEqual(vietnameseResidue('<p>Hello Phố Cổ Homestay and Hội An</p>', ['Phố Cổ Homestay']), ['Hội']);
});

test('runKb8: đúng 2 đường dẫn, trang khác vẫn Hit; bắt được invalidation thừa đường dẫn', async () => {
  const slug = 'c-site';
  const hash = hashSentence(KB8_SHARED_SENTENCE);
  const run = async (paths: string[]) => {
    const cached = new Map<string, string>();
    let tgt = 'Free breakfast...';
    let label = 'MACHINE';
    const get = async (url: string) => {
      const p = new URL(url).pathname;
      const hit = cached.has(p);
      const body = hit ? cached.get(p)! : `<p>${p.includes('/en/trang-1/') || p.includes('/en/trang-2/') ? tgt : 'x'}</p>`;
      cached.set(p, body);
      return res({ url, body, xCache: hit ? 'Hit from cloudfront' : 'Miss from cloudfront' });
    };
    const api: Api = async (method, path, body: any) => {
      if (method === 'GET' && path.startsWith('/console/hosts/')) return { status: 200, body: { host: { target_langs: ['en', 'ko'] } } };
      if (method === 'GET' && path.startsWith('/console/translations')) {
        const tab = /tab=(\w+)/.exec(path)![1];
        return { status: 200, body: { items: tab === label ? [{ hash, version: 3, label, tgt }] : [] } };
      }
      if (method === 'PUT') {
        assert.equal(body.hash, hash);
        assert.equal(body.expectedVersion, 3);
        tgt = body.newTgt; label = 'HUMAN';
        for (const p of paths) cached.delete(p);
        return { status: 200, body: { entry: { label: 'HUMAN' }, invalidation: { paths, mode: 'PATHS', invalidationId: 'I1', status: 'SUBMITTED' } } };
      }
      if (path === '/console/invalidations/I1') return { status: 200, body: { id: 'I1', status: 'COMPLETED', paths } };
      throw new Error(`${method} ${path}`);
    };
    return runKb8({ get, api, publicBase: 'https://cf.example', slug, lang: 'en', otherLang: 'ko', wait: noWait, newTgt: 'NEW-HUMAN-TEXT' });
  };
  const good = await run(expectedPaths(slug, 'en'));
  assert.ok(good.checks.every((c) => c.pass), JSON.stringify(good.checks.filter((c) => !c.pass)));
  assert.equal(good.checks.filter((c) => c.id.startsWith('K6')).length, 4, 'trang-3 en + 3 trang ko');
  const tooMany = await run([...expectedPaths(slug, 'en'), `/${slug}/en/trang-3/`]);
  const failed = tooMany.checks.filter((c) => !c.pass).map((c) => c.id);
  assert.ok(failed.includes('K2') && failed.includes('K6:en/trang-3/'), failed.join(','));
});
