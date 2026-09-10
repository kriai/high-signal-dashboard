"""Reusable Python scrape and document preparation, independent of Flask."""

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from email.utils import format_datetime
import hashlib
import json
import math
import os
import time
from urllib.parse import urlparse
from xml.sax.saxutils import escape as xml_escape

from d1_store import Document, Publication, D1Error
from scraper import (CATEGORIES, HighSignalScraper, is_generated_summary,
                     parse_iso, utc_now)
from source_config import is_public_url


SCORE_HIGH = 75
SCORE_MID = 60

# Measured on the Cloudflare preview: a 154 KB dashboard document answers every
# read inside the 10 ms Workers Free CPU budget, while a synthetic 727 KB one
# pushed uncached filtered compatibility queries to 22-38 ms. Publishing past
# this size is allowed, but it is where those legacy endpoints start risking
# Error 1102, so the job says so rather than failing quietly later.
DOCUMENT_BUDGET_BYTES = 300_000
SUMMARY_FIELDS = ('summary', 'summary_source', 'summary_checked_at',
                  'summary_error')


# A run that reached fewer than this share of the enabled sources is treated as
# an outage rather than a refresh, so the previous publication stays active. It
# is a starting product default, not a measurement; operators can move it with
# SCRAPE_MIN_SOURCE_COVERAGE once shadow runs show what coverage is normal.
DEFAULT_MIN_SOURCE_COVERAGE = 0.5


def run_scrape(sources, previous=None, warm_limit=100, warm_min_score=SCORE_MID,
               warm_budget_seconds=90, warm_workers=8,
               scrape_budget_seconds=600,
               min_source_coverage=DEFAULT_MIN_SOURCE_COVERAGE):
    """Run the existing scraper without importing Flask or writing state."""
    scraper = HighSignalScraper(sources=sources)
    previous = previous or {}
    articles = previous.get('articles') or []
    health = previous.get('health') or []
    scraper.articles = articles
    scraper.previous_by_id = {
        article['id']: article for article in articles if article.get('id')
    }
    scraper.health = {
        row['name']: row for row in health if isinstance(row, dict) and row.get('name')
    }
    scraper.last_run = previous.get('generated_at')
    if previous.get('scraper_state') is not None:
        scraper.load_scraper_state(previous['scraper_state'])
    else:
        scraper._migrate_source_batches(articles, health)

    scrape_deadline = (time.time() + max(1, scrape_budget_seconds)
                       if scrape_budget_seconds is not None else None)
    scraped = scraper.scrape_all(
        deadline=scrape_deadline, persist_health=False)
    normalize_summaries(scraped)
    coverage = _coverage(scraper, min_source_coverage)
    try:
        _validate_run(scraped, coverage)
    except D1Error as exc:
        _write_run_report(scraper, scraped, coverage, str(exc))
        raise
    warmed, attempted = warm_summaries(
        scraper, scraped, warm_limit, warm_min_score,
        warm_budget_seconds, warm_workers)
    result = {
        'version': 3,
        'generated_at': scraper.last_run,
        'articles': scraped,
        'health': list(scraper.health.values()),
        'scraper_state': scraper.scraper_state_payload(),
        'run_stats': dict(scraper.run_stats),
        'summary_warm': {'warmed': warmed, 'attempted': attempted},
    }
    if (articles and len(scraped) < len(articles) / 2 and
            {row.get('name') for row in health} ==
            {source.get('name') for source in sources}):
        result['warnings'] = [
            f'Article count fell from {len(articles)} to {len(scraped)} '
            'with the same configured source names']
    else:
        result['warnings'] = []
    result['source_coverage'] = coverage
    _write_run_report(scraper, scraped, coverage, None, result['warnings'])
    return result


def normalize_summaries(articles):
    for article in articles:
        if is_generated_summary(article.get('summary')):
            article['summary'] = ''
            article['summary_source'] = ''
        elif article.get('summary') and not article.get('summary_source'):
            article['summary_source'] = 'cached'
        else:
            article.setdefault('summary_source', '')


def warm_summaries(scraper, articles, limit=100, min_score=SCORE_MID,
                   budget_seconds=90, workers=8):
    targets = [article for article in articles
               if not article.get('summary')
               and not article.get('is_stale')
               and article.get('signal_score', 0) >= min_score
               and _is_public_http_url(article.get('link') or '')]
    targets.sort(key=lambda article: article.get('signal_score', 0), reverse=True)
    targets = _round_robin_hosts(targets[:max(limit, 0)])
    if not targets:
        return 0, 0
    deadline = time.time() + max(budget_seconds, 0)

    def fetch(article):
        if time.time() >= deadline:
            return None
        return article, scraper.fetch_article_summary(article)

    warmed = 0
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        for result in pool.map(fetch, targets):
            if result is None:
                continue
            article, (summary, source, error) = result
            if source == 'metadata':
                continue
            article['summary'] = summary
            article['summary_source'] = source
            article['summary_checked_at'] = datetime.now().isoformat()
            if error:
                article['summary_error'] = error
            else:
                article.pop('summary_error', None)
            warmed += 1
    return warmed, len(targets)


def prepare_publication(snapshot, sources, public_origin='https://high-signal.invalid'):
    """Build immutable documents consumed by the Worker and compatibility APIs."""
    generated_at = snapshot.get('generated_at')
    articles = snapshot.get('articles')
    health = snapshot.get('health')
    scraper_state = snapshot.get('scraper_state') or {'version': 1, 'sources': {}}
    if not generated_at or not parse_iso(generated_at):
        raise D1Error('Snapshot generated_at is missing or invalid')
    if not isinstance(articles, list) or not isinstance(health, list):
        raise D1Error('Snapshot articles and health must be lists')

    publication_seed = _json_text({
        'generated_at': generated_at,
        'articles': articles,
        'health': health,
        'scraper_state': scraper_state,
    })
    publication_id = 'pub-' + hashlib.sha256(
        publication_seed.encode('utf-8')).hexdigest()[:24]
    source_status = build_source_status(sources, health, articles)
    stats = build_stats(sources, health, articles, generated_at)
    stats['run'] = snapshot.get('run_stats') or {}
    stats['warnings'] = snapshot.get('warnings') or []
    dashboard = {
        'schema_version': 1,
        'publication_id': publication_id,
        'generated_at': generated_at,
        'articles': articles,
        'stats': stats,
        'sources': source_status,
    }
    export = {
        'generated_at': generated_at,
        'count': len(articles),
        'articles': articles,
    }
    documents = (
        Document('dashboard', _json_text(dashboard)),
        Document('export', _json_text(export)),
        Document('rss_default', build_rss(
            articles, sources, generated_at, public_origin),
                 'application/rss+xml; charset=utf-8'),
        # Prepared so the Worker can answer the two most-used compatibility
        # reads, and its own status reads, without parsing the feed document:
        # that parse alone costs 7-15 ms of a 10 ms Free-plan CPU budget.
        Document('stats', _json_text(stats)),
        Document('sources', _json_text(source_status)),
        # Private continuation state. The Worker has no route for this key;
        # the next scheduled publisher loads it by exact publication id.
        Document('scraper_state', _json_text(scraper_state)),
    )
    return Publication(publication_id, generated_at, documents)


def build_stats(sources, health, articles, generated_at):
    source_names = {article.get('source') for article in articles}
    categories = {article_category(article) for article in articles}
    scores = [article.get('signal_score', 0) for article in articles]
    failing = [row for row in health if row.get('state') in ('error', 'empty')]
    return {
        'total_articles': len(articles),
        'total_sources': len(source_names),
        'total_categories': len(categories),
        'high_signal_count': sum(score >= SCORE_HIGH for score in scores),
        'avg_score': round(sum(scores) / len(scores)) if scores else 0,
        'last_update': generated_at,
        'storage_error': None,
        'refresh_mode': 'check',
        'next_update': None,
        'thresholds': {'high': SCORE_HIGH, 'mid': SCORE_MID},
        'sources_configured': len(sources),
        'sources_ok': sum(row.get('state') == 'ok' for row in health),
        'sources_failing': len(failing),
        'sources_disabled': sum(row.get('state') == 'disabled' for row in health),
        'failing_names': [row.get('name') for row in failing[:12]],
        'refresh': {'state': 'idle', 'count': len(articles)},
    }


def build_source_status(sources, health, articles):
    health_by_name = {row.get('name'): row for row in health}
    live_counts = {}
    for article in articles:
        name = article.get('source')
        live_counts[name] = live_counts.get(name, 0) + 1
    rows = []
    for source in sources:
        row = dict(health_by_name.get(source.get('name')) or {
            'name': source.get('name'), 'url': source.get('url', ''),
            'tier': source.get('tier', 'medium'),
            'category': source.get('category', ''),
            'enabled': source.get('enabled', True) is not False,
            'state': 'pending', 'articles': 0, 'http_status': None,
            'error': None, 'attempts': 0, 'duration_ms': 0,
            'checked_at': None, 'last_success': None,
            'consecutive_failures': 0,
        })
        row['count'] = live_counts.get(row['name'], 0)
        rows.append(row)
    rows.sort(key=lambda row: (
        {'error': 0, 'empty': 1, 'pending': 2, 'disabled': 3, 'ok': 4}
        .get(row.get('state'), 5), -row['count'], row['name'].lower()))
    states = {}
    for row in rows:
        states[row['state']] = states.get(row['state'], 0) + 1
    return {
        'sources': rows,
        'total': len(rows),
        'ok': states.get('ok', 0),
        'failing': states.get('error', 0) + states.get('empty', 0),
        'disabled': states.get('disabled', 0),
        'states': states,
    }


def build_rss(articles, sources, generated_at, public_origin):
    source_by_name = {source.get('name'): source for source in sources}
    selected = sorted(
        [article for article in articles
         if article.get('signal_score', 0) >= SCORE_MID],
        key=lambda article: (article_time(article), article.get('signal_score', 0)),
        reverse=True)[:60]
    items = []
    for article in selected:
        name = article['source']
        source = source_by_name.get(name) or {}
        source_url = source.get('feed_url') or source.get('url')
        source_xml = (f'<source url="{_xml(source_url)}">{_xml(name)}</source>'
                      if source_url else '')
        stamp = article_time(article)
        items.append(
            '<item>'
            f'<title>{_xml(article["title"])}</title>'
            f'<link>{_xml(article["link"])}</link>'
            f'<guid isPermaLink="false">{_xml(article["id"])}</guid>'
            f'<dc:creator>{_xml(name)}</dc:creator>'
            f'{source_xml}'
            f'<category>{_xml(article_category(article))}</category>'
            f'<description>{_xml(article.get("summary") or article["title"])}</description>'
            f'<pubDate>{format_datetime(stamp)}</pubDate>'
            '</item>')
    built = parse_iso(generated_at) or datetime.now()
    origin = public_origin.rstrip('/') + '/'
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" '
        'xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>'
        '<title>High Signal</title>'
        f'<link>{_xml(origin)}</link>'
        '<description>AI and tech headlines, ranked by signal score.</description>'
        '<language>en-us</language><generator>High Signal</generator>'
        '<docs>https://www.rssboard.org/rss-specification</docs><ttl>30</ttl>'
        f'<lastBuildDate>{format_datetime(built)}</lastBuildDate>'
        f'<atom:link rel="self" type="application/rss+xml" href="{_xml(origin + "feed.xml")}"/>'
        + ''.join(items) + '</channel></rss>')


def previous_snapshot(document, scraper_state_document=None):
    if not document:
        return None
    try:
        dashboard = json.loads(document['body_text'])
    except (KeyError, TypeError, ValueError) as exc:
        raise D1Error('Active dashboard document is invalid JSON') from exc
    state = None
    if scraper_state_document:
        try:
            state = json.loads(scraper_state_document['body_text'])
        except (KeyError, TypeError, ValueError) as exc:
            raise D1Error('Active scraper state document is invalid JSON') from exc
    return {
        'generated_at': dashboard.get('generated_at'),
        'articles': dashboard.get('articles') or [],
        'health': ((dashboard.get('sources') or {}).get('sources') or []),
        'scraper_state': state,
    }


def article_category(article):
    return article.get('category') or 'Other'


def article_time(article):
    return (parse_iso(article.get('published')) or
            parse_iso(article.get('first_seen')) or
            parse_iso(article.get('timestamp')) or datetime.min)


def _coverage(scraper, min_source_coverage=None):
    """Current-run source success, as the publication gate measures it."""
    if min_source_coverage is None:
        min_source_coverage = os.environ.get(
            'SCRAPE_MIN_SOURCE_COVERAGE', DEFAULT_MIN_SOURCE_COVERAGE)
    threshold = min(max(float(min_source_coverage), 0.0), 1.0)
    enabled = len([source for source in scraper.sources
                   if source.get('enabled', True) is not False])
    succeeded = int(scraper.run_stats.get('succeeded') or 0)
    return {
        'succeeded': succeeded,
        'enabled': enabled,
        'threshold': threshold,
        'required': math.ceil(enabled * threshold),
    }


def _validate_run(articles, coverage):
    enabled = coverage['enabled']
    succeeded = coverage['succeeded']
    if enabled and succeeded == 0:
        raise D1Error('All enabled sources failed; previous publication retained')
    if enabled and succeeded < coverage['required']:
        raise D1Error(
            f'Only {succeeded}/{enabled} enabled sources succeeded this run; '
            f"at least {coverage['required']} are required to publish")
    if not articles:
        raise D1Error('Scrape produced no articles; previous publication retained')


def _round_robin_hosts(articles):
    buckets = {}
    for article in articles:
        host = (urlparse(article.get('link') or '').hostname or '').lower()
        buckets.setdefault(host, []).append(article)
    ordered = []
    while buckets:
        for host in list(buckets):
            ordered.append(buckets[host].pop(0))
            if not buckets[host]:
                del buckets[host]
    return ordered


def _is_public_http_url(url):
    return is_public_url(url)


def _json_text(payload):
    return json.dumps(payload, ensure_ascii=False, separators=(',', ':'))


def _xml(value):
    return xml_escape(str(value or ''), {'"': '&quot;'})


def settings_from_env():
    return {
        'warm_limit': int(os.environ.get('SUMMARY_WARM_LIMIT', 100)),
        'warm_min_score': int(os.environ.get('SUMMARY_WARM_MIN_SCORE', SCORE_MID)),
        'warm_budget_seconds': int(os.environ.get('SUMMARY_WARM_BUDGET_SECONDS', 90)),
        'warm_workers': int(os.environ.get('SUMMARY_WARM_WORKERS', 8)),
        'scrape_budget_seconds': int(os.environ.get(
            'SCRAPE_BUDGET_SECONDS', 600)),
        'min_source_coverage': float(os.environ.get(
            'SCRAPE_MIN_SOURCE_COVERAGE', DEFAULT_MIN_SOURCE_COVERAGE)),
        # _coverage clamps this to 0-1; the gate still rejects a run where every
        # enabled source failed, whatever the configured share.
    }


def _write_run_report(scraper, articles, coverage, error=None, warnings=None):
    path = os.environ.get('SCRAPE_REPORT_PATH')
    if not path:
        return
    report = {
        'schema_version': 1,
        'generated_at': utc_now(),
        'status': 'rejected' if error else 'accepted',
        'error': error,
        'run': dict(scraper.run_stats),
        'source_coverage': coverage,
        'article_count': len(articles),
        'warnings': warnings or [],
        'sources': list(scraper.health.values()),
    }
    try:
        with open(path, 'w') as handle:
            json.dump(report, handle, ensure_ascii=False, indent=2)
            handle.write('\n')
    except OSError as exc:
        print(f'⚠️  Could not write scrape report: {exc}')
