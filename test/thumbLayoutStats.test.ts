import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THUMB_LAYOUTS } from '../src/config.ts';
import {
  layoutCtrWeights,
  parseLayoutLog,
  pickWeighted,
  type LayoutLogEntry,
} from '../src/thumbLayoutStats.ts';

const [L0, L1, L2] = [THUMB_LAYOUTS[0]!, THUMB_LAYOUTS[1]!, THUMB_LAYOUTS[2]!];

// --- parseLayoutLog ---------------------------------------------------------------

test('parses videoId<TAB>layout lines and skips malformed ones', () => {
  const entries = parseLayoutLog(`v1\t${L0}\n\nnot-a-line\nv2\t${L1}\n`);
  assert.deepEqual(entries, [
    { videoId: 'v1', layout: L0 },
    { videoId: 'v2', layout: L1 },
  ]);
});

test('drops unknown layouts and keeps the LAST entry per video (rescue re-render wins)', () => {
  const entries = parseLayoutLog(`v1\t${L0}\nv2\tretired_layout\nv1\t${L2}`);
  assert.deepEqual(entries, [{ videoId: 'v1', layout: L2 }]);
});

// --- layoutCtrWeights -------------------------------------------------------------

function entry(videoId: string, layout: (typeof THUMB_LAYOUTS)[number]): LayoutLogEntry {
  return { videoId, layout };
}

test('returns null when no layout has enough measured samples (stay on rotation)', () => {
  assert.equal(layoutCtrWeights([], new Map(), 2), null);
  // One sample per layout, but minSamples is 2.
  const weights = layoutCtrWeights([entry('v1', L0)], new Map([['v1', 5]]), 2);
  assert.equal(weights, null);
});

test('weights a measured layout by its average CTR and gives unproven ones the global mean', () => {
  const entries = [entry('v1', L0), entry('v2', L0), entry('v3', L1)];
  const ctr = new Map([
    ['v1', 6],
    ['v2', 4],
    ['v3', 2],
  ]);
  const weights = layoutCtrWeights(entries, ctr, 2);
  assert.ok(weights);
  // L0 has 2 samples → avg 5. L1 has only 1 (< minSamples) → global mean 4.
  assert.equal(weights.get(L0), 5);
  assert.equal(weights.get(L1), 4);
  // Never-logged layouts also get the optimistic global mean.
  assert.equal(weights.get(L2), 4);
});

test('ignores logged videos that have no measured CTR yet', () => {
  const entries = [entry('v1', L0), entry('v2', L0), entry('unmeasured', L1)];
  const weights = layoutCtrWeights(entries, new Map([['v1', 3], ['v2', 5]]), 2);
  assert.ok(weights);
  assert.equal(weights.get(L0), 4);
});

// --- pickWeighted -----------------------------------------------------------------

test('deterministic rolls land proportionally to weight', () => {
  const weights = new Map([
    [L0, 3],
    [L1, 1],
  ]);
  // total 4: roll 0.5 → 2 falls inside L0's 0-3 span; roll 0.9 → 3.6 inside L1's.
  assert.equal(pickWeighted(weights, null, () => 0.5), L0);
  assert.equal(pickWeighted(weights, null, () => 0.9), L1);
});

test('exclude removes a layout from the draw (no-repeat rule)', () => {
  const weights = new Map([
    [L0, 100],
    [L1, 1],
  ]);
  assert.equal(pickWeighted(weights, L0, () => 0.99), L1);
});

test('an all-excluded pool falls back to the full set instead of crashing', () => {
  const weights = new Map([[L0, 1]]);
  assert.equal(pickWeighted(weights, L0, () => 0.5), L0);
});
