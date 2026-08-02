# ARCHITECTURE DECISION LOG (ADR)

> **Version**: 1.2 · **Last Updated**: 2026-08-02 · **Status**: Authoritative
>
> Explains the "why" behind architecture decisions. Append a new ADR for each new decision; mark superseded ones. Full rationale lives in `MIGRATION_AND_DEPLOYMENT_PLAN.md`.

## ADR-001 — GitHub Actions chosen as primary runtime
- **Status**: Accepted
- **Context**: The app is a scheduled batch job needing $0 hosting, cron, secrets, artifacts, and resumable state.
- **Decision**: Run the Playwright batch on a GitHub Actions scheduled workflow. The repo is public → unlimited standard-runner minutes.
- **Consequences**: 6 h/job cap; US/EU datacenter IPs (geo-block risk); public-repo cron auto-disables after 60 idle days (keepalive needed).

## ADR-002 — Oracle Always Free selected for resilience
- **Status**: Accepted
- **Context**: Jobs can exceed 6 h; datacenter egress from GitHub may be geo-blocked by `eg1xbet.com`.
- **Decision**: Provision an OCI Always Free Ampere A1 (2 OCPU / 12 GB) as a self-hosted runner, used only via a `runs-on` label.
- **Consequences**: Optional; $0; requires credit-card verification; A1 capacity can be unavailable at signup (retry or E2.1.Micro fallback).

## ADR-003 — No Docker required for primary deployment
- **Status**: Accepted
- **Context**: The primary tier is a GitHub-hosted runner.
- **Decision**: No Dockerfile for the primary path; install Chromium via `npx playwright install --with-deps chromium` on the runner.
- **Consequences**: A Dockerfile is only needed if/when moving to containers (e.g., Oracle VM as a container).

## ADR-004 — Proxy support (`PROXY_URL`) added
- **Status**: Accepted (implemented in roadmap P3)
- **Context**: `logs/failed-accounts.log` shows geo-block/anti-bot signatures (`net::ERR_CONNECTION_CLOSED`, `input#username` not found).
- **Decision**: Add optional `PROXY_URL` env passed to `browser.newContext({ proxy })`; off by default; mask the proxy password in logs.
- **Consequences**: The only in-scope mitigation for geo-blocking; may require a paid EG/residential proxy (the only non-$0 line item, operator-supplied).

## ADR-005 — Repository must remain public for unlimited minutes
- **Status**: Accepted
- **Context**: Private repos get a 2,000-minute/month free budget — too small for daily batches.
- **Decision**: Keep the repository public so the scheduled workflow is unlimited and $0.
- **Consequences**: Everything is public-facing; credentials must never enter the repo (Invariant #2). Account list stays in `accounts.csv` (gitignored) or fetched from a secure source (roadmap P8).

## ADR-006 — Refactoring decision: Option A (orchestration stays single-file, pure helpers move to `lib/`)
- **Status**: Accepted (implemented in roadmap P2)
- **Context**: All logic lived in `tests/login.spec.js` (~360 lines); CSV parsing, phone extraction, and screenshot naming are pure and need unit tests; a full module split adds ceremony without reuse demand yet.
- **Decision**: Keep `runAccountFlow` and the single `test()` in `tests/login.spec.js`; extract pure helpers verbatim into `lib/{csv,extractor}.js` (plus `lib/state.js`, `lib/retry.js`, `lib/proxy.js`, `lib/runSummary.js` stubs for P3–P5) and add `node:test` unit tests under `tests/unit/`.
- **Consequences**: Default-path behavior unchanged (helpers moved verbatim); reverts cleanly via `git revert`; revisit Option B only if `tests/login.spec.js` exceeds ~600 lines after extraction, a second automation flow appears, or multi-file reuse emerges.

## ADR-007 — Scheduler-agnostic runner + Telegram notify (GitHub Actions suspended)
- **Status**: Accepted (implemented in roadmap P6)
- **Context**: The GitHub billing lock (§0.4 external blocker) blocks all workflow dispatches on `MahmoudMahdy448`, so GitHub Actions can no longer serve as the scheduler. A 30–60 min cadence is still required.
- **Decision**: Make the batch a run-once cron-style process: `scripts/scheduled-run.mjs` (`npm run scheduled`) runs `login` → `excel` → `notify` in one process and exits (no sleep-loop). `scripts/notify.js` + `lib/telegram.js` post the run summary to Telegram via `fetch`, skipping silently when `TELEGRAM_*` is unset. Scheduling is pluggable: Windows Task Scheduler (`scripts/register-scheduled-task.ps1`) now, Linux cron (`scripts/crontab.example`) or GitLab free CI later — no GitHub dependency.
- **Consequences**: ADR-001's GitHub Actions schedule is superseded (the workflow file stays as a reusable definition). Requires the local machine or a free VM to be up at run time. Telegram becomes the reporting surface (summary text; Excel/screenshots remain as local artifacts). The `fetch`-based notifier needs no new dependencies.

## Future ADR template

```
# ADR-0XX — <title>
- **Status**: Proposed | Accepted | Superseded by ADR-0YY
- **Context**: <why>
- **Decision**: <what>
- **Consequences**: <trade-offs>
```
