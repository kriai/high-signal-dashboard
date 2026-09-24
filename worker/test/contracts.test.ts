import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import worker, { canonicalCacheKey, derivedEtag, refreshRelayCopies, relayRoute, sortArticles,
  validatePublicUrl, validateSource } from '../src/index.ts';

const articles = [
  { id: 'a', title: 'A', link: 'https://example.com/a', source: 'Beta',
    category: 'Other', signal_score: 70, first_seen: '2026-09-10T10:00:00' },
  { id: 'b', title: 'B', link: 'https://example.com/b', source: 'Alpha',
    category: 'Security', signal_score: 80, first_seen: '2026-09-10T09:00:00' },
  { id: 'c', title: 'C', link: 'https://example.com/c', source: 'Beta',
    category: 'Security', signal_score: 60, first_seen: '2026-09-10T11:00:00' },
];

describe('compatibility sorting', () => {
  it('orders score with a source-name tie breaker', () => {
    assert.deepEqual(sortArticles(articles, 'score').map((article) => article.id),
      ['b', 'a', 'c']);
  });

  it('orders recent using first_seen when published is unavailable', () => {
    assert.deepEqual(sortArticles(articles, 'recent').map((article) => article.id),
      ['c', 'a', 'b']);
  });

  it('round-robins mixed results across sources', () => {
    assert.deepEqual(sortArticles(articles, 'mixed').map((article) => article.id),
      ['b', 'a', 'c']);
  });

  it('uses taxonomy order for categories', () => {
    assert.deepEqual(sortArticles(articles, 'category').map((article) => article.id),
      ['b', 'c', 'a']);
  });
});

describe('owner URL validation', () => {
  it('rejects local, alternate IPv4 and IPv6 targets', () => {
    for (const url of ['http://localhost./', 'http://127.1/private',
      'http://2130706433/', 'http://0x7f000001/', 'http://[::ffff:127.0.0.1]/']) {
      assert.throws(() => validatePublicUrl(url, 'URL'), /local or private/);
    }
  });

  it('accepts public HTTP URLs and strips no path data', () => {
    assert.equal(validatePublicUrl('https://example.com/feed?q=1', 'URL'),
      'https://example.com/feed?q=1');
  });
});

describe('source configuration', () => {
  it('preserves bounded fallback strategies and retention settings', () => {
    const source = validateSource({
      name: 'Example', url: 'https://example.com/', type: 'static',
      retention_hours: 24, allow_empty: true,
      allowed_hosts: ['example.com'], path_prefixes: ['/news/'],
      fetch_strategies: [
        { id: 'feed', type: 'rss', url: 'https://example.com/feed.xml' },
        { id: 'html', type: 'static', url: 'https://example.com/news',
          selectors: ['article h2 a'] },
      ],
    });
    assert.equal(source.retention_hours, 24);
    assert.equal(source.allow_empty, true);
    assert.deepEqual(source.allowed_hosts, ['example.com']);
    assert.equal((source.fetch_strategies as Record<string, unknown>[]).length, 2);
  });

  it('keeps every field of every checked-in source through an edit', () => {
    // An admin edit rebuilds the source from this validator, so any field it
    // does not know is erased from D1. Each seed source must round-trip intact.
    const seed = JSON.parse(readFileSync(new URL('../../sources.json', import.meta.url), 'utf8'));
    for (const input of seed.sources as Record<string, unknown>[]) {
      const saved = validateSource(input);
      for (const [key, value] of Object.entries(input)) {
        // URLs are stored in canonical form, which names the same address.
        const expected = key === 'url' || key === 'feed_url'
          ? new URL(value as string).href : value;
        assert.deepEqual(saved[key], expected, `${input.name}: ${key} was not preserved`);
      }
    }
  });

  it('bounds the operator note and drops an empty one', () => {
    const base = { name: 'Example', url: 'https://example.com/' };
    assert.equal(validateSource({ ...base, note: '  why  ' }).note, 'why');
    assert.equal((validateSource({ ...base, note: 'x'.repeat(900) }).note as string).length, 500);
    assert.equal('note' in validateSource({ ...base, note: '   ' }), false);
  });

  it('rejects unsafe strategy URLs and excessive retention', () => {
    assert.throws(() => validateSource({ name: 'Bad', url: 'https://example.com',
      retention_hours: 169 }), /between 0 and 168/);
    assert.throws(() => validateSource({ name: 'Bad', url: 'https://example.com',
      fetch_strategies: [{ type: 'rss', url: 'http:\/\/127.0.0.1/feed' }] }),
    /local or private/);
  });
});

describe('edge cache keys', () => {
  it('ignores parameter order and leaves assets uncached by the Worker', () => {
    const first = canonicalCacheKey(new Request('https://x.dev/api/feed?sort=recent&min_score=40'));
    const second = canonicalCacheKey(new Request('https://x.dev/api/feed?min_score=40&sort=recent'));
    assert.equal(first?.url, second?.url);
    assert.equal(first?.url, 'https://x.dev/api/feed?min_score=40&sort=recent');
    assert.equal(canonicalCacheKey(new Request('https://x.dev/static/css/app.css')), null);
    assert.equal(canonicalCacheKey(new Request('https://x.dev/')), null);
  });

  it('ties derived entity tags to the publication and the query shape', () => {
    const url = new URL('https://x.dev/api/feed?sort=recent');
    const reordered = new URL('https://x.dev/api/feed?sort=recent&');
    assert.equal(derivedEtag('pub-1', url), derivedEtag('pub-1', reordered));
    assert.notEqual(derivedEtag('pub-1', url), derivedEtag('pub-2', url));
    assert.notEqual(derivedEtag('pub-1', url),
      derivedEtag('pub-1', new URL('https://x.dev/api/feed?sort=score')));
    assert.match(derivedEtag('pub-1', url), /^"pub-1-[0-9a-f]+"$/);
  });
});

describe('feed relay', () => {
  const SUB = 'https://sub.example.com/feed';
  const configs = (): Record<string, unknown>[] => [
    { name: 'Sub', url: 'https://sub.example.com/', feed_url: SUB, relay: true },
    { name: 'Plain', url: 'https://plain.example.com/', feed_url: 'https://plain.example.com/feed' },
    { name: 'Off', url: 'https://off.example.com/', feed_url: 'https://off.example.com/feed',
      relay: true, enabled: false },
  ];
  // Enough of D1 for the relay: the sources listing, and relay_copies rows.
  const fakeEnv = (sources = configs()) => {
    const copies = new Map<string, Record<string, unknown>>();
    const statement = (sql: string, params: unknown[] = []) => ({
      bind: (...values: unknown[]) => statement(sql, values),
      all: async () => ({ results: sources.map((config) => ({
        id: config.name, name: config.name, config_json: JSON.stringify(config),
        revision: 1, updated_at: '' })) }),
      first: async () => copies.get(String(params[0])) ?? null,
      run: async () => {
        if (sql.startsWith('INSERT INTO relay_copies')) {
          const [url, status, content_type, final_url, retry_after, body_text, fetched_at] = params;
          copies.set(String(url), { status, content_type, final_url, retry_after, body_text, fetched_at });
        } else if (sql.startsWith('DELETE FROM relay_copies')) {
          for (const key of [...copies.keys()]) if (!params.includes(key)) copies.delete(key);
        }
        return { success: true };
      },
    });
    const DB = {
      prepare: (sql: string) => statement(sql.replace(/\s+/g, ' ').trim()),
      batch: async (list: { run: () => Promise<unknown> }[]) => {
        for (const item of list) await item.run();
        return [];
      },
    };
    const env = { FEED_RELAY_TOKEN: 'relay-secret', ADMIN_API_TOKEN: 'admin-secret', DB } as
      unknown as Parameters<typeof relayRoute>[1];
    return { env, copies, sources };
  };
  const call = (env: Parameters<typeof relayRoute>[1], target: string, token = 'relay-secret') => {
    const url = new URL(`https://site.example/api/relay/feed?url=${encodeURIComponent(target)}`);
    return relayRoute(new Request(url, { headers: { authorization: `Bearer ${token}` } }), env, url);
  };
  const realFetch = globalThis.fetch;
  let requested: string[] = [];
  const serve = (routes: Record<string, () => Response>) => {
    requested = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const target = String(input);
      requested.push(target);
      assert.equal(init?.redirect, 'manual');
      const route = routes[target];
      if (!route) throw new Error(`unreachable ${target}`);
      return route();
    }) as typeof fetch;
  };
  const rss = (status = 200, headers: Record<string, string> = {}) => () =>
    new Response('<rss>entries</rss>', { status,
      headers: { 'content-type': 'application/rss+xml; charset=utf-8', ...headers } });
  afterEach(() => { globalThis.fetch = realFetch; });

  it('refuses a missing or wrong token, and URLs of sources not marked relay', async () => {
    const { env } = fakeEnv();
    serve({});
    assert.equal((await call(env, SUB, 'nope')).status, 401);
    // The relay source's own homepage is not an endpoint the scraper fetches.
    for (const target of ['https://sub.example.com/', 'https://plain.example.com/feed',
      'https://off.example.com/feed', 'https://unrelated.example.org/anything']) {
      const reply = await call(env, target);
      assert.equal(reply.status, 403, target);
      assert.equal(reply.headers.get('x-relay-upstream-status'), null);
    }
    assert.equal((await call(env, 'http://127.0.0.1/feed')).status, 400);
    assert.deepEqual(requested, []);
  });

  it('saves relay feeds on a schedule and serves the copy without fetching', async () => {
    const { env } = fakeEnv();
    serve({ [SUB]: rss(200, { 'retry-after': '60' }) });
    const outcome = await refreshRelayCopies(env);
    assert.deepEqual(outcome, { [SUB]: 'saved HTTP 200' });
    assert.deepEqual(requested, [SUB]);

    serve({});
    const reply = await call(env, SUB);
    assert.equal(reply.status, 200);
    assert.equal(await reply.text(), '<rss>entries</rss>');
    assert.equal(reply.headers.get('x-relay-upstream-status'), '200');
    assert.equal(reply.headers.get('x-relay-final-url'), SUB);
    assert.equal(reply.headers.get('retry-after'), '60');
    assert.ok(reply.headers.get('x-relay-fetched-at'));
    assert.deepEqual(requested, [], 'a relay read must never fetch the publisher');
  });

  it("serves the publisher's own refusal as upstream, so it reads as blocked", async () => {
    const { env } = fakeEnv();
    serve({ [SUB]: rss(403) });
    await refreshRelayCopies(env);
    const reply = await call(env, SUB);
    assert.equal(reply.status, 403);
    assert.equal(reply.headers.get('x-relay-upstream-status'), '403');
  });

  it('answers 503, not a publisher status, with no copy or a copy over 3 hours old', async () => {
    const { env, copies } = fakeEnv();
    const empty = await call(env, SUB);
    assert.equal(empty.status, 503);
    assert.equal(empty.headers.get('x-relay-upstream-status'), null);

    serve({ [SUB]: rss() });
    await refreshRelayCopies(env);
    copies.get(SUB)!.fetched_at = new Date(Date.now() - 3 * 60 * 60 * 1000 - 1000).toISOString();
    const stale = await call(env, SUB);
    assert.equal(stale.status, 503);
    assert.match((await stale.json() as { error: string }).error, /more than 3 hours/);
  });

  it('keeps the previous copy when a refresh cannot get a usable answer', async () => {
    const { env, copies } = fakeEnv();
    serve({ [SUB]: rss() });
    await refreshRelayCopies(env);
    const saved = { ...copies.get(SUB) };
    const refusals: Record<string, () => Response>[] = [
      { [SUB]: () => new Response(null, { status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data' } }) },
      { [SUB]: () => new Response('x', { headers: { 'content-type': 'text/xml; charset=iso-8859-1' } }) },
      { [SUB]: () => new Response(new Uint8Array([0xff, 0xfe, 0xfd]), {
        headers: { 'content-type': 'text/xml' } }) },
      { [SUB]: () => new Response('x', { headers: { 'content-length': '5000000' } }) },
      {},
    ];
    for (const routes of refusals) {
      serve(routes);
      const outcome = await refreshRelayCopies(env);
      assert.match(outcome[SUB], /^kept previous copy/);
      assert.deepEqual(copies.get(SUB), saved);
    }
    assert.deepEqual(requested, [SUB], 'the private redirect target is never requested');
  });

  it('follows public redirects and records where the feed ended up', async () => {
    const { env, copies } = fakeEnv();
    serve({
      [SUB]: () => new Response(null, { status: 301, headers: { location: '/feed/' } }),
      'https://sub.example.com/feed/': rss(),
    });
    await refreshRelayCopies(env);
    assert.equal(copies.get(SUB)!.final_url, 'https://sub.example.com/feed/');
  });

  it('forgets the copy once a source is no longer relayed', async () => {
    const { env, copies, sources } = fakeEnv();
    serve({ [SUB]: rss() });
    await refreshRelayCopies(env);
    assert.ok(copies.has(SUB));
    sources[0].relay = false;
    serve({});
    assert.deepEqual(await refreshRelayCopies(env), {});
    assert.equal(copies.size, 0);
  });

  it('lets only the owner refresh copies on demand', async () => {
    const { env } = fakeEnv();
    serve({ [SUB]: rss() });
    const ask = (token: string) => worker.fetch(new Request('https://site.example/api/admin/relay/refresh', {
      method: 'POST', headers: { authorization: `Bearer ${token}` } }), env, {} as ExecutionContext);
    assert.equal((await ask('relay-secret')).status, 401);
    const reply = await ask('admin-secret');
    assert.equal(reply.status, 200);
    assert.deepEqual(await reply.json(), { refreshed: { [SUB]: 'saved HTTP 200' } });
  });
});
