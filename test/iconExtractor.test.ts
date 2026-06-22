import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractIconEvents } from '../src/iconExtractor.ts';
import type { WordTiming } from '../src/types.ts';

function w(text: string, start: number): WordTiming {
  return { text, start, end: start + 0.4 };
}

test('extracts the matching subject when its word is spoken and in context', () => {
  const events = extractIconEvents([w('owl', 1)], 'owl hunts at night');
  assert.deepEqual(events, [{ start: 1, emoji: '🦉' }]);
});

test('an emoji match does NOT also append a motif fallback', () => {
  const events = extractIconEvents([w('owl', 1)], 'owl hunts at night');
  assert.equal(events.length, 1);
  assert.equal(events[0]!.motif, undefined);
});

test('falls back to a motif when the subject is spoken but not in context', () => {
  // Invariant #1 guard still holds: no faithful glyph fires. But instead of going
  // blank, the corner gets an abstract animated motif (no creature).
  const events = extractIconEvents([w('owl', 1)], 'silent flight at dusk');
  assert.equal(events.length, 1);
  assert.equal(events[0]!.emoji, undefined);
  assert.equal(typeof events[0]!.motif, 'number');
  assert.equal(events[0]!.start, 1);
});

test('a deduped section falls back to a motif, not the repeated glyph', () => {
  const used = new Set(['🦉']);
  const events = extractIconEvents([w('owl', 1)], 'owl hunts', used);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.emoji, undefined);
  assert.equal(typeof events[0]!.motif, 'number');
});

test('surfaces a DIFFERENT matching subject when the first is already used', () => {
  // Owl already shown earlier; the section also speaks "frog" → surface 🐸,
  // not a motif. Scanning continues past the avoided hit.
  const used = new Set(['🦉']);
  const events = extractIconEvents([w('owl', 1), w('frog', 5)], 'owl frog pond', used);
  assert.deepEqual(events, [{ start: 5, emoji: '🐸' }]);
});

test('accumulating across sections never repeats the same emoji', () => {
  // Mirrors the pipeline IIFE: feed each section's emoji into the avoid set.
  const used = new Set<string>();
  const s1 = extractIconEvents([w('owl', 1)], 'owl forest', used);
  for (const e of s1) if (e.emoji) used.add(e.emoji);
  const s2 = extractIconEvents([w('owl', 1)], 'owl forest', used);

  assert.deepEqual(s1, [{ start: 1, emoji: '🦉' }]);
  // owl already used in s1 → s2 falls back to a motif, never a second 🦉.
  assert.equal(s2[0]!.emoji, undefined);
  assert.equal(typeof s2[0]!.motif, 'number');
});

test('cross-section accumulation still lets a fresh subject through', () => {
  const used = new Set<string>();
  const s1 = extractIconEvents([w('owl', 1)], 'owl forest', used);
  for (const e of s1) if (e.emoji) used.add(e.emoji);
  // Next section speaks owl AND fox; owl is used, fox is fresh → 🦊 (not a motif).
  const s2 = extractIconEvents([w('owl', 1), w('fox', 4)], 'owl fox forest', used);

  assert.deepEqual(s2, [{ start: 4, emoji: '🦊' }]);
});

test('the motif fallback is deterministic per context and varies across sections', () => {
  const a1 = extractIconEvents([w('alpha', 1)], 'one two three')[0]!.motif;
  const a2 = extractIconEvents([w('alpha', 1)], 'one two three')[0]!.motif;
  const b = extractIconEvents([w('alpha', 1)], 'four five six')[0]!.motif;
  assert.equal(a1, a2); // stable for a given context
  assert.ok(a1! >= 0 && a1! < 4); // within the renderer's motif range
  assert.notEqual(a1, b); // different context → different motif (variety)
});

test('the motif start is seeded from a section word, not the very first', () => {
  const events = extractIconEvents(
    [w('the', 0), w('cold', 2), w('dark', 4), w('deep', 6), w('zone', 8)],
    'no subject here',
  );
  assert.equal(events[0]!.start, 2);
});

test('empty words yields no event even as a fallback', () => {
  assert.deepEqual(extractIconEvents([], 'owl forest'), []);
});

test('avoidEmojis defaults to empty (backwards compatible)', () => {
  assert.deepEqual(extractIconEvents([w('bee', 2)], 'bee nectar'), [
    { start: 2, emoji: '🐝' },
  ]);
});
