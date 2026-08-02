# IMPLEMENTATION ROADMAP — 1xauto (1xbet-login-flow)

> **Version**: 1.0
> **Last Updated**: 2026-08-02
> **Status**: Authoritative
> **Repository Commit**: `dfa181b` (1xauto HEAD)
>
> **Supersedes**: `master-knowledge-document.md`, `assets/STATE_BLOCK.md`

**Companion to:** `codebase-analysis-docs/MIGRATION_AND_DEPLOYMENT_PLAN.md` (architecture & option analysis — read it first).
**Audience:** An autonomous coding agent (Claude Code, OpenHands, Cline, Roo, Codex, ...) that will implement the migration.
**Repo:** `https://github.com/MahmoudMahdy448/1xauto` (public). Local clone: `1xauto` (Windows: `C:\Users\Dell\Desktop\workspace\1xauto`).

This document is the *how*. Every implementation step specifies: exact file, exact function, algorithm, constants, expected behavior, logging, tests, validation command, rollback, and estimated time.

---

## AI AGENT INSTRUCTIONS (read first)

**Before coding:**
1. Read `codebase-analysis-docs/CODEBASE_KNOWLEDGE.md`.
2. Read `codebase-analysis-docs/MIGRATION_AND_DEPLOYMENT_PLAN.md`.
3. Challenge assumptions (Stage 1).
4. Produce an implementation plan.
5. Implement **one phase only**.
6. Run validation.
7. Explain changes.
8. Stop and wait for approval.

**Never:**
- Refactor unrelated code.
- Rename files unnecessarily.
- Change public APIs without justification.
- Skip validation.
- Continue after a failed checkpoint.

---

## Stage 0 — OPERATING RULES FOR THE AGENT (non-negotiable)

Read these before anything else.

### 0.1 Four-stage execution model
| Stage | Mode | Scope | Output gate |
|---|---|---|---|
| **A — Analysis** | read-only | Inspect repo, confirm findings | This doc + `MIGRATION_AND_DEPLOYMENT_PLAN.md` |
| **B — Design** | read-only | This roadmap, workflows, rollback, checkpoints | This doc |
| **C — Implementation** | write | One phase at a time (see §0.3) | Per-phase tests + commit + stop |
| **D — Optimization** | write | Only after C is green | New doc `OPTIMIZATION_LOG.md` |

### 0.2 Hard rules (apply to every phase)
1. **After every completed phase:** run tests → verify functionality → create exactly **one logical commit** → explain the changes in 2–4 lines → **STOP for review**.
2. **Never modify unrelated files.** A phase touches only the files listed in its spec.
3. **Never commit secrets, `.env`, `accounts.csv`, `state.json`, `screenshots/`, `extracted_numbers.xlsx`, or `test-results/`** (all already in `.gitignore`; verify each commit).
4. **No refactoring outside the phase's stated scope.** If you find a bug outside scope, log it in the commit message or a TODO, don't fix it.
5. **Commit message style:** conventional, matches repo history (e.g., `feat:`, `fix:`, `ci:`). Repo history uses `feat:`, `fix:`, `ci:` prefixes.
6. **Preserve the public URL constants and selectors** exactly unless a phase explicitly redefines them.

### 0.3 Phase sequencing (implementation order)
```
CHALLENGE ASSUMPTIONS (free-form review, no code)
   ↓
CHECKPOINT 0: repo sanity
   ↓
P1  Fix CI runner environment (HEADLESS, --with-deps)      → CHECKPOINT 1
P2  Extract pure helpers + add unit tests                  → CHECKPOINT 2
P3  Proxy support + retry ladder                          → CHECKPOINT 3
P4  Resume state (state.json)                             → CHECKPOINT 4
P5  Observability (run summary, structured logs)          → CHECKPOINT 5
P6  Schedule + shard + artifacts + notify                 → CHECKPOINT 6
P7  (Conditional) Oracle self-hosted runner               → CHECKPOINT 7
P8  (Optional) Move account list off repo                 → CHECKPOINT 8
```

---

## Stage 1 — CHALLENGE ASSUMPTIONS (do this FIRST, before writing code)

Review the following claims from the analysis. If any is **wrong, outdated, or over-engineered**, state so in a short written response *before* implementing, and propose the correction.

| # | Claim to challenge | How to verify |
|---|---|---|
| A | GitHub Actions public repos get **unlimited** standard-runner minutes | Read GitHub billing docs (current) |
| B | Standard GitHub-hosted runner = 2 vCPU / 7 GB RAM / Ubuntu 24.04 | Read GitHub runner docs |
| C | Job max duration ≈ 6 h on public repos | Read GitHub usage-limits docs |
| D | Public-repo cron auto-disables after 60 days idle | Read GitHub docs; if true, plan a keepalive |
| E | Oracle Always Free Ampere A1 is **2 OCPU / 12 GB** (2026) and requires credit-card verification | Read OCI Always Free docs; account for the 4→2 OCPU reduction |
| F | OCI "out of capacity" is common for A1 — need fallback plan | Community reports; prepare E2.1.Micro fallback |
| G | The existing workflow is broken (headed launch + missing `--with-deps`) | Reproduce: run current workflow once; confirm failure |
| H | Geo-blocking is the dominant failure cause (from `logs/failed-accounts.log`) | Inspect log patterns: `ERR_CONNECTION_CLOSED`, `input#username` not found |
| I | `xlsx@0.18.5` is unmaintained with known advisories | Run `npm audit`; decide keep vs swap to `exceljs` |
| J | Splitting the module is optional at ≤600 lines | Count lines of `tests/login.spec.js` after P2 |

**Simplification filter (apply to your design):** if a proposed feature (proxy rotation, mock server, full module split) adds >50% complexity for <20% reliability gain at this stage, propose it as a Phase-D (optimization) item instead and keep the implementation minimal.

---

## Stage 2 — PHASE 11: Repository Refactoring Decision

**Decision required before P2.** Do not implement; write a 5-line justification.

### Option A (recommended default) — Keep orchestration single-file, extract pure helpers
```
tests/login.spec.js          # keeps runAccountFlow + test() orchestration ONLY
lib/                         # NEW: pure, unit-testable logic (no Playwright imports)
  csv.js                     # parseCsvLine, parseCsv, loadAccounts
  state.js                   # readState, writeState, resolveStartIndex
  retry.js                   # classifyError, isRetryable, backoffDelay
  proxy.js                   # parseProxyUrl
  extractor.js               # extractPhoneNumber, buildScreenshotPath, filenameFor
  runSummary.js              # buildSummary, failureCategory
tests/
  login.spec.js              # (moved? no — keep in tests/) orchestration
  unit/                      # NEW: node:test unit tests for lib/*
tests/mock/                  # (Phase D / optional) fixture pages for mock mode
```
- `testDir` stays `./tests`; `login.spec.js` remains the entry point; `lib/*` imported via relative path.

### Option B — Full module split
```
src/browser/ src/auth/ src/accounts/ src/extractor/ src/logging/ src/retry/ src/state/ tests/
```
Only justified if: file exceeds ~600 lines **after** extraction, a **second** automation flow appears, or multi-file reuse is needed.

### Decision rule
> Extract `lib/*` when any of these functions needs unit tests or is reused (they all will be: csv, state, retry, proxy, extractor). Keep `runAccountFlow` and the single `test()` in `tests/login.spec.js`. If total `tests/login.spec.js` exceeds 600 lines after extraction, move to Option B.

**Deliverable for this phase:** 5-line decision + justification. No code.

---

## Stage 3 — PHASE 12: Secrets Strategy

### 3.1 Secrets inventory
| Secret | Required? | Scope | Notes |
|---|---|---|---|
| `ONEXBET_USERNAME` | Yes | Fallback single-account runs (no CSV) | Plain GitHub Secret |
| `ONEXBET_PASSWORD` | Yes | Fallback single-account runs | Plain GitHub Secret |
| `ONEXBET_SURNAME` | Only if verification flow used | Fallback runs | Must differ from password (app enforces this) |
| `PROXY_URL` | Only if geo-blocked | All runs | Format `http://[user:pass@]host:port`; **mask** the password in logs |
| `TELEGRAM_BOT_TOKEN` | Optional (P6 notify) | Notifications | Store token; chat id in `TELEGRAM_CHAT_ID` |
| `TELEGRAM_CHAT_ID` | Optional (P6 notify) | Notifications | — |
| `BATCH_ID` | Optional | State matching | Auto-generated per run; not a secret |

### 3.2 Where secrets live (never in repo)
| Context | Mechanism |
|---|---|
| GitHub CI | `secrets.<NAME>` in workflow env; referenced only there |
| Local dev | `.env` (gitignored) — `ONEXBET_*`, `PROXY_URL` |
| Batch accounts | `accounts.csv` (gitignored); **not** secrets |
| Encrypted-at-rest | GitHub encrypts secrets; no plaintext in `run: echo` — use `env:` mapping only |

### 3.3 Rotation & lifecycle
- Fallback account creds: rotate monthly (single point of failure).
- Per-account creds in `accounts.csv`: rotate on failed-login spikes.
- `PROXY_URL`: rotate when failure signature `ERR_CONNECTION_CLOSED` + `input#username` not found spikes (geo-block); detect via run summary (P5).
- Process: change secret in GitHub Settings → trigger one `workflow_dispatch` → verify Checkpoint 3.

### 3.4 CI behavior rules (agent must implement)
- Map secrets via `env:` block only. Never `echo` a secret.
- If `PROXY_URL` set, redact its password in every log line (`mask` / replace `(://[^:]+):([^@]+)@` with `$1:***@`).
- Workflow must fail-fast with a clear message if `ONEXBET_USERNAME`/`ONEXBET_PASSWORD` are empty when `accounts.csv` is absent.

---

## Stage 4 — PHASE 13: Failure Recovery Design

### 4.1 Recovery ladder (implement in P3)
```
error in runAccountFlow
        │
        ▼
classifyError(error) ──► NON-RETRYABLE: bad credentials / validation / surname==password
        │
        ▼ RETRYABLE (regex: /net::|ERR_|closed|ENOSPC|timeout/i)
isRetryable? ── NO ──► logFailure() final ──► update state.json ──► next account
        │
        ▼ YES
attempt < MAX_RETRIES (default 2: 1 initial + 1 retry) ── NO ──► logFailure() ──► next
        │
        ▼ YES
close page+context  →  backoff sleep  →  new context  →  rerun runAccountFlow
        │                                                     │
        └─────────────── loop (attempt + 1) ◄──────────────────┘
```
### 4.2 Exact spec
- **New function:** `runAccountFlowWithRetry(contextFactory, account, index, total)` in `tests/login.spec.js` (or `lib/retry.js` for the pure parts).
- **Constants:** `MAX_RETRIES` env (default `2`, integer ≥ 1, validated); `RETRY_BASE_DELAY_MS = 2000`; `RETRY_MAX_DELAY_MS = 15000`; jitter = `Math.floor(Math.random() * 1000)`.
- **Algorithm:** `delay = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS) + jitter` (exponential backoff + jitter).
- **`classifyError(err)`:** returns `{ retryable: boolean, category: string }`. Categories: `network` (`net::|ERR_|CONNECTION|timeout`), `browserClosed` (`closed`), `disk` (`ENOSPC`), `loginRejected` (message starts `Login failed:` — **non-retryable**), `validation` (password===surname, missing fields — **non-retryable**), `domTimeout` (default — retryable only on the **login-page load** step, not after successful auth), `other`.
- **Logging:** console `[${n}/${total}] Retrying ${attempt}/${MAX_RETRIES} for ${username} after ${ms}ms`. `logFailure()` writes **only after the final attempt** (keep single line per account, current format, do not break `logs/failed-accounts.log` consumers).
- **Browser restart on retry:** always `page.close()`/`context.close()` and create a fresh context (matches existing isolation model).
- **Proxy rotation hook (future):** if ≥3 consecutive accounts fail with `network` category, log `PROXY_ROTATE_HINT` in run summary; actual rotation is Phase-D.

### 4.3 Interaction with state (P4)
- `state.json` is written **after each account's final outcome** (success or exhausted retries). A crash mid-run loses only the in-flight account.

---

## Stage 5 — PHASE 14: Observability

### 5.1 Structured logging (P5)
Replace bare `console.log` with a small `lib/logger.js`:
```
[2026-08-02T02:00:01Z] [info]  [account=asyut1@x] [phase=login] submitting credentials
[2026-08-02T02:00:05Z] [warn]  [account=asyut1@x] [phase=login] retry 1/2 in 2000ms (network)
[2026-08-02T02:00:40Z] [error] [account=asyut2@x] [phase=payment] copy button not found
[2026-08-02T02:00:41Z] [info]  [account=asyut2@x] [phase=payment] screenshot saved screenshots/01xxxxxxxxx.png
```
- Keep `logs/failed-accounts.log` byte-format identical (append-only compatibility).

### 5.2 Run summary (`lib/runSummary.js`, output `run-summary.json`)
| Field | Derivation |
|---|---|
| `batchId` | ISO timestamp at run start |
| `startedAt` / `endedAt` / `durationMs` | timestamps |
| `totalAccounts`, `succeeded`, `failed` | counters |
| `successRate` | `succeeded / total` |
| `uniqueNumbers` | size of the existing `uniqueNumbers` Set |
| `avgRuntimePerAccountMs` | `durationMs / total` |
| `slowestAccount` | `{username, runtimeMs}` tracked per account |
| `failureCategories` | `{network, domTimeout, loginRejected, disk, browserClosed, other: n}` from `classifyError` |
| `screenshotsRetained` | count of files written this run |
| `artifactNames` | array of screenshot filenames |
| `retryCount` | total retries issued |

### 5.3 Delivery
- Write `run-summary.json` at end of run; upload as an artifact; render a human summary into `$GITHUB_STEP_SUMMARY` (workflow step).
- Print `Success rate: 87.5% (70/80) · unique numbers: 42 · slowest: x@y (90s) · network: 6, domTimeout: 4` to console.

---

## Stage 6 — PHASE 15: Testing Strategy

No new heavyweight framework. Use Node's built-in `node:test` (`node --test`), zero deps.

### 6.1 Test matrix
| Test type | File | Scope | Gate |
|---|---|---|---|
| **Unit** | `tests/unit/*.test.js` | `lib/csv`, `lib/state`, `lib/retry`, `lib/proxy`, `lib/extractor`, `lib/runSummary` | `npm test` on push/PR |
| **Smoke** | `tests/login.spec.js` + `SMOKE=true` | First account only, shortened timeouts, real site (opt-in) | PR + manual dispatch |
| **Dry-run** | `DRY_RUN=true` | No browser launch: validates accounts parse, state resolve, summary build, filename gen | PR |
| **Mock mode** | `USE_MOCK=true` (Phase D) | Playwright `page.route` or static fixture serving selectors; full pipeline offline, deterministic regression | PR (after Phase D) |
| **Workflow validation** | `.github/workflows/*` | `actionlint` in CI lint job | push/PR |
| **Regression** | `tests/unit/` + fixtures | Re-run unit suite after every DOM-selector change; bump fixture version with selector changes | — |

### 6.2 Behavior specs per pure function (must be unit-tested)
- `parseCsv(text)` → handles quotes, escaped `""`, CRLF, empty lines, missing header cells (already in code — add tests, fix if broken).
- `buildScreenshotPath(number, count, existing)` → `01xxxxxxxxx.png` first, `01xxxxxxxxx(2).png` duplicates, timestamp fallback when no number.
- `extractPhoneNumber(modalText)` → first `/01\d{9}/` match or `''`.
- `parseProxyUrl(url)` → `null` if unset/empty; `{ server, username?, password? }`; throws on malformed.
- `backoffDelay(attempt)` → `Math.min(2000 * 2**attempt, 15000) + [0,1000)`.
- `classifyError(err)` → categories table above.
- `resolveStartIndex(state, explicitStartIndex)` → explicit wins if set; else `state.lastProcessedIndex + 1`; else `1`.
- `buildSummary(events)` → fields of §5.2.

### 6.3 `npm` scripts to add (package.json)
```jsonc
"test": "node --test tests/unit/",
"lint": "eslint .",
"format": "prettier --write .",
"login": "playwright test",
"excel": "node scripts/generate-excel.js"
```

---

## Stage 7 — PHASE 16: Rollback Plan (per implementation phase)

| Phase | Files changed | Rollback command | Risk | Validation after rollback |
|---|---|---|---|---|
| P1 CI env | `.github/workflows/playwright.yml` | `git revert <commit>` | L | Existing (broken) behavior restored; no data touched |
| P2 lib extraction | `lib/*` (new), `tests/login.spec.js`, `package.json` | `git revert <commit>` | M | `npm run login` dry-run + unit tests pass |
| P3 proxy+retry | `lib/retry.js`, `lib/proxy.js`, `tests/login.spec.js` | `git revert <commit>` | M | Default path unchanged when `PROXY_URL`/`MAX_RETRIES` unset (feature off) |
| P4 state | `lib/state.js`, `tests/login.spec.js`, `.gitignore`, workflow cache step | `git revert <commit>`; delete `state.json` | M | `START_INDEX` manual path still works |
| P5 observability | `lib/logger.js`, `lib/runSummary.js`, spec, workflow summary step | `git revert <commit>` | L | Old `console.log` output back; artifacts unchanged |
| P6 schedule/notify | `playwright.yml`, `scripts/notify.js` | `git revert <commit>`; disable cron | M | `workflow_dispatch` still runs; no notifications sent |
| P7 Oracle runner | workflow `runs-on`, docs | Flip `runs-on` back to `ubuntu-latest`; keep repo workflow file as source of truth | M | Nothing deployed until runner label used |
| P8 accounts off-repo | workflow, download script | Restore CSV in repo / remove fetch step | H (secret hygiene) | No repo change is permanent; old CSV path restored |

**General principles:** every phase is a single revertible commit; state/screenshots are throwaway (never roll back data, only code); `state.json` corruption is recoverable by deleting the file (batch restarts at 1).

---

## Stage 8 — IMPLEMENTATION CHECKPOINTS (PASS gates)

Run the listed commands; **do not proceed** to the next phase if any gate is red.

| Gate | Phase | PASS criteria | Command / evidence |
|---|---|---|---|
| **C0** | Pre-flight | Repo sanity: `npm ci`, `node --test` (after P2), git clean | `git status --porcelain` empty; deps install |
| **C1** | P1 | Workflow executes; browser **launches** headless; deps installed | Trigger workflow; check "Browser launched" log line; no `Missing library` errors |
| **C2** | P2 | `npm test` green; `npm run login` with `DRY_RUN=true` green; line count ≤600 | `npm test`; `DRY_RUN=true npm run login` |
| **C3** | P3 | Retry logic fires in test (inject retryable error in unit test); proxy parsed | `npm test`; run with bad proxy → clear error, no crash; without proxy → unchanged behavior |
| **C4** | P4 | Resume works: run 3 accounts, kill mid-run, re-run → starts at 4th | Manual: create `state.json` with `lastProcessedIndex=3`; run; log shows start at 4 |
| **C5** | P5 | `run-summary.json` produced with all §5.2 fields; step summary renders | Inspect artifact; console line present |
| **C6** | P6 | Cron fires (or dispatch works); artifacts uploaded; notify fires on forced failure | Manual dispatch + artifact list; fake a failure, confirm webhook |
| **C7** | P7 | Self-hosted runner online; job lands on Oracle label; longer batch completes | `gh run list`; runner label `self-hosted` shown |
| **C8** | P8 | Accounts loaded from remote source; no creds in repo | `git grep -i password` returns only code/docs |

---

## Stage 9 — PHASE-BY-PHASE IMPLEMENTATION SPECS

### P1 — Fix CI runner environment
- **Files:** `.github/workflows/playwright.yml`, `playwright.config.js`, `.env.example`.
- **Exact changes:**
  1. `playwright.yml` install step → `npx playwright install --with-deps chromium` (add `sudo: false` not needed on hosted; it self-privileges).
  2. `playwright.yml` run step env → add `HEADLESS: 'true'`.
  3. (Defensive) `playwright.config.js` → `headless: process.env.HEADLESS === 'true'` stays; add comment that CI must set it.
  4. `.env.example` → append `# PROXY_URL=http://user:pass@host:port (optional)`.
- **Validation:** C1. **Time:** 0.5–1 h. **Rollback:** P16 table.
- **Explicitly NOT done here:** proxy, retries, scheduling, artifacts.

### P2 — Extract pure helpers + unit tests
- **Files:** new `lib/{csv,state,retry,proxy,extractor,runSummary}.js` (state/retry/summary get minimal stubs returning defaults in P2 if their full impl lands in P3–P5), new `tests/unit/*.test.js`, `package.json` (`test` script), `tests/login.spec.js` (import from `lib/`).
- **Constraint:** move logic verbatim first (no behavior change), then add tests. `tests/login.spec.js` must still pass with `DRY_RUN=true`.
- **Validation:** C2. **Time:** 3–5 h.

### P3 — Proxy support + retry ladder
- **Files:** `lib/proxy.js`, `lib/retry.js` (fill in full impl), `tests/login.spec.js`.
- **Proxy:** in the test loop, `const proxy = parseProxyUrl(process.env.PROXY_URL); const context = await browser.newContext(proxy ? { proxy } : {});`. Log redacted proxy host when active. Default-off.
- **Retry:** wrap `runAccountFlow` per §4.2. Non-retryable errors skip retry.
- **Validation:** C3. **Time:** 3–5 h.

### P4 — Resume state
- **Files:** `lib/state.js` (full impl), `tests/login.spec.js`, `.gitignore` (add `state.json`), `playwright.yml` (cache steps).
- **State format:**
```json
{ "batchId": "2026-08-02T02:00:00Z", "lastProcessedIndex": 42, "totalAccounts": 500, "updatedAt": "2026-08-02T03:00:00Z" }
```
- **Flow:** read `state.json` (path from `STATE_FILE` env, default `./state.json`) → `resolveStartIndex` (§6.2) → process → write after every account. `START_INDEX` env overrides. If `BATCH_ID` (env) provided and differs, start fresh at 1.
- **Note on `run-loop.js`:** it sets `START_INDEX` before each spawn, which overrides state-based resume — after P4, run via plain `npm run login` (state-driven) rather than `npm run loop`. Leave `run-loop.js` untouched during P1–P8 (see Stage 12).
- **Workflow:** restore cache (`actions/cache` key `batch-state-${{ github.run_id }}`? no — use stable key `batch-state` with `restore-keys: batch-state-`) before run; save cache after.
- **Validation:** C4. **Time:** 2–3 h.

### P5 — Observability
- **Files:** `lib/logger.js`, `lib/runSummary.js` (full), `tests/login.spec.js`, `playwright.yml` (summary step).
- Implement §5 fully. Add `logs/` timestamps for phase transitions.
- **Validation:** C5. **Time:** 2–3 h.

### P6 — Schedule + shard + artifacts + notify
- **Files:** `playwright.yml`, `scripts/notify.js`, `.env.example` (`TELEGRAM_*`).
- **Schedule:** `on: { schedule: [{ cron: '0 2 * * *' }], workflow_dispatch: {} }`. Add `concurrency: { group: login-batch, cancel-in-progress: false }`.
- **Sharding:** add optional `matrix` over `ACCOUNT_RANGE` (e.g., `1-200`, `201-400`) → each job sets `START_INDEX` and reads state; only when a `SHARD_TOTAL`/`SHARD_INDEX` env present.
- **Artifacts:** `actions/upload-artifact@v4` for `screenshots/`, `extracted_numbers.xlsx`, `logs/`, `run-summary.json`. Delete `test-results/` traces before upload (size guard vs 500 MB artifact cap).
- **Notify:** `scripts/notify.js` posts `run-summary.json` summary to Telegram (`TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`) if set; skip silently otherwise.
- **Validation:** C6. **Time:** 3–4 h.

### P7 — (Conditional) Oracle self-hosted runner
- **Files:** `.github/workflows/playwright.yml` (runs-on label), new `.github/workflows/runner-setup.md`.
- **Steps:** provision `VM.Standard.A1.Flex` (1 OCPU/6 GB or 2 OCPU/12 GB, Ubuntu 24.04, 47 GB boot) → install Docker + Node 20 → register runner with label `self-hosted-linux-arm64` → set `runs-on: [self-hosted, linux, arm64]` via workflow input so hosted remains default.
- **Gate:** only when 6-h job cap or persistent-state needs arise. **Rollback:** flip `runs-on`.
- **Validation:** C7. **Time:** 4–8 h.

### P8 — (Optional) Account list off repo
- **Files:** workflow + `scripts/fetch-accounts.js` downloading `accounts.csv` from OCI Object Storage (public-read object, signed URL in a secret) or via `git-crypt` decryption.
- **Validation:** C8. **Time:** 2–3 h.

---

## Stage 10 — DIAGRAMS

### 10.1 Per-account sequence
```mermaid
sequenceDiagram
    participant W as Workflow(cron)
    participant T as runAccountFlowWithRetry
    participant C as Chromium context
    participant S as eg1xbet.com
    participant F as state.json/screenshots
    W->>T: start batch (restore state)
    T->>T: resolveStartIndex
    loop each account
        T->>C: newContext(+proxy)+newPage
        C->>S: GET /user/login
        T->>C: fill #username, #username-password, submit
        S-->>T: redirect | "Select a login option"
        alt verification page (/accountverify)
            T->>C: fill surname, Confirm
        end
        C->>S: GET /office/recharge
        C->>S: open deposit iframe
        T->>C: click #vodafone_1 → modal
        T->>C: extract number, screenshot
        T->>F: save PNG + state.json + summary event
        T->>C: close page/context
    end
    T->>W: run-summary.json + artifacts + notify
```

### 10.2 Failure recovery
```mermaid
flowchart TD
    E[runAccountFlow error] --> C{classifyError}
    C -->|non-retryable| LF[logFailure final] --> UP[update state.json] --> NEXT[next account]
    C -->|retryable| AT{attempt < MAX_RETRIES}
    AT -->|no| LF
    AT -->|yes| BC[close page+context] --> SLP[backoff sleep] --> NC[new context] --> RE[retry]
    RE --> E
    UP --> HINT{3+ network fails?}
    HINT -->|yes| P[log PROXY_ROTATE_HINT] --> NEXT
    HINT -->|no| NEXT
```

### 10.3 Batch state machine
```mermaid
stateDiagram-v2
    [*] --> LoadState
    LoadState --> Batch: state valid → start = last+1
    LoadState --> Batch: no state → start = 1
    Batch --> Account: next (idx < total)
    Account --> Success: flow ok
    Account --> Failed: retries exhausted
    Success --> Batch: idx+1, write state
    Failed --> Batch: idx+1, write state
    Batch --> Summary: idx == total
    Summary --> [*]
```

### 10.4 Deployment
```mermaid
flowchart LR
    GH[GitHub] -->|cron + dispatch| WF[Actions workflow]
    WF -->|default| HR[Hosted runner 2vCPU/7GB]
    WF -->|label self-hosted| OV[Oracle A1 VM 2OCPU/12GB]
    HR --> C1[Chromium headless]
    OV --> C2[Chromium headless]
    C1 --> P[(proxy optional)]
    C2 --> P
    P --> SITE[(eg1xbet.com)]
    C1 --> ART[artifacts: screenshots/xlsx/log/summary]
    C2 --> ART
```

### 10.5 CI pipeline
```mermaid
flowchart LR
    PR[push / PR] --> L[eslint + prettier]
    L --> U[npm test (unit)]
    U --> A[actionlint]
    A --> D[dry-run workflow]
    D --> S[smoke: 1 account]
    S --> N[nightly cron batch]
    N --> NTFY[notify on fail / zero success]
```

### 10.6 Data flow
```mermaid
flowchart LR
    CSV[accounts.csv] --> LOAD[lib/csv getAccountsToProcess]
    SEC[secrets/.env] --> LOAD
    LOAD --> FLOW[runAccountFlowWithRetry]
    FLOW --> SCR[screenshots/*.png]
    FLOW --> EX[extracted_numbers.xlsx]
    FLOW --> LG[logs/failed-accounts.log]
    FLOW --> ST[state.json]
    SCR --> SUM[lib/runSummary run-summary.json]
    EX --> SUM
    LG --> SUM
    ST --> SUM
    SUM --> NFY[notify.js → Telegram]
    SUM --> STEP[$GITHUB_STEP_SUMMARY]
```

---

## Stage 11 — DEFINITION OF DONE (final acceptance)

- [ ] All checkpoints C0–C6 green (C7–C8 only if conditional phases done).
- [ ] `npm test` (unit) green; `npm run lint` green; `actionlint` green.
- [ ] `npm run login` works headless in CI with `--with-deps`.
- [ ] State resume verified (kill/re-run test at C4).
- [ ] Artifacts contain `screenshots/`, `extracted_numbers.xlsx`, `logs/`, `run-summary.json`.
- [ ] No secrets in repo (`git grep` clean); `.gitignore` covers all outputs.
- [ ] One logical commit per phase, each with tests run and a 2–4 line explanation, and a stop for review.
- [ ] README updated with free-cloud run instructions, env vars, and checkpoints.

---

## Stage 12 — Post-migration (Phase D — Optimization, future doc)

Only after Stage 11 is green:
- Proxy rotation (multiple `PROXY_URL` list + round-robin on failure).
- Mock mode (`USE_MOCK=true`) + fixture versioning for deterministic regression.
- `exceljs` swap (Dependabot-clean) or documented risk-acceptance for `xlsx`.
- Dockerfile + OCI container deployment.
- Performance: parallel contexts across accounts (respect site rate limits), batch sharding tuning.
- Retention policy: auto-prune screenshots >N days (ENOSPC guard — the log already shows this failure).
- Reconcile `run-loop.js` (committed; `npm run loop`): once cron + resume state are live it is redundant — either delete it or repurpose as a local `START_INDEX`-advancing loop. Do not touch during P1–P8.

Track all Phase-D work in a new `codebase-analysis-docs/OPTIMIZATION_LOG.md`; each item is its own phase with the same P16 rollback/validation discipline.

---

## Stage 13 — CURRENT PROJECT STATE & KNOWN RISKS

*(Merged from the former `assets/STATE_BLOCK.md`; line counts refreshed for the `1xauto` clone at `dfa181b`.)*

### 13.1 File map (top files)

| # | Path | Lines | Type |
|---|---|---|---|
| 1 | `tests/login.spec.js` | 360 | Core automation (all logic) |
| 2 | `run-loop.js` | 26 | Local loop wrapper (`npm run loop`) |
| 3 | `playwright.config.js` | 22 | Test runner config (disk-cache args) |
| 4 | `package.json` | 18 | Project metadata |
| 5 | `scripts/generate-excel.js` | 30 | Excel utility |
| 6 | `.github/workflows/playwright.yml` | 31 | CI/CD (currently broken — see Stage 1-G) |
| 7 | `.env.example` | 3 | Config template |
| 8 | `README.md` | 74 | Documentation |
| 9 | `logs/failed-accounts.log` | 1300+ | Runtime log |

### 13.2 Open questions (answer before/while implementing)

| # | Question | Status |
|---|---|---|
| 1 | How many accounts are typically in a batch? (Log suggests 200+.) | Open — drives sharding decision in P6 |
| 2 | Is the 2-second inter-account delay sufficient? (Logs show mass failures.) | Open — revisit in P3 retry / Phase-D rate limiting |
| 3 | How often does `eg1xbet.com` change its login/verification UI? | Open — affects selector-maintenance budget |
| 4 | What happens with the collected phone numbers after Excel generation? | Open — product question, not a blocker |
| 5 | Is the GitHub Actions workflow actually used? | **Answered** — workflow is currently broken (no `HEADLESS=true`, no `--with-deps`); P1 fixes it |

### 13.3 Known risks

| Risk | Impact | Mitigation |
|---|---|---|
| CSS selector drift | Full flow breakage | Monitor site changes; prefer resilient selectors (P2 isolates them in `lib/`) |
| Disk full (ENOSPC) | Batch failure | Pre-check disk space; limit screenshot count; prune old PNGs (Stage 12) |
| IP blocking / rate limiting | Mass login failures | Increase delays; `PROXY_URL` (P3); proxy rotation (Phase-D) |
| Account lockout | Permanent account loss | Limit attempts per account (P3 retry caps) |
| Site URL change | Complete breakage | Externalize URLs to config (Phase-D) |
