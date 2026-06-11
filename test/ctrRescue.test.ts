import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isRescueCandidate,
  median,
  nextRescueLever,
  parseIsoDuration,
  parseRescueState,
  pickRescueTarget,
  seriesForPublishedAt,
  type RescueRow,
} from '../src/ctrRescue.ts';

const NOW = new Date('2026-06-11T13:00:00Z');
const OPTS = { minAgeDays: 2, maxAgeDays: 21, minImpressions: 300 };

function row(partial: Partial<RescueRow> & { videoId: string }): RescueRow {
  return {
    title: partial.videoId,
    publishedAt: new Date(NOW.getTime() - 5 * 86_400_000).toISOString(),
    durationSec: 600,
    impressions: 1000,
    ctr: 4,
    ...partial,
  };
}

// --- parseIsoDuration -------------------------------------------------------------

test('parses ISO 8601 durations to seconds', () => {
  assert.equal(parseIsoDuration('PT9M58S'), 598);
  assert.equal(parseIsoDuration('PT1H2M3S'), 3723);
  assert.equal(parseIsoDuration('PT45S'), 45);
  assert.equal(parseIsoDuration('PT10M'), 600);
});

test('unparsable duration reads as 0 (classified as a Short, safely skipped)', () => {
  assert.equal(parseIsoDuration('P1D'), 0);
  assert.equal(parseIsoDuration(''), 0);
  assert.equal(parseIsoDuration(null), 0);
  assert.equal(parseIsoDuration(undefined), 0);
});

// --- median -----------------------------------------------------------------------

test('median handles odd, even, and empty inputs', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([7]), 7);
  assert.equal(median([]), 0);
});

// --- isRescueCandidate ------------------------------------------------------------

test('accepts a long-form video inside the age window with enough impressions', () => {
  assert.equal(isRescueCandidate(row({ videoId: 'v1' }), new Set(), NOW, OPTS), true);
});

test('rejects shorts (below the long-form duration floor)', () => {
  assert.equal(
    isRescueCandidate(row({ videoId: 'v1', durationSec: 55 }), new Set(), NOW, OPTS),
    false,
  );
});

test('rejects already-rescued videos (one rescue per video, ever)', () => {
  assert.equal(isRescueCandidate(row({ videoId: 'v1' }), new Set(['v1']), NOW, OPTS), false);
});

test('rejects videos with too few impressions (CTR is noise)', () => {
  assert.equal(
    isRescueCandidate(row({ videoId: 'v1', impressions: 100 }), new Set(), NOW, OPTS),
    false,
  );
});

test('rejects videos outside the 2-21 day age window', () => {
  const tooYoung = row({
    videoId: 'v1',
    publishedAt: new Date(NOW.getTime() - 1 * 86_400_000).toISOString(),
  });
  const tooOld = row({
    videoId: 'v2',
    publishedAt: new Date(NOW.getTime() - 30 * 86_400_000).toISOString(),
  });
  assert.equal(isRescueCandidate(tooYoung, new Set(), NOW, OPTS), false);
  assert.equal(isRescueCandidate(tooOld, new Set(), NOW, OPTS), false);
});

// --- pickRescueTarget ---------------------------------------------------------------

test('picks the worst CTR below threshold x median', () => {
  const all = [
    row({ videoId: 'good', ctr: 5 }),
    row({ videoId: 'ok', ctr: 4 }),
    row({ videoId: 'bad', ctr: 2 }),
    row({ videoId: 'worst', ctr: 1 }),
  ];
  // median = 3, cutoff (0.7) = 2.1 → bad and worst qualify; worst wins.
  const target = pickRescueTarget(all, all, 0.7);
  assert.equal(target?.videoId, 'worst');
});

test('returns null when nothing is genuinely underperforming', () => {
  const all = [row({ videoId: 'a', ctr: 4 }), row({ videoId: 'b', ctr: 4.5 })];
  assert.equal(pickRescueTarget(all, all, 0.7), null);
});

test('returns null with no candidates or a zero median', () => {
  assert.equal(pickRescueTarget([], [row({ videoId: 'a' })], 0.7), null);
  const zeros = [row({ videoId: 'a', ctr: 0 }), row({ videoId: 'b', ctr: 0 })];
  assert.equal(pickRescueTarget(zeros, zeros, 0.7), null);
});

// --- seriesForPublishedAt ------------------------------------------------------------

test('recovers the series from the publish weekday (Mon/Wed/Fri themed days)', () => {
  // 2026-06-08 = Monday, 2026-06-10 = Wednesday, 2026-06-12 = Friday.
  assert.equal(seriesForPublishedAt('2026-06-08T19:00:00Z').key, 'animals');
  assert.equal(seriesForPublishedAt('2026-06-10T19:00:00Z').key, 'insects');
  assert.equal(seriesForPublishedAt('2026-06-12T19:00:00Z').key, 'plants');
});

test('falls back to the first active series on a non-publish weekday', () => {
  // 2026-06-07 = Sunday — no mapping; must still return a real series.
  const s = seriesForPublishedAt('2026-06-07T19:00:00Z');
  assert.ok(s.key.length > 0);
});

// --- parseRescueState / nextRescueLever ------------------------------------------------

test('parses videoId<TAB>lever lines, reading bare ids as thumbnail rescues (old format)', () => {
  const records = parseRescueState('v1\tthumbnail\nv2\ttitle\nlegacy-id\n\n');
  assert.deepEqual(records, [
    { videoId: 'v1', lever: 'thumbnail' },
    { videoId: 'v2', lever: 'title' },
    { videoId: 'legacy-id', lever: 'thumbnail' },
  ]);
});

test('lever alternates strictly, starting with thumbnail', () => {
  assert.equal(nextRescueLever(null), 'thumbnail');
  assert.equal(nextRescueLever(undefined), 'thumbnail');
  assert.equal(nextRescueLever('thumbnail'), 'title');
  assert.equal(nextRescueLever('title'), 'thumbnail');
});
