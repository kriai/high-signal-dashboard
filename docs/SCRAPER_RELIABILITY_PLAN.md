# Scraper reliability implementation plan

Status: implemented in this workspace on 2026-09-10. Production deployment and
the authoritative D1 source table have not been changed.

Prepared 2026-09-10 against checkout `094dc7a`. Read this alongside [SCRAPER_ARCHITECTURE.md](SCRAPER_ARCHITECTURE.md). The attachment summarizes that architecture document; it contains no source failure logs. Function names below are the primary anchors because line numbers will move.

## Outcome

Make source failures diagnosable, recover from selector and endpoint changes when a validated alternative exists, and keep a temporary failure from removing a source's last good articles. A source must not count as healthy merely because it returns HTTP 200 or produces a few navigation links.

Keep the scheduled Python scraper, existing deterministic ranking, and immutable D1 publication architecture. Implement in the ordered stages below. Do not start with a rewrite, browser automation, a proxy purchase, or more aggressive retries.

## 1. Evidence and confidence

### Saved observations, not a live production audit

The local `health.json` snapshot contains 27 sources: 24 enabled, 22 `ok`, 2 `error`, and 3 `disabled`. Its checks are stamped around `2026-09-10T17:46–17:47`, without timezone offsets.

| Observation | Evidence | Implication |
| --- | --- | --- |
| Both Information sources return 403 | `The Information` and `The Information Startup`: 33 consecutive failures each; last success September 4 | Repeating the same request three times does not repair access denial. Determine whether an accessible publisher endpoint exists. |
| A healthy source can contain no news | Cached `State of AI` articles are “📧 Air Street Press” linking to a publication homepage and “Air Street Capital” linking to `/portfolio` | Generic fallback links can pass `is_junk`; article count alone does not establish extraction quality. |
| Disabled sources accumulate failures | Morning Brew, StrictlyVC, Product Hunt AI each have 107 failures despite being disabled | Operational counters currently conflate non-attempts with failures. |
| Some healthy sources return one item | Last Week in AI, AI Weekly, The Hustle | Investigate extraction and expected publishing cadence; one result is not automatically a failure. |
| Newsletter labels mask site-wide feeds | Axios Pro Rata uses `https://api.axios.com/feed/`; Term Sheet uses `https://fortune.com/feed/`; both limitations are already recorded in `sources.json` | Availability fixes must preserve the intended publication scope. General publisher news is not automatically newsletter content. |

`DEPLOY.md`, “Known rough edges,” also records five sources failing with 403 from CI while working locally: Ben's Bites, Deep Learning Weekly, Last Week in AI, The Machine Learning Engineer, and The Information. Treat that as historical evidence of an environment-dependent problem. Its IP-reputation explanation has not been independently verified here. The next AI must compare actual runner responses before prescribing a hosting or network change.

### Code defects confirmed with offline reproductions

The following probes ran against the existing implementation with synthetic HTML or mocked network boundaries. They wrote no fixture files and made no publisher requests.

| Defect | Location | Reproduction result |
| --- | --- | --- |
| Fallback stops too early | `scraper.py:833`, `scrape_with_selectors` | Primary `.nav a` matched “About us”; extraction returned 0. Fallback `article h2 a` would return 1 valid article but was never tried. |
| One failed source loses its articles while another succeeds | `scraper.py:1226`, `scrape_all`; `pipeline.py:283`, `_validate_run` | Previous Fixture A article + A failing + B succeeding produced a publishable snapshot containing only B. |
| Disabled means another failure | `scraper.py:1201`, `record_health` | Previous failure count 4 became 5 when recording `disabled`, with zero attempts. |
| Bad retry configuration can escape the source boundary | `scraper.py:1122`, `scrape_source` | `retries='invalid'` raised `ValueError` before entering the request try/except. |

Other verified code limitations:

- Selectors are split with `.split(', ')`, which is inconsistent for comma formatting and can break valid CSS containing commas inside functional selectors or quoted values.
- HTML item exceptions and invalid selectors are silently swallowed. Feed parser warnings, unexpected JSON shapes, and filter rejection reasons are not surfaced.
- Challenge detection runs only after dispatching RSS/JSON, so a feed endpoint returning challenge HTML is not diagnosed through the same path.
- Every unsuccessful request is retried, including permanent statuses and deterministic parse failures; sleeps also happen after the final attempt. Listing bodies are read without a byte cap.
- Production joins relative article links to the configured display URL, while discovery uses the redirected page URL. These can disagree.
- `source_tools.py` and `app.py` duplicate validation/discovery/test logic. The Worker has another source-field whitelist in `validateSource`; new fields will disappear unless all relevant boundaries support them.
- Retained dashboard rows are already deduplicated. They cannot reconstruct the individual source batches or an alternate source's lost copy of a clustered story.
- `_validate_run` guards against total failure, not a severe partial outage. Its `ok` check is not explicitly limited to successful attempts in the current pass.

Baseline verification: `.venv/bin/python -W ignore -m unittest discover -s tests -v` passed **39 tests**. The four probes above demonstrate gaps despite that green suite. This workspace's default `python3` lacks BeautifulSoup; `.venv/bin/python` is Python 3.9.6. CI declares Python 3.12. Do final implementation verification on 3.12 too; do not change dependencies simply to match the local interpreter.

## 2. Boundaries and decisions

1. Preserve article IDs (`md5` of the existing normalized full title plus link), scoring/reasons, category ordering, publish-date precision, and `first_seen` for unchanged articles. A corrected broken relative URL can necessarily produce a different ID; report that migration impact.
2. Keep `html.parser` for listing extraction. Do not rotate RSS/JSON User-Agent headers or change the fetch client as part of this work.
3. Keep public health states `ok`, `empty`, `error`, `disabled`, `pending`. Add diagnostic fields rather than breaking every state consumer.
4. Persist source-local last good batches **before cross-source deduplication**. This is needed for reliable recovery and accurate `also_in`, not just for display caching.
5. Default temporary retention to 72 hours since the source batch was actually fetched successfully. Make it configurable per source, bounded to 0–168 hours. These are starting product defaults, not measurements of publisher behavior.
6. A failed attempt must remain a failure even while old articles remain visible. Retained articles never renew their fetch time, publish time, or `first_seen`.
7. Keep source fetching sequential in this iteration. Fix waste and enforce budgets before adding concurrency. Do not add cross-run circuit breakers until failure state can be persisted independently of successful publications.
8. Source discovery recommends configurations. It never silently changes authoritative source definitions or enables a disabled source.
9. No new model dependency, CAPTCHA handling, authenticated scraping, or paid infrastructure. If a source requires access the deployment does not have, expose that limitation precisely.

## 3. Stage A: observable source results and one configuration contract

**Files:** `scraper.py`, `source_tools.py`, `source_tool_job.py`, `app.py`, `worker/src/index.ts`, `tests/test_source_tools.py`; add focused `source_config.py` and `tests/test_scraper.py` if useful.

Introduce an internal structured result for one strategy attempt and one source run. Preserve `scrape_source -> (articles, health)` for existing callers while migrating internals.

Suggested bounded health additions:

```json
{
  "failure_kind": "blocked",
  "fetch_url": "https://publisher.example/feed",
  "final_url": "https://publisher.example/feed",
  "strategy_id": "primary",
  "selector_used": null,
  "raw_candidates": 0,
  "accepted_articles": 0,
  "rejected_counts": {},
  "parser_warning": null,
  "retained_articles": 12,
  "last_good_fetch_at": "2026-09-10T10:00:00Z",
  "quality_warnings": []
}
```

Use stable `failure_kind` values: `invalid_config`, `blocked`, `rate_limited`, `not_found`, `timeout`, `network`, `unexpected_content`, `parse_error`, `selector_miss`, `filtered_all`, `empty_feed`, `response_too_large`, `deadline`, `internal_error`. Keep `null` on success. Separate recoverable parser warnings from failures.

- Count fetched candidates, invalid/missing title/link, navigation filtering, duplicate rejection, source-scope rejection, and item exceptions. Keep at most three sanitized exception samples in private diagnostics. Do not add raw bodies, tokens, or full exception dumps to dashboard documents.
- Track every actual HTTP attempt, final outcome, content type, redirect target, elapsed duration, and response bytes. Do not leave the HTTP status from an earlier attempt attached to a later timeout as though it were the timeout's response.
- Increment `consecutive_failures` once per attempted failed source run, reset on actual accepted success, and leave it unchanged for disabled/unvisited sources. Keep `last_success` unchanged on failures.
- Validate each source at ingestion and isolate bad source configs at execution. Validate `limit`, `retries` (legacy total-attempt semantics, range 1–3), types, booleans, selectors, strategy lengths, and URLs. Malformed items must not kill unrelated entries; unexpected source exceptions must not kill unrelated sources. Unreadable global storage still fails closed.
- Use a dependency-light Python configuration module to avoid `scraper -> source_tools -> scraper` import cycles. Make Flask routes thin wrappers around shared tools, preserving HTTP shapes/status codes. Keep Python and TypeScript validation aligned using shared JSON test vectors.
- Validate duplicate/missing source identities before creating dictionaries; never silently collapse sources. D1 source IDs already exist in `_storage.id`; preserve them for internal state. Local configurations can remain name-keyed for compatibility.

Acceptance: each confirmed defect above has a meaningful regression fixture/test. A malformed source produces an actionable health result while a healthy neighbor completes. Old source payloads still validate, and new fields survive Worker edits and local tool round trips.

## 4. Stage B: select usable articles, then try explicit alternatives

**Files:** `scraper.py` extraction functions, shared configuration, `source_tools.py`, source editor serialization in `static/js/dashboard.js`, Worker validators.

### HTML selection

Change the selection unit from “nodes matched” to “usable articles extracted.” For each ordered selector candidate, extract and validate articles; continue when there are zero accepted articles. Return the first usable configured candidate by default. Report low yield as a warning; do not invent a universal minimum of five articles.

- Preserve existing ordered top-level comma-separated selectors with a CSS-aware splitter that respects quotes, escapes, brackets, and parentheses. Test `:is(h2, h3) a`, attribute values containing commas, and strings without spaces after commas. Add an optional explicit array for new strategy configurations so their ordering is unambiguous.
- Invalid selectors are visible diagnostics. A valid later fallback may still succeed. Reject invalid newly saved configs instead of silently accepting syntax errors.
- After configured selectors, try content-region anchors. Remove the blanket first-40-links fallback from production acceptance; it may still be offered as a low-confidence discovery candidate for review.
- Exclude navigation/header/footer containers in generic extraction, with explicit source selectors available for unusual real layouts. Add source-specific article path/host constraints for publishers that need them. Do not globally ban external links: HN, Techmeme, and Lobsters deliberately link elsewhere.
- Resolve relative links against the effective fetched document URL; honor a valid document `<base>` where appropriate. Preserve feed-provided resolved links and Atom/RSS base semantics. Validate resulting HTTP(S) URLs. Add redirected archive and relative-feed-link tests.
- Use the existing article builder semantics for every adapter. Avoid casually changing text joining/truncation and thereby re-keying all articles.

### Ordered publisher endpoints

Add an optional `fetch_strategies` array, at most four entries. Existing configs without it compile to one strategy using current `type`, `feed_url || url`, `selector`, and `fallback`. If the array is present, it is the complete ordered strategy list; top-level `url` remains the human-facing publication URL. Each strategy has a unique ID, explicit URL, `static|rss|json` type, and HTML selectors if needed. No recursive fallbacks.

Prefer a **verified publisher feed** over HTML when it covers the same publication. Fall back only to explicitly configured endpoints. An alternative that returns general site news for a specific newsletter does not qualify without an intentional scope change.

Run alternatives within a shared source budget. Never merge arbitrary unrelated candidate feeds. A 403 ends attempts against that endpoint, but a configured public alternative on a different endpoint may be tried if the source budget allows. A 429 constrains the entire responding host, including alternate paths.

### Feed and JSON parsing

- Detect challenge/login/interstitial bodies and unexpected formats before adapter dispatch, including HTTP 200 feeds that contain HTML. Match conservative markers with structural context; do not reject genuine articles merely mentioning Cloudflare.
- Feed parsing must distinguish valid empty feed, malformed feed, usable feed with a parser warning, and non-feed HTML. Parse bytes with available encoding/base metadata rather than blindly trusting `response.text`.
- The current JSON adapter is Reddit-specific. Validate that shape explicitly. Do not claim generic JSON Feed support without adding a separately tested adapter.
- Catch malformed individual feed entries/JSON children, count them, and continue. Apply the article limit after item validation and within-source dedupe; duplicate early entries must not prevent later valid entries filling the limit.

Acceptance: primary navigation-only matches fall through to a real fallback; footer-only pages never become healthy; malformed one-item data does not hide valid siblings; preview and production return the same accepted title/link sets for every fixture.

## 5. Stage C: bounded fetches and appropriate retries

**Files:** introduce a shared fetch helper, e.g. `source_fetch.py`; use it from scraping and discovery. Route summary requests through the same URL-safety boundary while retaining their existing summary-specific byte reader.

Keep one implementation of redirect handling, timeouts, response classification, and diagnostic capture. Continue using the current client initially.

| Outcome | Behavior |
| --- | --- |
| Connection failure, timeout, 408, or 5xx | Retry within the total attempt and time budgets; exponential delays starting at 1 second, capped at 8 seconds, with small jitter. |
| 429 | Parse both forms of `Retry-After`; do not retry earlier. If it exceeds remaining time, end with `rate_limited`; suppress further requests to that host in this run. |
| 401/403, recognized challenge | Classify as access blocked; no repeated identical endpoint requests. Try only configured eligible alternatives. |
| 404/410 | Endpoint unavailable; no repeated identical requests. |
| Invalid selector, deterministic parser failure, filtered-all | Try the next extraction strategy; do not refetch the same body hoping parsing changes. |
| No attempts/time left | End immediately; never sleep after the final attempt. |

Initial configurable limits: 3 HTTP attempts per endpoint, 5 total HTTP requests per source including redirect hops, 45 seconds per source, and a 10-minute listing-run budget. Reserve the existing summary budget plus publication time within the workflow's 20-minute timeout. An explicit caller deadline always wins. Discovery needs its own bounded request budget too.

Use monotonic time internally and recalculate the remaining timeout before each request, redirect, streamed read, and sleep. Suggested connect/read maxima are 5/10 seconds, clipped to remaining time. Cap **decompressed** listing/feed/JSON bytes at 2 MiB initially, close responses on every path, and emit a distinct oversize failure. Confirm the cap against captured representative responses before rollout. Do not reuse the summary reader's head-early-stop rule for full listings.

The current URL guards only reject obvious hostname/IP literals; redirects and DNS resolution can still reach private targets. Because this plan adds alternative endpoints, enforce public HTTP(S) destinations at every actual connection, including discovered feeds and summary URLs. Reject credentials, local/private/reserved resolved addresses, and unsafe redirect hops. Bind validation to the address actually connected to, preserving hostname/TLS verification, rather than doing a DNS check followed by an unrelated second resolution. Test with mocked DNS/transport; do not contact private targets. Keep this enforcement in the Python fetch layer because that is where requests execute.

Acceptance: fake clocks and fake responses prove no final sleep, no three identical 403 attempts, correct 429 waiting, bounded slow/oversize responses, and no private-target redirect connection. Deadline exhaustion records unvisited sources without replacing their last successful check timestamps.

## 6. Stage D: durable last good batches and honest stale display

**Files:** `scraper.py`, `pipeline.py`, `scrape_job.py`, `d1_store.py`, legacy load/save paths in `app.py`, `static/js/dashboard.js`; tests for scraper, pipeline, D1, and legacy storage.

Store source-local batches before global dedupe. Suggested internal shape:

```json
{
  "version": 1,
  "sources": {
    "stable-source-key": {
      "name": "Example",
      "config_fingerprint": "...",
      "last_good_fetch_at": "2026-09-10T10:00:00Z",
      "articles": []
    }
  }
}
```

The fingerprint covers extraction semantics: endpoints, strategy ordering/selectors, scope constraints, limits, and ranking/category configuration. It excludes operational metadata such as `_storage.updated_at`. A semantic change invalidates the old batch for retention; cosmetic edits need not. Disabling/deleting a source drops its batch from the next prepared publication. Re-enabling must fetch again.

| Current result | Batch used in this publication | Health |
| --- | --- | --- |
| Accepted successful fetch | Replace last good batch with this source's fresh batch | `ok`; update successful-fetch time |
| Failed, blocked, parse failure, or unexpected zero results | Retain previous compatible batch within its TTL | `error`/`empty`, failure reason, retained count |
| Intentionally empty valid feed | Default to `empty` plus bounded retention; an explicit `allow_empty` source setting can make empty authoritative and clear the batch | Distinguish intentional empty from parser failure; authoritative empty may be `ok` with zero articles |
| Not visited because of deadline | Retain compatible batch within TTL | Preserve previous attempted health, add current-run `attempted=false` and skip reason |
| Disabled, deleted, changed semantics, or TTL expired | No retained batch | Preserve the applicable state/reason; retained count zero |

Add `last_fetched_at` and `is_stale` to published article rows, and `retained_articles` to source health. Freshly fetched old news is not stale retrieval. Age warnings about an unchanged feed must be separate from retrieval failures and respect source cadence.

- Never use new snapshot `generated_at` to refresh stale article ages. Exclude retained-only articles from summary warming. RSS/export should preserve original article dates and identity.
- Deep-copy batches before dedupe: `dedupe` mutates `also_in`. Rebuild cluster attribution from the current fresh/retained batches each pass; never carry an old `also_in` list blindly.
- When a fresh and a retained copy identify the same story, choose a fresh copy as cluster lead, then use existing score ordering within that freshness class. Preserve every score and reason; this is representative selection, not rescoring. Test source disappearance/recovery and stable `first_seen` on unchanged IDs.
- D1: add a private `scraper_state` publication document using the existing generic document table and stage/verify/activate transaction flow. The Worker must not expose it as a new public read. Load it from the **same active publication ID** as the dashboard before scraping. Include its content hash in publication identity so different retained batches cannot share an ID accidentally.
- Local/Blob: add the same state under a versioned `scraper_state` snapshot field, preserving the existing one-snapshot-write remote path. Update cache loaders and Flask state rollback/copy lists; new mutable state must not leak through a shallow copy after failed publication.
- Migration: absent state in an older publication is allowed. Seed only recoverable lead articles grouped by their actual `source`; do not manufacture missing source copies from `also_in`. Mark migration coverage incomplete until sources succeed. Do not infer a fresh success time from the import time. A present but malformed new state document fails validation.
- Normalize **new operational timestamps** to UTC with offsets and compare them with an explicit UTC helper. Leave the legacy article date model unchanged. Treat ambiguous old naive success times conservatively: assume UTC only for known CI-generated state; otherwise require a new successful fetch before granting retention. Tests must cover imported laptop timestamps.
- Bound each batch to the configured article limit (maximum 50), drop expired/deleted entries, and test total document size against existing D1 limits. If needed, split private state into deterministic size-bounded documents in the same atomic publication; never silently truncate active valid batches or bypass size validation.

Acceptance: success → failure → repeated failure → expiry → recovery across process restarts works in both storage modes. A failed source remains visible within TTL with clear stale labeling; a disabled/deleted source does not return through carry-forward or `also_in`.

## 7. Stage E: publication safeguards and repair tooling

**Files:** `pipeline.py`, `scrape_job.py`, shared source tools/Flask routes, Worker tool validation, `static/js/dashboard.js`, `.github/workflows/scrape.yml`; add `scripts/audit_sources.py` and fixture data.

### Publication gate

Evaluate actual current-run outcomes, not carried health or retained article counts. Preserve the current all-failed and empty-dashboard guards. Initial partial-failure rule: require accepted current-run success for at least 50% of enabled configured sources, rounded up, before replacing the active dashboard. Disabled sources are excluded; invalid enabled sources and sources missed by a budget count as unsuccessful. Explicit authoritative empty success can count as source success, but cannot bypass the empty-dashboard guard.

Expose this threshold as an operator setting and include the numerator/denominator in diagnostics. A greater-than-50% article-count drop against a comparable prior configuration produces a review warning; do not reject solely on volume because dedupe and legitimate publication cadence change counts. Check the coverage default in shadow runs before enforcement.

On rejection, retain the entire previous publication and return nonzero. Write the current failure report to a CI artifact/job summary even though the active dashboard remains unchanged. Make that distinction explicit: snapshot health is the last published health, not necessarily the latest attempted health. Do not present retained content as a new successful refresh. Independent live failure telemetry can be a later feature.

### Shared discovery and source testing

- Production, preview, and discovery evaluation must use the same adapters and filters. Discovery may rank candidates, but must report accepted counts, rejection reasons, sample titles/links, strategy, content type, and final URL.
- Support a URL that is already a feed. Evaluate configured/discovered feed URLs independently; a blocked landing page must not prevent testing an explicitly supplied feed.
- Auto-discover only bounded publisher-advertised feed links and configured alternatives. Do not crawl an unbounded set of guessed endpoints or silently persist a replacement.
- Fix heading-inside-anchor discovery: `_derived_selectors` currently observes `<a><h3>…</h3></a>` but generates `h3 a`, the opposite nesting. Include a regression fixture for the actual structure.
- Extend Worker `validateSourceToolPayload`, which currently strips discovery input down to a small field set, alongside `validateSource`. Preserve supported advanced config in source editor round trips; it is sufficient to expose advanced strategies through validated admin JSON initially, but the UI must not erase them.
- Replace duplicated Flask discovery/test implementations with wrappers around `source_tools`; verify response compatibility and no scheduler startup when tools run in CI.

### Evidence capture

Create a read-only audit command with source filters, local-source JSON or read-only D1 config input, and a caller-selected output directory. It must never call `publish`, save normal cache/health, edit source config, or dispatch jobs. Output a small JSON report and optional bounded redacted HTML/XML/JSON response fixtures with capture metadata: source config fingerprint, requested/final URL, status, content type, timestamp, environment, bytes, and extractor version.

Separate deterministic fixture tests from optional live audits. Compare a local run and an Actions run for the same configuration. Upload bounded diagnostic reports even when scraping fails. Avoid raw full-page logging; committed fixtures should be minimal excerpts needed for the behavior being tested.

## 8. Source repair queue for the implementing AI

Do this after the shared diagnostics and fixture runner exist. Verify every proposed endpoint from the deployment environment; this plan does not assert that untested feeds exist.

| Source group | Concrete next action | Completion evidence |
| --- | --- | --- |
| Both Information sources | Capture status/content class from CI; inspect publisher-supported accessible listing/feed alternatives; configure only a verified equivalent | A valid fixture and runner success, or accurate blocked status with bounded retention and no pointless retries |
| Five historically CI-blocked sources in DEPLOY.md | Compare identical endpoint and header behavior locally and in Actions | A report distinguishing access denial from selector/parser failure; do not mark repaired based only on laptop success |
| State of AI | Find an actual report/article listing and apply source-specific link constraints; if no article source exists, propose disabling it | Promotional publication/portfolio links are rejected; valid report links accepted if available |
| AI Weekly, Last Week in AI, The Hustle | Inspect full listing and candidate rejection counts; compare genuine available articles with extracted articles | Source-specific expected results; a legitimate single issue remains valid |
| Exploding Topics | Decide whether intended content is editorial blog articles or trend records, based on existing product scope; encode that distinction | Accepted links match the chosen publication scope and exclude navigation/trend chrome |
| Axios Pro Rata and Term Sheet | Verify a newsletter-specific endpoint or metadata/path filter; otherwise document a proposed source-label/scope correction | No site-wide feed silently masquerades as newsletter coverage; avoid unplanned renames because names affect continuity |
| Morning Brew, StrictlyVC, Product Hunt AI | Keep disabled until a verified usable source path exists | No fetches or failure-counter increments while disabled |
| HN, Techmeme, Lobsters, arXiv, Reddit | Use as compatibility controls for external links, parent headings, arXiv sibling titles, feeds, dates, and duplicate stories | Existing good extraction survives shared engine changes |

D1 `sources` is authoritative in D1 mode. Editing `sources.json` alone does not repair production. Prepare source-specific changes with expected revisions and previews; apply through the supported admin update path when implementation/deployment is authorized. Do not bulk-replace the D1 table from stale seed data.

## 9. Test matrix and commands

Use `unittest` and mocked transport/fake clocks; the repository already has them. Fixtures should assert real expected titles, links, rejection reasons, and state transitions rather than mirror implementation details.

| Area | Required cases |
| --- | --- |
| Selectors | Primary matches only junk then fallback succeeds; malformed primary; nested CSS commas; parent-anchor heading; navigation-only page; one legitimate result; redirect-relative URL; external aggregator links |
| Parsing | RSS and Atom; valid empty feed; recoverable parser warning; malformed XML; challenge HTML under RSS and JSON; invalid JSON shape; one malformed item among good entries; duplicates before limit |
| Transport | 403 once; 429 seconds/date forms; timeout then success; 5xx exhaustion; final-attempt no sleep; redirect/request caps; slow stream deadline; oversized decompressed body; unsafe DNS/redirect destination |
| State | Invalid source isolation; duplicate identity rejection; disabled counter stable; all new diagnostic fields bounded; previous status not leaked across attempts |
| Retention | Mixed fresh/failing; repeated failures do not extend TTL; expiry boundary; recovery; empty policy; disabled/deleted/edited source; dedupe lead swap and attribution; process restart; old snapshot migration; ambiguous timezone |
| Publication | Current-run coverage threshold including partial deadlines; all retained is not all successful; rejected run keeps active pointer; report still emitted; internal state contributes to ID; mismatched/corrupt private state fails closed; legacy one-write budget and rollback |
| Tool contracts | Discovery/test/production fixture parity; nested heading discovery; Python/Worker field validation parity; admin edit preserves strategies; Flask wrapper compatibility; no source-table writes during audit/scrape |

Run in a Python 3.12 environment with existing requirements installed:

```sh
python -m unittest discover -s tests -v
npm run check
npm test
```

Run `npm run build` when source editor/display assets change. Verify stale labels and source-test diagnostics in the local UI. Live source checks belong in the explicit audit command and rollout, not mandatory unit tests. A 403 should not randomly make CI unit tests fail.

## 10. Implementation order, rollout, and completion

Suggested reviewable commits, each with its relevant regression tests:

1. Diagnostics/configuration validation and the four confirmed defect regressions.
2. Usable-selector fallback and parser correctness, without source migrations.
3. Shared bounded transport and explicit endpoint strategies; validation/tool parity.
4. Durable pre-dedupe batches, retention/migration, and stale display.
5. Current-run publication gate, shared repair tools, audit artifacts.
6. Evidence-backed source configuration repairs; architecture/deployment documentation updated to match final behavior.

The first commit may add failing regressions on a feature branch, but do not merge a deliberately failing suite. Retention changes must land with their persistence and UI semantics together; an in-memory cache alone is not complete.

Rollout:

1. Capture baseline source reports and representative fixtures from the intended runner, without publishing.
2. Run old and proposed extraction against the same captured responses to distinguish parser changes from publisher changes. Report gained/lost accepted URLs, junk regressions, source coverage, bytes, duration, and proposed gate result.
3. Run three consecutive scheduled-equivalent audits from Actions, including synthetic failure/retention scenarios in offline tests. Check that working control sources remain good and that partial-failure thresholds are attainable.
4. Prepare a preview publication in an isolated database or local store. Verify dashboard/export/RSS/source counts and old/new snapshot compatibility. No writes to production during this planning task.
5. Deploy only as the subsequent implementation task authorizes. Apply targeted authoritative source edits separately from seed-file changes. Keep prior code and source revisions for rollback.

Rollback: revert engine/config changes and, when needed, reactivate a still-retained verified prior publication using the existing conditional activation mechanism. Keep the new private documents additive so older readers can ignore them. Do not erase good state or reset article timestamps to make a rollback appear fresh. Test the rollback path before production rollout.

Completion means: the confirmed regressions are fixed; every enabled source has an accurate current outcome; legitimate fallbacks recover extraction; transient failures preserve bounded clearly stale content across restarts; source previews agree with production; catastrophic partial runs cannot silently replace a healthy dashboard; and every claimed publisher repair has deployment-environment evidence. A permanently inaccessible publisher may remain blocked, explicitly reported. Do not promise 100% source availability from parser changes.

Deferred: browser-rendered adapters, additional JSON formats, paid/API authentication, egress infrastructure changes, automatic source rewriting, cross-run circuit breakers, broader timestamp/ID migrations, and concurrent listing scraping. Revisit these only if the diagnostic evidence shows they are needed after the work above.

## 11. Implementation record

Implemented in this workspace:

- Shared Python source validation, CSS-aware selector lists, ordered endpoint
  strategies, semantic fingerprints, URL/article scoping, and matching Worker
  validation for the new fields.
- Accepted-article selector fallback, structured rejection/parser diagnostics,
  bounded streamed responses, status-aware retries, `Retry-After`, manual safe
  redirects, DNS/connected-peer checks, and the same boundary for summaries.
- Pre-dedupe source batches with configurable retention, stale article markers,
  expiry/config invalidation, fresh-copy cluster leadership, private atomic D1
  continuation state, and the legacy single-snapshot path.
- A current-run publication gate defaulting to 50% coverage and settable with
  `SCRAPE_MIN_SOURCE_COVERAGE`, with the numerator/denominator/required count in
  the run report and snapshot; article-drop warnings, CI diagnostic artifacts,
  shared Flask/source-tool execution, and a read-only audit command.
- Regression coverage for the confirmed defects and the main extraction,
  transport, retention, publication, and Python/Worker configuration contracts.
- Verified seed repairs: Last Week in AI now uses its advertised feed, The
  Information uses its official Atom feed, and four sources with no equivalent
  usable scoped listing are disabled instead of publishing junk or unrelated
  site-wide feeds.

Verification still requiring the deployed environment:

- Three consecutive Actions audits and a preview publication against a separate
  D1 database. The full local audit reached 19 of 20 enabled sources; Techmeme
  had one transient timeout during that run.
- Apply the targeted source changes through the revision-checked admin API after
  deployment. `sources.json` is only the local/Blob seed; D1 remains authoritative.

`DEPLOY.md` now records the new operator settings, the retention behavior that
replaced immediate source drop-off on a 403, the fact that published health is
the last *published* health rather than the latest attempt, and the audit
command. `SCRAPER_ARCHITECTURE.md` describes the final module layout.

Deferred items remain the ones listed in the prior paragraph. Legacy duplicate
private discovery helpers still exist in `app.py`, but the live Flask routes now
delegate to `source_tools.py`; remove those dead helpers with the eventual Flask
retirement rather than mixing that cleanup into scraper behavior.
