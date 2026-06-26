import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTopicDirective,
  parseCandidates,
  pickBestCandidate,
  type ScoredCandidate,
} from '../src/topicResearch.ts';

const CAND = (over: Partial<ScoredCandidate> = {}): ScoredCandidate => ({
  subject: 'house cat',
  angle: 'the physics of how cats lap water',
  searchQuery: 'how do cats drink water',
  medianViews: 100_000,
  floorViews: 20_000,
  ...over,
});

// --- parseCandidates --------------------------------------------------------------

test('parses a plain JSON array of candidates', () => {
  const raw = JSON.stringify([
    { subject: 'cat', angle: 'lapping physics', searchQuery: 'how do cats drink water' },
    { subject: 'ant', angle: 'death spiral', searchQuery: 'why do ants walk in circles' },
  ]);
  const parsed = parseCandidates(raw, 5);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]?.subject, 'cat');
});

test('parses candidates wrapped in prose and a {candidates: []} envelope', () => {
  const raw =
    'Here are my picks:\n\n' +
    JSON.stringify({
      candidates: [{ subject: 'octopus', angle: 'taste by touch', searchQuery: 'octopus arms taste' }],
    }) +
    '\n\nHope that helps!';
  const parsed = parseCandidates(raw, 5);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.subject, 'octopus');
});

test('drops malformed entries and caps at max', () => {
  const raw = JSON.stringify([
    { subject: 'cat', angle: 'a', searchQuery: 'q1' },
    { subject: '', angle: 'missing subject', searchQuery: 'q2' },
    { subject: 'dog', angle: 'b' }, // no searchQuery
    { subject: 'ant', angle: 'c', searchQuery: 'q3' },
  ]);
  const parsed = parseCandidates(raw, 1);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.subject, 'cat');
});

test('returns empty array on garbage output', () => {
  assert.deepEqual(parseCandidates('no json here at all', 5), []);
  assert.deepEqual(parseCandidates('', 5), []);
});

// --- pickBestCandidate ---------------------------------------------------------------

test('prefers a winnable-band candidate over a saturated mega-niche', () => {
  const scored = [
    // Highest median, but saturated (above SATURATED_MEDIAN) — unwinnable.
    CAND({ subject: 'saturated', medianViews: 8_000_000, floorViews: 3_000_000 }),
    // Solid proven demand inside the band — the right pick.
    CAND({ subject: 'winnable', medianViews: 400_000, floorViews: 120_000 }),
  ];
  assert.equal(pickBestCandidate(scored)?.subject, 'winnable');
});

test('among winnable candidates prefers the higher floor (consistent demand)', () => {
  const scored = [
    // Higher median but a tiny floor = one viral outlier propping it up.
    CAND({ subject: 'spiky', medianViews: 600_000, floorViews: 5_000 }),
    // Lower median but every top hit pulls real views = broad demand.
    CAND({ subject: 'broad', medianViews: 300_000, floorViews: 150_000 }),
  ];
  assert.equal(pickBestCandidate(scored)?.subject, 'broad');
});

test('falls back to best available when nothing lands in the winnable band', () => {
  // All below NO_DEMAND_MEDIAN — no winnable candidate, so pick the strongest
  // by floor rather than returning null (some demand beats the model's blind choice).
  const scored = [
    CAND({ subject: 'tiny', medianViews: 3_000, floorViews: 500 }),
    CAND({ subject: 'less-tiny', medianViews: 9_000, floorViews: 4_000 }),
  ];
  assert.equal(pickBestCandidate(scored)?.subject, 'less-tiny');
});

test('drops an in-band candidate whose floor is a mirage (6/26 dodder failure)', () => {
  // The real 6/26 plants run: only "dodder" lands in the median band, but its
  // floor is 3 — the median is one viral video over a thin niche with no stock
  // footage. It must NOT win by default; fall back to the highest real floor.
  const scored = [
    CAND({ subject: 'dodder', medianViews: 925_000, floorViews: 3 }),
    CAND({ subject: 'mistletoe', medianViews: 14_000, floorViews: 371 }),
    CAND({ subject: 'spanish moss', medianViews: 7_000, floorViews: 469 }),
  ];
  const best = pickBestCandidate(scored);
  assert.notEqual(best?.subject, 'dodder');
  assert.equal(best?.subject, 'spanish moss');
});

test('a band candidate with a real floor beats an in-band mirage-floor rival', () => {
  const scored = [
    // In band on median, but floor is a mirage — excluded from the band.
    CAND({ subject: 'mirage', medianViews: 1_500_000, floorViews: 10 }),
    // Lower median, still in band, with genuine demand depth — the right pick.
    CAND({ subject: 'real', medianViews: 50_000, floorViews: 8_000 }),
  ];
  assert.equal(pickBestCandidate(scored)?.subject, 'real');
});

test('returns null when every candidate scored zero (all probes failed)', () => {
  const scored = [
    CAND({ medianViews: 0, floorViews: 0 }),
    CAND({ subject: 'b', medianViews: 0, floorViews: 0 }),
  ];
  assert.equal(pickBestCandidate(scored), null);
  assert.equal(pickBestCandidate([]), null);
});

// --- buildTopicDirective --------------------------------------------------------------

test('directive carries subject, angle, query, and the demand evidence', () => {
  const directive = buildTopicDirective(CAND({ medianViews: 123_456.7 }));
  assert.ok(directive.includes('house cat'));
  assert.ok(directive.includes('how do cats drink water'));
  assert.ok(directive.includes('123,457'));
});
