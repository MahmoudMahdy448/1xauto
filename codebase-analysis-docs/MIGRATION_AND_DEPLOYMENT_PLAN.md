# MIGRATION & DEPLOYMENT PLAN — 1xauto (1xbet-login-flow)

> **Version**: 1.0
> **Last Updated**: 2026-08-02
> **Status**: Authoritative
> **Document Type**: Architecture Decision Record (ADR)
> **Repository Commit**: `dfa181b` (1xauto HEAD)
>
> **Supersedes**: `master-knowledge-document.md`

**Repo:** `https://github.com/MahmoudMahdy448/1xauto` (remote `origin` of this clone, public)
**Goal:** Run continuously on FREE cloud infrastructure with little or no maintenance. Budget: **$0/month**.
**Status:** Analysis complete. No code was changed. Document is a plan only.

---

## 0. Executive Summary (read this first)

This application is **not a web service**. It is a **Playwright browser-automation batch job**: it logs into a list of 1xBet (Egypt) accounts, walks each one to the Vodafone deposit window, screenshots the payment modal, and exports the extracted Egyptian phone numbers to an Excel file.

Because it is a *periodic batch job*, it does not need a 24/7 server. The correct free-cloud shape is a **scheduled runner that executes a bounded job, persists outputs, and resumes after failure** — not a long-running container.

### The one fact that dominates every decision
The `logs/failed-accounts.log` (1,300+ lines) shows the flow already fails at extremely high rates: `input#username` not found, `net::ERR_CONNECTION_CLOSED`, `Select a login option`, `#vodafone_1` not found. These signatures are consistent with **IP-level geo-blocking / anti-bot filtering by eg1xbet.com against datacenter IPs**. **Every free cloud option in this document uses datacenter IPs.** No cloud platform can fix this for you. The plan therefore treats **egress IP reputation** as an explicit engineering requirement (proxy support + retries), not as a hosting concern.

### The one current bug that makes every CI run fail
`playwright.config.js` sets `headless: process.env.HEADLESS === 'true'`, and the existing workflow `.github/workflows/playwright.yml` does **not** set `HEADLESS`. So the bot launches a **headed** Chromium inside a headless GitHub runner (no X server) → guaranteed browser-launch failure. The workflow also runs `npx playwright install chromium` **without** `--with-deps` (missing OS libraries). Both must be fixed regardless of hosting choice.

### Recommended architecture (full justification in Phase 10)
| Layer | Choice | Why |
|---|---|---|
| Scheduler + compute | **GitHub Actions scheduled workflow** (repo is **public** → **unlimited** runner minutes) | $0 guaranteed, zero infra, cron built-in, secrets, artifacts |
| Resilience upgrade | **Oracle Cloud Always Free VM (Ampere A1, 2 OCPU / 12 GB)** registered as a **self-hosted runner** | Removes the 6-hour/job limit, adds persistent disk + Egyptian-route-able IP, while GitHub stays the control plane |
| Egress IP | **Optional proxy** via new `PROXY_URL` env var (user-provided; may be a paid residential/EG proxy — the only non-free line item, and only needed if the site blocks datacenter IPs) | Mitigates the geo-block root cause |
| Output persistence | GitHub **Artifacts** (500 MB) + optional free object storage (OCI Object Storage 20 GB free) | Screenshots + Excel survive the ephemeral runner |

**Expected cost:** $0/month platform cost. **Expected uptime:** execution is scheduled (e.g., nightly); no 24/7 availability needed. **Maintenance:** near-zero as long as the site DOM is stable; re-running a failed batch is automatic via `START_INDEX` resume state.

---

## PHASE 1 — Repository Analysis (complete architecture document)

### 1.1 Languages & frameworks
- **Language:** JavaScript (ESM — `"type": "module"` in `package.json`).
- **Framework:** Playwright Test (`@playwright/test`) used as the automation runtime, not for unit testing.
- **No backend, no database, no API server.**

### 1.2 Runtime requirements
- Node.js **20 or newer** (workflow pins `node-version: 20`; local dev is Node 22).
- Chromium browser (Playwright-managed binary).
- On Linux CI: OS libraries required by Chromium (`libnss3`, `libatk`, `libgbm`, etc.) via `npx playwright install --with-deps chromium`.
- Headless supported by config; currently defaults to **headed** (see exec summary bug).

### 1.3 Package manager & dependencies
- **npm** (`package-lock.json`, lockfileVersion 3). Resolved tree (15 packages) is tiny:
  - `@playwright/test` **1.61.1** (also pulls `playwright`, `playwright-core`)
  - `dotenv` **16.6.1**
  - `xlsx` **0.18.5**
- **No Dockerfile** exists anywhere in the repo.

### 1.4 Database(s)
- **None.** No SQL/NoSQL store. All state is in files (below).

### 1.5 Browser automation libraries
- **Playwright (test runner)** — launches Chromium, drives `eg1xbet.com` pages, reads iframes, takes screenshots.
- Not Selenium, not Puppeteer.

### 1.6 External services/APIs
- `https://eg1xbet.com/en/user/login` — login page
- `https://eg1xbet.com/en/office/recharge` — deposit/recharge page
- `/en/user/accountverify*` — account verification page (surname prompt)
- `iframe[src*="/paysystems/deposit/"]` — payment systems iframe (Vodafone deposit modal)
- No REST APIs consumed; no webhooks out; no third-party SaaS.

### 1.7 Authentication methods & secrets required
- Username/password login against the site.
- **Secrets** (per account or fallback): username, password, optional surname.
- No API keys, no tokens, no SSH keys in the app.

### 1.8 Environment variables (complete list)
| Variable | Required | Purpose |
|---|---|---|
| `ONEXBET_USERNAME` | Yes, unless `accounts.csv` exists | Fallback login email |
| `ONEXBET_PASSWORD` | Yes, unless `accounts.csv` exists | Fallback login password |
| `ONEXBET_SURNAME` | Conditional | Only for account-verification flow |
| `START_INDEX` | No (default 1) | Resume batch at 1-based record index |
| `HEADLESS` | No (default `false`) | `true` → headless Chromium |
| `PROXY_URL` | **New — recommended** | `http://user:pass@host:port`; passed to Playwright `proxy` |
| `COOLDOWN_MINUTES` | No (default 10) | Pause between `run-loop.js` iterations |

### 1.9 Folder structure & entry points
```
tests/login.spec.js          ← ENTRY POINT (single Playwright test)
run-loop.js                  ← local loop wrapper: re-runs `npm run login` with cooldown (`npm run loop`)
scripts/generate-excel.js    ← secondary entry (regenerate Excel from screenshots)
playwright.config.js         ← runner config (testDir ./tests, timeout 0)
package.json                 ← scripts: "login" = playwright test, "excel" = generate-excel
.env.example                 ← credential template
.github/workflows/playwright.yml  ← CI/CD (workflow_dispatch only)
logs/failed-accounts.log     ← append-only failure log
accounts.csv                 ← (gitignored) batch account list
screenshots/                 ← (gitignored) PNG output
extracted_numbers.xlsx       ← (gitignored) Excel output
test-results/                ← (gitignored) Playwright traces
```

### 1.10 Startup / build process
- **Startup:** `npm run login` → `playwright test` (config: `testDir: './tests'`, `timeout: 0`).
- **Build:** none. No compile step. `npm install` + `npx playwright install chromium` is all.
- **Long-running workers / cron / queues:** none today. The batch loop inside the single test is sequential (`for` over accounts). Failure of one account does not abort the loop.
- **Persistent storage requirements:** none required by logic; *output* storage needed for `screenshots/`, `extracted_numbers.xlsx`, `logs/`. The runner's filesystem is **ephemeral** on every free-cloud option → outputs must be exported/uploaded.
- **Logging:** single append-only text file; failures only. No structured logs, no log shipping.

### 1.11 Existing CI/CD
- `.github/workflows/playwright.yml`: `workflow_dispatch` only, `ubuntu-latest`, Node 20, `npm install`, `npx playwright install chromium`, `npm run login`, secrets injected from GitHub Secrets.
- **Defects:** (1) no `HEADLESS=true` → headed launch on headless runner; (2) `playwright install` without `--with-deps`; (3) no output collection (screenshots/Excel lost after the job); (4) no schedule; (5) no resume state; (6) no failure notification.

---

## PHASE 2 — Runtime Analysis

### 2.1 What it actually is
- **Automation bot** (Playwright). It is a **CLI-style batch job** wrapped in a Playwright test. It is **not** a web server, API, or always-on worker.

### 2.2 How it stays running (current)
- It does **not**. A human runs `npm run login` locally (visible browser) and babysits CAPTCHA/OTP/verification. This is the exact opposite of "continuous with little maintenance."
- **Intended continuous operation model (target):** scheduled, idempotent, resumable batch runs.

### 2.3 Failure recovery (current vs required)
| Aspect | Current | Required for unattended |
|---|---|---|
| Retry on transient error | None | Backoff retry per account (e.g., 2 attempts) |
| Resume mid-batch | Manual `START_INDEX` | Automatic: persist last processed index to state; next run continues |
| Crash during run | Whole run lost | Ephemeral-run-safe: commit progress after each account |
| Notification | None | Telegram/Discord webhook on run completion/failure |

### 2.4 Environment requirements (answers to the checklist)
- **Persistent sessions:** No — a **fresh browser context per account** is created and closed (`browser.newContext()`). Sessions must NOT be reused; this simplifies cloud runs.
- **Browser profiles:** No — stock Playwright contexts.
- **Local files:** Yes — `accounts.csv` (input), `screenshots/` + `extracted_numbers.xlsx` (output), `logs/` (log). All are ephemeral-friendly if exported.
- **Writable storage:** Yes (output dirs). Any ephemeral runner works if artifacts are uploaded after the job.
- **GPU:** No — software rendering (Chromium `--headless` uses SwiftShader). Do **not** enable GPU.
- **X11/display:** No, **if** `HEADLESS=true`. The current default (`false`) requires a display and breaks on all headless cloud runners — must be overridden in CI.
- **Network:** Outbound HTTPS to `eg1xbet.com` only. No inbound traffic ever.

### 2.5 Timing profile (drives sizing)
- Per account: ~20–70 s (page load 3–8 s + login 3–12 s + optional verify 2–5 s + recharge nav 3–8 s + iframe/Vodafone wait 0–30 s + modal/screenshot 3–10 s), plus 2 s between accounts.
- 100 accounts ≈ **0.5–2 hours**. 500 accounts ≈ **3–10 hours** → exceeds GitHub's 6-hour per-job cap → must shard or batch daily.

---

## PHASE 3 — Dependency Audit

### 3.1 System / OS dependencies (Ubuntu 22.04/24.04 runner)
| Package | Needed for |
|---|---|
| Chromium OS libs (`libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 libpango-1.0-0 libcairo2`) | Playwright Chromium launch |
| `xvfb` | Only if run headed (not recommended) |
| `fonts-liberation`, `fonts-noto-cjk` | Text rendering of the payment modal screenshots |

Installed automatically by `npx playwright install --with-deps chromium` (needs `sudo` on self-hosted VMs; on GH hosted runners `--with-deps` uses sudo automatically).

### 3.2 Browsers / drivers
- Chromium (bundled/Playwright-managed, ~170 MB unpacked). No separate driver; Playwright speaks CDP natively.

### 3.3 Node runtime
- Node 20 (LTS) minimum; Node 22 verified locally. ESM modules.

### 3.4 Resource profile (single concurrent account)
- **RAM:** Chromium headless idle ~150–250 MB; peak (screenshot of a 1440×960 viewport page) ~350–500 MB. Node + xlsx overhead < 100 MB. **Safe minimum: 1 GB; comfortable: 2 GB.**
- **CPU:** 1 vCPU is enough; serialized per-account work. More vCPUs only help via parallelism (not implemented; not needed).
- **Disk:** ~1 GB transient (Chromium + Node modules) + screenshots (~0.5–1.5 MB each; a 500-account run ≈ 250–750 MB). Add a cleanup step if batch is large (ENOSPC is a **known historical failure** in the log).
- **Network:** Low bandwidth; ~2–10 KB/request; a full run transfers < 100 MB including page assets.
- **Memory ceiling examples:** Render free 512 MB → **too tight**; GH-hosted runner 7 GB → fine; Oracle A1 12 GB → fine; e2-micro 1 GB → borderline/failing.

### 3.5 Vulnerability notes (audit flags)
- `xlsx@0.18.5` is **unmaintained** and has known **prototype-pollution / ReDoS** advisories (GHSA). It only parses/writes arrays of strings here, so exposure is minimal, but plan a pin + npm audit whitelist note.
- GitHub **Dependabot** will flag `xlsx`; you must either accept the risk or replace with `exceljs`.

---

## PHASE 4 — Deployment Options (all evaluated; free tiers verified 2026)

Scoring: 1–10. Score weights: can it run Chromium, can it schedule, can it persist output, $0 reliability, maintenance.

### Serverless / Functions (cannot run this app)
| # | Option | Verdict | Suitability |
|---|---|---|---|
| 4 | **Cloudflare Workers** | No Chromium; only V8 isolates. Cannot run Playwright. | **0/10** |
| 18 | **Firebase / Cloud Functions** | No reliable Chromium; short timeouts; wrong model. | **1/10** |
| 19 | **Vercel** | Serverless, 300 s cap, no browser. | **1/10** |
| 20 | **Netlify** | Same as Vercel. | **1/10** |

### PaaS / Containers
| # | Option | Verdict | Suitability |
|---|---|---|---|
| 1+2 | **GitHub Actions + scheduled cron** | **BEST FIT.** Public repo → **unlimited** standard-runner minutes. Runs Chromium (with-deps), cron, secrets, artifacts. Limits: 6 h/job, US/EU datacenter IPs, 60-day inactivity auto-disable on public repos. | **9/10** |
| 3 | **GitHub self-hosted runner** | Free + unlimited, runs your own hardware/IP (solves geo-block if machine is in Egypt). But it is **not cloud** and is "little maintenance" only if you already own a 24/7 box. | **8/10** (only if hardware exists) |
| 11 | **Oracle Cloud Always Free VM** | Ampere A1 **2 OCPU / 12 GB** (reduced from 4/24 in 2026), 200 GB disk, 10 TB egress, public IPv4, no expiry. Can run Docker/Playwright/cron 24/7 or as self-hosted runner. Needs credit-card verification. Datacenter IP. | **8/10** |
| 8 | **Render (free web/cron)** | Free tier exists (750 h/mo, cron free, no card). But 512 MB RAM / 0.1 CPU is **too weak for Chromium reliably**, no persistent disk on free, US/EU IPs, cold starts. | **4/10** |
| 15 | **Hugging Face Spaces** | Free CPU Basic (2 vCPU/16 GB) existed, but **2026 changes restricted/paid Gradio & Docker for new accounts**; also no cron and spaces sleep. **Unreliable** for this workload now. | **3/10** |
| 5 | **Cloudflare Containers** | Still preview; Chromium-heavy image + egress fees make this a poor fit; not for scheduled batch. | **2/10** |
| 6 | **Fly.io** | No free tier for new accounts (2024+): only ~2 VM-hour trial. | **2/10** |
| 7 | **Railway** | No free tier (only $5 one-time trial credit). | **2/10** |
| 9 | **Koyeb** | Free tier is small/credit-limited and changed repeatedly; weak fit for 6 h Chromium jobs. | **3/10** |
| 10 | **Deta Space** | **Sunset/defunct.** | **0/10** |
| 16 | **Replit** | Free tier ephemeral, deployments sleep; no reliable scheduling. | **2/10** |
| 17 | **Glitch** | Apps sleep; not suitable. | **2/10** |

### Hyperscaler free tiers (12-month caps → not $0 ongoing)
| # | Option | Verdict | Suitability |
|---|---|---|---|
| 12 | **GCP Always Free (e2-micro, 1 GB)** | Too weak for Chromium; US regions only (worse geo-block); *always-free* part is real but CPU starves. | **3/10** |
| 13 | **AWS Free Tier (t2/t3.micro)** | Free only **12 months**; then billed. Not $0 ongoing. | **2/10** |
| 14 | **Azure Free Tier (B1s)** | Same 12-month cap; 1 GB RAM borderline. | **2/10** |

### Better alternatives worth noting
- **Cron-job.org / FastCron / EasyCron (free tiers)** → could trigger a webhook, but the bot is not a web server, so they only help if you later add a "start run" endpoint on the Oracle VM (out of scope for $0 plan).
- **Google Colab free** → 12 h CPU sessions, but no scheduling and requires a browser/token to start; **not** viable for unattended automation.
- **Any always-on $0 VM is the "real" alternative**: Oracle Always Free is the only major-cloud one left in 2026.

---

## PHASE 5 — GitHub Actions Feasibility (deep dive)

| Question | Answer |
|---|---|
| Executes within workflow time limits? | Per-job max is **~6 hours** for standard runners on public repos. Yes for ≤ ~200–400 accounts/run; **no for 500+** → shard with a `matrix`, or split into multiple daily runs, or move to Oracle self-hosted runner (no job cap). |
| Can it be restarted automatically? | Yes — `schedule: cron` re-runs each interval. Each run starts fresh; **resume via persisted `START_INDEX`** stored in an artifact/cache/state file. |
| Can state be persisted? | **Artifacts** (500 MB free, retained up to 90 days) and **cache** (10 GB) persist between runs. Write a small `state.json` (last processed index) to a cache key; on each run, download state, set `START_INDEX`, upload new state. |
| Can browser automation run? | **Yes** — standard runner has 7 GB RAM/2 vCPU. Use `npx playwright install --with-deps chromium` and set `HEADLESS=true`. (`xvfb-run` only needed if you insist on headed.) |
| Can artifacts store data? | Yes — upload `screenshots/`, `extracted_numbers.xlsx`, `logs/` as artifacts each run. Screenshots of ~500 accounts (~750 MB) exceed the 500 MB artifact cap → trim (keep only the phone number? no—keep modal screenshots but delete `test-results/` traces, or upload to free OCI Object Storage 20 GB instead). |
| Can cache store sessions? | Cache is for CI deps + resume state, **not** browser sessions (sessions are intentionally not reused). |
| Can GitHub Secrets replace config files? | Yes — credentials as `ONEXBET_*` secrets; **never commit `accounts.csv`/`.env`**. For hundreds of accounts, a secrets file in repo is not viable → store the CSV in the repo as **encrypted** (e.g., `git-crypt`) or fetch from free OCI Object Storage with a signed URL. |
| Can cron replace background services? | Yes — this app is a batch job, exactly what cron is for. Min interval 5 min; default branch only; **public repos auto-disable schedules after 60 days of no repo activity** (keep a keepalive commit or keep the repo private with the 2,000-min budget). |
| Monthly runtime estimate | 1 daily run × 100 accounts ≈ 1–2 h → **~30–60 h/month** on a public repo = **unlimited/free**. On a **private** repo this would consume 1,800–3,600 min vs a 2,000-min free budget → **public repo (or Oracle self-hosted) is required**. |
| Verdict | **Feasible and recommended**, subject to: public repo + `HEADLESS=true` + `--with-deps` + artifact/cache persistence + proxy for geo-block. |

---

## PHASE 6 — Cost Optimization ($0/month)

Ranked by (reliability, cost, simplicity, maintenance, performance):

| Rank | Option | Reliability | Cost | Simplicity | Maintenance | Performance | Why |
|---|---|---|---|---|---|---|---|
| 1 | **GH Actions (public repo) + cron** | High (hosted by GitHub) | **$0** (unlimited min) | Very high | Very low | High (7 GB/2 vCPU) | Already in repo; scheduling, secrets, artifacts built-in |
| 2 | **Oracle Always Free VM + self-hosted runner** | High (your VM) | **$0** | Medium | Medium (VM patching) | High (up to 12 GB) | No job-time cap, persistent disk, egress control, region choice closer to Egypt (Jeddah) |
| 3 | **GH Actions private repo** | High | $0 until 2,000 min/mo | High | Low | High | Budget limits batch size to ~30–100 accounts/month |
| 4 | **Oracle VM standalone (cron + systemd)** | Medium-High | **$0** | Medium | Medium | High | No GitHub dependency; more manual ops |
| 5 | **Render free cron** | Medium | $0 | Medium | Low | **Low** (512 MB) | Chromium runs but slow/flaky; no persistence |
| 6 | Everything else | — | — | — | — | — | Not $0-continuous or cannot run the app |

**Cost conclusions**
1. The only truly "unlimited + $0 + zero-ops" path is a **public GitHub repo using Actions cron**.
2. The only "$0 + arbitrary runtime + persistence + regional IP choice" path is **Oracle Cloud Always Free**.
3. **Hybrid (recommended):** GitHub Actions as scheduler/control-plane + Oracle VM as a self-hosted runner when job size or geo-block demands it. Both halves are $0.

---

## PHASE 7 — Migration Plan (step-by-step; no code written yet)

Legend: Risk = L/M/H · Time = engineering-hours.

### Step 1 — Fix CI runner environment (do first; today's runs fail)
- **Purpose:** Make the existing workflow actually launch Chromium.
- **Files affected:** `.github/workflows/playwright.yml`, `playwright.config.js`, `.env.example`.
- **Changes:** set `HEADLESS: true` in the workflow env; change install to `npx playwright install --with-deps chromium`; add `.env.example` entries for `PROXY_URL`.
- **Risk:** L. **Rollback:** revert workflow YAML. **Time:** 0.5–1 h. **Deps:** none. **Prereq:** push access.

### Step 2 — Add proxy + retry support to the test
- **Purpose:** Address the geo-block root cause and transient failures.
- **Files affected:** `tests/login.spec.js` (read `PROXY_URL`; pass `proxy` to `browser.newContext()`; wrap account attempt in a small retry loop; keep `logFailure`).
- **Risk:** M (browser config change). **Rollback:** default-off (only active when `PROXY_URL` set). **Time:** 2–4 h. **Deps:** Step 1. **Prereq:** a proxy endpoint (optional; without one the bot still runs, just from datacenter IP).

### Step 3 — Persist resume state + shrink outputs
- **Purpose:** Auto-resume batches across ephemeral runners and stop losing artifacts.
- **Files affected:** `tests/login.spec.js` (write `state.json` after each account: `{ lastProcessedIndex, batchId }`); new `scripts/` helper for state upload/download; workflow steps to save/restore state via Actions **cache**, upload **artifacts** (`screenshots/`, `extracted_numbers.xlsx`, `logs/`), and delete `test-results/` traces.
- **Risk:** M. **Rollback:** `START_INDEX` still works manually. **Time:** 3–5 h. **Deps:** Steps 1–2.

### Step 4 — Schedule + shard
- **Purpose:** Continuous, bounded, parallelizable execution.
- **Files affected:** `.github/workflows/playwright.yml`.
- **Changes:** add `on.schedule: cron` (e.g., `0 2 * * *` UTC nightly); keep `workflow_dispatch`; optional `matrix` over account ranges for >300-account batches; set `concurrency` to avoid overlap.
- **Risk:** L. **Rollback:** remove cron entry. **Time:** 1–2 h. **Deps:** Step 3 (state) so shards/restarts are safe.

### Step 5 — Notifications
- **Purpose:** Maintenance-free alerting.
- **Files affected:** workflow + a small `scripts/notify.js` (POST to `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` or Discord webhook on failure/zero-success).
- **Risk:** L. **Rollback:** don't set tokens. **Time:** 1–2 h. **Deps:** Step 4.

### Step 6 — (Conditional) Provision Oracle Always Free VM as self-hosted runner
- **Purpose:** Escape the 6-hour job cap; add persistent disk; choose a region (Jeddah) nearer to Egypt; run longer batches or even 24/7.
- **Files affected:** new `.github/workflows/runner-setup.md` + runner registration docs; `Dockerfile` optional.
- **Steps (summary, no code):** sign up OCI → create VCN + `VM.Standard.A1.Flex` (1–2 OCPU/6–12 GB, Ubuntu 24.04, 47 GB boot) → install Docker/Node → register as a GitHub self-hosted runner at org/repo level with a runner label → point the scheduled workflow's `runs-on` at that label.
- **Risk:** M (account setup; capacity ("out of capacity for A1") is common → retry or use `E2.1.Micro`). **Rollback:** keep `runs-on: ubuntu-latest` fallback. **Time:** 4–8 h. **Deps:** Steps 1–5. **Prereq:** credit card for OCI signup (never charged while using only Always Free resources; set a $1 budget alert).

### Step 7 — Optional: move account list off the repo
- **Purpose:** Handle 100s of accounts without committing credentials to a public repo.
- **Files affected:** workflow + script to download `accounts.csv` from OCI Object Storage (public-read, signed URL) or encrypt in-repo.
- **Risk:** M (secret hygiene). **Rollback:** keep local CSV path. **Time:** 2–3 h. **Deps:** Step 6 (OCI) or a git-crypt decision.

---

## PHASE 8 — CI/CD Plan

| Discipline | Plan |
|---|---|
| **Automatic testing** | Keep the Playwright run itself as the only real test. Add a **smoke test** (1 account, `SMOKE=true`) that runs on push/PR so DOM changes surface early. |
| **Linting / formatting** | Add ESLint + Prettier (dev deps); run in a fast `lint` job on push. No lint config exists today. |
| **Dependency updates** | Enable **Dependabot** (npm); note `xlsx` advisories — plan `exceljs` swap or a documented accept-risk. |
| **Security scanning** | `npm audit` job + GitHub **CodeQL** (JS) on schedule. Block on critical, warn on high. |
| **Automatic deployment** | "Deploy" = the scheduled workflow itself; no artifact build needed. |
| **Secrets management** | GitHub Secrets for `ONEXBET_*`; never commit `.env`/`accounts.csv` (already gitignored). Proxy credentials live in the proxy URL secret. |
| **Release process** | Tag-based: scheduled workflow always runs `main`; releases are informational. Keep `START_INDEX` state keyed to branch. |
| **Monitoring** | Per-run summary step: accounts processed / succeeded / failed / unique numbers; write to the run summary + artifact. |
| **Failure notifications** | Telegram/Discord webhook (Step 5) on: run failure, zero successes, or ≥N consecutive failures. |
| **Guard against 60-day cron death** | Public-repo schedules auto-disable after 60 days of no activity → add a keepalive job or periodic doc-bump commit; or use the Oracle self-hosted runner (private scheduling still needs the minute budget — see Phase 5). |

---

## PHASE 9 — Required Repository Changes

### Critical (required for any cloud run to work)
1. `HEADLESS=true` in `.github/workflows/playwright.yml` (or a config default of `true` when CI is detected).
2. `npx playwright install --with-deps chromium` in the workflow.
3. Upload `screenshots/`, `extracted_numbers.xlsx`, `logs/` as workflow artifacts; delete `test-results/` before upload.
4. Never run headed on a runner without `xvfb-run` (matches #1).

### Recommended (reliability of the $0 deployment)
5. `PROXY_URL` env support passed to `browser.newContext({ proxy })` (off by default).
6. Per-account retry (1 retry) with short backoff; continue logging via `logFailure`.
7. Resume state (`state.json`) persisted through Actions cache; auto-set `START_INDEX`.
8. Cron schedule (`0 2 * * *`) + `concurrency` group + matrix sharding for large batches.
9. Failure notification script (Telegram/Discord).
10. Dependabot + `npm audit` + CodeQL workflows.
11. Add `.github/workflows/smoke.yml` for a 1-account run on PR/push.
12. Update `README.md` with the free-cloud run instructions and the proxy/headless flags.

### Optional
13. ESLint + Prettier setup.
14. Dockerfile (`mcr.microsoft.com/playwright` base) — only needed if you later run on a container platform or Oracle VM as a container.
15. Swap `xlsx` → `exceljs` (maintained) to clear Dependabot alerts.

### Nice-to-have
16. `git-crypt` for an encrypted `accounts.csv` in-repo.
17. Excel "Screenshot" column mapping number → artifact URL.
18. Structured JSON run-summary artifact for downstream analysis.

---

## PHASE 10 — Final Recommendation

### Recommended architecture: **GitHub Actions scheduled workflow (primary) + Oracle Cloud Always Free VM as self-hosted runner (resilience tier)**

Rationale in one line: *GitHub Actions is the only $0 platform with unlimited compute for this public repo, scheduling, secrets, and artifacts built in; Oracle's Always Free VM removes GitHub's only real limit (6 h/job + datacenter-only egress) for the same $0.*

```
┌────────────────────────────────────────────────────────────────────────────┐
│ GitHub (control plane)                                                     │
│  ┌────────────────────┐   ┌────────────────────┐   ┌─────────────────────┐ │
│  │ Secrets            │   │ Cron (nightly)     │   │ Actions cache       │ │
│  │ ONEXBET_* PROXY    │   │ workflow_dispatch  │   │ state.json (resume) │ │
│  └────────┬───────────┘   └─────────┬──────────┘   └──────────┬──────────┘ │
└───────────┼─────────────────────────┼─────────────────────────┼────────────┘
            │                          ▼                         │
            │            ┌─────────────────────────────┐        │
            │            │ Scheduled workflow          │        │
            │            │ (ubuntu-latest OR self-     │        │
            │            │  hosted label)              │        │
            │            │  npm ci                     │        │
            │            │  playwright install --with- │        │
            │            │  deps chromium              │        │
            │            │  HEADLESS=true PROXY_URL    │        │
            │            │  npm run login  (state in)  │        │
            └────────────┼──────────┬──────────────────┼────────┘
                         ▼          │                  ▼
        ┌──────────────────────────┐│   ┌──────────────────────────┐
        │ Hosted runner (free,     ││   │ Oracle Always Free VM    │
        │ unlimited, ≤6h/job)      ││   │ A1 2 OCPU/12GB · 200GB   │
        │ ┌──────────────────────┐ ││   │ self-hosted runner label │
        │ │ Chromium → eg1xbet   │ ││   │ persistent disk + state  │
        │ │ → screenshots/xlsx   │ ││   └──────────────┬───────────┘
        │ └──────────┬───────────┘ ││                  │
        └────────────┼─────────────┘│                  │
                     ▼              │                  ▼
   ┌────────────────────────────────┴──────────────────────────┐
   │ Artifacts: screenshots/*.png · extracted_numbers.xlsx ·    │
   │ logs/failed-accounts.log  (+ optional OCI Object Storage)  │
   └────────────────────────────────────────────────────────────┘
```

### Why this is the best
1. **$0 guaranteed** — public repo = unlimited Actions minutes; Oracle Always Free has no expiry.
2. **Zero maintenance** — no servers to keep warm for the primary tier; cron self-heals; failures auto-resume via state.
3. **Already aligned** — the repo already ships a GH Actions workflow; the delta is small.
4. **Capacity escape hatch** — the same workflow file runs against the Oracle self-hosted runner (just change `runs-on`) when jobs exceed 6 h or when datacenter IPs are blocked and you need a region/proxy closer to Egypt.
5. **Persistent outputs** — artifacts (and OCI Object Storage free 20 GB) preserve screenshots and the Excel export.

### Folder changes (target tree)
```
.github/workflows/
  playwright.yml        # + schedule, HEADLESS, --with-deps, artifacts, state, notify
  smoke.yml             # new: 1-account CI on push/PR
  dependabot.yml        # new
  codeql.yml            # new
scripts/
  generate-excel.js     # existing
  notify.js             # new: Telegram/Discord
  state.js              # new: read/write resume state.json
  cleanup.js            # new: prune old screenshots (ENOSPC guard)
Dockerfile              # optional
.gitignore              # add state.json
```

### Workflow files (outline only — code in a later implementation phase)
- `playwright.yml`: `on: { schedule: [{ cron: '0 2 * * *' }], workflow_dispatch: {} }` → jobs: `run` (matrix optional) on `ubuntu-latest` or `self-hosted` → steps: checkout → setup-node(20, npm cache) → `npm ci` → `playwright install --with-deps chromium` → restore state cache → `env: { HEADLESS: 'true', PROXY_URL: secrets.PROXY_URL, ONEXBET_*: secrets }` → `npm run login` → save state cache → upload artifacts → notify.
- `smoke.yml`: same, `SMOKE=true`, on push/PR.

### Docker requirements
- **None for the primary tier.** Optional `Dockerfile` (`FROM mcr.microsoft.com/playwright:v1.61.1-noble` + copy app + `CMD ["npm","run","login"]`) only if you later move to the Oracle VM as a container or to a container PaaS.

### Secrets
- GitHub Secrets: `ONEXBET_USERNAME`, `ONEXBET_PASSWORD`, `ONEXBET_SURNAME`, `PROXY_URL` (optional), `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` (optional).
- OCI (if resilience tier used): SSH key; object-storage keys (optional).

### Environment variables
- `HEADLESS=true` (CI), `START_INDEX` (auto), `PROXY_URL` (optional), existing `ONEXBET_*`, optional `SMOKE=true`, `TELEGRAM_*`.

### Expected metrics
| Metric | Expected |
|---|---|
| Monthly platform cost | **$0.00** (no card charged; OCI free-tier only, budget alert at $1) |
| Uptime | Execution is scheduled nightly (~1–2 h); no always-on requirement. "Availability of the pipeline" ≈ 100% for a public repo with a keepalive commit every ≤60 days |
| Maintenance | ~0.5–1 h/month (review failed log, adjust DOM selectors if the site changes, occasional keepalive commit) |
| Scalability | 100s of accounts/day via matrix sharding (multiple 6-h jobs in parallel) or Oracle self-hosted (unbounded per-job time) |
| Limitations | (1) Datacenter IPs are the dominant risk — requires `PROXY_URL` for reliable operation; (2) interactive CAPTCHA/OTP cannot be solved unattended — the flow must stay CAPTCHA-free or you must pay for solving; (3) GitHub cron has no SLA (5–30 min delays) and auto-disables after 60 days idle on public repos; (4) OCI A1 capacity is sometimes unavailable at signup (retry or use E2.1.Micro); (5) OCI Always-Free A1 was reduced to 2 OCPU/12 GB in 2026 — still ample for Chromium |

### Final call
**Adopt the GitHub Actions scheduled workflow now** (Steps 1–5, ~2–3 engineering days, $0, near-zero maintenance). **Add the Oracle Cloud Always Free self-hosted runner** (Step 6) the moment you hit the 6-hour job cap, need longer-than-daily batches, or need an egress IP closer to Egypt. **Add `PROXY_URL` support immediately** (Step 2) because it is the only in-scope mitigation for the geo-blocking already visible in `logs/failed-accounts.log`.

No code has been written in this phase, per the mission. Implementation should begin at **Step 1**.
