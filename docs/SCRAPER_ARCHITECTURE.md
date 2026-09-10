# Scraper architecture

Written for an agent that has to change this code without reading all of
`scraper.py` first. Everything below is derived from the code as it stands.
Function names are the stable navigation anchors; numeric line references may
drift as the implementation changes.

---

## 0. One-paragraph summary

`scraper.py` turns a list of source definitions (`sources.json` / the D1 `sources`
table) into a flat, ranked, de-duplicated list of article dicts plus a per-source
health table. It fetches each source with `cloudscraper`, parses it via one of
three adapters (HTML selectors, RSS/Atom, Reddit-style JSON), filters out site
chrome, scores every headline with a transparent rule set, assigns a category by
keyword, resolves a publish date from whatever the page actually stated, and
collapses the same story arriving from multiple sources into one row with an
`also_in` list. It never calls a model, never uses tokens, and is fully
deterministic apart from network results and randomized politeness sleeps. The
result is written as an immutable snapshot — a JSON blob (legacy) or a D1
publication (current) — that the read path serves without ever re-scraping.

**Nothing scrapes inside an HTTP request on the hosted deployment.** The scrape is
a scheduled CI job (`.github/workflows/scrape.yml` → `scrape_job.py`).

---

## 1. File map

| File | Role |
| --- | --- |
| `scraper.py` | All scraping, parsing, filtering, scoring, categorising, dating, dedupe, and the legacy JSON cache read/write. The only file that touches the network for feed content. |
| `sources.json` | Committed seed source list (27 sources). Authoritative only in local/Blob mode; in D1 mode the `sources` table is authoritative. |
| `pipeline.py` | Flask-free orchestration: run and validate a scrape, warm summaries, then build the immutable **documents** (`dashboard`, `export`, `rss_default`, `stats`, `sources`, `scraper_state`) that get published. |
| `scrape_job.py` | The scheduled entry point. Branches on `store.backend_name()`: D1 path (`_run_d1`) or legacy Blob/local path (`_run_legacy`). |
| `store.py` | Legacy JSON storage abstraction: `LocalStore`, `BlobStore`, and a `D1StoreBoundary` that deliberately raises so D1 never gets treated as a file backend. |
| `d1_store.py` | D1 REST client + staged/verified/atomically-activated publication store. |
| `source_config.py` | Shared source normalization, CSS-list parsing, endpoint strategy compilation, URL validation, DNS checks, and retention fingerprints. |
| `source_tools.py` | Selector **discovery** and single-source **test**, reusing production extraction and transport behavior. |
| `source_tool_job.py` | Claims one `tool_jobs` row from D1 and runs `discover_source` / `test_source` in CI. |
| `app.py` | Legacy Flask host: scheduler, in-request refresh job, read APIs. Deprecated on the Cloudflare path. |
| `worker/src/index.ts` | Current read path. Serves the published documents from D1. Never scrapes. |

---

## 2. Data model

### 2.1 A source definition

Keys actually used (validated in `source_tools.clean_source`, `source_tools.py:50`):

```jsonc
{
  "name": "Techmeme",              // required, unique, the join key everywhere
  "url": "https://techmeme.com/",  // required, human-facing link shown in the UI
  "type": "static",                // static | rss | json   (default: static)
  "feed_url": "…/feed",            // optional; what is actually FETCHED when set
  "tier": "high",                  // high | medium | low → scoring base
  "category": "…",                 // fallback category (or forced, see lock_category)
  "lock_category": true,           // optional; bypass keyword rules entirely
  "enabled": true,                 // false ⇒ never fetched, health state "disabled"
  "selector": "h2 a, .item a",     // static only; comma-separated CSS, tried in order
  "fallback": ".title a",          // static only; tried after every `selector`
  "fetch_strategies": [            // optional complete ordered endpoint list, max 4
    {"id": "feed", "type": "rss", "url": "…/feed"},
    {"id": "page", "type": "static", "url": "…", "selectors": ["article h2 a"]}
  ],
  "retention_hours": 72,           // last-good source batch TTL, 0–168
  "allow_empty": false,            // true makes verified empty authoritative
  "allowed_hosts": ["example.com"], // optional article-link scope
  "path_prefixes": ["/news/"],    // optional article-path scope
  "limit": 15,                     // max articles kept per source (default 15, clamped 1–50)
  "retries": 3,                    // fetch attempts (default 3)
  "note": "…"                      // free text, ignored by the scraper
}
```

`url` vs `feed_url` is the important one: `feed_url` is what gets requested
(`scraper.py:1150`), `url` stays as the display link and as the base for
`urljoin` on relative hrefs.

### 2.2 An article

Produced by `extract_articles_from_items` (`scraper.py:859`) for HTML and by
`build_article` (`scraper.py:998`) for feeds/JSON. Both emit the identical shape:

```jsonc
{
  "title": "…",                  // whitespace-collapsed, truncated to 200 chars
  "link": "https://…",           // absolutised against source.url
  "source": "Techmeme",
  "category": "Models & Releases",
  "type": "static",
  "timestamp": "2026-09-10T17:11:04.923705",  // when THIS scrape saw it
  "first_seen": "2026-09-10T16:11:09.314510", // carried forward across scrapes
  "published": null,             // ISO or null — never guessed
  "published_precision": null,   // "exact" | "day" | "month" | null
  "id": "a70e1e91…",             // md5(title + link)
  "summary": "",
  "summary_source": "",          // "" | meta | body | feed | metadata | cached
  "summary_checked_at": "…",     // only once a warm/fetch has run
  "summary_error": "…",          // only on a failed fetch
  "signal_score": 91,            // 5–100
  "score_reasons": [ {"label": "…", "delta": 68, "kind": "source"}, … ],
  "also_in": ["Hacker News"],    // other sources that carried the same story
  "last_fetched_at": "2026-09-10T12:00:00Z",
  "is_stale": false              // retained after a failed fetch when true
}
```

**Invariant:** the `delta`s in `score_reasons` always sum exactly to
`signal_score`, including a synthetic `{"kind": "clamp"}` entry when clamping
bites (`scraper.py:772`). The UI renders this list as the score explanation, so
breaking the sum silently makes the UI lie.

**`id` is `md5(title + link)`** — it changes if either changes. That is why a
headline edited by the publisher loses its `first_seen` and reappears as new.

### 2.3 A health row

One per configured source, produced by `record_health` (`scraper.py:1201`),
including for sources that failed or were skipped:

```jsonc
{
  "name": "…", "url": "…", "tier": "medium", "category": "…", "enabled": true,
  "state": "ok",              // ok | empty | error | disabled | pending
  "articles": 5,
  "http_status": 200,         // null if the request never completed
  "error": null,              // human-readable cause on empty/error
  "attempts": 1,
  "duration_ms": 347,
  "checked_at": "…",
  "last_success": "…",        // carried forward from the previous row
  "consecutive_failures": 0   // incremented across runs
}
```

State semantics: `ok` = returned ≥1 article, or a verified zero-item result when
`allow_empty` is true. `empty` = HTTP 200 but nothing usable (selector miss,
filtered candidates, or an empty feed). A bot challenge is `error` with
`failure_kind: "blocked"`. `error` also covers non-200 responses, invalid
configuration, transport failures, and parser failures. `disabled` =
`enabled: false`.
`pending` = configured but never scraped in this state (`health_summary`,
`scraper.py:1453`).

---

## 3. The pipeline, end to end

```
sources (json file | D1 table)
   │
   ▼  HighSignalScraper.scrape_all(deadline=None, progress=None)      scraper.py:1226
   │    for each enabled source, sequentially, with 0.5–2s sleeps:
   │      scrape_source(source)                                       scraper.py:1122
   │        ├─ compile up to 4 ordered fetch strategies
   │        ├─ bounded streamed GET with manual safe redirects
   │        ├─ dispatch on type:
   │        │    rss    → fetch_feed        (feedparser)              scraper.py:1053
   │        │    json   → fetch_json        (Reddit listing)          scraper.py:1083
   │        │    static → scrape_with_selectors → extract_articles…   scraper.py:833/859
   │        └─ record_health(...)                                     scraper.py:1201
   │
   ├─ update or retain source-local pre-dedupe batches (72h default TTL)
   ├─ dedupe(all)          exact id, then cross-source clustering     scraper.py:1307
   ├─ merge_with_previous  restore first_seen / published / summary   scraper.py:1344
   └─ sort by signal_score desc
   │
   ▼  pipeline.run_scrape(...)                                        pipeline.py:31
   ├─ normalize_summaries       drop app-generated placeholder text   pipeline.py:62
   ├─ _validate_run             require ≥50% current source success
   └─ warm_summaries            threaded, budgeted page fetches       pipeline.py:73
   │
   ▼  pipeline.prepare_publication(snapshot, sources, origin)         pipeline.py:109
   └─ Documents: dashboard | export | rss_default | stats | sources | scraper_state
   │
   ▼  D1PublicationStore.publish(prepared, expected_previous=active)  d1_store.py:295
   └─ stage → verify etags → mark ready → single conditional pointer swap
   │
   ▼  worker/src/index.ts reads the active publication's documents
```

### 3.1 Per-source fetch (`scrape_source`, `scraper.py:1122`)

- Retries only transient timeouts, 408s and 5xx responses, with no sleep after
  the final attempt. Permanent access/not-found failures and deterministic parse
  failures are not repeated. Each source is bounded to 45 seconds, five total
  requests, and 2 MiB per response.
- Redirects are followed manually. Every hop, resolved address, and available
  connected-peer address must remain public.
- Optional `fetch_strategies` provide ordered explicit endpoint fallbacks. A
  legacy source compiles to one strategy using `feed_url || url`.
- **User-Agent rotation is deliberately skipped for `rss` and `json`**.
  `cloudscraper` picks a UA that matches its own TLS
  fingerprint; overriding it makes bot-checked feed endpoints (Reddit) read the
  mismatch as a spoof and answer 403. Do not "simplify" this back to a single
  header block.
- Returns `(articles, health)` — always both, even on total failure.

### 3.2 HTML extraction (`static`)

`extract_static_articles` tries each CSS-aware entry of `selector`, then
`fallback`, and returns the first selector that yields at least one accepted
article after filtering. A selector that matches only navigation no longer
blocks a usable fallback. If configured selectors fail, it tries content-region
anchors outside `nav`, `header`, and `footer`; there is no blanket anchor sweep.

`extract_articles_from_items` (`scraper.py:859`) then, per node:

1. Text → title (collapsed whitespace, ≥5 chars).
2. Link resolution order: the node's own `href` → a descendant `<a>` → a
   **parent** `<a>`. The parent case is what lets selectors target the heading
   *inside* a card link, keeping bylines and tags out of the title.
3. arXiv special case: `ARXIV_ID` matches ("arXiv:2509.01234"), and the human
   title is pulled from the sibling `<dd>` by `resolve_arxiv_title`
   (`scraper.py:787`).
4. `is_junk` filter (§4).
5. In-batch dedupe on `title[:50].lower()` and normalised URL.
6. Score, category, date; stop at `limit`.

Note the parser choice: the **listing** scrape uses `html.parser`
(`scraper.py:1175`) and only the **summary** path uses `lxml`
(`parse_summary_html`, `scraper.py:418`). Every selector in `sources.json` was
written against `html.parser`'s handling of malformed markup — switching the
listing parser will silently change what matches.

### 3.3 Feeds (`rss`) and JSON (`json`)

`fetch_feed` (`scraper.py:1053`) uses `feedparser`, takes
`published_parsed`/`updated_parsed` as a **`precision: "exact"`** timestamp, strips
tags from `entry.summary`, and routes everything through `build_article` so a
feed-backed source is filtered, scored and categorised identically to a scraped
one.

`fetch_json` (`scraper.py:1083`) expects a Reddit listing (`data.children[].data`).
It skips `stickied` posts, uses `created_utc`, and prefers `permalink` for
self-posts so discussion links point at the thread rather than a bare redirect.

Both finish with `dedupe_new` (`scraper.py:1040`).

---

## 4. The junk filter (`is_junk`, `scraper.py:315`)

This is the highest-leverage and most brittle part of the file. It exists because
CSS selectors on real sites pick up nav, footers and legal links alongside
headlines. Order of checks:

1. Normalised title (lowercased, punctuation stripped) is in `BOILERPLATE_TITLES`
   (a ~90-entry set, `scraper.py:18`).
2. Title matches any `JUNK_TITLE_PATTERNS` regex (`scraper.py:38`) — sign-in
   verbs, "read more", TLDR date rails, trend rows like `Soursop bitters+1011%`,
   traffic rows like `google.com105.8B`, `© …`.
3. Non-http(s) scheme.
4. Host in `NON_ARTICLE_DOMAINS` (creativecommons, w3.org, …).
5. Any path segment in `JUNK_PATH_SEGMENTS` (`about`, `tag`, `category`, `feed`,
   `author`, …) or a legal slug (`LEGAL_SLUGS`).
6. The link equals the source's own URL (normalised).
7. One-word title with no digit → a source label ("PCMag"), never a headline.
8. ≤3 words and entirely lowercase → footer copy.
9. **Corroborated rules** — each of these needs a *shallow* URL (≤1 path segment)
   to fire, so that genuinely short headlines on deep slugs survive (the comment
   at `scraper.py:356` cites Stratechery's "Amazon's Durability"):
   - social host + shallow → footer profile link;
   - no path segments and ≤3 words;
   - ≤2 words, no digit, shallow.

Reddit and YouTube are intentionally **absent** from `SOCIAL_DOMAINS`
(`scraper.py:69`) because they are real sources here.

`is_challenge_page` (`scraper.py:376`) is a companion: a 200 response under 20 KB
whose first 4 KB contains a Cloudflare interstitial marker. Both the listing path
and the summary path consult it, so "blocked" is reported as blocked rather than
as an empty selector.

---

## 5. Scoring (`score_headline`, `scraper.py:733`)

Deliberately a rule set, not a model, so every point is explainable in the UI.

```
score = clamp( SOURCE_TIERS[tier] + Σ positive + Σ negative , 5 , 100 )
        high=68  medium=56  low=46           cap +26      floor −24
```

- Tier comes from `resolve_tier` (`scraper.py:721`): explicit `tier` field, else
  a **substring** match against `LEGACY_TIERS` (`scraper.py:104`), else `low`.
  The substring behaviour is intentional — the old exact-match lookup graded
  every parenthesised name ("Import AI (Jack Clark)") as low tier.
- Each rule in `SCORE_SIGNALS` (`scraper.py:112`) fires at most once. Positives:
  ships something concrete (+11), money/deal (+10), names a frontier lab (+8), a
  result not a take (+7), regulatory action (+6), contains a digit (+4).
  Negatives: listicle (−12), question headline (−9), how-to/opinion (−8), hype
  language (−7), meme bait (−6).
- Caps are applied **per rule as it fires**, so a rule that only partially fits
  under the cap contributes a truncated delta and records that truncated delta.
  This is what keeps `score_reasons` summing to the score.
- Band thresholds live downstream, not here: `SCORE_HIGH = 75`, `SCORE_MID = 60`
  (`pipeline.py:18`, mirrored in `app.py:42`). `SCORE_MID` doubles as the summary
  warming floor and the RSS inclusion floor.

---

## 6. Categories (`categorize`, `scraper.py:288`)

Ordered regex list `CATEGORY_RULES` (`scraper.py:202`), **first match wins**, so
narrow buckets sit above broad ones (Security → Policy → Funding → Chips →
Crypto → Science → AI Research → Models & Releases → AI Tools & Agents →
Engineering & Open Source → Big Tech → Business & Markets → `Other`). "Google
sued over ads" is Policy, not Big Tech, purely because of that ordering — reorder
the list and you re-file large parts of the corpus.

`resolve_category` (`scraper.py:937`): if the source sets `lock_category: true`,
its `category` wins unconditionally (arXiv listings are papers even when the
title says "agents"); otherwise the keyword rules run and the source's `category`
is only the fallback.

---

## 7. Publish dates (`resolve_published`, `scraper.py:650`)

Returns `(iso_or_None, precision)` where precision is `exact` | `day` | `month`.
**A missing date is left null. Nothing is inferred from scrape time.** The UI
renders "2h" only for `exact` and "27 Aug" for coarser precisions, so it never
implies accuracy the page did not give.

Order — by how tightly the evidence is bound to *this* headline, not by how
precise it looks:

1. `<time datetime>` / `[datetime]` / `[data-timestamp]` on the node or up to 4
   ancestors. `precision = exact` when the raw string is longer than 10 chars.
2. A dated URL slug: `/2026/08/27/…`, `/2026/08/…`, `/2026/Aug/27/…`
   (`published_from_url`, `scraper.py:629`).
3. A relative age ("3 hours ago") or a written date ("Aug 26") found in the
   node's immediate surroundings.

Step 3 is heavily fenced:

- The climb stops as soon as an ancestor contains **more than one** long anchor —
  past that point the text belongs to a neighbouring card.
- The headline's own text is removed before scanning, because
  "Mechanical Turk shutting down September 30" was otherwise filed as *published*
  on 30 September.
- Only the first 240 characters are scanned.
- `published_from_relative` (`scraper.py:591`) requires the literal word "ago"
  when the match has no `ago` group, so "6 min read" is not a date.
- Nothing may land more than one day in the future (`horizon`); a bare "Dec 20"
  seen in January rolls back a year.

`parse_iso` (`scraper.py:573`) is the lenient parser used everywhere: handles
trailing `Z`, falls back to a date-only prefix, and always returns **naive**
datetimes. All timestamps in this system are naive local time — CI runs on UTC,
a laptop does not, which is why the slot-suppression logic in `scrape_job.py`
compares slots rather than elapsed time and explicitly tolerates future-stamped
snapshots (`scrape_job.py:115`).

---

## 8. Dedupe and continuity

`dedupe` (`scraper.py:1307`) runs in two stages:

1. Collapse identical `id`s.
2. Cluster across sources: for each article, in **descending score order**, build
   up to two keys — `url:<normalised link>` and `title:<cluster_key>`. The first
   article to claim a key becomes the cluster **lead**; every later article
   sharing a key is dropped from the list and its source is appended to the
   lead's `also_in`.

`cluster_key` (`scraper.py:781`) is the sorted set of the first six words longer
than 3 characters from the normalised title, and returns `''` (i.e. no title key)
for titles with fewer than three such words — deliberately, so short titles are
not over-merged.

Because leads are chosen by score, the strongest copy of a story survives and the
rest become `also_in` attribution. That is why Techmeme/HN/Lobsters carrying the
same link produce one row.

`merge_with_previous` (`scraper.py:1344`) then restores continuity from the
previous snapshot, keyed by `id`: `first_seen`, and — only when the new scrape
found nothing — `published`/`published_precision` and `summary` (+ its source,
checked-at and error). `first_seen` matters because most scraped pages publish no
date, so "recency" in this product means *new to the dashboard*.

`scrape_all` re-indexes `previous_by_id` from the merged result before returning
(`scraper.py:1296`); without that, everything discovered by this pass would look
brand new again on the next one.

---

## 9. Partial passes and the deadline

`scrape_all(deadline=…)` supports a wall-clock cutoff for
environments with an invocation cap:

- Enabled sources are sorted **least-recently-checked first** using
  `health[name].checked_at`.
- The loop breaks once `time.time() >= deadline` (never before the first source).
- `self.covered` records which sources this pass actually visited.
- Compatible source-local batches are retained for both unvisited and failed
  sources, for 72 hours by default. Retained articles keep their timestamps,
  carry `is_stale: true`, and are excluded from summary warming. Disabled,
  deleted, semantically edited, or expired sources are never retained.

`pipeline.run_scrape` gives the scheduled listing pass a 600-second deadline by
default (`SCRAPE_BUDGET_SECONDS`). It is checked between sources, so a source
already in flight may finish its bounded attempt before the pass stops. The
same deadline mechanism also serves the local
`start_refresh(background=False, deadline=…)` route.

---

## 10. Summaries

No model is involved anywhere. `fetch_article_summary` (`scraper.py:955`) returns
`(summary, source, error)`:

1. Streamed GET, then `read_capped` (`scraper.py:431`) — reads until 64 KB past
   `</head>` (or 768 KB hard stop) and closes the response. The header comment
   records the measurement behind this: across 36 sampled pages the head closed
   at a median 24 KB while pages averaged 329 KB; a flat 256 KB cap would read
   163 KB/page *and* still miss the two pages that bury `og:description` past
   398 KB.
2. Charset handling is explicit: `requests` defaults `text/html` with no declared
   charset to ISO-8859-1, which mangles the curly quotes these summaries are full
   of, so an undeclared charset is decoded as UTF-8 with `errors='replace'`.
3. `summary_from_meta` (`og:description` → `description` → `twitter:description`)
   → `summary_source: "meta"`.
4. `summary_from_body` — first paragraphs of `article`/`main`/`body`, first two
   sentences → `summary_source: "body"`.
5. Otherwise `metadata_summary` (`scraper.py:500`) — a deterministic line built
   from fields already in the cache ("Scored 91 for …; Also carried by …") →
   `summary_source: "metadata"`, which downstream treats as *a failure*, not a
   summary.

`is_useful_summary` rejects anything under 45 chars, anything whose first 180
chars mention cookies/subscribe/newsletter/etc., and anything identical to the
title. `trim_summary` caps at 280 chars on a word boundary.

**Warming** (`pipeline.warm_summaries`, `pipeline.py:73`): targets are articles
with no summary, `signal_score >= SCORE_MID`, and a public http(s) URL; sorted by
score, capped at `SUMMARY_WARM_LIMIT` (100), then **round-robined by host**
(`_round_robin_hosts`, `pipeline.py:293`) so eight worker threads never hammer one
domain. A 90-second budget and 8 workers by default, all overridable via
`SUMMARY_WARM_LIMIT` / `SUMMARY_WARM_MIN_SCORE` / `SUMMARY_WARM_BUDGET_SECONDS` /
`SUMMARY_WARM_WORKERS` (`pipeline.settings_from_env`, `pipeline.py:320`). Results
with `source == 'metadata'` are discarded rather than stored.

`normalize_summaries` / `is_generated_summary` (`scraper.py:468`) exist to strip
the legacy `"Headline picked up from …"` placeholder that an earlier version
wrote into the cache.

---

## 11. Publication and storage

### 11.1 Backend selection (`store.py:140`)

`STATE_BACKEND` ∈ `local` | `blob` | `d1`. Legacy default: `blob` if
`BLOB_READ_WRITE_TOKEN` is present, else `local`. In `d1` mode the file helpers
raise `StoreUnavailable` by design (`D1StoreBoundary`) — D1 is *not* dressed up as
a JSON file store; the publisher uses `d1_store.py` and the Worker uses a D1
binding.

### 11.2 Documents (`pipeline.prepare_publication`, `pipeline.py:109`)

`publication_id = 'pub-' + sha256(generated_at + articles + health +
scraper_state)[:24]` — content addressed, so re-running identical content and
continuation state is idempotent.

| Key | Content |
| --- | --- |
| `dashboard` | `{schema_version, publication_id, generated_at, articles, stats, sources}` — the one document the Worker parses for full reads. |
| `export` | `{generated_at, count, articles}` for `/api/export`. |
| `rss_default` | Pre-rendered RSS: articles at `score ≥ SCORE_MID`, newest-first by `article_time`, capped at 60 items. |
| `stats` | Pre-rendered copy of `dashboard.stats`. |
| `sources` | Pre-rendered copy of `dashboard.sources`. |
| `scraper_state` | Private source-local batches and fingerprints for the next scheduled run. The Worker exposes no route for this key. |

`stats` and `sources` are duplicated as standalone documents on purpose
(`pipeline.py:147`): parsing the 154 KB dashboard costs 7–15 ms of the Workers
Free 10 ms CPU budget. `DOCUMENT_BUDGET_BYTES = 300_000` (`pipeline.py:26`) is a
*warning* threshold measured against that budget, not a hard limit; the hard
limits are in `d1_store.py` (`DOCUMENT_WARN_BYTES = 1 MB`,
`DOCUMENT_MAX_BYTES = 1.9 MB`).

### 11.3 Atomic publish (`d1_store.py`)

`stage()` inserts the publication row (`ready = 0`) and its documents with
`ON CONFLICT DO NOTHING`, **reads back every etag/byte_count/content_type and
compares against the manifest**, and only then flips `ready = 1`. `activate()` is
a single conditional `UPDATE app_state SET value = ? WHERE key =
'active_publication_id' AND value = <expected_previous> AND EXISTS (ready
publication)`. A conflict raises `PublicationConflict` and leaves the previous
publication active. `prune()` retains 3 ready generations plus the active one,
deletes abandoned staging older than 24h, and expired `tool_jobs`.

### 11.4 Failure policy

Deliberately fail-closed, at three layers:

- `_validate_run` (`pipeline.py:283`) raises if the scrape produced no articles or
  if every enabled source failed → the previous publication stays active.
- Publication also requires a current-run success from at least half of enabled
  sources, rounded up. Retained articles do not count as successful fetches.
- `scrape_job._run_d1` catches `D1Error` and returns exit 1 without touching the
  pointer.
- Slot suppression: if the active publication's `generated_at` falls in the
  **same** 30-minute slot as now, the run is skipped (`scrape_job.py:115`). Only
  the same slot suppresses — a future-stamped snapshot (a laptop ahead of a UTC
  runner) does not block CI.

---

## 12. Scheduling and entry points

| How | What runs |
| --- | --- |
| `python scraper.py` | Full pass, writes `cache.json` + `health.json`, prints the ≥80 headlines. The quickest local smoke test. |
| `python scrape_job.py` | The scheduled job. D1 or legacy depending on `STATE_BACKEND`. Sets `SCRAPE_JOB=1` before importing `store`, which also stops `app.py` from starting its scheduler. |
| `.github/workflows/scrape.yml` | Cron `7,37 * * * *` (off-peak minutes), `concurrency: scrape`, 20-minute timeout, runs the test suite first, then `scrape_job.py`, then recovers up to 2 queued source-tool jobs. |
| `app.py` (local only) | APScheduler every `SCRAPE_INTERVAL_MINUTES = 30` plus a `boot()` refresh when the cache is older than `STALE_AFTER` (60 min). Guarded by `owns_background()` so the Werkzeug reloader cannot start it twice. Skipped entirely when `store.is_remote()`. |

GitHub Actions was chosen over platform cron because Vercel Hobby cron is capped
at one run per day and 300 s per invocation; Actions has neither limit, so the
full pass with its politeness sleeps runs unmodified
(`.github/workflows/scrape.yml` header, `scrape_job.py` docstring).

---

## 13. Source discovery and testing (`source_tools.py`)

Owner-facing tooling that reuses the scraper's production extraction and
transport paths so preview behavior does not drift from scheduled scraping.

- `discover_source` (`source_tools.py:111`) fetches the page once, then:
  **RSS candidates** from `<link rel=alternate>` (up to 4, each actually fetched
  and parsed, confidence 78–90); **static candidates** from
  `COMMON_HEADLINE_SELECTORS` plus selectors *derived from the page itself*
  (`_derived_selectors`, `source_tools.py:196` — heading tags inside long
  anchors, card-ish class names from up to 4 ancestors, first path segment as
  `a[href*="/news/"]`). Up to 90 selectors are evaluated against the already
  fetched soup via `scraper.extract_articles_from_items`, ranked by
  `_candidate_score` (`source_tools.py:174`: articles × 18, plus bonuses for
  `article `/`main `/heading/`[href*=` prefixes, penalties for high-raw-count
  low-yield selectors), and the top 8 are returned — each with the next-best
  selector pre-filled as its `fallback`.
- `test_source` (`source_tools.py:144`) runs the real `scrape_source` with
  `retries: 1` and returns state, HTTP status, error, duration and an 8-item
  preview.
- SSRF guard: `is_public_url` (`source_tools.py:37`) rejects `localhost`,
  `*.local`, `metadata.google.internal` and any private/loopback/link-local/
  reserved/multicast IP literal. Applied to both `url` and `feed_url` in
  `clean_source`, and again in the Worker (`validatePublicUrl`).
- Execution path in production: the Worker enqueues a `tool_jobs` row and
  dispatches `.github/workflows/source-tools.yml`; `source_tool_job.py` claims it
  with a conditional `UPDATE … WHERE state = 'queued'`, runs it, and writes back
  a result capped at 256 KB. The claim handles a lost REST response by
  re-reading `claimed_at`, and `--recover-limit` processes an oldest-first batch
  of jobs whose dispatch was lost.

---

## 14. Invariants to preserve

1. `score_reasons` deltas sum to `signal_score`.
2. `published` is null unless the page actually stated a date; precision is never
   overstated.
3. `first_seen` survives across scrapes for an unchanged `id`.
4. Every configured source produces a health row every run, including failures
   and disabled sources.
5. A catastrophic run with no articles, no successful source, or less than 50%
   current source success never replaces a good published snapshot.
6. Publication activation is a single conditional pointer update against a
   verified, `ready = 1` publication.
7. The read path never scrapes.
8. Feed-backed and HTML-backed sources go through the same junk filter, scorer
   and categoriser (`build_article` vs `extract_articles_from_items` emit the
   same shape).
9. No model calls, no tokens, anywhere in the scrape path.

## 15. Known traps

- **Parser asymmetry.** Listing = `html.parser`; summaries = `lxml`. Changing the
  listing parser silently changes selector matching across all 20 static sources.
- **UA rotation must stay off for `rss`/`json`.** See §3.1.
- **`CATEGORY_RULES` order is semantics**, not style. Selectors are ordered too,
  but a selector wins only after it yields a usable article.
- **`id = md5(title + link)`** — any change to title normalisation re-keys the
  whole corpus and resets `first_seen` everywhere.
- **Mixed datetime history.** Retention state uses UTC-aware timestamps, while
  older article and publication fields may still be naive. Audit `parse_iso`
  consumers and slot comparisons before changing formats.
- **`extract_articles_from_items` swallows per-item exceptions** (`continue` at
  `scraper.py:932`), so a malformed node is dropped silently. When a source
  yields fewer articles than expected, check there before blaming the selector.
- Flask discovery and test routes delegate to `source_tools.py`, the executable
  implementation used by local and Cloudflare tooling. Legacy private helper
  definitions remain in `app.py` but are no longer called.

## 16. Where to change what

| Goal | Edit |
| --- | --- |
| Add/remove a source | `sources.json` (local/Blob) or the D1 `sources` table via the admin API / `scripts/import_state.py`. |
| Change ranking | `SOURCE_TIERS` / `SCORE_SIGNALS` / caps, `scraper.py:93`–`160`. |
| Change bands (high/mid) | `pipeline.py:18` and `app.py:42` together — the client reads them from `/api/stats`. |
| Add a category | `CATEGORY_RULES` (`scraper.py:202`), minding order. |
| Stop pulling in nav links | `BOILERPLATE_TITLES` / `JUNK_TITLE_PATTERNS` / `JUNK_PATH_SEGMENTS`, `scraper.py:18`–`66`. |
| Support a new source format | Add a branch in `scrape_source` (`scraper.py:1161`) plus a `fetch_*` that ends in `build_article` + `dedupe_new`; extend the `type` whitelist in `source_tools.py:79`. |
| Change what gets published | `pipeline.prepare_publication` (`pipeline.py:109`) and the Worker's `PREPARED_READS` map and `compatibilityRoute` (`worker/src/index.ts:64`, `:501`). |
| Change the schedule | `.github/workflows/scrape.yml` cron **and** the 30-minute slot arithmetic in `scrape_job.py:107`. |

Tests: `python -m unittest discover -s tests -v` — `test_pipeline.py` covers the
scrape→publication contract, `test_d1_store.py` the atomicity guarantees,
`test_hobby_storage.py` the legacy Blob read/write budget, `test_source_tools.py`
the discovery/test job lifecycle.
