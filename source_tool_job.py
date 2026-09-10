"""Claim and process one owner source-tool job from D1."""

import argparse
import json
import os
import sys
from datetime import datetime, timezone

from d1_store import D1Error, D1RestClient
from scraper import HighSignalScraper
from source_tools import SourceToolError, discover_source, test_source


RESULT_MAX_BYTES = 256_000


def now():
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def run_job(client, job_id):
    claimed_at = now()
    claimed = client.query(
        "UPDATE tool_jobs SET state = 'running', claimed_at = ? "
        "WHERE id = ? AND state = 'queued' AND expires_at > ?",
        (claimed_at, job_id, now()))
    if int((claimed.get('meta') or {}).get('changes') or 0) != 1:
        saved = client.query(
            'SELECT state, claimed_at FROM tool_jobs WHERE id = ?', (job_id,))
        rows = saved.get('results') or []
        if rows and rows[0]['state'] == 'running' and \
                rows[0].get('claimed_at') == claimed_at:
            pass  # The first write succeeded but its REST response was lost.
        else:
            state = rows[0]['state'] if rows else 'missing'
            raise D1Error(f'Job {job_id} cannot be claimed (state: {state})')

    row = client.query(
        'SELECT kind, payload_json FROM tool_jobs WHERE id = ?', (job_id,))
    rows = row.get('results') or []
    if not rows:
        raise D1Error(f'Job {job_id} disappeared after claim')
    kind = rows[0]['kind']
    try:
        payload = json.loads(rows[0]['payload_json'])
        scraper = HighSignalScraper(sources=[])
        result = (discover_source(scraper, payload) if kind == 'discover'
                  else test_source(scraper, payload))
        result_json = json.dumps(result, ensure_ascii=False, separators=(',', ':'))
        if len(result_json.encode('utf-8')) > RESULT_MAX_BYTES:
            raise D1Error('Source-tool result exceeded 256 KB')
        finished = client.query(
            "UPDATE tool_jobs SET state = 'completed', result_json = ?, error = NULL, "
            "finished_at = ? WHERE id = ? AND state = 'running'",
            (result_json, now(), job_id))
        if int((finished.get('meta') or {}).get('changes') or 0) != 1:
            saved = client.query(
                'SELECT state FROM tool_jobs WHERE id = ?', (job_id,))
            if not saved.get('results') or saved['results'][0]['state'] != 'completed':
                raise D1Error(f'Job {job_id} completion conflicted')
        return result
    except Exception as exc:  # noqa: BLE001
        message = (str(exc) if isinstance(exc, (D1Error, SourceToolError))
                   else f'{type(exc).__name__}: {str(exc)}')[:300]
        client.query(
            "UPDATE tool_jobs SET state = 'failed', error = ?, finished_at = ? "
            "WHERE id = ? AND state = 'running'", (message, now(), job_id))
        raise


def recover_jobs(client, limit=2):
    """Process a small oldest-first batch left queued after a lost dispatch."""
    if limit < 1 or limit > 5:
        raise ValueError('Recovery limit must be between 1 and 5')
    queued = client.query(
        "SELECT id FROM tool_jobs WHERE state = 'queued' AND expires_at > ? "
        'ORDER BY requested_at ASC LIMIT ?', (now(), limit))
    completed, failed = [], []
    for row in queued.get('results') or []:
        job_id = row['id']
        try:
            run_job(client, job_id)
            completed.append(job_id)
        except Exception as exc:  # noqa: BLE001
            failed.append({'id': job_id, 'error': str(exc)[:300]})
    return {'completed': completed, 'failed': failed}


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('job_id', nargs='?', default=os.environ.get('SOURCE_TOOL_JOB_ID'))
    parser.add_argument('--recover-limit', type=int)
    args = parser.parse_args(argv)
    if not args.job_id and args.recover_limit is None:
        print('SOURCE_TOOL_JOB_ID is required', file=sys.stderr)
        return 2
    try:
        client = D1RestClient(
            os.environ.get('CLOUDFLARE_ACCOUNT_ID'),
            os.environ.get('CLOUDFLARE_D1_DATABASE_ID'),
            os.environ.get('CLOUDFLARE_D1_API_TOKEN'))
        if args.recover_limit is not None:
            result = recover_jobs(client, args.recover_limit)
            print(f'Recovery: {len(result["completed"])} completed, '
                  f'{len(result["failed"])} failed')
        else:
            result = run_job(client, args.job_id)
            print(f'Completed {args.job_id}: {result.get("count", 0)} results')
        print(f'D1 usage: {client.usage}')
        return 1 if args.recover_limit is not None and result['failed'] else 0
    except Exception as exc:  # noqa: BLE001
        print(f'Source-tool job failed: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
