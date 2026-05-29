import { ICON_DICT } from './iconDict.js';
import type { WordTiming } from './types.js';

export type IconEvent = {
  start: number;
  emoji: string;
};

const COOLDOWN_SEC = 12;
const MAX_PER_SECTION = 1;

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

export function extractIconEvents(
  words: WordTiming[],
  context: string,
): IconEvent[] {
  const events: IconEvent[] = [];
  const lastUseByEmoji: Record<string, number> = {};
  const allowed = buildContextSet(context);

  for (const w of words) {
    if (events.length >= MAX_PER_SECTION) break;
    const hit = lookupEmoji(w.text);
    if (!hit) continue;
    if (!allowed.has(hit.key)) continue;
    const last = lastUseByEmoji[hit.emoji] ?? -Infinity;
    if (w.start - last < COOLDOWN_SEC) continue;
    events.push({ start: w.start, emoji: hit.emoji });
    lastUseByEmoji[hit.emoji] = w.start;
  }
  return events;
}
