import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildShortsManifest, planShortsForToday, publishAtFor } from '../src/shortsGen.js';
import type { Episode, RenderManifest } from '../src/types.js';

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

// --- buildShortsManifest title source -------------------------------------------

function manifestFixture(): RenderManifest {
  return {
    series: 'animals',
    title: 'The Cat That Defies Gravity Every Time It Drinks',
    hook: 'Your cat breaks the laws of physics every morning.',
    coldOpenVisualPath: 'cold.mp4',
    intro: { durationSec: 3 },
    sections: Array.from({ length: 6 }, (_, i) => ({
      heading: `Chapter Label ${i}`,
      audioPath: `sec${i}.mp3`,
      duration: 12,
      gapAfterSec: 0,
      brollPaths: ['a.mp4'],
      cutTimes: [0],
      words: [{ start: 0, end: 2, text: 'Hello.' }],
      iconEvents: [],
    })),
    interludes: [],
    outro: { durationSec: 5 },
    bgmPath: 'bgm.mp3',
    bgmVolume: 0.1,
    totalDuration: 100,
  };
}

function episodeFixture(shortsHook?: string): Episode {
  return {
    title: 'The Cat That Defies Gravity Every Time It Drinks',
    hook: 'Your cat breaks the laws of physics every morning.',
    description: 'desc',
    tags: ['cats'],
    sections: Array.from({ length: 6 }, (_, i) => ({
      heading: `Chapter Label ${i}`,
      narration: 'Hello.',
      visual: 'cat drinking water',
      ...(i === 3 && shortsHook !== undefined ? { shortsHook } : {}),
    })),
  };
}

test('teaser short (section 0) titles with the episode cold-open hook', () => {
  const sm = buildShortsManifest(manifestFixture(), episodeFixture('Unused hook for section three'), {
    sectionIdx: 0,
    daysAhead: 0,
  });
  assert.ok(sm);
  assert.equal(sm.shortsTitle, 'Your cat breaks the laws of physics every morning.');
});

test('off-day short prefers the script-written shortsHook over the chapter heading', () => {
  const sm = buildShortsManifest(
    manifestFixture(),
    episodeFixture('Cats bend physics every single time they drink water'),
    { sectionIdx: 3, daysAhead: 1 },
  );
  assert.ok(sm);
  assert.equal(sm.shortsTitle, 'Cats bend physics every single time they drink water');
  assert.equal(sm.hook, 'Cats bend physics every single time they drink water');
});

test('off-day short falls back to the heading when shortsHook is absent or blank', () => {
  const absent = buildShortsManifest(manifestFixture(), episodeFixture(), {
    sectionIdx: 3,
    daysAhead: 1,
  });
  assert.ok(absent);
  assert.equal(absent.shortsTitle, 'Chapter Label 3');

  const blank = buildShortsManifest(manifestFixture(), episodeFixture('   '), {
    sectionIdx: 3,
    daysAhead: 1,
  });
  assert.ok(blank);
  assert.equal(blank.shortsTitle, 'Chapter Label 3');
});
