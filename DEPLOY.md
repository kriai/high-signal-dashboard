# Deploying

The app still runs unchanged on a laptop (`python app.py`, APScheduler, JSON
files on disk). Everything below is about the second environment, not a
replacement for the first — `BLOB_READ_WRITE_TOKEN` decides which one is live.

## Cloudflare preview (migration path, not live yet)

The Cloudflare implementation serves generated static assets through Workers
Static Assets, keeps the published dashboard and authoritative source settings
in D1, and leaves scraping/source tests in GitHub Actions. The existing Vercel
deployment stays intact until preview acceptance and an explicit cutover.

The preview is deployed and serving the current snapshot at
<https://high-signal-dashboard-preview.krishayd.workers.dev>, backed by the
`high-signal-preview` D1 database. It is a review environment: nothing publishes
into it on a schedule yet, so its feed is as old as the last manual import.

Reads are edge cached by canonical URL and answer `x-cache: hit|miss`. Cache
entries are per data centre, so the first request in a new location is a miss;
that is expected, not a fault. `curl -sI <url>/api/dashboard | grep x-cache`
is the quickest way to confirm caching after a deployment.

Local reproduction uses no real credentials:

```bash
npm ci
npm run check && npm test && npm run build
npx wrangler d1 migrations apply high-signal-preview --local
python3 scripts/import_state.py --local
cp .dev.vars.example .dev.vars
# Set ADMIN_API_TOKEN and GITHUB_DISPATCH_DISABLED=1 in .dev.vars.
npx wrangler dev --local
```

Before the first remote preview, create a separate D1 database, replace the
placeholder `database_id` in `wrangler.jsonc`, apply both migrations, and review
the import without credentials before allowing writes:

```bash
npx wrangler d1 create high-signal-preview
npx wrangler d1 migrations apply high-signal-preview --remote
python3 scripts/import_state.py --public-origin https://PREVIEW.workers.dev
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_D1_DATABASE_ID=... \
  CLOUDFLARE_D1_API_TOKEN=... PUBLIC_ORIGIN=https://PREVIEW.workers.dev \
  python3 scripts/import_state.py --apply
npm run build
npx wrangler deploy
```

Set Worker secrets with `wrangler secret put ADMIN_API_TOKEN` and
`wrangler secret put GITHUB_ACTIONS_TOKEN`. The GitHub token must be a scoped
fine-grained token able to dispatch Actions for this repository. Set plain
Worker variables `GITHUB_REPOSITORY=owner/repository` and
`GITHUB_WORKFLOW_REF=main`; never put either token in `wrangler.jsonc` or the
generated assets.

The workflows use repository variables `CLOUDFLARE_ACCOUNT_ID`,
`CLOUDFLARE_D1_DATABASE_ID`, and `PUBLIC_ORIGIN`, plus the repository secret
`CLOUDFLARE_D1_API_TOKEN`, and `CLOUDFLARE_API_TOKEN` for Worker deployments.
Leave `STATE_BACKEND` unset while the Blob publisher is still production.
Setting it to `d1` moves scheduled publication to D1 and is therefore a cutover
action, not preview setup. To publish one real run into Cloudflare before that
decision, dispatch the scrape workflow with the `state_backend` input set to
`d1`; it applies to that run only:

```bash
gh workflow run scrape.yml -f state_backend=d1
```

`.github/workflows/deploy.yml` runs the Python, TypeScript, client-JavaScript and
Worker-contract suites plus a deployment dry run on every pull request, with no
Cloudflare credentials in that job. It deploys the Worker on pushes that change
site code and on manual dispatch (`preview` by default, `production` only when
chosen), and skips the deployment step with a notice while the repository has no
`CLOUDFLARE_API_TOKEN`. Scrapes publish data into D1 and never redeploy the site.

Keep the published dashboard document under about 300 KB, roughly 400 articles.
That is where the Cloudflare preview measurements put the boundary of the 10 ms
Workers Free CPU budget for uncached filtered compatibility queries; the browser
path itself stays under 5 ms well past that. `scrape_job.py` prints a warning
when a published document crosses the budget.

Reading state (read, saved, hidden, pinned) belongs to one browser at one
hostname. Before moving readers to a new address, use *Reading tools → Save
reading state to a file* on the old origin and *Load reading state from a file*
on the new one; importing merges and never discards what the new browser has.

The owner token is entered in the Sources dialog and retained only in that
browser tab's memory. Source discovery/tests are queued in D1 and dispatched to
the fixed `source-tools.yml` workflow; the normal scrape workflow recovers at
most two missed queued jobs per run. Publication cleanup retains three complete
generations and removes expired jobs/abandoned staging rows after 24 hours.

## Shape of the deployment

Two halves, because no free platform does both well:

- **Vercel** serves the dashboard. Reading, refreshing, and expanding summaries
  never upload state. Explicit source edits still write `sources.json`.
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
| Refresh button → background thread, client polls | Refresh button → check latest published snapshot; no scrape or upload |

## Steps

```bash
vercel login                                        # interactive; needs a browser
vercel link --yes                                   # attach this directory to a project
vercel blob create-store high-signal --access public # then answer "y" to link it
vercel deploy --prod --yes
```

`create-store` prompts twice — once to link the store to the project, once to
pick environments. Linking is what injects `BLOB_READ_WRITE_TOKEN`; skip it and
the app deploys with no state backend and serves an empty dashboard. The store
must be **public**: `store.py` reads blobs from their CDN URL without
credentials.

Then give Actions the same token, so the job writes where the app reads:

```bash
vercel env pull .env.local          # contains BLOB_READ_WRITE_TOKEN
gh secret set BLOB_READ_WRITE_TOKEN < <(grep BLOB_READ_WRITE_TOKEN .env.local | cut -d= -f2- | tr -d '"')
gh workflow run "Scrape sources"    # first run, rather than waiting 30 min
```

The first deploy shows a retryable unavailable state until the first workflow
run publishes a snapshot. Only HTTP 404 means a missing document; a blocked
store or malformed JSON stops the job without overwriting saved state.

> Scheduled workflows are disabled automatically after 60 days of no commits in
> a public repo, and `*/30` schedules are best-effort — Actions drops runs under
> load, so expect the occasional skipped slot.

## Tuning

| Variable | Default | What it does |
| --- | --- | --- |
| `BLOB_READ_WRITE_TOKEN` | — | Selects the Blob backend. Set on Vercel *and* as an Actions secret. Absent = local files |
| `BLOB_PUBLIC_BASE_URL` | Derived from the token’s public store ID | Optional public Blob origin, e.g. `https://<store-id>.public.blob.vercel-storage.com`. Set on Vercel and as an Actions repository variable when overriding |
| `SUMMARY_WARM_LIMIT` | 100 | Articles the CI job pre-fetches summaries for before publishing a scrape. 0 disables it |
| `SUMMARY_WARM_MIN_SCORE` | 60 | Score floor for that pass, matching the dashboard's own 60+ filter |
| `SUMMARY_WARM_BUDGET_SECONDS` | 90 | Wall-clock cap on it, so a run of slow pages cannot stretch the job |

Scrape frequency lives in `.github/workflows/scrape.yml`.

`.python-version` pins 3.12, and the workflow pins the same. Worth keeping:
`lxml==4.9.3` publishes cp312 wheels but not for every newer interpreter, so an
unpinned project would follow the default forward into a source build.

## Summaries

The detail drawer's summary is publisher text, never generated: an RSS blurb,
else `og:description`, else the article's first two sentences, else a fact line
built from the score (`scraper.fetch_article_summary`).

CI prepares publisher summaries for up to 100 articles scoring 60+ and includes
them in the same `cache.json` upload as articles and source health. Summary
fetch failures leave articles eligible for an on-demand retry from Vercel.

On-demand summaries are held in process memory and in the reader's browser
(up to 500 entries, reused for six hours). They never trigger hosted writes.
A new browser may fetch an unprepared summary again. Local development retains
the `summaries.json` sidecar. Hosted reads ignore legacy `health.json` and
`summaries.json`; old blobs can remain without costing write operations.

## Hobby operation budget

- **Zero listings:** `store.py` constructs each public document URL directly.
  Normal token formats require no new configuration; the URL override supports
  future formats. Reads use a stable URL with no cache-busting query, so the CDN
  can reuse downloads between instances. Overwrites can take roughly a minute
  to propagate, plus the app's 60-second state cache and client polling delay.
- **One upload per full scrape:** `cache.json` already carries source health.
  The separate hosted health write and summary sidecar writes are removed.
- **30-minute schedule retained:** 1,440 uploads per 30 days (1,488 for 31).
  This leaves 560 of a 2,000 allowance in a 30-day window for explicit source
  edits and maintenance. These figures assume every scheduled slot runs;
  GitHub Actions schedules are best-effort, not a freshness guarantee.
- **Serialized publisher:** scheduled and manually dispatched workflows share
  the `scrape` concurrency group. The job skips publication when this half-hour
  slot already has a snapshot. Only CI bypasses the CDN cache when loading
  state, so a manual dispatch sees a just-finished publication. Hosted Refresh only checks published
  data; it cannot start overlapping writers or spend extra uploads.
- **No hidden-tab polling:** a visible tab checks each minute; a returning tab
  checks immediately. Summaries, filtering, saving and reading stay available.
- **Failure handling:** a warm server keeps its last good feed and reports a
  storage error. A cold server with no snapshot returns 503 for data requests.
  No durable offline fallback is promised if the entire store is suspended.
- **Usage visibility:** each successful CI job logs its process's read and write
  attempts. These are diagnostic counters, not Vercel's account-wide billing
  totals. Watch Vercel Usage and quota emails for advanced operations, simple
  operations and transfer. Source edits remain billable; this is not a global
  cap across arbitrary user actions or other projects.

## Rollout and recovery

Deploy the web changes and update the default-branch workflow together: an old
web deployment still writes summaries and performs listings, while an old CI
job still uploads separate health. Existing fixed-path `cache.json` snapshots
are compatible and contain health; no data migration or new store is required.

A suspended Blob store must first regain access through Vercel's quota reset
or account resolution. These changes reduce future operations; they do not
reactivate the store or erase prior usage. After access returns, dispatch
`Scrape sources` and check for one write in its log, then verify the dashboard.
In GitHub, enable workflow failure notifications to catch stopped publication.

Run the offline regression suite before publishing:

```bash
python -m unittest discover -s tests -v
node --check static/js/dashboard.js
```

## Known rough edges

- `static/` is served by Flask, so every CSS/JS request is a function
  invocation rather than a CDN hit. Copying `static/` into `public/` at build
  time would move it to the CDN.
- The Blob calls in `store.py` use the REST API directly (`x-api-version: 10`)
  using the existing upload contract. The regression suite mocks the HTTP
  boundary to verify write counts and failures without spending quota. If
  uploads ever start failing with a version error, that header is the thing to
  bump.
- Cached headlines are readable by anyone with the blob URL, since the store is
  public. They are public news headlines, so this is not a leak, but it is worth
  knowing.
- **Five sources 403 from CI that work from a laptop**: Ben's Bites, Deep
  Learning Weekly, Last Week in AI, The Machine Learning Engineer, The
  Information. The same URLs return 200 from a residential IP, so this is
  IP reputation, not a broken selector — four of the five are Substack-hosted
  and Substack blocks datacenter ranges, which is what a GitHub Actions runner
  has. A scrape that 403s contributes no articles, so those sources drop off
  the dashboard until they succeed again (pre-existing behaviour: carry-forward
  only covers sources a pass did not *reach*, not ones that failed). Fixing it
  needs an egress proxy with residential IPs, or running the job somewhere
  other than Actions.
