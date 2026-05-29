import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkWords } from '../src/chunker.js';
import type { WordTiming } from '../src/types.js';

// Build evenly-spaced words; `gap` is the silence inserted before each word.
function words(texts: string[], wordDur = 0.3, gap = 0.05): WordTiming[] {
  let t = 0;
  return texts.map((text) => {
    t += gap;
    const start = t;
    t += wordDur;
    return { start, end: t, text };
  });
}

test('returns empty array for no words', () => {
  assert.deepEqual(chunkWords([]), []);
});

test('never emits a cue longer than the 4-word cap', () => {
  const cues = chunkWords(words(['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight']));
  for (const c of cues) {
    assert.ok(c.text.split(' ').length <= 4, `cue too long: "${c.text}"`);
  }
});

test('breaks on strong punctuation once past the minimum length', () => {
  const cues = chunkWords(words(['alpha', 'beta.', 'gamma', 'delta']));
  assert.equal(cues[0]!.text, 'alpha beta.');
});

test('breaks on a long pause between words', () => {
  const w = words(['quiet', 'pause']);
  // Insert a big gap before a third word so the chunker splits there.
  w.push({ start: w[1]!.end + 1.0, end: w[1]!.end + 1.3, text: 'after' });
  const cues = chunkWords(w);
  assert.equal(cues[0]!.text, 'quiet pause');
  assert.equal(cues[1]!.text, 'after');
});

test('cue timings span their first and last word', () => {
  const w = words(['a', 'b', 'c', 'd']);
  const cues = chunkWords(w);
  assert.equal(cues[0]!.start, w[0]!.start);
  assert.equal(cues[0]!.end, w[3]!.end);
});
