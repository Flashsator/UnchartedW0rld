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
