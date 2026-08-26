import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BROLL_STAT_KEYS,
  bumpBrollStat,
  emptyBrollStats,
  formatBrollStats,
  resetBrollStats,
  snapshotBrollStats,
} from '../src/brollStats.ts';

test('emptyBrollStats has every key at zero', () => {
  const s = emptyBrollStats();
  for (const k of BROLL_STAT_KEYS) assert.equal(s[k], 0);
});

test('reset then snapshot is all zeros', () => {
  resetBrollStats();
  assert.deepEqual(snapshotBrollStats(), emptyBrollStats());
});

test('bump accumulates and reset clears', () => {
  resetBrollStats();
  bumpBrollStat('visionDrop');
  bumpBrollStat('visionDrop');
  bumpBrollStat('commonsFill', 3);
  const s = snapshotBrollStats();
  assert.equal(s.visionDrop, 2);
  assert.equal(s.commonsFill, 3);
  assert.equal(s.unsplashFill, 0);
  resetBrollStats();
  assert.equal(snapshotBrollStats().visionDrop, 0);
});

test('bump ignores non-positive counts (empty filter, no negatives)', () => {
  resetBrollStats();
  bumpBrollStat('cardFired', 0);
  bumpBrollStat('restStill', -2);
  const s = snapshotBrollStats();
  assert.equal(s.cardFired, 0);
  assert.equal(s.restStill, 0);
});

test('snapshot is a copy — mutating it does not affect the counter', () => {
  resetBrollStats();
  bumpBrollStat('heroSegment', 4);
  const snap = snapshotBrollStats();
  snap.heroSegment = 999;
  assert.equal(snapshotBrollStats().heroSegment, 4);
});

test('formatBrollStats names only the nets that fired', () => {
  const s = emptyBrollStats();
  s.visionDrop = 2;
  s.commonsFill = 1;
  s.heroSegment = 4;
  const line = formatBrollStats(s);
  assert.match(line, /vision-drop×2/);
  assert.match(line, /commons×1/);
  assert.match(line, /hero-seg×4/);
  assert.doesNotMatch(line, /unsplash/);
  assert.doesNotMatch(line, /rest-stills/);
});

test('formatBrollStats reports the all-idle happy path explicitly', () => {
  assert.match(formatBrollStats(emptyBrollStats()), /none fired/);
});

test('formatBrollStats keeps hero-seg and its dropped variant distinct', () => {
  const s = emptyBrollStats();
  s.heroSegment = 3;
  s.heroSegmentDropped = 1;
  const line = formatBrollStats(s);
  assert.match(line, /hero-seg×3/);
  assert.match(line, /hero-seg-dropped×1/);
});
