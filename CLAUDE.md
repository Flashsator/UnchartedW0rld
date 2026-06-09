# CLAUDE.md

Guidance for Claude Code (and any sub-agent) working in this repo. Read this
before making changes — it captures invariants that are NOT obvious from the
code and that, if broken, ship a bad video to a live channel.

## What this is

**Wild Anomalies** — a fully-autonomous daily YouTube channel. One Node/TypeScript
pipeline writes a science mini-documentary script, narrates it (Azure neural TTS),
pulls stock b-roll, renders with Remotion (headless Chrome), muxes audio with
ffmpeg, generates a thumbnail (FLUX), and uploads to YouTube. No human in the loop.

- Pure Node/TS + React/Remotion. No framework backend.
- Triggered on a schedule (Upstash QStash → `workflow_dispatch` → GitHub Actions;
  the old Cloudflare Worker trigger is retired/removed). **CI runs the code on
  `main`, so a change only affects real videos once pushed.**
- Repo path is `UnchartedW0rld` (the trigger depends on it); the *channel* is
  "Wild Anomalies". Don't rename the repo.

## Commands

```bash
npm run run      # run the full pipeline (tsx src/pipeline.ts)
npm test         # node:test unit tests (test/*.test.ts, listed explicitly in package.json)
npm run tsc      # typecheck (tsc --noEmit) — must stay clean
npm run render   # Remotion render only
npm run studio   # Remotion studio (visual preview of compositions)
```

Local end-to-end check without publishing (PowerShell):

```powershell
$env:DRY_RUN=1; npm run run     # runs script→TTS→b-roll→render→mux→thumbnail, SKIPS upload only
```

After adding a `test/*.test.ts` file, add it to the `test` script in `package.json`
— the Node 20 test runner does NOT glob.

A fast CI gate (`.github/workflows/ci.yml`) runs `npm run tsc` + `npm test` on
every code push/PR to `main` (doc-only changes are skipped via `paths-ignore`).
It's the safety net that catches a broken push *before* the 13:00 UTC daily run
ships it — so keep `tsc` clean and tests green, or the gate (and the next video)
goes red. No custom failure-email step lives in `daily.yml`: GitHub's built-in
Actions failure notification to the triggering account already covers a failed
run; neither catches a *total* QStash non-trigger (that needs a separate
heartbeat monitor).

## Invariants — do not break these

1. **No fabricated data (science channel).** An on-screen overlay (`stat`/`label`/
   `compare`) may only surface a number/date/name that is *actually spoken in that
   section's narration*. The sanitizer in `src/scriptGen.ts` enforces it
   (`spokenNumbers`, `sanitizeOverlay`). Never relax this to "fill a bar".
2. **Claim-safe audio only.** BGM is drawn ONLY from the committed YouTube Audio
   Library tracks under `assets/yt_music/` (the one source YouTube doesn't
   Content-ID-claim). Interlude beds come from `assets/ambient_nature/`; white
   noise is ffmpeg-synthesized, never a random downloaded nature mp3. Tracks in
   `assets/music_blacklist.txt` (claimed on a past video) are never reused.
3. **On-topic visuals.** Every b-roll query is anchored to the episode `subject`
   (`anchorVisual` in `scriptGen.ts`); per-section ordered shot beats (`visuals[]`)
   make footage track the narration. Keep both intact when touching the b-roll path.
4. **Length is mandatory.** Scripts target ~`TARGET_MINUTES` (9.5–10 min) so the
   final cut clears 8:00 for YouTube mid-roll ads. There's a word-count floor in
   the script prompt; don't lower it.
5. **Audio mix is already pro-grade** (`src/mux.ts`): narration sidechain-ducks
   BGM, output is loudnorm'd to −14 LUFS with a limiter. Don't "fix" loudness.
6. **`.env` holds real API keys — never commit it.**

## Pipeline shape (`src/pipeline.ts`, 8 steps)

scriptGen → TTS → b-roll fetch → BGM + ambient interludes → build render manifest
→ Remotion render → ffmpeg mux → thumbnail → YouTube upload. `DRY_RUN=1` skips
only the upload.

Key modules: `scriptGen.ts` (Claude CLI), `tts.ts` (Azure), `stock.ts` (Pexels/
Pixabay/Coverr/Unsplash + BGM picking), `render.ts`/`remotion/` (compositions),
`mux.ts` (ffmpeg audio + SRT + chapters), `thumbnail.ts` (FLUX), `youtube.ts`.

After the long-form upload, `youtube.ts` runs three **best-effort, non-fatal**
enrichments (each wrapped in try/catch so a failure never blocks a successful
upload): `addToSeriesPlaylist` (shelves the video on its series-name playlist,
creating it public if absent), `uploadCaption` (uploads the burned-in SRT as a
real selectable caption track via `captions.insert` — **needs the
`youtube.force-ssl` OAuth scope**; the live `YT_REFRESH_TOKEN` was re-minted with
it on 2026-06-08, so this works — if it ever 403s again, the token lost the scope),
and localized title/description metadata (`translateMetadata` in `scriptGen.ts`
reuses the script-gen Claude CLI to translate the title + prose blurb into
es/pt/hi/id; passed as `videos.insert` `localizations`). The channel stays
**English-primary** (`defaultLanguage: 'en'`, base snippet + audio + burned-in
on-screen text unchanged) — localization is discovery metadata only.

## Config & env overrides

- **Script-generation model:** `src/scriptGen.ts` `CLAUDE_MODEL` (currently
  `claude-opus-4-8`). This is the live one; it's passed to `claude -p --model`.
- **Analytics feedback loop:** `ENABLE_ANALYTICS_FEEDBACK` (set to `'1'` in
  `daily.yml`, default OFF locally). When on, `fetchTopPerformingTitles` ranks past
  videos by CTR/retention/views and feeds `winningTitles[0]` into the Outro "Watch
  next" end card + title-generation hints. Best-effort/non-fatal: needs the
  `yt-analytics.readonly` scope on `YT_REFRESH_TOKEN` (granted 2026-06-08) AND real
  analytics data over `ANALYTICS_LOOKBACK_DAYS` (90). Until the young channel
  accrues data the ranking is empty, so the Outro falls back to the plain subscribe
  CTA — that's expected, not a bug. The token carries four scopes:
  `youtube.upload`, `youtube`, `youtube.force-ssl`, `yt-analytics.readonly`
  (`scripts/bootstrap_youtube_token.ts` requests all four; re-mint there to change).
- **Schedule:** `PUBLISH_WEEKDAYS_UTC = [1,3,5]`; `WEEKDAY_SERIES_MAP` = Mon→animals,
  Wed→insects, Fri→plants. The run is *triggered* at 13:00 UTC but each long video
  is *scheduled public* at `PUBLISH_HOUR_UTC` = **19:00 UTC** (the US-afternoon
  slot ≈3pm ET / 12pm PT; = 03:00 next-day Taiwan). Don't confuse the 13:00 UTC
  trigger with the publish time. Shorts (`planShortsForToday` in `src/shortsGen.ts`):
  every long-video run emits a **same-day teaser** (section 0 = cold-open hook,
  staggered to `PUBLISH_HOUR_UTC + 2` ≈ 21:00 UTC so it funnels into the
  just-dropped long video) **plus** later-section shorts dripped onto the
  off-days, so every weekday gets one and no two reuse a section: Mon/Wed → 2
  shorts (same-day + next-day), Fri → 3 (same-day + Sat + Sun).
- **Shorts → long-video funnel:** the only *automated* link from a Short to its
  long video is the `▶ Full video:` URL line in the Short's description
  (`shortsDescription` in `src/youtube.ts`). YouTube's native **Related-video
  card** (the in-player long-video link on a Short) is **Studio-only — the Data
  API exposes no field for it**, so it's intentionally NOT automated; binding it
  is a manual Studio action the human can do if/when they want (must wait until
  the long video is actually public). Likewise the **"altered/synthetic content"
  disclosure** toggle is Studio-only and left to human judgment — don't try to
  set either via the API.
- **Trigger:** an **Upstash QStash** schedule (cron `0 13 * * 1,3,5` UTC) POSTs a
  `workflow_dispatch` to `daily.yml` — the **sole** trigger. The old Cloudflare
  Worker (`cloudflare-trigger/`) and GitHub `schedule:` cron are retired/removed; the
  CF Worker still needs decommissioning on Cloudflare's side. (Cloudflare Workers AI
  for FLUX.2 thumbnails is a separate product, still in use.) Manual fallback:
  `gh workflow run "Daily video" --ref main`. Setup + the
  `GET /v2/schedules` token-leak hazard live in `docs/scheduling-troubleshooting.md`.
- **Day numbering** uses `new Date().getUTCDay()` (0=Sun … 6=Sat).
- **Override env vars** (handy for local testing): `DRY_RUN`, `WEEKDAY=N`,
  `SHORTS_PLAN_WEEKDAY=N`, `SERIES_KEY`, `SUB_THEME`, `STRUCTURE_KEY`, `TONE_KEY`,
  `VOICE_ID`, `SECTION_COUNT`, `TARGET_MINUTES`, `FORCE_RUN`, `TEST_MODE`,
  `FLUX_STEPS`, `REMOTION_CONCURRENCY`.

## Conventions

- Commit format: `<type>: <description>` (feat/fix/refactor/docs/test/chore/perf/ci).
- **Attribution is disabled globally — do NOT add `Co-Authored-By` trailers.**
- Commit when the work is done; **push only when the user asks** (but note: the
  pipeline only uses pushed code, so unpushed work won't affect the next run).
- Style: small focused files, immutable updates, explicit error handling, no
  hardcoded secrets. `tsc` clean + tests green before pushing.
