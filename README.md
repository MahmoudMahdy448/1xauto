# 1xauto - 24/7 Autologin with Group Alternation

This repository runs the **1xBet Egypt** automation (2 parallel shards). Two sibling
deployments, **linebet** and **melbet**, reuse the same code (see
[Deploying a site](#deploying-a-site)).

All three sites run on one Azure VM and **alternate** so only one group's browsers
are active at a time (2 vCPU budget).

```
1xauto-shard-1  group A  accounts 1-149
1xauto-shard-2  group A  accounts 150-276
linebet         group B  its own account list
melbet          group B  its own account list
```

## Group Alternation (lease)

A shared lease file (`/opt/1xauto/group-lease.json`) gates who may run.

- **Group A (1xbet) is the priority group.** It takes the lease unconditionally,
  even mid-run, so it never waits for B. When A preempts B, B's running loop is
  stopped via a SIGTERM to the whole process group (`detached: true` spawn +
  `process.kill(-pid, 'SIGTERM')`) so no orphan browsers are left behind.
- **Group B (linebet/melbet)** runs only when the lease is free (no lease, lease
  expired, or owner is B). While B runs it heartbeats the lease every 2 min
  (2-hour lease window) and polls every 15 s; if A takes the lease, B stops its
  current run and goes back to waiting — no cooldown after a preemption.
- On a normal finish each group **releases** the lease (owner `null` + 5 min
  buffer so all sibling shards of the releasing group finish before the other
  group starts).
- Both groups wait `COOLDOWN_MINUTES` (default 60) between completed runs.

Relevant env: `RUN_GROUP`, `LEASE_FILE`, `PRIORITY_GROUP` (default A).

## Per-Site Isolation

Each deployment has its own state, screenshots, run summary, and dedup ledger:

| Site     | service(s)       | state               | screenshots dir    | ledger                    |
|----------|------------------|---------------------|--------------------|---------------------------|
| 1xBet    | 1xauto-shard-1/2 | state-shard-1/2.json | screenshots/shard-1/2 | seen-numbers.json (shared) |
| Linebet  | linebet          | state.json          | screenshots        | seen-numbers.json         |
| Melbet   | melbet           | state.json          | screenshots        | seen-numbers.json         |

A number captured on one site is **never re-sent on another site** unless the
sites share the same ledger file.

## run-loop.js

`run-loop.js` is the systemd entrypoint (`ExecStart`) for every service:

1. Acquires the group turn (lease).
2. Sets `RUN_STARTED_AT`, then spawns `scripts/scheduled-run.mjs` (login +
   excel) as a detached child.
3. While running: heartbeats the lease (every 2 min), spawns
   `scripts/notify.js` periodically (`NOTIFY_INTERVAL_MINUTES`, default 15) to
   push new unique numbers as they are captured, and (group B only) checks every
   15 s whether group A has taken the lease and kills its own run if so.
4. On finish releases the lease, then cools down or waits for the next turn.

## scripts/notify.js

- Sends screenshots only for **new unique numbers** (numbers not already in the
  ledger), once per run/interval.
- Sends **two Excel files**:
  - `extracted_numbers-combined.xlsx` — all unique numbers ever seen.
  - `extracted_numbers-unique.xlsx` — only the numbers captured **in the current
    batch** (filtered by `RUN_STARTED_AT`).
- Skips entirely when there are no new numbers.
- On a Telegram send failure the number is **released** from the ledger so it can
  be retried; rate limits (HTTP 429) are handled with backoff retry.
- Sends to chat + channel when `TELEGRAM_CHANNEL_ID` is set.

## scripts/force-send.mjs

Manual one-shot tool: claims all numbers currently in the screenshots dir against
the ledger, sends the new unique ones, and writes the combined excel. Same dedup
and release-on-failure logic as notify.js. Usage:

```bash
node scripts/force-send.mjs
```

## Telegram / status bot

- `lib/telegram.js` — photo/document send with 429 rate-limit retry.
- `scripts/status-bot.mjs` — runs as `1xauto-status-bot.service`; replies to
  `/status` (and `/status <passcode>`) with RAM/load/disk, each service's loop
  state (`running now` / `waiting for turn` / `cooldown`), progress, screenshot
  counts, and unique numbers per ledger. Allowed chat IDs come from
  `STATUS_ALLOWED_IDS`.
- `scripts/status.mjs` — CLI equivalent.

## Registering services

```bash
# A group (1xbet shards) — created on the VM as root
SHARDS="1:149,150:276" COOLDOWN_MINUTES=60 sudo bash scripts/register-shards.sh

# B group (linebet / melbet) — per site
APP_DIR=/opt/linebet SERVICE_PREFIX=linebet RUN_GROUP=B COOLDOWN_MINUTES=60 \
  sudo bash scripts/register-app.sh
APP_DIR=/opt/melbet SERVICE_PREFIX=melbet RUN_GROUP=B COOLDOWN_MINUTES=60 \
  sudo bash scripts/register-app.sh
```

Each systemd unit gets the `LEASE_FILE`, `RUN_GROUP`, `SEEN_NUMBERS_FILE`,
`STATUS_FILE`, `STATE_FILE`, `SCREENSHOTS_DIR`, `RUN_SUMMARY_FILE`, and
`COOLDOWN_MINUTES` env it needs.

## Sharded VM + combined collector (new-VM setup)

A second VM runs **only 1xauto** accounts split across N shards (e.g. 3 shards
`1:92,93:184,185:276`, or 4 shards with 16 GB RAM), each with a short cooldown
(e.g. 15 min). Shards must **not** send their own Telegram messages — instead
`scripts/collector.mjs` waits until **every** shard has finished its run and then
sends **one combined notification** (unique numbers across all shards + combined
and batch Excel files) to a **separate bot/channel**.

```bash
# 1) shards: per-shard notify off, no lease (1xauto-only VM)
SHARDS="1:92,93:184,185:276" COOLDOWN_MINUTES=15 \
  SKIP_NOTIFY=true NOTIFY_INTERVAL_MINUTES=0 LEASE_FILE= \
  sudo bash scripts/register-shards.sh

# 2) collector: derives loop-status-shard-N.json + screenshots/shard-N from SHARD_COUNT
SHARD_COUNT=3 \
  TELEGRAM_BOT_TOKEN=<new bot> TELEGRAM_CHAT_ID=<admin chat> \
  TELEGRAM_CHANNEL_ID=<new channel> \
  sudo bash scripts/register-collector.sh
```

- The new VM needs a **fresh** `seen-numbers.json` ledger (a new bot/channel must
  not reuse the shared SA VM ledger, or everything would already be deduped).
- The collector polls `COLLECTOR_STATUS_FILES` (default 30 s), records the last
  collection in `collect-state.json`, and only fires when all shards are in
  `cooldown` after `lastCollectedAt` (or advanced to a newer run).
- `SKIP_NOTIFY=true` removes the per-shard notify step in
  `scripts/scheduled-run.mjs` and disables the periodic notify timer in
  `run-loop.js`.
- `APP_DEFS_JSON` on the status bot overrides `APP_DEFS` in `lib/status.js` so
  `/status` can describe a different service set; `STATUS_BOT=0` skips the bot.

## Runtime files (gitignored)

State, screenshots, excels, ledgers, lease, and `loop-status*.json` are runtime
artifacts and are not committed.
