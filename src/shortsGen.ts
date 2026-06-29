import type {
  Episode,
  RenderManifest,
  ShortsManifest,
  ShortsPlanEntry,
  WordTiming,
} from './types.js';
import { PUBLISH_HOUR_UTC } from './config.js';
import { log } from './utils.js';

const MAX_SHORTS_SEC = 55;
// A "complete story" Short shorter than this is implausible, so a tiny
// shortsArcSentences marker (e.g. the model marking sentence 1) is treated as
// noise and we fall back to the blind time-based cut instead of shipping a 6s clip.
const MIN_ARC_SEC = 15;
// End-card outro window (seconds) held AFTER the narration ends. The Short's
// final frames show the "Watch the full video + SUBSCRIBE" card (ShortsScene,
// gated on outroSec > 0) so the Short has a deliberate, finished ending instead
// of a hard cut that loops mid-sentence. Any value > 0 also auto-disables the
// loop-back hook re-fade — the end card owns the tail (see ShortsScene
// `hasOutro`). User directive 2026-06-29: the seamless loop (OUTRO_SEC = 0) read
// as "cut off / suddenly interrupted" even once the narration resolved its own
// self-contained arc, so we trade the (never-data-proven) replay-loop benefit
// for a complete-feeling ending plus an on-screen subscribe CTA. The funnel link
// still also lives in the description's "▶ Full video:" line.
const OUTRO_SEC = 2.5;

// Same-day teaser short publishes a couple hours AFTER the long video (which
// lands at PUBLISH_HOUR_UTC) so the two don't split the launch slot and the
// short can funnel viewers back to the already-live long video.
const SAME_DAY_SHORT_HOUR_UTC = PUBLISH_HOUR_UTC + 2;

export function planShortsForToday(weekdayUtc: number): ShortsPlanEntry[] {
  const override = process.env.SHORTS_PLAN_WEEKDAY;
  const effective = override !== undefined ? Number.parseInt(override, 10) : weekdayUtc;
  if (override !== undefined) {
    log(`Shorts: SHORTS_PLAN_WEEKDAY=${override} overrides real UTC weekday ${weekdayUtc}`);
  }
  // Long videos publish Mon/Wed/Fri (1/3/5). Each long-video run produces a
  // same-day teaser short (section 0 = the cold-open hook, staggered ~2h after
  // the long) PLUS shorts dripped onto the off-days from later sections, so
  // every day of the week gets a short and no two reuse the same section:
  //   Mon (animals) → Mon teaser (+0d, sec 0) + Tue short (+1d, sec 3)
  //   Wed (insects) → Wed teaser (+0d, sec 0) + Thu short (+1d, sec 3)
  //   Fri (plants)  → Fri teaser (+0d, sec 0) + Sat (+1d, sec 3) + Sun (+2d, sec 5)
  const sameDayTeaser: ShortsPlanEntry = {
    sectionIdx: 0,
    daysAhead: 0,
    publishHourUtc: SAME_DAY_SHORT_HOUR_UTC,
  };
  switch (effective) {
    case 1:
      return [sameDayTeaser, { sectionIdx: 3, daysAhead: 1 }];
    case 3:
      return [sameDayTeaser, { sectionIdx: 3, daysAhead: 1 }];
    case 5:
      return [
        sameDayTeaser,
        { sectionIdx: 3, daysAhead: 1 },
        { sectionIdx: 5, daysAhead: 2 },
      ];
    default:
      return [];
  }
}

export function publishAtFor(
  daysAhead: number,
  baseDate: Date = new Date(),
  hourUtc: number = PUBLISH_HOUR_UTC,
): Date {
  const d = new Date(baseDate);
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
}

// The index of the WordTiming that ends the nth (1-based) spoken sentence, or -1
// if there are fewer than n sentences. Pure and exported for testing.
export function sentenceEndIndex(words: WordTiming[], n: number): number {
  if (n < 1) return -1;
  const sentenceEnders = /[.!?]$/;
  let count = 0;
  for (let i = 0; i < words.length; i++) {
    if (sentenceEnders.test(words[i]!.text)) {
      count++;
      if (count === n) return i;
    }
  }
  return -1;
}

// When `arcSentences` (the section's shortsArcSentences marker — the sentence by
// which the tease→answer arc COMPLETES) is set and the answer lands within
// [MIN_ARC_SEC, MAX_SHORTS_SEC+0.5], cut exactly there so the Short ends ON the
// answer instead of dragging into the next beat (Lever A). Otherwise fall back to
// the blind "last sentence boundary under maxSec" cut. Exported for testing.
export function trimToBoundary(
  words: WordTiming[],
  maxSec: number,
  arcSentences?: number,
): { words: WordTiming[]; endSec: number } {
  const hardCap = MAX_SHORTS_SEC + 0.5;
  if (arcSentences && arcSentences >= 1) {
    const idx = sentenceEndIndex(words, arcSentences);
    if (idx >= 0) {
      const end = words[idx]!.end;
      if (end >= MIN_ARC_SEC && end <= hardCap) {
        const slice = words.slice(0, idx + 1);
        return { words: slice, endSec: Math.min(end + 0.3, hardCap) };
      }
    }
  }
  const sentenceEnders = /[.!?]$/;
  let lastSentence = -1;
  for (let i = 0; i < words.length; i++) {
    if (words[i]!.end > maxSec) break;
    if (sentenceEnders.test(words[i]!.text)) lastSentence = i;
  }
  if (lastSentence >= 0) {
    const slice = words.slice(0, lastSentence + 1);
    const endSec = slice[slice.length - 1]!.end + 0.3;
    return { words: slice, endSec: Math.min(endSec, hardCap) };
  }
  const slice = words.filter((w) => w.end <= maxSec);
  const endSec = slice.length > 0 ? slice[slice.length - 1]!.end + 0.3 : maxSec;
  return { words: slice, endSec: Math.min(endSec, hardCap) };
}

// Trim b-roll clips and their cut times together so they stay the same length.
// If they desync, ShortsScene falls back to evenly spacing clips across the
// duration, which decouples the visuals from where the narration actually lands.
function trimClips(
  brollPaths: string[],
  cutTimes: number[],
  maxSec: number,
): { brollPaths: string[]; cutTimes: number[] } {
  const pairs = cutTimes
    .map((t, i) => ({ t, path: brollPaths[i] }))
    .filter((p): p is { t: number; path: string } => p.path !== undefined && p.t < maxSec - 0.5);
  if (pairs.length === 0) {
    return { brollPaths: brollPaths.slice(0, 1), cutTimes: [0] };
  }
  return {
    brollPaths: pairs.map((p) => p.path),
    cutTimes: pairs.map((p) => p.t),
  };
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

// The biggest text block on the short is the on-screen title card. A full hook
// sentence (or two) wraps into many lines and covers the frame, so we distil it
// to one punchy thought: take the first sentence, then word-trim to a short cap
// so it lands in ~2 lines at a big, readable size.
const CARD_HOOK_MAX_CHARS = 60;

function compactHook(text: string): string {
  const clean = text.trim().replace(/\s+/g, ' ');
  // First sentence (keep its terminal punctuation — a question hook reads well).
  const firstSentence = clean.match(/^.*?[.!?](?:\s|$)/)?.[0].trim() ?? clean;
  if (firstSentence.length <= CARD_HOOK_MAX_CHARS) return firstSentence;
  // Too long even as one sentence. Prefer cutting at the last clause boundary
  // (comma/semicolon/colon/dash) that fits, so the card reads as a complete
  // thought instead of stopping mid-phrase.
  const clause = firstSentence.slice(0, CARD_HOOK_MAX_CHARS).match(/^.*[,;:—–-]/)?.[0];
  if (clause && clause.length >= 20) {
    return `${clause.replace(/[\s,;:—–-]+$/, '')}…`;
  }
  // No usable clause break — word-trim to the cap and add an ellipsis.
  const words = firstSentence.split(' ');
  let out = '';
  for (const w of words) {
    if ((out ? `${out} ${w}` : w).length > CARD_HOOK_MAX_CHARS - 1) break;
    out = out ? `${out} ${w}` : w;
  }
  return `${(out || firstSentence.slice(0, CARD_HOOK_MAX_CHARS - 1)).trimEnd()}…`;
}

// The first spoken sentence of a section, cleaned of whitespace. Used as a
// subject-named fallback hook for off-day Shorts — it is VERBATIM narration, so
// any number it contains is by definition spoken (invariant #1 holds without a
// separate guard), and unlike the abstract chapter heading it actually names the
// subject and makes a claim a cold viewer can read.
function firstSentence(narration: string): string {
  const clean = (narration ?? '').trim().replace(/\s+/g, ' ');
  if (!clean) return '';
  return clean.match(/^.*?[.!?](?:\s|$)/)?.[0].trim() ?? clean;
}

// Decide the Short's title/card text. Priority:
//  1. the script's purpose-written, subject-named `shortsHook` (already
//     invariant-#1-gated upstream by normalizeShortsHook);
//  2. for the section-0 teaser, the episode cold-open hook (curated, on-subject);
//  3. for off-day sections, the section's FIRST spoken narration sentence — it
//     names the subject and makes a real claim (data finding: subject-first lines
//     win, abstract chapter-heading titles like "When Pollen Leaps the Gap" flop);
//  4. last resort, the episode anchor subject, then the heading only if even that
//     is empty.
// The abstract chapter heading is deliberately NEVER preferred as a Short title.
export function pickShortsHookText(opts: {
  sectionIdx: number;
  shortsHook?: string;
  coldOpenHook: string;
  narration: string;
  heading: string;
  subject?: string;
}): string {
  const hook = opts.shortsHook?.trim();
  if (hook) return hook;
  if (opts.sectionIdx === 0) {
    const cold = opts.coldOpenHook?.trim();
    if (cold) return cold;
  }
  const sentence = firstSentence(opts.narration);
  if (sentence) return sentence;
  const subject = opts.subject?.trim();
  if (subject) return subject;
  return opts.heading?.trim() ?? '';
}

export function buildShortsManifest(
  long: RenderManifest,
  longEpisode: Episode,
  entry: ShortsPlanEntry,
): ShortsManifest | null {
  const section = long.sections[entry.sectionIdx];
  if (!section) {
    log(`Shorts: section ${entry.sectionIdx} not found, skipping.`);
    return null;
  }
  const epSection = longEpisode.sections[entry.sectionIdx];

  const cap = Math.min(section.duration, MAX_SHORTS_SEC);
  // Cut at the section's self-contained tease→answer arc end (Lever A) when the
  // script marked it, so a resolved answer is never chopped; else blind cut.
  const { words: trimmedWords, endSec } = trimToBoundary(
    section.words,
    cap,
    epSection?.shortsArcSentences,
  );
  const narrationSec = Math.max(8, Math.min(endSec, section.duration, MAX_SHORTS_SEC + 0.5));
  const duration = narrationSec + OUTRO_SEC;
  const { brollPaths: trimmedBroll, cutTimes: trimmedCuts } = trimClips(
    section.brollPaths,
    section.cutTimes,
    narrationSec,
  );

  // Title/card text: every section prefers the script's purpose-written
  // standalone shortsHook. Fallbacks NEVER use the abstract chapter heading —
  // that produced flop titles like "When Pollen Leaps the Gap". The teaser
  // (section 0) falls back to the episode cold-open hook; off-day sections fall
  // back to the section's first spoken narration sentence (subject-named, a real
  // claim), then to the episode anchor subject — see pickShortsHookText.
  const hookText = pickShortsHookText({
    sectionIdx: entry.sectionIdx,
    shortsHook: epSection?.shortsHook,
    coldOpenHook: long.hook,
    narration: epSection?.narration ?? '',
    heading: section.heading,
    subject: longEpisode.subject,
  });
  // No "#Shorts" in the title — YouTube classifies Shorts by vertical ratio +
  // duration, not the hashtag, so it only wastes title space that should be a
  // pure curiosity hook. (Description still carries hashtags.)
  const shortsTitle = truncate(hookText, 100);

  const overlays = section.overlays
    ? section.overlays.filter((o) =>
        trimmedWords.some((w) => {
          const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
          return norm(w.text) === norm(o.triggerWord) || norm(w.text).includes(norm(o.triggerWord));
        }),
      )
    : undefined;

  return {
    series: long.series,
    longTitle: long.title,
    shortsTitle,
    hook: hookText,
    cardHook: compactHook(hookText),
    sectionIdx: entry.sectionIdx,
    audioPath: section.audioPath,
    duration,
    narrationSec,
    outroSec: OUTRO_SEC,
    brollPaths: trimmedBroll,
    cutTimes: trimmedCuts,
    words: trimmedWords,
    overlays,
    bgmPath: long.bgmPath,
    bgmVolume: long.bgmVolume,
  };
}
