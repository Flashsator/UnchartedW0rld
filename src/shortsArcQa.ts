import type { Episode } from './types.js';
import { ENABLE_SHORTS_ARC_QA } from './config.js';
import { log } from './utils.js';

// The fixed sections republished as standalone Shorts (planShortsForToday):
// section 0 = same-day teaser, sections 3/5 = off-day drips. This is 100% of
// Shorts, so verifying these three covers every published Short.
export const SHORTS_SECTION_INDICES: readonly number[] = [0, 3, 5];

// TTS runs ~178 wpm; budget the self-contained arc at ~50s of speech (≈148
// words), comfortably under the 55s hard cut (MAX_SHORTS_SEC) so a genuine
// 45-50s arc passes without over-triggering a regeneration.
const WORDS_PER_MINUTE = 178;
const ARC_BUDGET_SEC = 50;
export const SHORTS_ARC_MAX_WORDS = Math.round((WORDS_PER_MINUTE * ARC_BUDGET_SEC) / 60); // 148

// Split narration into spoken sentences on a terminal . ! ? followed by a space
// or end-of-string, so decimals like "0.02" stay intact (mirrors firstSentence
// in shortsGen). Pure/exported for testing.
export function splitSentences(narration: string): string[] {
  const clean = (narration ?? '').trim().replace(/\s+/g, ' ');
  if (!clean) return [];
  const out: string[] = [];
  const re = /.*?[.!?](?=\s|$)/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) {
    out.push(m[0].trim());
    lastIndex = re.lastIndex;
  }
  const tail = clean.slice(lastIndex).trim();
  if (tail) out.push(tail);
  return out.filter(Boolean);
}

export function countWords(text: string): number {
  const clean = (text ?? '').trim();
  return clean ? clean.split(/\s+/).length : 0;
}

// Deterministic word-budget check on the marked arc.
//  'overflow' = the marked arc's narration exceeds the ~50s word budget, so the
//              answer would be chopped by the hard cut (a regen trigger);
//  'unknown'  = no usable marker (missing/<1, or beyond the section's sentence
//              count) — leave it to the blind cut, never regenerate on this;
//  'ok'       = the arc fits the budget.
export function checkShortsArc(
  narration: string,
  arcSentences: number | undefined,
): 'ok' | 'overflow' | 'unknown' {
  if (!arcSentences || arcSentences < 1) return 'unknown';
  const sentences = splitSentences(narration);
  if (sentences.length === 0 || arcSentences > sentences.length) return 'unknown';
  const words = countWords(sentences.slice(0, arcSentences).join(' '));
  return words > SHORTS_ARC_MAX_WORDS ? 'overflow' : 'ok';
}

// Which Short sections (0/3/5) overflow the budget. Deterministic, no CLI, always
// on — drives the bounded regen in generateEpisode. Pure/exported for testing.
export function shortsArcOverflowSections(ep: Episode): number[] {
  const out: number[] = [];
  for (const idx of SHORTS_SECTION_INDICES) {
    const sec = ep.sections[idx];
    if (!sec) continue;
    if (checkShortsArc(sec.narration ?? '', sec.shortsArcSentences) === 'overflow') out.push(idx);
  }
  return out;
}

// --- Gated LLM judge ----------------------------------------------------------
// Independently verifies that each Short opening both POSES and RESOLVES a
// question inside the ~50s window, corrects the marker, and flags sections that
// never resolve. Gated behind ENABLE_SHORTS_ARC_QA; best-effort/non-fatal.

const ARC_QA_TIMEOUT_MS = 90 * 1000;

export type ArcVerdict = { resolvesInWindow: boolean; resolveSentence: number | null };

// runClaudeCli is INJECTED (not imported) to avoid a scriptGen <-> shortsArcQa
// import cycle: scriptGen imports this module, so this module must not import it.
export type RunCli = (
  prompt: string,
  opts?: { extraArgs?: readonly string[]; timeoutMs?: number },
) => Promise<string>;

export function buildArcQaPrompt(
  sections: ReadonlyArray<{ index: number; narration: string }>,
): string {
  const blocks = sections
    .map((s) => `### SECTION ${s.index}\n${s.narration.trim()}`)
    .join('\n\n');
  return [
    'You are a strict editor verifying that the OPENING of each narration section',
    'works as a STANDALONE short video (a "Short").',
    '',
    `A Short ships only the first ~${ARC_BUDGET_SEC} seconds of the section — about`,
    `${SHORTS_ARC_MAX_WORDS} words, the first handful of spoken sentences. Within that`,
    'window the narration must (a) POSE a clear question or curiosity hook, and',
    '(b) fully RESOLVE it so a cold viewer who never sees the rest gets a complete,',
    'satisfying answer.',
    '',
    'For EACH section below, count its sentences from 1 and decide:',
    '- resolvesInWindow: true only if the hook it opens with is fully answered',
    `  on or before sentence ~6 AND within ~${SHORTS_ARC_MAX_WORDS} words; else false.`,
    '- resolveSentence: the 1-based sentence number of the LAST sentence a viewer',
    '  needs to hear to get that full answer (the arc end). If it never resolves in',
    '  the window, set resolveSentence to null and resolvesInWindow to false.',
    '',
    'Reply with ONLY a JSON object mapping each section index (as a string key) to',
    '{"resolvesInWindow": boolean, "resolveSentence": number|null}. No prose, no',
    'code fence. Example: {"0":{"resolvesInWindow":true,"resolveSentence":5}}',
    '',
    blocks,
  ].join('\n');
}

export function parseArcQaVerdicts(raw: string): Record<number, ArcVerdict> {
  const out: Record<number, ArcVerdict> = {};
  const match = (raw ?? '').match(/\{[\s\S]*\}/);
  if (!match) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== 'object') return out;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const idx = Number(key);
    if (!Number.isInteger(idx) || idx < 0) continue;
    if (!value || typeof value !== 'object') continue;
    const rec = value as Record<string, unknown>;
    const resolvesInWindow = rec.resolvesInWindow === true;
    const rs = typeof rec.resolveSentence === 'number' ? rec.resolveSentence : Number(rec.resolveSentence);
    const resolveSentence = Number.isFinite(rs) && rs >= 1 ? Math.floor(rs) : null;
    out[idx] = { resolvesInWindow, resolveSentence };
  }
  return out;
}

// Apply the judge's verdicts immutably: correct each Short section's marker to
// the judge's resolveSentence (only when it does NOT itself overflow the budget),
// and collect the indices the judge says never resolve in the window so the
// caller can trigger a bounded regeneration. Pure/exported for testing.
export function applyArcVerdicts(
  ep: Episode,
  verdicts: Record<number, ArcVerdict>,
): { episode: Episode; unresolved: number[] } {
  const unresolved: number[] = [];
  const sections = ep.sections.map((sec, i) => {
    if (!SHORTS_SECTION_INDICES.includes(i)) return sec;
    const v = verdicts[i];
    if (!v) return sec;
    if (!v.resolvesInWindow) {
      unresolved.push(i);
      return sec;
    }
    if (
      v.resolveSentence !== null &&
      checkShortsArc(sec.narration ?? '', v.resolveSentence) !== 'overflow'
    ) {
      return { ...sec, shortsArcSentences: v.resolveSentence };
    }
    return sec;
  });
  return { episode: { ...ep, sections }, unresolved };
}

export async function refineShortsArcs(
  ep: Episode,
  runCli: RunCli,
): Promise<{ episode: Episode; unresolved: number[] }> {
  if (!ENABLE_SHORTS_ARC_QA) return { episode: ep, unresolved: [] };
  const sections = SHORTS_SECTION_INDICES.map((index) => ({
    index,
    narration: (ep.sections[index]?.narration ?? '').trim(),
  })).filter((s) => s.narration.length > 0);
  if (sections.length === 0) return { episode: ep, unresolved: [] };
  try {
    const raw = await runCli(buildArcQaPrompt(sections), { timeoutMs: ARC_QA_TIMEOUT_MS });
    const verdicts = parseArcQaVerdicts(raw);
    const result = applyArcVerdicts(ep, verdicts);
    log(
      `Shorts arc QA: judged ${sections.length} section(s), ` +
        `${result.unresolved.length} unresolved${result.unresolved.length ? ` [${result.unresolved.join(',')}]` : ''}.`,
    );
    return result;
  } catch (err) {
    log(`Shorts arc QA unavailable (${(err as Error).message}); keeping markers as-is.`);
    return { episode: ep, unresolved: [] };
  }
}
