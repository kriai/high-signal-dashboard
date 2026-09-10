"""Regression coverage for billed operations and failed publication.

No live services or credentials: only the HTTP boundary is mocked, so these
exercise the actual scraper, snapshot persistence and Flask endpoints.
"""
import copy
import json
import os
import unittest
from datetime import datetime, timedelta
from unittest.mock import patch

import requests

# Importing the development app must not start its background scrape in tests.
with patch.dict(os.environ, {'FLASK_DEBUG': '1', 'BLOB_READ_WRITE_TOKEN': ''}):
    import app
    import scrape_job
    import store

TOKEN = 'vercel_blob_rw_TestStore_testsecret'
SOURCE = {'name': 'Example', 'url': 'https://example.com', 'tier': 'high'}
ARTICLE = {
    'id': 'one', 'title': 'Example releases a new research model',
    'link': 'https://example.com/article', 'source': 'Example',
    'signal_score': 80, 'summary': '', 'first_seen': '2026-08-01T00:00:00',
}


def response(status=200, payload=None, text=None):
    result = requests.Response()
    result.status_code = status
    result._content = (text if text is not None else json.dumps(payload)).encode()
    result.url = 'https://teststore.public.blob.vercel-storage.com/test'
    return result


class HobbyStorageTests(unittest.TestCase):
    def setUp(self):
        self.backend = store.BlobStore(TOKEN)
        self.patcher = patch.object(store, 'store', self.backend)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)
        self.snapshot = {
            'version': 2, 'generated_at': (datetime.now() - timedelta(hours=2)).isoformat(),
            'articles': [copy.deepcopy(ARTICLE)], 'health': [],
        }
        self.documents = {
            'sources.json': {'sources': [copy.deepcopy(SOURCE)]},
            'cache.json': self.snapshot,
        }
        self.get = patch('store.requests.get', side_effect=self.read).start()
        self.put = patch('store.requests.put', return_value=response(payload={'url': 'saved'})).start()
        self.addCleanup(patch.stopall)
        app.cached_articles = []
        app.summary_cache.clear()
        app.last_scrape_at = None
        app.state_loaded_at = 0
        app.state_error = None
        app.scraper.health = {}
        app.scraper.articles = []
        app.scraper.previous_by_id = {}
        app.scraper.last_run = None
        app.refresh_job.update(state='idle', error=None)
        self.client = app.app.test_client()

    def read(self, url, **kwargs):
        self.assertTrue(url.startswith('https://teststore.public.blob.vercel-storage.com/high-signal/'))
        if self.backend.fresh_reads:
            self.assertIn('v', kwargs.get('params', {}))
        else:
            self.assertNotIn('params', kwargs, 'Viewer reads must use shared CDN URLs')
        self.assertNotIn('headers', kwargs, 'Public reads must not send the write token')
        name = url.rsplit('/', 1)[-1]
        if name not in self.documents:
            return response(status=404)
        return response(payload=self.documents[name])

    def test_polling_and_cold_instances_never_list_or_write(self):
        for _ in range(3):
            app.state_loaded_at = 0  # Another cold instance / expired cache.
            for path in ('/api/feed', '/api/stats', '/api/sources'):
                self.assertEqual(self.client.get(path).status_code, 200)
        self.assertGreater(self.get.call_count, 0)
        self.put.assert_not_called()
        self.assertEqual(self.backend.operations['writes'], 0)

    def test_static_requests_do_not_hydrate_storage(self):
        self.assertEqual(self.client.get('/').status_code, 200)
        with self.client.get('/static/js/dashboard.js') as result:
            self.assertEqual(result.status_code, 200)
        self.get.assert_not_called()

    def test_summary_click_does_not_upload(self):
        app.cached_articles = [copy.deepcopy(ARTICLE)]
        app.scraper.articles = app.cached_articles
        app.last_scrape_at = datetime.now()
        app.state_loaded_at = app.time.time()
        with patch.object(app.scraper, 'fetch_article_summary',
                          return_value=('Publisher summary.', 'meta', None)):
            result = self.client.get('/api/article/one/summary')
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json['summary'], 'Publisher summary.')
        self.put.assert_not_called()
        # Ephemeral summaries survive a server-side reload, without a sidecar GET.
        app.load_state()
        self.assertEqual(app.cached_articles[0]['summary'], 'Publisher summary.')

    def test_refresh_only_reads_saved_feed(self):
        with patch.object(app, 'start_refresh') as start:
            result = self.client.post('/api/refresh')
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json['status'], 'checked')
        start.assert_not_called()
        self.put.assert_not_called()

    def test_full_job_uploads_one_snapshot_with_health_and_warmed_summary(self):
        health = {'name': 'Example', 'state': 'ok', 'articles': 1}
        with patch.object(app.scraper, 'scrape_source', return_value=(
                [copy.deepcopy(ARTICLE)], health)), \
                patch('scraper.time.sleep'), \
                patch.object(app.scraper, 'fetch_article_summary', return_value=(
                    'Prepared publisher summary.', 'meta', None)):
            self.assertEqual(scrape_job.main(), 0)
        self.assertEqual(self.put.call_count, 1)
        kwargs = self.put.call_args.kwargs
        self.assertEqual(kwargs['params']['pathname'], 'high-signal/cache.json')
        self.assertEqual(kwargs['headers']['x-add-random-suffix'], '0')
        payload = json.loads(kwargs['data'])
        self.assertEqual(payload['health'], [health])
        self.assertEqual(payload['articles'][0]['summary'], 'Prepared publisher summary.')
        self.assertEqual(payload['articles'][0]['first_seen'], ARTICLE['first_seen'])
        self.assertEqual(self.backend.operations['writes'], 1)

    def test_source_disable_writes_only_config_and_survives_reload(self):
        app.load_state()
        result = self.client.patch('/api/sources/Example', json={'enabled': False})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(self.put.call_count, 1)
        kwargs = self.put.call_args.kwargs
        self.assertEqual(kwargs['params']['pathname'], 'high-signal/sources.json')
        self.documents['sources.json'] = json.loads(kwargs['data'])
        app.load_state()
        health = self.client.get('/api/sources').json
        self.assertEqual(health['disabled'], 1)

    def test_cold_store_can_be_seeded_by_job(self):
        del self.documents['cache.json']
        with patch.object(app.scraper, 'scrape_source', return_value=(
                [copy.deepcopy(ARTICLE)], {'name': 'Example', 'state': 'ok'})), \
                patch('scraper.time.sleep'), patch.object(app, 'warm_summaries', return_value=(0, 0)):
            self.assertEqual(scrape_job.main(), 0)
        self.assertEqual(self.put.call_count, 1)

    def test_local_scrapes_still_save_health_and_cache(self):
        with patch.object(store, 'store', store.LocalStore()), \
                patch.object(store, 'write_json') as write, \
                patch.object(app.scraper, 'scrape_source', return_value=(
                    [copy.deepcopy(ARTICLE)], {'name': 'Example', 'state': 'ok'})), \
                patch('scraper.time.sleep'):
            app.scrape_and_cache()
        self.assertEqual(app.refresh_job['state'], 'done')
        self.assertEqual([c.args[0] for c in write.call_args_list], ['health.json', 'cache.json'])

    def test_recent_job_does_not_scrape_or_upload(self):
        self.snapshot['generated_at'] = datetime.now().isoformat()
        with patch.object(app.scraper, 'scrape_all') as scrape:
            self.assertEqual(scrape_job.main(), 0)
        scrape.assert_not_called()
        self.put.assert_not_called()

    def test_next_scheduled_slot_is_not_skipped_due_to_scrape_duration(self):
        # Previous scrape finished at 12:02; the 12:30 run must still execute.
        self.snapshot['generated_at'] = '2026-09-06T12:02:00'
        with patch.object(app, 'datetime') as clock, \
                patch.object(app, 'scrape_and_cache') as scrape:
            clock.now.return_value = datetime(2026, 9, 6, 12, 30)
            clock.fromisoformat.side_effect = datetime.fromisoformat
            self.assertEqual(scrape_job.main(), 0)
        scrape.assert_called_once_with(warm=True)

    def test_snapshot_stamped_ahead_of_this_clock_still_publishes(self):
        # Timestamps are naive local time. A snapshot imported from a laptop
        # ahead of UTC must not block a UTC runner until the clock catches up.
        self.snapshot['generated_at'] = '2026-09-06T14:00:00'
        with patch.object(app, 'datetime') as clock, \
                patch.object(app, 'scrape_and_cache') as scrape:
            clock.now.return_value = datetime(2026, 9, 6, 12, 30)
            clock.fromisoformat.side_effect = datetime.fromisoformat
            self.assertEqual(scrape_job.main(), 0)
        scrape.assert_called_once_with(warm=True)

    def test_ci_missing_token_fails_without_scraping(self):
        with patch.dict(os.environ, {'GITHUB_ACTIONS': 'true'}), \
                patch.object(store, 'store', store.LocalStore()), \
                patch.object(app, 'load_state') as load:
            self.assertEqual(scrape_job.main(), 1)
        load.assert_not_called()

    def test_403_preserves_feed_and_surfaces_error(self):
        app.load_state()
        previous = copy.deepcopy(app.cached_articles)
        self.get.side_effect = None
        self.get.return_value = response(status=403)
        app.ensure_loaded(force=True)
        self.assertEqual(app.cached_articles, previous)
        self.assertIsNotNone(app.state_error)
        self.assertEqual(self.client.get('/api/feed').json, previous)
        self.assertIsNotNone(self.client.get('/api/stats').json['storage_error'])
        self.assertEqual(self.client.post('/api/refresh').status_code, 503)
        self.put.assert_not_called()

    def test_cold_403_is_503_instead_of_empty_success(self):
        self.get.side_effect = None
        self.get.return_value = response(status=403)
        self.assertEqual(self.client.get('/api/feed').status_code, 503)
        self.assertEqual(self.client.get('/').status_code, 200)

    def test_missing_snapshot_does_not_clear_previous_feed(self):
        app.load_state()
        del self.documents['cache.json']
        app.ensure_loaded(force=True)
        self.assertEqual(len(app.cached_articles), 1)
        self.assertIsNotNone(app.state_error)

    def test_invalid_snapshots_do_not_clear_previous_feed(self):
        app.load_state()
        for malformed in ({}, {'articles': None}, 7, {'articles': [], 'health': [],
                          'generated_at': 'bad date'}):
            with self.subTest(snapshot=malformed):
                self.documents['cache.json'] = malformed
                app.ensure_loaded(force=True)
                self.assertEqual(len(app.cached_articles), 1)
                self.assertIsNotNone(app.state_error)

    def test_failed_job_does_not_overwrite_unreadable_state(self):
        self.get.side_effect = None
        self.get.return_value = response(status=403)
        with patch.object(app.scraper, 'scrape_all') as scrape:
            self.assertEqual(scrape_job.main(), 1)
        scrape.assert_not_called()
        self.put.assert_not_called()

    def test_failed_publish_rolls_back_live_state(self):
        app.load_state()
        original = copy.deepcopy(app.cached_articles)
        old_time = app.last_scrape_at
        self.put.return_value = response(status=403)
        newer = dict(ARTICLE, id='two', title='A newer research model')
        with patch.object(app.scraper, 'scrape_source', return_value=(
                [newer], {'name': 'Example', 'state': 'ok'})), patch('scraper.time.sleep'):
            app.scrape_and_cache()
        self.assertEqual(app.refresh_job['state'], 'error')
        self.assertEqual(app.cached_articles, original)
        self.assertEqual(app.scraper.articles, original)
        self.assertEqual(app.last_scrape_at, old_time)

    def test_recovery_clears_error_and_publishes_loaded_state(self):
        app.load_state()
        self.get.side_effect = requests.Timeout()
        app.ensure_loaded(force=True)
        self.get.side_effect = self.read
        self.snapshot['articles'][0]['title'] = 'Recovered headline'
        app.ensure_loaded(force=True)
        self.assertIsNone(app.state_error)
        self.assertEqual(app.cached_articles[0]['title'], 'Recovered headline')

    def test_missing_is_distinct_from_invalid_json_and_forbidden(self):
        self.assertIsNone(self.backend.read('missing.json'))
        self.get.side_effect = None
        for result in (response(status=403), response(text='not JSON')):
            self.get.return_value = result
            with self.assertRaises(store.StoreUnavailable):
                store.read_json('cache.json', {})


if __name__ == '__main__':
    unittest.main()
