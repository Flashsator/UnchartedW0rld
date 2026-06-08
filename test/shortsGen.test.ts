import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { planShortsForToday, publishAtFor } from '../src/shortsGen.js';

beforeEach(() => {
  // The override env would otherwise mask the real weekday argument under test.
  delete process.env.SHORTS_PLAN_WEEKDAY;
});

test('long-video days fire a same-day teaser plus off-day drip (Mon/Wed/Fri)', () => {
  // Each long day publishes a same-day teaser (sec 0, staggered to 21:00 UTC)
  // then drips later sections onto the off days so every weekday gets a short:
  // Mon(1) -> Mon+Tue, Wed(3) -> Wed+Thu, Fri(5) -> Fri+Sat+Sun.
  const teaser = { sectionIdx: 0, daysAhead: 0, publishHourUtc: 21 };
  assert.deepEqual(planShortsForToday(1), [teaser, { sectionIdx: 3, daysAhead: 1 }]);
  assert.deepEqual(planShortsForToday(3), [teaser, { sectionIdx: 3, daysAhead: 1 }]);
  assert.deepEqual(planShortsForToday(5), [
    teaser,
    { sectionIdx: 3, daysAhead: 1 },
    { sectionIdx: 5, daysAhead: 2 },
  ]);
});

test('no two shorts from one episode reuse the same section', () => {
  for (const wd of [1, 3, 5]) {
    const sections = planShortsForToday(wd).map((e) => e.sectionIdx);
    assert.equal(new Set(sections).size, sections.length, `weekday ${wd} reused a section`);
  }
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

test('publishAtFor honors an explicit UTC hour override (same-day teaser slot)', () => {
  const base = new Date('2026-05-25T08:30:00.000Z'); // a Monday
  const out = publishAtFor(0, base, 21);
  assert.equal(out.toISOString(), '2026-05-25T21:00:00.000Z');
});
