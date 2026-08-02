# PHASES TRACKER — Implementation Status

> **Version**: 1.9 · **Last Updated**: 2026-08-03 · **Status**: Authoritative
>
> Purpose: resume work across sessions. A new session reads this + `CHANGELOG_AI.md` instead of re-reading history.
>
> Rules:
> - A phase is **Completed** only when its checkpoint is green and the commit is pushed.
> - After each completed phase, update Status / Commit / Notes, then add a changelog entry.
> - Phase specs live in `IMPLEMENTATION_ROADMAP.md` (Stage 8 gates, Stage 9 specs, Stage 7 rollback).

Legend: `Pending` · `In Progress` · `Completed` · `Skipped`

| Phase | Status | Commit | Checkpoint | Notes |
|---|---|---|---|---|
| Challenge assumptions (Stage 1) | Completed | — | — | Verified 2026-08-02: A–J all confirmed (incl. Oracle A1 2 OCPU/12 GB; cron auto-disable after 60 idle days) |
| C0 — Pre-flight repo sanity | Completed | — | C0 | `npm ci` green; only runtime logs dirty (`logs/loop*.log` untracked) |
| P1 — Fix CI runner env | In Progress | — | C1 | Code done (`HEADLESS=true`, `--with-deps`). C1 attempt blocked 2026-08-02: GH account billing lock — job not started (run 30753919330). Re-dispatch after lock cleared |
| P2 — Extract pure helpers + unit tests | Completed | 64d67bd | C2 | `npm test` 26/26 green; `DRY_RUN=true npm run login` green (276 accounts parsed, no navigation); spec 360 → 274 lines (≤600). ADR-006 (Option A) |
| P3 — Proxy + retry ladder | Completed | 455dca4 | C3 | `lib/retry.js` + `lib/proxy.js` full impl (44 unit tests green); proxy default-off, malformed `PROXY_URL` fails fast; retry per account via `runAccountFlowWithRetry` (backoff, non-retryable skip) |
| P4 — Resume state | Completed | 10f5ada | C4 | `lib/state.js` full impl (atomic tmp→fsync→rename); `runWithRetry` gained `onSuccess`/`onFailure` hooks (once per final outcome); spec persists `state.json` after every account; `BATCH_ID` reset + `START_INDEX` override + `STATE_FILE` env; Actions state cache. 52/52 unit tests green. C4 verified manually: state `lastProcessedIndex=3` → resume at 4; `START_INDEX=7` overrides; `BATCH_ID` change restarts at 1 |
| P5 — Observability | Completed | 747d215 | C5 | `lib/logger.js` (structured lines, `logs/run-*.log`) + `lib/runSummary.js` full (`run-summary.json` all §5.2 fields + `formatSummary` human line); spec writes summary every run (incl. DRY_RUN), console + `$GITHUB_STEP_SUMMARY`; CI uploads artifact; `ALLOW_LIVE_RUN` guard added (reviewer rec). 60/60 unit tests green. C5 verified locally: DRY_RUN produced `run-summary.json` + rendered step summary line; live run blocked without `ALLOW_LIVE_RUN` |
| P6 — Schedule + notify (local scheduler) | Completed | c137bb0 | C6 | GitHub Actions **suspended** (billing lock, §0.4) → scheduler-agnostic path: `lib/telegram.js` + `scripts/notify.js` (Telegram, silent-skip) + `scripts/scheduled-run.mjs` (run-once: login → excel → notify) + Windows Task Scheduler registration (`scripts/register-scheduled-task.ps1`, 60 min) + `scripts/crontab.example` (Linux VM). 65/65 unit tests green; dry-run pipeline verified (summary produced, notify network round-trip OK). C6: run `npm run scheduled -- --dry-run`; register task; confirm Telegram alert on a real/fake run |
| P7 — Cloud VM as primary runtime | In Progress | — | C7 | Two-phase Azure plan (2026-08-03): **Phase A** — $200 credit month on a single `B2ms` 8 GiB (~$79/mo), full batch, no `LOW_MEMORY`, no sharding; **Phase B** — deallocate, free-tier `B2ats_v2` (1 GiB) shards with `LOW_MEMORY=true` + 2 GiB swap + `END_INDEX` sharding. Tooling ready: `scripts/vm-setup.sh` RAM auto-detect (<2 GiB → swap + LOW_MEMORY; else full-memory), `SHARD_START`/`SHARD_END`/`SHARD_STATE` in cron, `END_INDEX` in `lib/state.js` + spec. 69/69 unit tests green. C7: provision B2ms, upload secrets, cron fires + Telegram notifies |
| P8 — (Optional) Accounts off repo | Pending | — | C8 | OCI / git-crypt |

Open questions and known risks: `IMPLEMENTATION_ROADMAP.md` Stage 13.
