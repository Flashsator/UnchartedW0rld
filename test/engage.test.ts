import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  channelAlreadyCommented,
  extractFullVideoUrl,
  fallbackComment,
  isCommentTarget,
  isShortDuration,
  loadCommentedIds,
  orderCommentTargets,
  parseIsoDurationSec,
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

// --- parseIsoDurationSec / isShortDuration --------------------------------------

test('parses ISO-8601 durations into seconds', () => {
  assert.equal(parseIsoDurationSec('PT58S'), 58);
  assert.equal(parseIsoDurationSec('PT9M42S'), 9 * 60 + 42);
  assert.equal(parseIsoDurationSec('PT1H2M3S'), 3600 + 120 + 3);
  assert.equal(parseIsoDurationSec('PT3M'), 180);
});

test('unparseable duration is 0 (classifies as long, the safe default)', () => {
  assert.equal(parseIsoDurationSec(''), 0);
  assert.equal(parseIsoDurationSec('garbage'), 0);
  assert.equal(isShortDuration(parseIsoDurationSec('garbage')), false);
});

test('isShortDuration draws the line at 180s and rejects 0', () => {
  assert.equal(isShortDuration(58), true);
  assert.equal(isShortDuration(180), true);
  assert.equal(isShortDuration(181), false);
  assert.equal(isShortDuration(600), false);
  assert.equal(isShortDuration(0), false);
});

// --- orderCommentTargets --------------------------------------------------------

test('orders Shorts before long videos, stable within each group', () => {
  const targets = [
    { id: 'long1', isShort: false },
    { id: 'short1', isShort: true },
    { id: 'long2', isShort: false },
    { id: 'short2', isShort: true },
  ];
  assert.deepEqual(
    orderCommentTargets(targets).map((t) => t.id),
    ['short1', 'short2', 'long1', 'long2'],
  );
});

test('orderCommentTargets is a no-op ordering when all one type', () => {
  const shorts = [{ id: 'a', isShort: true }, { id: 'b', isShort: true }];
  assert.deepEqual(orderCommentTargets(shorts).map((t) => t.id), ['a', 'b']);
});

// --- channelAlreadyCommented (live dedupe guard) ---------------------------------

const MINE = 'UC_mine';
function thread(authorId: string) {
  return { snippet: { topLevelComment: { snippet: { authorChannelId: { value: authorId } } } } };
}

test('detects our own channel among the video comment threads', () => {
  const threads = [thread('UC_someone'), thread(MINE), thread('UC_other')];
  assert.equal(channelAlreadyCommented(threads, MINE), true);
});

test('returns false when our channel has not commented', () => {
  const threads = [thread('UC_someone'), thread('UC_other')];
  assert.equal(channelAlreadyCommented(threads, MINE), false);
});

test('returns false for empty threads or an unknown channel id', () => {
  assert.equal(channelAlreadyCommented([], MINE), false);
  assert.equal(channelAlreadyCommented([thread(MINE)], ''), false);
});

test('tolerates malformed thread rows without throwing', () => {
  const threads = [{}, { snippet: {} }, { snippet: { topLevelComment: {} } }, thread(MINE)];
  assert.equal(channelAlreadyCommented(threads, MINE), true);
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
