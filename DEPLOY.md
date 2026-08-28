# Deploying

The app still runs unchanged on a laptop (`python app.py`, APScheduler, JSON
files on disk). Everything below is about the second environment, not a
replacement for the first — `BLOB_READ_WRITE_TOKEN` decides which one is live.

## Shape of the deployment

Two halves, because no free platform does both well:

- **Vercel** serves the dashboard. It only ever reads.
- **GitHub Actions** runs the scrape every 30 minutes and publishes the result
  to a Vercel Blob store, which the app reads from.

The scrape moved out of the web app because it does not fit inside one: a
Vercel invocation is capped at 300s, a background thread is frozen the moment
its response is sent, and Hobby cron jobs are limited to **one run per day**.
Actions has none of those limits, so the full pass runs there with its
politeness delays intact, exactly as it does locally.

| Local | Deployed |
| --- | --- |
| `cache.json` / `health.json` / `sources.json` on disk | Vercel Blob store — the function filesystem is read-only and `/tmp` is per-instance |
| APScheduler thread every 30 min | `.github/workflows/scrape.yml` every 30 min |
| Refresh button → background thread, client polls | Refresh button → inline 45s partial scrape, client reloads |

## Steps

```bash
vercel login                        # interactive; must be done by a human
vercel link                         # attach this directory to a project
vercel blob store add high-signal   # provisions BLOB_READ_WRITE_TOKEN
vercel deploy --prod
```

Then give Actions the same token, so the job writes where the app reads:

```bash
vercel env pull .env.local          # contains BLOB_READ_WRITE_TOKEN
gh secret set BLOB_READ_WRITE_TOKEN < <(grep BLOB_READ_WRITE_TOKEN .env.local | cut -d= -f2- | tr -d '"')
gh workflow run "Scrape sources"    # first run, rather than waiting 30 min
```

The first deploy starts with an empty Blob store and an empty dashboard. It
fills on the first workflow run.

> Scheduled workflows are disabled automatically after 60 days of no commits in
> a public repo, and `*/30` schedules are best-effort — Actions drops runs under
> load, so expect the occasional skipped slot.

## Tuning

| Variable | Default | What it does |
| --- | --- | --- |
| `BLOB_READ_WRITE_TOKEN` | — | Selects the Blob backend. Set on Vercel *and* as an Actions secret. Absent = local files |
| `MANUAL_SCRAPE_BUDGET_SECONDS` | 45 | Budget for the Refresh button, which runs inline and blocks the click |

Scrape frequency lives in `.github/workflows/scrape.yml`.

`.python-version` pins 3.12, and the workflow pins the same. Worth keeping:
`lxml==4.9.3` publishes cp312 wheels but not for every newer interpreter, so an
unpinned project would follow the default forward into a source build.

## Why the Refresh button still does a partial scrape

The scheduled job covers everything, but the button runs inside a request, so
it keeps a 45s budget and visits the least-recently-checked sources first.
Sources it does not reach keep their previous articles (`scrape_all` carries
them through dedupe) and go first next time — the dashboard is never missing a
source, some rows are just older than others.

## Known rough edges

- `static/` is served by Flask, so every CSS/JS request is a function
  invocation rather than a CDN hit. Copying `static/` into `public/` at build
  time would move it to the CDN.
- The Blob calls in `store.py` use the REST API directly (`x-api-version: 10`)
  because Vercel ships no Python SDK for Blob. If uploads start failing with a
  version error, that header is the thing to bump.
- A manual refresh landing mid-workflow is overwritten by the workflow's full
  pass a moment later. Harmless — the full pass is strictly more complete.
