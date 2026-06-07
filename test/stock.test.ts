import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocateClipsAcrossBeats, preferredMoods, moodFromPath } from '../src/stock.js';

test('distributes evenly when it divides', () => {
  assert.deepEqual(allocateClipsAcrossBeats(6, 3), [2, 2, 2]);
});

test('gives the remainder to the earliest beats (narration order)', () => {
  assert.deepEqual(allocateClipsAcrossBeats(7, 3), [3, 2, 2]);
  assert.deepEqual(allocateClipsAcrossBeats(8, 3), [3, 3, 2]);
});

test('every beat gets at least one when needed equals beat count', () => {
  assert.deepEqual(allocateClipsAcrossBeats(4, 4), [1, 1, 1, 1]);
});

test('allocation always sums to needed', () => {
  for (const needed of [1, 5, 7, 11, 18]) {
    for (const beats of [1, 2, 3, 4, 6]) {
      const out = allocateClipsAcrossBeats(needed, beats);
      assert.equal(out.length, beats);
      assert.equal(
        out.reduce((a, b) => a + b, 0),
        needed,
        `sum mismatch for needed=${needed} beats=${beats}`,
      );
      assert.ok(
        out.every((n) => n >= 0),
        `negative allocation for needed=${needed} beats=${beats}`,
      );
    }
  }
});

test('zero beats yields an empty allocation', () => {
  assert.deepEqual(allocateClipsAcrossBeats(5, 0), []);
});

test('preferredMoods picks the dominant mood from music tags', () => {
  assert.deepEqual(preferredMoods(['dark cinematic suspense underscore']), ['dark']);
  assert.deepEqual(preferredMoods(['tense investigative ambient']), ['dark']);
});

test('preferredMoods returns empty when nothing matches', () => {
  assert.deepEqual(preferredMoods(['underscore documentary']), []);
  assert.deepEqual(preferredMoods([]), []);
});

test('preferredMoods can return a tie of equally-weighted moods', () => {
  const out = preferredMoods(['epic gentle']); // epic->dramatic, gentle->calm
  assert.deepEqual([...out].sort(), ['calm', 'dramatic']);
});

test('moodFromPath reads the mood folder from an assets-relative path', () => {
  assert.equal(moodFromPath('yt_music/Cinematic-Dramatic/Night Falls - Everet Almond.mp3'), 'dramatic');
  assert.equal(moodFromPath('yt_music/Cinematic-Dark/Down - Joey Pecoraro.mp3'), 'dark');
  assert.equal(moodFromPath('yt_music/Classical-Dark/Toccata in D minor - Bach.mp3'), 'dark');
  assert.equal(moodFromPath('yt_music/Ambient-Calm/Lens - Bobby Richards.mp3'), 'calm');
  assert.equal(moodFromPath('yt_music/Classical-Calm/Some Piece - Someone.mp3'), 'calm');
});

test('moodFromPath returns null outside a recognized mood folder', () => {
  assert.equal(moodFromPath('yt_music/Uncategorized/Track - Artist.mp3'), null);
});
