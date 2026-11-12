"""Contract tests for Flask-independent publication preparation."""

import copy
import json
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from d1_store import D1Error
from pipeline import (load_summary_retries, prepare_publication,
                      prune_summary_retries, run_scrape, warm_summaries)


SOURCE = {
    'name': 'Example', 'url': 'https://example.com', 'tier': 'high',
    'category': 'AI Research',
}
ARTICLE = {
    'id': 'article-1', 'title': 'Example research model',
    'link': 'https://example.com/article', 'source': 'Example',
    'category': 'AI Research', 'signal_score': 80,
    'summary': 'Publisher supplied summary.', 'summary_source': 'feed',
    'first_seen': '2026-09-10T10:00:00',
}
HEALTH = {
    'name': 'Example', 'state': 'ok', 'enabled': True, 'articles': 1,
    'url': 'https://example.com',
}


class PipelineTests(unittest.TestCase):
    def test_prepared_dashboard_bundles_existing_public_contracts(self):
        snapshot = {
            'generated_at': '2026-09-10T12:00:00',
            'articles': [copy.deepcopy(ARTICLE)],
            'health': [copy.deepcopy(HEALTH)],
        }
        publication = prepare_publication(
            snapshot, [SOURCE], 'https://signal.example')
        documents = {document.key: document for document in publication.documents}
        dashboard = json.loads(documents['dashboard'].body)

        self.assertEqual(dashboard['articles'][0]['id'], 'article-1')
        self.assertEqual(dashboard['stats']['high_signal_count'], 1)
        self.assertEqual(dashboard['sources']['ok'], 1)
        self.assertEqual(documents['rss_default'].content_type,
                         'application/rss+xml; charset=utf-8')
        self.assertIn('https://signal.example/feed.xml',
                      documents['rss_default'].body)

    def test_prepared_compatibility_documents_match_the_dashboard(self):
        snapshot = {
            'generated_at': '2026-09-10T12:00:00',
            'articles': [copy.deepcopy(ARTICLE)],
            'health': [copy.deepcopy(HEALTH)],
        }
        publication = prepare_publication(
            snapshot, [SOURCE], 'https://signal.example')
        documents = {document.key: document for document in publication.documents}
        dashboard = json.loads(documents['dashboard'].body)

        # The Worker serves these as stored text instead of parsing the feed,
        # so they have to be byte-identical to the embedded copies.
        self.assertEqual(json.loads(documents['stats'].body), dashboard['stats'])
        self.assertEqual(json.loads(documents['sources'].body), dashboard['sources'])
        self.assertEqual(documents['stats'].content_type,
                         'application/json; charset=utf-8')
        self.assertEqual(dashboard['stats']['total_articles'], 1)

    def test_all_source_failure_keeps_previous_publication(self):
        failed = dict(HEALTH, state='error', articles=0, error='HTTP 403')
        previous = {
            'generated_at': '2026-09-10T11:30:00',
            'articles': [copy.deepcopy(ARTICLE)],
            'health': [failed],
        }
        with patch('scraper.HighSignalScraper.scrape_source',
                   return_value=([], failed)), patch('scraper.time.sleep'):
            with self.assertRaisesRegex(D1Error, 'All enabled sources failed'):
                run_scrape([SOURCE], previous, warm_limit=0)

    def test_pipeline_preserves_article_ids_and_first_seen(self):
        previous = {
            'generated_at': '2026-09-10T11:30:00',
            'articles': [copy.deepcopy(ARTICLE)],
            'health': [copy.deepcopy(HEALTH)],
        }
        fresh = dict(ARTICLE, first_seen='2026-09-10T12:00:00', summary='')
        with patch('scraper.HighSignalScraper.scrape_source',
                   return_value=([fresh], copy.deepcopy(HEALTH))), \
                patch('scraper.time.sleep'):
            result = run_scrape([SOURCE], previous, warm_limit=0)

        self.assertEqual(result['articles'][0]['id'], ARTICLE['id'])
        self.assertEqual(result['articles'][0]['first_seen'], ARTICLE['first_seen'])
        self.assertEqual(result['articles'][0]['summary'], ARTICLE['summary'])


NOW = datetime(2026, 11, 13, 12, 0, tzinfo=timezone.utc)
FAILED = ('Fallback line.', 'metadata', 'HTTP 403')
FOUND = ('A real summary from the page.', 'meta', None)


class FakeScraper:
    """Stands in for the network: each call takes the next queued result."""

    def __init__(self, *results):
        self.results = list(results)
        self.fetched = []

    def fetch_article_summary(self, article):
        self.fetched.append(article['id'])
        return self.results.pop(0)


def missing_summary(article_id='article-1'):
    return dict(ARTICLE, id=article_id, summary='', summary_source='')


class SummaryRetryTests(unittest.TestCase):
    def warm(self, scraper, articles, retries, now, **kwargs):
        return warm_summaries(scraper, articles, retries=retries, now=now,
                              workers=1, **kwargs)

    def test_failure_waits_before_the_next_try(self):
        retries = {}
        self.warm(FakeScraper(FAILED), [missing_summary()], retries, NOW)

        entry = retries['article-1']
        self.assertEqual(entry['attempts'], 1)
        self.assertEqual(entry['last_error'], 'HTTP 403')
        self.assertEqual(entry['next_attempt_at'], '2026-11-13T15:00:00Z')

        waiting = FakeScraper()
        warmed, attempted = self.warm(
            waiting, [missing_summary()], retries, NOW + timedelta(hours=1))
        self.assertEqual((warmed, attempted, waiting.fetched), (0, 0, []))

        later = FakeScraper(FAILED)
        self.warm(later, [missing_summary()], retries, NOW + timedelta(hours=3))
        self.assertEqual(later.fetched, ['article-1'])
        self.assertEqual(retries['article-1']['attempts'], 2)
        self.assertEqual(retries['article-1']['next_attempt_at'],
                         '2026-11-14T03:00:00Z')

    def test_gives_up_after_four_tries(self):
        retries, now = {}, NOW
        for _ in range(4):
            self.warm(FakeScraper(FAILED), [missing_summary()], retries, now)
            now += timedelta(days=2)

        self.assertEqual(retries['article-1']['attempts'], 4)
        self.assertIsNone(retries['article-1']['next_attempt_at'])
        never = FakeScraper()
        self.warm(never, [missing_summary()], retries, now + timedelta(days=30))
        self.assertEqual(never.fetched, [])

    def test_success_clears_the_record(self):
        retries = {'article-1': {'attempts': 2, 'last_error': 'HTTP 503',
                                 'next_attempt_at': '2026-11-13T11:00:00Z'}}
        article = missing_summary()
        warmed, _ = self.warm(FakeScraper(FOUND), [article], retries, NOW)

        self.assertEqual(warmed, 1)
        self.assertEqual(article['summary'], FOUND[0])
        self.assertEqual(retries, {})

    def test_waiting_articles_free_their_slot_for_others(self):
        retries = {'article-1': {'attempts': 1, 'last_error': 'HTTP 403',
                                 'next_attempt_at': '2026-11-13T15:00:00Z'}}
        scraper = FakeScraper(FOUND)
        self.warm(scraper, [missing_summary('article-1'),
                            missing_summary('article-2')],
                  retries, NOW, limit=1)
        self.assertEqual(scraper.fetched, ['article-2'])

    def test_running_out_of_time_is_not_a_failure(self):
        retries = {}
        scraper = FakeScraper(FAILED)
        self.warm(scraper, [missing_summary()], retries, NOW, budget_seconds=0)
        self.assertEqual((scraper.fetched, retries), ([], {}))

    def test_without_a_retry_map_every_run_tries_again(self):
        for _ in range(2):
            scraper = FakeScraper(FAILED)
            warm_summaries(scraper, [missing_summary()], workers=1)
            self.assertEqual(scraper.fetched, ['article-1'])

    def test_load_drops_malformed_records(self):
        state = {'version': 1, 'sources': {}, 'summary_retries': {
            'good': {'attempts': 1, 'next_attempt_at': '2026-11-13T15:00:00Z'},
            'given-up': {'attempts': 4, 'next_attempt_at': None},
            'no-attempts': {'next_attempt_at': '2026-11-13T15:00:00Z'},
            'bad-time': {'attempts': 1, 'next_attempt_at': 'soon'},
            'not-a-dict': 'x',
        }}
        self.assertEqual(sorted(load_summary_retries(state)), ['given-up', 'good'])
        self.assertEqual(load_summary_retries(None), {})
        self.assertEqual(load_summary_retries({'version': 1, 'sources': {}}), {})

    def test_prune_keeps_only_listed_articles_still_missing_a_summary(self):
        retries = {key: {'attempts': 1, 'next_attempt_at': None}
                   for key in ('missing', 'summarised', 'gone')}
        articles = [missing_summary('missing'),
                    dict(ARTICLE, id='summarised')]
        self.assertEqual(list(prune_summary_retries(retries, articles)),
                         ['missing'])

    def test_run_carries_records_through_the_private_state(self):
        later = (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat()
        previous = {
            'generated_at': '2026-09-10T11:30:00',
            'articles': [missing_summary()],
            'health': [copy.deepcopy(HEALTH)],
            'scraper_state': {'version': 1, 'sources': {}, 'summary_retries': {
                'article-1': {'attempts': 1, 'last_error': 'HTTP 403',
                              'next_attempt_at': later},
                'gone': {'attempts': 1, 'next_attempt_at': later},
            }},
        }
        with patch('scraper.HighSignalScraper.scrape_source',
                   return_value=([missing_summary()], copy.deepcopy(HEALTH))), \
                patch('scraper.time.sleep'), \
                patch('scraper.HighSignalScraper.fetch_article_summary') as fetch:
            result = run_scrape([SOURCE], previous)

        fetch.assert_not_called()
        self.assertEqual(list(result['scraper_state']['summary_retries']),
                         ['article-1'])
        self.assertEqual(result['summary_warm']['retry_waiting'], 1)
        self.assertEqual(result['summary_warm']['retry_given_up'], 0)

    def test_run_without_failures_leaves_the_state_unchanged(self):
        previous = {
            'generated_at': '2026-09-10T11:30:00',
            'articles': [copy.deepcopy(ARTICLE)],
            'health': [copy.deepcopy(HEALTH)],
        }
        with patch('scraper.HighSignalScraper.scrape_source',
                   return_value=([copy.deepcopy(ARTICLE)], copy.deepcopy(HEALTH))), \
                patch('scraper.time.sleep'):
            result = run_scrape([SOURCE], previous)
        self.assertNotIn('summary_retries', result['scraper_state'])


if __name__ == '__main__':
    unittest.main()
