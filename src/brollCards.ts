import type { BrollCard, BrollClip, WordTiming } from './types.js';
import {
  ENABLE_BROLL_CARDS,
  BROLL_CARD_MAX_PER_SECTION,
  BROLL_CARD_OFFSUBJECT_RATIO,
  accentForSeries,
} from './config.js';

// Plan which b-roll slots in ONE long-form section should be replaced by a
// self-built explainer card instead of an off-subject clip. PURE and unit-
// tested: given the section's clips (each tagged onSubject by stock.ts), its
// narration words, the cut times, and section metadata, it returns an array
// index-aligned to `clips` — `result[i]` is a BrollCard to render in slot i, or
// null to keep the real footage.
//
// Invariants this enforces (do not relax):
//  * Conservative: only a clip PROVEN off-subject (`onSubject === false`) is ever
//    carded. `undefined` (no provider metadata to judge on) is left as footage.
//  * Capped: at most BROLL_CARD_MAX_PER_SECTION cards per section.
//  * Bail on a bad section: if MORE than BROLL_CARD_OFFSUBJECT_RATIO of slots are
//    off-subject, the subject is effectively unfilmable (invariant #3 smell) —
//    return all-null rather than paper a wall of cards over it.
//  * Cold-open slot 0 stays real footage (the episode's establishing shot).
//  * No fabricated data (invariant #1): card text comes only from THIS section's
//    own narration (a spoken figure → stat card; a verbatim clause → fact card).

export type PlanShotCardsArgs = {
  clips: readonly BrollClip[];
  words: readonly WordTiming[];
  cutTimes: readonly number[];
  totalSec: number;
  heading: string;
  subject?: string;
  seriesKey: string;
  isColdOpenSection: boolean;
  // Defaults to the live ENABLE_BROLL_CARDS gate; tests pass true explicitly so
  // they don't depend on process.env being set before import.
  enabled?: boolean;
};

export function planShotCards(args: PlanShotCardsArgs): (BrollCard | null)[] {
  const { clips, words, cutTimes, totalSec, heading, subject, seriesKey, isColdOpenSection } = args;
  const enabled = args.enabled ?? ENABLE_BROLL_CARDS;

  const result: (BrollCard | null)[] = clips.map(() => null);
  if (!enabled || clips.length === 0) return result;

  const offIdx = clips
    .map((c, i) => (c.onSubject === false ? i : -1))
    .filter((i) => i >= 0);
  if (offIdx.length === 0) return result;

  // Too many off-subject slots ⇒ the subject itself isn't filmable; bail.
  if (offIdx.length > clips.length * BROLL_CARD_OFFSUBJECT_RATIO) return result;

  const accent = accentForSeries(seriesKey);
  let made = 0;
  for (const i of offIdx) {
    if (made >= BROLL_CARD_MAX_PER_SECTION) break;
    // The opening establishing shot must stay real footage.
    if (isColdOpenSection && i === 0) continue;
    const startSec = cutTimes[i] ?? 0;
    const endSec = i + 1 < cutTimes.length ? cutTimes[i + 1]! : totalSec;
    const card = buildCard(words, startSec, endSec, heading, subject, accent);
    if (card) {
      result[i] = card;
      made++;
    }
  }
  return result;
}

// Builds the card for one slot from the narration in [startSec, endSec). A stat
// card when a spoken figure lands in the window; otherwise a fact card carrying
// a verbatim narration clause. Returns null only if there's no usable text.
function buildCard(
  words: readonly WordTiming[],
  startSec: number,
  endSec: number,
  heading: string,
  subject: string | undefined,
  accent: string,
): BrollCard | null {
  const figure = spokenFigureInWindow(words, startSec, endSec);
  if (figure) {
    return { kind: 'stat', headline: figure, caption: heading, accent };
  }
  const clause = factHeadline(words, startSec, endSec);
  if (!clause) return null;
  return { kind: 'fact', headline: clause, caption: subject || heading, accent };
}

// The first digit-bearing spoken word whose start falls in the slot window,
// cleaned to a tidy figure ("47%", "1,200", "1986"). Mirrors clipHasNumber in
// SectionScene so the same beats the overlays treat as facts drive a stat card.
function spokenFigureInWindow(
  words: readonly WordTiming[],
  startSec: number,
  endSec: number,
): string | null {
  for (const w of words) {
    if (w.start >= startSec - 0.1 && w.start < endSec && /\d/.test(w.text)) {
      const cleaned = cleanFigure(w.text);
      if (cleaned) return cleaned;
    }
  }
  return null;
}

// Strips leading non-word/non-$ chars and trailing punctuation so a spoken
// token like "(47%)." becomes "47%". Pure.
export function cleanFigure(text: string): string {
  return text
    .replace(/^[^\w$]+/, '')
    .replace(/[.,;:!?)"']+$/, '')
    .trim();
}

const FACT_MAX_WORDS = 10;

// A verbatim clause from the slot window for a fact card: the words spoken in
// the window, else a short run starting at the first word at/after startSec.
// Trimmed to FACT_MAX_WORDS and tidied (trailing punctuation dropped, first
// letter capitalized). Never rewords — the text is lifted, not generated.
function factHeadline(
  words: readonly WordTiming[],
  startSec: number,
  endSec: number,
): string | null {
  let inWindow = words.filter((w) => w.start >= startSec - 0.1 && w.start < endSec);
  if (inWindow.length === 0) {
    const from = words.findIndex((w) => w.start >= startSec - 0.1);
    if (from < 0) return null;
    inWindow = words.slice(from, from + FACT_MAX_WORDS);
  }
  if (inWindow.length === 0) return null;
  const text = inWindow
    .slice(0, FACT_MAX_WORDS)
    .map((w) => w.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .replace(/[.,;:!?]+$/, '')
    .trim();
  if (!text) return null;
  return text.charAt(0).toUpperCase() + text.slice(1);
}
