import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAuditPrompt,
  formatAuditEntry,
  hookLineFromDescription,
  parseAuditVerdict,
  type AuditVideo,
} from '../src/contentAudit.ts';

const VID = (over: Partial<AuditVideo> = {}): AuditVideo => ({
  title: 'The Cat That Hears in Ultrasound',
  hookLine: 'A house cat can hear frequencies no human ear will ever register.',
  tags: ['weird animals', 'how do cats hear', 'feline hearing range'],
  ...over,
});

// --- hookLineFromDescription -----------------------------------------------------

test('takes the first sentence and strips the trailing hashtag block', () => {
  const desc =
    'A house cat can hear into ultrasound. Then it does something stranger.\n\n#cats #science #nature';
  assert.equal(
    hookLineFromDescription(desc),
    'A house cat can hear into ultrasound.',
  );
});

test('falls back to the first non-empty line when there is no sentence break', () => {
  assert.equal(hookLineFromDescription('\n\n  Just one clause here  \n'), 'Just one clause here');
});

test('returns empty string for an empty description', () => {
  assert.equal(hookLineFromDescription(''), '');
});

// --- buildAuditPrompt ------------------------------------------------------------

test('prompt lists every video with title, hook and tags, and asks for JSON', () => {
  const prompt = buildAuditPrompt([VID(), VID({ title: 'Second One', tags: [] })]);
  assert.ok(prompt.includes('The Cat That Hears in Ultrasound'));
  assert.ok(prompt.includes('Second One'));
  assert.ok(prompt.includes('(none)')); // empty tags render as (none)
  assert.ok(prompt.includes('PLAYBOOK'));
  assert.ok(/Output ONLY a JSON object/.test(prompt));
});

// --- parseAuditVerdict -----------------------------------------------------------

test('parses a clean verdict object', () => {
  const raw = JSON.stringify({
    score: 8,
    regression: false,
    findings: ['Title 2 buries the subject behind a label prefix.'],
    topFix: 'Front-load the subject in title 2.',
  });
  const v = parseAuditVerdict(raw);
  assert.equal(v?.score, 8);
  assert.equal(v?.regression, false);
  assert.equal(v?.findings.length, 1);
  assert.equal(v?.topFix, 'Front-load the subject in title 2.');
});

test('treats a low score as a regression even when the model said false', () => {
  const raw = JSON.stringify({ score: 3, regression: false, findings: [], topFix: '' });
  assert.equal(parseAuditVerdict(raw)?.regression, true);
});

test('honors an explicit regression flag at a passing score', () => {
  const raw = JSON.stringify({ score: 7, regression: true, findings: ['drift'], topFix: 'fix' });
  assert.equal(parseAuditVerdict(raw)?.regression, true);
});

test('tolerates prose around the JSON and drops blank findings', () => {
  const raw =
    'Here is my audit:\n```json\n' +
    JSON.stringify({ score: 6, regression: false, findings: ['real', '', '   '], topFix: 'x' }) +
    '\n```\nHope it helps.';
  const v = parseAuditVerdict(raw);
  assert.equal(v?.findings.length, 1);
  assert.equal(v?.findings[0], 'real');
});

test('returns null when there is no usable score', () => {
  assert.equal(parseAuditVerdict('no json at all'), null);
  assert.equal(parseAuditVerdict(JSON.stringify({ regression: true })), null);
});

// --- formatAuditEntry ------------------------------------------------------------

test('formats a dated block and marks a regression', () => {
  const entry = formatAuditEntry(
    { score: 4, regression: true, findings: ['a', 'b'], topFix: 'do x' },
    new Date('2026-06-15T12:00:00Z'),
  );
  assert.ok(entry.includes('## 2026-06-15 — score 4/10 ⚠ REGRESSION'));
  assert.ok(entry.includes('- a'));
  assert.ok(entry.includes('- b'));
  assert.ok(entry.includes('TOP FIX: do x'));
});

test('omits the regression marker and renders a placeholder with no findings', () => {
  const entry = formatAuditEntry(
    { score: 9, regression: false, findings: [], topFix: '' },
    new Date('2026-06-15T12:00:00Z'),
  );
  assert.ok(entry.includes('## 2026-06-15 — score 9/10'));
  assert.ok(!entry.includes('REGRESSION'));
  assert.ok(entry.includes('(no findings returned)'));
});
