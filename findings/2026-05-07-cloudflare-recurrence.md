# Recurrence: sustained Cloudflare blockade on GitHub Actions IPs

| Field    | Value                                       |
|----------|---------------------------------------------|
| Date     | 2026-05-07                                  |
| Source   | UI                                          |
| Severity | Medium (CI flakiness for the day; no user-facing impact) |
| Status   | Accepted as known weakness on 2026-05-07 (no further code change planned) |
| Related  | [2026-05-05 — Empty pagination response when running from GitHub Actions cloud IPs](./2026-05-05-cloud-ip-empty-pagination.md) |

## Summary

Two consecutive runs failed today on the UI sort validator job:

| When | Trigger | Got to | Failed on | Total time |
|---|---|---|---|---|
| 13:54 UTC | scheduled cron | page 1 | "More" → page 2 (Cloudflare) | ~2.5 min (5 retries) |
| 14:33 UTC | manual `workflow_dispatch` | page 2 | "More" → page 3 (Cloudflare) | ~2.5 min (5 retries) |

Same SHA (`2b4f5af`) ran green yesterday and the day before. Today HN's
edge layer (Cloudflare) is unusually aggressive against GitHub
Actions runner IPs, returning a challenge page after the first or
second pagination click.

The retries did not help: once the runner's IP is challenged, the
challenge persists across the 10/20/30/40/50-second backoffs because
Cloudflare's per-IP reputation doesn't reset on that timescale.

## Steps to reproduce

Trigger the workflow today (2026-05-07). Reproduces consistently from
GitHub-hosted runners. Locally from residential IPs the script still
runs cleanly — confirming the issue is the IP class, not the code.

## Expected

The script paginates through 4 pages of `/newest` and validates the
sort order across the first 100 articles.

## Actual (run 2 logs, abbreviated)

```
page 1 loaded — collected 30 so far
page 2 loaded — collected 60 so far
page 3 unhealthy (Cloudflare challenge), backing off 10s ...
page 3 unhealthy (Cloudflare challenge), backing off 20s ...
page 3 unhealthy (Cloudflare challenge), backing off 30s ...
page 3 unhealthy (Cloudflare challenge), backing off 40s ...
page 3 unhealthy (Cloudflare challenge), backing off 50s ...
✗ Run failed: Page 3 stayed unhealthy after 5 retries —
  Hacker News appears to be rate-limiting this client.
```

Notably, run 2 reached page 3 before failing while run 1 failed at
page 2 — likely because run 2 had more elapsed time between requests
(queue + setup overhead added ~10s up front). Slower request cadence
defers the trigger but doesn't prevent it.

## Investigation

- **Same SHA across all four recent runs.** No code regression involved.
- **API job passed both times.** The Firebase API isn't behind
  Cloudflare; only the rendered HTML path is affected.
- **Pattern correlates with request cadence.** Run 2 got one page
  further than run 1, supporting the hypothesis that *slower is better*.

## Tuning experiment

The polite delay was tuned in three stages on 2026-05-07. Each row
below is a separate CI run on the same SHA (apart from the constant
itself), all from GitHub-hosted runners within ~30 minutes of each
other:

| Delay | Result | Notes |
|---|---|---|
| 1500 ms (original) | failed at page 2 (cron) / page 3 (manual re-run) | Variance suggests timing is the dominant variable |
| 5000 ms | failed at page 4 — reached 90/100 articles before challenge | Big improvement over 1.5s |
| 10000 ms | failed at page 4 — pages 2/3 now needed retries to recover, page 4 challenge persisted; job hit 5-min timeout while retrying | No additional pages reached compared to 5s |

The data shows the delay matters up to ~5s, then stops mattering — at
which point we're hitting Cloudflare's per-IP reputation scoring,
which is not a thing further client-side delay can fix.

## Decision: accept and stop tuning

Settling at **5000 ms**. The 10s value gave no extra coverage, and
its longer retry timeline pushed us into the 5-minute job timeout
when retries fired. 5s is the better operating point.

This is now an **accepted known weakness**: when GitHub Actions
runner IPs are flagged by Cloudflare for HN, our scheduled UI run
fails for the day. Tomorrow's run, on a freshly-scheduled runner with
a different IP and a recovered Cloudflare reputation, will likely
succeed. We don't fight the upstream further — the game of "evade
Cloudflare from cloud IPs" is unwinnable and not the right thing for
a QA portfolio to be doing anyway.

The badge will be red today. The finding documents why. Tomorrow's
green run is the real signal.

## Alternatives considered and rejected

- *Add Playwright stealth plugin.* Defeats the purpose of testing the
  same path users take; turns the test into a cat-and-mouse against
  Cloudflare rather than a quality monitor.
- *Use a real-browser User-Agent.* Worth trying as a follow-up if
  delay alone isn't enough, but would also be detection-evasion
  rather than fix-the-test.
- *Fall back to Firebase API listing when the HTML path is blocked.*
  Defeats the cross-layer-validation premise of the suite. The whole
  point is to verify the *rendered* surface; substituting the API
  removes the test's value.
- *Mark UI job as `continue-on-error`.* Masks real regressions. Bad
  trade.

## Acceptance criteria

If the **next scheduled run** (12:00 UTC tomorrow) passes with the new
5s delay, this finding moves to `Mitigated`. If it fails again,
update this finding with the new evidence and accept the failure
mode as today's portfolio limitation.
