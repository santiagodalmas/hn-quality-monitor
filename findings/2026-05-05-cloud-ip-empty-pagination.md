# Empty pagination response when running from GitHub Actions cloud IPs

| Field    | Value                              |
|----------|------------------------------------|
| Date     | 2026-05-05                         |
| Source   | UI                                 |
| Severity | Medium (CI flakiness; not user-facing) |
| Status   | Mitigated                          |

## Summary

When `src/ui/sort-validator.js` runs from a GitHub-hosted `ubuntu-latest`
runner, clicking the "More" link on `news.ycombinator.com/newest`
intermittently navigates to a response with **zero `<tr.athing>` rows**
and **no "More" link** — neither HN's documented rate-limit page nor a
clear error. From local residential connections the same script
reliably paginates through all four pages.

## Steps to reproduce

1. Push a commit to a branch with the `monitor` workflow enabled, or
   trigger `workflow_dispatch` on it.
2. Watch the `ui-sort-validator` job logs.
3. Observe failure roughly 1 in N runs (initial commit reproduced first
   try; after mitigation the issue has not recurred).

## Expected

The script paginates through 4 pages (30 + 30 + 30 + 10 articles) and
proceeds to validate sort order across the first 100 articles.

## Actual

After page 1 (30 articles), the click on `a.morelink` navigates, but the
resulting page contains zero article rows. The next iteration finds no
`a.morelink` either, and the script aborted with:

```
✗ Run failed: "More" link not found on page 2; cannot reach 100 articles (only got 30).
```

The body of the empty page does **not** contain HN's documented apology
("Sorry, we're not able to serve your requests this quickly"), so the
original rate-limit detector silently passed it through.

## Investigation

- Tested locally on a residential IP: 50+ runs, zero failures.
- Tested in GitHub Actions: failure within the first run, on a fresh
  Azure-block IP. Subsequent retries on the same job often succeeded
  after a delay.
- Concluded the empty response is most likely an upstream anti-abuse
  layer (Cloudflare or HN's own) returning a non-`/sorry/` response to
  cloud IPs.

## Mitigation

Commit
[`0f0ca3f`](https://github.com/santiagodalmas/hn-quality-monitor/commit/0f0ca3f)
("Harden rate-limit handling for cloud IPs") replaced the narrow apology
detector with `pageHealth`, which now also flags:

- Cloudflare challenge text (`/just a moment|attention required|cloudflare/i`)
- Any page returning zero `<tr.athing>` rows after a navigation that was
  expected to land on a listing

Combined with a 1.5s polite delay before each "More" click and linear
backoff over five retries, CI has been stable since.
