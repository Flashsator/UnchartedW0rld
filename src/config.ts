import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
export const ROOT = path.resolve(path.dirname(__filename), '..');

export const WORK_DIR = path.join(ROOT, 'work');
export const OUT_DIR = path.join(ROOT, 'out');
// Daily dedup lock: records the date (YYYY-MM-DD) of the last successful
// long-form upload. Persisted across ephemeral runners via the rotation-state
// cache so a same-day re-run (manual dispatch + scheduled cron) won't publish a
// second long-form video. Kept at WORK_DIR root, alongside the .last-* state.
export const UPLOAD_LOCK_FILE = path.join(WORK_DIR, '.last-upload-date');
export const ASSETS_DIR = path.join(ROOT, 'assets');
export const FONTS_DIR = path.join(ASSETS_DIR, 'fonts');

export const PEXELS_API_KEY = process.env.PEXELS_API_KEY ?? '';
// PIXABAY_API_KEY is used for b-roll video search only. Pixabay *music* was
// removed: distributors (e.g. We Are Era Music BV) register the tracks in
// YouTube Content ID and claim the monetization. BGM/ambient now come solely
// from the official YouTube Audio Library committed under assets/yt_music/.
export const PIXABAY_API_KEY = process.env.PIXABAY_API_KEY ?? '';
// COVERR_API_KEY adds a third free, commercial-use stock-VIDEO source for b-roll
// (coverr.co). Same role as Pexels/Pixabay video — more providers means less
// repeated footage across episodes. Optional: absent key just disables it.
export const COVERR_API_KEY = process.env.COVERR_API_KEY ?? '';
// UNSPLASH_ACCESS_KEY enables a still-photo b-roll fallback: when the video
// providers can't fill a section, Unsplash photos are turned into slow Ken Burns
// (pan/zoom) clips so the section never replays the same footage. Optional.
export const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY ?? '';

// Cloudflare Workers AI: primary thumbnail-background generator via FLUX.2
// [klein] 9B. Replaces the anonymous Pollinations flux endpoint (now 402).
// Free tier covers ~7 images/day before billing kicks in. Both required.
export const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
export const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN ?? '';

// Azure Speech (neural TTS). These are the SAME neural voices msedge-tts tapped
// unofficially (en-US-AndrewNeural, etc.), but via the licensed API that allows
// commercial use. F0 (free) tier covers ~500k chars/month — well above this
// channel's usage. Get both from the Azure Portal Speech resource.
export const AZURE_SPEECH_KEY = process.env.AZURE_SPEECH_KEY ?? '';
export const AZURE_SPEECH_REGION = process.env.AZURE_SPEECH_REGION ?? '';

export const YT_CLIENT_ID = process.env.YT_CLIENT_ID ?? '';
export const YT_CLIENT_SECRET = process.env.YT_CLIENT_SECRET ?? '';
export const YT_REFRESH_TOKEN = process.env.YT_REFRESH_TOKEN ?? '';
export const YT_CHANNEL_ID = process.env.YT_CHANNEL_ID ?? '';

// --- Analytics feedback loop (opt-in) ---------------------------------------
// When ENABLE_ANALYTICS_FEEDBACK=1, the pipeline pulls the channel's
// best-performing past titles (ranked by click-through + retention) and feeds
// them to the script generator as POSITIVE examples — the counterpart to the
// existing already-published "avoid" list. OFF by default: it needs a
// YT_REFRESH_TOKEN minted with the `yt-analytics.readonly` scope, otherwise the
// YouTube Analytics API returns 403 and the loop quietly no-ops (non-fatal).
export const ENABLE_ANALYTICS_FEEDBACK = process.env.ENABLE_ANALYTICS_FEEDBACK === '1';
// How far back to look for performance data, and how many winners to surface.
export const ANALYTICS_LOOKBACK_DAYS = Number(process.env.ANALYTICS_LOOKBACK_DAYS ?? 90);
export const ANALYTICS_TOP_N = Number(process.env.ANALYTICS_TOP_N ?? 8);

// --- Auto engagement comment (opt-in) ----------------------------------------
// When ENABLE_AUTO_COMMENT=1, the end of each pipeline run posts ONE pinned-style
// engagement comment (a reply-bait question) under each recently-PUBLIC video
// that doesn't have one yet. Comments can't be posted on private/scheduled
// videos, so today's upload gets its comment on the NEXT run, once live.
// Best-effort/non-fatal; needs the youtube.force-ssl scope (already on the token).
export const ENABLE_AUTO_COMMENT = process.env.ENABLE_AUTO_COMMENT === '1';
// Video ids already commented on (one per line), persisted across ephemeral
// runners via the rotation-state cache like the other .last-* files.
export const COMMENTED_VIDEOS_FILE = path.join(WORK_DIR, '.commented-videos');
// How far back a video still counts as "recent" for auto-commenting, and the
// per-run cap so a backlog never floods the channel with same-minute comments.
export const AUTO_COMMENT_RECENT_DAYS = Number(process.env.AUTO_COMMENT_RECENT_DAYS ?? 7);
export const AUTO_COMMENT_MAX_PER_RUN = Number(process.env.AUTO_COMMENT_MAX_PER_RUN ?? 3);

// --- CTR rescue loop (opt-in) -------------------------------------------------
// When ENABLE_CTR_RESCUE=1, the end of each run finds at most ONE long-form
// video whose thumbnail is demonstrably underperforming (enough impressions,
// CTR well below the channel median) and regenerates + replaces its thumbnail.
// One per run keeps FLUX inside the free tier (~7 images/day) and makes each
// swap a clean before/after experiment. Best-effort/non-fatal.
export const ENABLE_CTR_RESCUE = process.env.ENABLE_CTR_RESCUE === '1';
// Video ids whose thumbnail was already rescued (one per line) — each video
// gets at most one rescue so we never thrash a thumbnail back and forth.
export const CTR_RESCUED_FILE = path.join(WORK_DIR, '.ctr-rescued');
// Eligibility window: old enough that CTR is measured on real impressions, young
// enough that a better thumbnail still changes the video's trajectory.
export const CTR_RESCUE_MIN_AGE_DAYS = Number(process.env.CTR_RESCUE_MIN_AGE_DAYS ?? 2);
export const CTR_RESCUE_MAX_AGE_DAYS = Number(process.env.CTR_RESCUE_MAX_AGE_DAYS ?? 21);
// Below this many impressions CTR is statistical noise, not a verdict.
export const CTR_RESCUE_MIN_IMPRESSIONS = Number(process.env.CTR_RESCUE_MIN_IMPRESSIONS ?? 300);
// A video qualifies when its CTR < this fraction of the long-form median CTR.
export const CTR_RESCUE_THRESHOLD = Number(process.env.CTR_RESCUE_THRESHOLD ?? 0.7);

// --- Thumbnail layout learning (rides ENABLE_ANALYTICS_FEEDBACK) --------------
// Which layout each uploaded long-form video shipped with (videoId<TAB>layout,
// one per line; a later line for the same id wins, so a CTR-rescue swap simply
// appends). Once enough videos carry measured CTR, layout selection weights
// itself toward the layouts that historically earn clicks (see
// thumbLayoutStats.ts). Persisted via the rotation-state cache.
export const THUMB_LAYOUT_LOG_FILE = path.join(WORK_DIR, '.thumb-layout-log');
// A layout needs at least this many CTR-measured videos before its own mean
// counts; below that it inherits the cross-layout mean (keeps exploring).
export const THUMB_LAYOUT_MIN_SAMPLES = Number(process.env.THUMB_LAYOUT_MIN_SAMPLES ?? 2);

// --- Topic demand validation (opt-in) -----------------------------------------
// When ENABLE_TOPIC_VALIDATION=1, before writing the script the pipeline asks
// the script model for a handful of candidate angles, scores each against real
// YouTube search results (median view count of the top hits = proven audience
// demand), and feeds the winner to generateEpisode as a topic steer. Costs
// ~500 Data API quota units per run (search.list = 100/each) out of the 10k
// daily budget. Best-effort/non-fatal — any failure falls back to the model's
// own topic choice.
export const ENABLE_TOPIC_VALIDATION = process.env.ENABLE_TOPIC_VALIDATION === '1';
export const TOPIC_CANDIDATE_COUNT = Number(process.env.TOPIC_CANDIDATE_COUNT ?? 5);

// --- Content self-audit (opt-in) ----------------------------------------------
// When ENABLE_CONTENT_AUDIT=1, the end of each run reads the channel's most
// recent uploads (title / pre-fold hook / tags) and asks the script CLI to score
// them against the views playbook and surface concrete fixes — a QUALITATIVE
// self-critique of the actual shipped packaging that, unlike the analytics
// loops, needs no accrued watch data to be useful on a young channel. Purely
// advisory: it writes a dated entry to CONTENT_AUDIT_LOG_FILE and raises a
// GitHub Actions warning annotation on a detected regression, but never edits a
// live video (that's ctrRescue's job) and never fails the run. Best-effort/
// non-fatal; skipped on DRY_RUN via the pipeline's early return.
export const ENABLE_CONTENT_AUDIT = process.env.ENABLE_CONTENT_AUDIT === '1';
// Append-only audit history (one dated block per run). Rides the rotation-state
// cache like the other work/.* state files, so it must be listed in daily.yml.
export const CONTENT_AUDIT_LOG_FILE = path.join(WORK_DIR, '.content-audit.log');
// How many most-recent uploads to feed the auditor (titles + hooks + tags).
export const CONTENT_AUDIT_RECENT_COUNT = Number(process.env.CONTENT_AUDIT_RECENT_COUNT ?? 8);

// Appended to every long-form description (after chapters, before attribution)
// so each video carries a consistent channel pitch + subscribe CTA. The
// ?sub_confirmation=1 link only opens the subscribe prompt on a /channel/UC...
// URL (not the @handle). The channel ID comes from YT_CHANNEL_ID (env/secret),
// not hard-coded, so a public repo clone can't be trivially linked to the
// channel. If the env is unset the CTA falls back to URL-less text rather than
// shipping a broken link.
const SUBSCRIBE_URL = YT_CHANNEL_ID
  ? `https://www.youtube.com/channel/${YT_CHANNEL_ID}?sub_confirmation=1`
  : '';
export const CHANNEL_FOOTER = [
  '━━━━━━━━━━━━━━━',
  '📺 Wild Anomalies investigates the strangest true stories from the living world — animals, insects, and plants that quietly break biology — one short, cinematic case file at a time. New documentary every Monday (animals), Wednesday (insects) and Friday (plants).',
  SUBSCRIBE_URL
    ? `👉 Subscribe: ${SUBSCRIBE_URL}`
    : '👉 Subscribe for a new documentary every Monday, Wednesday and Friday.',
].join('\n');

export const VIDEO_W = 1920;
export const VIDEO_H = 1080;
export const VIDEO_FPS = 30;
export const THUMB_W = 1280;
export const THUMB_H = 720;

export const TEST_MODE = process.env.TEST_MODE === '1';

function pickTargetMinutes(): number {
  if (process.env.TARGET_MINUTES) return Number(process.env.TARGET_MINUTES);
  if (TEST_MODE) return 1;
  // The 150-wpm assumption below under-estimates the real TTS rate (~178 wpm),
  // so the finished video lands ~7% short of the target minutes. We need the
  // final cut to clear 8:00 for YouTube mid-roll ads, so target high enough that
  // even the fast end of the rate range stays comfortably above 8 minutes
  // (9.5-10.0 target → ~8:50-9:18 final). Raising word count, not padding.
  const range = [9.5, 10.0];
  return range[Math.floor(Math.random() * range.length)]!;
}

export const TARGET_MINUTES = pickTargetMinutes();
export const TARGET_WORDS = Math.round(TARGET_MINUTES * 150);
export const SECTION_COUNT = Number(process.env.SECTION_COUNT ?? (TEST_MODE ? 3 : 7));
export const WORDS_PER_SECTION = Math.round(TARGET_WORDS / SECTION_COUNT);

export const INTRO_SEC = 0;
export const COLD_OPEN_SEC = 1.5;
export const OUTRO_SUBSCRIBE_SEC = 6.0;
export const INTERLUDE_SEC = 7.0;
export const INTER_SECTION_GAP_SEC = 1.8;

export const TTS_VOICE_FALLBACK = 'en-US-GuyNeural';
export const TTS_RATE = '-2%';

export const BROLL_CLIP_SEC = 5;
export const BROLL_MIN_HEIGHT = 1080;

// Background-music level (0–1) mixed under the narration by ffmpeg (see mux.ts).
// Applies to both long-form and shorts (shorts inherit the long-form value).
// Lower = subtler bed; raise if BGM gets lost. Was 0.35; lowered for a quieter mix.
export const BGM_VOLUME = 0.25;

export const PUBLISH_OFFSET_HOURS = 4;
// US-afternoon publish window, shared by long videos and shorts so the whole
// channel lands in the same slot: 19:00 UTC ≈ 3pm ET / 12pm PT (summer),
// 2pm ET / 11am PT (winter). Fixed UTC by design — both DST cases are good
// afternoon times, so no daylight-saving handling is needed.
export const PUBLISH_HOUR_UTC = 19;
export const DRY_RUN = process.env.DRY_RUN === '1';
// Bypass the daily upload lock (e.g. the first video was deleted and you want a
// genuine same-day re-publish). Set via the workflow_dispatch `force` input.
export const FORCE_RUN = process.env.FORCE_RUN === '1';

// UTC weekdays we publish on. 0=Sun, 1=Mon, ..., 6=Sat. Mon/Wed/Fri.
// Documents the cadence (the actual trigger is the Cloudflare cron); each of
// these days is assigned a topic by WEEKDAY_SERIES_MAP below.
export const PUBLISH_WEEKDAYS_UTC: readonly number[] = [1, 3, 5];

export type Voice = {
  id: string;
  label: string;
  gender: 'male' | 'female';
  accent: 'us' | 'gb';
};

export const VOICE_POOL: Voice[] = [
  { id: 'en-US-AndrewNeural',  label: 'Andrew (US, M, warm)',     gender: 'male',   accent: 'us' },
  { id: 'en-US-BrandonNeural', label: 'Brandon (US, M, smooth)',  gender: 'male',   accent: 'us' },
  { id: 'en-US-GuyNeural',     label: 'Guy (US, M, neutral)',     gender: 'male',   accent: 'us' },
  { id: 'en-US-EmmaNeural',    label: 'Emma (US, F, warm)',       gender: 'female', accent: 'us' },
  { id: 'en-US-AvaNeural',     label: 'Ava (US, F, bright)',      gender: 'female', accent: 'us' },
  { id: 'en-US-JennyNeural',   label: 'Jenny (US, F, calm)',      gender: 'female', accent: 'us' },
  { id: 'en-GB-RyanNeural',    label: 'Ryan (GB, M, crisp)',      gender: 'male',   accent: 'gb' },
  { id: 'en-GB-SoniaNeural',   label: 'Sonia (GB, F, refined)',   gender: 'female', accent: 'gb' },
];

export type ThumbLayout =
  | 'q_panel_right'
  | 'q_corner_dot'
  | 'q_band_word'
  | 'q_diag_split'
  | 'q_giant_overlay';

export const THUMB_LAYOUTS: ThumbLayout[] = [
  'q_panel_right',
  'q_corner_dot',
  'q_band_word',
  'q_diag_split',
  'q_giant_overlay',
];

export type Series = {
  key: string;
  name: string;
  theme: string;
  subThemes: string[];
  categoryId: string;
  imageStyle: string;
  musicQueries: string[];
  ambientQuery: string;
  // Relative priority, default 1. Currently unused by the fixed weekday
  // schedule (see seriesForToday); retained as metadata and for an optional
  // future return to weighted random rotation.
  weight?: number;
};

export const SERIES_POOL: Series[] = [
  {
    key: 'nature',
    name: 'Wild Earth Files',
    theme:
      'ecosystems, geological wonders, weather phenomena, plant survival strategies, extreme environments, biomes, natural disasters, symbiosis',
    subThemes: [
      'a single plant species with an unbelievable survival adaptation',
      'a microbiome that runs an entire ecosystem',
      'a weather phenomenon almost no one has heard of',
      'a geological feature that breaks intuition',
      'a symbiosis that looks like one creature but is many',
      'an extreme environment where life should be impossible',
      'a place on Earth that behaves like another planet',
    ],
    categoryId: '27',
    imageStyle: 'cinematic nature documentary, dramatic golden hour lighting, ultra detailed',
    musicQueries: ['cinematic ambient nature', 'organic ambient documentary', 'earth nature cinematic', 'documentary cinematic underscore'],
    ambientQuery: 'forest birds ambient',
    weight: 1.5,
  },
  {
    key: 'insects',
    name: 'Tiny Titans',
    theme:
      'insects, arachnids, microscopic life, weird invertebrate behaviors, parasites, insect superpowers, hive intelligence',
    subThemes: [
      "a parasite that hijacks its host's brain",
      'an insect that uses physics other species cannot',
      'a colony that behaves like a single mind',
      'a defense mechanism that defies biology textbooks',
      'a near-microscopic predator that out-classes mammals',
      'an arachnid that builds something engineers studied',
      'an insect strategy that explains modern technology',
    ],
    categoryId: '27',
    imageStyle: 'extreme macro photography, jewel tones, shallow depth of field, dramatic key light',
    musicQueries: ['suspense curiosity cinematic', 'macro nature underscore', 'investigative ambient cinematic', 'minimal cinematic curious'],
    ambientQuery: 'insects crickets ambient',
    weight: 0.9,
  },
  {
    key: 'cosmos',
    name: 'Cosmic Anomalies',
    theme:
      'deep space mysteries, black holes, exoplanets, dark matter, neutron stars, cosmic phenomena, physics edge cases, time dilation',
    subThemes: [
      "a star that breaks one of physics' rules",
      'a region of space that behaves impossibly',
      'a phenomenon predicted decades before it was found',
      'an exoplanet with conditions no model expected',
      'a measurement of the universe that disagrees with itself',
      'an object whose density would erase a city block',
      'a corner of the cosmos that hints at unknown physics',
    ],
    categoryId: '28',
    imageStyle: 'hyperreal space art, nebula colors, volumetric light, cosmic horror grandeur',
    musicQueries: ['epic space ambient', 'cosmic cinematic underscore', 'sci-fi ambient drone', 'celestial ambient cinematic'],
    ambientQuery: 'deep space drone',
    weight: 1.0,
  },
  {
    key: 'ocean',
    name: 'Abyss Unknown',
    theme:
      'deep sea creatures, abyssal zone, bioluminescence, hydrothermal vents, kraken-tier organisms, oceanic mysteries',
    subThemes: [
      'a deep-sea creature scientists barely understand',
      'a hydrothermal vent ecosystem with chemistry-driven life',
      'a sound recorded in the ocean that has never been explained',
      'a colony organism that behaves like a single animal',
      'an animal that survives where pressure should crush it',
      'a bioluminescence pattern that functions like language',
      'an ocean current discovery that rewrites textbooks',
    ],
    categoryId: '27',
    imageStyle: 'deep underwater bioluminescent scene, teal-cyan glow, particles in water, eerie',
    musicQueries: ['deep ocean ambient', 'underwater cinematic drone', 'submarine ambient underscore', 'abyssal cinematic pad'],
    ambientQuery: 'underwater whale ambient',
    weight: 1.3,
  },
  {
    key: 'animals',
    name: 'Beast Codex',
    theme:
      'mammals, birds, reptiles, animal intelligence, hunting strategies, evolutionary oddities, animals that break biology',
    subThemes: [
      'an animal with a sense humans cannot perceive',
      'a hunting strategy that took centuries to decode',
      'a species that broke a rule of evolution',
      'an intelligence test no one expected the animal to pass',
      'a behavior recently caught on camera for the first time',
      'a body plan that should not work but does',
      'a social structure stranger than any human society',
    ],
    categoryId: '27',
    imageStyle: 'wildlife photography, dramatic backlight, savanna or rainforest mood',
    musicQueries: ['cinematic wildlife', 'documentary nature cinematic', 'savanna ambient underscore', 'wildlife epic cinematic'],
    ambientQuery: 'savanna wildlife ambient',
    weight: 1.4,
  },
  {
    key: 'plants',
    name: 'Rooted Anomalies',
    theme:
      'carnivorous plants, parasitic plants, chemical warfare between plants, plant communication, extreme survival strategies, plants that move, plants that mimic other organisms, plants that outlive civilizations',
    subThemes: [
      'a plant that hunts, traps, and digests animals',
      'a parasitic plant that steals everything from another plant',
      'a plant that wages chemical warfare on its neighbors',
      'a plant that warns or signals others when attacked',
      'a plant that survives where almost nothing should grow',
      'a plant that mimics another organism to deceive it',
      'a single plant organism older than recorded history',
    ],
    categoryId: '27',
    imageStyle: 'botanical macro, dramatic chiaroscuro lighting, dewdrops, deep greens with one vivid accent, faintly menacing',
    musicQueries: ['organic ambient documentary', 'botanical cinematic underscore', 'earth nature cinematic', 'mysterious cinematic underscore'],
    ambientQuery: 'rainforest leaves ambient',
    weight: 1.0,
  },
  {
    key: 'body',
    name: 'The Human Machine',
    theme:
      'human anatomy oddities, neurological phenomena, immune system feats, psychological glitches, evolutionary leftovers in the body',
    subThemes: [
      'a neurological glitch most people will experience once',
      'an immune system feat that sounds like science fiction',
      'an anatomical leftover from an ancestor species',
      'a psychological bias that shaped human civilization',
      'a sense humans have but rarely notice',
      'a chemical reaction in the body that mimics other phenomena',
      'a cellular event that occurs trillions of times per day',
    ],
    categoryId: '27',
    imageStyle: 'medical cinematic, cool blue clinical light, micro-detail biology',
    musicQueries: ['curious investigative', 'science documentary underscore', 'cerebral ambient cinematic', 'minimal cinematic curious'],
    ambientQuery: 'soft heartbeat ambient',
    weight: 0.7,
  },
  {
    key: 'history',
    name: 'Lost & Forgotten',
    theme:
      'archaeological mysteries, lost civilizations, ancient technology, unsolved historical puzzles, myth versus archaeology',
    subThemes: [
      'an ancient device that should not have existed yet',
      "a civilization that vanished and left clues we still can't read",
      'a structure built with techniques modern engineers debate',
      'a written record describing something we now know was real',
      'an artifact discovered in the wrong layer of history',
      'a city found beneath a city beneath a city',
      'a myth that turned out to encode a real event',
    ],
    categoryId: '27',
    imageStyle: 'warm torchlit ancient ruin, dust particles, oil-painting cinematic',
    musicQueries: ['mysterious ancient', 'archaeological cinematic underscore', 'ancient ambient drone', 'historical cinematic pad'],
    ambientQuery: 'wind ruins ambient',
    weight: 0.7,
  },
];

// Channel positioning: only living-world episodes ship — animals, insects, and
// plants. The other series definitions above are kept (not deleted) so the
// channel can be re-broadened later by adding their keys here. A manual
// SERIES_KEY override can still target any defined series.
export const ACTIVE_SERIES_KEYS: readonly string[] = ['animals', 'insects', 'plants'];

export const ACTIVE_SERIES_POOL: Series[] = SERIES_POOL.filter((s) =>
  ACTIVE_SERIES_KEYS.includes(s.key),
);

// Fixed weekday → series mapping. Each publish day owns one topic so the slate
// reads as themed days: Mon = animals, Wed = insects, Fri = plants. Keys must
// be a subset of ACTIVE_SERIES_KEYS. Weekdays use UTC (0=Sun … 6=Sat) to match
// PUBLISH_WEEKDAYS_UTC.
export const WEEKDAY_SERIES_MAP: Readonly<Record<number, string>> = {
  1: 'animals',
  3: 'insects',
  5: 'plants',
};

export type HookPattern = { name: string; example: string; rule: string };

// Editorial template that determines the script's spine: hook style,
// per-section role, tone, music, sting. Picked per episode so the channel
// reads like a varied editorial slate, not a single locked format.
export type Structure = {
  key: string;
  label: string;
  structuralMantra: string;
  hookPatterns: HookPattern[];
  // Length should match SECTION_COUNT (default 7). Extras are sliced; shortfalls
  // are padded with a generic fallback by scriptGen.
  sectionRoles: string[];
  toneInstruction: string;
  titleStyleNote: string;
  musicTags: string[];
  stingSubFreq: number;
  stingTopFreq: number;
  stingTopDuration: number;
};

export const STRUCTURE_POOL: Structure[] = [
  {
    key: 'concept_twist',
    label: 'Concept Twist',
    structuralMantra:
      'First let the viewer fully understand the conventional, "obvious" version of the subject. Then flip ONE specific load-bearing detail in the middle. Then walk them through the new reality.',
    hookPatterns: [
      {
        name: 'forbidden_claim',
        example: 'There is a creature so strange most textbooks still refuse to name it.',
        rule: 'Open with a single matter-of-fact statement that sounds impossible AND hints it has been hidden or ignored. No question. State the impossible like a secret you are letting slip.',
      },
      {
        name: 'flip_assumption',
        example: 'Everyone is told the loudest sound on Earth came from a volcano. It did not.',
        rule: 'Open with a common belief in one sentence, then undercut it in the next. Two short sentences. No question. The contradiction is the hook.',
      },
      {
        name: 'sensory_paradox',
        example: 'It is louder than a jet engine, smaller than a fingernail, and it lives where you sleep.',
        rule: 'Open by stacking three contradictions (scale, sound, location, time) about the subject in a single sentence.',
      },
    ],
    sectionRoles: [
      'HOOK + PROMISE TAIL. Hint that something has been hidden, but do NOT spoil the flip yet.',
      'SETUP A. Introduce the conventional, "obvious" version of the subject. Treat it as if it is the whole truth.',
      'SETUP B. Deepen the conventional understanding with specific details that will become load-bearing for the flip.',
      'THE PIVOT. A single conceptual reversal. Open with a reversal line that NAMES the subject so it stands alone, e.g. "Except that is not what the octopus is actually doing." Identify exactly which load-bearing detail breaks.',
      'REFRAME A. Re-walk the subject under the new framing. Cite the evidence the old story ignored.',
      'REFRAME B. Explain why the old framing survived this long. Name what no one talks about.',
      'CLOSING IMPLICATION. ONE reflective line that lingers. Not a recap. Not a CTA. The viewer should feel they cannot un-know this.',
    ],
    toneInstruction:
      'Investigator who has uncovered a hidden truth. Every sentence is a clue, withheld then dropped. Short sentences land hard, long sentences stack details. Never reassure. Never soften.',
    titleStyleNote:
      'Reveal-implying. Lanes: "The X That [Quietly Stopped Being Discussed]", "Why X Should Not [Exist/Work]", "What X Hides", "The Truth About X They Stopped Talking About", "Hidden In Plain Sight: X".',
    musicTags: ['dark cinematic suspense underscore', 'mysterious documentary drone', 'creeping cinematic pad', 'dark ambient reveal'],
    stingSubFreq: 38,
    stingTopFreq: 160,
    stingTopDuration: 0.65,
  },
  {
    key: 'investigative_case_file',
    label: 'Case File',
    structuralMantra:
      'Walk the viewer through the subject as a detective would walk through a case file: the original report, the skeptics, the hard evidence, independent confirmation, current consensus, the part still unexplained.',
    hookPatterns: [
      {
        name: 'scene_in_media_res',
        example: 'Two miles below the Pacific, something is glowing where no light should reach.',
        rule: 'Open mid-scene with a sensory snapshot — depth, time, darkness, pressure, silence. Drop the viewer in like a camera that just turned on.',
      },
      {
        name: 'buried_record',
        example: 'In a 1973 lab notebook, one sentence was crossed out. It described what we are about to show you.',
        rule: 'Open by pointing to a real-sounding record — a notebook, a transcript, a recording, a sealed report — and tease what it contained. Plausible and generic; no fabricated document numbers.',
      },
      {
        name: 'time_anchor_secret',
        example: 'For four hundred years sailors said they saw it. Science quietly confirmed them in 2004.',
        rule: 'Open with a span of time or a date that frames a long-hidden truth, then the moment it was confirmed. Imply almost no one heard.',
      },
    ],
    sectionRoles: [
      'HOOK + PROMISE TAIL. Drop into a specific moment that opens the case. Promise tail teases what the investigation will reveal.',
      'FIRST REPORT. What was originally reported, observed, or recorded. Specifics: who, when, where, what instrument.',
      'SKEPTICS. How it was dismissed at the time. The alternative explanations that did not survive.',
      'HARD EVIDENCE. The measurement, recording, or specimen that could not be argued away.',
      'INDEPENDENT CONFIRMATION. A second team, a second instrument, a second source that corroborated the original report.',
      'CURRENT CONSENSUS. What the field now quietly agrees on, even if the public has not heard.',
      'CLOSING IMPLICATION. The part still unexplained. One line. Leave it open.',
    ],
    toneInstruction:
      'Investigative journalist writing a case file. Cool. Restrained. Cite when, where, who, what instrument. The viewer feels they are reading from a quietly-declassified dossier.',
    titleStyleNote:
      'Investigator-frame. Lanes: "The Recording From [Place/Year]", "Case File: X", "What Was Logged In [Year]", "The Report They Filed And Forgot".',
    musicTags: ['tense investigative ambient', 'documentary cinematic underscore', 'ticking suspense underscore', 'investigative ambient cinematic'],
    stingSubFreq: 42,
    stingTopFreq: 180,
    stingTopDuration: 0.5,
  },
  {
    key: 'expedition_narrative',
    label: 'Expedition Narrative',
    structuralMantra:
      'Tell the story of a single discovery, expedition, or moment chronologically. The viewer rides along as the people involved encounter the unknown step by step.',
    hookPatterns: [
      {
        name: 'scene_in_media_res',
        example: 'It was three in the morning when the cable came back empty, and that should not have been possible.',
        rule: 'Open mid-scene at the moment of discovery. Time, place, sensory detail. No setup.',
      },
      {
        name: 'time_anchor_secret',
        example: 'In the summer of 1958, a small ship anchored over a trench, and nobody on board would talk about what they saw again.',
        rule: 'Anchor a year, a location, an actor — then tease the silence that followed.',
      },
    ],
    sectionRoles: [
      'HOOK + PROMISE TAIL. Open in the scene or the year of the expedition. Promise tail teases what they found.',
      'THE PLACE. Where this happened, what conditions, what was known beforehand.',
      'THE TEAM. Who went, what they were looking for, what tools they had.',
      'THE FIRST CLUE. What they noticed that should not have been there. The first instrument reading that did not fit.',
      'THE OBSTACLE. What almost stopped them. Weather, equipment, doubt, time.',
      'THE DISCOVERY. The moment it became undeniable. Slow it down. Stay in the scene.',
      'AFTERMATH. What it changed. One line of closing implication.',
    ],
    toneInstruction:
      'Narrative documentarian. Past tense. Third person. Cinematic descriptive prose. Specific dates, specific place names. Reads like a New Yorker long-read condensed to nine minutes.',
    titleStyleNote:
      'Expedition-frame. Lanes: "The Expedition That [Quietly Confirmed/Found] X", "What They Found In [Place/Year]", "[Year]: When Someone Saw X", "The Voyage No One Talks About".',
    musicTags: ['cinematic ambient documentary', 'organic ambient drone', 'expedition cinematic underscore', 'earth nature cinematic'],
    stingSubFreq: 46,
    stingTopFreq: 200,
    stingTopDuration: 0.55,
  },
  {
    key: 'layered_explainer',
    label: 'Layered Explainer',
    structuralMantra:
      'Onion-peel. Each section is a deeper layer of "what is actually going on". The viewer thinks they understand at the end of every layer, then the next layer changes the picture.',
    hookPatterns: [
      {
        name: 'name_drop_mystery',
        example: 'Its name is Osedax. It has no mouth, no stomach, no anus — and it eats whales.',
        rule: 'Open by naming the subject directly and stacking its strangest contradictions in one breath. No question, no buildup.',
      },
      {
        name: 'sensory_paradox',
        example: 'It is colder than space, denser than lead, and the universe is full of it.',
        rule: 'Open by stacking three contradictions about the subject in a single sentence.',
      },
    ],
    sectionRoles: [
      'HOOK + PROMISE TAIL. Name the subject + one-line paradox. Promise tail teases that the layers go deeper than the viewer thinks.',
      'SURFACE LAYER. What most people would say if asked. The textbook one-liner. Treat it as if it is enough.',
      'LAYER TWO. The actual mechanism beneath the surface explanation. What the textbook leaves out.',
      'LAYER THREE. The constraint or rule that makes the mechanism work. Why it had to evolve / form this way.',
      'LAYER FOUR. The thing about that constraint nobody mentions. The deepest layer that quietly breaks expectation.',
      'WIDER IMPLICATION. How this deepest layer changes how you see related things in the same field.',
      'CLOSING IMPLICATION. A quiet line that lingers. One sentence.',
    ],
    toneInstruction:
      'Knowing teacher who has peeled this apart many times. Patient, methodical, each section a deeper floor of a building you are walking down. Never condescending. Never breathless.',
    titleStyleNote:
      'Explainer-frame. Lanes: "How X Actually Works", "Why X Is Not What You Think", "Beneath The Surface Of X", "What X Looks Like Four Layers Down".',
    musicTags: ['cerebral ambient cinematic', 'minimal cinematic curious', 'investigative ambient cinematic', 'science documentary underscore'],
    stingSubFreq: 50,
    stingTopFreq: 220,
    stingTopDuration: 0.45,
  },
  {
    key: 'profile_protagonist',
    label: 'Profile',
    structuralMantra:
      'Treat the subject — creature, object, place, phenomenon — as a protagonist. The viewer should leave knowing it like a character, not a list of facts.',
    hookPatterns: [
      {
        name: 'name_drop_mystery',
        example: 'Its name is Mola tecta. It was hiding in plain sight for two hundred years.',
        rule: 'Open by naming the subject and stacking its strangest contradictions in one breath.',
      },
      {
        name: 'forbidden_claim',
        example: 'There is an animal that grows a new set of organs every spring, and most biology classes never mention it.',
        rule: 'Open with a single matter-of-fact statement that sounds impossible AND hints it has been ignored.',
      },
    ],
    sectionRoles: [
      'HOOK + PROMISE TAIL. Name the subject + a paradox. Promise tail teases its strangeness.',
      'WHERE IT LIVES. Habitat, when it appears, what conditions favor it.',
      'WHAT IT IS. Body plan, classification, what it resembles, what it is not.',
      'WHAT IT DOES THAT SHOULD NOT WORK. Its signature impossible behavior, in one specific scene.',
      'HOW IT DOES IT. The mechanism. The contradiction with expected biology/physics. Specifics.',
      'HOW LONG IT HAS BEEN HERE. Temporal scale. When it evolved, when it was discovered, when it was first described.',
      'CLOSING IMPLICATION. Why almost no one knows it exists. Leave on a quiet line.',
    ],
    toneInstruction:
      'Character-profile narration. The subject is the protagonist. Specific anatomy, specific environment, specific behaviors. Reads like a nature-doc profile crossed with a cryptid biography.',
    titleStyleNote:
      'Profile-frame. Lanes: "X: The Creature That [Should Not Exist]", "Meet The X That [Quietly Breaks Biology]", "The X You Were Never Taught About".',
    musicTags: ['cinematic wildlife', 'organic ambient documentary', 'mysterious cinematic underscore', 'documentary cinematic underscore'],
    stingSubFreq: 40,
    stingTopFreq: 170,
    stingTopDuration: 0.6,
  },
];

export function pickFromArray<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

// The channel uses ONE fixed narrator ("主角") for brand consistency.
// Per-episode variety comes from the tone/prosody preset instead (see pickTone).
// Override with VOICE_ID env if the narrator ever needs to change.
export const FIXED_VOICE_ID = process.env.VOICE_ID?.trim() || 'en-US-AndrewNeural';

export function pickVoice(): Voice {
  return VOICE_POOL.find((v) => v.id === FIXED_VOICE_ID) ?? VOICE_POOL[0]!;
}

// Tone presets vary the SAME voice's delivery per episode via SSML prosody
// (rate = speaking speed, pitch = relative pitch). Same narrator, different mood.
export type Tone = {
  key: string;
  label: string;
  rate: string;
  pitch: string;
};

export const TONE_POOL: Tone[] = [
  { key: 'measured', label: 'Measured (slow, grounded)', rate: '-7%', pitch: '-2Hz' },
  { key: 'neutral', label: 'Neutral (steady)', rate: '-2%', pitch: '+0Hz' },
  { key: 'intimate', label: 'Intimate (hushed, close)', rate: '-9%', pitch: '-4Hz' },
  { key: 'urgent', label: 'Urgent (brisk, driving)', rate: '+5%', pitch: '+1Hz' },
  { key: 'bright', label: 'Bright (lively, lifted)', rate: '+1%', pitch: '+3Hz' },
];

// Picks a tone at random but never repeats the previous run's tone, so back-to-back
// episodes from the same narrator still feel different. Persisted like thumb layout.
const LAST_TONE_FILE = path.join(WORK_DIR, '.last-tone');

export function pickTone(): Tone {
  const override = process.env.TONE_KEY?.trim();
  if (override) {
    const found = TONE_POOL.find((t) => t.key === override);
    if (found) return found;
  }
  let last: string | null = null;
  try {
    last = fs.readFileSync(LAST_TONE_FILE, 'utf-8').trim();
  } catch {
    // No previous run recorded — fall through to the full pool.
  }
  const pool = TONE_POOL.filter((t) => t.key !== last);
  const chosen = pickFromArray(pool.length > 0 ? pool : TONE_POOL);
  try {
    fs.mkdirSync(WORK_DIR, { recursive: true });
    fs.writeFileSync(LAST_TONE_FILE, chosen.key, 'utf-8');
  } catch {
    // Persistence is best-effort.
  }
  return chosen;
}

export function pickStructure(): Structure {
  const override = process.env.STRUCTURE_KEY;
  if (override) {
    const found = STRUCTURE_POOL.find((s) => s.key === override);
    if (found) return found;
  }
  return pickFromArray(STRUCTURE_POOL);
}

// Picks a thumbnail layout at random but never repeats the one used on the
// previous run, so consecutive episodes always look visually distinct. The
// last choice is persisted in a tiny state file under WORK_DIR. The read/persist
// pair is shared with the CTR-weighted picker (thumbLayoutStats.ts) so both
// selection paths honor the same no-repeat state.
const LAST_THUMB_LAYOUT_FILE = path.join(WORK_DIR, '.last-thumb-layout');

export function readLastThumbLayout(): string | null {
  try {
    return fs.readFileSync(LAST_THUMB_LAYOUT_FILE, 'utf-8').trim();
  } catch {
    return null;
  }
}

export function persistLastThumbLayout(layout: ThumbLayout): void {
  try {
    fs.mkdirSync(WORK_DIR, { recursive: true });
    fs.writeFileSync(LAST_THUMB_LAYOUT_FILE, layout, 'utf-8');
  } catch {
    // Persistence is best-effort; a failure just means the next run may repeat.
  }
}

export function pickThumbLayout(): ThumbLayout {
  const last = readLastThumbLayout();
  const pool = THUMB_LAYOUTS.filter((l) => l !== last);
  const chosen = pickFromArray(pool.length > 0 ? pool : THUMB_LAYOUTS);
  persistLastThumbLayout(chosen);
  return chosen;
}

// --- Series rotation ---------------------------------------------------------
// Fixed weekday schedule (themed days). Each UTC publish day maps to exactly
// one active series via WEEKDAY_SERIES_MAP: Mon = animals, Wed = insects,
// Fri = plants. Deterministic, state-free, trivially testable. Overrides:
//   - SERIES_KEY env: trending-event injection — forces any defined series.
//   - WEEKDAY env: forces a specific UTC weekday's mapping (manual dispatch).
// A non-publish-day manual run with no override falls back to a day-of-month
// rotation over the active pool, so a stray run still stays on positioning.

export function seriesForToday(): Series {
  // 1. Hard override for trending-event injection (manual dispatch).
  const seriesKey = process.env.SERIES_KEY?.trim();
  if (seriesKey) {
    const found = SERIES_POOL.find((s) => s.key === seriesKey);
    if (found) return found;
  }

  // 2. Resolve which UTC weekday to schedule for — a forced WEEKDAY env or today.
  const weekdayEnv = process.env.WEEKDAY?.trim();
  const utcDay =
    weekdayEnv && !Number.isNaN(Number(weekdayEnv))
      ? Number(weekdayEnv)
      : new Date().getUTCDay();

  // 3. Fixed weekday → series mapping for that publish day.
  const mappedKey = WEEKDAY_SERIES_MAP[utcDay];
  if (mappedKey) {
    const found = ACTIVE_SERIES_POOL.find((s) => s.key === mappedKey);
    if (found) return found;
  }

  // 4. Fallback: non-publish-day manual run. Rotate the active pool by
  //    day-of-month so a stray run still produces an on-positioning topic.
  const fallbackIdx = new Date().getUTCDate() % ACTIVE_SERIES_POOL.length;
  return ACTIVE_SERIES_POOL[fallbackIdx]!;
}

export function pickSubTheme(series: Series): string {
  const override = process.env.SUB_THEME?.trim();
  if (override) return override;
  return pickFromArray(series.subThemes);
}
