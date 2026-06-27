import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SHORTS_ARC_MAX_WORDS,
  applyArcVerdicts,
  buildArcQaPrompt,
  checkShortsArc,
  countWords,
  parseArcQaVerdicts,
  shortsArcOverflowSections,
  splitSentences,
} from '../src/shortsArcQa.js';
import type { Episode, ScriptSection } from '../src/types.js';

// A narration long enough to blow the ~50s word budget when treated as one arc.
const LONG_SENTENCE = `${'word '.repeat(SHORTS_ARC_MAX_WORDS + 20).trim()}.`;
const SHORT_5_SENTENCES =
  'A cat laps water fast. It snaps a column up. Gravity then pulls it down. The cat times the bite. That is the whole trick.';

function section(narration: string, extra: Partial<ScriptSection> = {}): ScriptSection {
  return { heading: 'Chapter', narration, visual: 'cat drinking', ...extra };
}

function episodeWith(sectionsByIndex: Record<number, ScriptSection>): Episode {
  const sections = Array.from({ length: 6 }, (_, i) => sectionsByIndex[i] ?? section('Filler text.'));
  return {
    title: 'The Cat That Defies Gravity',
    hook: 'Your cat breaks physics every morning.',
    description: 'desc',
    tags: ['cats'],
    subject: 'cat',
    sections,
  };
}

// --- splitSentences -------------------------------------------------------------

test('splitSentences splits on terminal punctuation', () => {
  assert.deepEqual(splitSentences('One. Two! Three?'), ['One.', 'Two!', 'Three?']);
});

test('splitSentences keeps decimals intact (does not split on the dot in 0.02)', () => {
  const out = splitSentences('It weighs 0.02 grams. That is tiny.');
  assert.deepEqual(out, ['It weighs 0.02 grams.', 'That is tiny.']);
});

test('splitSentences returns [] for empty/whitespace narration', () => {
  assert.deepEqual(splitSentences(''), []);
  assert.deepEqual(splitSentences('   '), []);
});

test('splitSentences captures a trailing fragment without terminal punctuation', () => {
  assert.deepEqual(splitSentences('Done. And a tail'), ['Done.', 'And a tail']);
});

// --- countWords -----------------------------------------------------------------

test('countWords counts whitespace-separated tokens', () => {
  assert.equal(countWords('a b c'), 3);
  assert.equal(countWords('  spaced   out  '), 2);
  assert.equal(countWords(''), 0);
});

// --- checkShortsArc -------------------------------------------------------------

test('checkShortsArc returns unknown when the marker is missing or <1', () => {
  assert.equal(checkShortsArc(SHORT_5_SENTENCES, undefined), 'unknown');
  assert.equal(checkShortsArc(SHORT_5_SENTENCES, 0), 'unknown');
});

test('checkShortsArc returns unknown when the marker exceeds the sentence count', () => {
  assert.equal(checkShortsArc(SHORT_5_SENTENCES, 9), 'unknown');
});

test('checkShortsArc returns ok when the marked arc fits the word budget', () => {
  assert.equal(checkShortsArc(SHORT_5_SENTENCES, 5), 'ok');
});

test('checkShortsArc returns overflow when the marked arc blows the word budget', () => {
  assert.equal(checkShortsArc(LONG_SENTENCE, 1), 'overflow');
});

// --- shortsArcOverflowSections --------------------------------------------------

test('shortsArcOverflowSections flags only Short sections (0/3/5) that overflow', () => {
  const ep = episodeWith({
    0: section(SHORT_5_SENTENCES, { shortsArcSentences: 5 }), // ok
    3: section(LONG_SENTENCE, { shortsArcSentences: 1 }), // overflow
    5: section(SHORT_5_SENTENCES, { shortsArcSentences: 3 }), // ok
    // section 2 overflow is ignored — it never ships as a Short.
    2: section(LONG_SENTENCE, { shortsArcSentences: 1 }),
  });
  assert.deepEqual(shortsArcOverflowSections(ep), [3]);
});

test('shortsArcOverflowSections returns [] when no Short section has a marker', () => {
  const ep = episodeWith({
    0: section(SHORT_5_SENTENCES),
    3: section(SHORT_5_SENTENCES),
    5: section(SHORT_5_SENTENCES),
  });
  assert.deepEqual(shortsArcOverflowSections(ep), []);
});

// --- parseArcQaVerdicts ---------------------------------------------------------

test('parseArcQaVerdicts parses a clean JSON map', () => {
  const out = parseArcQaVerdicts('{"0":{"resolvesInWindow":true,"resolveSentence":5}}');
  assert.deepEqual(out, { 0: { resolvesInWindow: true, resolveSentence: 5 } });
});

test('parseArcQaVerdicts tolerates a surrounding code fence / prose', () => {
  const raw = 'Here you go:\n```json\n{"3":{"resolvesInWindow":false,"resolveSentence":null}}\n```';
  assert.deepEqual(parseArcQaVerdicts(raw), { 3: { resolvesInWindow: false, resolveSentence: null } });
});

test('parseArcQaVerdicts floors a fractional resolveSentence and nulls <1', () => {
  const out = parseArcQaVerdicts('{"5":{"resolvesInWindow":true,"resolveSentence":4.9},"3":{"resolvesInWindow":true,"resolveSentence":0}}');
  assert.equal(out[5]!.resolveSentence, 4);
  assert.equal(out[3]!.resolveSentence, null);
});

test('parseArcQaVerdicts returns {} on malformed input', () => {
  assert.deepEqual(parseArcQaVerdicts('not json at all'), {});
  assert.deepEqual(parseArcQaVerdicts('{ broken'), {});
});

// --- applyArcVerdicts -----------------------------------------------------------

test('applyArcVerdicts corrects a Short section marker to the judge sentence', () => {
  const ep = episodeWith({ 3: section(SHORT_5_SENTENCES, { shortsArcSentences: 5 }) });
  const { episode, unresolved } = applyArcVerdicts(ep, {
    3: { resolvesInWindow: true, resolveSentence: 4 },
  });
  assert.equal(episode.sections[3]!.shortsArcSentences, 4);
  assert.deepEqual(unresolved, []);
  // immutability: the original episode is untouched.
  assert.equal(ep.sections[3]!.shortsArcSentences, 5);
});

test('applyArcVerdicts collects unresolved sections and leaves their markers alone', () => {
  const ep = episodeWith({ 5: section(SHORT_5_SENTENCES, { shortsArcSentences: 3 }) });
  const { episode, unresolved } = applyArcVerdicts(ep, {
    5: { resolvesInWindow: false, resolveSentence: null },
  });
  assert.deepEqual(unresolved, [5]);
  assert.equal(episode.sections[5]!.shortsArcSentences, 3);
});

test('applyArcVerdicts does NOT adopt a resolveSentence that itself overflows the budget', () => {
  const ep = episodeWith({ 0: section(LONG_SENTENCE) });
  const { episode } = applyArcVerdicts(ep, {
    0: { resolvesInWindow: true, resolveSentence: 1 }, // sentence 1 is 168 words → overflow
  });
  assert.equal(episode.sections[0]!.shortsArcSentences, undefined);
});

test('applyArcVerdicts ignores verdicts for non-Short sections', () => {
  const ep = episodeWith({ 2: section(SHORT_5_SENTENCES, { shortsArcSentences: 3 }) });
  const { episode } = applyArcVerdicts(ep, {
    2: { resolvesInWindow: true, resolveSentence: 2 },
  });
  // section 2 never ships as a Short, so its marker is left as written.
  assert.equal(episode.sections[2]!.shortsArcSentences, 3);
});

// --- buildArcQaPrompt -----------------------------------------------------------

test('buildArcQaPrompt embeds each section index and narration', () => {
  const prompt = buildArcQaPrompt([
    { index: 0, narration: 'A teaser line.' },
    { index: 3, narration: 'An off-day line.' },
  ]);
  assert.match(prompt, /SECTION 0/);
  assert.match(prompt, /A teaser line\./);
  assert.match(prompt, /SECTION 3/);
  assert.match(prompt, /An off-day line\./);
  assert.match(prompt, /resolvesInWindow/);
  assert.match(prompt, /resolveSentence/);
});
