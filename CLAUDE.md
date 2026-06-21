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

A separate **read-only** weekly workflow (`.github/workflows/funnel-report.yml`,
Mon 14:00 UTC + manual `workflow_dispatch`) runs `scripts/funnelReport.ts` to
track whether the Shorts→long-video funnel is improving over time. It ONLY reads
analytics (it never edits a video) and is fully isolated from `daily.yml`, so it
can't affect publishing. "Funnel views" = `EXT_URL + NO_LINK_OTHER` on long
videos (the description "Full video" link, approximately) vs `RELATED_VIDEO`
(algorithmic suggestions, not the funnel) — a rising funnel share means the
Short→long link is getting more visible (pinned comments / Studio related-video
cards). `scripts/` is outside the tsconfig `include`, so it's not in `npm run
tsc` or the pipeline; run it locally with `npx tsx scripts/funnelReport.ts`.
A sibling **read-only** workflow (`.github/workflows/shorts-hook-report.yml`,
Mon 14:30 UTC + manual `workflow_dispatch`) runs `scripts/shortsHookReport.ts` to
rank every Short (≤180s) over ~120 days by views alongside its title/hook,
retention, engagement, and subscribers gained — the feedback loop for tuning the
`shortsHook` prompt. Same isolation guarantees: analytics-only, never edits a
video, fully separate from `daily.yml`.

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
   The script prompt also **pins `subject` to a common, widely-filmed creature**
   that free stock libraries actually have (the STOCK-FOOTAGE RULE in the subject
   field + the "obscurity in the angle, not the animal" sub-topic rule). This is
   load-bearing for all three series: an obscure species (e.g. a `chough`) returns
   no stock video, and the providers fuzzy-match a no-result query into generic
   unrelated scenery (random landscapes), so the footage stops matching the
   narration. Keep the surprise in the *angle* (familiar animal, buried behavior —
   "how a cat laps water"), never in an unfilmable subject.
   As a **last-resort safety net** (not a strategy — obscure subjects still hurt
   views), if the video providers AND Unsplash come up short for a beat, the
   b-roll gap-fill falls back to a **Wikimedia Commons** still that title-matches
   the actual species (`searchCommons`/`parseCommonsResults` in `src/stock.ts`),
   so the footage stays on-subject instead of drifting to random scenery. Two
   guards are load-bearing here and must not be relaxed: it accepts **permissive
   licenses only** (CC0 / public domain / plain CC BY — never -SA/-NC/-ND or
   GFDL, since share-alike could force-license the whole monetized video;
   `isPermissiveLicense`), and every used photo carries a **per-image CC credit**
   (author + license) into the description's attribution block
   (`buildAttribution` in `src/attribution.ts`, fed by the `imageCredits`
   collector in `pipeline.ts`). For common subjects the providers already fill
   the quota, so this never fires.
   **Relevance beats resolution (user directive 2026-06-11).** Candidate clips
   are filtered/ranked by per-clip provider metadata against the beat query
   (`filterAndRankByRelevance` in `src/stock.ts`); resolution NEVER excludes a
   landscape clip — sub-720 renditions are still accepted
   (`pickBestVideoFile`'s last tier) and only demoted to the back of the
   relevance-ranked pool (`orderPoolByPreference`), same as too-short clips.
   Don't reintroduce a hard resolution cutoff on the landscape path: a soft
   on-subject clip beats a sharp off-subject one. The single exception is
   portrait Shorts b-roll, which keeps a 1280px hard floor because
   center-cropping a relevant 1080p landscape clip (the guaranteed fallback)
   is sharper than a soft portrait file.
   **Vision relevance gate (`ENABLE_BROLL_VISION_QA`, `'1'` in daily.yml, OFF
   locally).** The metadata filter only reads a provider's tags/slug, which are
   thin and sometimes wrong — so a clip can pass the text filter yet visually
   show the wrong thing (the mismatch viewers notice). When enabled, the PRIMARY
   downloaded clip of each long-form beat is vision-checked: `visionRejectsClip`
   in `src/brollVision.ts` samples one midpoint frame (ffmpeg) and asks the
   script-gen Claude CLI's vision (same plumbing as the thumbnail QA) whether it
   depicts the beat query; a clip judged *clearly* off-subject is dropped and the
   next candidate tried. **Best-effort/non-fatal and must stay so:** disabled,
   any infra error (no CLI, ffmpeg missing, timeout), or an ambiguous verdict all
   KEEP the clip, so it never starves a section below the metadata-only pipeline.
   It only DROPS on a clear FAIL (conservative prompt) and the per-beat check
   count is capped (`BROLL_VISION_QA_MAX_CHECKS`, shared across the beat's query
   variants); once one clip passes, the beat's remaining fills are trusted.
   Long-form (landscape) only — Shorts center-crop the already-verified long
   clips. Fetch-time only, no new state file. Pure parts (`visionVerdictIsFail`,
   `buildVisionPrompt`) unit-tested in `test/brollVision.test.ts`.
   **Explainer-card last resort (`ENABLE_BROLL_CARDS`, `'1'` in daily.yml, OFF
   locally).** Below even the Commons safety net, when a long-form shot slot's
   clip is *proven* off-subject — its provider metadata shares no token with the
   episode `subject`, tagged `onSubject === false` by `isClipOnSubject` in
   `src/stock.ts` — that one slot is replaced by a self-built, full-frame
   Remotion motion-graphic **explainer card** (`remotion/scenes/FactCard.tsx`)
   instead of shipping footage that contradicts the narration. The pure decider
   is `planShotCards` in `src/brollCards.ts` (unit-tested in
   `test/brollCards.test.ts`). It is deliberately conservative and must stay so:
   it cards a slot ONLY on `onSubject === false` (never `undefined` — no metadata
   to judge means leave the footage), at most `BROLL_CARD_MAX_PER_SECTION` (2)
   cards per section, never the cold-open slot 0, and bails the whole section to
   all-footage if MORE than `BROLL_CARD_OFFSUBJECT_RATIO` (0.5) of slots are
   off-subject (that's an unfilmable subject — an invariant #3 smell to fix
   upstream, not paper over with a wall of cards). **Invariant #1 extends to the
   card text:** it is lifted only from THAT section's narration in the slot's
   time window — a spoken figure makes a `stat` card (count-up), otherwise a
   verbatim clause makes a `fact` card; nothing is ever reworded or fabricated.
   The `fact` card RENDERS as a tiny **schematic** chosen by how many subjects the
   verbatim clause names (`collectCardIcons` in `src/iconDict.ts`, the pure
   layout decider): **2 distinct subject emoji → a relation diagram** (two ringed
   subject nodes + a connector that draws in + a travelling A→B pulse + arrowhead
   — for process beats like "the wasp paralyses the caterpillar"), **1 → a focal
   node** (emoji in an accent ring + concentric pulse rings), **0 → an editorial
   text card** (key word accented). The emoji are DECORATIVE only — they depict a
   subject the verbatim text already names and add no data (invariant #1 holds);
   the arrow follows narration order and asserts no new claim. `ICON_DICT` lists
   only faithful glyphs — a subject with no accurate emoji (wasp, moth) is
   deliberately ABSENT so the card degrades to the text layout, never a wrong
   creature. Note `ICON_DICT` is ALSO consumed by `src/iconExtractor.ts`
   (the always-on in-frame overlay-emoji path, independent of this gate), so
   broadening it affects live overlays too — but that path only fires when the
   matched word also appears in the section heading/visual context, so it can't
   fabricate. Long-form only (Shorts untouched); render-side, no new state file.
   This is a safety net, NOT a strategy — a real on-subject clip always wins; the
   goal is that a bad slot degrades to a clean designed card, never off-topic
   scenery.
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
es/pt/hi/id/fr/de/ja; passed as `videos.insert` `localizations`). The channel stays
**English-primary** (`defaultLanguage: 'en'`, base snippet + audio + burned-in
on-screen text unchanged) — localization is discovery metadata only.

After the Shorts pipeline, two more **opt-in housekeeping passes** run over PAST
uploads (env-gated, non-fatal, skipped on DRY_RUN via the early return):
`autoCommentOnRecentVideos` (`src/engage.ts`, `ENABLE_AUTO_COMMENT`) posts one
reply-bait engagement comment under each recently-public video that lacks ours —
comments can't be posted on private/scheduled videos, so today's upload gets its
comment on the NEXT run; and `rescueWorstPackaging` (`src/ctrRescue.ts`,
`ENABLE_CTR_RESCUE`) finds at most ONE long-form video (2–21 days old, ≥300
impressions) whose CTR is below 70% of the channel median and pulls ONE
packaging lever, **alternating across runs**: thumbnail (regenerated with a
CTR-weighted fresh layout, FLUX, swapped via `thumbnails.set`) or title
(rewritten by the script CLI under a same-claim-only rule — invariant #1
extends to packaging — swapped via `videos.update`; an unusable rewrite falls
back to the thumbnail lever so the run's one rescue isn't wasted). The state
file records `videoId<TAB>lever` so the log doubles as an A/B record of which
lever moves CTR. One rescue per run (FLUX free tier), one rescue per video
ever. A third pass, `auditRecentContent` (`src/contentAudit.ts`,
`ENABLE_CONTENT_AUDIT`), reads the channel's most recent uploads' packaging
(title / pre-fold hook / tags) and asks the script CLI to score them against the
views playbook and surface concrete fixes. Unlike the analytics loops it needs
NO accrued watch data, so it produces signal on a young channel from day one. It
is **purely advisory**: it appends a dated entry to `work/.content-audit.log`
and raises a non-failing GitHub Actions `::warning::` annotation on a regression
(score `< 5` or the model flags drift), but it **never edits a live video**
(that's `rescueWorstPackaging`'s job) and **never fails the run**. Their state
files (`work/.commented-videos`, `work/.ctr-rescued`, `work/.thumb-layout-log`,
`work/.content-audit.log`) ride the `rotation-state-` cache in `daily.yml` —
**any new state file must be added to that cache's `path:` list** or it
silently resets every run.

## Config & env overrides

- **Script-generation model:** `src/scriptGen.ts` `CLAUDE_MODEL` (currently
  `claude-opus-4-8`). This is the live one; it's passed to `claude -p --model`.
- **Thumbnail caption is one word (by design):** `src/thumbnail.ts` renders a
  single high-impact kicker word (`thumbnailWord`, else a word picked from the
  title) — NOT a phrase. It forms a curiosity-gap pair with the title and must
  not echo it. Every layout's font fitting is tuned for one short poster word;
  this is intentional, not a bug — don't "fix" it into a multi-word caption
  without reworking the layouts and mobile legibility.
- **Analytics feedback loop:** `ENABLE_ANALYTICS_FEEDBACK` (set to `'1'` in
  `daily.yml`, default OFF locally). When on, `fetchTopPerformers`
  (`src/analytics.ts`) ranks past videos by CTR/retention/views and the result
  drives FIVE consumers: `winningTitles[0]` into the Outro "Watch next" end
  card, title-generation shape hints, a soft flavor hint to the topic-candidate
  proposer, the description's "▶ Watch next:" cross-link block
  (`buildWatchNextBlock` — long-form links only, Shorts excluded, also spliced
  into localized descriptions), and the CTR-weighted thumbnail-layout draw
  (`pickThumbLayoutWeighted` in `src/thumbLayoutStats.ts` — every upload logs
  `videoId<TAB>layout` to `work/.thumb-layout-log`; once ≥`THUMB_LAYOUT_MIN_SAMPLES`
  videos per layout have measured CTR, layout selection shifts from blind
  no-repeat rotation to a CTR-weighted draw that still explores every layout).
  The same flag gates the **retention feedback loop** (`src/retention.ts`):
  `fetchRetentionDirective` samples recent long-form `audienceWatchRatio` curves,
  measures early-exit % and the steepest mid-video drop, and hands
  `generateEpisode` a measured pacing directive (shapes pacing only — never
  facts). Best-effort/non-fatal: needs the `yt-analytics.readonly` scope on
  `YT_REFRESH_TOKEN` (granted 2026-06-08) AND real analytics data over
  `ANALYTICS_LOOKBACK_DAYS` (90). Until the young channel accrues data every
  consumer quietly degrades to its pre-feedback behavior (plain subscribe CTA,
  no hints, no watch-next block, blind rotation, no directive) — that's
  expected, not a bug. The token carries four scopes: `youtube.upload`,
  `youtube`, `youtube.force-ssl`, `yt-analytics.readonly`
  (`scripts/bootstrap_youtube_token.ts` requests all four; re-mint there to change).
- **Topic demand validation:** `ENABLE_TOPIC_VALIDATION` (`'1'` in `daily.yml`).
  Before script-gen, `validateTopicDemand` (`src/topicResearch.ts`) asks the
  script CLI for `TOPIC_CANDIDATE_COUNT` (5) candidate angles — each pinned to a
  common stock-filmed creature per invariant #3 — scores each by the median view
  count of its query's top YouTube search hits (search.list = 100 quota units
  each, ~500/run of the 10k daily budget), and feeds the winner to
  `generateEpisode` as a topic *steer*, not an order: the script model still
  owns the episode and every safety rule. The winner is NOT just the highest
  median: `pickBestCandidate` keeps only candidates in the **winnable band**
  `[NO_DEMAND_MEDIAN 15k, SATURATED_MEDIAN 2M]` (above the ceiling = a saturated
  mega-niche a young channel can't out-rank; below the floor = no real
  audience), then prefers the highest **floor** (lowest of the top hits — proxy
  for demand depth, logged each run so we can confirm it isn't just selecting
  high-competition queries), tie-broken by median; it falls back to best-by-floor
  if nothing lands in the band, and returns null (model keeps its own choice)
  only when every probe scored 0. The winner's exact search query is also forced
  verbatim into the description's first two sentences + one tag for on-page SEO
  (`buildTopicDirective`). When analytics feedback is on, the channel's own
  winning titles are passed as a soft flavor hint to the candidate proposer
  (deliberately NOT a hard weighting — a young channel's sample is taste, not
  statistics). Any failure falls back silently to the model's own topic choice.
- **Shorts loop seamlessly (by design):** `OUTRO_SEC = 0` in `src/shortsGen.ts` —
  a Short ends exactly where its narration ends so it loops mid-curiosity
  (replay rate is a Shorts ranking signal). The subscribe/watch-full end card in
  `ShortsScene.tsx` is kept for reversibility but only renders when
  `outroSec > 0`; the funnel lives in the description link (next bullet).
  To tighten the loop, `ShortsScene.tsx` re-fades the opening hook card back in
  over the final ~1.2s (`loopBackOpacity`, gated `!hasOutro` so it never fights
  the reversible end card), so the seam lands back on the hook and re-arms the
  curiosity gap on replay. The hook card itself is tuned for the swipe-decision
  moment as a **kinetic opener** (Shorts feel like a recited article without it):
  a near-hard cut-in (3-frame fade, not ~0.3s up from black, so frame 0 is
  footage), a yellow series **badge stinger** (`badgeIn`/`badgeScale`, settles by
  frame 10), the headline rendered as a **per-word cascade** (each word fades +
  rises in narration order, `CASCADE_WINDOW`/`WORD_RISE`, completes ~frame 23),
  the FIRST b-roll clip getting a centered **snap-zoom** (`KenBurnsClip isFirst`,
  1.26→~1.12, with a `durationInFrames <= 12` two-point guard so the interpolate
  range stays strictly increasing), and a length-aware hold (`hookHoldSec` ≈
  chars/13, floored 2.4s / capped 4.6s) so a short punch clears fast while a
  longer hook gets read. All of this is transform/opacity only, and every stage
  is clamped to rest (badge scale 1, words at full opacity/no lift), so the tail
  loop-back re-fade shows a **settled static block** and nothing re-animates
  there — the cascade only replays when the loop restarts from frame 0 (which
  re-grabs the eye, by design). The old `-webkit-line-clamp:3` was dropped (it
  would crop the per-word `translateY` entrance); the title stays a tidy ~2-line
  block purely via the upstream `compactHook` ≤`CARD_HOOK_MAX_CHARS` (60-char)
  cap, so don't reintroduce a clamp without re-checking the cascade. The Shorts
  caption (`SubtitleOverlay.tsx`, vertical variant only) lights the active
  karaoke word with an **overshoot pop** (0.82→1.08→1) so the highlight reads as
  a beat; the long-form caption path stays calm/uniform-white. The opener is also
  front-loaded: the Shorts-cut prompt rule makes sections 3/5's FIRST narration
  sentence the section's biggest scroll-stopping hook — framed as a TEASE, never
  the payoff, so the no-spoiler chapter rule and invariant #1 still hold — and a
  **SPOKEN-HOOK FORM** sub-rule requires that sentence to read like a line a
  person actually *says* (short, mostly a single clause, present tense, ~14 words
  max), not documentary prose, since the Shorts audio is reused verbatim from the
  long-form section and that prompt is the only lever on its spoken cadence.
- **Shorts cut faster than the long-form (by design):** `SHORTS_CLIP_SEC = 3.4`
  in `src/config.ts` (the long-form `BROLL_CLIP_SEC` is 6) — a vertical,
  muted, fast-scrolled feed rewards energy, so the same narration gets ~50% more
  cuts. It drives BOTH the portrait-clip fetch quota (`fetchShortsBroll`'s
  `needed` in `src/stock.ts`) and the Short's `clipQuota` in `pipeline.ts`. The
  extra clips still pass the same relevance ranking and the portrait 1280px hard
  floor (invariant #3 holds); the rare landscape-fallback path (<2 portrait clips
  found) inherits the faster cadence by center-cropping the relevant long-section
  clips, which stays on-subject. Don't relax the floor to chase the quota.
- **Long-form rest beats + slower cadence (anti-fatigue):** the long-form picture
  used to move constantly (video + Ken Burns + grade + captions), which tires the
  eye. Two levers ease it, **long-form only** (Shorts keep their fast cadence):
  (1) `BROLL_CLIP_SEC` was raised **5 → 6** in `src/config.ts` — shots-per-section
  = `max(beats, ceil(duration / perShot))`, so a bigger baseline yields ~15% fewer
  cuts. Note `BROLL_CLIP_SEC` is ALSO read in `src/stock.ts` (the `orderPoolByPreference`
  weak-clip threshold and the `makeKenBurnsClip` frame count), so the change
  propagates there by design. (2) `REST_STILLS_PER_SECTION` (1) slots ONE shot per
  section as a genuine **still** so the eye gets a pause. The pure decider is
  `pickRestSlots` in `src/cuts.ts` (unit-tested): it is conservative — never slot 0
  (the cold-open/establishing shot), never a card slot, never a slot whose
  narration window speaks a number (those keep the accent push-in), nothing at all
  below `REST_STILL_MIN_CLIPS` (3) shots, and it prefers the longest-held slot. The
  image comes from `fetchRestStill` in `src/stock.ts`: an **on-subject Unsplash
  photo** of the episode `subject` if available, else a **freeze-frame** of the
  already-chosen, already-vetted clip — so the rest beat is on-subject by
  construction (invariant #3 holds) and best-effort (any failure keeps the moving
  clip, zero regression). It renders via `CalmStill` in `SectionScene.tsx` (a
  barely-there 1.0→1.03 push; captions/overlays/grade still layer on top),
  index-aligned through the new `shotStills?: (string|null)[]` manifest field.
  Render-side + one fetch step, no new state file.
- **Schedule:** `PUBLISH_WEEKDAYS_UTC = [1,3,5]`; `WEEKDAY_SERIES_MAP` = Mon→animals,
  Wed→insects, Fri→plants. The run is *triggered* at 13:00 UTC but each long video
  is *scheduled public* at `PUBLISH_HOUR_UTC` = **19:00 UTC** (the US-afternoon
  slot ≈3pm ET / 12pm PT; = 03:00 next-day Taiwan). Don't confuse the 13:00 UTC
  trigger with the publish time. Shorts (`planShortsForToday` in `src/shortsGen.ts`):
  every long-video run emits a **same-day teaser** (section 0 = cold-open hook,
  staggered to `PUBLISH_HOUR_UTC + 2` ≈ 21:00 UTC so it funnels into the
  just-dropped long video) **plus** later-section shorts dripped onto the
  off-days, so every weekday gets one and no two reuse a section: Mon/Wed → 2
  shorts (same-day + next-day), Fri → 3 (same-day + Sat + Sun). Because sections
  3/5 ship verbatim as those off-day Shorts, the script prompt requires their
  FIRST sentence to stand alone for a cold viewer (name the subject, zero-context
  claim) and adds a per-section `shortsHook` field (8-14 word standalone hook)
  that `buildShortsManifest` prefers over the chapter-label heading for the
  Short's title/card. The prompt writes `shortsHook` for **sections 0, 3 and 5**
  — section 0 is the same-day teaser, whose spoken cold-open line may withhold the
  subject for mystery, so its `shortsHook` carries the standalone, subject-named
  version the teaser's title/card needs (no clickbait: the claim must be real and
  actually delivered in the episode). Fallbacks differ by section: the teaser
  (section 0) falls back to the episode cold-open hook, off-day sections to the
  chapter heading (older episodes wrote `shortsHook` only on 3/5). Because a
  `shortsHook` is published as the Short's title AND rendered as the on-screen
  card, invariant #1 extends to it: `normalizeEpisode` drops any hook stating a
  number the episode never speaks (`hookNumbersAreSpoken` vs the whole episode's
  `spokenNumbers`) back to that fallback rather than caption a fabricated figure.
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
  `FLUX_STEPS`, `REMOTION_CONCURRENCY`; growth-automation gates (all default
  OFF locally, `'1'` in `daily.yml`): `ENABLE_ANALYTICS_FEEDBACK`,
  `ENABLE_TOPIC_VALIDATION`, `ENABLE_AUTO_COMMENT`, `ENABLE_CTR_RESCUE`,
  `ENABLE_CONTENT_AUDIT`, `ENABLE_BROLL_CARDS` (explainer-card b-roll fallback,
  invariant #3; tune with `BROLL_CARD_MAX_PER_SECTION` / `BROLL_CARD_OFFSUBJECT_RATIO`,
  per-series accent hex in `SERIES_ACCENTS` in `src/config.ts`),
  `ENABLE_BROLL_VISION_QA` (vision relevance gate on b-roll selection, invariant
  #3; tune with `BROLL_VISION_QA_MAX_CHECKS`).

## Conventions

- Commit format: `<type>: <description>` (feat/fix/refactor/docs/test/chore/perf/ci).
- **Attribution is disabled globally — do NOT add `Co-Authored-By` trailers.**
- Commit when the work is done; **push only when the user asks** (but note: the
  pipeline only uses pushed code, so unpushed work won't affect the next run).
- Style: small focused files, immutable updates, explicit error handling, no
  hardcoded secrets. `tsc` clean + tests green before pushing.
