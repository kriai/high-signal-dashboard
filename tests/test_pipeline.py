"""Contract tests for Flask-independent publication preparation."""

import copy
import json
import unittest
from unittest.mock import patch

from d1_store import D1Error
from pipeline import prepare_publication, run_scrape


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


if __name__ == '__main__':
    unittest.main()
