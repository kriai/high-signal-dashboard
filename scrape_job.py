"""The scheduled scrape, run by CI instead of by the server.

Deployed serverlessly there is nowhere for a long job to live: an invocation is
capped at 300s and a background thread is frozen the moment its response is
sent. So the scrape moved out of the web app entirely. GitHub Actions runs this
on a schedule, it writes the result to the same Blob store the app reads from,
and the app itself never scrapes on a timer.

That also buys back the full pass. Nothing here is racing a deadline, so every
source is visited with its politeness delay intact, exactly as on a laptop.

The D1 path calls the reusable pipeline directly and never imports Flask or
starts APScheduler. The legacy local/Blob path remains during migration so the
existing deployment continues to work until cutover is approved.
"""

import os
import sys

# The CLI owns its scrape even when testing with local files.
os.environ['SCRAPE_JOB'] = '1'

import store

# One D1 publication per UTC hour. The Worker starts the scrape at :30 UTC and
# GitHub's own timer at :50 is only a backup in the same UTC hour, so the
# backup finds the hour already published and stops before scraping.
PUBLISH_INTERVAL_SECONDS = 60 * 60


def main():
    backend = store.backend_name()
    if backend == 'd1':
        return _run_d1()
    if os.environ.get('GITHUB_ACTIONS') == 'true' and backend != 'blob':
        print('❌ STATE_BACKEND=d1 or BLOB_READ_WRITE_TOKEN is required in GitHub Actions')
        return 1
    return _run_legacy()


def _run_legacy():
    # Import lazily: D1 CI must not initialize Flask or APScheduler.
    import app

    if not store.is_remote():
        print('⚠️  BLOB_READ_WRITE_TOKEN is not set — writing to local files.')

    if store.is_remote():
        store.store.fresh_reads = True

    try:
        app.load_state(allow_empty=True)
    except (store.StoreUnavailable, ValueError, TypeError, KeyError) as exc:
        print(f'❌ Cannot load previous state; nothing published: {exc}')
        return 1

    # workflow_dispatch uses the same concurrency group as the timer. Do not
    # spend another upload when a run already published in this half-hour
    # slot. An elapsed 30-minute cooldown would skip normal scheduled jobs
    # because the previous scrape finished a minute or two after its start.
    if store.is_remote() and app.last_scrape_at is not None:
        interval = app.SCRAPE_INTERVAL_MINUTES * 60
        published_slot = int(app.last_scrape_at.timestamp() // interval)
        current_slot = int(app.datetime.now().timestamp() // interval)
        # Same slot only: a snapshot stamped ahead of this clock is skew, and
        # refusing to publish until the clock catches up would be worse.
        if published_slot == current_slot:
            print('⏭️  This half-hour already has a published snapshot; skipping')
            return 0
    before = len(app.cached_articles)

    app.scrape_and_cache(warm=True)

    job = app.refresh_job
    if job['state'] == 'error':
        print(f'❌ Scrape failed: {job["error"]}')
        return 1

    after = len(app.cached_articles)
    covered = len(app.scraper.covered)
    total = len(app.scraper.sources)
    print(f'✅ {after} articles ({after - before:+d}) from {covered}/{total} sources')

    if store.is_remote():
        print(f'🗄️  Blob operations this process: {store.store.operations}')

    if covered < total:
        # Only a deadline causes a partial pass, and this job sets none.
        print(f'⚠️  Only {covered}/{total} sources were visited')

    return 0


def published_this_slot(previous_time, now,
                        interval=PUBLISH_INTERVAL_SECONDS):
    if previous_time is None:
        return False
    return int(previous_time.timestamp() // interval) == \
        int(now.timestamp() // interval)


def _run_d1():
    from d1_store import D1Error, D1PublicationStore, D1RestClient
    from pipeline import (DOCUMENT_BUDGET_BYTES, prepare_publication,
                          previous_snapshot, run_scrape, settings_from_env)
    from scraper import parse_iso

    try:
        client = D1RestClient(
            os.environ.get('CLOUDFLARE_ACCOUNT_ID'),
            os.environ.get('CLOUDFLARE_D1_DATABASE_ID'),
            os.environ.get('CLOUDFLARE_D1_API_TOKEN'))
        d1 = D1PublicationStore(client)
        active = d1.active_publication_id()
        previous = previous_snapshot(
            d1.load_document(publication_id=active),
            d1.load_document('scraper_state', publication_id=active))

        # A retry or the backup timer in the same hour should not create
        # another generation; compare wall-clock slots, not elapsed scrape
        # duration. Only the same slot suppresses a run. Timestamps are naive
        # local time, so a snapshot imported from a laptop ahead of UTC lands
        # in a future slot on a UTC runner; treating that as "already
        # published" would block CI until the clock caught up.
        from datetime import datetime
        previous_time = parse_iso((previous or {}).get('generated_at'))
        if published_this_slot(previous_time, datetime.now()):
            print('⏭️  This hour already has an active publication; skipping')
            return 0

        sources = d1.load_sources()
        if not sources:
            raise D1Error('D1 has no active sources; run the state importer first')
        snapshot = run_scrape(sources, previous, **settings_from_env())
        prepared = prepare_publication(
            snapshot, sources,
            os.environ.get('PUBLIC_ORIGIN') or 'https://high-signal.invalid')
        manifest = d1.publish(prepared, expected_previous=active)
        print(f'✅ Published {len(snapshot["articles"])} articles as {prepared.id}')
        warm = snapshot['summary_warm']
        print(f'📝 Warmed {warm["warmed"]}/{warm["attempted"]} summaries; '
              f'{warm.get("retry_waiting", 0)} waiting to retry, '
              f'{warm.get("retry_given_up", 0)} given up')
        print('📄 Documents: ' + ', '.join(sorted(manifest['documents'])))
        for key, document in sorted(manifest['documents'].items()):
            if document['byte_count'] > DOCUMENT_BUDGET_BYTES:
                print(f'⚠️  Document {key} is {document["byte_count"]} bytes, over the '
                      f'{DOCUMENT_BUDGET_BYTES}-byte Free-tier CPU budget measured '
                      'for uncached compatibility queries')
        try:
            removed = d1.prune()
            if removed:
                print(f'🧹 Pruned {len(removed)} old publications')
        except D1Error as exc:
            # Activation already succeeded. Cleanup is intentionally best-effort.
            print(f'⚠️  Publication succeeded but cleanup failed: {exc}')
        print(f'🗄️  D1 usage: {client.usage}')
        return 0
    except D1Error as exc:
        print(f'❌ D1 publication failed: {exc}')
        return 1


if __name__ == '__main__':
    sys.exit(main())
