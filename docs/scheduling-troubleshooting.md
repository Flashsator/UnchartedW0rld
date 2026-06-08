# Scheduling & triggering — troubleshooting notes (2026-06-08 investigation)

These notes record an investigation into a scheduling anomaly: **why the pipeline
ran on a Sunday (a non-publish day), and why it looked like "a Short went out too."**
For future me / future agents.

## Scheduling architecture (understand this first)

```
Cloudflare Worker (uncharted-daily-trigger)
  └─ cron fires → POSTs workflow_dispatch to GitHub → runs the full daily.yml pipeline
GitHub built-in cron (backup)
  └─ Mon/Wed/Fri 15:30 UTC, only fills in when CF didn't fire (exits early via the upload lock)
```

> NOTE: this section describes the OLD architecture that was in effect during the
> investigation. As of 2026-06-08 both the Cloudflare Worker and the GitHub cron are
> retired — scheduling is now Upstash QStash only. See "Follow-up" at the bottom.

- **The primary schedule was the Cloudflare Worker**, not GitHub cron.
- The Worker's `scheduled()` dispatches **unconditionally** — it has no "day of week"
  check; which day it fires is decided entirely by the cron in
  `cloudflare-trigger/wrangler.toml`.
- The Worker's `fetch()` (hitting the Worker URL) **also triggers one dispatch, with no
  auth** — a secondary risk, but it isn't an on-the-hour trigger, so it can be told
  apart by timestamp.
- The pipeline **itself has no "don't publish on a non-publish day" gate.**
  `seriesForToday()` falls back (picks a series by date) when there's no mapping for the
  weekday, so **once the workflow is triggered it will publish, no matter the day.**

## The two findings this time

### 1. The live Worker's cron drifted from the repo (causes weekend misfires)

`wrangler.toml` is set to `crons = ["0 13 * * 1,3,5"]` (Mon/Wed/Fri only), but the
trigger log shows a cron fire at **2026-06-07 (Sunday) 13:00:09 UTC** with the
"on-the-hour + a few seconds of jitter" signature — that's the fingerprint of a
Cloudflare cron, and it should never happen on a Sunday.

→ **Conclusion: the deployed version was running an old cron (including weekends) and
had never been redeployed to match the repo's config.** That's the root cause of the
extra unplanned Sunday video (`4bFajUx2ydM`, Beast Codex / animals).

> Aside: `CLOUDFLARE_API_TOKEN` was verified dead during the investigation
> (`Invalid API Token`), so the live cron couldn't be read via the API — it had to be
> inferred from the trigger log.

### 2. "A Short went out too" was actually by design

`planShortsForToday()` is designed so the long-form run "produces" a Short on its own
day, but **schedules it to go public on a following off-day**:

```
Mon long → Tue short
Wed long → Thu short
Fri long → Sat + Sun shorts (two)
other days → nothing
```

So the Short seen on 06-07 (`aVToU-9aNos`) was **scheduled by the 06-06 run for the next
day**, **not** published by the 06-07 run — the 06-07 run's log explicitly says
"Shorts: nothing scheduled for today." Not a bug.

## Fix (what was actually done)

The two CF-Worker findings above were resolved not by redeploying the Worker but by
**retiring it entirely** and moving to Upstash QStash (see "Follow-up" below). The
`cloudflare-trigger/` directory and its `wrangler.toml` / `CLOUDFLARE_API_TOKEN`
workflow have been **removed from the repo** — the historical wrangler-redeploy /
token-regeneration steps no longer apply. (Cloudflare Workers AI is still used for
FLUX.2 thumbnail backgrounds — that's a separate product and is unaffected.)

## One-line summary

| What you saw | The truth | Fix? |
|---|---|---|
| GH ran on Sunday + an extra long video | Live CF cron was the old one (incl. weekends), out of sync with the repo | Superseded — CF Worker retired, replaced by QStash |
| A Short on Sunday too | By design: scheduled by the 06-06 run for the next day | No |
| API can't read the live cron | `CLOUDFLARE_API_TOKEN` expired | Moot — Worker removed |

---

## Follow-up: switched to Upstash QStash as the sole trigger (2026-06-08)

The CF Worker silently stopped firing once its token expired, and GitHub's built-in cron
routinely lands hours late — neither is reliable. So as of 2026-06-08:

- **Removed** the `schedule:` cron from `daily.yml` (commit `8501997`); its `on:` is now
  `workflow_dispatch:` only.
- **CF Worker schedule retired.**
- **Sole trigger = Upstash QStash:** one schedule (cron `0 13 * * 1,3,5` = Mon/Wed/Fri
  13:00 UTC = Taiwan 21:00) POSTs a `workflow_dispatch` to GitHub's `daily.yml`,
  forwarding a GitHub PAT (`Upstash-Forward-Authorization`, needs this repo's Actions: write).
- Double-publishing is still guarded by the upload lock (`work/.last-upload-date`) + the
  `daily-video` concurrency group.
- **Manual fallback if a trigger is missed:** `gh workflow run "Daily video" --ref main`.

Create the schedule (read tokens from `.env`; never paste their values into terminal
history / chat):

```bash
curl -s -X POST \
  "https://qstash.upstash.io/v2/schedules/https://api.github.com/repos/Flashsator/UnchartedW0rld/actions/workflows/daily.yml/dispatches" \
  -H "Authorization: Bearer $QSTASH_TOKEN" \
  -H "Upstash-Cron: 0 13 * * 1,3,5" \
  -H "Upstash-Method: POST" \
  -H "Upstash-Forward-Authorization: Bearer $GH_PAT" \
  -H "Upstash-Forward-Accept: application/vnd.github+json" \
  -H "Content-Type: application/json" \
  -d '{"ref":"main"}'
```

## ⚠️ QStash schedules leak the forwarded token — NEVER `GET /v2/schedules`

**Background:** the GitHub PAT is passed in the
`Upstash-Forward-Authorization: Bearer <token>` header at schedule creation. QStash
stores that header **verbatim, in plaintext, inside every schedule.**

**The trap:** any "list / read schedule" call echoes the stored token back in cleartext:
- `GET https://qstash.upstash.io/v2/schedules` — lists ALL, dumps **every** schedule's token
- `GET https://qstash.upstash.io/v2/schedules/{id}` — single, also includes the full header

If that output lands anywhere persistent (chat logs, CI logs, terminal screenshots,
pasted to someone), treat those PATs as compromised. **This actually happened on
2026-06-08:** a "verify" step that listed all schedules printed `.env`'s `GITHUB_TOKEN`
plus a PAT shared with another project — both had to be rotated.

**Rules:**
1. **Never** run `GET /v2/schedules` just to "check" a schedule.
2. After creating a schedule, the `scheduleId` from the `POST` response is all you need.
3. If you must read a schedule, **project away the header** and select only safe fields:
   ```bash
   curl -s "https://qstash.upstash.io/v2/schedules/<ID>" \
     -H "Authorization: Bearer $QSTASH_TOKEN" \
   | jq '{scheduleId, cron, destination, method, body, isPaused, nextScheduleTime}'
   ```
   (`jq` keeps only safe fields; `.header` is never emitted, so the token never hits
   stdout/logs.)

**If a token was already exposed:** treat the PAT as leaked →
(a) mint a new PAT; (b) **delete the old schedule(s) and recreate with the new token**
(QStash can't edit a stored header — delete + recreate only); (c) only after every
schedule is recreated, **revoke the old PAT on GitHub** (minting a new one does NOT
disable the old one).

**General rule:** treat any QStash schedule read-output as secret. Forward a
least-privilege fine-grained PAT (e.g. only the target repo's `Actions: write`) so a
leak has the smallest blast radius.
