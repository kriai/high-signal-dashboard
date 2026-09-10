"""Legacy local/Blob JSON storage during the Cloudflare transition.

Reads use known URLs, never the billable listing API. Only missing files return
None; unavailable storage and invalid JSON are errors, so callers can preserve
the last successful snapshot instead of replacing it with an empty feed.

`STATE_BACKEND` is now explicit for new deployments. The old token-based
selection remains only as a compatibility default until the Vercel path is
removed. D1 deliberately is not made to look like a JSON-file backend: the
scheduled publisher uses d1_store.py and the hosted Worker uses a D1 binding.
"""

import json
import os
import re
import time
from urllib.parse import quote, urlparse

import requests

BLOB_API = 'https://blob.vercel-storage.com'
BLOB_API_VERSION = '10'

# Namespace inside the store, so the bucket stays legible if anything else is
# ever added to it.
PREFIX = 'high-signal/'

class StoreUnavailable(RuntimeError):
    """State could not be read or published. Safe to show without credentials."""


class D1StoreBoundary:
    """Prevent deployment-specific D1 behavior leaking through file helpers."""

    def read(self, name):
        raise StoreUnavailable(
            f'{name} cannot be read through the legacy store in D1 mode')

    def write(self, name, text):
        raise StoreUnavailable(
            f'{name} cannot be written through the legacy store in D1 mode')


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
    """Public blobs with stable filenames; GETs never require LIST or HEAD."""

    def __init__(self, token, base_url=None):
        self.token = token
        if not base_url:
            # The store ID is the public component of a Vercel read/write token.
            # An explicit URL supports future token formats without a listing.
            match = re.match(r'^vercel_blob_rw_([A-Za-z0-9]+)_', token)
            if not match:
                raise StoreUnavailable('Set BLOB_PUBLIC_BASE_URL for this token format')
            base_url = f'https://{match[1].lower()}.public.blob.vercel-storage.com'
        parsed = urlparse(base_url)
        if (parsed.scheme != 'https' or not parsed.hostname or
                not parsed.hostname.endswith('.public.blob.vercel-storage.com') or
                parsed.username or parsed.password or parsed.port or
                parsed.path not in ('', '/') or parsed.query or parsed.fragment):
            raise StoreUnavailable('BLOB_PUBLIC_BASE_URL must be a public Blob store origin')
        self.base_url = base_url.rstrip('/')
        self.operations = {'reads': 0, 'writes': 0}
        self.fresh_reads = False

    def _headers(self, **extra):
        headers = {'authorization': f'Bearer {self.token}',
                   'x-api-version': BLOB_API_VERSION}
        headers.update(extra)
        return headers

    def read(self, name):
        self.operations['reads'] += 1
        try:
            # A stable URL lets the CDN share its cache across server instances.
            # Overwrites can take about a minute to propagate.
            options = {'timeout': 20}
            if self.fresh_reads:
                # Only the serialized CI writer bypasses CDN caching, so a
                # just-finished run cannot be missed by a manual dispatch.
                options['params'] = {'v': str(time.time_ns())}
            response = requests.get(
                f'{self.base_url}/{PREFIX}{quote(name, safe="")}', **options)
            if response.status_code == 404:
                return None
            response.raise_for_status()
            return response.text
        except requests.RequestException as exc:
            status = getattr(getattr(exc, 'response', None), 'status_code', None)
            detail = f'HTTP {status}' if status else 'network error'
            raise StoreUnavailable(f'Cannot read {name}: {detail}') from exc

    def write(self, name, text):
        self.operations['writes'] += 1
        try:
            response = requests.put(
                BLOB_API,
                params={'pathname': PREFIX + name},
                headers=self._headers(**{
                    'access': 'public',
                    'x-content-type': 'application/json',
                    'x-add-random-suffix': '0',
                    'x-allow-overwrite': '1',
                    'x-cache-control-max-age': '60',
                }),
                data=text.encode('utf-8'),
                timeout=30,
            )
            response.raise_for_status()
            return response.json()
        except (requests.RequestException, ValueError) as exc:
            status = getattr(getattr(exc, 'response', None), 'status_code', None)
            detail = f'HTTP {status}' if status else 'network or response error'
            raise StoreUnavailable(f'Cannot publish {name}: {detail}') from exc


def _build():
    configured = os.environ.get('STATE_BACKEND', '').strip().lower()
    if configured and configured not in ('local', 'blob', 'd1'):
        raise StoreUnavailable('STATE_BACKEND must be local, blob, or d1')
    if configured == 'd1':
        print('🗄️  State backend: Cloudflare D1')
        return D1StoreBoundary()

    token = os.environ.get('BLOB_READ_WRITE_TOKEN')
    if configured == 'blob' or (not configured and token):
        if not token:
            raise StoreUnavailable('BLOB_READ_WRITE_TOKEN is required for STATE_BACKEND=blob')
        print('🗄️  State backend: Vercel Blob')
        return BlobStore(token, os.environ.get('BLOB_PUBLIC_BASE_URL'))
    return LocalStore()


store = _build()


def read_json(name, default=None):
    text = store.read(name)
    if text is None:
        return default
    try:
        return json.loads(text)
    except ValueError:
        raise StoreUnavailable(f'{name} is not valid JSON')


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


def backend_name():
    if isinstance(store, D1StoreBoundary):
        return 'd1'
    if isinstance(store, BlobStore):
        return 'blob'
    return 'local'
