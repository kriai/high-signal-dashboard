"""Shared validation and normalization for scraper source definitions."""

import hashlib
import ipaddress
import json
import socket
from urllib.parse import urlparse

import soupsieve


SOURCE_TYPES = ('static', 'rss', 'json')
EDITABLE_FIELDS = (
    'url', 'category', 'selector', 'fallback', 'selectors', 'tier', 'limit',
    'retries', 'enabled', 'lock_category', 'type', 'feed_url',
    'fetch_strategies', 'retention_hours', 'allow_empty', 'allowed_hosts',
    'path_prefixes',
)
BLOCKED_HOSTS = ('localhost', 'localhost.localdomain',
                 'metadata.google.internal')
MAX_STRATEGIES = 4


class SourceConfigError(ValueError):
    """One source definition cannot be executed safely or predictably."""


def is_public_url(url):
    """Reject obvious non-public URL targets at the configuration boundary.

    The request layer repeats this check for every redirect. Hostnames are not
    resolved here because validation and connection must use the same DNS
    result to close DNS-rebinding attacks; that belongs in the transport.
    """
    try:
        parsed = urlparse(str(url or ''))
        port = parsed.port
    except (TypeError, ValueError):
        return False
    host = (parsed.hostname or '').lower().rstrip('.')
    if (parsed.scheme not in ('http', 'https') or not host or parsed.username or
            parsed.password or parsed.fragment or port not in (None, 80, 443)):
        return False
    if host in BLOCKED_HOSTS or host.endswith(('.localhost', '.local')):
        return False
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return True
    return not (address.is_private or address.is_loopback or
                address.is_link_local or address.is_reserved or
                address.is_multicast or address.is_unspecified)


def validate_public_url(value, label='URL'):
    text = str(value or '').strip()
    if not text.startswith(('http://', 'https://')):
        raise SourceConfigError(f'{label} must start with http:// or https://')
    if not is_public_url(text):
        raise SourceConfigError(f'{label} points at a local or private address')
    return text


def public_host_addresses(url):
    """Resolve a URL host and require every returned address to be public."""
    parsed = urlparse(url)
    try:
        records = socket.getaddrinfo(
            parsed.hostname, parsed.port or (443 if parsed.scheme == 'https' else 80),
            type=socket.SOCK_STREAM)
    except OSError:
        return None
    addresses = {record[4][0] for record in records}
    if not addresses:
        return None
    for text in addresses:
        if not is_public_address(text):
            return False
    return True


def is_public_address(value):
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False
    return not (address.is_private or address.is_loopback or address.is_link_local or
                address.is_reserved or address.is_multicast or address.is_unspecified)


def split_css_selectors(value):
    """Split a CSS selector list without breaking commas inside CSS syntax."""
    if isinstance(value, (list, tuple)):
        selectors = [str(item or '').strip() for item in value]
        return [item for item in selectors if item]
    text = str(value or '')
    selectors = []
    start = 0
    quote = None
    escaped = False
    square = round_depth = 0
    for index, char in enumerate(text):
        if escaped:
            escaped = False
            continue
        if char == '\\':
            escaped = True
            continue
        if quote:
            if char == quote:
                quote = None
            continue
        if char in ('"', "'"):
            quote = char
        elif char == '[':
            square += 1
        elif char == ']':
            square = max(0, square - 1)
        elif char == '(':
            round_depth += 1
        elif char == ')':
            round_depth = max(0, round_depth - 1)
        elif char == ',' and square == 0 and round_depth == 0:
            selector = text[start:index].strip()
            if selector:
                selectors.append(selector)
            start = index + 1
    tail = text[start:].strip()
    if tail:
        selectors.append(tail)
    return selectors


def _bounded_int(value, label, default, lower, upper):
    if value in (None, ''):
        return default
    if isinstance(value, bool):
        raise SourceConfigError(f'{label} must be a number')
    try:
        result = int(value)
    except (TypeError, ValueError) as exc:
        raise SourceConfigError(f'{label} must be a number') from exc
    if result < lower or result > upper:
        raise SourceConfigError(f'{label} must be between {lower} and {upper}')
    return result


def _boolean(value, label, default):
    if value is None:
        return default
    if not isinstance(value, bool):
        raise SourceConfigError(f'{label} must be true or false')
    return value


def _string_list(value, label, limit=12):
    if value in (None, ''):
        return []
    if not isinstance(value, list) or len(value) > limit:
        raise SourceConfigError(f'{label} must be a list of at most {limit} strings')
    result = []
    for item in value:
        text = str(item or '').strip()
        if not text or len(text) > 500:
            raise SourceConfigError(f'{label} contains an invalid value')
        result.append(text)
    return result


def _validate_selectors(selectors):
    for selector in selectors:
        try:
            soupsieve.compile(selector)
        except Exception as exc:  # noqa: BLE001
            raise SourceConfigError(f'Invalid CSS selector: {selector}') from exc


def _clean_strategy(value, index, display_url, strict_selectors=False):
    if not isinstance(value, dict):
        raise SourceConfigError('Each fetch strategy must be an object')
    strategy_type = str(value.get('type') or 'static').strip().lower()
    if strategy_type not in SOURCE_TYPES:
        raise SourceConfigError('Strategy type must be static, rss or json')
    strategy_id = str(value.get('id') or f'strategy-{index + 1}').strip()
    if not strategy_id or len(strategy_id) > 50:
        raise SourceConfigError('Strategy id must be 1 to 50 characters')
    result = {
        'id': strategy_id,
        'type': strategy_type,
        'url': validate_public_url(value.get('url') or display_url,
                                   'Strategy URL'),
    }
    if strategy_type == 'static':
        raw = value.get('selectors', value.get('selector', 'h2 a, h3 a'))
        selectors = split_css_selectors(raw)
        fallbacks = split_css_selectors(value.get('fallback'))
        if not selectors:
            raise SourceConfigError('Static strategy requires a selector')
        if len(selectors) + len(fallbacks) > 20:
            raise SourceConfigError('A strategy can contain at most 20 selectors')
        result['selectors'] = selectors + fallbacks
        if strict_selectors:
            _validate_selectors(result['selectors'])
    return result


def normalize_source(payload, existing=None, strict_selectors=False):
    """Return one sanitized source while preserving non-editable metadata."""
    if not isinstance(payload, dict):
        raise SourceConfigError('A source configuration is required')
    source = dict(existing or {})
    name = str(payload.get('name') or source.get('name') or '').strip()
    if not name:
        raise SourceConfigError('A name is required')
    if len(name) > 80:
        raise SourceConfigError('Name is too long')
    source['name'] = name

    for field in EDITABLE_FIELDS:
        if field in payload:
            source[field] = payload[field]

    source['url'] = validate_public_url(source.get('url'), 'URL')
    source_type = str(source.get('type') or 'static').lower().strip()
    if source_type not in SOURCE_TYPES:
        raise SourceConfigError('Type must be static, rss or json')
    source['type'] = source_type

    tier = str(source.get('tier') or 'medium').lower().strip()
    if tier not in ('high', 'medium', 'low'):
        raise SourceConfigError('Tier must be high, medium or low')
    source['tier'] = tier
    source['category'] = str(source.get('category') or 'Other').strip()[:80]
    source['limit'] = _bounded_int(source.get('limit'), 'Limit', 15, 1, 50)
    source['retries'] = _bounded_int(source.get('retries'), 'Retries', 3, 1, 3)
    source['retention_hours'] = _bounded_int(
        source.get('retention_hours'), 'Retention hours', 72, 0, 168)
    source['enabled'] = _boolean(source.get('enabled'), 'enabled', True)
    source['lock_category'] = _boolean(
        source.get('lock_category'), 'lock_category', False)
    source['allow_empty'] = _boolean(
        source.get('allow_empty'), 'allow_empty', False)

    feed_url = str(source.get('feed_url') or '').strip()
    if feed_url:
        source['feed_url'] = validate_public_url(feed_url, 'Feed URL')
    else:
        source.pop('feed_url', None)

    if source_type == 'static':
        selectors = split_css_selectors(
            source.get('selectors', source.get('selector', 'h2 a, h3 a')))
        fallbacks = split_css_selectors(source.get('fallback'))
        if not selectors:
            raise SourceConfigError('Static source requires a selector')
        if len(selectors) + len(fallbacks) > 20:
            raise SourceConfigError('A source can contain at most 20 selectors')
        source['selector'] = ', '.join(selectors)
        if fallbacks:
            source['fallback'] = ', '.join(fallbacks)
        else:
            source.pop('fallback', None)
        if strict_selectors:
            _validate_selectors(selectors + fallbacks)
    else:
        source.pop('selector', None)
        source.pop('selectors', None)
        source.pop('fallback', None)

    source['allowed_hosts'] = _string_list(source.get('allowed_hosts'),
                                            'allowed_hosts')
    source['path_prefixes'] = _string_list(source.get('path_prefixes'),
                                            'path_prefixes')
    if not source['allowed_hosts']:
        source.pop('allowed_hosts', None)
    if not source['path_prefixes']:
        source.pop('path_prefixes', None)

    strategies = source.get('fetch_strategies')
    if strategies is not None:
        if not isinstance(strategies, list) or not strategies:
            raise SourceConfigError('fetch_strategies must be a non-empty list')
        if len(strategies) > MAX_STRATEGIES:
            raise SourceConfigError(f'At most {MAX_STRATEGIES} fetch strategies are allowed')
        cleaned = [_clean_strategy(item, index, source['url'], strict_selectors)
                   for index, item in enumerate(strategies)]
        ids = [item['id'].lower() for item in cleaned]
        if len(ids) != len(set(ids)):
            raise SourceConfigError('Fetch strategy ids must be unique')
        source['fetch_strategies'] = cleaned
    return source


def validate_sources(sources):
    if not isinstance(sources, list):
        raise SourceConfigError('Sources must be a list')
    normalized = []
    names = set()
    keys = set()
    for source in sources:
        item = normalize_source(source)
        folded = item['name'].casefold()
        key = source_key(item)
        if folded in names:
            raise SourceConfigError(f'Duplicate source name: {item["name"]}')
        if key in keys:
            raise SourceConfigError(f'Duplicate source id: {key}')
        names.add(folded)
        keys.add(key)
        normalized.append(item)
    return normalized


def source_strategies(source):
    if source.get('fetch_strategies'):
        return [dict(item) for item in source['fetch_strategies']]
    strategy = {
        'id': 'primary',
        'type': source.get('type', 'static'),
        'url': source.get('feed_url') or source['url'],
    }
    if strategy['type'] == 'static':
        strategy['selectors'] = (
            split_css_selectors(source.get('selector', 'h2 a')) +
            split_css_selectors(source.get('fallback')))
    return [strategy]


def source_key(source):
    storage_id = (source.get('_storage') or {}).get('id')
    return str(storage_id or source.get('name') or '').casefold()


def config_fingerprint(source):
    strategies = source_strategies(source)
    semantic = {
        'name': source.get('name'),
        'url': source.get('url'),
        'strategies': strategies,
        'limit': source.get('limit', 15),
        'tier': source.get('tier', 'medium'),
        'category': source.get('category', 'Other'),
        'lock_category': bool(source.get('lock_category')),
        'allow_empty': bool(source.get('allow_empty')),
        'allowed_hosts': source.get('allowed_hosts') or [],
        'path_prefixes': source.get('path_prefixes') or [],
    }
    body = json.dumps(semantic, ensure_ascii=False, sort_keys=True,
                      separators=(',', ':'))
    return hashlib.sha256(body.encode('utf-8')).hexdigest()
