# Wild Anomalies — Daily Discovery-Style YouTube Automation

Fully autonomous pipeline that produces and uploads cinematic mini-documentaries about the strange biology of the living world. Pure Node/TypeScript, **Remotion** for video composition, runs on **GitHub Actions**. No paid render service.

> **Private repo.** Actions runs on the free private quota (2,000 Linux min/month). A full run is ~88 min on `ubuntu-latest`; at 3 runs/week (~13/month) usage is ~1,150–1,450 min/month, comfortably under quota.

## Publish schedule

Three videos per week on a **fixed weekday → topic** mapping. The run is *triggered*
at **13:00 UTC** (QStash cron), but each video is *scheduled to go public* at
**19:00 UTC** (`PUBLISH_HOUR_UTC`) — the US-afternoon slot (≈3pm ET / 12pm PT in
summer), fixed in UTC by design so no daylight-saving handling is needed. The
same-day teaser Short is staggered to **21:00 UTC** (`PUBLISH_HOUR_UTC + 2`).

| 發片日 | 主題 | Series | 觸發 (trigger) UTC | 發片 (publish) UTC |
|---|---|---|---|---|
| 週一 (Mon) | 動物 Animals | Beast Codex (`animals`) | 13:00 | 19:00 |
| 週三 (Wed) | 昆蟲 Insects | Tiny Titans (`insects`) | 13:00 | 19:00 |
| 週五 (Fri) | 植物 Plants | Rooted Anomalies (`plants`) | 13:00 | 19:00 |

Each long-video run also produces **Shorts**, all derived from that day's episode. It publishes a **same-day teaser** (the cold-open hook section, staggered ~2h after the long video so it funnels viewers into the fresh upload) **plus** later-section Shorts dripped onto the off-days, so **every day of the week gets a Short** and no two reuse the same section: 週一→週一+週二, 週三→週三+週四, 週五→週五+週六+週日 (週六/週日 both come from Friday's plants episode).

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

BGM and ambient audio come solely from official **YouTube Audio Library** tracks committed under `assets/yt_music/` (the one music source YouTube does not Content-ID-claim, so videos keep monetization). Tracks listed in `assets/music_blacklist.txt` are never reused. BGM volume is set via `BGM_VOLUME` in `src/config.ts`.

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
  pipeline.ts    orchestrator (entry point)
remotion/        composition + scenes (Intro / SectionScene / AmbientBreather / Outro)
scripts/         bootstrap_youtube_token.ts
.github/workflows/daily.yml   (triggered by an Upstash QStash schedule)
```

## License

Personal project. Third-party media retains its original license (Pexels and Pixabay video terms apply). Music is from the YouTube Audio Library bundled in `assets/yt_music/`; "Attribution required" tracks must be credited in the video description.
