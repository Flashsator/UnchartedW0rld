import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeRetention,
  buildRetentionDirective,
  sectionForElapsed,
  type RetentionPoint,
} from '../src/retention.ts';

// Builds an N-point curve from a watching-fraction function of elapsed ratio.
function curve(fn: (elapsed: number) => number, points = 100): RetentionPoint[] {
  return Array.from({ length: points }, (_, i) => {
    const elapsed = i / (points - 1);
    return { elapsed, watching: fn(elapsed) };
  });
}

// --- analyzeRetention -----------------------------------------------------------

test('returns null on a curve too sparse to trust', () => {
  assert.equal(analyzeRetention([]), null);
  assert.equal(analyzeRetention(curve(() => 1, 10)), null);
});

test('measures early exit at the ~5% mark', () => {
  // 30% of starters gone immediately, flat afterwards.
  const insight = analyzeRetention(curve((e) => (e === 0 ? 1 : 0.7)));
  assert.ok(insight);
  assert.ok(Math.abs(insight.earlyExitPct - 30) < 1);
});

test('locates the steepest mid-video drop', () => {
  // Gentle decay with a cliff at the 50% mark.
  const insight = analyzeRetention(
    curve((e) => (e < 0.5 ? 0.9 - e * 0.1 : 0.6 - e * 0.1)),
  );
  assert.ok(insight);
  assert.ok(Math.abs(insight.steepestDropAt - 0.5) < 0.05);
  assert.ok(insight.steepestDropPct > 20);
});

test('ignores drops in the outro zone (expected exits)', () => {
  // Flat curve with a cliff at 95% — outside the mid scan window.
  const insight = analyzeRetention(curve((e) => (e < 0.95 ? 0.8 : 0.1)));
  assert.ok(insight);
  assert.equal(insight.steepestDropPct, 0);
});

test('clamps early exit into 0-100 even with rewatch ratios above 1', () => {
  const insight = analyzeRetention(curve(() => 1.2));
  assert.ok(insight);
  assert.equal(insight.earlyExitPct, 0);
});

// --- sectionForElapsed ------------------------------------------------------------

test('maps elapsed ratio to a 1-based section number', () => {
  assert.equal(sectionForElapsed(0, 6), 1);
  assert.equal(sectionForElapsed(0.49, 6), 3);
  assert.equal(sectionForElapsed(0.99, 6), 6);
  // Out-of-range input still yields a valid section.
  assert.equal(sectionForElapsed(1.5, 6), 6);
  assert.equal(sectionForElapsed(-1, 6), 1);
});

// --- buildRetentionDirective --------------------------------------------------------

test('returns null with no usable insights', () => {
  assert.equal(buildRetentionDirective([]), null);
});

test('averages insights into a directive naming the drop section', () => {
  const directive = buildRetentionDirective(
    [
      { earlyExitPct: 20, steepestDropAt: 0.5, steepestDropPct: 10 },
      { earlyExitPct: 40, steepestDropAt: 0.5, steepestDropPct: 14 },
    ],
    6,
  );
  assert.ok(directive);
  assert.match(directive, /~30% of viewers leave/);
  assert.match(directive, /section 4 of 6/);
  assert.match(directive, /50% mark/);
});

test('healthy early retention gets a keep-the-formula line, not a denser-opening order', () => {
  const directive = buildRetentionDirective([
    { earlyExitPct: 8, steepestDropAt: 0, steepestDropPct: 0 },
  ]);
  assert.ok(directive);
  assert.match(directive, /Early retention is healthy \(~8%/);
  assert.doesNotMatch(directive, /Make the opening even denser/);
});

test('omits the drop line when no video showed a mid-video drop', () => {
  const directive = buildRetentionDirective([
    { earlyExitPct: 25, steepestDropAt: 0, steepestDropPct: 0 },
  ]);
  assert.ok(directive);
  assert.match(directive, /~25% of viewers leave/);
  assert.doesNotMatch(directive, /steepest mid-video drop/);
});
