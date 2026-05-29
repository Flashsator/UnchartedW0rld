# UnchartedW0rld — Daily Discovery-Style YouTube Automation

Fully autonomous pipeline that produces and uploads one 10–12 minute Discovery-style mini-documentary every day. Pure Node/TypeScript, **Remotion** for video composition, runs on **GitHub Actions** (free tier). No paid render service.

## Weekly series

| Day | Series | Domain |
|---|---|---|
| Mon | Wild Earth Files | Nature & ecosystems |
| Tue | Tiny Titans | Insects & micro life |
| Wed | Cosmic Anomalies | Space & physics |
| Thu | Abyss Unknown | Deep sea |
| Fri | Beast Codex | Animals |
| Sat | The Human Machine | Human body |
| Sun | Lost & Forgotten | History mysteries |

## Pipeline

```
Anthropic SDK (Sonnet)      script JSON
  ↓
msedge-tts                  per-section MP3 + word/sentence boundaries
  ↓
Pexels + Pixabay            b-roll MP4 per section
Freesound                   BGM + ambient breather audio
  ↓
Remotion (headless Chrome)  silent MP4 (intro / sections / breather / outro)
  ↓
ffmpeg                      mux narration + BGM ducking + ambient + limiter
  ↓
Pollinations + sharp        1280×720 thumbnail with title overlay
  ↓
YouTube Data API            scheduled publish (private + publishAt)
```

## One-time setup

### 1. API keys (all free tier)

| Service | Used for | Where to get |
|---|---|---|
| Anthropic | Script generation | https://console.anthropic.com |
| Pexels | Video b-roll | https://www.pexels.com/api/ |
| Pixabay | Video b-roll (fallback) | https://pixabay.com/api/docs/ |
| Freesound | BGM + ambient | https://freesound.org/help/developers/ |

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
3. The workflow `.github/workflows/daily.yml` runs at **13:00 UTC** every day. You can also trigger it manually from the Actions tab.

The runner installs ffmpeg, Chromium, fonts, and Remotion, then runs the pipeline end-to-end (~15–25 min for a 10–12 min video on the standard 2-vCPU runner).

## Repo layout

```
src/             pipeline modules (one per stage)
  scriptGen.ts   Anthropic SDK
  tts.ts         msedge-tts
  stock.ts       Pexels / Pixabay / Freesound
  thumbnail.ts   Pollinations + sharp
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
| Pexels / Pixabay / Freesound / msedge-tts / Pollinations | $0 |
| YouTube API | $0 (well within quota) |
| GitHub Actions on a public repo | $0 |
| Anthropic API (~1 script/day, ~30k tokens) | ~$3–6 |

## License

Personal project. Third-party media retains its original license (Pexels, Pixabay, Freesound terms apply).
