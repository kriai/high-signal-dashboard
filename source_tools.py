"""Source validation, discovery and selector tests without Flask dependencies."""

import ipaddress
import random
import re
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup

from scraper import is_challenge_page


EDITABLE_FIELDS = ('url', 'category', 'selector', 'fallback', 'tier', 'limit',
                   'enabled', 'lock_category', 'type', 'feed_url')
BLOCKED_HOSTS = ('localhost', 'localhost.localdomain', 'metadata.google.internal')
COMMON_HEADLINE_SELECTORS = (
    'article h1 a', 'article h2 a', 'article h3 a',
    'main h1 a', 'main h2 a', 'main h3 a',
    'h1 a', 'h2 a', 'h3 a',
    '.post-title a', '.entry-title a', '.story-title a', '.article-title a',
    '.headline a', '.title a', '.card-title a', 'a[rel="bookmark"]',
    'a[href*="/article/"]', 'a[href*="/articles/"]',
    'a[href*="/post/"]', 'a[href*="/posts/"]',
    'a[href*="/news/"]', 'a[href*="/blog/"]',
)
CARD_CLASS_HINTS = ('post', 'entry', 'article', 'story', 'headline',
                    'card', 'item', 'tile')


class SourceToolError(RuntimeError):
    def __init__(self, message, status=400, http_status=None):
        super().__init__(message)
        self.status = status
        self.http_status = http_status


def is_public_url(url):
    host = (urlparse(url).hostname or '').lower().rstrip('.')
    if not host or host in BLOCKED_HOSTS or host.endswith('.local'):
        return False
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return True
    return not (address.is_private or address.is_loopback or
                address.is_link_local or address.is_reserved or
                address.is_multicast)


def clean_source(payload, existing=None):
    source = dict(existing or {})
    name = str(payload.get('name') or source.get('name') or '').strip()
    if not name:
        raise SourceToolError('A name is required')
    if len(name) > 80:
        raise SourceToolError('Name is too long')
    source['name'] = name

    for field in EDITABLE_FIELDS:
        if field not in payload:
            continue
        value = payload[field]
        if field in ('enabled', 'lock_category'):
            if not isinstance(value, bool):
                raise SourceToolError(f'{field} must be true or false')
            source[field] = value
        elif field == 'limit':
            try:
                source['limit'] = max(1, min(50, int(value)))
            except (TypeError, ValueError) as exc:
                raise SourceToolError('Limit must be a number') from exc
        elif field == 'tier':
            tier = str(value).lower().strip()
            if tier not in ('high', 'medium', 'low', ''):
                raise SourceToolError('Tier must be high, medium or low')
            source['tier'] = tier or 'low'
        elif field == 'type':
            source_type = str(value or 'static').lower().strip()
            if source_type not in ('static', 'rss', 'json'):
                raise SourceToolError('Type must be static, rss or json')
            source['type'] = source_type
        else:
            source[field] = str(value or '').strip()

    url = source.get('url', '')
    if not url.startswith(('http://', 'https://')):
        raise SourceToolError('URL must start with http:// or https://')
    if not is_public_url(url):
        raise SourceToolError('That URL points at a local or private address')

    source['type'] = (source.get('type') or 'static').lower()
    feed_url = (source.get('feed_url') or '').strip()
    if feed_url:
        if not feed_url.startswith(('http://', 'https://')):
            raise SourceToolError('Feed URL must start with http:// or https://')
        if not is_public_url(feed_url):
            raise SourceToolError('Feed URL points at a local or private address')
        source['feed_url'] = feed_url
    else:
        source.pop('feed_url', None)

    if source['type'] == 'static':
        source.setdefault('selector', 'h2 a, h3 a')
    else:
        source.pop('selector', None)
        source.pop('fallback', None)
    source.setdefault('enabled', True)
    return source


def discover_source(scraper, payload):
    url = str(payload.get('url') or '').strip()
    if not url:
        raise SourceToolError('A URL is required')
    if not url.startswith(('http://', 'https://')):
        raise SourceToolError('URL must start with http:// or https://')
    if not is_public_url(url):
        raise SourceToolError('That URL points at a local or private address')
    try:
        response = scraper.scraper.get(
            url, headers={'User-Agent': random.choice(scraper.user_agents)},
            timeout=20, allow_redirects=True)
    except Exception as exc:  # noqa: BLE001
        raise SourceToolError(f'{type(exc).__name__}: {str(exc)[:160]}', 502) from exc
    if response.status_code != 200:
        raise SourceToolError(f'HTTP {response.status_code}', 502,
                              response.status_code)
    if is_challenge_page(response.text):
        raise SourceToolError('Blocked by a bot challenge', 502)

    page_url = response.url or url
    soup = BeautifulSoup(response.text, 'html.parser')
    working = dict(payload, url=page_url)
    candidates = []
    for feed_url in _feed_links(soup, page_url):
        candidate = _discover_feed_candidate(scraper, working, feed_url)
        if candidate:
            candidates.append(candidate)
    candidates.extend(_discover_static_candidates(scraper, working, soup))
    return {'url': url, 'fetched_url': page_url,
            'count': len(candidates[:8]), 'candidates': candidates[:8]}


def test_source(scraper, payload):
    source = clean_source(dict(payload, name=payload.get('name') or 'Preview'))
    articles, health = scraper.scrape_source(dict(source, retries=1))
    return {
        'state': health['state'], 'http_status': health['http_status'],
        'error': health['error'], 'duration_ms': health['duration_ms'],
        'count': len(articles), 'preview': _preview_payload(articles),
    }


def _candidate_source(payload, source_type='static', feed_url=''):
    return {
        'name': str(payload.get('name') or 'Preview').strip() or 'Preview',
        'url': payload['url'], 'category': payload.get('category') or 'Other',
        'tier': payload.get('tier') or 'medium', 'type': source_type,
        'feed_url': feed_url, 'limit': 15,
    }


def _preview_articles(scraper, source, soup, selector):
    try:
        items = soup.select(selector)
    except Exception:  # noqa: BLE001
        return [], 0
    if not items:
        return [], 0
    return scraper.extract_articles_from_items(
        items, dict(source, selector=selector)), len(items)


def _candidate_score(selector, raw_count, article_count):
    score = article_count * 18 + min(raw_count, 40)
    if selector.startswith('article '):
        score += 20
    if selector.startswith('main '):
        score += 14
    if selector.startswith('h'):
        score += 8
    if '[href*=' in selector:
        score += 6
    if raw_count > 60 and article_count < 8:
        score -= 20
    if raw_count > 120:
        score -= 25
    return score


def _css_escape(value):
    return ''.join(ch if ch.isalnum() or ch in ('-', '_') else '\\' + ch
                   for ch in value)


def _derived_selectors(soup):
    selectors = []
    for anchor in soup.select('main a[href], article a[href], section a[href]'):
        text = ' '.join(anchor.get_text(' ', strip=True).split())
        if len(text) < 16:
            continue
        heading = anchor.find(['h1', 'h2', 'h3'])
        if heading:
            selectors.extend((heading.name + ' a', 'article ' + heading.name + ' a',
                              'main ' + heading.name + ' a'))
        for node in [anchor] + list(anchor.parents)[:4]:
            useful = [name for name in (node.get('class') or [])
                      if any(hint in name.lower() for hint in CARD_CLASS_HINTS)]
            for name in useful[:2]:
                selectors.append(('.' + _css_escape(name)) if node.name == 'a'
                                 else ('.' + _css_escape(name) + ' a'))
        segments = [part for part in urlparse(anchor.get('href') or '').path.split('/')
                    if part]
        if segments:
            selectors.append(f'a[href*="/{segments[0]}/"]')
    return selectors


def _dedupe_selectors(selectors):
    seen, result = set(), []
    for selector in selectors:
        selector = ' '.join(selector.split())
        if selector and selector not in seen:
            seen.add(selector)
            result.append(selector)
    return result


def _feed_links(soup, page_url):
    links = []
    for node in soup.select('link[rel~="alternate"][href]'):
        mime = (node.get('type') or '').lower()
        title = (node.get('title') or '').lower()
        if 'rss' in mime or 'atom' in mime or 'feed' in title:
            feed_url = urljoin(page_url, node.get('href'))
            if feed_url not in links and is_public_url(feed_url):
                links.append(feed_url)
    return links[:4]


def _discover_feed_candidate(scraper, payload, feed_url):
    source = _candidate_source(payload, 'rss', feed_url)
    try:
        response = scraper.scraper.get(feed_url, timeout=15, allow_redirects=True)
    except Exception:  # noqa: BLE001
        return None
    if response.status_code != 200:
        return None
    articles = scraper.fetch_feed(source, response)
    if not articles:
        return None
    return {
        'kind': 'rss', 'type': 'rss', 'label': 'RSS feed', 'selector': '',
        'fallback': '', 'feed_url': feed_url, 'match_count': len(articles),
        'count': len(articles), 'confidence': min(99, 78 + min(len(articles), 12)),
        'preview': _preview_payload(articles),
    }


def _preview_payload(articles):
    return [{'title': item['title'], 'link': item['link'],
             'signal_score': item['signal_score'], 'category': item['category']}
            for item in articles[:8]]


def _discover_static_candidates(scraper, payload, soup):
    source = _candidate_source(payload)
    selectors = _dedupe_selectors(COMMON_HEADLINE_SELECTORS +
                                  tuple(_derived_selectors(soup)))
    candidates = []
    for selector in selectors[:90]:
        articles, raw_count = _preview_articles(scraper, source, soup, selector)
        if len(articles) < 2:
            continue
        rank = _candidate_score(selector, raw_count, len(articles))
        candidates.append({
            'kind': 'static', 'type': 'static', 'label': selector,
            'selector': selector, 'fallback': '', 'feed_url': '',
            'match_count': raw_count, 'count': len(articles),
            'confidence': max(30, min(95, int(rank / 2))),
            'rank_score': rank, 'preview': _preview_payload(articles),
        })
    candidates.sort(key=lambda item: (-item['rank_score'], item['selector']))
    for index, item in enumerate(candidates):
        item.pop('rank_score', None)
        item['fallback'] = next((other['selector'] for other in candidates[index + 1:]
                                 if other['selector'] != item['selector']), '')
    return candidates[:8]
