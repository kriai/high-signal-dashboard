"""Where scrape state lives.

Locally that is three JSON files next to the code, which is what every other
module still thinks it is talking to. On Vercel it cannot be: the function
filesystem is read-only apart from `/tmp`, and `/tmp` is per-instance and
disposable, so a scrape written by the cron invocation would be invisible to
the instance serving the dashboard a second later.

So the same three documents move into a Vercel Blob store, keyed by the same
names. `BLOB_READ_WRITE_TOKEN` decides which backend is live -- Vercel injects
it when a Blob store is linked to the project, and it is absent on a laptop, so
local development keeps its plain files with no configuration.

The Blob calls here are the raw REST API rather than a client library, because
Vercel ships no Python SDK for Blob. The shapes below are what the platform
actually accepts today (`x-api-version: 10`); if uploads ever start failing
with a version error, that header is the thing to bump.
"""

import json
import os
import threading
import time

import requests

BLOB_API = 'https://blob.vercel-storage.com'
BLOB_API_VERSION = '10'

# Namespace inside the store, so the bucket stays legible if anything else is
# ever added to it.
PREFIX = 'high-signal/'

# The public blob URL is CDN-backed. Reads bust that cache with the blob's own
# uploadedAt, so the only staleness window is how long we reuse the listing.
INDEX_TTL = 15


class LocalStore:
    """Plain files, written atomically. The development and CLI path."""

    def read(self, name):
        try:
            with open(name, 'r') as handle:
                return handle.read()
        except (IOError, ValueError):
            return None

    def write(self, name, text):
        temp = name + '.tmp'
        with open(temp, 'w') as handle:
            handle.write(text)
        os.replace(temp, name)


class BlobStore:
    """The three documents as blobs at a stable pathname."""

    def __init__(self, token):
        self.token = token
        self._index = {}
        self._indexed_at = 0
        self._lock = threading.Lock()

    def _headers(self, **extra):
        headers = {'authorization': f'Bearer {self.token}',
                   'x-api-version': BLOB_API_VERSION}
        headers.update(extra)
        return headers

    def _listing(self, force=False):
        """pathname -> (url, uploadedAt), cached briefly.

        Every read would otherwise cost a listing call on top of the download.
        """
        with self._lock:
            fresh = time.time() - self._indexed_at < INDEX_TTL
            if self._index and fresh and not force:
                return self._index

            response = requests.get(BLOB_API, headers=self._headers(),
                                    params={'prefix': PREFIX, 'limit': '1000'},
                                    timeout=15)
            response.raise_for_status()
            self._index = {
                blob['pathname']: (blob['url'], blob.get('uploadedAt', ''))
                for blob in response.json().get('blobs', [])
            }
            self._indexed_at = time.time()
            return self._index

    def read(self, name):
        try:
            entry = self._listing().get(PREFIX + name)
            if not entry:
                # A cold store, or a blob written by another instance since we
                # last listed. One forced re-list tells the difference.
                entry = self._listing(force=True).get(PREFIX + name)
            if not entry:
                return None
            url, stamp = entry
            response = requests.get(url, params={'v': stamp}, timeout=20)
            response.raise_for_status()
            return response.text
        except (requests.RequestException, ValueError, KeyError) as exc:
            print(f'⚠️  Blob read failed for {name}: {exc}')
            return None

    def write(self, name, text):
        response = requests.put(
            BLOB_API,
            params={'pathname': PREFIX + name},
            headers=self._headers(**{
                'access': 'public',
                'x-content-type': 'application/json',
                # Overwriting a fixed pathname is the whole point; without this
                # the API rejects the second write of the same name.
                'x-allow-overwrite': '1',
                # Short, because this content changes every scrape.
                'x-cache-control-max-age': '60',
            }),
            data=text.encode('utf-8'),
            timeout=30,
        )
        response.raise_for_status()
        with self._lock:
            # Point subsequent reads at what we just wrote instead of waiting
            # out the listing TTL.
            body = response.json()
            self._index[PREFIX + name] = (body['url'], str(time.time()))
        return body


def _build():
    token = os.environ.get('BLOB_READ_WRITE_TOKEN')
    if token:
        print('🗄️  State backend: Vercel Blob')
        return BlobStore(token)
    return LocalStore()


store = _build()


def read_json(name, default=None):
    text = store.read(name)
    if text is None:
        return default
    try:
        return json.loads(text)
    except ValueError:
        print(f'⚠️  {name} is not valid JSON; ignoring it')
        return default


def read_json_seeded(name, default=None):
    """Store first, the file deployed alongside the code as the seed.

    `sources.json` is committed, so a brand new Blob store has no copy of it.
    Fall back to the bundled one until the first edit writes it to the store.
    """
    data = read_json(name)
    if data is not None:
        return data
    if is_remote():
        try:
            with open(name, 'r') as handle:
                return json.load(handle)
        except (IOError, ValueError):
            return default
    return default


def write_json(name, payload):
    store.write(name, json.dumps(payload, indent=2))


def is_remote():
    return isinstance(store, BlobStore)
