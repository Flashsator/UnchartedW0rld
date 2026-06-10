import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAttribution,
  formatImageCredit,
  shortsMusicLine,
} from '../src/attribution.js';
import type { ImageCredit } from '../src/types.js';

const img = (over: Partial<ImageCredit> = {}): ImageCredit => ({
  title: 'Red-billed chough',
  author: 'Jane Doe',
  license: 'CC BY-SA 4.0',
  url: 'https://commons.wikimedia.org/wiki/File:chough',
  ...over,
});

test('formatImageCredit renders title — author (license)', () => {
  assert.equal(formatImageCredit(img()), 'Red-billed chough — Jane Doe (CC BY-SA 4.0)');
});

test('formatImageCredit drops missing parts without dangling punctuation', () => {
  assert.equal(formatImageCredit(img({ author: '', license: '' })), 'Red-billed chough');
  assert.equal(formatImageCredit(img({ author: '' })), 'Red-billed chough (CC BY-SA 4.0)');
  assert.equal(formatImageCredit(img({ license: '' })), 'Red-billed chough — Jane Doe');
});

test('buildAttribution appends a per-image Commons block when images were used', () => {
  const out = buildAttribution(
    [{ title: 'Lens', artist: 'Bobby Richards' }],
    ['Pexels'],
    [img()],
  );
  assert.match(out, /🎵 Music — YouTube Audio Library:/);
  assert.match(out, /🎬 Footage: Pexels \(royalty-free\)\./);
  assert.match(out, /🖼 Images — Wikimedia Commons \(CC\):/);
  assert.match(out, /• Red-billed chough — Jane Doe \(CC BY-SA 4\.0\)/);
});

test('buildAttribution omits the image block entirely when no images were used', () => {
  const out = buildAttribution([{ title: 'Lens', artist: 'Bobby Richards' }], ['Pexels']);
  assert.doesNotMatch(out, /Wikimedia Commons/);
});

test('buildAttribution dedupes a photo reused across beats', () => {
  const out = buildAttribution([], [], [img(), img(), img({ author: 'Other Person' })]);
  const lines = out.split('\n').filter((l) => l.startsWith('• '));
  assert.equal(lines.length, 2);
});

test('shortsMusicLine stays a compact one-liner', () => {
  assert.equal(
    shortsMusicLine({ title: 'Lens', artist: 'Bobby Richards' }),
    '🎵 Lens — Bobby Richards · YouTube Audio Library',
  );
  assert.equal(shortsMusicLine(undefined), '');
});
