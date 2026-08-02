# CHANGELOG_AI — Documentation Revision History

Tracks changes to the AI-facing documentation set in `codebase-analysis-docs/`. Read this to know what changed since the last implementation cycle.

## v1.10 — 2026-08-03

Sharding landed: `END_INDEX` bounds the batch per run so the 276-account batch can be split across multiple low-RAM VMs (Azure `Standard_B2ats_v2`, 1 GiB). OCI signup is blocked on card verification; Azure work account free tier is now the target runtime.

- **New code**: `lib/state.js` gained `resolveEndIndex(explicitEndIndex, totalAccounts)` — defaults to total, clamps above total, throws on <1. `tests/login.spec.js` parses `END_INDEX` (invalid → throw; > total → warn + clamp), logs the processing range, and breaks the loop past `endIndex`. `scripts/vm-setup.sh` accepts `SHARD_START`/`SHARD_END`/`SHARD_STATE` to bake `START_INDEX`/`END_INDEX`/`STATE_FILE` into the cron line.
- **Config**: `.env.example` documents `END_INDEX`, per-shard `STATE_FILE`, `COOLDOWN_MINUTES`.
- **Tests**: 5 new `resolveEndIndex` cases in `tests/unit/state.test.js` (default, clamp, explicit, invalid x2) → 69/69 unit tests green. Dry-run verified with `START_INDEX=1 END_INDEX=5`.
- Docs: `CODEBASE_KNOWLEDGE.md` → v1.7 (env table: `END_INDEX`, `STATE_FILE`; §2.3.2 sharding note), `PHASES_TRACKER.md` → v1.8 (P7: Azure pivot + sharding tooling added), `README_AI.md` → v1.10, `AI_MANIFEST.yaml` `docs_version` → 1.10.
- Next action for the operator: pick the shard count / index ranges (e.g. 3 × 92), provision the Azure VMs with `SHARD_START`/`SHARD_END`/`SHARD_STATE`, upload secrets, and let cron run `scheduled-run.mjs` per VM.

## v1.9 — 2026-08-02

P7 pivoted: Oracle Always Free VM is now the **primary runtime** (cron + Telegram), not a GitHub self-hosted runner — GitHub Actions remains suspended (billing lock, §0.4). Provisioning tooling added; implementation blocked on OCI signup card verification.

- **New code**: `scripts/vm-setup.sh` (63) — idempotent Oracle VM provisioning: apt prereqs, Node 22 (NodeSource), clone repo to `/opt/1xauto`, `npm install`, `npx playwright install --with-deps chromium`, installs 60-min cron for `scheduled-run.mjs`, prints a secrets-upload reminder (`scp .env accounts.csv`).
- Docs: `IMPLEMENTATION_ROADMAP.md` → v1.2 (P7 retitled "Oracle Always Free VM as primary runtime"; P6 row updated to run-once runner; roadmap phase list updated), `MIGRATION_AND_DEPLOYMENT_PLAN.md` → Step 6 (Active) + Phase 10 recommendation inverted to "Oracle VM primary, GitHub suspended", `CODEBASE_KNOWLEDGE.md` → v1.6 (File Index: `scripts/vm-setup.sh`; §2.5 Oracle VM primary target), `PHASES_TRACKER.md` → v1.7 (P7 In Progress, blocked on OCI signup card verification), `README_AI.md` → v1.9, `AI_MANIFEST.yaml` `docs_version` → 1.9.
- Next action for the operator: complete OCI signup (credit-card verification — region must match card country; online/international payments must be enabled on the card). Once the VM exists, run `scripts/vm-setup.sh`, upload secrets, and C7 verifies cron fires + Telegram notifies.

## v1.8 — 2026-08-02

P6 (scheduler + Telegram notify) implemented; GitHub Actions **suspended** as the scheduler (billing lock, §0.4). The batch is now a run-once cron-style process, deployable to a local scheduler or any free VM — no GitHub dependency.

- **New code**: `lib/telegram.js` (31) — `buildTelegramMessage` (run-summary → text), `buildTelegramUrl`, `sendTelegramMessage` (global `fetch`, no new deps). `scripts/notify.js` (26) — reads `run-summary.json`, posts to Telegram, silent exit 0 when `TELEGRAM_*` unset, exit 1 on API error. `scripts/scheduled-run.mjs` (32) — run-once entry: loads `.env`, forces `HEADLESS=true` + `ALLOW_LIVE_RUN=true`, runs `login` → `excel` → `notify`, exits non-zero on any step failure; `--dry-run` sets `DRY_RUN=true`. `scripts/register-scheduled-task.ps1` (12) — Windows Task Scheduler every 60 min. `scripts/crontab.example` — Linux cron line for a later VM.
- `run-loop.js` 26 → 28: now also sets `ALLOW_LIVE_RUN=true` (P5 guard blocked the operator loop; fixes local runs after the P5 commit).
- `package.json` → 21 lines: added `scheduled` (`node scripts/scheduled-run.mjs`) + `notify` scripts. `.env.example` → 8 lines: added `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
- Tests: new `tests/unit/telegram.test.js` (5 tests: message build, OK/partial, null batchId, URL, fetch POST + non-OK throw) → 65 unit tests total. `npm test` 65/65 green.
- C6 verified locally: `node scripts/notify.js` skips silently without tokens; real API round-trip returns 401 (network works); `node scripts/scheduled-run.mjs --dry-run` produced `run-summary.json` and ran login → excel → notify end-to-end without navigation.
- Docs: `CODEBASE_KNOWLEDGE.md` → v1.5 (File Index: telegram + runner/notify/scheduler scripts; §2.4 GitHub Actions status → suspended; new §2.5 Scheduled Runner; function-table coverage), `PHASES_TRACKER.md` → v1.6 (P6 Completed, C6 PASS, P5 commit filled in, stale duplicate P5 row removed), `ADR_LOG.md` → v1.2 (ADR-007: scheduler-agnostic runner + Telegram, supersedes ADR-001's GitHub Actions schedule), `README_AI.md` → v1.8, `AI_MANIFEST.yaml` `docs_version` → 1.8.
- C1 remains blocked by the GitHub billing lock (external blocker, §0.4) — the workflow file is kept as a reusable definition for when billing resolves or the repo moves to GitLab free CI.

## v1.7 — 2026-08-02

P5 (observability) implemented; C5 verified locally. Includes the reviewer-recommended `ALLOW_LIVE_RUN` safeguard.

- **P5 code**: `lib/logger.js` (33) — `formatLogLine` (`[ISO] [level]  [account=x] [phase=y] message`, level padded to align info/warn with error) + `createLogger` (console with error→stderr, optional per-run file). `lib/runSummary.js` stub → full (96): `buildSummary` computes all §5.2 fields (`batchId`, timestamps, `durationMs`, counters, `successRate`, `uniqueNumbers`, `avgRuntimePerAccountMs`, `slowestAccount`, `failureCategories`, `screenshotsRetained`, `artifactNames`, `retryCount`) + operational extras (`accountsRetried`, `startIndex`, `lastProcessedIndex`, `proxyEnabled`, `maxRetries`); `formatSummary` renders the §5.3 human line; `FAILURE_CATEGORIES` zero-fills the breakdown.
- `tests/login.spec.js` 381 → 431: structured logging through `createLogger` (run log `logs/run-<ISO>.log`); `writeRunSummary()` writes `run-summary.json` at end of every run (including DRY_RUN); batch loop collects per-account `results` + screenshot paths; `ALLOW_LIVE_RUN` guard — spec throws before navigation unless `ALLOW_LIVE_RUN=true` or `DRY_RUN=true`; human summary printed to console; `runAccountFlow` returns the screenshot path.
- `.github/workflows/playwright.yml` 48 → 71: run step env adds `ALLOW_LIVE_RUN: 'true'`; new `actions/upload-artifact@v4` step for `run-summary.json`; new "Render step summary" step appends `## Run summary` + `formatSummary` line to `$GITHUB_STEP_SUMMARY`.
- `.gitignore` → 11 lines: added `run-summary.json`, `logs/run-*.log`. `.env.example` → 6 lines: added `# ALLOW_LIVE_RUN=true (required for real runs; DRY_RUN=true bypasses navigation without it)`.
- Tests: new `tests/unit/logger.test.js` (68) + `tests/unit/runSummary.test.js` rewritten (106) → 60 unit tests total. `npm test` 60/60 green.
- C5 verified locally: `DRY_RUN=true npm run login` produced `run-summary.json` (all §5.2 fields, zero counts) and printed `Success rate: 0% (0/276) · unique numbers: 0`; the exact workflow step-summary node command rendered correctly; running without `ALLOW_LIVE_RUN`/`DRY_RUN` throws `Live execution blocked` before any navigation.
- Docs: `CODEBASE_KNOWLEDGE.md` → v1.4 (File Index: logger + full runSummary core; §2.4 workflow; §5.3 logging/summary/guard notes; §7.2 function table; §8.4 observability guide; §8.7 items 12–13); `PHASES_TRACKER.md` → v1.5 (P5 Completed, C5 PASS); `README_AI.md` → v1.7 and `AI_MANIFEST.yaml` `docs_version` → 1.7.
- C1 remains blocked by the GitHub billing lock (§0.4 external blocker — P1 stays In Progress).

## v1.6 — 2026-08-02

P4 (resume state) implemented; C4 verified locally.

- **P4 code**: `lib/state.js` full implementation — `readState` (`null` when missing/invalid JSON), `writeState` (atomic: tmp file → `fsyncSync` → `renameSync`; recursive dir creation), `resolveStartIndex` (explicit `START_INDEX` > `lastProcessedIndex + 1` > 1). File: 17 → 52 lines.
- `lib/retry.js`: `runWithRetry` gained `onSuccess`/`onFailure` hooks (each `?? (async () => {})`) — called exactly once per account on its final outcome; `onRetry` already existed. Logic stays in `lib/retry.js`. File: 95 → 99 lines.
- `tests/login.spec.js`: imports `readState`/`writeState`/`resolveStartIndex`; `runAccountFlowWithRetry` forwards `onSuccess`/`onFailure`; test body computes `batchId` (`BATCH_ID` env or ISO timestamp), reads state, resets to `null` on `BATCH_ID` mismatch, resolves start index via `resolveStartIndex`, logs the resolved start index, writes `{ batchId, lastProcessedIndex, totalAccounts, updatedAt }` after every account through the hooks; DRY_RUN log now includes `startIndex`. Spec 337 → 381 lines.
- `.gitignore` → 9 lines: added `state.json`.
- `.github/workflows/playwright.yml` → 48 lines: `actions/cache@v4` restore (`key: batch-state-${{ github.run_id }}`, `restore-keys: batch-state-`) before run; `PROXY_URL` secret + `MAX_RETRIES` var env; cache save step (`path: state.json`) after run.
- Tests: `tests/unit/state.test.js` (66) expanded with atomic-write/resume cases (unique per-call temp dirs fix parallel `node:test` collisions) + `tests/unit/retry.test.js` (245) hook cases. `npm test` 52/52 green.
- C4 verified manually (DRY_RUN): state `lastProcessedIndex=3` → "Start index resolved to 4"; `START_INDEX=7` overrides state; `BATCH_ID` change → "starting fresh at 1"; no-state → 1. No `.tmp` leftovers.
- Docs: `CODEBASE_KNOWLEDGE.md` → v1.3 (File Index + function table + §2.4 workflow + Feature 7 resume + §5.3/§8.3/§8.6 notes); `PHASES_TRACKER.md` → v1.4 (P4 Completed, C4 PASS, P2/P3 commit hashes recorded); `README_AI.md` → v1.6 and `AI_MANIFEST.yaml` `docs_version` → 1.6.
- C1 remains blocked by the GitHub billing lock (§0.4 external blocker — P1 stays In Progress).

## v1.5 — 2026-08-02

P3 (proxy support + retry ladder) implemented; C3 verified locally.

- **P3 code**: `lib/retry.js` full implementation — `classifyError` (retryable: `network`/`browserClosed`/`disk`/`domTimeout`; non-retryable: `loginRejected`/`validation`/`other`), `isRetryable`, `readMaxRetries` (`MAX_RETRIES` env, default 2, integer ≥ 1 validated), `backoffDelay` (`min(2000·2^attempt, 15000) + [0,1000)` jitter), `runWithRetry` (generic engine returning `{ outcome, retries, error, category, value }`).
- `lib/proxy.js` full implementation — `parseProxyUrl` (null when unset; `{ server, username?, password? }`; throws on malformed URL / unsupported protocol / missing host), `maskProxyPassword` (`:pass@` → `:***@` for safe logging).
- `tests/login.spec.js`: new `runAccountFlowWithRetry(createContext, account, index, total, opts)` — fresh browser context per attempt, backoff, retry logging, cleanup, final `logFailure()` only after exhausted attempts; test loop resolves `PROXY_URL` (default-off, redacted host logged when active), reads `MAX_RETRIES`, accumulates run stats (total/succeeded/failed/retries/categories). Spec 274 → 337 lines.
- `.env.example` → 5 lines: added `# MAX_RETRIES=2 (optional, default 2: 1 initial + 1 retry)`.
- Tests: `tests/unit/retry.test.js` (183) + `tests/unit/proxy.test.js` (48) expanded to 44 unit tests total. `npm test` 44/44 green. C3 local checks: `DRY_RUN=true` with proxy on/off both green (276 accounts parsed, no navigation); malformed `PROXY_URL` fails fast with a clear error before any navigation.
- Docs: `CODEBASE_KNOWLEDGE.md` → v1.2 (File Index + function table + §5.3 retry note); `PHASES_TRACKER.md` → v1.3 (P3 Completed, C3 PASS); `README_AI.md` → v1.5 and `AI_MANIFEST.yaml` `docs_version` → 1.5.
- C1 remains blocked by the GitHub billing lock (§0.4 external blocker — P1 stays In Progress).

## v1.4 — 2026-08-02

P2 (extract pure helpers + unit tests) implemented; C2 verified locally.

- **P2 code**: new `lib/{csv,extractor}.js` — verbatim extraction of `parseCsvLine`, `parseCsv`, `loadAccounts`, `getAccountsToProcess`, `extractPhoneNumber`, `buildScreenshotPath`, `fallbackScreenshotPath`. New `lib/{state,retry,proxy,runSummary}.js` stubs (state has `resolveStartIndex` implemented; retry/proxy/runSummary return defaults, filled in P3/P5).
- New `tests/unit/*.test.js` (6 files, 26 tests) run via `npm test` (`node --test "tests/unit/*.test.js"`).
- `tests/login.spec.js` refactored to import from `lib/`; shrank 360 → 274 lines; added `DRY_RUN=true` mode (validates accounts parse + summary without navigating to the site; the Playwright browser fixture still spins up but no navigation occurs).
- Logged ADR-006 (Option A); `package.json` gained the `test` script.
- Docs: `CODEBASE_KNOWLEDGE.md` → v1.1 (File Index updated for P2/P1 state; function table + constant locations refreshed; §4–§5 line-number detail stays the `dfa181b` snapshot per the added note); `ADR_LOG.md` → v1.1 (ADR-006); `PHASES_TRACKER.md` → v1.2 (P2 Completed, C2 PASS); `README_AI.md` → v1.4 and `AI_MANIFEST.yaml` `docs_version` → 1.4.
- C2 verified locally; C1 remains blocked by the GitHub billing lock (§0.4 external blocker — P1 stays In Progress).

## v1.3 — 2026-08-02

- Added §0.4 "External blockers" to `IMPLEMENTATION_ROADMAP.md` (→ v1.1): an external blocker (billing lock, GitHub outage, cloud verification, domain outage) pauses checkpoint completion but keeps the phase In Progress; completed work is never invalidated. Triggered by C1 being blocked by a GitHub account billing lock (run 30753919330).
- `README_AI.md` (→ v1.3) and `AI_MANIFEST.yaml` `docs_version` (→ 1.3) bumped per docs-sync rules (a current doc's content changed).
- `PHASES_TRACKER.md` P1 note already recorded the C1 blocker in `1bec703` (tracker bookkeeping — no version bump).

## v1.2 — 2026-08-02

P1 implemented + docs-guard scaffolding.

- **P1 (Fix CI runner env)** — `playwright.yml`: browser install step now `npx playwright install --with-deps chromium`; run step sets `HEADLESS: 'true'`. `playwright.config.js`: comment documenting the CI HEADLESS contract. `.env.example`: appended `# PROXY_URL=http://user:pass@host:port (optional)`.
- Added `.github/scripts/validate-docs.mjs` + `.github/workflows/docs-validation.yml` — a push/PR CI check that enforces: version/status headers, manifest + README path integrity, commit-hash consistency with `analyzed_commit`, ADR references defined in `ADR_LOG.md`, no stray files at the docs root, and valid doc-to-doc links.
- Added "Docs-sync rules" to `README_AI.md` (v1.1 → v1.2); bumped `AI_MANIFEST.yaml` `docs_version` to 1.2.
- `PHASES_TRACKER.md` (→ v1.1): Stage 1 (challenge assumptions) and C0 marked Completed; P1 marked In Progress (C1 gate pending push + `workflow_dispatch`).
- `Repository Commit` headers remain `dfa181b` (analyzed baseline — code moved, analysis did not; Stage 13 line counts remain the `dfa181b` snapshot).

## v1.1 — 2026-08-02

Added long-lived AI-assisted development scaffolding.

- Added `AI_MANIFEST.yaml` (repo root) — machine-readable manifest (documents, reading order, workflow, context budget).
- Added `PROJECT_CONSTITUTION.md` — 8 non-negotiable invariants (START_INDEX, no creds in Git, rollbackable phases, CI-compatible, local-execution preserved, $0 budget, GH Actions primary, Oracle optional).
- Added `ADR_LOG.md` — ADR-001..005 (GH Actions primary, Oracle resilience, no Docker, proxy, public-repo requirement) + future-ADR template.
- Added `PHASES_TRACKER.md` — per-phase status/commit/checkpoint table for resuming work across sessions.
- Updated `README_AI.md` to v1.1: context-budget section (fast/medium/full), new file references, invariant rule.
- Updated `AI_MANIFEST.yaml` `docs_version` to 1.1.

## v1.0 — 2026-08-02

Consolidated the documentation set.

- Moved the three main docs from the `betjam-autologin` clone to `1xauto/codebase-analysis-docs/`.
- Re-verified all facts against `1xauto` HEAD `dfa181b`: added `run-loop.js` + `loop` script + `COOLDOWN_MINUTES`, disk-cache config (`.browser-cache`), corrected `playwright.config.js` (22 lines), `package.json` (18 lines), `.gitignore` (8 lines), documented `Email`-as-username CSV mapping.
- Merged `assets/architecture-diagrams.md` into `CODEBASE_KNOWLEDGE.md` (§9 — Architecture Diagrams).
- Merged `assets/STATE_BLOCK.md` into `IMPLEMENTATION_ROADMAP.md` (Stage 13 — Current Project State & Known Risks) with corrected line counts; open question #5 marked answered.
- Archived `master-knowledge-document.md` (stale) under `archive/`.
- Added `README_AI.md` entry point, per-document version metadata, and `AI AGENT INSTRUCTIONS` in the roadmap.
- Deleted the now-empty `assets/` directory.

## Prior history (before v1.0)

- **v0.4** — `IMPLEMENTATION_ROADMAP.md` first release: phases 11–16 (refactoring, secrets, failure recovery, observability, testing, rollback), checkpoints C0–C8, 6 Mermaid diagrams, challenge-assumptions table, per-phase specs.
- **v0.3** — `MIGRATION_AND_DEPLOYMENT_PLAN.md` first release: 20 hosting options scored, GitHub Actions deep-dive, $0 cost ranking, hybrid recommendation (GitHub Actions + Oracle Always Free).
- **v0.2** — `CODEBASE_KNOWLEDGE.md` first release (analysis of `tests/login.spec.js`, selectors, failure taxonomy). `assets/architecture-diagrams.md` and `assets/STATE_BLOCK.md` generated.
- **v0.1** — `master-knowledge-document.md` created (superseded by v1.0).

## Versioning convention

- Bump the minor version (e.g. 1.0 → 1.1) when any current doc's facts change.
- Bump the major version when the document set is restructured.
- Update the `Repository Commit` field in each doc header whenever the analyzed code moves.
- Add an entry here for every change; never edit a doc without logging it.
