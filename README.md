# Hacker News `/newest` — Sort Validator

[![validate](https://github.com/santiagodalmas/hn-sort-validator/actions/workflows/validate.yml/badge.svg)](https://github.com/santiagodalmas/hn-sort-validator/actions/workflows/validate.yml)

A small Playwright script that loads
[`news.ycombinator.com/newest`](https://news.ycombinator.com/newest), collects
exactly the first 100 articles across pagination, and verifies they are
sorted **newest → oldest**. Prints a structured pass/fail report and exits
with a CI-friendly status code.

## Why I built this

I wanted a focused Playwright exercise that wasn't just "click around an
e-commerce demo": real pagination, a slightly noisy upstream (HN occasionally
rate-limits), timestamps that need careful parsing, and a clear pass/fail
contract. Small on purpose, but production-shaped — error handling, reporting,
and an exit code you'd actually want in CI.

## Setup

```bash
npm install
npx playwright install chromium   # one-time browser download
```

## Run

```bash
node index.js              # headed browser — good for demos
node index.js --headless   # headless — good for CI
```

Auto-headless when `CI=true` is set in the environment.
Exits `0` on success, `1` on failure.

A scheduled GitHub Actions job runs this against live Hacker News once a
day, so the badge above reflects whether the sort invariant currently
holds.

### Example output

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

On failure, the script lists every out-of-order pair with positions, parsed
timestamps, and titles (capped at 10 to keep output readable), plus any
articles whose timestamps couldn't be parsed.

## How it works

- **Source of truth = `<span class="age">`'s `title` attribute.** HN renders
  relative text ("5 minutes ago") visually, but the `title` attribute carries
  the exact timestamp in the form `YYYY-MM-DDTHH:MM:SS <unix>`. The script
  prefers the unix value when present (timezone-unambiguous) and falls back
  to the ISO string treated as UTC. This avoids any flakiness from parsing
  relative text.
- **Equal timestamps are allowed.** Two posts in the same minute is normal on
  HN — "newest to oldest" is non-increasing, not strictly decreasing. Only
  pairs where item *i+1* is strictly newer than item *i* are flagged.
- **Pagination via the "More" link.** Clicking the link rather than
  constructing `/newest?next=…` URLs keeps the script closer to how a user
  navigates and avoids depending on a query parameter that could change.
- **Rate-limit handling.** HN sometimes responds with "Sorry, we're not able
  to serve your requests this quickly." The script detects that copy and
  retries with linear backoff (up to 3 attempts on the initial load, plus
  one in-pagination retry).
- **Structured reporting + exit code.** Success prints newest/oldest articles
  and total time span. Failure surfaces every inversion. Exit `0`/`1` makes
  this trivial to drop into CI.

## Possible extensions

- A "future-timestamp" sanity check (refetch if any article's timestamp is
  newer than `Date.now()`, indicating clock skew or test data).
- Pluggable target count (`--count 200`) once a strategy for pagination
  beyond 4 pages is exercised.
- Slack/webhook notification from the scheduled job when validation fails.

## Tech

- Node.js
- [Playwright](https://playwright.dev/) (chromium)
- No test framework — the script is self-contained
