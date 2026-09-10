"""Offline source validation and durable job processing tests."""

import json
import unittest
from unittest.mock import patch

from source_tool_job import recover_jobs, run_job
from source_tools import SourceToolError, clean_source
from tests.test_d1_store import SqliteD1Client


class SourceToolsTests(unittest.TestCase):
    def test_source_validation_blocks_private_targets(self):
        for url in ('http://127.0.0.1/admin', 'http://10.0.0.2/',
                    'http://[::1]/', 'http://metadata.google.internal/'):
            with self.subTest(url=url), self.assertRaises(SourceToolError):
                clean_source({'name': 'Private', 'url': url})

    def test_source_validation_requires_real_booleans(self):
        with self.assertRaisesRegex(SourceToolError, 'enabled must be true or false'):
            clean_source({'name': 'Example', 'url': 'https://example.com',
                          'enabled': 'false'})

    def test_source_validation_rejects_invalid_selectors(self):
        with self.assertRaisesRegex(SourceToolError, 'Invalid CSS selector'):
            clean_source({'name': 'Example', 'url': 'https://example.com',
                          'selector': '[broken'})

    def test_source_validation_preserves_bounded_strategies(self):
        source = clean_source({
            'name': 'Example', 'url': 'https://example.com',
            'retention_hours': 24, 'allow_empty': True,
            'fetch_strategies': [
                {'id': 'feed', 'type': 'rss',
                 'url': 'https://example.com/feed.xml'},
                {'id': 'page', 'type': 'static',
                 'url': 'https://example.com/news',
                 'selectors': ['article h2 a']},
            ],
        })
        self.assertEqual(source['retention_hours'], 24)
        self.assertEqual(len(source['fetch_strategies']), 2)

    def test_job_claims_and_persists_bounded_result(self):
        client = SqliteD1Client()
        client.query(
            "INSERT INTO tool_jobs "
            "(id, kind, payload_json, state, requested_at, expires_at, idempotency_key) "
            "VALUES (?, 'discover', ?, 'queued', ?, ?, ?)",
            ('job-1', json.dumps({'url': 'https://example.com'}),
             '2026-09-10T00:00:00Z', '2099-09-11T00:00:00Z', 'key-1'))
        with patch('source_tool_job.discover_source',
                   return_value={'count': 1, 'candidates': [{'type': 'rss'}]}):
            result = run_job(client, 'job-1')

        self.assertEqual(result['count'], 1)
        saved = client.query(
            'SELECT state, result_json FROM tool_jobs WHERE id = ?', ('job-1',))
        self.assertEqual(saved['results'][0]['state'], 'completed')
        self.assertEqual(json.loads(saved['results'][0]['result_json'])['count'], 1)

    def test_job_failure_is_durable(self):
        client = SqliteD1Client()
        client.query(
            "INSERT INTO tool_jobs "
            "(id, kind, payload_json, state, requested_at, expires_at, idempotency_key) "
            "VALUES (?, 'test', ?, 'queued', ?, ?, ?)",
            ('job-2', json.dumps({'url': 'https://example.com'}),
             '2026-09-10T00:00:00Z', '2099-09-11T00:00:00Z', 'key-2'))
        with patch('source_tool_job.test_source',
                   side_effect=SourceToolError('Publisher blocked the request')):
            with self.assertRaises(SourceToolError):
                run_job(client, 'job-2')
        saved = client.query(
            'SELECT state, error FROM tool_jobs WHERE id = ?', ('job-2',))
        self.assertEqual(saved['results'][0]['state'], 'failed')
        self.assertIn('Publisher blocked', saved['results'][0]['error'])

    def test_recovery_processes_a_bounded_oldest_first_batch(self):
        client = SqliteD1Client()
        for index in range(3):
            client.query(
                "INSERT INTO tool_jobs "
                "(id, kind, payload_json, state, requested_at, expires_at, idempotency_key) "
                "VALUES (?, 'discover', ?, 'queued', ?, ?, ?)",
                (f'job-{index}', json.dumps({'url': 'https://example.com'}),
                 f'2026-09-10T00:00:0{index}Z', '2099-09-11T00:00:00Z',
                 f'key-{index}'))
        with patch('source_tool_job.discover_source', return_value={'count': 0}):
            result = recover_jobs(client, limit=2)

        self.assertEqual(result['completed'], ['job-0', 'job-1'])
        states = client.query(
            'SELECT id, state FROM tool_jobs ORDER BY requested_at')['results']
        self.assertEqual([row['state'] for row in states],
                         ['completed', 'completed', 'queued'])


if __name__ == '__main__':
    unittest.main()
