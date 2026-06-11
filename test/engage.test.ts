import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractFullVideoUrl,
  fallbackComment,
  isCommentTarget,
  loadCommentedIds,
  saveCommentedIds,
} from '../src/engage.ts';

const NOW = new Date('2026-06-11T13:00:00Z');

function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 86_400_000).toISOString();
}

// --- extractFullVideoUrl --------------------------------------------------------

test('extracts the long-video URL from a Short description funnel line', () => {
  const description = 'Wild stuff!\n\n▶ Full video: https://youtu.be/abc123XYZ_-\n\n#shorts';
  assert.equal(extractFullVideoUrl(description), 'https://youtu.be/abc123XYZ_-');
});

test('returns null when the description has no funnel line', () => {
  assert.equal(extractFullVideoUrl('Just a long-form description with chapters.'), null);
  assert.equal(extractFullVideoUrl(''), null);
});

// --- fallbackComment ------------------------------------------------------------

test('fallback comment carries the funnel link when there is one', () => {
  const withLink = fallbackComment('https://youtu.be/abc');
  assert.ok(withLink.includes('https://youtu.be/abc'));
  assert.ok(withLink.includes('?'));
});

test('fallback comment without a link is still a question', () => {
  const noLink = fallbackComment(null);
  assert.ok(noLink.includes('?'));
  assert.ok(!noLink.includes('http'));
});

// --- isCommentTarget ------------------------------------------------------------

test('targets a recent public video not yet commented on', () => {
  const v = { id: 'v1', privacyStatus: 'public', publishedAt: daysAgo(1) };
  assert.equal(isCommentTarget(v, new Set(), NOW, 7), true);
});

test('skips private and scheduled videos', () => {
  const base = { id: 'v1', publishedAt: daysAgo(1) };
  assert.equal(isCommentTarget({ ...base, privacyStatus: 'private' }, new Set(), NOW, 7), false);
  assert.equal(isCommentTarget({ ...base, privacyStatus: undefined }, new Set(), NOW, 7), false);
});

test('skips already-commented videos', () => {
  const v = { id: 'v1', privacyStatus: 'public', publishedAt: daysAgo(1) };
  assert.equal(isCommentTarget(v, new Set(['v1']), NOW, 7), false);
});

test('skips videos older than the recency window', () => {
  const v = { id: 'v1', privacyStatus: 'public', publishedAt: daysAgo(8) };
  assert.equal(isCommentTarget(v, new Set(), NOW, 7), false);
});

test('skips videos with a future publish time or missing publishedAt', () => {
  const future = { id: 'v1', privacyStatus: 'public', publishedAt: daysAgo(-1) };
  assert.equal(isCommentTarget(future, new Set(), NOW, 7), false);
  const missing = { id: 'v2', privacyStatus: 'public' };
  assert.equal(isCommentTarget(missing, new Set(), NOW, 7), false);
});

// --- State file round-trip --------------------------------------------------------

test('commented-ids state file round-trips and missing file reads as empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engage-test-'));
  const file = path.join(dir, '.commented-videos');
  try {
    assert.deepEqual([...loadCommentedIds(file)], []);
    saveCommentedIds(new Set(['a', 'b']), file);
    assert.deepEqual([...loadCommentedIds(file)].sort(), ['a', 'b']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
