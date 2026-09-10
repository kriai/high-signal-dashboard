"""Offline tests for atomic, idempotent D1 publication semantics."""

import json
from pathlib import Path
import sqlite3
import unittest

from d1_store import (D1Error, D1PublicationStore, Document, Publication,
                      PublicationConflict)


ROOT = Path(__file__).resolve().parents[1]


class SqliteD1Client:
    """Small D1-compatible boundary backed by SQLite for deterministic tests."""

    def __init__(self):
        self.connection = sqlite3.connect(':memory:')
        self.connection.row_factory = sqlite3.Row
        for migration in sorted((ROOT / 'migrations').glob('*.sql')):
            self.connection.executescript(migration.read_text())
        self.usage = {'queries': 0, 'rows_read': 0, 'rows_written': 0}

    def query(self, sql, params=()):
        before = self.connection.total_changes
        cursor = self.connection.execute(sql, params)
        rows = [dict(row) for row in cursor.fetchall()] if cursor.description else []
        self.connection.commit()
        changes = self.connection.total_changes - before
        self.usage['queries'] += 1
        self.usage['rows_read'] += len(rows)
        self.usage['rows_written'] += changes
        return {
            'success': True,
            'results': rows,
            'meta': {
                'changes': changes,
                'rows_read': len(rows),
                'rows_written': changes,
            },
        }

    def batch(self, statements):
        results = []
        try:
            self.connection.execute('BEGIN')
            for sql, params in statements:
                before = self.connection.total_changes
                cursor = self.connection.execute(sql, params)
                rows = [dict(row) for row in cursor.fetchall()] \
                    if cursor.description else []
                changes = self.connection.total_changes - before
                results.append({
                    'success': True, 'results': rows,
                    'meta': {'changes': changes, 'rows_read': len(rows),
                             'rows_written': changes},
                })
            self.connection.commit()
        except Exception:
            self.connection.rollback()
            raise
        self.usage['queries'] += len(results)
        self.usage['rows_read'] += sum(r['meta']['rows_read'] for r in results)
        self.usage['rows_written'] += sum(r['meta']['rows_written'] for r in results)
        return results


def publication(publication_id, generated_at='2026-09-10T12:00:00Z',
                title='One'):
    body = json.dumps({
        'publication_id': publication_id,
        'generated_at': generated_at,
        'articles': [{'id': 'article-1', 'title': title}],
    }, separators=(',', ':'))
    return Publication(
        publication_id, generated_at,
        (Document('dashboard', body),
         Document('rss', '<rss></rss>', 'application/rss+xml; charset=utf-8')),
    )


class D1PublicationTests(unittest.TestCase):
    def setUp(self):
        self.client = SqliteD1Client()
        self.store = D1PublicationStore(
            self.client, now=lambda: '2026-09-10T12:05:00Z')

    def test_publication_is_complete_before_atomic_activation(self):
        item = publication('pub-1')
        manifest = self.store.publish(item)

        self.assertEqual(self.store.active_publication_id(), 'pub-1')
        self.assertEqual(set(manifest['documents']), {'dashboard', 'rss'})
        saved = self.store.load_document()
        self.assertEqual(saved['body_text'], item.documents[0].body)
        ready = self.client.query(
            'SELECT ready FROM publications WHERE id = ?', ('pub-1',))
        self.assertEqual(ready['results'][0]['ready'], 1)

    def test_repeating_same_publication_is_idempotent(self):
        item = publication('pub-1')
        self.store.publish(item)
        writes = self.client.usage['rows_written']
        self.store.publish(item, expected_previous='pub-1')

        counts = self.client.query(
            'SELECT COUNT(*) AS count FROM publication_documents')
        self.assertEqual(counts['results'][0]['count'], 2)
        # The ready flag/pointer can be set to their existing values, but no
        # duplicate rows are introduced and the active document is unchanged.
        self.assertGreaterEqual(self.client.usage['rows_written'], writes)
        self.assertEqual(self.store.load_document()['body_text'],
                         item.documents[0].body)

    def test_same_id_with_different_content_is_rejected(self):
        self.store.stage(publication('pub-1'))
        with self.assertRaises(PublicationConflict):
            self.store.stage(publication('pub-1', title='Changed'))

    def test_pointer_conflict_keeps_previous_publication_active(self):
        self.store.publish(publication('pub-1'))
        self.store.stage(publication('pub-2', '2026-09-10T12:30:00Z'))

        with self.assertRaises(PublicationConflict):
            self.store.activate('pub-2', expected_previous='someone-else')
        self.assertEqual(self.store.active_publication_id(), 'pub-1')

    def test_unverified_staging_never_becomes_active(self):
        item = publication('pub-1')
        manifest = item.manifest()
        self.client.query(
            'INSERT INTO publications '
            '(id, generated_at, schema_version, manifest_json, ready, created_at) '
            'VALUES (?, ?, ?, ?, 0, ?)',
            (item.id, item.generated_at, item.schema_version,
             json.dumps(manifest, sort_keys=True, separators=(',', ':')),
             '2026-09-10T12:05:00Z'))
        self.client.query(
            'INSERT INTO publication_documents '
            '(publication_id, key, body_text, content_type, etag, byte_count) '
            'VALUES (?, ?, ?, ?, ?, ?)',
            ('pub-1', 'dashboard', item.documents[0].body,
             item.documents[0].content_type, item.documents[0].etag,
             item.documents[0].byte_count))

        with self.assertRaises(PublicationConflict):
            self.store.activate('pub-1', expected_previous=None)
        self.assertIsNone(self.store.active_publication_id())

    def test_oversized_document_is_rejected_before_writes(self):
        item = Publication(
            'too-large', '2026-09-10T12:00:00Z',
            (Document('dashboard', 'x' * 1_900_001),))
        with self.assertRaises(D1Error):
            self.store.stage(item)
        count = self.client.query('SELECT COUNT(*) AS count FROM publications')
        self.assertEqual(count['results'][0]['count'], 0)

    def test_publish_does_not_touch_authoritative_sources(self):
        config = json.dumps({'name': 'Example', 'url': 'https://example.com'})
        self.client.query(
            'INSERT INTO sources '
            '(id, name, config_json, revision, updated_at) VALUES (?, ?, ?, ?, ?)',
            ('source-1', 'Example', config, 2, '2026-09-10T11:59:00Z'))

        self.store.publish(publication('pub-1'))
        sources = self.store.load_sources()
        self.assertEqual(sources[0]['name'], 'Example')
        self.assertEqual(sources[0]['_storage']['revision'], 2)

    def test_source_import_requires_explicit_replacement_and_is_idempotent(self):
        sources = [{'name': 'Example', 'url': 'https://example.com'}]
        self.store.replace_sources(sources)
        with self.assertRaises(PublicationConflict):
            self.store.replace_sources(sources)

        self.store.replace_sources(sources, allow_existing=True)
        self.store.replace_sources(sources, allow_existing=True)
        saved = self.store.load_sources()
        self.assertEqual(len(saved), 1)
        self.assertEqual(saved[0]['name'], 'Example')
        self.assertEqual(saved[0]['_storage']['revision'], 1)

    def test_prune_keeps_active_and_two_preceding_generations(self):
        previous = None
        for index in range(5):
            item = publication(
                f'pub-{index}', f'2026-09-10T{10 + index:02d}:00:00Z')
            self.store.publish(item, expected_previous=previous)
            previous = item.id

        removed = self.store.prune(retain=3)
        self.assertEqual(set(removed), {'pub-0', 'pub-1'})
        rows = self.client.query(
            'SELECT id FROM publications ORDER BY generated_at')['results']
        self.assertEqual([row['id'] for row in rows],
                         ['pub-2', 'pub-3', 'pub-4'])
        self.assertEqual(self.store.active_publication_id(), 'pub-4')

    def test_prune_removes_abandoned_staging_and_expired_jobs(self):
        item = publication('staging-old', '2026-09-08T10:00:00Z')
        self.client.query(
            'INSERT INTO publications '
            '(id, generated_at, schema_version, manifest_json, ready, created_at) '
            'VALUES (?, ?, ?, ?, 0, ?)',
            (item.id, item.generated_at, item.schema_version,
             json.dumps(item.manifest()), '2026-09-08T10:00:00Z'))
        self.client.query(
            "INSERT INTO tool_jobs (id, kind, payload_json, state, requested_at, "
            "expires_at, idempotency_key) VALUES (?, 'test', '{}', 'failed', ?, ?, ?)",
            ('expired-job', '2026-09-08T10:00:00Z',
             '2026-09-09T10:00:00Z', 'expired-key'))

        self.store.prune()

        staged = self.client.query(
            'SELECT id FROM publications WHERE id = ?', ('staging-old',))
        jobs = self.client.query(
            'SELECT id FROM tool_jobs WHERE id = ?', ('expired-job',))
        self.assertEqual(staged['results'], [])
        self.assertEqual(jobs['results'], [])


if __name__ == '__main__':
    unittest.main()
