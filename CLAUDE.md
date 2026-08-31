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
   **iNaturalist species-accurate stills (`searchINaturalist`/`parseINaturalistResults`
   in `src/stock.ts`).** A second keyless still gap-fill, tried between Commons
   and Unsplash. iNat research-grade observations are community-ID'd to the
   species, so it is searched by the episode **subject** (the creature, via
   `taxon_name`) rather than the beat query, returning a REAL photo of the exact
   animal/plant — the best free on-subject coverage for uncommon subjects, and it
   Ken-Burns'es through the same still path (so Shorts get it too). Same two
   guards as Commons: **permissive licenses only** (API `photo_license=cc0,cc-by`
   AND `isPermissiveLicense`, with iNat's hyphen codes normalized by
   `normalizeINatLicense` so `cc-by` matches), and per-image attribution. One
   extra rule is load-bearing: CC-BY legally needs a credit, and the **Shorts**
   fetch path threads NO credit channel (`fetchShortsBroll` passes
   `commonsCredits` undefined), so a CC-BY iNat photo is accepted ONLY when that
   channel exists (long-form); on Shorts only **CC0 / public-domain** iNat photos
   are used (`licenseNeedsAttribution` gate), so a used photo is never left
   unattributed. Bumps the `inaturalistFill` brollStats counter. Pure parsing
   unit-tested in `test/stock.test.ts`.
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
   layout decider, fed ONLY the on-screen `headline` clause — NOT the subject
   caption: keying off the caption injected the same subject emoji into every card
   of a single-subject episode, e.g. an owl episode, so every card hit the 1-icon
   focal layout and rendered an identical graphic with only the text changing;
   off the clause the visual matches the words shown and the layout varies
   naturally across the episode): **2 distinct subject emoji → a relation diagram**
   (two ringed subject nodes + a connector that draws in + a travelling A→B pulse
   + arrowhead — for process beats like "the wasp paralyses the caterpillar"),
   **1 → a focal node** (emoji in an accent ring + ONE of three deterministic
   motifs picked by `focalVariant(headline)` — expanding rings / a steady breathing
   halo / a slow rotating dashed ring — so repeated focal cards don't look
   identical and the "sonar" emission is only 1 of 3, not every card), **0 → an
   abstract animated motif** (`AbstractFocal` in `FactCard.tsx`: a neutral glowing
   core inside one of those same `FocalMotif` variants — no creature — above the
   same centered verbatim clause; when the words name no subject we can show
   faithfully, animate instead of dropping to a flat text slide. User directive:
   "match the words with an icon, else use animation." The motif depicts nothing,
   so invariant #1 is trivially safe). The emoji are DECORATIVE only — they
   depict a subject the verbatim text already names and add no data (invariant #1 holds);
   the arrow follows narration order and asserts no new claim. `ICON_DICT` lists
   only faithful glyphs — a subject with no accurate emoji (wasp, moth) is
   deliberately ABSENT so the card degrades to the text layout, never a wrong
   creature. Note `ICON_DICT` is ALSO consumed by `src/iconExtractor.ts`
   (the always-on in-frame overlay-emoji path, independent of this gate), so
   broadening it affects live overlays too — but that path only fires when the
   matched word also appears in the section heading/visual context, so it can't
   fabricate. That overlay path also **de-dups the emoji across the whole
   episode** (user directive: variety, not fewer icons) — `extractIconEvents`
   takes an `avoidEmojis` set and `pipeline.ts` threads an episode-wide
   `usedIconEmojis` Set through the in-order `sections.map` (each section avoids
   every glyph used earlier and surfaces a DIFFERENT spoken-and-in-context
   subject, or none, instead of repeating e.g. 🦉 every section). It only ever
   SKIPS — invariant #1 holds (the spoken-AND-in-context gate is unchanged).
   When NO faithful glyph matches (none in the dict, none in context, or the only
   match was already used this episode), the corner now falls back to ONE
   **abstract animated motif** instead of going blank (`IconEvent` is
   `{start; emoji?; motif?}`, exactly one set; `CornerMotif` in `IconOverlay.tsx`
   renders 4 pure-geometry variants — pulse rings / orbiting dot / breathing bars
   / rotating dashed ring — chosen deterministically from the section context for
   variety). Same user directive as the card path; the motif depicts nothing so
   invariant #1 is safe. The motif carries no `emoji`, so `pipeline.ts` does NOT
   add it to `usedIconEmojis` (a motif section never burns a glyph) and `mux.ts`
   gates the audio icon-pop on `ev.emoji` (motif sections are a quiet visual-only
   beat, keeping the pop an accent for true subject reveals). Pure parts
   unit-tested in `test/iconExtractor.test.ts`.
   Long-form only (Shorts untouched); render-side, no new state file.
   This is a safety net, NOT a strategy — a real on-subject clip always wins; the
   goal is that a bad slot degrades to a clean designed card, never off-topic
   scenery.
   **AI illustration background for cards (`ENABLE_BROLL_AI_ART`, OFF by default,
   long-form only).** An explainer card that is ALREADY going to render (a slot
   `planShotCards` proved off-subject) MAY get a stylized, non-photoreal AI
   illustration as its full-frame BACKGROUND instead of the geometric schematic
   (`generateCardIllustration` in `src/brollArt.ts`, rendered by `IllustratedCard`
   in `FactCard.tsx`). It **never replaces real footage** — it only upgrades a
   card that was going to show anyway, and it sits BELOW every real-footage net in
   priority. Two trust guards are load-bearing and must stay: the FLUX prompt
   forces a clearly-illustrated, NON-photoreal look (so it can't masquerade as
   real footage on a science channel — the reason we don't AI-generate photoreal
   creatures), and a **vision-QA gate** (`passesArtQa`) DROPS any illustration
   with an anatomical error or that reads as a photo — and, unlike the thumbnail
   QA, a QA-*unavailable* result also drops (the schematic card is a clean
   invariant-safe fallback, so an unverified illustration never ships). **Invariant
   #1 holds:** the card's on-screen text stays verbatim narration (the illustration
   is decorative background asserting no number/claim), and the prompt bans
   rendered text/numbers. Hard per-EPISODE cap (`BROLL_AI_ART_MAX_PER_EPISODE`,
   default 2 — FLUX free-tier quota is largely spent on the thumbnail; generation
   reuses the shared `src/flux.ts` extracted from `thumbnail.ts`). Fetch-time only,
   no new state file; bumps the `cardIllustration` brollStats counter. This is a
   last-resort upgrade, NOT a strategy — measure `brollStats` (how often cards even
   fire) before enabling it. Pure parts unit-tested in `test/brollArt.test.ts`.
   **Observability (`src/brollStats.ts`).** Every b-roll safety net above
   (vision-drop, Commons/iNaturalist/Unsplash fill, hero-segment reuse,
   cross-section backfill, explainer cards, card AI illustrations, rest stills)
   bumps a run-scoped counter, and
   `pipeline.ts` logs a one-line `B-roll fallbacks: …` tally at the end of step
   3. It is pure telemetry (never changes which clip ships), so use the Actions
   log to see which nets actually earn their keep before adding another — a net
   that never fires over weeks is a removal candidate, and one that fires
   constantly is an upstream unfilmable-subject smell (fix at the topic gate, not
   downstream). Pure parts unit-tested in `test/brollStats.test.ts`.
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
reply-bait engagement comment under each recently-public video that lacks ours
(the comment asks ONE effortless binary/"guess-before-you-look" question —
those pull far more replies than open-ended ones). **Shorts-first + link-free
(subs directive 2026-08-26):** the pass already covers Shorts (the uploads
playlist includes them), but the analytics showed Shorts averaging ~0.3
comments — the blind newest-first order let same-day long uploads eat the
`AUTO_COMMENT_MAX_PER_RUN` (3) slots. Targets are now classified by duration
(`parseIsoDurationSec`/`isShortDuration`, ≤180s = Short) and **Shorts are
seeded first** (`orderCommentTargets`, pure/unit-tested) since Shorts are the
reach/subscriber engine. A Short's comment is also now **pure reply-bait with
NO funnel link**: the link diluted reply intent and pushed the near-dead
Short→long funnel (~0.26%); the description's own `▶ Full video:` line is
untouched, so the funnel link itself isn't removed. Long-video comments keep
the (currently unused) funnel-append path. Comments can't be posted on
private/scheduled videos, and today's upload only goes public at 19:00/21:00 UTC
(hours after the 13:00 UTC run), so the pipeline itself only ever comments on
EARLIER runs' videos. To stop today's Short waiting ~2 days for the next
Mon/Wed/Fri run (long past its key early-push window), the SAME entry point is
also driven by a standalone **`comment-pass.yml`** workflow (22:00 UTC daily +
`workflow_dispatch`, `scripts/autoCommentPass.ts`) — a light isolated pass (no
render/upload) that comments ~1h after the publish slots. The two triggers don't
share the `.commented-videos` state file, so a **live `commentThreads.list`
dedupe guard** (`channelAlreadyCommented` vs our own channel id) is the real
cross-run idempotency check — it confirms our channel hasn't already commented
before posting, so neither trigger ever double-comments. `comment-pass.yml`
needs no new secrets (it reuses `daily.yml`'s `CLAUDE_CODE_OAUTH_TOKEN` +
`YT_*`) and only takes effect once pushed to `main` (a scheduled workflow lives
on the default branch). And `rescueWorstPackaging` (`src/ctrRescue.ts`,
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
  common stock-filmed creature per invariant #3, and each angle required to be a
  **VISIBLE phenomenon** a stranger can picture in one glance (a behavior /
  movement / transformation / reaction you could film), NEVER an invisible or
  abstract angle (genetics, kinship, DNA, internal chemistry, statistics) with no
  watchable moment — those reliably flop as Shorts because the viewer can't
  picture anything in the first two seconds — scores each by the median view
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
- **Shorts end on a complete-feeling card (user directive 2026-06-29):**
  `OUTRO_SEC = 2.5` in `src/shortsGen.ts` — after the narration ends, the Short
  holds ~2.5s on the "Watch the full video + SUBSCRIBE" end card
  (`ShortsScene.tsx`, gated on `outroSec > 0`) so it has a deliberate, finished
  ending. This **REVERSES** the prior seamless-loop design (`OUTRO_SEC = 0`): a
  loop with no ending read as "cut off / suddenly interrupted" even once the
  narration resolved its own arc. The self-contained-narration directive
  (2026-06-23 "分流") still stands — the narration CONTENT resolves its own posed
  question (see the Shorts-cut prompt rule below); what changed is only the
  on-screen *ending*, not the script. We traded the replay-loop benefit
  (never data-proven; the Short→long funnel is ~5.8% and long views arrive via
  `RELATED_VIDEO` anyway) for the complete ending + an on-screen subscribe CTA;
  the funnel link still also lives in the description's `▶ Full video:` line.
  Because `OUTRO_SEC > 0` now, `hasOutro` is true, which **auto-disables** the
  loop-back hook re-fade (`loopBackOpacity` in `ShortsScene.tsx`, gated
  `!hasOutro`) — the end card owns the tail, so that re-fade is dormant unless
  `OUTRO_SEC` is set back to 0. The audio side already supported this: BGM keeps
  playing through `[narrationSec, duration]` and fades over the last 0.8s while
  narration stops at `narrationSec` (`muxShortsAudio` in `src/mux.ts`). The hook card itself is tuned for the swipe-decision
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
  a beat; the long-form caption path stays calm/uniform-white. **Both variants
  force ONE line per cue — and one line *per word*.** `flexWrap:'nowrap'` only
  stops word-to-word wrapping, so every word `<span>` ALSO pins
  `whiteSpace:'nowrap'` + `flexShrink:0`: without them a hyphenated TTS token
  (`deep-sea`, `cold-blooded`) is a single squeezable span and the browser
  breaks it at the hyphen, dropping the tail (`sea`) to a second line — the
  long-form caption glitch fixed here. `fitFontSize` auto-shrinks the whole row
  to a pixel budget (`WIDTH_SAFETY` 0.90 headroom) so the pinned, non-shrinking
  row stays inside the frame instead of clipping. Don't drop the per-word
  `nowrap`/`flexShrink:0` or push `WIDTH_SAFETY` back toward 1.0. The opener is also
  front-loaded: the Shorts-cut prompt rule makes sections 3/5's FIRST narration
  sentence the section's biggest scroll-stopping hook — framed as a TEASE, never
  the payoff, so the no-spoiler chapter rule and invariant #1 still hold — and a
  **SPOKEN-HOOK FORM** sub-rule requires that sentence to read like a line a
  person actually *says* (short, mostly a single clause, present tense, ~14 words
  max), not documentary prose, since the Shorts audio is reused verbatim from the
  long-form section and that prompt is the only lever on its spoken cadence.
  **Lead with the phenomenon, not the mechanism (user directive 2026-06-24,
  commit b8647b2 — the single biggest reach lever):** a `LEAD WITH THE PHENOMENON,
  NOT THE MECHANISM` sub-rule (in the Shorts-cut rule + a `shortsHook` Shape
  criterion) requires that opener to lead with the VISIBLE thing a stranger can
  instantly picture — the behavior/WHAT, or a sharp question about it — NOT the
  internal anatomy/mechanism/measurement that EXPLAINS it (that's the body's
  payoff). Diagnosed from real analytics: the 6/22 owl episode's two Shorts
  diverged ~5x — the phenomenon-first teaser ("an owl spins its head almost all
  the way around — how?") got 756 views vs the mechanism-first sibling ("its neck
  bones are full of holes wider than the arteries…") at 155, because the dry
  mechanism opener loses the swipe-decision in the first ~2s even when it names
  the subject. Prompt-only (`scriptGen.ts`), no logic/honesty-gate touched —
  invariant #1 holds (it only reshapes which TRUE narration moment leads). This
  REINFORCES, does not fight, the self-contained rule below: phenomenon/question
  up front, mechanism + full resolution in the body.
  **High-stakes drama, not mere visibility (data directive 2026-08-26).** A
  120-day pull of all ~80 published Shorts (the `shorts-hook-report.yml` output)
  showed that VISIBLE-but-low-stakes openers still flop 3-5x (a click beetle
  "snapping faster than muscle", a garden spider "building a perfect web", a
  tree's longevity), while every top performer carried real DRAMA in one of five
  categories: predation/hunting, threat/defense/escape, deception/mimicry, a
  hidden weapon or a sense we don't have, or an "impossible body" that forces a
  "how?". So visibility is necessary but not sufficient — the winning lever is
  STAKES. Two prompt-only edits push both the topic choice and the hook toward
  those categories and explicitly DEMOTE the proven losers (longevity, seasonal
  timing / life-cycle stages, kinship / social rank, slow growth, pure abstract
  mechanism): the topic-candidate proposer's HIGH-STAKES DRAMA hard rule
  (`topicResearch.ts`) and a stakes clause on the `LEAD WITH THE PHENOMENON` rule
  (`scriptGen.ts`). Invariant #1 holds — both only reshape WHICH true angle/moment
  leads; a hook may never invent stakes the episode doesn't deliver. This is the
  north-star lever while the channel optimizes for **subscribers via Shorts** (the
  Short→long funnel converts only ~0.26%, so long-form reach is deprioritized
  until it's the focus): reach drives subs, and subject/angle drama drives reach
  far more than hook wording does.
  **Facet-collision + history-hook follow-up (user directive 2026-07-06):** the
  7/3 sundew episode exposed two hook-level gaps, both fixed prompt-only in
  `scriptGen.ts`. (a) The `DIFFERENT FACETS` rule only compared sections 3 and 5's
  shortsHooks to EACH OTHER, so the section-3 Short shipped a hook nearly
  word-for-word identical to the long video's TITLE (and the same "glue" facet as
  the day-before teaser) — the overlapping audience had already seen the claim
  and swiped (147 views vs the teaser's 653). The rule now also bans restating
  the episode TITLE's claim or section 0's teaser-hook facet: title + teaser +
  section-3 + section-5 must be four different facets. Note the TEASER may still
  echo the title's central claim — that pairing is by design (it funnels into the
  just-dropped long video); only sections 3/5 carry the wider ban. (b) The
  phenomenon-first rule now explicitly bans the history/trivia opener (famous
  scientist, discovery year — "A sundew obsessed Darwin…" gave a stranger nothing
  to picture, 228 views). Still a steer, not a guarantee; invariant #1 untouched
  (both rules only pick WHICH true claim leads, never invent one).
  **Self-contained payoff (user directive 2026-06-23, "分流"):** the TEASE applies
  only to that FIRST sentence — the section BODY must then RESOLVE the specific
  question it opened so a cold Short viewer gets a complete, satisfying answer
  (then at most ONE soft forward pull, never a bare cliffhanger). Enforced in
  `scriptGen.ts` by the `SELF-CONTAINED PAYOFF` bullet + the Pacing-rule
  exception, which OVERRIDE the per-section role's generic "end on a hook into the
  next" for sections 3/5.
  **TRUNCATION clarification (user follow-up 2026-06-27, commit a2f60b7):** a Short
  is NOT the whole section — only the section's OPENING ~45 seconds (~120-140 words
  / first 4-6 spoken sentences) ships as the Short; the audio is verbatim but
  TRUNCATED (the runtime hard cut is `MAX_SHORTS_SEC = 55`s at the last sentence
  boundary, so the ~45s prompt target leaves a ~10s buffer). So the tease→answer
  micro-arc MUST land INSIDE that opening window, not in the section's back half —
  the three prompt spots (Pacing-rule EXCEPTION line ~213, Shorts-cut opening-window
  rule line ~221, `SELF-CONTAINED PAYOFF` line ~224) all say so. ALL Shorts come
  from sections 0/3/5 ONLY (`planShortsForToday`), so this rule covers 100% of
  Shorts — there is no other Short category to fix. It is a strong prompt STEER,
  not a 100% hard guarantee (a true guarantee would need a verify→regenerate loop);
  the user accepted the prompt-rewrite approach. The section-0 same-day teaser keeps its mystery
  cold-open line and sentence-2 promise tail unchanged (don't spoil the long
  video) but now ALSO lands one small self-contained fact before its forward hook,
  so the channel's highest-traffic Short stops cutting off cold. The episode's
  single central reveal is still withheld to the template's reveal section, so
  long-form retention is unaffected; invariant #1 holds because every resolved
  beat is the model's own true narration (no new claim is invented).
  **Self-contained-arc ENFORCEMENT (user directive 2026-06-27, "做a和b" — beyond
  the prompt steer above):** two structural levers now make the tease→answer arc
  land inside the cut window instead of relying on the prompt alone.
  **Lever A — marker-aligned cut:** the script writes a per-Short-section
  `shortsArcSentences` (the 1-based sentence number where that section's arc is
  COMPLETE, ≤6 / ≤140 words). `trimToBoundary` in `src/shortsGen.ts` cuts the
  Short at exactly that sentence (via the pure `sentenceEndIndex`) when its end
  lands in `[MIN_ARC_SEC 15s, MAX_SHORTS_SEC+0.5 = 55.5s]`, so the Short ends ON
  the answer instead of the old blind fill dragging it into the next beat (which
  then got chopped). A missing/garbage marker, one below 15s, one past the
  section's sentence count, or one whose arc overflows the hard cap all degrade to
  the original blind time-based cut — zero regression for older episodes.
  **Lever B — text-stage verify + bounded regen** (`src/shortsArcQa.ts`): a
  deterministic, always-on (no CLI) word-budget check (`shortsArcOverflowSections`
  vs `SHORTS_ARC_MAX_WORDS = 148` ≈ 50s @178wpm) flags any Short section whose
  marked arc would overflow the window, and `generateEpisode` treats that as a
  third accept-last regen trigger alongside `collision`/`tooShort` (bounded by
  `SCRIPT_GEN_ATTEMPTS = 2`, so it never stalls). On top of that a **gated** LLM
  judge (`ENABLE_SHORTS_ARC_QA`, `'1'` in daily.yml, OFF locally) independently
  verifies each Short opening both POSES and RESOLVES a question in the window,
  CORRECTS the `shortsArcSentences` marker, and flags sections that never resolve
  (→ regen). It runs only when the cheap checks are clear (no wasted CLI) and is
  best-effort/non-fatal: any CLI/parse/timeout error keeps the episode unchanged.
  `runClaudeCli` is INJECTED into `refineShortsArcs` to avoid a scriptGen↔shortsArcQa
  import cycle. **Invariant #1 holds:** the judge only ever moves an integer cut
  marker — narration, `shortsHook`, and overlays are never touched, and
  `shortsArcSentences` is a cut index, never rendered text. Pure parts unit-tested
  in `test/shortsGen.test.ts` (Lever A) and `test/shortsArcQa.test.ts` (Lever B).
  Still a STEER + bounded retry, not a 100% guarantee, but now backed by a
  structural cut + a verify→regen loop rather than the prompt alone.
- **Shorts cut faster than the long-form (by design):** `SHORTS_CLIP_SEC = 4.0`
  in `src/config.ts` (the long-form `BROLL_CLIP_SEC` is 7) — a vertical,
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
  (1) `BROLL_CLIP_SEC` was raised **5 → 6 → 7** in `src/config.ts` (6/25 hero-reuse
  pass took it to 7; `SHORTS_CLIP_SEC` 3.4 → 4.0 in the same pass) — shots-per-section
  = `max(beats, ceil(duration / perShot))`, so a bigger baseline yields fewer
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
- **Shot assembly: up to N distinct clips per beat, then hero-segment reuse
  (`assembleHeroReuseShots` in `src/stock.ts`).** A narration beat can own more shot
  slots than it has fetched clips. Each beat downloads
  `min(MAX_DISTINCT_CLIPS_PER_BEAT, slots)` distinct clips for its query and fills
  the rest of its slots with ffmpeg time-window cuts of the FIRST (hero) clip
  (`segmentWindow`/`cutClipSegment`, camera varied per `kenBurnsFor`) — so a
  multi-slot beat shows real variety up front and never flashes a wall of different
  individuals. `MAX_DISTINCT_CLIPS_PER_BEAT` was **1 → 2** (user directive
  2026-06-27, commit d2d2a45) for a little more honest variety; the pure mapper is
  `shotSource(reuseOrdinal, distinctCount)` (`reuseOrdinal < distinctCount` →
  distinct clip, else a hero segment whose ordinal restarts at 1 so the first reused
  segment still starts at `ss = perShot`, matching the old single-clip behavior;
  unit-tested in `test/stock.test.ts`). `clipsForBeat` borrows the nearest non-empty
  NEIGHBOR list when a beat itself found nothing. **Invariant #3 holds:** all distinct
  clips of a beat come from the SAME on-subject beat query and pass the same
  relevance/vision/portrait-floor filters; a failed segment cut DROPS that slot
  rather than repeating a hero frame-0. Shorts inherit the same path (up to 2
  distinct portrait clips per beat).
- **Animals series is vertebrates-only (weekday-series bleed fix, user directive
  2026-07-07):** the Monday `animals` series kept shipping insects (bee 6/29,
  butterfly 7/7) because its theme/subThemes were taxonomy-agnostic AND the
  topic-demand steer treats high-view insects (bees/butterflies) as valid
  "animals". The `animals` series now carries `vertebrateOnly: true` (in
  `SERIES_POOL`, `src/config.ts`) — mammal/bird/reptile/amphibian/fish ONLY,
  never an insect/arachnid/invertebrate (those are the Wednesday insects series'
  territory). Enforced in **three layers**, forward-fix only (live videos
  untouched): (1) a hard TAXONOMY-CONSTRAINT prompt block in `generateEpisode`
  (`scriptGen.ts`) + a HARD-RULE line in the topic-candidate proposer
  (`topicResearch.ts`), both gated on `series.vertebrateOnly`; (2) a deterministic
  regen guard — `findTaxonMismatch(subject, series)` (pure, in `config.ts`,
  unit-tested in `test/config.test.ts`) matches the subject against
  `INVERTEBRATE_SUBJECT_WORDS` by **whole word-token** (so 'ant' never fires on
  'anteater'/'antelope', 'fly' not on 'flycatcher') and becomes a fourth
  accept-last regen trigger in `generateEpisode` alongside
  `collision`/`tooShort`/`arcFail` (bounded by `SCRIPT_GEN_ATTEMPTS`, so it never
  stalls; a rare bird like 'bee hummingbird' just costs one retry); (3) a
  deterministic candidate filter in `validateTopicDemand` (`topicResearch.ts`)
  that drops invertebrate candidates before scoring so the demand steer can never
  push an insect (empties-to-fallback: model keeps its own choice). **Invariant #1
  holds** — every layer only reshapes WHICH true subject/taxon is chosen; no
  narration, overlay, or figure is touched. `INVERTEBRATE_SUBJECT_WORDS`
  deliberately excludes tokens that collide with vertebrate names ('coral' → coral
  snake, bare 'worm' → slow worm, bare 'star' → star-nosed mole). Other series
  (insects/plants) have no `vertebrateOnly` flag, so all three guards are inert
  there.
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
  3/5 ship verbatim (but truncated to the opening ~45s — see the TRUNCATION
  clarification above) as those off-day Shorts, the script prompt requires their
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
  #3; tune with `BROLL_VISION_QA_MAX_CHECKS`),
  `ENABLE_SHORTS_ARC_QA` (LLM judge that verifies + corrects each Short's
  self-contained tease→answer arc marker, gating only the judge — the
  deterministic word-budget overflow regen runs always; see the
  Self-contained-arc ENFORCEMENT note above). One gate is OFF EVERYWHERE for now
  (NOT yet in `daily.yml` — measure `brollStats` first): `ENABLE_BROLL_AI_ART`
  (stylized AI illustration background for explainer cards, invariant #3; tune
  with `BROLL_AI_ART_MAX_PER_EPISODE`; see the card AI-illustration note above).

## Conventions

- Commit format: `<type>: <description>` (feat/fix/refactor/docs/test/chore/perf/ci).
- **Attribution is disabled globally — do NOT add `Co-Authored-By` trailers.**
- Commit when the work is done; **push only when the user asks** (but note: the
  pipeline only uses pushed code, so unpushed work won't affect the next run).
- Style: small focused files, immutable updates, explicit error handling, no
  hardcoded secrets. `tsc` clean + tests green before pushing.
