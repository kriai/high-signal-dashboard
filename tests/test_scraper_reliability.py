"""Regression tests for source extraction, transport, and retained batches."""

import copy
from datetime import datetime, timedelta, timezone
import json
import os
import unittest
from unittest.mock import patch

from bs4 import BeautifulSoup
import requests

from d1_store import D1Error
from pipeline import prepare_publication, previous_snapshot, run_scrape
from scraper import HighSignalScraper, LISTING_FETCH_LIMIT
from source_config import (SourceConfigError, normalize_source,
                           split_css_selectors, validate_sources)


SOURCE = {
    'name': 'Example', 'url': 'https://example.com/', 'type': 'static',
    'tier': 'high', 'category': 'AI Research',
    'selector': '.primary a', 'fallback': 'article h2 a', 'retries': 3,
}


def response(status=200, text='', url='https://example.com/', content_type='text/html'):
    item = requests.Response()
    item.status_code = status
    item.url = url
    item.headers['content-type'] = content_type
    item._content = text.encode('utf-8')
    item.encoding = 'utf-8'
    return item


class ExtractionReliabilityTests(unittest.TestCase):
    def test_checked_in_source_repairs_validate(self):
        with open('sources.json') as handle:
            sources = validate_sources(json.load(handle)['sources'])
        by_name = {source['name']: source for source in sources}
        self.assertEqual(by_name['Last Week in AI']['feed_url'],
                         'https://lastweekin.ai/feed')
        self.assertEqual(by_name['The Information']['feed_url'],
                         'https://www.theinformation.com/feed')
        for name in ('State of AI', 'Axios Pro Rata', 'Term Sheet (Fortune)',
                     'The Information Startup'):
            self.assertFalse(by_name[name]['enabled'])

    def test_css_splitter_preserves_nested_and_quoted_commas(self):
        value = ':is(h2, h3) a, a[data-label="news,analysis"],article h4 a'
        self.assertEqual(split_css_selectors(value), [
            ':is(h2, h3) a', 'a[data-label="news,analysis"]', 'article h4 a'])

    def test_primary_junk_falls_through_to_usable_fallback(self):
        soup = BeautifulSoup(
            '<div class="primary"><a href="/about">About us</a></div>'
            '<article><h2><a href="/news/model">Researchers release a new model</a>'
            '</h2></article>', 'html.parser')
        scraper = HighSignalScraper(sources=[SOURCE])

        articles, diagnostics = scraper.extract_static_articles(soup, SOURCE)

        self.assertEqual([article['title'] for article in articles],
                         ['Researchers release a new model'])
        self.assertEqual(diagnostics['selector_used'], 'article h2 a')
        self.assertEqual(diagnostics['rejected_counts']['junk'], 1)

    def test_invalid_primary_selector_is_reported_and_fallback_still_works(self):
        source = dict(SOURCE, selector='[broken', fallback='article h2 a')
        soup = BeautifulSoup(
            '<article><h2><a href="/news/model">Researchers release a new model</a>'
            '</h2></article>', 'html.parser')

        articles, diagnostics = HighSignalScraper(
            sources=[source]).extract_static_articles(soup, source)

        self.assertEqual(len(articles), 1)
        self.assertEqual(len(diagnostics['invalid_selectors']), 1)

    def test_relative_link_uses_redirected_document_url(self):
        source = dict(SOURCE, url='https://example.com/archive')
        source['_document_url'] = 'https://cdn.example.com/edition/'
        soup = BeautifulSoup(
            '<article><h2><a href="today/model">Researchers release a new model</a>'
            '</h2></article>', 'html.parser')
        items = soup.select('article h2 a')

        articles = HighSignalScraper(sources=[SOURCE]).extract_articles_from_items(
            items, source)

        self.assertEqual(articles[0]['link'],
                         'https://cdn.example.com/edition/today/model')

    def test_heading_inside_anchor_discovery_structure_is_extractable(self):
        soup = BeautifulSoup(
            '<main><a class="story-card" href="/story/model"><h3>'
            'Researchers release a new model</h3></a></main>', 'html.parser')
        scraper = HighSignalScraper(sources=[SOURCE])
        source = dict(SOURCE, selector='main a h3', fallback='')

        articles, diagnostics = scraper.extract_static_articles(soup, source)

        self.assertEqual(len(articles), 1)
        self.assertEqual(diagnostics['selector_used'], 'main a h3')

    def test_source_scope_rejects_wrong_host(self):
        source = dict(SOURCE, allowed_hosts=['example.com'])
        soup = BeautifulSoup(
            '<article><h2><a href="https://ads.example.net/story/model">'
            'Researchers release a new model</a></h2></article>', 'html.parser')
        diagnostics = {}

        articles = HighSignalScraper(sources=[SOURCE]).extract_articles_from_items(
            soup.select('a'), source, diagnostics)

        self.assertEqual(articles, [])
        self.assertEqual(diagnostics['rejected_counts']['outside_source_scope'], 1)


class TransportReliabilityTests(unittest.TestCase):
    def setUp(self):
        self.scraper = HighSignalScraper(sources=[SOURCE])
        self.resolver = patch('scraper.public_host_addresses', return_value=True)
        self.resolver.start()
        self.addCleanup(self.resolver.stop)

    def test_bad_retry_config_becomes_health_error(self):
        articles, health = self.scraper.scrape_source(dict(SOURCE, retries='bad'))
        self.assertEqual(articles, [])
        self.assertEqual(health['failure_kind'], 'invalid_config')
        self.assertEqual(health['attempts'], 0)

    def test_403_is_not_retried(self):
        with patch.object(self.scraper.scraper, 'get',
                          return_value=response(403)) as get, \
                patch('scraper.time.sleep') as sleep:
            _, health = self.scraper.scrape_source(SOURCE)
        self.assertEqual(get.call_count, 1)
        sleep.assert_not_called()
        self.assertEqual(health['failure_kind'], 'blocked')

    def test_transient_failure_retries_without_final_sleep(self):
        with patch.object(self.scraper.scraper, 'get', side_effect=[
                response(503), response(503), response(503)]) as get, \
                patch('scraper.time.sleep') as sleep:
            _, health = self.scraper.scrape_source(SOURCE)
        self.assertEqual(get.call_count, 3)
        self.assertEqual(sleep.call_count, 2)
        self.assertEqual(health['failure_kind'], 'network')

    def test_challenge_html_is_detected_before_feed_parser(self):
        source = dict(SOURCE, type='rss', feed_url='https://example.com/feed')
        challenge = '<title>Just a moment...</title><div>challenge-platform</div>'
        with patch.object(self.scraper.scraper, 'get',
                          return_value=response(200, challenge,
                                                'https://example.com/feed')) as get:
            _, health = self.scraper.scrape_source(source)
        self.assertEqual(get.call_count, 1)
        self.assertEqual(health['failure_kind'], 'blocked')

    def test_configured_strategy_falls_back_after_permanent_failure(self):
        source = dict(SOURCE, fetch_strategies=[
            {'id': 'feed', 'type': 'rss', 'url': 'https://feeds.example.com/feed'},
            {'id': 'page', 'type': 'static', 'url': 'https://example.com/news',
             'selectors': ['article h2 a']},
        ])
        html = ('<article><h2><a href="/story/model">'
                'Researchers release a new model</a></h2></article>')
        with patch.object(self.scraper.scraper, 'get', side_effect=[
                response(403, url='https://feeds.example.com/feed'),
                response(200, html, 'https://example.com/news')]) as get:
            articles, health = self.scraper.scrape_source(source)
        self.assertEqual(get.call_count, 2)
        self.assertEqual(len(articles), 1)
        self.assertEqual(health['strategy_id'], 'page')

    def test_retry_after_is_honored_and_same_host_alternative_is_suppressed(self):
        source = dict(SOURCE, fetch_strategies=[
            {'id': 'first', 'type': 'rss', 'url': 'https://example.com/feed'},
            {'id': 'second', 'type': 'rss', 'url': 'https://example.com/other'},
        ], retries=1)
        limited = response(429, url='https://example.com/feed')
        limited.headers['retry-after'] = '1'
        with patch.object(self.scraper.scraper, 'get', return_value=limited) as get, \
                patch('scraper.time.sleep') as sleep:
            _, health = self.scraper.scrape_source(source)
        self.assertEqual(get.call_count, 1)
        sleep.assert_not_called()
        self.assertEqual(health['failure_kind'], 'rate_limited')

    def test_redirect_hop_to_private_target_is_never_requested(self):
        moved = response(302, url='https://example.com/')
        moved.headers['location'] = 'http://127.0.0.1/private'
        with patch.object(self.scraper.scraper, 'get', return_value=moved) as get:
            _, health = self.scraper.scrape_source(SOURCE)
        self.assertEqual(get.call_count, 1)
        self.assertEqual(health['failure_kind'], 'invalid_config')

    def test_oversized_response_is_bounded(self):
        with patch.object(self.scraper.scraper, 'get', return_value=response(
                200, 'x' * (LISTING_FETCH_LIMIT + 1))):
            _, health = self.scraper.scrape_source(SOURCE)
        self.assertEqual(health['failure_kind'], 'response_too_large')

    def test_private_redirect_is_rejected(self):
        redirected = response(200, '<html></html>', 'http://127.0.0.1/private')
        with patch.object(self.scraper.scraper, 'get', return_value=redirected):
            _, health = self.scraper.scrape_source(SOURCE)
        self.assertEqual(health['failure_kind'], 'invalid_config')

    def test_json_malformed_child_does_not_hide_valid_sibling(self):
        source = dict(SOURCE, type='json', feed_url='https://example.com/list.json',
                      limit=1)
        body = json.dumps({'data': {'children': [None, {'data': {
            'title': 'Researchers release a new model',
            'url': 'https://example.com/story/model', 'created_utc': 1,
        }}]}})
        with patch.object(self.scraper.scraper, 'get', return_value=response(
                200, body, 'https://example.com/list.json', 'application/json')):
            articles, health = self.scraper.scrape_source(source)
        self.assertEqual(len(articles), 1)
        self.assertEqual(health['rejected_counts']['item_error'], 1)

    def test_feed_deduplicates_before_applying_limit(self):
        source = dict(SOURCE, type='rss', feed_url='https://example.com/feed',
                      limit=2)
        body = '''<rss version="2.0"><channel>
          <item><title>Researchers release a new model</title>
            <link>https://example.com/story/model</link></item>
          <item><title>Researchers release a new model</title>
            <link>https://example.com/story/model</link></item>
          <item><title>Company raises 40 million for chip factory</title>
            <link>https://example.com/story/factory</link></item>
        </channel></rss>'''
        with patch.object(self.scraper.scraper, 'get', return_value=response(
                200, body, 'https://example.com/feed', 'application/rss+xml')):
            articles, _ = self.scraper.scrape_source(source)
        self.assertEqual(len(articles), 2)


class RetentionReliabilityTests(unittest.TestCase):
    def article(self, scraper, source=SOURCE):
        return scraper.build_article(
            source, 'Researchers release a new model',
            'https://example.com/story/model')

    def test_failure_retains_last_good_batch_without_marking_health_ok(self):
        scraper = HighSignalScraper(sources=[SOURCE])
        fresh = self.article(scraper)
        success = {'name': 'Example', 'state': 'ok', 'articles': 1,
                   'attempted': True, 'last_success': '2026-09-10T10:00:00Z',
                   'consecutive_failures': 0}
        with patch.object(scraper, 'scrape_source', return_value=([fresh], success)), \
                patch('scraper.time.sleep'):
            scraper.scrape_all(persist_health=False)
        failure = {'name': 'Example', 'state': 'error', 'articles': 0,
                   'attempted': True, 'last_success': '2026-09-10T10:00:00Z',
                   'consecutive_failures': 1, 'error': 'HTTP 403'}
        with patch.object(scraper, 'scrape_source', return_value=([], failure)), \
                patch('scraper.time.sleep'):
            articles = scraper.scrape_all(persist_health=False)

        self.assertEqual(len(articles), 1)
        self.assertTrue(articles[0]['is_stale'])
        self.assertEqual(scraper.health['Example']['state'], 'error')
        self.assertEqual(scraper.health['Example']['retained_articles'], 1)

    def test_retention_expiry_and_semantic_edit_drop_batch(self):
        scraper = HighSignalScraper(sources=[SOURCE])
        normalized = normalize_source(SOURCE)
        article = self.article(scraper)
        old = (datetime.now(timezone.utc) - timedelta(hours=73)).isoformat()
        from source_config import config_fingerprint, source_key
        scraper.source_batches[source_key(SOURCE)] = {
            'name': 'Example', 'config_fingerprint': config_fingerprint(normalized),
            'last_good_fetch_at': old, 'articles': [article],
        }
        self.assertEqual(scraper._retained_articles(SOURCE), [])

        recent = datetime.now(timezone.utc).isoformat()
        scraper.source_batches[source_key(SOURCE)]['last_good_fetch_at'] = recent
        self.assertEqual(scraper._retained_articles(
            dict(SOURCE, selector='.changed a')), [])

    def test_disabled_source_does_not_increment_failure_count(self):
        source = dict(SOURCE, enabled=False)
        scraper = HighSignalScraper(sources=[source])
        scraper.health['Example'] = {
            'name': 'Example', 'state': 'error', 'consecutive_failures': 4,
            'checked_at': '2026-09-10T10:00:00Z'}
        with patch('scraper.time.sleep'):
            scraper.scrape_all(persist_health=False)
        row = scraper.health['Example']
        self.assertEqual(row['consecutive_failures'], 4)
        self.assertEqual(row['checked_at'], '2026-09-10T10:00:00Z')

    def test_authoritative_empty_success_clears_previous_batch(self):
        source = dict(SOURCE, allow_empty=True)
        scraper = HighSignalScraper(sources=[source])
        article = self.article(scraper, source)
        from source_config import config_fingerprint, source_key
        scraper.source_batches[source_key(source)] = {
            'name': 'Example',
            'config_fingerprint': config_fingerprint(normalize_source(source)),
            'last_good_fetch_at': datetime.now(timezone.utc).isoformat(),
            'articles': [article],
        }
        success = {'name': 'Example', 'state': 'ok', 'articles': 0,
                   'attempted': True, 'consecutive_failures': 0}
        with patch.object(scraper, 'scrape_source', return_value=([], success)), \
                patch('scraper.time.sleep'):
            articles = scraper.scrape_all(persist_health=False)
        self.assertEqual(articles, [])
        self.assertEqual(scraper.source_batches[source_key(source)]['articles'], [])

    def test_fresh_copy_leads_cluster_over_higher_scored_stale_copy(self):
        scraper = HighSignalScraper(sources=[SOURCE])
        stale = dict(self.article(scraper), source='Old', signal_score=100,
                     is_stale=True)
        fresh = dict(self.article(scraper), id='fresh', source='Fresh',
                     signal_score=60, is_stale=False)
        result = scraper.dedupe([stale, fresh])
        self.assertEqual(result[0]['source'], 'Fresh')
        self.assertEqual(result[0]['also_in'], ['Old'])

    def test_source_state_round_trip_and_private_publication_document(self):
        scraper = HighSignalScraper(sources=[SOURCE])
        article = self.article(scraper)
        now = datetime.now(timezone.utc).isoformat()
        from source_config import config_fingerprint, source_key
        scraper.source_batches[source_key(SOURCE)] = {
            'name': 'Example',
            'config_fingerprint': config_fingerprint(normalize_source(SOURCE)),
            'last_good_fetch_at': now, 'articles': [article],
        }
        snapshot = {
            'generated_at': '2026-09-10T12:00:00', 'articles': [article],
            'health': [{'name': 'Example', 'state': 'ok'}],
            'scraper_state': scraper.scraper_state_payload(),
            'run_stats': {'enabled': 1, 'succeeded': 1},
        }
        publication = prepare_publication(snapshot, [SOURCE])
        documents = {item.key: {'body_text': item.body}
                     for item in publication.documents}
        restored = previous_snapshot(documents['dashboard'],
                                     documents['scraper_state'])
        self.assertEqual(restored['scraper_state'], snapshot['scraper_state'])

    def test_partial_outage_below_half_is_rejected(self):
        sources = [dict(SOURCE, name=f'Source {index}',
                        url=f'https://example{index}.com/') for index in range(3)]
        scraper = HighSignalScraper(sources=sources)
        scraper.run_stats = {'enabled': 3, 'attempted': 3, 'succeeded': 1,
                             'failed': 2, 'skipped': 0}
        from pipeline import _coverage, _validate_run
        articles = [self.article(scraper, sources[0])]
        coverage = _coverage(scraper)
        self.assertEqual(coverage, {'succeeded': 1, 'enabled': 3,
                                    'threshold': 0.5, 'required': 2})
        with self.assertRaisesRegex(D1Error, 'at least 2'):
            _validate_run(articles, coverage)

    def test_operator_can_lower_and_raise_the_coverage_gate(self):
        sources = [dict(SOURCE, name=f'Source {index}',
                        url=f'https://example{index}.com/') for index in range(4)]
        scraper = HighSignalScraper(sources=sources)
        scraper.run_stats = {'enabled': 4, 'attempted': 4, 'succeeded': 1,
                             'failed': 3, 'skipped': 0}
        from pipeline import _coverage, _validate_run
        articles = [self.article(scraper, sources[0])]
        # A quarter of the sources is enough once an operator says so.
        lenient = _coverage(scraper, 0.25)
        self.assertEqual(lenient['required'], 1)
        _validate_run(articles, lenient)
        with self.assertRaisesRegex(D1Error, 'at least 4'):
            _validate_run(articles, _coverage(scraper, 1.0))
        # Out-of-range settings clamp instead of disabling the gate, and a run
        # where nothing succeeded is still an outage.
        scraper.run_stats['succeeded'] = 0
        with self.assertRaisesRegex(D1Error, 'All enabled sources failed'):
            _validate_run(articles, _coverage(scraper, -5))

    def test_coverage_gate_setting_comes_from_the_environment(self):
        scraper = HighSignalScraper(sources=[dict(SOURCE)])
        scraper.run_stats = {'enabled': 1, 'attempted': 1, 'succeeded': 1,
                             'failed': 0, 'skipped': 0}
        from pipeline import _coverage, settings_from_env
        with patch.dict(os.environ, {'SCRAPE_MIN_SOURCE_COVERAGE': '0.8'}):
            self.assertEqual(settings_from_env()['min_source_coverage'], 0.8)
            self.assertEqual(_coverage(scraper)['threshold'], 0.8)


if __name__ == '__main__':
    unittest.main()
