# UnchartedW0rld — Daily Discovery-Style YouTube Automation

Fully autonomous pipeline that produces and uploads one 10–12 minute Discovery-style mini-documentary every day. Pure Node/TypeScript, **Remotion** for video composition, runs on **GitHub Actions** (free tier). No paid render service.

## Publish schedule

Three videos per week, on **Mon / Wed / Sat**. Times are anchored to **Taiwan time (UTC+8, no DST)**.

| 發片日 | 台灣時間 (UTC+8) | UTC |
|---|---|---|
| 週一 | **21:23** | 13:23 |
| 週三 | **21:23** | 13:23 |
| 週六 | **21:23** | 13:23 |

> 觸發時間為 GitHub Actions 排程時間，尖峰時段仍可能被延遲數十分鐘（屬 GitHub 正常行為，非保證準點）。

cron: `23 13 * * 1,3,6` (in `.github/workflows/daily.yml`). The `:23` minute is intentional — GitHub delays scheduled jobs that fire on the hour, so an off-peak minute dispatches sooner.

## Series pool

Series are **not** pinned to a weekday. Each ISO week the pool below is deterministically weighted-shuffled (`seriesForToday` in `src/config.ts`); the three publish slots get three **distinct** series, so no series repeats within a week. Higher-weight series surface more often. A trending-event override (`SERIES_KEY`) can pin a specific series for a manual run.

| Series | Domain | Key | Weight |
|---|---|---|---|
| Wild Earth Files | Nature & ecosystems | `nature` | 1.5 |
| Beast Codex | Animals | `animals` | 1.4 |
| Abyss Unknown | Deep sea | `ocean` | 1.3 |
| Cosmic Anomalies | Space & physics | `cosmos` | 1.0 |
| Tiny Titans | Insects & micro life | `insects` | 0.9 |
| The Human Machine | Human body | `body` | 0.7 |
| Lost & Forgotten | History mysteries | `history` | 0.7 |

## Pipeline

```
Claude Code CLI (Opus)      script JSON
  ↓
Azure Speech (neural)       per-section MP3 + word boundaries
  ↓
Pexels + Pixabay            b-roll MP4 per section
Local library (Pixabay)     BGM + ambient breather audio (royalty-free, offline)
  ↓
Remotion (headless Chrome)  silent MP4 (intro / sections / breather / outro)
  ↓
ffmpeg                      mux narration + BGM ducking + ambient + limiter
  ↓
FLUX.2 [klein] + sharp      1280×720 thumbnail with title overlay (Unsplash fallback)
  ↓
YouTube Data API            scheduled publish (private + publishAt)
```

## One-time setup

### 1. API keys (all free tier)

| Service | Used for | Where to get |
|---|---|---|
| Claude Code | Script generation (headless `claude -p`) | Run `claude setup-token` → set `CLAUDE_CODE_OAUTH_TOKEN` (uses your Claude subscription, no API billing) |
| Azure Speech | Narration TTS (neural, free F0 tier) | https://portal.azure.com → Speech resource |
| Pexels | Video b-roll | https://www.pexels.com/api/ |
| Pixabay | Video b-roll | https://pixabay.com/api/docs/ |
| Coverr | Video b-roll (optional) | https://coverr.co/ |
| Unsplash | Still-photo b-roll fallback (optional) | https://unsplash.com/developers |

BGM and ambient audio come solely from official **YouTube Audio Library** tracks
committed under `assets/yt_music/` (downloaded manually from YouTube Studio).
This is the one music source YouTube does not Content-ID-claim, so videos keep
their monetization. Pixabay *music* was removed because distributors (e.g. We
Are Era Music BV) register those tracks in Content ID and claim the revenue.
Tracks listed in `assets/music_blacklist.txt` are never reused. See
`assets/yt_music/README.md` for how to add tracks.

### 2. YouTube OAuth

1. Google Cloud Console → enable **YouTube Data API v3**
2. Credentials → **OAuth client ID → Desktop app** → copy `client_id` + `client_secret` into `.env`
3. Locally run:
   ```sh
   npx tsx scripts/bootstrap_youtube_token.ts
   ```
4. Sign in to the channel you want to publish to. The script prints `YT_REFRESH_TOKEN=...` — paste into `.env`.

### 3. Local dependencies

```sh
npm install
```

You also need `ffmpeg` on PATH. Remotion will download Chromium on first use (`npx remotion browser ensure`).

### 4. Configure `.env`

Copy `.env.example` to `.env` and fill in every value. Never commit `.env`.

## Run

Local dry-run (no upload):

```sh
DRY_RUN=1 npm run run
```

Local full run (uploads to YouTube as scheduled-private):

```sh
npm run run
```

Override the day's series:

```sh
WEEKDAY=2 DRY_RUN=1 npm run run    # Cosmic Anomalies
```

Open Remotion Studio to iterate on visuals:

```sh
npm run studio
```

## Cloud automation (GitHub Actions)

1. Push to a **public** GitHub repo (Actions has unlimited minutes for public repos).
2. Settings → Secrets and variables → Actions → New repository secret. Add every key from `.env.example` (no quotes).
3. The workflow `.github/workflows/daily.yml` publishes on the fixed schedule above — **Mon / Wed / Sat at 21:23 Taiwan time** (`23 13 * * 1,3,6`). You can also trigger it manually from the Actions tab.

The runner installs ffmpeg, Chromium, fonts, and Remotion, then runs the pipeline end-to-end (~15–25 min for a 10–12 min video on the standard 2-vCPU runner).

## Repo layout

```
src/             pipeline modules (one per stage)
  scriptGen.ts   Claude Code CLI (headless claude -p, model pinned via CLAUDE_MODEL)
  tts.ts         Azure Speech neural TTS
  stock.ts       Pexels / Pixabay b-roll + local royalty-free BGM
  thumbnail.ts   Cloudflare FLUX.2 [klein] + sharp (Unsplash fallback)
  render.ts      Remotion bundle + renderMedia
  mux.ts         ffmpeg audio mux + SRT
  youtube.ts     googleapis upload
  pipeline.ts    orchestrator (entry point)
remotion/
  index.ts       registerRoot
  Root.tsx       composition registration
  MainVideo.tsx  sequence layout
  scenes/        Intro / SectionScene / AmbientBreather / Outro
scripts/
  bootstrap_youtube_token.ts
.github/workflows/daily.yml
```

## Costs

| Item | Monthly |
|---|---|
| Pexels / Pixabay / Coverr / Unsplash | $0 |
| Cloudflare Workers AI (FLUX.2 [klein], thumbnails) | $0 (~7 free img/day; ~3 used/wk) |
| Azure Speech (neural TTS, F0 free tier ~500k chars/mo) | $0 |
| YouTube API | $0 (well within quota) |
| GitHub Actions on a public repo | $0 |
| Claude Code (script generation) | $0 incremental — runs on your existing Claude subscription quota via `CLAUDE_CODE_OAUTH_TOKEN`, not API billing (~1 script/day) |

## License

Personal project. Third-party media retains its original license (Pexels and Pixabay video terms apply). Music is from the YouTube Audio Library bundled in `assets/yt_music/`; "Attribution required" tracks must be credited in the video description.
