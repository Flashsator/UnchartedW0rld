import fs from 'node:fs';
import path from 'node:path';
import {
  THUMB_LAYOUTS,
  THUMB_LAYOUT_LOG_FILE,
  THUMB_LAYOUT_MIN_SAMPLES,
  persistLastThumbLayout,
  readLastThumbLayout,
  type ThumbLayout,
} from './config.js';
import { log } from './utils.js';

// Thumbnail layout learning: every upload logs which of the five layouts the
// video shipped with. Once enough videos per layout have measured CTR (via the
// analytics feedback loop), layout selection shifts from blind rotation to a
// CTR-weighted draw — layouts that win clicks come up more often, but every
// layout keeps a nonzero share so the data never goes stale. Until the data
// exists, the picker silently falls back to the existing no-repeat rotation,
// so this changes nothing on a young channel.

export interface LayoutLogEntry {
  videoId: string;
  layout: ThumbLayout;
}

// --- Pure helpers (unit-tested) -------------------------------------------------

// Parses the log ("videoId<TAB>layout" per line). Unknown layouts are dropped
// (a removed layout must not poison the stats); on duplicate video ids the
// LAST entry wins (a CTR-rescue re-render replaces the layout that's live).
export function parseLayoutLog(text: string): LayoutLogEntry[] {
  const byVideo = new Map<string, ThumbLayout>();
  for (const line of text.split(/\r?\n/)) {
    const [videoId, layout] = line.split('\t').map((s) => s?.trim());
    if (!videoId || !layout) continue;
    if (!(THUMB_LAYOUTS as string[]).includes(layout)) continue;
    byVideo.set(videoId, layout as ThumbLayout);
  }
  return [...byVideo].map(([videoId, layout]) => ({ videoId, layout }));
}

// Average measured CTR per layout. Layouts with fewer than minSamples measured
// videos get the global mean instead — unproven is not the same as bad, and
// the optimistic prior keeps them in rotation until they have a real verdict.
export function layoutCtrWeights(
  entries: LayoutLogEntry[],
  ctrByVideo: ReadonlyMap<string, number>,
  minSamples: number = THUMB_LAYOUT_MIN_SAMPLES,
): Map<ThumbLayout, number> | null {
  const samples = new Map<ThumbLayout, number[]>();
  for (const e of entries) {
    const ctr = ctrByVideo.get(e.videoId);
    if (typeof ctr !== 'number' || !Number.isFinite(ctr)) continue;
    samples.set(e.layout, [...(samples.get(e.layout) ?? []), ctr]);
  }
  const measured = [...samples.values()].flat();
  // No layout has a verdict yet — tell the caller to stay on blind rotation.
  if (measured.length === 0 || ![...samples.values()].some((s) => s.length >= minSamples)) {
    return null;
  }
  const globalMean = measured.reduce((a, b) => a + b, 0) / measured.length;
  const weights = new Map<ThumbLayout, number>();
  for (const layout of THUMB_LAYOUTS) {
    const s = samples.get(layout) ?? [];
    const avg = s.length >= minSamples ? s.reduce((a, b) => a + b, 0) / s.length : globalMean;
    // Floor at a small epsilon so a 0%-CTR layout stays drawable (rarely).
    weights.set(layout, Math.max(avg, globalMean * 0.1, 0.01));
  }
  return weights;
}

// Weighted draw. `rand` is injectable for tests; `exclude` enforces the
// existing no-repeat rule against the previous upload's layout.
export function pickWeighted(
  weights: ReadonlyMap<ThumbLayout, number>,
  exclude: string | null = null,
  rand: () => number = Math.random,
): ThumbLayout {
  const pool = [...weights].filter(([layout]) => layout !== exclude);
  const usable = pool.length > 0 ? pool : [...weights];
  const total = usable.reduce((sum, [, w]) => sum + w, 0);
  let roll = rand() * total;
  for (const [layout, w] of usable) {
    roll -= w;
    if (roll <= 0) return layout;
  }
  return usable[usable.length - 1]![0];
}

// --- File-backed log -------------------------------------------------------------

export function loadLayoutLog(file: string = THUMB_LAYOUT_LOG_FILE): LayoutLogEntry[] {
  try {
    return parseLayoutLog(fs.readFileSync(file, 'utf-8'));
  } catch {
    return [];
  }
}

// Appends one upload's layout to the log (last entry per video wins on read).
export function recordThumbLayout(
  videoId: string,
  layout: ThumbLayout,
  file: string = THUMB_LAYOUT_LOG_FILE,
): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${videoId}\t${layout}\n`, 'utf-8');
  } catch (e) {
    log(`Thumb layout log: could not persist (continuing): ${(e as Error).message}`);
  }
}

// --- Main picker ------------------------------------------------------------------

// Drop-in upgrade over pickThumbLayout: when per-layout CTR evidence exists
// (analytics feedback on + enough logged uploads measured), draws a layout
// weighted by its measured CTR; otherwise falls back to the blind no-repeat
// rotation. `performances` is whatever CTR-bearing rows the caller already has
// (fetchTopPerformers output or the CTR-rescue measurement set).
// `exclude` defaults to the previous upload's layout (the no-repeat rule); a
// CTR rescue passes the target video's own logged layout instead, so the
// replacement is guaranteed to actually look different. The rescue also passes
// `persist: false` — the `.last-thumb-layout` state belongs to the daily
// upload rotation, and a mid-run rescue must not clobber it.
export function pickThumbLayoutWeighted(
  performances: ReadonlyArray<{ videoId: string; ctr?: number }>,
  exclude: string | null = readLastThumbLayout(),
  persist = true,
): ThumbLayout {
  const entries = loadLayoutLog();
  const ctrByVideo = new Map(
    performances
      .filter((p) => typeof p.ctr === 'number' && Number.isFinite(p.ctr))
      .map((p) => [p.videoId, p.ctr as number]),
  );
  const weights = layoutCtrWeights(entries, ctrByVideo);
  if (!weights) {
    // Blind no-repeat fallback — same draw as config's pickThumbLayout, but
    // honoring the caller's exclude (a rescue avoids the target's OWN layout,
    // not the last upload's).
    const pool = THUMB_LAYOUTS.filter((l) => l !== exclude);
    const usable = pool.length > 0 ? pool : THUMB_LAYOUTS;
    const chosen = usable[Math.floor(Math.random() * usable.length)]!;
    if (persist) persistLastThumbLayout(chosen);
    return chosen;
  }
  const chosen = pickWeighted(weights, exclude);
  if (persist) persistLastThumbLayout(chosen);
  log(
    `Thumb layout: CTR-weighted pick "${chosen}" (weights: ${[...weights]
      .map(([l, w]) => `${l}=${w.toFixed(2)}`)
      .join(', ')})`,
  );
  return chosen;
}
