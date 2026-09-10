#!/usr/bin/env python3
"""Read-only source audit. It never publishes cache, health, or source edits."""

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scraper import HighSignalScraper  # noqa: E402
from source_config import config_fingerprint, normalize_source  # noqa: E402


def load_sources(args):
    if args.d1:
        from d1_store import D1PublicationStore, D1RestClient
        client = D1RestClient(
            os.environ.get('CLOUDFLARE_ACCOUNT_ID'),
            os.environ.get('CLOUDFLARE_D1_DATABASE_ID'),
            os.environ.get('CLOUDFLARE_D1_API_TOKEN'))
        return D1PublicationStore(client).load_sources()
    payload = json.loads(Path(args.sources).read_text())
    return payload.get('sources') if isinstance(payload, dict) else payload


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sources', default=str(ROOT / 'sources.json'))
    parser.add_argument('--source', action='append', default=[],
                        help='Audit only this source name; repeat as needed')
    parser.add_argument('--d1', action='store_true',
                        help='Read authoritative source configs from D1')
    parser.add_argument('--include-disabled', action='store_true',
                        help='Audit disabled sources too')
    parser.add_argument('--output', help='Optional JSON report path')
    args = parser.parse_args()

    sources = load_sources(args)
    if not args.include_disabled:
        sources = [source for source in sources
                   if source.get('enabled', True) is not False]
    selected = {name.casefold() for name in args.source}
    if selected:
        sources = [source for source in sources
                   if source.get('name', '').casefold() in selected]
    scraper = HighSignalScraper(sources=sources)
    results = []
    for source in sources:
        articles, health = scraper.scrape_source(source)
        try:
            fingerprint = config_fingerprint(normalize_source(source))
        except Exception:  # The health row carries the actionable error.
            fingerprint = None
        results.append({
            'name': source.get('name'),
            'config_fingerprint': fingerprint,
            'health': health,
            'preview': [
                {'title': item['title'], 'link': item['link']}
                for item in articles[:8]
            ],
        })
    report = {
        'schema_version': 1,
        'captured_at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        'environment': 'github-actions' if os.environ.get('GITHUB_ACTIONS') else 'local',
        'source_count': len(results),
        'results': results,
    }
    text = json.dumps(report, ensure_ascii=False, indent=2)
    if args.output:
        Path(args.output).write_text(text + '\n')
    else:
        print(text)
    return 0 if all(row['health'].get('state') == 'ok' for row in results) else 1


if __name__ == '__main__':
    raise SystemExit(main())
