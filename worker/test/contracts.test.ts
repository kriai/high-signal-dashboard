import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonicalCacheKey, derivedEtag, sortArticles, validatePublicUrl,
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
