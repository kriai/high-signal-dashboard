import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { canonicalCacheKey, derivedEtag, relayRoute, sortArticles, validatePublicUrl,
  validateSource } from '../src/index.ts';

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
  const row = (config: Record<string, unknown>) => ({
    id: String(config.name), name: config.name, config_json: JSON.stringify(config),
    revision: 1, updated_at: '',
  });
  const env = {
    FEED_RELAY_TOKEN: 'relay-secret',
    DB: { prepare: () => ({ all: async () => ({ results: [
      row({ name: 'Sub', url: 'https://sub.example.com/', feed_url: 'https://sub.example.com/feed', relay: true }),
      row({ name: 'Plain', url: 'https://plain.example.com/', feed_url: 'https://plain.example.com/feed' }),
      row({ name: 'Off', url: 'https://off.example.com/', feed_url: 'https://off.example.com/feed',
        relay: true, enabled: false }),
    ] }) }) },
  } as unknown as Parameters<typeof relayRoute>[1];
  const call = (target: string, token = 'relay-secret') => {
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
      if (!route) throw new Error(`unexpected fetch ${target}`);
      return route();
    }) as typeof fetch;
  };
  afterEach(() => { globalThis.fetch = realFetch; });

  it('refuses a missing or wrong token before touching the network', async () => {
    serve({});
    assert.equal((await call('https://sub.example.com/feed', 'nope')).status, 401);
    assert.deepEqual(requested, []);
  });

  it('only fetches endpoints of enabled sources marked relay', async () => {
    serve({});
    for (const target of ['https://plain.example.com/feed', 'https://off.example.com/feed',
      'https://unrelated.example.org/anything']) {
      const reply = await call(target);
      assert.equal(reply.status, 403, target);
      assert.equal(reply.headers.get('x-relay-upstream-status'), null);
    }
    assert.equal((await call('http://127.0.0.1/feed')).status, 400);
    assert.deepEqual(requested, []);
  });

  it("passes the publisher's status and body through, marked as upstream", async () => {
    serve({ 'https://sub.example.com/feed': () => new Response('<rss/>', {
      status: 200, headers: { 'content-type': 'application/rss+xml' } }) });
    const ok = await call('https://sub.example.com/feed');
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), '<rss/>');
    assert.equal(ok.headers.get('x-relay-upstream-status'), '200');
    assert.equal(ok.headers.get('x-relay-final-url'), 'https://sub.example.com/feed');

    serve({ 'https://sub.example.com/feed': () => new Response('no', { status: 403 }) });
    const blocked = await call('https://sub.example.com/feed');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.headers.get('x-relay-upstream-status'), '403');
  });

  it('follows public redirects and refuses private ones', async () => {
    serve({
      'https://sub.example.com/feed': () => new Response(null, {
        status: 301, headers: { location: '/feed/' } }),
      'https://sub.example.com/feed/': () => new Response('<rss/>', { status: 200 }),
    });
    const moved = await call('https://sub.example.com/feed');
    assert.equal(moved.headers.get('x-relay-final-url'), 'https://sub.example.com/feed/');

    serve({ 'https://sub.example.com/feed': () => new Response(null, {
      status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } }) });
    const unsafe = await call('https://sub.example.com/feed');
    assert.equal(unsafe.status, 502);
    assert.equal(unsafe.headers.get('x-relay-upstream-status'), null);
    assert.deepEqual(requested, ['https://sub.example.com/feed']);
  });
});
