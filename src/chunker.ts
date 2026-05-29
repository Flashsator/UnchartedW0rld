import type { WordTiming } from './types.js';

export type Cue = {
  start: number;
  end: number;
  text: string;
};

const MAX_WORDS = 4;
const MIN_WORDS = 2;
const GAP_BREAK_SEC = 0.22;
const STRONG_PUNCT = /[.!?…]$/;
const SOFT_PUNCT = /[,;:—–-]$/;

function shouldBreakAfter(words: WordTiming[], i: number, currentLen: number): boolean {
  if (i >= words.length - 1) return true;
  if (currentLen >= MAX_WORDS) return true;
  if (currentLen < MIN_WORDS) return false;

  const cur = words[i]!;
  const next = words[i + 1]!;
  const text = cur.text.trim();

  if (STRONG_PUNCT.test(text)) return true;
  if (SOFT_PUNCT.test(text) && currentLen >= MIN_WORDS) return true;
  if (next.start - cur.end > GAP_BREAK_SEC && currentLen >= MIN_WORDS) return true;

  return false;
}

export function chunkWords(words: WordTiming[]): Cue[] {
  if (words.length === 0) return [];
  const cues: Cue[] = [];
  let bucket: WordTiming[] = [];

  for (let i = 0; i < words.length; i++) {
    bucket.push(words[i]!);
    if (shouldBreakAfter(words, i, bucket.length)) {
      const text = bucket.map((w) => w.text).join(' ').replace(/\s+([,.!?;:])/g, '$1');
      cues.push({
        start: bucket[0]!.start,
        end: bucket[bucket.length - 1]!.end,
        text,
      });
      bucket = [];
    }
  }

  if (bucket.length > 0) {
    const text = bucket.map((w) => w.text).join(' ').replace(/\s+([,.!?;:])/g, '$1');
    cues.push({
      start: bucket[0]!.start,
      end: bucket[bucket.length - 1]!.end,
      text,
    });
  }

  return cues;
}
