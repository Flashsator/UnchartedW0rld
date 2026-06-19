import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visionVerdictIsFail, buildVisionPrompt } from '../src/brollVision.js';

// --- visionVerdictIsFail ----------------------------------------------------
// The gate is best-effort: it must only drop a clip on a CLEAR FAIL, and keep
// the clip on anything ambiguous so a picky/garbled model never starves a
// section.

test('treats a bare FAIL as a rejection', () => {
  assert.equal(visionVerdictIsFail('FAIL'), true);
});

test('is case-insensitive on FAIL', () => {
  assert.equal(visionVerdictIsFail('fail'), true);
});

test('rejects when FAIL appears in a short sentence without PASS', () => {
  assert.equal(visionVerdictIsFail('This is unrelated, FAIL'), true);
});

test('keeps the clip on a bare PASS', () => {
  assert.equal(visionVerdictIsFail('PASS'), false);
});

test('keeps the clip on an empty reply', () => {
  assert.equal(visionVerdictIsFail(''), false);
});

test('keeps the clip when both words appear (ambiguous)', () => {
  assert.equal(visionVerdictIsFail('It could PASS or FAIL'), false);
});

test('does not match FAIL inside a larger word', () => {
  // "FAILURE" has no word boundary after FAIL, so it is not a verdict.
  assert.equal(visionVerdictIsFail('no FAILURE detected'), false);
});

// --- buildVisionPrompt ------------------------------------------------------

test('prompt embeds the query and asks for a one-word verdict', () => {
  const p = buildVisionPrompt('/tmp/frame.jpg', 'glass frog clinging to a leaf');
  assert.match(p, /glass frog clinging to a leaf/);
  assert.match(p, /exactly one word: PASS or FAIL/);
});

test('prompt references the frame path to read', () => {
  const p = buildVisionPrompt('frame.jpg', 'octopus changing color');
  assert.match(p, /Read the image file at:/);
  assert.match(p, /frame\.jpg/);
});
