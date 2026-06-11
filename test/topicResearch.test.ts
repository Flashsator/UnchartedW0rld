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

test('picks the candidate with the highest median views', () => {
  const scored = [
    CAND({ subject: 'low', medianViews: 1_000 }),
    CAND({ subject: 'high', medianViews: 500_000 }),
    CAND({ subject: 'mid', medianViews: 50_000 }),
  ];
  assert.equal(pickBestCandidate(scored)?.subject, 'high');
});

test('returns null when every candidate scored zero (all probes failed)', () => {
  const scored = [CAND({ medianViews: 0 }), CAND({ subject: 'b', medianViews: 0 })];
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
