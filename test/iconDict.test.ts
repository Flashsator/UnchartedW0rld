import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectCardIcons, ICON_DICT } from '../src/iconDict.ts';

test('collects subject emoji in the order they appear', () => {
  assert.deepEqual(collectCardIcons('The bee visits the flower', 2), ['🐝', '🌸']);
});

test('order follows the text, not the dictionary', () => {
  assert.deepEqual(collectCardIcons('A flower waits for the bee', 2), ['🌸', '🐝']);
});

test('dedupes repeated subjects to a single icon', () => {
  assert.deepEqual(collectCardIcons('bee bees bee colony', 2), ['🐝']);
});

test('caps the result at max distinct icons', () => {
  const icons = collectCardIcons('The frog hunts a beetle near the snail', 2);
  assert.equal(icons.length, 2);
  assert.deepEqual(icons, ['🐸', '🪲']);
});

test('folds simple plurals (len>3, trailing -s)', () => {
  assert.deepEqual(collectCardIcons('Frogs eat beetles', 2), ['🐸', '🪲']);
});

test('returns an empty array when nothing matches', () => {
  assert.deepEqual(collectCardIcons('temperatures would freeze most life', 2), []);
});

test('searches the combined caption + headline string', () => {
  // FactCard passes `${caption} ${headline}` — the subject in the caption counts.
  assert.deepEqual(collectCardIcons('Spider It paralyses the beetle underground', 2), ['🕷️', '🪲']);
});

test('default max is 2', () => {
  assert.equal(collectCardIcons('frog beetle snail').length, 2);
});

test('dictionary covers each series with accurate glyphs', () => {
  assert.equal(ICON_DICT['frog'], '🐸'); // animals
  assert.equal(ICON_DICT['beetle'], '🪲'); // insects
  assert.equal(ICON_DICT['seed'], '🌱'); // plants
  // wasp/moth have no faithful emoji, so they are intentionally absent.
  assert.equal(ICON_DICT['wasp'], undefined);
});
