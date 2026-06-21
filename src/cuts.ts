import type { WordTiming } from './types.js';

const MIN_CLIP_SEC = 2.2;
const MAX_CLIP_SEC = 5.5;

// --- Narrative-arc shot pacing -------------------------------------------------
// A good editor doesn't cut on a metronome. The opening is patient (let the
// world settle), the body builds, the penultimate beat quickens into the reveal
// like a montage, and the finale breathes again. We express that as
// seconds-per-shot per section; the b-roll fetch turns it into a clip count and
// computeCutTimes lays the cuts on sentence boundaries within that budget. The
// effect is real because clip count — not computeCutTimes — sets the cadence:
// a faster section simply fetches more shots over the same narration.
const SLOW_HOLD_MULT = 1.26; // patient opening hold
const FAST_HOLD_MULT = 0.74; // quickest montage hold
const ARC_PEAK = 0.78; // where the episode peaks (penultimate section)
const FINALE_ENERGY = 0.45; // the close still has life, but slows to breathe

/**
 * Seconds each b-roll shot should hold for the section at `index` of `count`,
 * scaled from `base` along the episode's narrative arc. Energy ramps from the
 * calm open up to a montage peak near ARC_PEAK, then eases back for the finale.
 * Pure (unit-tested); returns `base` unchanged for a single-section episode.
 */
export function sectionClipSeconds(index: number, count: number, base: number): number {
  if (count <= 1 || base <= 0) return base;
  const p = index / (count - 1);
  const energyRaw =
    p <= ARC_PEAK
      ? p / ARC_PEAK
      : 1 - (1 - FINALE_ENERGY) * ((p - ARC_PEAK) / (1 - ARC_PEAK));
  const energy = Math.max(0, Math.min(1, energyRaw));
  const mult = SLOW_HOLD_MULT - (SLOW_HOLD_MULT - FAST_HOLD_MULT) * energy;
  return Math.round(base * mult * 10) / 10;
}

function endsSentence(text: string): boolean {
  return /[.!?]["')\]]?$/.test(text);
}

/**
 * Compute b-roll cut times for a section.
 *
 * Goal: each cut lands on a sentence boundary (word ending in . ! ?) so the
 * visual change reinforces the narrative beat. Falls back to even division
 * when there aren't enough sentence boundaries to feed every clip.
 *
 * Returns the START time of every clip, including the leading 0.
 * Length is always equal to clipCount.
 */
export function computeCutTimes(
  words: WordTiming[],
  totalSec: number,
  clipCount: number,
): number[] {
  const n = Math.max(1, clipCount);
  if (n === 1 || words.length === 0) return [0];

  const sentenceEnds: number[] = [];
  for (const w of words) {
    if (endsSentence(w.text)) sentenceEnds.push(w.end);
  }

  const starts: number[] = [0];
  let lastStart = 0;
  for (const t of sentenceEnds) {
    if (starts.length >= n) break;
    const gap = t - lastStart;
    const remaining = totalSec - t;
    const slotsLeft = n - starts.length;
    if (gap < MIN_CLIP_SEC) continue;
    if (gap > MAX_CLIP_SEC) {
      const mid = lastStart + Math.min(MAX_CLIP_SEC, gap / 2);
      starts.push(Math.min(mid, t - 0.05));
      lastStart = starts[starts.length - 1]!;
      if (starts.length >= n) break;
    }
    if (remaining < MIN_CLIP_SEC * (slotsLeft - 1)) continue;
    starts.push(t);
    lastStart = t;
  }

  while (starts.length < n) {
    const slot = totalSec / n;
    const next = slot * starts.length;
    if (next - starts[starts.length - 1]! < MIN_CLIP_SEC) {
      starts.push(starts[starts.length - 1]! + MIN_CLIP_SEC);
    } else {
      starts.push(next);
    }
  }

  return starts.slice(0, n).map((s) => Math.max(0, Math.min(s, totalSec - 0.05)));
}

/**
 * Pick which b-roll slots should render as a near-motionless STILL (rest beat)
 * so the eye gets a pause between moving shots (long-form anti-fatigue). Returns
 * the chosen slot indices, ascending.
 *
 * Conservative by design: never slot 0 (the cold-open/establishing shot), never
 * a card slot, never a slot whose narration window speaks a number (those beats
 * carry the accent push-in), and nothing at all unless the section has at least
 * `minClips` shots. Among the eligible slots it prefers the longest holds (a
 * still reads best when it lingers), tie-broken by earliest index. Pure
 * (unit-tested); does no I/O — the caller fetches the actual still image.
 */
export function pickRestSlots(opts: {
  clipCount: number;
  cutTimes: number[];
  totalSec: number;
  words: WordTiming[];
  cardSlots?: boolean[];
  maxStills?: number;
  minClips?: number;
}): number[] {
  const { clipCount, cutTimes, totalSec, words } = opts;
  const maxStills = Math.max(0, opts.maxStills ?? 1);
  const minClips = opts.minClips ?? 3;
  if (maxStills === 0 || clipCount < minClips) return [];
  const slotHasNumber = (i: number): boolean => {
    const start = cutTimes[i] ?? 0;
    const end = i + 1 < cutTimes.length ? cutTimes[i + 1]! : totalSec;
    return words.some((w) => w.start >= start - 0.1 && w.start < end && /\d/.test(w.text));
  };
  const candidates: Array<{ idx: number; hold: number }> = [];
  for (let i = 1; i < clipCount; i++) {
    // never slot 0
    if (opts.cardSlots?.[i]) continue; // never a card slot
    if (slotHasNumber(i)) continue; // never a number/accent beat
    const start = cutTimes[i] ?? 0;
    const end = i + 1 < cutTimes.length ? cutTimes[i + 1]! : totalSec;
    candidates.push({ idx: i, hold: end - start });
  }
  if (candidates.length === 0) return [];
  candidates.sort((a, b) => b.hold - a.hold || a.idx - b.idx); // longest hold, tie earliest
  return candidates.slice(0, maxStills).map((c) => c.idx).sort((a, b) => a - b);
}
