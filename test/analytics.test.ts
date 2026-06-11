import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWatchNextBlock, rankPerformers, type VideoPerformance } from '../src/analytics.ts';

function perf(partial: Partial<VideoPerformance> & { title: string }): VideoPerformance {
  return { videoId: partial.title, views: 0, avgViewPct: 0, ...partial };
}

test('returns empty array when there are no rows', () => {
  // Arrange / Act
  const result = rankPerformers([], 8);
  // Assert
  assert.deepEqual(result, []);
});

test('returns empty array when topN is zero or negative', () => {
  const rows = [perf({ title: 'A', ctr: 10, avgViewPct: 50, views: 100 })];
  assert.deepEqual(rankPerformers(rows, 0), []);
  assert.deepEqual(rankPerformers(rows, -3), []);
});

test('ranks the high-CTR high-retention title first', () => {
  // Arrange — winner leads on the two weighted signals, not just raw views.
  const rows: VideoPerformance[] = [
    perf({ title: 'low all round', ctr: 2, avgViewPct: 20, views: 500 }),
    perf({ title: 'clicks and holds', ctr: 12, avgViewPct: 70, views: 400 }),
    perf({ title: 'mid', ctr: 6, avgViewPct: 45, views: 450 }),
  ];

  // Act
  const ranked = rankPerformers(rows, 3);

  // Assert
  assert.equal(ranked[0], 'clicks and holds');
  assert.equal(ranked.length, 3);
});

test('CTR outweighs raw views (packaging beats a viral fluke)', () => {
  // The high-view title has poor CTR and retention; the lower-view title is
  // strong on both weighted signals and should win.
  const rows: VideoPerformance[] = [
    perf({ title: 'viral fluke', ctr: 1, avgViewPct: 15, views: 100_000 }),
    perf({ title: 'well packaged', ctr: 14, avgViewPct: 65, views: 2_000 }),
  ];

  const ranked = rankPerformers(rows, 2);

  assert.equal(ranked[0], 'well packaged');
});

test('falls back to retention + views when no row has CTR', () => {
  // No ctr field anywhere — the CTR weight must drop out, not crash or NaN.
  const rows: VideoPerformance[] = [
    perf({ title: 'short watch', avgViewPct: 20, views: 300 }),
    perf({ title: 'long watch', avgViewPct: 80, views: 250 }),
  ];

  const ranked = rankPerformers(rows, 2);

  assert.equal(ranked[0], 'long watch');
  assert.equal(ranked.length, 2);
});

test('honors topN by truncating the ranked list', () => {
  const rows: VideoPerformance[] = [
    perf({ title: 'a', ctr: 9, avgViewPct: 60, views: 100 }),
    perf({ title: 'b', ctr: 8, avgViewPct: 55, views: 90 }),
    perf({ title: 'c', ctr: 7, avgViewPct: 50, views: 80 }),
  ];

  assert.equal(rankPerformers(rows, 2).length, 2);
});

test('drops rows with blank titles', () => {
  const rows: VideoPerformance[] = [
    perf({ title: '   ', ctr: 99, avgViewPct: 99, views: 99 }),
    perf({ title: 'real title', ctr: 5, avgViewPct: 40, views: 50 }),
  ];

  const ranked = rankPerformers(rows, 8);

  assert.deepEqual(ranked, ['real title']);
});

// --- buildWatchNextBlock --------------------------------------------------------------

test('builds a Watch next block of long-form links only (Shorts excluded)', () => {
  const performers: VideoPerformance[] = [
    perf({ title: 'Long winner', durationSec: 600 }),
    perf({ title: 'A Short', durationSec: 45 }),
    perf({ title: 'Second long', durationSec: 580 }),
  ];

  const block = buildWatchNextBlock(performers);

  assert.match(block, /^▶ Watch next:/);
  assert.match(block, /Long winner\n {2}https:\/\/youtu\.be\/Long winner/);
  assert.match(block, /Second long/);
  assert.doesNotMatch(block, /A Short/);
});

test('caps the link count and preserves performance order', () => {
  const performers: VideoPerformance[] = ['a', 'b', 'c', 'd'].map((t) =>
    perf({ title: t, durationSec: 600 }),
  );

  const block = buildWatchNextBlock(performers, 2);
  const lines = block.split('\n');

  // Header + 2 × (title line + url line).
  assert.equal(lines.length, 5);
  assert.match(lines[1]!, /• a/);
  assert.match(lines[3]!, /• b/);
});

test('returns an empty string when nothing qualifies (drops out of the description join)', () => {
  assert.equal(buildWatchNextBlock([]), '');
  assert.equal(buildWatchNextBlock([perf({ title: 'short only', durationSec: 50 })]), '');
  // Unknown duration is treated as a Short, not linked.
  assert.equal(buildWatchNextBlock([perf({ title: 'no duration' })]), '');
});
