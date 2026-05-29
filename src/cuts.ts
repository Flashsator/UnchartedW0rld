import type { WordTiming } from './types.js';

const MIN_CLIP_SEC = 2.2;
const MAX_CLIP_SEC = 5.5;

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
