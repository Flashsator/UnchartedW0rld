import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCutTimes, sectionClipSeconds } from '../src/cuts.js';
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
