# Monitoring layer — manual checklist (live clock / real kill only)

Everything that can run without a real clock, a real kill or the real Telegram
API is automated. This file is the short list that cannot be:

```powershell
npm test              # unit tests (~2 s)
npm run test:integration   # process-level, fake Telegram (~3 min)
npm run test:all      # both
```

Integration tests never touch the live pipeline: they use throwaway temp
workspaces, a local fake Bot API (`TELEGRAM_API_BASE`) and a fake
`scripts/launch-shard.ps1`. The only exception is `launcher.test.js`, which runs
the real PowerShell file but only the guard paths that throw *before* anything
is started.

Run the checks below **once** after a deploy, and again after any change to the
alert rules, the bot commands or the launcher. Do them in order; each one leaves
the pipeline healthier than the previous.

---

## 1. Real delivery to the admin chat only

**Why manual:** the fake API proves the message text and the recipient; only
Telegram proves the bot is actually allowed to write to the admin chat.

1. Send `/help` from the admin account (`699397575`).
2. Expect the 16-line command list within ~2 s.
3. Open the channel (`-1004357023695`): **nothing** from the bot may appear
   there. Only screenshots from `realtime-send` belong in the channel.

**Fail means:** the bot token is wrong, or `TELEGRAM_CHAT_ID` points at the
channel.

---

## 2. The 09:00 Cairo all-clear line

**Why manual:** needs a real 09:00 in `Africa/Cairo`.

1. Leave the agent running overnight.
2. At 09:00 (±1 min) exactly one message arrives:
   `🟢 daily all clear · … ledger N · open incidents: none`.
3. It must not repeat during the same day, and a later restart of the agent must
   not send it again (`lastDailyPingDate` in `monitor-state.json`).
4. If there is an open incident, the line must say so instead of "all clear".

**Fail means:** `ALERT_DAILY_PING_HOUR`, the Cairo timezone, or the
`lastDailyPingDate` persistence is broken.

---

## 3. Dead-shard ladder: 🟡 silent → 🔴 stalled → `/restart` → ✅

**Why manual:** requires killing a real shard mid-batch and waiting out the real
5/15-minute thresholds.

Do this on **shard-2 only, during cooldown-end**, never on melbet.

1. Note the shard's PID: `Get-Content shards\shard-2.pid`.
2. Kill the whole tree: `taskkill /PID <pid> /T /F`.
3. `/status` shows `🟡 shard-2 · silent` after ~5 min (no events).
4. After ~15 min the agent sends one 🔴 `STALLED` alert that names
   `/restart shard-2`.
5. Send `/restart shard-2` → `⏳ restarting shard-2…`.
6. When events resume the bot sends `✅ shard-2 restarted — last event 3s ago`.
   The open `stalled` incident closes at the same moment (one 🟢 `RESOLVED`
   line), not when its TTL runs out 15 minutes later.
7. `/shards` shows the resumed `#index`. It must resume at
   `lastProcessedIndex + 1`, not at #150.

**Fail means:** the staleness thresholds, the restart guard or the launcher are
broken. Re-run `node --test tests/integration/status-bot.test.js` first; the
guards and both confirmation paths are automated there.

---

## 4. A real error screenshot

**Why manual:** needs a genuine Playwright failure that writes a PNG.

1. Force one unique failure (e.g. temporarily block the Vodafone option in
   `tests/login.spec.js`, then revert).
2. One photo arrives in the admin chat with a `NEW ERROR` caption and the
   screenshot attached. Nothing goes to the channel.
3. Repeat the same error: **no** second photo, and no second `NEW ERROR` line.
4. Force 11 unique failures within an hour (or lower
   `ALERT_PHOTO_CAP_PER_HOUR=1` in a scratch run): the 11th arrives as text
   only, containing `screenshot suppressed`.
5. Fail a step while the screenshot cannot be saved: the alert must still
   arrive, text only.

**Fail means:** the screenshot path, the 10/hour cap, or the text fallback is
broken.

---

## 5. Storm and site-wide alerts

**Why manual:** the thresholds are real-minute windows; the automated suite
covers them with synthetic timestamps.

1. Cause 5 failures for shard-1 within 15 min.
2. Expect exactly one `STORM · shard-1 · 5 failures in 15 min` message, and no
   per-account messages.
3. Cause the same error on shard-1 and shard-2 within 10 min: one
   `SITE-WIDE` message listing both shards.

---

## 6. Quiet hours on the real clock

**Why manual:** 00:00–08:00 Cairo.

1. Between 00:00 and 08:00, trigger a 🟡 warning (e.g. one new login error).
   Nothing arrives; `monitor-state.json → suppressed` grows.
2. Trigger a 🔴 critical (e.g. kill the agent's ledger file access, or corrupt
   `seen-numbers.json`): it arrives immediately.
3. After 08:00 the buffered warnings are summarised in one message, not one
   message each.
4. `/mute 2h` behaves the same way, and `/unmute` reports how many warnings were
   buffered.

---

## 7. Supervisor: restart, notice, give-up

**Why manual:** real process kills and real backoff.

1. Kill the agent only: `taskkill /PID <agent pid> /T /F`.
   The supervisor restarts it and sends one
   `ℹ️ monitor restarted · agent · was down Ns …` to the admin chat.
2. Kill it 3 times within 10 min: one 🔴 `MONITOR CHILD STOPPED · agent` and no
   further restarts. `node scripts/monitor-supervisor.mjs` brings it back.
3. Kill the status bot: same restart notice, and `/help` works again without
   starting a second bot.
4. Try to start a second supervisor: it exits with code 3 and does not fight the
   first.

Automated: backoff, give-up, exit-code-3 handling, stale lock takeover,
duplicate supervisor (`tests/integration/supervisor.test.js`).

---

## 8. Event logs and `/tail`

**Why manual:** the day boundary and file rotation are real-clock events.

1. `/tail shard-1 20` shows the newest events with Cairo time and a relative
   age, merged across the `loop`, `scrape` and `sender` files (a service writes
   one file per process).
2. After midnight Cairo, a new `events/<svc>-<role>-<inst>-YYYY-MM-DD.jsonl` is
   created and yesterday's file is left alone.
3. `/timeline` lists milestones only (never individual `step` lines), each with
   its service name.
4. Nothing from the event stream is ever posted to Telegram by itself.
5. `/report` says `N with failed accounts` and `M ended with an error`
   separately: a batch's exit code is not account success.

---

## 9. Ledger safety

**Why manual:** the live ledger is the one thing that must never be damaged.

1. `/ledger` reports the count, last sync, and pending release numbers.
2. `/csv` sends `ledger-<stamp>.csv` to the admin chat; the caption count equals
   `/ledger`'s number and the file's row count is that number plus one header row.
3. With the pipeline stopped, corrupt `seen-numbers.json` → one
   `LEDGER UNREADABLE` critical, and no crash.
4. With the pipeline stopped, replace it with a much smaller file → one
   `LEDGER SHRANK` critical.
5. Restore the file. `/numbers` totals must match again.

---

## 10. `realtime-send` shutdown and orphan protection

**Why manual:** Windows cannot deliver `SIGTERM` to a Node child, and the
parent-death check runs every 30 s.

1. Stop a batch while a screenshot is being sent: no half-sent photo, no
   duplicate on the next start, and the number stays claimed if it was
   delivered.
2. Kill only the batch parent and wait 30 s: the sender logs
   `Parent process is gone — exiting` and stops watching.
3. A `sender.stopped` event appears in `events/<svc>-sender-1-*.jsonl` after a
   graceful stop.

Automated: send to both recipients, skip old/unstable/already-seen files, one
send per number, partial recipient failure, full failure → release for retry,
missing token (`tests/integration/realtime-send.test.js`).

---

## 11. Known gaps (accepted, do not "fix" silently)

- **melbet emits no scrape steps.** Its `login.spec` was never instrumented, so
  `/tail melbet` shows loop/sender events only and `/shards melbet` has no state
  file. Its progress comes from its own loop state (#139 observed).
- **Nothing watches the supervisor.** If it dies, the agent and the bot die with
  it. Documented limitation.
- **`/restart` cannot recover melbet.** That is deliberate.
- **The 09:00 line depends on the machine being awake.** A sleeping laptop skips
  it; the next tick after 09:00 sends it once.
- **Two admins can only be added via `STATUS_ALLOWED_IDS`.** There is no
  `/addadmin`.

---

## Test map (feature → automated coverage)

| Feature | Automated test |
| --- | --- |
| Service registry, ranges, path resolution | `tests/unit/services.test.js` |
| Resume index rule | `tests/unit/resume.test.js` |
| Event writer/reader, per-role files, offsets | `tests/unit/events.test.js` |
| Alert rules (storm, stall, site-wide, caps, Cairo) | `tests/unit/alert-rules.test.js` |
| Telegram helpers, rate-limit retry | `tests/unit/telegram.test.js` |
| Dedup / ledger claim and release | `tests/unit/dedup.test.js` |
| Agent: all rules, quiet hours, mute, daily ping, queue, locks | `tests/integration/monitor-agent.test.js` |
| Bot: every command, auth, 38-line cap, rate limit, mute, restart guards, backlog | `tests/integration/status-bot.test.js` |
| Sender: recipients, dedup, stability, partial/full failure | `tests/integration/realtime-send.test.js` |
| Supervisor: backoff, give-up, exit 3, locks | `tests/integration/supervisor.test.js` |
| Launcher guards (`BATCH_ID`, name validation) | `tests/integration/launcher.test.js` |
| Real clock, real kills, real Telegram, screenshots | this file |
