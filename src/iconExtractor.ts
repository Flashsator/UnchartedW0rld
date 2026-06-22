import { ICON_DICT } from './iconDict.js';
import type { IconEvent, WordTiming } from './types.js';

const COOLDOWN_SEC = 12;
const MAX_PER_SECTION = 1;
// Number of abstract corner motifs the renderer knows (IconOverlay.CornerMotif).
const MOTIF_COUNT = 4;

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function normalize(token: string): string {
  return token.toLowerCase().replace(/[^a-z]/g, '');
}

function lookupEmoji(token: string): { key: string; emoji: string } | null {
  const t = normalize(token);
  if (!t) return null;
  if (ICON_DICT[t]) return { key: t, emoji: ICON_DICT[t]! };
  if (t.endsWith('ies')) {
    const k = t.slice(0, -3) + 'y';
    if (ICON_DICT[k]) return { key: k, emoji: ICON_DICT[k]! };
  }
  if (t.endsWith('es')) {
    const k = t.slice(0, -2);
    if (ICON_DICT[k]) return { key: k, emoji: ICON_DICT[k]! };
  }
  if (t.endsWith('s')) {
    const k = t.slice(0, -1);
    if (ICON_DICT[k]) return { key: k, emoji: ICON_DICT[k]! };
  }
  return null;
}

function buildContextSet(context: string): Set<string> {
  const out = new Set<string>();
  for (const raw of context.split(/\s+/)) {
    const t = normalize(raw);
    if (!t) continue;
    out.add(t);
    if (t.endsWith('s')) out.add(t.slice(0, -1));
    if (t.endsWith('es')) out.add(t.slice(0, -2));
    if (t.endsWith('ies')) out.add(t.slice(0, -3) + 'y');
  }
  return out;
}

// `avoidEmojis` carries the emoji already shown EARLIER in the same episode
// (accumulated section-by-section by the caller) so the corner overlay never
// repeats the same glyph across sections — variety, not fewer icons. A repeat
// is skipped and scanning continues into the section's later words, so the
// section can still surface a DIFFERENT matching subject (or none) instead of
// stopping at the first already-used hit. Invariant #1 holds: the emoji is
// decorative and only fires when its subject word is actually spoken AND in the
// section's heading/visual context.
export function extractIconEvents(
  words: WordTiming[],
  context: string,
  avoidEmojis: ReadonlySet<string> = new Set(),
): IconEvent[] {
  const events: IconEvent[] = [];
  const lastUseByEmoji: Record<string, number> = {};
  const allowed = buildContextSet(context);

  for (const w of words) {
    if (events.length >= MAX_PER_SECTION) break;
    const hit = lookupEmoji(w.text);
    if (!hit) continue;
    if (!allowed.has(hit.key)) continue;
    if (avoidEmojis.has(hit.emoji)) continue;
    const last = lastUseByEmoji[hit.emoji] ?? -Infinity;
    if (w.start - last < COOLDOWN_SEC) continue;
    events.push({ start: w.start, emoji: hit.emoji });
    lastUseByEmoji[hit.emoji] = w.start;
  }

  // No faithful subject glyph matched (none in the dict, none in context, or the
  // only match was already used elsewhere in the episode) → fall back to ONE
  // abstract animated motif so the corner beat still lands instead of going
  // blank (user directive: match the words with an icon, else use animation).
  // It depicts nothing specific, so invariant #1 is trivially safe — pure
  // decoration that asserts no creature or claim. The variant is chosen from the
  // section context so different sections show different motifs (variety).
  if (events.length === 0 && words.length > 0) {
    const seed = words[Math.min(words.length - 1, Math.floor(words.length * 0.3))]!;
    events.push({ start: seed.start, motif: hashStr(context) % MOTIF_COUNT });
  }

  return events;
}
