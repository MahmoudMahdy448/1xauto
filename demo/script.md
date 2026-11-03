# Boss demo — talk track

**One line:** we log in to 1xbet accounts, read the Vodafone cash number from the
deposit page, send it to Telegram, and never send the same number twice — with
two safety rails that stop the farm before it wastes accounts or gets the IP
banned.

Everything on screen is the real pipeline. The ledger is real, the Telegram
channel is real. Some numbers will show **already seen** because those accounts
were scraped before — that is the dedup rail doing its job, so say it before he
asks.

---

## 0. Before he sits down (5 min)

```powershell
cd C:\Users\Dell\Desktop\workspace\1xauto
```

1. **IP is clean.** If `site-block.json` says `blocked: true`, the demo refuses
   to start. Change the IP, then:
   ```powershell
   node scripts/block-clear.mjs --yes
   ```
2. **Ledger count** (what "already seen" means): shown live on the dashboard.
3. **Run the demo:** double-click `demo.bat` (one shard), or `fleet-demo.bat`
   to answer the 1‑vs‑3 question.
   - Both pause the farm and open the control room in your default browser.
     The single demo opens one *visible* Chromium window; the fleet demo opens
     two 1xbet windows and runs melbet at the same time.
4. **Have Telegram open** on your phone or desktop, on the channel.
5. Put the browser window(s) on the left, Telegram on the right. Dashboard
   behind.

If the pass already ran and you need a rerun: stop everything (Enter at the
prompt restores shard-2), then `demo.bat` again.

---

## 0b. Fleet demo — the 1‑vs‑3 answer (3–4 min)

Use `.\fleet-demo.bat` when he asks what more shards actually buy. It runs
1xbet shard-1 alone until two accounts finish (about a minute), then adds 1xbet
shard-2 and melbet — so he sees both halves of the comparison.

Point at these, in order:

1. **First minute or so:** `RUNNING · shards 1 / 3`. One browser, one account at
   a time. Say: "This is one shard. Remember this number."
2. **Then:** shard-2 and melbet join. Header goes to `3 / 3`; three shard cards,
   three accounts, own phase and timer. No shared queue — they are independent.
3. **1 shard vs 3 shards:** the grey bar is the rate recorded while one shard
   ran alone; the blue bar is the measured sum of all three now. With all three
   warm it settles near 3×. Early in the second phase it is lower because a
   new shard is still on its first account.
   > "Same pipeline, same pacing — the only difference is how many run at once."
4. **Machine panel:** CPU spikes while pages load, then falls; RAM holds three
   separate browser trees; Browsers shows ~13 Chrome processes.
5. **Task Manager (optional):** Details tab, sort by memory — three Chrome
   trees, not one. Then say the honest part:
   > "This work is network‑bound. CPU looks idle between page loads, so CPU is
   > not the proof. Concurrency and accounts per hour are."

Say the memory caveat before he asks: at 8 GB, three headed browsers are near
the ceiling. That is why each 1xbet shard is paced at 20 s (10 s aggregate) and
why the farm runs headless when nobody is watching. Melbet is a separate site,
so it adds throughput without sharing the 1xbet IP budget.

Melbet is extract‑only in this demo: its own ledger is far behind the shared
one, so attaching its sender would re‑post history. That is a deliberate demo
choice, not a missing feature.

---

## 1. Open — what this is (30 s)

> "This is the farm. Three parts: a browser that signs in to each account, a
> dashboard that shows every step live, and Telegram, where the numbers land.
> The screen behind me is not a mock-up — it's reading the same event log the
> browser writes."

Point at the header: `RUNNING`, mode `demo`.

---

## 2. Watch one account end to end (2–3 min)

Point at the **pipeline strip** as it lights up, left to right:

| Step | What to say |
|---|---|
| **01 Login** | "Real Chromium, real credentials from `accounts.csv`. Nothing pre-recorded." |
| **02 Wallet** | "It opens the deposit page, not the profile — that's where the number lives." |
| **03 Vodafone** | "It selects the Vodafone cash method and reads the number the account is tied to." |
| **04 Extract** | "Number captured, screenshot saved. The screenshot is the evidence." |
| **05 Telegram** | "Sender checks the ledger before posting. New → sends. Seen → skips." |

Point at the **current account** line and the frozen timer when the account
finishes — around 25–35 s per account.

Point at **Numbers extracted this run**: the number cards are the actual
screenshots, newest first.

> "Each card is a real screenshot of the payment page. If you ever want to check
> a number, it's here, timestamped."

---

## 3. Dedup — the part that saves money (1 min)

Look at `Numbers extracted` vs the sub-line `N new · M already seen`.

> "This is the important one. The ledger already holds about twelve thousand
> numbers. Before anything goes to Telegram, the sender claims the number in
> that ledger. If it's already there, it's skipped — no duplicate post, no
> wasted account. So the honest number for this run is the *new* count, not the
> extracted count."

If he asks "so the demo produced nothing new?":

> "Correct, and that's the system working. These accounts were scraped before.
> The machinery is what we're proving; a fresh batch of accounts is what
> produces new numbers. I deliberately didn't fake a new number."

---

## 4. Safety rail 1 — deposit gate (1 min)

Point at **Vodafone deposit gate**, state `OPEN`.

> "1xbet sometimes disables the Vodafone method. When that happens the gate
> closes: it remembers `PAYMENT_METHOD_DISABLED`, stops trying accounts, and
> probes on a ladder — five minutes, then fifteen, fifteen, fifteen — until the
> method comes back. It only reopens when a real number is read, not because a
> timer ran out. You get an alert in Telegram the moment it trips, and a short
> 'still down' note after each probe. No accounts are burned while it's shut."

---

## 5. Safety rail 2 — IP block breaker (1 min)

Point at **IP block breaker**, state `CLEAR`.

> "1xbet also blocks IPs that log in too fast. The page says 'Suspicious activity
> detected'. The breaker detects that phrase — even when the page takes thirty
> seconds to show it — and parks every shard. Retry ladder: fifteen minutes,
> thirty, sixty, then two hours. It won't restart on its own into the same
> block. When a login finally succeeds, it clears itself and says so in
> Telegram."

This is the rail that fired last night. Say so — it's credible:

> "Last night it tripped after an 83-account burst. The breaker caught it, and
> we changed the IP and resumed at ten-second pacing. That's also why this demo
> runs three accounts slowly instead of a hundred fast."

---

## 6. Close (30 s)

> "So: real browser, real accounts, real channel. Every number is deduped
> against a twelve-thousand-number ledger. Two rails stop the run before it
> wastes accounts or gets us banned. The dashboard is what I watch; Telegram is
> what you watch. Ask me for any account and I'll show you its screenshot."

Press **Enter** in the console: the farm restores (shard-2, 10 s pacing) and the
dashboard closes. If he wants to keep looking, leave the dashboard open and say
so — the restore only happens on Enter.

---

## Q&A cheat sheet

**"Is this legal / are these real accounts?"**
> "The accounts are the ones already in `accounts.csv`, supplied for this work.
> The tool drives them the same way a person would."

**"How many can it do per hour?"**
> "About 25–35 s per account plus pacing. At ten seconds between accounts a
> 1xbet shard does roughly 90–100 an hour. The fleet demo runs three shards at
> twenty seconds each — about ten seconds aggregate — and measured around
> 240 an hour. We throttle on purpose: speed is what triggers the IP block."

**"What if Telegram is down?"**
> "The sender logs `send.failed` and the number stays unclaimed in the ledger, so
> the next pass retries it. We never mark something delivered that wasn't."

**"What happens when an account fails?"**
> "It's logged as `account.failed` with the reason and a screenshot, counted in
> the success rate, and the pass moves on. It does not retry into a block — the
> retry ladder only retries things worth retrying."

**"Can I see it without Telegram?"**
> "The dashboard's event stream and the screenshot cards are the full trace. The
> channel is just the delivery end."

---

## If something goes wrong mid-demo

| Symptom | Do this |
|---|---|
| Dashboard says `DISCONNECTED` | `scripts\demo-watch.mjs` died. `powershell -NoProfile -File scripts\run-demo.ps1 -SkipPause` restarts the whole thing, or just re-run `demo.bat`. |
| Fleet panel shows `2 / 3` | One shard failed or is still starting. Check `logs\demo-s1.err.log`, `logs\demo-s2.err.log`, `logs\melbet-demo.log`. |
| Fleet comparison shows ~2× not 3× | Warm‑up: one shard has only one completion. Wait for its second account; the rate then converges. |
| Breaker turns red (`IP BLOCKED`) | Say it out loud — it's the rail working. The demo pass stops. Press Enter, change IP, `node scripts/block-clear.mjs --yes`, rerun. |
| Gate turns amber (`DISABLED`) | 1xbet shut the Vodafone method. Nothing to fix; the ladder handles it. Show the Telegram alert as proof. |
| An account fails | Normal. Point at the red line in the event stream and the failure count. |
| Browser window doesn't appear | Playwright needs a desktop session. It ran headed on this machine before; if it truly won't, rerun with `-SkipPause` and check `logs\demo.log`. |
