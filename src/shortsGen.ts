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
// End card (subscribe + watch full video) shown after the narration ends so the
// short doesn't cut off abruptly.
const OUTRO_SEC = 2.6;

export function planShortsForToday(weekdayUtc: number): ShortsPlanEntry[] {
  const override = process.env.SHORTS_PLAN_WEEKDAY;
  const effective = override !== undefined ? Number.parseInt(override, 10) : weekdayUtc;
  if (override !== undefined) {
    log(`Shorts: SHORTS_PLAN_WEEKDAY=${override} overrides real UTC weekday ${weekdayUtc}`);
  }
  switch (effective) {
    case 1:
      return [{ sectionIdx: 0, daysAhead: 1 }];
    case 3:
      return [
        { sectionIdx: 0, daysAhead: 1 },
        { sectionIdx: 4, daysAhead: 2 },
      ];
    case 6:
      return [{ sectionIdx: 0, daysAhead: 1 }];
    default:
      return [];
  }
}

export function publishAtFor(daysAhead: number, baseDate: Date = new Date()): Date {
  const d = new Date(baseDate);
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(PUBLISH_HOUR_UTC, 0, 0, 0);
  return d;
}

function trimToBoundary(
  words: WordTiming[],
  maxSec: number,
): { words: WordTiming[]; endSec: number } {
  const sentenceEnders = /[.!?]$/;
  let lastSentence = -1;
  for (let i = 0; i < words.length; i++) {
    if (words[i]!.end > maxSec) break;
    if (sentenceEnders.test(words[i]!.text)) lastSentence = i;
  }
  if (lastSentence >= 0) {
    const slice = words.slice(0, lastSentence + 1);
    const endSec = slice[slice.length - 1]!.end + 0.3;
    return { words: slice, endSec: Math.min(endSec, MAX_SHORTS_SEC + 0.5) };
  }
  const slice = words.filter((w) => w.end <= maxSec);
  const endSec = slice.length > 0 ? slice[slice.length - 1]!.end + 0.3 : maxSec;
  return { words: slice, endSec: Math.min(endSec, MAX_SHORTS_SEC + 0.5) };
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

export function buildShortsManifest(
  long: RenderManifest,
  _longEpisode: Episode,
  entry: ShortsPlanEntry,
): ShortsManifest | null {
  const section = long.sections[entry.sectionIdx];
  if (!section) {
    log(`Shorts: section ${entry.sectionIdx} not found, skipping.`);
    return null;
  }

  const cap = Math.min(section.duration, MAX_SHORTS_SEC);
  const { words: trimmedWords, endSec } = trimToBoundary(section.words, cap);
  const narrationSec = Math.max(8, Math.min(endSec, section.duration, MAX_SHORTS_SEC + 0.5));
  const duration = narrationSec + OUTRO_SEC;
  const { brollPaths: trimmedBroll, cutTimes: trimmedCuts } = trimClips(
    section.brollPaths,
    section.cutTimes,
    narrationSec,
  );

  const hookText = entry.sectionIdx === 0 ? long.hook : section.heading;
  const shortsTitle = truncate(`${hookText} #Shorts`, 100);

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
