import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIllustrationPrompt, illustrationVerdictIsFail } from '../src/brollArt.ts';
import type { BrollCard } from '../src/types.ts';

const factCard: BrollCard = {
  kind: 'fact',
  headline: 'the caterpillar keeps eating while it is eaten alive',
  caption: 'parasitic wasp',
};

test('prompt forces a stylized, non-photoreal illustration', () => {
  const p = buildIllustrationPrompt(factCard);
  assert.match(p, /flat vector scientific illustration/i);
  assert.match(p, /not a photograph/i);
  assert.match(p, /no photorealism/i);
});

test('prompt bans any rendered text/number (invariant #1 keeps the card text as the only words)', () => {
  const p = buildIllustrationPrompt(factCard);
  assert.match(p, /no text/i);
  assert.match(p, /no numbers/i);
  assert.match(p, /no watermark/i);
});

test('prompt carries the verbatim clause and the subject caption', () => {
  const p = buildIllustrationPrompt(factCard);
  assert.ok(p.includes('the caterpillar keeps eating while it is eaten alive'));
  assert.ok(p.includes('parasitic wasp'));
});

test('prompt softens FLUX-moderated predation wording', () => {
  const card: BrollCard = { kind: 'fact', headline: 'the predator hunts its prey in the dark', caption: 'owl' };
  const p = buildIllustrationPrompt(card);
  assert.doesNotMatch(p, /\bpredator\b/i);
  assert.doesNotMatch(p, /\bhunts\b/i);
  assert.doesNotMatch(p, /\bprey\b/i);
  assert.match(p, /\bhunter\b/i);
  assert.match(p, /\bstalks\b/i);
});

test('a card with no caption still builds a prompt from the clause alone', () => {
  const card: BrollCard = { kind: 'fact', headline: 'a hidden sixth mouthpart' };
  const p = buildIllustrationPrompt(card);
  assert.ok(p.includes('a hidden sixth mouthpart'));
  assert.match(p, /flat vector scientific illustration/i);
});

test('illustrationVerdictIsFail drops only on a clear FAIL token', () => {
  assert.equal(illustrationVerdictIsFail('FAIL'), true);
  assert.equal(illustrationVerdictIsFail('FAIL - wrong number of legs'), true);
  assert.equal(illustrationVerdictIsFail('PASS'), false);
  assert.equal(illustrationVerdictIsFail('Looks like a clean illustration. PASS'), false);
  assert.equal(illustrationVerdictIsFail('this is a painful edge case'), false);
});
