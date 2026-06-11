# Wild Anomalies — Daily Discovery-Style YouTube Automation

Fully autonomous pipeline that produces and uploads cinematic mini-documentaries about the strange biology of the living world. Pure Node/TypeScript, **Remotion** for video composition, runs on **GitHub Actions**. No paid render service.

> **Private repo.** Actions runs on the free private quota (2,000 Linux min/month). A full run is ~88 min on `ubuntu-latest`; at 3 runs/week (~13/month) usage is ~1,150–1,450 min/month, comfortably under quota.

## Publish schedule

Three videos per week on a **fixed weekday → topic** mapping. The run is *triggered*
at **13:00 UTC** (QStash cron), but each video is *scheduled to go public* at
**19:00 UTC** (`PUBLISH_HOUR_UTC`) — the US-afternoon slot (≈3pm ET / 12pm PT in
summer), fixed in UTC by design so no daylight-saving handling is needed. The
same-day teaser Short is staggered to **21:00 UTC** (`PUBLISH_HOUR_UTC + 2`).
Taiwan time is UTC+8 (no DST), so the 19:00/21:00 UTC publish lands in the early
hours of the **next** Taiwan day (03:00 / 05:00).

| 發片日 | 主題 | Series | 觸發 UTC / 台灣 | 發片 UTC / 台灣 |
|---|---|---|---|---|
| 週一 (Mon) | 動物 Animals | Beast Codex (`animals`) | 13:00 / 21:00 | 19:00 / 03:00 (隔天) |
| 週三 (Wed) | 昆蟲 Insects | Tiny Titans (`insects`) | 13:00 / 21:00 | 19:00 / 03:00 (隔天) |
| 週五 (Fri) | 植物 Plants | Rooted Anomalies (`plants`) | 13:00 / 21:00 | 19:00 / 03:00 (隔天) |

Each long-video run also produces **Shorts**, all derived from that day's episode. It publishes a **same-day teaser** (the cold-open hook, section 0, staggered to 21:00 UTC so it funnels viewers into the fresh long video) **plus** later-section Shorts dripped onto the off-days. The off-day Shorts go out at the normal 19:00 UTC slot. Net result: **every day of the week gets exactly one Short**, and no two Shorts from the same episode reuse a section:

Short 發片日 below is the **UTC** day; in Taiwan (UTC+8) each lands in the early hours of the next morning.

| Short 發片日 (UTC) | 來源 episode | 段落 section | 發片 UTC | 台灣時間 |
|---|---|---|---|---|
| 週一 (Mon) | 週一 動物 Animals | 0 (teaser) | 21:00 | 05:00 (週二) |
| 週二 (Tue) | 週一 動物 Animals | 3 | 19:00 | 03:00 (週三) |
| 週三 (Wed) | 週三 昆蟲 Insects | 0 (teaser) | 21:00 | 05:00 (週四) |
| 週四 (Thu) | 週三 昆蟲 Insects | 3 | 19:00 | 03:00 (週五) |
| 週五 (Fri) | 週五 植物 Plants | 0 (teaser) | 21:00 | 05:00 (週六) |
| 週六 (Sat) | 週五 植物 Plants | 3 | 19:00 | 03:00 (週日) |
| 週日 (Sun) | 週五 植物 Plants | 5 | 19:00 | 03:00 (週一) |

So Mon/Wed each yield 2 Shorts (teaser + next off-day) and Fri yields 3 (teaser + Sat + Sun) — **7 Shorts/week** from the 3 long episodes.

The schedule is fired by an **Upstash QStash schedule** (cron `0 13 * * 1,3,5` UTC), which POSTs a `workflow_dispatch` to `daily.yml` via the GitHub REST API. This is the **sole** trigger — the old Cloudflare Worker and GitHub native `schedule:` cron were both retired (see `docs/scheduling-troubleshooting.md`). Manual fallback: `gh workflow run "Daily video" --ref main`.

## Series

The channel is narrowed to the **living-world trio**, one topic per publish day (`WEEKDAY_SERIES_MAP` / `seriesForToday()` in `src/config.ts`):

| Series | Domain | Key | Active |
|---|---|---|---|
| Beast Codex | Animals | `animals` | ✅ Mon |
| Tiny Titans | Insects & micro life | `insects` | ✅ Wed |
| Rooted Anomalies | Carnivorous / parasitic / chemical-warfare plants | `plants` | ✅ Fri |
| Wild Earth Files | Nature & ecosystems | `nature` | — kept, inactive |
| Abyss Unknown | Deep sea | `ocean` | — kept, inactive |
| Cosmic Anomalies | Space & physics | `cosmos` | — kept, inactive |
| The Human Machine | Human body | `body` | — kept, inactive |
| Lost & Forgotten | History mysteries | `history` | — kept, inactive |

Inactive series stay defined in `SERIES_POOL` but are excluded via `ACTIVE_SERIES_KEYS` — re-broaden by adding keys + `WEEKDAY_SERIES_MAP` entries. A manual `SERIES_KEY=<key>` override can still pin **any** defined series for a one-off run (escape hatch for trending topics).

## Pipeline

```
Claude Code CLI (Opus)      script JSON
  ↓
Azure Speech (neural)       per-section MP3 + word boundaries
  ↓
Pexels + Pixabay            b-roll MP4 per section
  (gap-fill: Wikimedia Commons CC still → Unsplash, only if providers fall short)
Local library (yt_music)    BGM + ambient breather audio (royalty-free, offline)
  ↓
Remotion (headless Chrome)  silent MP4 (intro / sections / breather / outro)
  ↓
ffmpeg                      mux narration + BGM (lowered volume) + ambient + limiter
  ↓
FLUX.2 [klein] + sharp      1280×720 thumbnail with title overlay (Unsplash fallback)
  ↓
YouTube Data API            scheduled publish (private + publishAt)
```

## One-time setup

### 1. API keys

| Service | Used for | Where to get |
|---|---|---|
| Claude Code | Script generation (headless `claude -p`) | `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN` (uses your Claude subscription, no API billing) |
| Azure Speech | Narration TTS (neural, free F0 tier) | https://portal.azure.com → Speech resource |
| Pexels | Video b-roll | https://www.pexels.com/api/ |
| Pixabay | Video b-roll | https://pixabay.com/api/docs/ |
| Cloudflare Workers AI | FLUX.2 thumbnails | https://dash.cloudflare.com → Workers AI |
| Unsplash | Still-photo b-roll fallback (optional) | https://unsplash.com/developers |
| Wikimedia Commons | Last-resort b-roll gap-fill (keyless, no signup) | https://commons.wikimedia.org/w/api.php |

BGM and ambient audio come solely from official **YouTube Audio Library** tracks committed under `assets/yt_music/` (the one music source YouTube does not Content-ID-claim, so videos keep monetization). Tracks listed in `assets/music_blacklist.txt` are never reused. BGM volume is set via `BGM_VOLUME` in `src/config.ts`.

**B-roll gap-fill (Wikimedia Commons).** Episode subjects are pinned to common, widely-filmed creatures so the stock providers reliably return on-topic footage. As a last-resort safety net, if Pexels/Pixabay/Coverr **and** Unsplash all come up short for a shot (typically an unusually obscure subject), the pipeline pulls a still from **Wikimedia Commons**, which title-matches the actual species and returns a real photo instead of letting the providers fuzzy-match into generic unrelated scenery. It accepts **permissive licenses only** (CC0 / public domain / plain CC BY — never share-alike, non-commercial, or no-derivatives), and every Commons photo used is credited per-image (author + license) in the video description. For common subjects the providers already fill the quota, so this never fires.

### 2. YouTube OAuth

1. Google Cloud Console → enable **YouTube Data API v3**
2. Credentials → **OAuth client ID → Desktop app** → copy `client_id` + `client_secret` into `.env`
3. Run `npx tsx scripts/bootstrap_youtube_token.ts`, sign in to the channel, paste the printed `YT_REFRESH_TOKEN=...` into `.env`.

### 3. Local dependencies

```sh
npm install
```

Needs `ffmpeg` on PATH. Remotion downloads Chromium on first use (`npx remotion browser ensure`).

### 4. Configure `.env`

Copy `.env.example` to `.env` and fill in every value. Never commit `.env`.

## Run

```sh
DRY_RUN=1 npm run run          # local dry-run, no upload
npm run run                    # full run, uploads as scheduled-private
WEEKDAY=5 DRY_RUN=1 npm run run # force a specific weekday's series (Fri = plants)
SERIES_KEY=cosmos npm run run  # force any series (override the weekday map)
npm run studio                 # open Remotion Studio to iterate on visuals
```

## Cloud automation

- Schedule is driven by an **Upstash QStash schedule** (cron `0 13 * * 1,3,5`), which dispatches `daily.yml` via a fine-grained GitHub PAT (Actions-only write, scoped to this repo), forwarded in the `Upstash-Forward-Authorization` header. See `docs/scheduling-troubleshooting.md` for setup and the schedule-read token-leak hazard.
- `daily.yml` (`timeout-minutes: 240`, `runs-on: ubuntu-latest`) installs ffmpeg, Chromium, fonts, and Remotion, then runs the pipeline end-to-end. Can also be triggered manually from the Actions tab.

## Growth automations (opt-in, all best-effort/non-fatal)

Each is gated by an env flag (set to `'1'` in `daily.yml`, OFF by default locally) and wrapped in try/catch so a failure never blocks an upload:

| Flag | What it does | Module |
|---|---|---|
| `ENABLE_ANALYTICS_FEEDBACK` | Ranks past videos by CTR/retention/views; feeds the top title into the outro "Watch next" card + title-generation hints | `src/analytics.ts` |
| `ENABLE_TOPIC_VALIDATION` | Before script-gen, proposes candidate angles and scores each against real YouTube search results (median views of top hits); the proven winner steers the episode topic | `src/topicResearch.ts` |
| `ENABLE_AUTO_COMMENT` | End of each run, posts one engagement comment (a reply-bait question) under each recently-public video without one — today's upload gets its comment on the *next* run, once live | `src/engage.ts` |
| `ENABLE_CTR_RESCUE` | Finds at most ONE long-form video (2–21 days old, ≥300 impressions) whose CTR is <70% of the channel median, regenerates its thumbnail with a fresh layout, and swaps it in. Each video is rescued at most once | `src/ctrRescue.ts` |

Auto-comment and CTR-rescue persist their "already done" sets in `work/.commented-videos` / `work/.ctr-rescued`, cached across ephemeral CI runners via the `rotation-state-` cache in `daily.yml` — any new state file must be added to that cache's `path:` list.

Shorts are cut **loop-friendly**: the composition ends exactly where the narration ends (`OUTRO_SEC = 0`, no end card), so the Short restarts mid-curiosity — replay rate is a Shorts ranking signal. The long-video funnel lives in the description's `▶ Full video:` link. Long-form metadata is also localized (title + blurb) into **es/pt/hi/id/fr/de/ja** as discovery metadata; the channel stays English-primary.

## Repo layout

```
src/             pipeline modules (one per stage)
  config.ts      series pool, weekday map, footer, BGM volume
  scriptGen.ts   Claude Code CLI (headless claude -p, model pinned via CLAUDE_MODEL)
  tts.ts         Azure Speech neural TTS
  stock.ts       Pexels / Pixabay b-roll + local royalty-free BGM
  thumbnail.ts   Cloudflare FLUX.2 [klein] + sharp (Unsplash fallback)
  render.ts      Remotion bundle + renderMedia
  mux.ts         ffmpeg audio mux + SRT
  youtube.ts     googleapis upload
  analytics.ts   top-performer feedback loop (opt-in)
  topicResearch.ts  topic demand validation vs YouTube search (opt-in)
  engage.ts      auto engagement comments on recent videos (opt-in)
  ctrRescue.ts   underperforming-thumbnail rescue loop (opt-in)
  pipeline.ts    orchestrator (entry point)
remotion/        composition + scenes (Intro / SectionScene / AmbientBreather / Outro)
scripts/         bootstrap_youtube_token.ts
.github/workflows/daily.yml   (triggered by an Upstash QStash schedule)
```

## License

Personal project. Third-party media retains its original license (Pexels and Pixabay video terms apply). Any Wikimedia Commons stills used as gap-fill are permissive-licensed (CC0 / public domain / plain CC BY) and credited per-image (author + license) in the video description. Music is from the YouTube Audio Library bundled in `assets/yt_music/`; "Attribution required" tracks must be credited in the video description.
