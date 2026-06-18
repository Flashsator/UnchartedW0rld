import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planShotCards, cleanFigure } from '../src/brollCards.js';
import { isClipOnSubject } from '../src/stock.js';
import type { BrollClip, WordTiming } from '../src/types.js';

// --- builders ---------------------------------------------------------------

function clip(onSubject?: boolean): BrollClip {
  return { path: 'x.mp4', duration: 5, width: 1920, height: 1080, onSubject };
}

// One word per second over [from, to), 0.5s long, so any slot window has text.
function wordsOver(from: number, to: number, label = 'word'): WordTiming[] {
  const out: WordTiming[] = [];
  for (let s = from; s < to; s += 1) {
    out.push({ start: s, end: s + 0.5, text: `${label}${s}` });
  }
  return out;
}

const baseArgs = {
  totalSec: 10,
  heading: 'The Hidden Mechanism',
  subject: 'glass frog',
  seriesKey: 'animals',
  isColdOpenSection: false,
  enabled: true,
};

// --- planShotCards: candidacy ----------------------------------------------

test('a proven off-subject slot becomes a card', () => {
  // Arrange: slot 0 on-subject, slot 1 proven off-subject.
  const clips = [clip(true), clip(false)];
  // Act
  const cards = planShotCards({
    ...baseArgs,
    clips,
    words: wordsOver(0, 10),
    cutTimes: [0, 5],
  });
  // Assert
  assert.equal(cards[0], null);
  assert.ok(cards[1]);
});

test('an on-subject slot is left as footage', () => {
  const clips = [clip(false), clip(true)];
  const cards = planShotCards({
    ...baseArgs,
    clips,
    words: wordsOver(0, 10),
    cutTimes: [0, 5],
  });
  assert.equal(cards[1], null);
});

test('an unknown (no-metadata) slot is left alone — only proven off-subject is carded', () => {
  const clips = [clip(true), clip(undefined)];
  const cards = planShotCards({
    ...baseArgs,
    clips,
    words: wordsOver(0, 10),
    cutTimes: [0, 5],
  });
  assert.deepEqual(cards, [null, null]);
});

test('the gate off (enabled:false) cards nothing even with off-subject slots', () => {
  const clips = [clip(false), clip(false)];
  const cards = planShotCards({
    ...baseArgs,
    enabled: false,
    clips,
    words: wordsOver(0, 10),
    cutTimes: [0, 5],
  });
  assert.deepEqual(cards, [null, null]);
});

test('at most BROLL_CARD_MAX_PER_SECTION (2) slots are carded', () => {
  // 6 clips, 3 off-subject (exactly at the 50% ratio, so it proceeds), cap = 2.
  const clips = [clip(true), clip(false), clip(false), clip(false), clip(true), clip(true)];
  const cards = planShotCards({
    ...baseArgs,
    totalSec: 12,
    clips,
    words: wordsOver(0, 12),
    cutTimes: [0, 2, 4, 6, 8, 10],
  });
  assert.equal(cards.filter((c) => c !== null).length, 2);
});

test('the cold-open slot 0 is never carded', () => {
  const clips = [clip(false), clip(true)];
  const cards = planShotCards({
    ...baseArgs,
    isColdOpenSection: true,
    clips,
    words: wordsOver(0, 10),
    cutTimes: [0, 5],
  });
  assert.equal(cards[0], null);
});

test('more than half off-subject bails the whole section (unfilmable subject)', () => {
  // 3 clips, 2 off-subject -> 2 > 1.5 -> bail.
  const clips = [clip(false), clip(false), clip(true)];
  const cards = planShotCards({
    ...baseArgs,
    totalSec: 9,
    clips,
    words: wordsOver(0, 9),
    cutTimes: [0, 3, 6],
  });
  assert.deepEqual(cards, [null, null, null]);
});

// --- planShotCards: card content (invariant #1) -----------------------------

test('a spoken figure in the slot window makes a stat card showing THAT figure', () => {
  const clips = [clip(true), clip(false)];
  const words: WordTiming[] = [
    { start: 1, end: 1.5, text: '999' }, // spoken, but OUTSIDE slot 1's window
    { start: 6, end: 6.5, text: '1,200' }, // inside slot 1's window [5,10)
    { start: 7, end: 7.5, text: 'years' },
  ];
  const cards = planShotCards({ ...baseArgs, clips, words, cutTimes: [0, 5] });
  assert.equal(cards[1]?.kind, 'stat');
  assert.equal(cards[1]?.headline, '1,200');
  assert.equal(cards[1]?.caption, baseArgs.heading);
});

test('no spoken figure in the window makes a fact card with verbatim narration + subject caption', () => {
  const clips = [clip(true), clip(false)];
  const words: WordTiming[] = [
    { start: 5, end: 5.4, text: 'a' },
    { start: 5.5, end: 5.9, text: 'glass' },
    { start: 6, end: 6.4, text: 'frog' },
    { start: 6.5, end: 6.9, text: 'has' },
    { start: 7, end: 7.4, text: 'transparent' },
    { start: 7.5, end: 7.9, text: 'skin.' },
  ];
  const cards = planShotCards({ ...baseArgs, clips, words, cutTimes: [0, 5] });
  assert.equal(cards[1]?.kind, 'fact');
  assert.equal(cards[1]?.caption, 'glass frog');
  // Verbatim clause, capitalized, trailing period dropped.
  assert.equal(cards[1]?.headline, 'A glass frog has transparent skin');
});

// --- cleanFigure ------------------------------------------------------------

test('cleanFigure strips wrapping punctuation but keeps $ and %', () => {
  assert.equal(cleanFigure('(47%).'), '47%');
  assert.equal(cleanFigure('$1,200,'), '$1,200');
  assert.equal(cleanFigure('1986'), '1986');
});

// --- isClipOnSubject --------------------------------------------------------

test('isClipOnSubject is true when metadata names the subject', () => {
  assert.equal(isClipOnSubject('a cat drinking water', 'cat'), true);
});

test('isClipOnSubject is false when metadata names none of the subject tokens', () => {
  assert.equal(isClipOnSubject('mountain landscape sunset', 'cat'), false);
});

test('isClipOnSubject is undefined without metadata or without a subject', () => {
  assert.equal(isClipOnSubject(undefined, 'cat'), undefined);
  assert.equal(isClipOnSubject('cat', undefined), undefined);
});
