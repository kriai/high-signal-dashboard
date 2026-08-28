"""High Signal — Flask API and dashboard host.

The server owns three things the browser cannot: the scrape, the cache, and the
source list. Everything else (filtering, grouping, read state) lives client-side
because the whole corpus is a few hundred headlines.

Scrapes never run inside a request. A full pass walks ~27 sources with polite
sleeps between them, which takes minutes -- far longer than any browser will
wait. `/api/refresh` therefore starts a background job and returns immediately;
the UI follows `/api/refresh/status` for a determinate progress bar.
"""

import atexit
import ipaddress
import os
import random
import threading
import time
import uuid
from urllib.parse import urljoin, urlparse
from datetime import datetime, timedelta
from email.utils import format_datetime
from xml.sax.saxutils import escape as xml_escape

from apscheduler.schedulers.background import BackgroundScheduler
from bs4 import BeautifulSoup
from flask import Flask, Response, jsonify, render_template, request

import store
from scraper import (CATEGORIES, HighSignalScraper, categorize,
                     is_challenge_page, is_generated_summary, metadata_summary,
                     write_json_atomic)

app = Flask(__name__)

# Score bands. Derived from the live distribution rather than guessed: the
# corpus runs roughly 29-90 with a median near 68, so 75/60 actually cut it into
# three populated groups. The client reads these from /api/stats so the badge
# colours, the threshold filter and the "high signal" stat can never disagree.
SCORE_HIGH = 75
SCORE_MID = 60

SCRAPE_INTERVAL_MINUTES = 30
STALE_AFTER = timedelta(minutes=SCRAPE_INTERVAL_MINUTES * 2)
SOURCES_FILE = 'sources.json'

# Serverless only. How long an instance may serve the copy of the cache it
# already has before re-reading it from the store.
STATE_TTL = 60

# Budget for a scrape a person is sitting and waiting on. The scheduled full
# pass runs in CI (see scrape_job.py); this one runs inside a request, so it is
# short enough that the button feels like it did something and covers the
# sources that have gone longest without a check.
MANUAL_SCRAPE_BUDGET_SECONDS = int(
    os.environ.get('MANUAL_SCRAPE_BUDGET_SECONDS', 45))

scraper = HighSignalScraper()
cached_articles = []
last_scrape_at = None
state_loaded_at = 0
load_lock = threading.Lock()

@app.before_request
def _hydrate():
    """Every request serves from state this instance actually has.

    Cheap and idempotent after the first call within STATE_TTL; see
    ensure_loaded. Registered as a hook rather than sprinkled through the
    routes so a new endpoint cannot forget it.
    """
    if store.is_remote():
        ensure_loaded()


# == Refresh job ============================================================
# One scrape at a time, tracked well enough to render a progress bar.

refresh_lock = threading.Lock()
summary_lock = threading.Lock()
refresh_job = {
    'job_id': None,
    'state': 'idle',        # idle | running | done | error
    'done': 0,
    'total': 0,
    'source': None,
    'started_at': None,
    'finished_at': None,
    'error': None,
    'count': 0,
}


def _summarize(articles):
    """Normalize summary fields without inventing prose.

    Older caches contain generated placeholder text. Clear it so the client can
    lazily ask for a real token-free summary when the detail row is opened.
    """
    for article in articles:
        if is_generated_summary(article.get('summary')):
            article['summary'] = ''
            article['summary_source'] = ''
        elif article.get('summary') and not article.get('summary_source'):
            article['summary_source'] = 'cached'
        else:
            article.setdefault('summary_source', '')


def find_article(article_id):
    return next((a for a in cached_articles if a.get('id') == article_id), None)


def has_cached_summary(article):
    return bool(article.get('summary')) and \
        not is_generated_summary(article.get('summary'))


def _progress(done, total, source):
    with refresh_lock:
        refresh_job.update(done=done, total=total, source=source)


def scrape_and_cache(job_id=None, deadline=None):
    """Run a scrape and swap it into the cache. Blocking; call in a thread.

    `deadline` caps the pass for serverless, where the invocation itself is
    capped; see HighSignalScraper.scrape_all.
    """
    global cached_articles, last_scrape_at

    with refresh_lock:
        refresh_job.update(job_id=job_id, state='running', done=0,
                           total=len(scraper.sources), source=None, error=None,
                           started_at=datetime.now().isoformat(),
                           finished_at=None)

    print('🔄 Running scrape...')
    try:
        articles = scraper.scrape_all(progress=_progress, deadline=deadline)
        _summarize(articles)
        cached_articles = articles
        last_scrape_at = datetime.now()
        scraper.save_to_cache()
        print(f'✅ Cached {len(articles)} articles')
        state, error = 'done', None
    except Exception as exc:                                 # noqa: BLE001
        # A failed scrape must not take the server with it; the previous cache
        # stays served and the UI surfaces the error.
        print(f'❌ Scrape failed: {exc}')
        state, error = 'error', f'{type(exc).__name__}: {exc}'[:300]

    with refresh_lock:
        refresh_job.update(state=state, error=error, source=None,
                           finished_at=datetime.now().isoformat(),
                           count=len(cached_articles))


def start_refresh(background=True, deadline=None):
    """Kick off a scrape unless one is already in flight. Returns the job id.

    `background=False` runs the scrape in the calling request instead of a
    daemon thread. Serverless has nowhere for a background thread to live -- the
    instance can be frozen the moment the response is sent -- so the scheduled
    scrape on Vercel blocks its own invocation and the deadline keeps it inside
    the function's time limit.
    """
    with refresh_lock:
        if refresh_job['state'] == 'running':
            return refresh_job['job_id'], False
        job_id = uuid.uuid4().hex[:12]
        refresh_job.update(job_id=job_id, state='running', done=0,
                           total=len(scraper.sources), source=None, error=None,
                           started_at=datetime.now().isoformat(),
                           finished_at=None)

    if not background:
        scrape_and_cache(job_id, deadline=deadline)
        return job_id, True

    threading.Thread(target=scrape_and_cache, args=(job_id,),
                     kwargs={'deadline': deadline},
                     daemon=True, name='scrape-' + job_id).start()
    return job_id, True


def load_state():
    """Pull the cache and health table into this process."""
    global cached_articles, last_scrape_at, state_loaded_at

    scraper.load_health()
    cached_articles = scraper.load_cache()
    _summarize(cached_articles)
    last_scrape_at = _parse(scraper.last_run)
    state_loaded_at = time.time()
    print(f'📦 Loaded {len(cached_articles)} cached articles')


def ensure_loaded():
    """Make sure this instance has state, and that it is not too old.

    A long-lived local server loads once at boot. Serverless has no boot: every
    instance starts empty, and the instance that answers a request is rarely the
    one that ran the last scrape, so state is loaded on first use and re-read
    once it ages past STATE_TTL. The read is cheap -- one listing plus one CDN
    download -- next to re-scraping.
    """
    if state_loaded_at and time.time() - state_loaded_at < STATE_TTL:
        return
    with load_lock:
        if state_loaded_at and time.time() - state_loaded_at < STATE_TTL:
            return
        load_state()


def boot():
    """Serve from cache immediately, then refresh in the background if stale.

    The previous version scraped synchronously at import time, so the first
    request waited minutes for a cold start (twice over, under the debug
    reloader). Only the long-lived local server calls this; deployed, the
    scheduled scrape belongs to CI, never to a page view.
    """
    load_state()

    if not cached_articles or last_scrape_at is None or \
            datetime.now() - last_scrape_at > STALE_AFTER:
        print('⏳ Cache is stale or empty — refreshing in the background')
        start_refresh()


def _parse(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return None


# == Query helpers ==========================================================

def category_rank(name):
    """Position in the scraper's declared taxonomy; unknown buckets sort last."""
    try:
        return CATEGORIES.index(name)
    except ValueError:
        return len(CATEGORIES)


def interleave_by_source(articles):
    """Round-robin the articles across their sources, strongest source first.

    Score order alone stacks each source into a block, because the score is
    largely a property of the source. Interleaving is what makes the flat view
    read as a feed.
    """
    buckets = {}
    for article in sorted(articles, key=lambda a: -a.get('signal_score', 0)):
        buckets.setdefault(article['source'], []).append(article)

    order = sorted(buckets, key=lambda name: (-buckets[name][0].get('signal_score', 0),
                                              name.lower()))
    merged = []
    for index in range(max(len(b) for b in buckets.values()) if buckets else 0):
        for name in order:
            if index < len(buckets[name]):
                merged.append(buckets[name][index])
    return merged


def article_category(article):
    """Category of a cached article, derived on the fly if it predates the field."""
    return article.get('category') or categorize(article.get('title', ''))


def article_time(article):
    """Best timestamp for recency: publish date if known, else first sighting."""
    return _parse(article.get('published')) or \
        _parse(article.get('first_seen')) or \
        _parse(article.get('timestamp')) or \
        datetime.min


def source_element(name):
    """`<source>` for a feed item, or '' when we cannot satisfy the spec.

    RSS 2.0 makes `url` a required attribute, so a bare `<source>Name</source>`
    fails validation. Prefer the source's feed endpoint (what the spec asks
    for); fall back to its homepage; emit nothing for an article whose source
    has since been deleted from sources.json.
    """
    source = next((s for s in scraper.sources if s['name'] == name), None)
    url = (source.get('feed_url') or source.get('url')) if source else None
    if not url:
        return ''
    return (f'<source url="{xml_escape(url, {chr(34): "&quot;"})}">'
            f'{xml_escape(name)}</source>')


def matches(article, min_score=0, source='', category=''):
    if article.get('signal_score', 0) < min_score:
        return False
    if source and article.get('source') != source:
        return False
    if category and article_category(article) != category:
        return False
    return True


def sort_articles(articles, sort):
    if sort == 'source':
        return sorted(articles, key=lambda a: (a['source'].lower(),
                                               -a.get('signal_score', 0)))
    if sort == 'category':
        return sorted(articles, key=lambda a: (category_rank(article_category(a)),
                                               -a.get('signal_score', 0)))
    if sort == 'recent':
        return sorted(articles, key=lambda a: (article_time(a),
                                               a.get('signal_score', 0)),
                      reverse=True)
    if sort == 'mixed':
        return interleave_by_source(articles)
    return sorted(articles, key=lambda a: (-a.get('signal_score', 0),
                                           a['source'].lower()))


# == Pages ==================================================================

@app.route('/')
def index():
    return render_template('index.html')


# == Feed =====================================================================

@app.route('/api/feed')
def get_feed():
    """Flat newsfeed: every source merged into one stream.

    `sort=score` (default) puts the strongest headlines first; `sort=recent`
    orders by publish date (falling back to when we first saw the headline);
    `sort=mixed` round-robins across sources so a single prolific feed cannot own
    the top of the page; `sort=source` and `sort=category` group without nesting.
    """
    min_score = request.args.get('min_score', 0, type=int)
    limit = request.args.get('limit', 0, type=int)
    source = request.args.get('source', '')
    category = request.args.get('category', '')
    sort = request.args.get('sort', 'score')

    articles = sort_articles(
        [a for a in cached_articles if matches(a, min_score, source, category)],
        sort)

    return jsonify(articles[:limit] if limit > 0 else articles)


@app.route('/api/articles')
def get_articles():
    limit = request.args.get('limit', 50, type=int)
    source = request.args.get('source', '')
    min_score = request.args.get('min_score', 0, type=int)

    articles = [a for a in cached_articles if matches(a, min_score, source)]
    return jsonify(articles[:limit])


@app.route('/api/grouped')
def get_grouped():
    min_score = request.args.get('min_score', 0, type=int)
    per_source = request.args.get('per_source', 100, type=int)

    grouped = {}
    for article in cached_articles:
        if not matches(article, min_score):
            continue
        grouped.setdefault(article['source'], []).append(article)

    result = []
    for name, items in grouped.items():
        items.sort(key=lambda a: a.get('signal_score', 0), reverse=True)
        result.append({
            'source': name,
            'count': len(items),
            'articles': items[:per_source]
        })

    result.sort(key=lambda group: (-group['count'], group['source'].lower()))
    return jsonify(result)


@app.route('/api/categories')
def get_categories():
    """The same corpus bucketed by category instead of by source."""
    min_score = request.args.get('min_score', 0, type=int)
    per_category = request.args.get('per_category', 100, type=int)

    grouped = {}
    for article in cached_articles:
        if not matches(article, min_score):
            continue
        grouped.setdefault(article_category(article), []).append(article)

    result = []
    for name, items in grouped.items():
        items.sort(key=lambda a: -a.get('signal_score', 0))
        result.append({
            'category': name,
            'count': len(items),
            'sources': len(set(a['source'] for a in items)),
            'articles': items[:per_category]
        })

    result.sort(key=lambda group: category_rank(group['category']))
    return jsonify(result)


@app.route('/api/high_signal')
def get_high_signal():
    articles = [a for a in cached_articles
                if a.get('signal_score', 0) >= SCORE_HIGH]
    return jsonify(articles[:30])


# == Summaries ================================================================

@app.route('/api/article/<article_id>/summary')
def get_article_summary(article_id):
    """Lazy, cached detail summary.

    Most feed items already have publisher text. Static HTML headlines do not,
    so the detail drawer asks for a summary only when opened. First successful
    layer wins: cached/feed text, article metadata, body lead, then a
    deterministic score/source line.
    """
    article = find_article(article_id)
    if not article:
        return jsonify({'error': 'No such article'}), 404

    with summary_lock:
        if has_cached_summary(article):
            return jsonify({
                'id': article_id,
                'summary': article['summary'],
                'summary_source': article.get('summary_source') or 'cached',
                'cached': True,
            })

        error = None
        if is_public_url(article.get('link', '')):
            summary, source, error = scraper.fetch_article_summary(article)
        else:
            summary, source = metadata_summary(article), 'metadata'
            error = 'Article URL is not public'

        article['summary'] = summary
        article['summary_source'] = source
        article['summary_checked_at'] = datetime.now().isoformat()
        if error:
            article['summary_error'] = error
        else:
            article.pop('summary_error', None)

        scraper.articles = cached_articles
        scraper.save_to_cache()

        return jsonify({
            'id': article_id,
            'summary': article['summary'],
            'summary_source': article['summary_source'],
            'summary_checked_at': article['summary_checked_at'],
            'summary_error': article.get('summary_error'),
            'cached': False,
        })


# == Sources ==================================================================

EDITABLE_FIELDS = ('url', 'category', 'selector', 'fallback', 'tier', 'limit',
                   'enabled', 'lock_category', 'type', 'feed_url')

BLOCKED_HOSTS = ('localhost', 'localhost.localdomain', 'metadata.google.internal')


def is_public_url(url):
    """Reject URLs pointing at the machine itself or a private network.

    /api/sources and /api/sources/test both make the server fetch a URL the
    caller chose, which is a request-forgery primitive: without this, anyone who
    can reach the dashboard can use it to probe 127.0.0.1, the LAN, or a cloud
    metadata endpoint. Literal addresses are checked directly; hostnames are
    matched by name (this is a guard, not a sandbox — it does not resolve DNS).
    """
    host = (urlparse(url).hostname or '').lower().rstrip('.')
    if not host or host in BLOCKED_HOSTS or host.endswith('.local'):
        return False
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return True                      # a normal hostname
    return not (address.is_private or address.is_loopback or
                address.is_link_local or address.is_reserved or
                address.is_multicast)


@app.route('/api/sources')
def get_sources():
    """Per-source health, not just a count of what happened to work.

    A source that stops matching its selector used to disappear from the
    dashboard silently. Every configured source appears here with a state, the
    HTTP status, the error text and the last time it succeeded.
    """
    live_counts = {}
    for article in cached_articles:
        live_counts[article['source']] = live_counts.get(article['source'], 0) + 1

    rows = []
    for row in scraper.health_summary():
        rows.append(dict(row, count=live_counts.get(row['name'], 0)))

    rows.sort(key=lambda r: ({'error': 0, 'empty': 1, 'pending': 2,
                              'disabled': 3, 'ok': 4}.get(r['state'], 5),
                             -r['count'], r['name'].lower()))

    states = {}
    for row in rows:
        states[row['state']] = states.get(row['state'], 0) + 1

    return jsonify({
        'sources': rows,
        'total': len(rows),
        'ok': states.get('ok', 0),
        'failing': states.get('error', 0) + states.get('empty', 0),
        'disabled': states.get('disabled', 0),
        'states': states,
    })


def _write_sources(sources):
    write_json_atomic(SOURCES_FILE, {'sources': sources})
    scraper.reload_sources(SOURCES_FILE)


def _clean_source_payload(payload, existing=None):
    """Validate an incoming source. Returns (source_dict, error_message)."""
    source = dict(existing or {})

    name = (payload.get('name') or source.get('name') or '').strip()
    if not name:
        return None, 'A name is required'
    if len(name) > 80:
        return None, 'Name is too long'
    source['name'] = name

    for field in EDITABLE_FIELDS:
        if field not in payload:
            continue
        value = payload[field]
        if field == 'enabled' or field == 'lock_category':
            source[field] = bool(value)
        elif field == 'limit':
            try:
                source['limit'] = max(1, min(50, int(value)))
            except (TypeError, ValueError):
                return None, 'Limit must be a number'
        elif field == 'tier':
            tier = str(value).lower().strip()
            if tier not in ('high', 'medium', 'low', ''):
                return None, 'Tier must be high, medium or low'
            source['tier'] = tier or 'low'
        elif field == 'type':
            source_type = str(value or 'static').lower().strip()
            if source_type not in ('static', 'rss', 'json'):
                return None, 'Type must be static, rss or json'
            source['type'] = source_type
        else:
            source[field] = str(value or '').strip()

    url = source.get('url', '')
    if not url.startswith('http://') and not url.startswith('https://'):
        return None, 'URL must start with http:// or https://'
    if not is_public_url(url):
        return None, 'That URL points at a local or private address'

    source['type'] = (source.get('type') or 'static').lower()
    feed_url = (source.get('feed_url') or '').strip()
    if feed_url:
        if not feed_url.startswith('http://') and not feed_url.startswith('https://'):
            return None, 'Feed URL must start with http:// or https://'
        if not is_public_url(feed_url):
            return None, 'Feed URL points at a local or private address'
        source['feed_url'] = feed_url
    else:
        source.pop('feed_url', None)

    if source['type'] == 'static':
        if not source.get('selector'):
            source['selector'] = 'h2 a, h3 a'
    else:
        source.pop('selector', None)
        source.pop('fallback', None)

    source.setdefault('enabled', True)
    return source, None


COMMON_HEADLINE_SELECTORS = (
    'article h1 a', 'article h2 a', 'article h3 a',
    'main h1 a', 'main h2 a', 'main h3 a',
    'h1 a', 'h2 a', 'h3 a',
    '.post-title a', '.entry-title a', '.story-title a', '.article-title a',
    '.headline a', '.title a', '.card-title a',
    'a[rel="bookmark"]',
    'a[href*="/article/"]', 'a[href*="/articles/"]',
    'a[href*="/post/"]', 'a[href*="/posts/"]',
    'a[href*="/news/"]', 'a[href*="/blog/"]',
)

CARD_CLASS_HINTS = (
    'post', 'entry', 'article', 'story', 'headline', 'card', 'item', 'tile'
)


def _css_escape(value):
    """Enough CSS identifier escaping for class names emitted by real sites."""
    return ''.join(ch if ch.isalnum() or ch in ('-', '_') else '\\' + ch
                   for ch in value)


def _candidate_source(payload, source_type='static', feed_url=''):
    return {
        'name': (payload.get('name') or 'Preview').strip() or 'Preview',
        'url': payload['url'],
        'category': payload.get('category') or 'Other',
        'tier': payload.get('tier') or 'medium',
        'type': source_type,
        'feed_url': feed_url,
        'limit': 15,
    }


def _preview_articles(source, soup, selector):
    try:
        items = soup.select(selector)
    except Exception:                                      # noqa: BLE001
        return [], 0
    if not items:
        return [], 0
    return scraper.extract_articles_from_items(items, dict(source, selector=selector)), len(items)


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


def _derived_selectors(soup):
    selectors = []
    for anchor in soup.select('main a[href], article a[href], section a[href]'):
        text = ' '.join(anchor.get_text(' ', strip=True).split())
        if len(text) < 16:
            continue

        heading = anchor.find(['h1', 'h2', 'h3'])
        if heading:
            selectors.append(heading.name + ' a')
            selectors.append('article ' + heading.name + ' a')
            selectors.append('main ' + heading.name + ' a')

        for node in [anchor] + list(anchor.parents)[:4]:
            classes = node.get('class') or []
            useful = [cls for cls in classes
                      if any(hint in cls.lower() for hint in CARD_CLASS_HINTS)]
            for cls in useful[:2]:
                if node.name == 'a':
                    selectors.append('.' + _css_escape(cls))
                else:
                    selectors.append('.' + _css_escape(cls) + ' a')

        parsed = urlparse(anchor.get('href') or '')
        segments = [segment for segment in parsed.path.split('/') if segment]
        if segments:
            selectors.append('a[href*="/' + segments[0] + '/"]')

    return selectors


def _dedupe_selectors(selectors):
    seen = set()
    out = []
    for selector in selectors:
        selector = ' '.join(selector.split())
        if not selector or selector in seen:
            continue
        seen.add(selector)
        out.append(selector)
    return out


def _feed_links(soup, page_url):
    links = []
    for node in soup.select('link[rel~="alternate"][href]'):
        mime = (node.get('type') or '').lower()
        title = (node.get('title') or '').lower()
        href = node.get('href')
        if 'rss' in mime or 'atom' in mime or 'feed' in title:
            feed_url = urljoin(page_url, href)
            if feed_url not in links and is_public_url(feed_url):
                links.append(feed_url)
    return links[:4]


def _discover_feed_candidate(payload, feed_url):
    source = _candidate_source(payload, 'rss', feed_url)
    try:
        response = scraper.scraper.get(feed_url, timeout=15, allow_redirects=True)
    except Exception as exc:                              # noqa: BLE001
        return None
    if response.status_code != 200:
        return None
    articles = scraper.fetch_feed(source, response)
    if not articles:
        return None
    return {
        'kind': 'rss',
        'type': 'rss',
        'label': 'RSS feed',
        'selector': '',
        'fallback': '',
        'feed_url': feed_url,
        'match_count': len(articles),
        'count': len(articles),
        'confidence': min(99, 78 + min(len(articles), 12)),
        'preview': _preview_payload(articles),
    }


def _preview_payload(articles):
    return [{
        'title': a['title'],
        'link': a['link'],
        'signal_score': a['signal_score'],
        'category': a['category'],
    } for a in articles[:8]]


def _discover_static_candidates(payload, soup):
    source = _candidate_source(payload)
    selectors = _dedupe_selectors(COMMON_HEADLINE_SELECTORS + tuple(_derived_selectors(soup)))
    candidates = []

    for selector in selectors[:90]:
        articles, raw_count = _preview_articles(source, soup, selector)
        if len(articles) < 2:
            continue
        score = _candidate_score(selector, raw_count, len(articles))
        candidates.append({
            'kind': 'static',
            'type': 'static',
            'label': selector,
            'selector': selector,
            'fallback': '',
            'feed_url': '',
            'match_count': raw_count,
            'count': len(articles),
            'confidence': max(30, min(95, int(score / 2))),
            'rank_score': score,
            'preview': _preview_payload(articles),
        })

    candidates.sort(key=lambda item: (-item['rank_score'], item['selector']))
    for item in candidates:
        item.pop('rank_score', None)
    for index, item in enumerate(candidates):
        fallback = next((other['selector'] for other in candidates[index + 1:]
                         if other['selector'] != item['selector']), '')
        item['fallback'] = fallback
    return candidates[:8]


@app.route('/api/sources', methods=['POST'])
def add_source():
    payload = request.get_json(silent=True) or {}
    sources = list(scraper.sources)

    source, error = _clean_source_payload(payload)
    if error:
        return jsonify({'error': error}), 400
    if any(s['name'].lower() == source['name'].lower() for s in sources):
        return jsonify({'error': 'A source with that name already exists'}), 409

    sources.append(source)
    _write_sources(sources)
    return jsonify({'status': 'created', 'source': source}), 201


@app.route('/api/sources/discover', methods=['POST'])
def discover_source():
    """Find likely extraction options for a URL without model calls.

    The endpoint prefers feeds when a page advertises one, then falls back to
    deterministic CSS candidates ranked by the same extraction path used by the
    scraper. The browser still chooses; this just removes selector guesswork.
    """
    payload = request.get_json(silent=True) or {}
    url = (payload.get('url') or '').strip()
    if not url:
        return jsonify({'error': 'A URL is required'}), 400
    if not url.startswith('http://') and not url.startswith('https://'):
        return jsonify({'error': 'URL must start with http:// or https://'}), 400
    if not is_public_url(url):
        return jsonify({'error': 'That URL points at a local or private address'}), 400

    try:
        response = scraper.scraper.get(
            url,
            headers={'User-Agent': random.choice(scraper.user_agents)},
            timeout=20,
            allow_redirects=True
        )
    except Exception as exc:                              # noqa: BLE001
        return jsonify({'error': f'{type(exc).__name__}: {str(exc)[:160]}'}), 502

    if response.status_code != 200:
        return jsonify({'error': f'HTTP {response.status_code}',
                        'http_status': response.status_code}), 502
    if is_challenge_page(response.text):
        return jsonify({'error': 'Blocked by a bot challenge'}), 502

    page_url = response.url or url
    soup = BeautifulSoup(response.text, 'html.parser')
    working_payload = dict(payload, url=page_url)

    candidates = []
    for feed_url in _feed_links(soup, page_url):
        candidate = _discover_feed_candidate(working_payload, feed_url)
        if candidate:
            candidates.append(candidate)

    candidates.extend(_discover_static_candidates(working_payload, soup))
    candidates = candidates[:8]

    return jsonify({
        'url': url,
        'fetched_url': page_url,
        'count': len(candidates),
        'candidates': candidates,
    })


@app.route('/api/sources/<name>', methods=['PATCH', 'DELETE'])
def edit_source(name):
    sources = list(scraper.sources)
    index = next((i for i, s in enumerate(sources)
                  if s['name'].lower() == name.lower()), None)
    if index is None:
        return jsonify({'error': 'No such source'}), 404

    if request.method == 'DELETE':
        removed = sources.pop(index)
        _write_sources(sources)
        scraper.health.pop(removed['name'], None)
        scraper.save_health()
        return jsonify({'status': 'deleted', 'name': removed['name']})

    payload = request.get_json(silent=True) or {}
    source, error = _clean_source_payload(payload, existing=sources[index])
    if error:
        return jsonify({'error': error}), 400

    sources[index] = source
    _write_sources(sources)

    # A disabled source keeps its row but stops being scraped.
    if source.get('enabled') is False and source['name'] in scraper.health:
        scraper.health[source['name']]['state'] = 'disabled'
        scraper.save_health()

    return jsonify({'status': 'updated', 'source': source})


@app.route('/api/sources/test', methods=['POST'])
def test_source():
    """Dry-run a selector against a live page without saving anything.

    This is the difference between "add a source and wait 30 minutes to find out
    it was wrong" and seeing the five headlines it would have produced.
    """
    payload = request.get_json(silent=True) or {}
    source, error = _clean_source_payload(dict(payload, name=payload.get('name') or 'Preview'))
    if error:
        return jsonify({'error': error}), 400

    articles, health = scraper.scrape_source(dict(source, retries=1))

    return jsonify({
        'state': health['state'],
        'http_status': health['http_status'],
        'error': health['error'],
        'duration_ms': health['duration_ms'],
        'count': len(articles),
        'preview': [{
            'title': a['title'],
            'link': a['link'],
            'signal_score': a['signal_score'],
            'category': a['category'],
        } for a in articles[:8]],
    })


# == Refresh ==================================================================

@app.route('/api/refresh', methods=['POST'])
def refresh():
    """Start a scrape and return straight away.

    202 plus a job id: the caller polls /api/refresh/status. A synchronous
    scrape here would hold the request open for minutes and time out behind any
    proxy.
    """
    if store.is_remote():
        # Serverless. A daemon thread is frozen along with the instance as soon
        # as this response is sent, and the client's status polls would land on
        # a different instance with no memory of the job in any case. So scrape
        # inline on a short budget -- least-recently-checked sources first --
        # and hand back an already-finished job for the client to act on.
        start_refresh(background=False,
                      deadline=time.time() + MANUAL_SCRAPE_BUDGET_SECONDS)
        with refresh_lock:
            snapshot = dict(refresh_job)
        return jsonify({'status': 'completed', 'job': snapshot}), 200

    job_id, started = start_refresh()
    with refresh_lock:
        snapshot = dict(refresh_job)
    return jsonify({'status': 'started' if started else 'already_running',
                    'job': snapshot}), 202


@app.route('/api/refresh/status')
def refresh_status():
    with refresh_lock:
        snapshot = dict(refresh_job)
    snapshot['count'] = len(cached_articles)
    return jsonify(snapshot)


# == Stats ====================================================================

@app.route('/api/stats')
def get_stats():
    sources = set(a['source'] for a in cached_articles)
    categories = set(article_category(a) for a in cached_articles)
    scores = [a.get('signal_score', 0) for a in cached_articles]
    high_signal = [s for s in scores if s >= SCORE_HIGH]

    health = scraper.health_summary()
    failing = [h for h in health if h['state'] in ('error', 'empty')]

    next_run = getattr(scrape_job, 'next_run_time', None)
    with refresh_lock:
        job = dict(refresh_job)

    return jsonify({
        'total_articles': len(cached_articles),
        'total_sources': len(sources),
        'total_categories': len(categories),
        'high_signal_count': len(high_signal),
        'avg_score': round(sum(scores) / len(scores)) if scores else 0,
        'last_update': last_scrape_at.isoformat() if last_scrape_at else None,
        'next_update': next_run.isoformat() if next_run else None,
        'thresholds': {'high': SCORE_HIGH, 'mid': SCORE_MID},
        'sources_configured': len(health),
        'sources_ok': sum(1 for h in health if h['state'] == 'ok'),
        'sources_failing': len(failing),
        'sources_disabled': sum(1 for h in health if h['state'] == 'disabled'),
        'failing_names': [h['name'] for h in failing][:12],
        'refresh': job,
    })


@app.route('/api/health')
def health_check():
    """Liveness plus freshness, for uptime checks and the stale banner."""
    age = (datetime.now() - last_scrape_at).total_seconds() \
        if last_scrape_at else None
    return jsonify({
        'status': 'ok' if cached_articles else 'empty',
        'articles': len(cached_articles),
        'age_seconds': age,
        'stale': age is None or age > STALE_AFTER.total_seconds(),
    })


# == Export ===================================================================

@app.route('/api/export.json')
def export_json():
    """The corpus as a file, so a scrape can feed something other than this UI."""
    response = jsonify({
        'generated_at': last_scrape_at.isoformat() if last_scrape_at else None,
        'count': len(cached_articles),
        'articles': cached_articles,
    })
    response.headers['Content-Disposition'] = 'attachment; filename=high-signal.json'
    return response


@app.route('/feed.xml')
def export_rss():
    """RSS out. Whatever the reader already uses can subscribe to the top of it.

    Aimed at strict RSS 2.0 so the widest range of readers and validators take
    it as-is: <source> carries the required `url`, the channel advertises its
    own address via atom:link, and every element a reader might key off
    (pubDate, guid, category, dc:creator) is present on every item.
    """
    min_score = request.args.get('min_score', SCORE_MID, type=int)
    limit = request.args.get('limit', 60, type=int)
    articles = sort_articles([a for a in cached_articles
                              if a.get('signal_score', 0) >= min_score],
                             'recent')[:limit]

    items = []
    for article in articles:
        stamp = article_time(article)
        name = article['source']
        items.append(
            '<item>'
            f'<title>{xml_escape(article["title"])}</title>'
            f'<link>{xml_escape(article["link"])}</link>'
            f'<guid isPermaLink="false">{xml_escape(article["id"])}</guid>'
            f'<dc:creator>{xml_escape(name)}</dc:creator>'
            + source_element(name)
            + f'<category>{xml_escape(article_category(article))}</category>'
            # Readers that render only the description (and link unfurlers)
            # show a blank row for the ~90% of items with no summary yet, so
            # fall back to the headline rather than shipping an empty body.
            f'<description>{xml_escape(article.get("summary") or article["title"])}</description>'
            + (f'<pubDate>{format_datetime(stamp)}</pubDate>'
               if stamp != datetime.min else '')
            + '</item>')

    built = last_scrape_at or datetime.now()
    xml = ('<?xml version="1.0" encoding="UTF-8"?>'
           '<rss version="2.0"'
           ' xmlns:atom="http://www.w3.org/2005/Atom"'
           ' xmlns:dc="http://purl.org/dc/elements/1.1/">'
           '<channel>'
           '<title>High Signal</title>'
           f'<link>{xml_escape(request.url_root)}</link>'
           '<description>AI and tech headlines, ranked by signal score.</description>'
           '<language>en-us</language>'
           '<generator>High Signal</generator>'
           '<docs>https://www.rssboard.org/rss-specification</docs>'
           f'<ttl>{SCRAPE_INTERVAL_MINUTES}</ttl>'
           f'<lastBuildDate>{format_datetime(built)}</lastBuildDate>'
           f'<atom:link rel="self" type="application/rss+xml"'
           f' href="{xml_escape(request.url, {chr(34): "&quot;"})}"/>'
           + ''.join(items) +
           '</channel></rss>')

    return Response(xml, mimetype='application/rss+xml')


# == Schedule =================================================================

scheduler = BackgroundScheduler()
scrape_job = scheduler.add_job(func=lambda: start_refresh(), trigger='interval',
                               minutes=SCRAPE_INTERVAL_MINUTES)

def owns_background():
    """True in exactly one process, so the boot scrape never runs twice.

    Werkzeug's reloader imports this module in both a parent and a child; only
    the child sets WERKZEUG_RUN_MAIN. Under gunicorn or a plain `flask run`
    there is no reloader and no such variable, and this process owns the work.
    """
    if os.environ.get('WERKZEUG_RUN_MAIN') == 'true':
        return True
    reloader_expected = __name__ == '__main__' or \
        os.environ.get('FLASK_DEBUG', '').lower() in ('1', 'true')
    return not reloader_expected


if store.is_remote():
    # Serverless. There is no process to own a scheduler and no boot to speak
    # of: the scheduled scrape runs in CI (scrape_job.py) and publishes to the
    # Blob store, and each instance hydrates itself from that on first use.
    print('▲ Serverless mode — scheduled scraping runs in CI')
elif owns_background():
    scheduler.start()
    boot()
    atexit.register(lambda: scheduler.shutdown(wait=False))

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)
