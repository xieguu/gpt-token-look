# Changelog

## Unreleased

- Added a Chrome/Edge Manifest V3 extension with a toolbar usage overview, connection settings, and a full dashboard tab reusing the existing frontend.
- Added a loopback-only extension client with local settings, header-only authentication, timeout handling, and redirect/cookie isolation.
- Added reproducible extension ZIP builds using the development-only `fflate` dependency, installation docs, regression tests, and CI artifacts.
- Reused normalized and sorted session summaries on unchanged scans, with file/title invalidation and a `summaryReused` diagnostic.
- Decoupled local exports and Gist uploads from official account queries while preserving token totals and pricing.
- Limited chart-granularity changes to chart redraws, preserving pagination and applying pending search filters first.
- Added regression coverage for summary invalidation, blocked official queries, and targeted chart redraws.
- Replaced per-line async iteration with native streaming line events and explicit read-error propagation for statistics, titles, and full-session exports.
- Added complete session pagination with bounded rendering, stable refresh behavior, and full-filter statistics and exports.
- Added clipboard failure feedback, cache-write token details, accessible row actions, and escaped pricing tooltips.
- Added an isolated, repeatable scan benchmark and regression tests for pagination, stream boundaries, and failures.
- Made session scans asynchronous with bounded metadata queries, shared in-flight scans, cached titles, and disk writes only when the cache changes.
- Added cache diagnostics and fixed cold-start session exports and rate-limit snapshots without token totals.
- Fixed Gist routes returning premature responses; added JSON validation, a 64 KiB request limit, and static asset allowlisting.
- Reduced filtering and aggregation to single passes, moved sorting out of render, debounced search, and paused automatic refresh in hidden pages.
- Sent browser API tokens through request headers and included cache-write tokens in CSV exports.
- Expanded isolated regression coverage for scanning, HTTP boundaries, and frontend interactions.

## 1.0.0

- Added local Codex usage scanning from JSONL session files.
- Added token totals, input/output split, per-session table, and usage trend chart.
- Added primary and secondary rate-limit display.
- Added API-equivalent USD cost estimates with cache write input support.
- Added model and date filters.
- Added CSV and JSON export for filtered sessions.
- Added optional custom pricing through `TOKEN_LENS_PRICES_JSON` and `TOKEN_LENS_PRICING_FILE`.
- Added incremental cache for faster repeated scans.
- Added Node test coverage and GitHub Actions CI.
