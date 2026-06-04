# Wild Anomalies — Daily Discovery-Style YouTube Automation

Fully autonomous pipeline that produces and uploads cinematic mini-documentaries about the strange biology of the living world. Pure Node/TypeScript, **Remotion** for video composition, runs on **GitHub Actions**. No paid render service.

> **Private repo.** Actions runs on the free private quota (2,000 Linux min/month). A full run is ~88 min on `ubuntu-latest`; at 3 runs/week (~13/month) usage is ~1,150–1,450 min/month, comfortably under quota.

## Publish schedule

Three videos per week on a **fixed weekday → topic** mapping, anchored to **Taiwan time (UTC+8, no DST)**.

| 發片日 | 主題 | Series | 台灣時間 | UTC |
|---|---|---|---|---|
| 週一 (Mon) | 動物 Animals | Beast Codex (`animals`) | 21:00 | 13:00 |
| 週三 (Wed) | 昆蟲 Insects | Tiny Titans (`insects`) | 21:00 | 13:00 |
| 週六 (Sat) | 植物 Plants | Rooted Anomalies (`plants`) | 21:00 | 13:00 |

The schedule is fired by a **Cloudflare Worker cron** (`0 13 * * 1,3,6` UTC), which dispatches `daily.yml` via the GitHub REST API — more reliable than GitHub's own `schedule:` cron. See `cloudflare-trigger/`.

## Series

The channel is narrowed to the **living-world trio**, one topic per publish day (`WEEKDAY_SERIES_MAP` / `seriesForToday()` in `src/config.ts`):

| Series | Domain | Key | Active |
|---|---|---|---|
| Beast Codex | Animals | `animals` | ✅ Mon |
| Tiny Titans | Insects & micro life | `insects` | ✅ Wed |
| Rooted Anomalies | Carnivorous / parasitic / chemical-warfare plants | `plants` | ✅ Sat |
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
WEEKDAY=6 DRY_RUN=1 npm run run # force a specific weekday's series (Sat = plants)
SERIES_KEY=cosmos npm run run  # force any series (override the weekday map)
npm run studio                 # open Remotion Studio to iterate on visuals
```

## Cloud automation

- Schedule is driven by the **Cloudflare Worker** in `cloudflare-trigger/` (cron `0 13 * * 1,3,6`), which dispatches `daily.yml` via a fine-grained GitHub PAT (Actions-only write, scoped to this repo). The PAT lives only in Cloudflare's encrypted secret store.
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
cloudflare-trigger/  scheduled dispatch Worker
.github/workflows/daily.yml
```

## License

Personal project. Third-party media retains its original license (Pexels and Pixabay video terms apply). Music is from the YouTube Audio Library bundled in `assets/yt_music/`; "Attribution required" tracks must be credited in the video description.
