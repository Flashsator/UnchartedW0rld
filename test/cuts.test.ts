import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCutTimes, pickRestSlots, sectionClipSeconds } from '../src/cuts.js';
import type { WordTiming } from '../src/types.js';

function words(texts: string[], wordDur = 0.5): WordTiming[] {
  let t = 0;
  return texts.map((text) => {
    const start = t;
    t += wordDur;
    return { start, end: t, text };
  });
}

test('single clip returns just the leading zero', () => {
  assert.deepEqual(computeCutTimes(words(['a', 'b.', 'c']), 30, 1), [0]);
});

test('empty words returns a single zero start', () => {
  assert.deepEqual(computeCutTimes([], 30, 4), [0]);
});

test('always returns exactly clipCount starts', () => {
  for (const n of [1, 2, 3, 5, 8]) {
    const out = computeCutTimes(words(['a.', 'b.', 'c.', 'd.', 'e.', 'f.']), 30, n);
    assert.equal(out.length, n, `expected ${n} starts`);
  }
});

test('starts are ascending, begin at 0, and stay within bounds', () => {
  const totalSec = 24;
  const out = computeCutTimes(
    words(['one.', 'two.', 'three.', 'four.', 'five.', 'six.', 'seven.', 'eight.']),
    totalSec,
    5,
  );
  assert.equal(out[0], 0);
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i]! >= out[i - 1]!, `not ascending at ${i}: ${out.join(',')}`);
    assert.ok(out[i]! <= totalSec - 0.05, `out of bounds at ${i}`);
  }
});

test('sectionClipSeconds returns base for a single-section episode', () => {
  assert.equal(sectionClipSeconds(0, 1, 5), 5);
  assert.equal(sectionClipSeconds(0, 0, 5), 5);
});

test('sectionClipSeconds peaks faster than the opening and finale', () => {
  const count = 6;
  const open = sectionClipSeconds(0, count, 5);
  const peak = sectionClipSeconds(Math.round((count - 1) * 0.78), count, 5);
  const finale = sectionClipSeconds(count - 1, count, 5);
  // The opening holds the longest, the penultimate beat cuts fastest, and the
  // finale eases back to somewhere between the two.
  assert.ok(open > peak, `open (${open}) should hold longer than peak (${peak})`);
  assert.ok(finale > peak, `finale (${finale}) should hold longer than peak (${peak})`);
  assert.ok(finale < open, `finale (${finale}) should be tighter than open (${open})`);
});

test('sectionClipSeconds stays within a sane band around the base', () => {
  const count = 8;
  for (let i = 0; i < count; i++) {
    const s = sectionClipSeconds(i, count, 5);
    assert.ok(s >= 5 * 0.7 && s <= 5 * 1.3, `clipSec ${s} out of band at section ${i}`);
  }
});

test('pickRestSlots returns [] when the section has fewer than minClips shots', () => {
  const out = pickRestSlots({ clipCount: 2, cutTimes: [0, 5], totalSec: 10, words: [], minClips: 3 });
  assert.deepEqual(out, []);
});

test('pickRestSlots returns [] when maxStills is 0', () => {
  const out = pickRestSlots({
    clipCount: 4,
    cutTimes: [0, 2, 4, 6],
    totalSec: 8,
    words: [],
    maxStills: 0,
  });
  assert.deepEqual(out, []);
});

test('pickRestSlots never picks slot 0 even when it holds longest', () => {
  // Slot 0 has by far the longest hold (8s) but must be excluded.
  const out = pickRestSlots({
    clipCount: 4,
    cutTimes: [0, 8, 9, 10],
    totalSec: 12,
    words: [],
  });
  assert.ok(!out.includes(0), `slot 0 must never be a rest still: ${out.join(',')}`);
  assert.deepEqual(out, [3]); // slot 3 holds longest (2s) among 1..3
});

test('pickRestSlots picks the longest-held eligible slot', () => {
  const out = pickRestSlots({
    clipCount: 4,
    cutTimes: [0, 1, 5, 6],
    totalSec: 8,
    words: [],
  });
  assert.deepEqual(out, [1]); // slot 1 holds 4s, the longest
});

test('pickRestSlots skips card slots', () => {
  const out = pickRestSlots({
    clipCount: 4,
    cutTimes: [0, 1, 5, 6],
    totalSec: 8,
    words: [],
    cardSlots: [false, true, false, false], // slot 1 (longest) is a card
  });
  assert.deepEqual(out, [3]); // next-longest non-card slot
});

test('pickRestSlots skips slots whose narration window speaks a number', () => {
  // A digit-bearing word lands inside slot 1's window [1, 5).
  const words: WordTiming[] = [{ start: 2, end: 2.5, text: '500' }];
  const out = pickRestSlots({
    clipCount: 4,
    cutTimes: [0, 1, 5, 6],
    totalSec: 8,
    words,
  });
  assert.deepEqual(out, [3]); // slot 1 excluded as a number beat
});
