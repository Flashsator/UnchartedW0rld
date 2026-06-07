import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { planShortsForToday, publishAtFor } from '../src/shortsGen.js';

beforeEach(() => {
  // The override env would otherwise mask the real weekday argument under test.
  delete process.env.SHORTS_PLAN_WEEKDAY;
});

test('long-video days drip shorts onto the off days (Mon/Wed/Fri)', () => {
  // Mon(1) -> Tue, Wed(3) -> Thu, Fri(5) -> Sat+Sun (both from the Fri episode).
  assert.deepEqual(planShortsForToday(1), [{ sectionIdx: 0, daysAhead: 1 }]);
  assert.deepEqual(planShortsForToday(3), [{ sectionIdx: 0, daysAhead: 1 }]);
  assert.deepEqual(planShortsForToday(5), [
    { sectionIdx: 0, daysAhead: 1 },
    { sectionIdx: 4, daysAhead: 2 },
  ]);
});

test('non-long-video days schedule nothing themselves', () => {
  for (const wd of [0, 2, 4, 6]) {
    assert.deepEqual(planShortsForToday(wd), [], `weekday ${wd} should be empty`);
  }
});

test('publishAtFor lands daysAhead later at 19:00:00.000 UTC', () => {
  const base = new Date('2026-05-25T08:30:00.000Z'); // a Monday
  const out = publishAtFor(2, base);
  assert.equal(out.toISOString(), '2026-05-27T19:00:00.000Z');
});

test('publishAtFor with zero days stays on the base date', () => {
  const base = new Date('2026-05-25T22:45:10.500Z');
  const out = publishAtFor(0, base);
  assert.equal(out.toISOString(), '2026-05-25T19:00:00.000Z');
});
