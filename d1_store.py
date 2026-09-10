"""Cloudflare D1 publication primitives for the scheduled Python job.

The browser-facing Worker uses a D1 binding. GitHub Actions cannot use that
binding, so its low-volume administrative writes go through Cloudflare's REST
query endpoint. Every SQL value is parameterized and publication is staged,
verified, then activated with one conditional pointer update.
"""

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import hashlib
import json
import time
import warnings

import requests


D1_API_ROOT = 'https://api.cloudflare.com/client/v4/accounts'
SCHEMA_VERSION = 1
DOCUMENT_WARN_BYTES = 1_000_000
DOCUMENT_MAX_BYTES = 1_900_000
RETAIN_PUBLICATIONS = 3


class D1Error(RuntimeError):
    """A D1 request or invariant failed; safe to report without credentials."""


class PublicationConflict(D1Error):
    """The requested publication or active pointer conflicts with saved state."""


@dataclass(frozen=True)
class Document:
    key: str
    body: str
    content_type: str = 'application/json; charset=utf-8'

    @property
    def byte_count(self):
        return len(self.body.encode('utf-8'))

    @property
    def etag(self):
        return hashlib.sha256(self.body.encode('utf-8')).hexdigest()


@dataclass(frozen=True)
class Publication:
    id: str
    generated_at: str
    documents: tuple
    schema_version: int = SCHEMA_VERSION

    def manifest(self):
        return {
            'publication_id': self.id,
            'generated_at': self.generated_at,
            'schema_version': self.schema_version,
            'documents': {
                document.key: {
                    'etag': document.etag,
                    'byte_count': document.byte_count,
                    'content_type': document.content_type,
                }
                for document in self.documents
            },
        }


class D1RestClient:
    """Minimal retrying client for Cloudflare's parameterized D1 query API."""

    def __init__(self, account_id, database_id, api_token, session=None,
                 attempts=3, timeout=30):
        missing = [name for name, value in (
            ('CLOUDFLARE_ACCOUNT_ID', account_id),
            ('CLOUDFLARE_D1_DATABASE_ID', database_id),
            ('CLOUDFLARE_D1_API_TOKEN', api_token),
        ) if not value]
        if missing:
            raise D1Error('Missing D1 configuration: ' + ', '.join(missing))
        self.url = (f'{D1_API_ROOT}/{account_id}/d1/database/'
                    f'{database_id}/query')
        self.api_token = api_token
        self.session = session or requests.Session()
        self.attempts = attempts
        self.timeout = timeout
        self.usage = {'queries': 0, 'rows_read': 0, 'rows_written': 0}

    def query(self, sql, params=()):
        return self._request({'sql': sql, 'params': list(params)})[0]

    def batch(self, statements):
        body = {'batch': [
            {'sql': sql, 'params': list(params)} for sql, params in statements
        ]}
        return self._request(body)

    def _request(self, body):
        last_error = None
        for attempt in range(self.attempts):
            try:
                response = self.session.post(
                    self.url,
                    headers={
                        'Authorization': f'Bearer {self.api_token}',
                        'Content-Type': 'application/json',
                    },
                    json=body,
                    timeout=self.timeout,
                )
            except requests.RequestException as exc:
                last_error = exc
                if attempt + 1 < self.attempts:
                    time.sleep(2 ** attempt)
                    continue
                raise D1Error('D1 request failed: network error') from exc

            if response.status_code in (401, 403):
                raise D1Error(f'D1 authorization failed (HTTP {response.status_code})')
            if response.status_code == 429 or response.status_code >= 500:
                last_error = D1Error(f'D1 temporarily unavailable (HTTP {response.status_code})')
                if attempt + 1 < self.attempts:
                    retry_after = response.headers.get('Retry-After')
                    delay = int(retry_after) if retry_after and retry_after.isdigit() \
                        else 2 ** attempt
                    time.sleep(min(delay, 10))
                    continue
                raise last_error
            try:
                payload = response.json()
            except ValueError as exc:
                raise D1Error(f'D1 returned invalid JSON (HTTP {response.status_code})') from exc
            if not response.ok or not payload.get('success'):
                raise D1Error(_api_error(payload, response.status_code))

            results = payload.get('result')
            if not isinstance(results, list) or not results:
                raise D1Error('D1 returned no query result')
            for result in results:
                if not result.get('success'):
                    raise D1Error(_api_error(result, response.status_code))
                meta = result.get('meta') or {}
                self.usage['queries'] += 1
                self.usage['rows_read'] += int(meta.get('rows_read') or 0)
                self.usage['rows_written'] += int(meta.get('rows_written') or 0)
            return results
        raise D1Error(f'D1 request failed: {last_error}')


class D1PublicationStore:
    def __init__(self, client, now=None):
        self.client = client
        self.now = now or (lambda: datetime.now(timezone.utc)
                           .isoformat().replace('+00:00', 'Z'))

    def active_publication_id(self):
        result = self.client.query(
            "SELECT value FROM app_state WHERE key = 'active_publication_id'")
        rows = result.get('results') or []
        return rows[0].get('value') if rows else None

    def load_document(self, key='dashboard', publication_id=None):
        publication_id = publication_id or self.active_publication_id()
        if not publication_id:
            return None
        result = self.client.query(
            'SELECT d.body_text, d.content_type, d.etag, d.byte_count '
            'FROM publication_documents d JOIN publications p ON p.id = d.publication_id '
            'WHERE d.publication_id = ? AND d.key = ? AND p.ready = 1',
            (publication_id, key))
        rows = result.get('results') or []
        return rows[0] if rows else None

    def load_sources(self):
        result = self.client.query(
            'SELECT id, name, config_json, revision, updated_at '
            'FROM sources WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE')
        rows = []
        for row in result.get('results') or []:
            try:
                config = json.loads(row['config_json'])
            except (KeyError, TypeError, ValueError) as exc:
                raise D1Error(f'Invalid saved source configuration for {row.get("name", "unknown")}') from exc
            config['_storage'] = {
                'id': row['id'], 'revision': row['revision'],
                'updated_at': row['updated_at'],
            }
            rows.append(config)
        return rows

    def replace_sources(self, sources, allow_existing=False):
        """Seed authoritative source config; never called by normal publish."""
        existing = self.client.query(
            'SELECT COUNT(*) AS count FROM sources WHERE deleted_at IS NULL')
        count = int((existing.get('results') or [{'count': 0}])[0]['count'])
        if count and not allow_existing:
            raise PublicationConflict(
                f'D1 already has {count} active sources; replacement was not requested')
        now = self.now()
        statements = []
        if count:
            statements.append((
                'UPDATE sources SET deleted_at = ?, updated_at = ? '
                'WHERE deleted_at IS NULL', (now, now)))
        for source in sources:
            config = {key: value for key, value in source.items()
                      if key != '_storage'}
            name = str(config.get('name') or '').strip()
            url = str(config.get('url') or '').strip()
            if not name or not url:
                raise D1Error('Every source requires a name and URL')
            source_id = 'src-' + hashlib.sha256(
                name.lower().encode('utf-8')).hexdigest()[:24]
            statements.append((
                'INSERT INTO sources '
                '(id, name, config_json, revision, updated_at, deleted_at) '
                'VALUES (?, ?, ?, 1, ?, NULL) '
                'ON CONFLICT(id) DO UPDATE SET '
                'name = excluded.name, config_json = excluded.config_json, '
                'revision = sources.revision, updated_at = excluded.updated_at, '
                'deleted_at = NULL',
                (source_id, name, _canonical_json(config), now)))
        if not statements:
            raise D1Error('At least one source is required')
        self.client.batch(statements)
        return len(sources)

    def stage(self, publication):
        manifest = _validate_publication(publication)
        manifest_json = _canonical_json(manifest)
        existing = self.client.query(
            'SELECT generated_at, schema_version, manifest_json, ready '
            'FROM publications WHERE id = ?', (publication.id,))
        rows = existing.get('results') or []
        if rows:
            row = rows[0]
            if (row['generated_at'] != publication.generated_at or
                    int(row['schema_version']) != publication.schema_version or
                    row['manifest_json'] != manifest_json):
                raise PublicationConflict(
                    f'Publication {publication.id} already exists with different content')
        else:
            self.client.query(
                'INSERT INTO publications '
                '(id, generated_at, schema_version, manifest_json, ready, created_at) '
                'VALUES (?, ?, ?, ?, 0, ?) ON CONFLICT(id) DO NOTHING',
                (publication.id, publication.generated_at,
                 publication.schema_version, manifest_json, self.now()))

        if publication.documents:
            self.client.batch([(
                'INSERT INTO publication_documents '
                '(publication_id, key, body_text, content_type, etag, byte_count) '
                'VALUES (?, ?, ?, ?, ?, ?) '
                'ON CONFLICT(publication_id, key) DO NOTHING',
                (publication.id, document.key, document.body,
                 document.content_type, document.etag, document.byte_count),
            ) for document in publication.documents])

        verified = self.client.query(
            'SELECT key, etag, byte_count, content_type '
            'FROM publication_documents WHERE publication_id = ? ORDER BY key',
            (publication.id,))
        actual = {
            row['key']: {
                'etag': row['etag'], 'byte_count': int(row['byte_count']),
                'content_type': row['content_type'],
            }
            for row in verified.get('results') or []
        }
        if actual != manifest['documents']:
            raise PublicationConflict(
                f'Publication {publication.id} did not verify; it remains inactive')

        result = self.client.query(
            'UPDATE publications SET ready = 1 '
            'WHERE id = ? AND manifest_json = ?',
            (publication.id, manifest_json))
        if _changes(result) != 1:
            raise PublicationConflict(
                f'Publication {publication.id} could not be marked ready')
        return manifest

    def activate(self, publication_id, expected_previous):
        result = self.client.query(
            "UPDATE app_state SET value = ?, updated_at = ? "
            "WHERE key = 'active_publication_id' "
            'AND ((value IS NULL AND ? IS NULL) OR value = ?) '
            'AND EXISTS (SELECT 1 FROM publications WHERE id = ? AND ready = 1)',
            (publication_id, self.now(), expected_previous,
             expected_previous, publication_id))
        if _changes(result) != 1:
            current = self.active_publication_id()
            if current == publication_id:
                return
            raise PublicationConflict(
                f'Active publication changed (expected {expected_previous!r}, found {current!r})')

    def publish(self, publication, expected_previous=None):
        if expected_previous is None:
            expected_previous = self.active_publication_id()
        manifest = self.stage(publication)
        self.activate(publication.id, expected_previous)
        return manifest

    def prune(self, retain=RETAIN_PUBLICATIONS):
        if retain < 1:
            raise ValueError('retain must be at least 1')
        active = self.active_publication_id()
        result = self.client.query(
            'SELECT id FROM publications WHERE ready = 1 '
            'ORDER BY generated_at DESC, created_at DESC')
        keep = [row['id'] for row in (result.get('results') or [])[:retain]]
        if active and active not in keep:
            keep.append(active)
        candidates = [row['id'] for row in result.get('results') or []
                      if row['id'] not in keep]
        for publication_id in candidates:
            self.client.query('DELETE FROM publications WHERE id = ?',
                              (publication_id,))
        cutoff = (datetime.fromisoformat(self.now().replace('Z', '+00:00')) -
                  timedelta(hours=24)).isoformat().replace('+00:00', 'Z')
        self.client.query(
            'DELETE FROM publications WHERE ready = 0 AND created_at < ?',
            (cutoff,))
        self.client.query('DELETE FROM tool_jobs WHERE expires_at <= ?',
                          (self.now(),))
        return candidates


def _validate_publication(publication):
    if not publication.id or not publication.generated_at:
        raise D1Error('Publication ID and generated_at are required')
    if not publication.documents:
        raise D1Error('A publication must contain at least one document')
    keys = [document.key for document in publication.documents]
    if len(keys) != len(set(keys)):
        raise D1Error('Publication document keys must be unique')
    for document in publication.documents:
        if not document.key or not isinstance(document.body, str):
            raise D1Error('Publication documents require a key and text body')
        if document.byte_count > DOCUMENT_MAX_BYTES:
            raise D1Error(
                f'Document {document.key} is {document.byte_count} bytes; '
                f'maximum is {DOCUMENT_MAX_BYTES}')
        if document.byte_count > DOCUMENT_WARN_BYTES:
            warnings.warn(
                f'Document {document.key} is {document.byte_count} bytes; '
                f'consider bounded chunks before it reaches {DOCUMENT_MAX_BYTES}',
                RuntimeWarning)
    return publication.manifest()


def _canonical_json(payload):
    return json.dumps(payload, sort_keys=True, separators=(',', ':'),
                      ensure_ascii=False)


def _changes(result):
    return int((result.get('meta') or {}).get('changes') or 0)


def _api_error(payload, status):
    errors = payload.get('errors') or [] if isinstance(payload, dict) else []
    messages = [str(error.get('message')) for error in errors
                if isinstance(error, dict) and error.get('message')]
    return f'D1 query failed (HTTP {status}): ' + ('; '.join(messages) or 'unknown error')
