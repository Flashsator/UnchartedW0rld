import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findTaxonMismatch, SERIES_POOL, type Series } from '../src/config.ts';

// The animals series carries vertebrateOnly: true (the Monday day that kept
// bleeding into insects — bee 6/29, butterfly 7/7). The insects series does
// not, so the same guard must be a no-op there.
const animals = SERIES_POOL.find((s) => s.key === 'animals') as Series;
const insects = SERIES_POOL.find((s) => s.key === 'insects') as Series;

test('the animals series is flagged vertebrateOnly and insects is not', () => {
  assert.equal(animals.vertebrateOnly, true);
  assert.ok(!insects.vertebrateOnly);
});

// --- findTaxonMismatch: catches the invertebrate bleed --------------------------

test('flags an insect subject on the vertebrate-only animals series', () => {
  assert.equal(findTaxonMismatch('monarch butterfly', animals), 'butterfly');
  assert.equal(findTaxonMismatch('honey bee', animals), 'bee');
  assert.equal(findTaxonMismatch('praying mantis', animals), 'mantis');
});

test('flags a bare invertebrate subject (mollusc, arachnid)', () => {
  assert.equal(findTaxonMismatch('octopus', animals), 'octopus');
  assert.equal(findTaxonMismatch('spider', animals), 'spider');
});

test('matches a plural invertebrate token via the singularizer', () => {
  // The offending ORIGINAL token is returned, not its singular form.
  assert.equal(findTaxonMismatch('spiders', animals), 'spiders');
  assert.equal(findTaxonMismatch('butterflies', animals), 'butterflies');
});

// --- findTaxonMismatch: does NOT false-positive on vertebrates ------------------

test('passes a vertebrate subject unchanged', () => {
  assert.equal(findTaxonMismatch('barn owl', animals), null);
  assert.equal(findTaxonMismatch('bottlenose dolphin', animals), null);
  assert.equal(findTaxonMismatch('king cobra', animals), null);
});

test('does not fire on a vertebrate name that merely contains an invert substring', () => {
  // 'ant' ⊂ anteater/antelope, 'fly' ⊂ flycatcher, 'star' ⊂ star-nosed mole —
  // whole-token matching means none of these trip the guard.
  assert.equal(findTaxonMismatch('giant anteater', animals), null);
  assert.equal(findTaxonMismatch('antelope', animals), null);
  assert.equal(findTaxonMismatch('flycatcher', animals), null);
  assert.equal(findTaxonMismatch('star-nosed mole', animals), null);
});

// --- findTaxonMismatch: only fires for a vertebrateOnly series ------------------

test('never flags anything for a series without vertebrateOnly', () => {
  // On the insects series a butterfly/spider is exactly the point — the guard
  // must be inert there.
  assert.equal(findTaxonMismatch('monarch butterfly', insects), null);
  assert.equal(findTaxonMismatch('jumping spider', insects), null);
  assert.equal(findTaxonMismatch('octopus', insects), null);
});
