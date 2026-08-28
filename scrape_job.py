"""The scheduled scrape, run by CI instead of by the server.

Deployed serverlessly there is nowhere for a long job to live: an invocation is
capped at 300s and a background thread is frozen the moment its response is
sent. So the scrape moved out of the web app entirely. GitHub Actions runs this
on a schedule, it writes the result to the same Blob store the app reads from,
and the app itself never scrapes on a timer.

That also buys back the full pass. Nothing here is racing a deadline, so every
source is visited with its politeness delay intact, exactly as on a laptop.

Not `python scraper.py`: that entrypoint scrapes without loading what came
before, which resets `first_seen` on every article and wipes the per-source
failure history. Going through the app's own loader keeps both.
"""

import sys

import app
import store


def main():
    if not store.is_remote():
        print('⚠️  BLOB_READ_WRITE_TOKEN is not set — writing to local files.')

    app.load_state()
    before = len(app.cached_articles)

    app.scrape_and_cache()

    job = app.refresh_job
    if job['state'] == 'error':
        print(f'❌ Scrape failed: {job["error"]}')
        return 1

    after = len(app.cached_articles)
    covered = len(app.scraper.covered)
    total = len(app.scraper.sources)
    print(f'✅ {after} articles ({after - before:+d}) from {covered}/{total} sources')

    if covered < total:
        # Only a deadline causes a partial pass, and this job sets none.
        print(f'⚠️  Only {covered}/{total} sources were visited')

    return 0


if __name__ == '__main__':
    sys.exit(main())
