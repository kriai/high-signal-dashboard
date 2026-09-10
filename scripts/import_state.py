#!/usr/bin/env python3
"""Validate and optionally import an explicit local snapshot into D1."""

import argparse
import json
import os
from pathlib import Path
import sqlite3
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from d1_store import D1Error, D1PublicationStore, D1RestClient  # noqa: E402
from pipeline import prepare_publication  # noqa: E402
from scraper import parse_iso  # noqa: E402


def read_json(path):
    try:
        return json.loads(path.read_text())
    except OSError as exc:
        raise D1Error(f'Cannot read {path}: {exc.strerror}') from exc
    except ValueError as exc:
        raise D1Error(f'{path} is not valid JSON') from exc


def validate_inputs(cache_path, sources_path, public_origin):
    cache = read_json(cache_path)
    source_document = read_json(sources_path)
    if not isinstance(cache, dict) or not isinstance(cache.get('articles'), list):
        raise D1Error('Cache must be an object with an articles list')
    if not isinstance(cache.get('health', []), list):
        raise D1Error('Cache health must be a list')
    if not parse_iso(cache.get('generated_at')):
        raise D1Error('Cache generated_at is missing or invalid')
    sources = source_document.get('sources') if isinstance(source_document, dict) else None
    if not isinstance(sources, list) or not sources:
        raise D1Error('Sources file must contain a non-empty sources list')
    publication = prepare_publication(cache, sources, public_origin)
    return cache, sources, publication


def parser():
    result = argparse.ArgumentParser(
        description='Import selected High Signal JSON state into Cloudflare D1')
    result.add_argument('--cache', type=Path, default=ROOT / 'cache.json')
    result.add_argument('--sources', type=Path, default=ROOT / 'sources.json')
    result.add_argument('--public-origin', default=os.environ.get(
        'PUBLIC_ORIGIN', 'https://high-signal.invalid'))
    result.add_argument('--apply', action='store_true',
                        help='write to D1; the default is a credential-free dry run')
    result.add_argument('--local', action='store_true',
                        help='seed Wrangler local D1 state with parameterized SQLite writes')
    result.add_argument('--local-db', type=Path,
                        help='explicit Wrangler local SQLite file (normally auto-detected)')
    result.add_argument('--replace-existing', action='store_true',
                        help='replace initialized source config and active publication')
    return result


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        cache, sources, publication = validate_inputs(
            args.cache.resolve(), args.sources.resolve(), args.public_origin)
        manifest = publication.manifest()
        print(f'Cache: {args.cache.resolve()}')
        print(f'Sources: {args.sources.resolve()}')
        print(f'Generated: {cache["generated_at"]}')
        print(f'Articles: {len(cache["articles"])}')
        print(f'Source configs: {len(sources)}')
        for key, document in manifest['documents'].items():
            print(f'Document {key}: {document["byte_count"]} bytes')
        print(f'Publication: {publication.id}')
        if args.local:
            database = (args.local_db.resolve() if args.local_db
                        else find_local_database())
            seed_local_database(database, sources, publication,
                                args.replace_existing)
            print(f'Local D1: {database}')
            print(f'Imported and activated {publication.id} locally')
            return 0
        if not args.apply:
            print('Dry run only. Re-run with --apply after reviewing these inputs.')
            return 0

        client = D1RestClient(
            os.environ.get('CLOUDFLARE_ACCOUNT_ID'),
            os.environ.get('CLOUDFLARE_D1_DATABASE_ID'),
            os.environ.get('CLOUDFLARE_D1_API_TOKEN'))
        store = D1PublicationStore(client)
        active = store.active_publication_id()
        if active and not args.replace_existing:
            raise D1Error(
                f'D1 already has active publication {active}; '
                'pass --replace-existing to replace initialized state')
        store.replace_sources(sources, allow_existing=args.replace_existing)
        store.publish(publication, expected_previous=active)
        print(f'Imported and activated {publication.id}')
        print(f'D1 usage: {client.usage}')
        return 0
    except D1Error as exc:
        print(f'Import refused: {exc}', file=sys.stderr)
        return 1


def find_local_database():
    candidates = list((ROOT / '.wrangler' / 'state' / 'v3' / 'd1')
                      .glob('miniflare-D1DatabaseObject/*.sqlite'))
    candidates = [path for path in candidates if path.name != 'metadata.sqlite']
    if len(candidates) != 1:
        raise D1Error(
            'Could not identify one Wrangler local database; pass --local-db')
    return candidates[0].resolve()


def seed_local_database(database, sources, publication, allow_existing):
    """Seed only Wrangler's disposable local database using bound values."""
    from d1_store import _canonical_json  # kept inside the import boundary
    import hashlib

    if not database.is_file():
        raise D1Error(f'Wrangler local database does not exist: {database}')
    connection = sqlite3.connect(str(database))
    try:
        count = connection.execute(
            'SELECT COUNT(*) FROM sources WHERE deleted_at IS NULL').fetchone()[0]
        active = connection.execute(
            "SELECT value FROM app_state WHERE key = 'active_publication_id'").fetchone()
        active = active[0] if active else None
        if (count or active) and not allow_existing:
            raise D1Error(
                'Local D1 is initialized; pass --replace-existing to replace it')
        now = publication.generated_at
        with connection:
            if count:
                connection.execute(
                    'UPDATE sources SET deleted_at = ?, updated_at = ? '
                    'WHERE deleted_at IS NULL', (now, now))
            for source in sources:
                config = {key: value for key, value in source.items()
                          if key != '_storage'}
                name = str(config['name']).strip()
                source_id = 'src-' + hashlib.sha256(
                    name.lower().encode('utf-8')).hexdigest()[:24]
                connection.execute(
                    'INSERT INTO sources '
                    '(id, name, config_json, revision, updated_at, deleted_at) '
                    'VALUES (?, ?, ?, 1, ?, NULL) '
                    'ON CONFLICT(id) DO UPDATE SET name = excluded.name, '
                    'config_json = excluded.config_json, revision = sources.revision, '
                    'updated_at = excluded.updated_at, deleted_at = NULL',
                    (source_id, name, _canonical_json(config), now))
            connection.execute(
                'INSERT INTO publications '
                '(id, generated_at, schema_version, manifest_json, ready, created_at) '
                'VALUES (?, ?, ?, ?, 1, ?) '
                'ON CONFLICT(id) DO UPDATE SET ready = 1',
                (publication.id, publication.generated_at,
                 publication.schema_version,
                 _canonical_json(publication.manifest()), now))
            for document in publication.documents:
                connection.execute(
                    'INSERT INTO publication_documents '
                    '(publication_id, key, body_text, content_type, etag, byte_count) '
                    'VALUES (?, ?, ?, ?, ?, ?) '
                    'ON CONFLICT(publication_id, key) DO UPDATE SET '
                    'body_text = excluded.body_text, content_type = excluded.content_type, '
                    'etag = excluded.etag, byte_count = excluded.byte_count',
                    (publication.id, document.key, document.body,
                     document.content_type, document.etag, document.byte_count))
            connection.execute(
                "UPDATE app_state SET value = ?, updated_at = ? "
                "WHERE key = 'active_publication_id'", (publication.id, now))
    except sqlite3.Error as exc:
        raise D1Error(f'Cannot seed Wrangler local D1: {exc}') from exc
    finally:
        connection.close()


if __name__ == '__main__':
    sys.exit(main())
