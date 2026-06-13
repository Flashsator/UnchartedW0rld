import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spokenNumbers, sanitizeOverlay, hookNumbersAreSpoken } from '../src/scriptGen.js';

// spokenNumbers — the honesty primitive: every numeric figure the narration
// actually states, normalized so commas/percents/trailing dots collapse to a
// bare comparable form. compare-overlay bars may only chart these.
test('spokenNumbers normalizes commas, percents and trailing dots', () => {
  const nums = spokenNumbers('It weighed 12,000 tons, lost 47% in 1850.');
  assert.ok(nums.has('12000'));
  assert.ok(nums.has('47'));
  assert.ok(nums.has('1850'));
});

test('spokenNumbers returns empty set when the narration states no figures', () => {
  assert.equal(spokenNumbers('The spider hides behind a decoy of itself.').size, 0);
});

// hookNumbersAreSpoken — invariant #1 for the shortsHook, which surfaces as the
// Short's on-screen title card + published title. A hook may only state figures
// the episode actually speaks; an unspoken number drops the hook (caller falls
// back). Keyed to the whole episode, since the teaser hook draws on all of it.
test('hookNumbersAreSpoken passes a hook whose numbers are all spoken', () => {
  const spoken = spokenNumbers('It strikes in 0.02 seconds and lives 30 years.');
  assert.equal(hookNumbersAreSpoken('A strike in 0.02 seconds you can never see', spoken), true);
});

test('hookNumbersAreSpoken passes a hook with no numbers at all', () => {
  const spoken = spokenNumbers('A cat laps water faster than gravity pulls it back.');
  assert.equal(hookNumbersAreSpoken('How a cat outruns gravity every single morning', spoken), true);
});

test('hookNumbersAreSpoken rejects a hook stating a number the episode never speaks', () => {
  const spoken = spokenNumbers('A juvenile carries 12 milligrams; an adult carries 30.');
  // 500 appears nowhere in the narration — a fabricated figure on the title card.
  assert.equal(hookNumbersAreSpoken('This bite delivers 500 times the venom you expect', spoken), false);
});

// sanitizeOverlay — the no-fabricated-data gate. An overlay may only surface
// something the narration actually says; anything else returns null (dropped).
test('sanitizeOverlay rejects a non-object or unknown kind', () => {
  assert.equal(sanitizeOverlay(null, 'anything'), null);
  assert.equal(sanitizeOverlay({ kind: 'banner', triggerWord: 'x', text: 'y' }, 'x'), null);
});

test('sanitizeOverlay rejects when triggerWord is not spoken in the narration', () => {
  const o = { kind: 'stat', triggerWord: 'venom', text: '47%', subtext: 'OF BITES' };
  assert.equal(sanitizeOverlay(o, 'The fangs deliver a paralyzing dose.'), null);
});

test('sanitizeOverlay accepts a stat whose triggerWord is spoken (case-insensitive)', () => {
  const o = { kind: 'stat', triggerWord: 'Venom', text: '47%', subtext: 'OF BITES' };
  const result = sanitizeOverlay(o, 'Its venom can drop prey in seconds.');
  assert.deepEqual(result, { kind: 'stat', triggerWord: 'Venom', text: '47%', subtext: 'OF BITES' });
});

test('sanitizeOverlay drops a label missing required text', () => {
  const o = { kind: 'label', triggerWord: 'genus', text: '' };
  assert.equal(sanitizeOverlay(o, 'A new genus was named in 2010.'), null);
});

// The headline invariant: a compare overlay may ONLY chart two numbers that are
// both spoken verbatim in that section's narration — this is what blocks the
// fabricated "YOUNG 20 / OLD 90" bars.
test('sanitizeOverlay accepts a compare when BOTH values are spoken', () => {
  const o = {
    kind: 'compare',
    triggerWord: 'juvenile',
    text: 'JUVENILE',
    compareWith: 'ADULT',
    compareLabel: 'VENOM (MG)',
    compareLeftValue: 12,
    compareRightValue: 30,
  };
  const narration = 'A juvenile carries 12 milligrams; an adult carries 30.';
  assert.deepEqual(sanitizeOverlay(o, narration), {
    kind: 'compare',
    triggerWord: 'juvenile',
    text: 'JUVENILE',
    compareWith: 'ADULT',
    compareLabel: 'VENOM (MG)',
    compareLeftValue: 12,
    compareRightValue: 30,
  });
});

test('sanitizeOverlay rejects a compare with a fabricated (unspoken) value', () => {
  const o = {
    kind: 'compare',
    triggerWord: 'juvenile',
    text: 'JUVENILE',
    compareWith: 'ADULT',
    compareLabel: 'VENOM (MG)',
    compareLeftValue: 12,
    compareRightValue: 90, // never stated — must drop the whole overlay
  };
  const narration = 'A juvenile carries 12 milligrams; an adult carries 30.';
  assert.equal(sanitizeOverlay(o, narration), null);
});

test('sanitizeOverlay rejects a compare with a negative or non-finite value', () => {
  const base = {
    kind: 'compare',
    triggerWord: 'depth',
    text: 'SHALLOW',
    compareWith: 'DEEP',
    compareLabel: 'DEPTH (M)',
  };
  const narration = 'It ranges from depth 5 to 200 meters.';
  assert.equal(sanitizeOverlay({ ...base, compareLeftValue: -5, compareRightValue: 200 }, narration), null);
  assert.equal(
    sanitizeOverlay({ ...base, compareLeftValue: 'x', compareRightValue: 200 }, narration),
    null,
  );
});
