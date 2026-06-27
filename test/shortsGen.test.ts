import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildShortsManifest,
  pickShortsHookText,
  planShortsForToday,
  publishAtFor,
  sentenceEndIndex,
  trimToBoundary,
} from '../src/shortsGen.js';
import type { Episode, RenderManifest, WordTiming } from '../src/types.js';

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

function episodeFixture(shortsHook?: string, section0Hook?: string): Episode {
  return {
    title: 'The Cat That Defies Gravity Every Time It Drinks',
    hook: 'Your cat breaks the laws of physics every morning.',
    description: 'desc',
    tags: ['cats'],
    subject: 'cat',
    sections: Array.from({ length: 6 }, (_, i) => ({
      heading: `Chapter Label ${i}`,
      // A subject-first first sentence so the off-day fallback (now the first
      // spoken narration sentence, never the abstract chapter heading) is real.
      narration: 'A cat never scoops water. It snaps a column straight up.',
      visual: 'cat drinking water',
      ...(i === 0 && section0Hook !== undefined ? { shortsHook: section0Hook } : {}),
      ...(i === 3 && shortsHook !== undefined ? { shortsHook } : {}),
    })),
  };
}

test('teaser short (section 0) prefers its own standalone shortsHook', () => {
  const sm = buildShortsManifest(
    manifestFixture(),
    episodeFixture(undefined, 'A cat laps water faster than gravity can pull it back'),
    { sectionIdx: 0, daysAhead: 0 },
  );
  assert.ok(sm);
  assert.equal(sm.shortsTitle, 'A cat laps water faster than gravity can pull it back');
  assert.equal(sm.hook, 'A cat laps water faster than gravity can pull it back');
});

test('teaser short falls back to the cold-open hook when section 0 has no shortsHook', () => {
  // Older episodes wrote shortsHook only on sections 3/5; the teaser must still
  // title cleanly off the episode hook rather than the subject-less heading.
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

test('off-day short falls back to the first narration sentence, NOT the abstract heading', () => {
  // The chapter heading ("Chapter Label 3") is a label, not a hook — preferring
  // it produced flop titles like "When Pollen Leaps the Gap". With no shortsHook
  // the Short now titles off the section's first spoken (subject-named) sentence.
  const absent = buildShortsManifest(manifestFixture(), episodeFixture(), {
    sectionIdx: 3,
    daysAhead: 1,
  });
  assert.ok(absent);
  assert.equal(absent.shortsTitle, 'A cat never scoops water.');
  assert.notEqual(absent.shortsTitle, 'Chapter Label 3');

  const blank = buildShortsManifest(manifestFixture(), episodeFixture('   '), {
    sectionIdx: 3,
    daysAhead: 1,
  });
  assert.ok(blank);
  assert.equal(blank.shortsTitle, 'A cat never scoops water.');
});

// --- pickShortsHookText (pure fallback decider) ---------------------------------

test('pickShortsHookText prefers the script-written shortsHook above all', () => {
  const out = pickShortsHookText({
    sectionIdx: 3,
    shortsHook: '  A wasp turns a caterpillar into a living food store  ',
    coldOpenHook: 'cold open',
    narration: 'A cat never scoops water. It snaps a column up.',
    heading: 'Chapter Label 3',
    subject: 'cat',
  });
  assert.equal(out, 'A wasp turns a caterpillar into a living food store');
});

test('pickShortsHookText: section 0 falls back to the cold-open hook', () => {
  const out = pickShortsHookText({
    sectionIdx: 0,
    shortsHook: undefined,
    coldOpenHook: 'Your cat breaks the laws of physics every morning.',
    narration: 'Something else entirely is spoken first.',
    heading: 'Chapter Label 0',
    subject: 'cat',
  });
  assert.equal(out, 'Your cat breaks the laws of physics every morning.');
});

test('pickShortsHookText: off-day section falls back to the first narration sentence', () => {
  const out = pickShortsHookText({
    sectionIdx: 3,
    shortsHook: undefined,
    coldOpenHook: 'cold open',
    narration: 'A cat never scoops water. It snaps a column straight up.',
    heading: 'Chapter Label 3',
    subject: 'cat',
  });
  assert.equal(out, 'A cat never scoops water.');
});

test('pickShortsHookText NEVER returns the abstract chapter heading when a sentence exists', () => {
  const out = pickShortsHookText({
    sectionIdx: 3,
    shortsHook: undefined,
    coldOpenHook: '',
    narration: 'A mosquito pierces your skin and you feel nothing.',
    heading: 'When Pollen Leaps the Gap',
    subject: 'mosquito',
  });
  assert.equal(out, 'A mosquito pierces your skin and you feel nothing.');
  assert.notEqual(out, 'When Pollen Leaps the Gap');
});

test('pickShortsHookText: empty narration falls back to the subject, not the heading', () => {
  const out = pickShortsHookText({
    sectionIdx: 3,
    shortsHook: undefined,
    coldOpenHook: '',
    narration: '   ',
    heading: 'Chapter Label 3',
    subject: 'glass frog',
  });
  assert.equal(out, 'glass frog');
});

test('pickShortsHookText: only the heading remains when narration and subject are empty', () => {
  const out = pickShortsHookText({
    sectionIdx: 3,
    shortsHook: undefined,
    coldOpenHook: '',
    narration: '',
    heading: 'Chapter Label 3',
    subject: undefined,
  });
  assert.equal(out, 'Chapter Label 3');
});

// --- Lever A: sentenceEndIndex + arc-aware trimToBoundary -----------------------

function w(text: string, end: number): WordTiming {
  return { start: Math.max(0, end - 1), end, text };
}

// 5 sentences ending at 10s / 20s / 30s / 45s / 52s of speech.
const ARC_WORDS: WordTiming[] = [
  w('An', 5), w('owl', 8), w('turns.', 10), // sentence 1 ends @10
  w('It', 14), w('never', 17), w('tears.', 20), // sentence 2 ends @20
  w('Here', 24), w('is', 27), w('why.', 30), // sentence 3 ends @30
  w('Bones', 35), w('have', 40), w('holes.', 45), // sentence 4 ends @45
  w('And', 48), w('more.', 52), // sentence 5 ends @52
];

test('sentenceEndIndex returns the WordTiming index that ends the nth sentence', () => {
  assert.equal(sentenceEndIndex(ARC_WORDS, 1), 2);
  assert.equal(sentenceEndIndex(ARC_WORDS, 2), 5);
  assert.equal(sentenceEndIndex(ARC_WORDS, 3), 8);
  assert.equal(sentenceEndIndex(ARC_WORDS, 5), 13);
});

test('sentenceEndIndex returns -1 for n<1 or beyond the sentence count', () => {
  assert.equal(sentenceEndIndex(ARC_WORDS, 0), -1);
  assert.equal(sentenceEndIndex(ARC_WORDS, 9), -1);
});

test('trimToBoundary cuts exactly at the marked arc sentence (Lever A)', () => {
  const { words, endSec } = trimToBoundary(ARC_WORDS, 50, 3);
  assert.equal(words.length, 9); // through sentence 3
  assert.equal(words[words.length - 1]!.text, 'why.');
  assert.ok(Math.abs(endSec - 30.3) < 1e-9);
});

test('trimToBoundary ignores a marker below MIN_ARC_SEC and blind-cuts instead', () => {
  // Marker = sentence 1 ends @10s (< 15s MIN_ARC_SEC) → implausible "story",
  // fall back to the blind cut (last sentence boundary under maxSec=50 → s4 @45).
  const { words, endSec } = trimToBoundary(ARC_WORDS, 50, 1);
  assert.equal(words.length, 12);
  assert.equal(words[words.length - 1]!.text, 'holes.');
  assert.ok(Math.abs(endSec - 45.3) < 1e-9);
});

test('trimToBoundary ignores a marker beyond the section sentence count', () => {
  // 9 > 5 sentences → no such boundary → blind cut (s4 @45 under maxSec=50).
  const { words } = trimToBoundary(ARC_WORDS, 50, 9);
  assert.equal(words.length, 12);
  assert.equal(words[words.length - 1]!.text, 'holes.');
});

test('trimToBoundary with no marker keeps the original blind time-based cut', () => {
  const { words, endSec } = trimToBoundary(ARC_WORDS, 50);
  assert.equal(words.length, 12); // last sentence ending under 50s is s4 @45
  assert.ok(Math.abs(endSec - 45.3) < 1e-9);
});

test('trimToBoundary ignores a marker whose answer overflows the hard cap', () => {
  // sentence 2 ends at 58s, past MAX_SHORTS_SEC+0.5 (55.5) → blind fallback.
  const longWords: WordTiming[] = [
    w('First', 20), w('claim.', 30), // sentence 1 ends @30
    w('Second', 50), w('answer.', 58), // sentence 2 ends @58 (> 55.5)
  ];
  const { words } = trimToBoundary(longWords, 55, 2);
  assert.equal(words.length, 2); // fell back to blind cut → only sentence 1 fits
  assert.equal(words[words.length - 1]!.text, 'claim.');
});
