import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCutTimes } from '../src/cuts.js';
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
