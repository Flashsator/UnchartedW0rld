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
- Triggered on a schedule (Cloudflare Worker cron → GitHub Actions). **CI runs the
  code on `main`, so a change only affects real videos once pushed.**
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

## Config & env overrides

- **Script-generation model:** `src/scriptGen.ts` `CLAUDE_MODEL` (currently
  `claude-opus-4-8`). This is the live one; it's passed to `claude -p --model`.
- **Schedule:** `PUBLISH_WEEKDAYS_UTC = [1,3,5]`; `WEEKDAY_SERIES_MAP` = Mon→animals,
  Wed→insects, Fri→plants. Shorts: Mon/Wed → 1 short, Fri → 2.
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
