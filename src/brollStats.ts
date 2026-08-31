// Run-scoped b-roll fallback telemetry.
//
// The long-form b-roll path stacks several safety nets on top of the primary
// provider fetch — vision-QA drops, Wikimedia Commons stills, Unsplash Ken
// Burns fills, hero-segment reuse, cross-section backfill, explainer cards,
// rest-beat stills. Each is individually justified (see CLAUDE.md invariant #3),
// but until now nothing recorded HOW OFTEN each one actually fires. That left us
// unable to tell a net that earns its keep from dead code, or to notice a net
// that fires constantly (an upstream invariant-#3 smell — the subject is hard to
// film — that should be fixed at the topic gate, not papered over downstream).
//
// This module is deliberately tiny: a process-wide counter the pipeline resets
// at the top of the b-roll step and logs once at the end. The pipeline runs one
// episode per process, so a module singleton is exactly one run's worth of
// counts. It is pure telemetry — incrementing a counter never changes which clip
// ships, so it cannot affect a live video (and invariant #1/#3 are untouched).
// The counter logic and the formatter are pure and unit-tested.

export type BrollStatKey =
  | 'visionDrop' // vision QA judged a downloaded clip clearly off-subject and dropped it
  | 'commonsFill' // a Wikimedia Commons still filled a beat the providers left short
  | 'inaturalistFill' // a species-accurate iNaturalist still filled a beat (below Commons)
  | 'unsplashFill' // an Unsplash Ken Burns still filled a beat (below iNaturalist)
  | 'heroSegment' // an extra slot was realized as a time-window cut of the beat's hero clip
  | 'heroSegmentDropped' // a hero segment couldn't be cut, so the slot was dropped (not repeated)
  | 'sectionBackfill' // a whole section came up empty and borrowed on-subject clips from others
  | 'cardFired' // an off-subject slot was replaced by a self-built explainer card
  | 'cardIllustration' // an explainer card got a vision-QA'd AI illustration background
  | 'restStill'; // a slot was rendered as a near-motionless rest-beat still

export const BROLL_STAT_KEYS: BrollStatKey[] = [
  'visionDrop',
  'commonsFill',
  'inaturalistFill',
  'unsplashFill',
  'heroSegment',
  'heroSegmentDropped',
  'sectionBackfill',
  'cardFired',
  'cardIllustration',
  'restStill',
];

// Short human labels for the one-line run summary.
const STAT_LABELS: Record<BrollStatKey, string> = {
  visionDrop: 'vision-drop',
  commonsFill: 'commons',
  inaturalistFill: 'inaturalist',
  unsplashFill: 'unsplash',
  heroSegment: 'hero-seg',
  heroSegmentDropped: 'hero-seg-dropped',
  sectionBackfill: 'section-backfill',
  cardFired: 'cards',
  cardIllustration: 'card-art',
  restStill: 'rest-stills',
};

export type BrollStats = Record<BrollStatKey, number>;

export function emptyBrollStats(): BrollStats {
  return {
    visionDrop: 0,
    commonsFill: 0,
    inaturalistFill: 0,
    unsplashFill: 0,
    heroSegment: 0,
    heroSegmentDropped: 0,
    sectionBackfill: 0,
    cardFired: 0,
    cardIllustration: 0,
    restStill: 0,
  };
}

let current: BrollStats = emptyBrollStats();

export function resetBrollStats(): void {
  current = emptyBrollStats();
}

export function bumpBrollStat(key: BrollStatKey, n = 1): void {
  if (n <= 0) return;
  current[key] += n;
}

export function snapshotBrollStats(): BrollStats {
  return { ...current };
}

// Pure: renders a compact single line naming only the nets that actually fired
// this run, e.g. "B-roll fallbacks: vision-drop×2, commons×1, hero-seg×4". When
// every net stayed idle (the common-subject happy path) it says so explicitly,
// which is itself a useful signal — a run where a net NEVER fires over weeks is a
// candidate for removal.
export function formatBrollStats(stats: BrollStats): string {
  const parts = BROLL_STAT_KEYS.filter((k) => stats[k] > 0).map(
    (k) => `${STAT_LABELS[k]}×${stats[k]}`,
  );
  if (parts.length === 0) return 'B-roll fallbacks: none fired (all primary provider footage)';
  return `B-roll fallbacks: ${parts.join(', ')}`;
}
