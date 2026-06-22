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

test('does not fire when the subject is spoken but absent from context', () => {
  // Invariant #1 guard: the word must also appear in the heading/visual context.
  assert.deepEqual(extractIconEvents([w('owl', 1)], 'silent flight at dusk'), []);
});

test('avoidEmojis skips an already-used glyph (no cross-section repeat)', () => {
  const used = new Set(['🦉']);
  assert.deepEqual(extractIconEvents([w('owl', 1)], 'owl hunts', used), []);
});

test('surfaces a DIFFERENT matching subject when the first is already used', () => {
  // Owl already shown earlier; the section also speaks "frog" → surface 🐸,
  // not nothing. Scanning continues past the avoided hit.
  const used = new Set(['🦉']);
  const events = extractIconEvents([w('owl', 1), w('frog', 5)], 'owl frog pond', used);
  assert.deepEqual(events, [{ start: 5, emoji: '🐸' }]);
});

test('accumulating across sections never repeats the same emoji', () => {
  // Mirrors the pipeline IIFE: feed each section's emoji into the avoid set.
  const used = new Set<string>();
  const s1 = extractIconEvents([w('owl', 1)], 'owl forest', used);
  for (const e of s1) used.add(e.emoji);
  const s2 = extractIconEvents([w('owl', 1)], 'owl forest', used);
  for (const e of s2) used.add(e.emoji);

  assert.deepEqual(s1, [{ start: 1, emoji: '🦉' }]);
  assert.deepEqual(s2, []); // owl already used in s1
});

test('cross-section accumulation still lets a fresh subject through', () => {
  const used = new Set<string>();
  const s1 = extractIconEvents([w('owl', 1)], 'owl forest', used);
  for (const e of s1) used.add(e.emoji);
  // Next section speaks owl AND fox; owl is used, fox is fresh → 🦊.
  const s2 = extractIconEvents([w('owl', 1), w('fox', 4)], 'owl fox forest', used);

  assert.deepEqual(s2, [{ start: 4, emoji: '🦊' }]);
});

test('avoidEmojis defaults to empty (backwards compatible)', () => {
  assert.deepEqual(extractIconEvents([w('bee', 2)], 'bee nectar'), [
    { start: 2, emoji: '🐝' },
  ]);
});
