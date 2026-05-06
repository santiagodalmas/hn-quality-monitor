# Findings

Notable findings observed by the monitor's daily runs against Hacker
News. Each finding is a self-contained markdown file using the format in
[`_template.md`](./_template.md): summary, repro, expected vs actual,
investigation, mitigation.

Not every CI failure becomes a finding — only ones with non-obvious
cause or lasting documentation value.

## Log

- 2026-05-05 — [Empty pagination response when running from GitHub Actions cloud IPs](./2026-05-05-cloud-ip-empty-pagination.md) *(Medium, Mitigated)*
