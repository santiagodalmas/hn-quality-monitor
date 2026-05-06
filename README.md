# Hacker News Quality Monitor

[![monitor](https://github.com/santiagodalmas/hn-quality-monitor/actions/workflows/monitor.yml/badge.svg)](https://github.com/santiagodalmas/hn-quality-monitor/actions/workflows/monitor.yml)

A small Playwright-based suite that monitors public Hacker News surfaces
for sort order, API contract conformance, and cross-layer agreement
between the website and the Firebase API. Runs daily in GitHub Actions;
notable observations are written up in [`findings/`](./findings/) using
a structured QA-report template.

## Why I built this

I wanted a portfolio piece that demonstrates the full QA loop:
**automate → observe → investigate → report**. Hacker News is a good
target because its UI and API are both public and stable enough to give
a clear pass/fail signal, while being noisy enough (rate limits,
Cloudflare, occasional outages) to surface real findings worth
documenting.

## Suite

### `src/ui/sort-validator.js` — UI

Visits [`news.ycombinator.com/newest`](https://news.ycombinator.com/newest),
paginates through the "More" link, collects exactly the first 100
articles, and verifies they are sorted **newest → oldest**. Parses each
article's timestamp from the `<span class="age">` `title` attribute
(prefers the unix timestamp; falls back to the ISO string treated as
UTC). Reports newest/oldest articles and total time span on success;
on failure, lists every out-of-order pair with positions, parsed
timestamps, and titles.

### `src/api/firebase-checks.js` — API

Contract tests against [`hacker-news.firebaseio.com/v0`](https://github.com/HackerNews/API):

- `/topstories.json`, `/newstories.json`, `/beststories.json` return
  arrays of integers, capped at the documented 500 ids
- `/maxitem.json` returns a positive integer
- A sampled item from `/topstories.json` has the documented schema
  (`id`, `type`, `time`, plus per-type fields like `title` for stories)
- `/user/<id>.json` returns the documented user shape
- Median response time stays under **2000ms** across 5 samples to
  `/topstories.json`

### `src/crosscheck/ui-vs-api.js` — Cross-layer

Asserts that **every story shown in the UI's top 10 of `/news` appears
within the API's top 50 of `/topstories.json`**. The contract is
deliberately set-based rather than rank-strict, because the cached HTML
page and the API surface can drift by a few positions. A failure here
is a possible real defect (a story that's on the homepage but not in
the API list, or vice versa) and is treated as a finding to investigate
before being labelled a bug.

## Setup

```bash
npm install
npx playwright install chromium   # one-time browser download
```

## Run

```bash
npm run ui            # UI sort validator (headed — good for demos)
npm run ui:headless   # UI sort validator (headless — good for CI)
npm run api           # API contract checks
npm run crosscheck    # UI vs API cross-check (headed)
npm run all           # all three, headless
```

Each script exits `0` on success, `1` on failure. Headed scripts
auto-switch to headless when `CI=true` is set in the environment.

### Example UI output

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Hacker News /newest — Sort Validation
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  page 1 loaded — collecting articles...
  collected 30 so far
  page 2 loaded — collecting articles...
  collected 60 so far
  page 3 loaded — collecting articles...
  collected 90 so far
  page 4 loaded — collecting articles...
  collected 120 so far

Validating sort order across 100 articles...

✓ All 100 articles are sorted newest → oldest.

  Newest: 2026-05-05 19:52:04 UTC  —  "SMG: The Case for Disaggregating CPU from GPU in LLM Serving"
  Oldest: 2026-05-05 18:23:20 UTC  —  "Trump Pressures FDA Commissioner to Approve Flavored Vapes"
  Span:   1h 28m 44s

Finished in 3s.
```

## CI

The `monitor` workflow runs all three checks daily at **12:00 UTC**,
sequentially (`api` → `ui` → `crosscheck`) to be polite to HN's rate
limits. The badge above reflects the most recent run; failures surface
in [Actions](https://github.com/santiagodalmas/hn-quality-monitor/actions).

## Findings

See [`findings/`](./findings/) for a log of notable observations from
past runs, formatted as structured QA reports (severity, repro,
expected/actual, mitigation). The format template is in
[`findings/_template.md`](./findings/_template.md).

## Design choices

- **Source of truth for timestamps = `<span class="age">` `title` attr.**
  HN renders relative text ("5 minutes ago") visually, but the `title`
  carries the exact `YYYY-MM-DDTHH:MM:SS <unix>` string. Parsing the
  unix value is timezone-unambiguous; falls back to ISO-as-UTC if not
  present.
- **Equal timestamps allowed.** Two posts in the same minute is normal
  on HN — "newest to oldest" is non-increasing, not strictly decreasing.
- **Pagination via the "More" link**, not by constructing
  `/newest?next=…` URLs — closer to user behavior, robust to query-param
  changes.
- **Broad rate-limit detection.** Treats HN's apology copy, Cloudflare
  challenge text, and "page returned zero `<tr.athing>` rows" all as
  unhealthy, then retries with linear backoff. (Original detector was
  too narrow; see [first finding](./findings/2026-05-05-cloud-ip-empty-pagination.md).)
- **Single tool, two layers.** Playwright's `request` fixture handles
  the API layer — no Postman/Newman dependency.
- **Sequential CI jobs.** API → UI → cross-check rather than parallel,
  to avoid hammering HN from a single runner pool.

## Possible extensions

- Slack/webhook notification from the scheduled job when validation
  fails, with a one-line summary suitable for an oncall channel.
- A "future-timestamp" sanity check (refetch if any article's timestamp
  is newer than `Date.now()` — clock skew or test data).
- Pluggable target count for the UI script (`--count 200`) once a
  strategy for pagination beyond 4 pages is exercised.
- Auto-open a draft finding markdown when a CI run fails, pre-filled
  with the run URL and error excerpt.

## Tech

- Node.js
- [Playwright](https://playwright.dev/) (browser + `request`)
- GitHub Actions (free tier)
- No test framework — scripts are self-contained
