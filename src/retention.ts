import { google } from 'googleapis';
import {
  ANALYTICS_LOOKBACK_DAYS,
  ENABLE_ANALYTICS_FEEDBACK,
  SECTION_COUNT,
  YT_CLIENT_ID,
  YT_CLIENT_SECRET,
  YT_REFRESH_TOKEN,
} from './config.js';
import { log, parseIsoDuration } from './utils.js';

// Retention feedback loop: where do viewers actually leave? The Analytics API's
// audienceWatchRatio (per elapsedVideoTimeRatio bucket) is the per-video
// retention curve. We sample the channel's recent long-form videos, find the
// two patterns that decide a video's fate — how many starters bail in the first
// moments, and where the steepest mid-video drop sits — and hand the script
// generator a measured, channel-specific pacing directive. Like the winning-
// titles steer this rides ENABLE_ANALYTICS_FEEDBACK and is best-effort: until
// the young channel accrues curve data it quietly returns undefined.

// How many recent long-form videos to average the curves over. Few enough to
// stay cheap, enough that one outlier video can't dictate the directive.
const RETENTION_SAMPLE_VIDEOS = 4;
// A curve with fewer buckets than this is too coarse to localize a drop.
const RETENTION_MIN_POINTS = 20;
// "Early exit" is measured at this elapsed ratio — ~30s of a 9.5-min video.
const EARLY_MARK = 0.05;
// The steepest-drop scan ignores the very start (intro churn is universal) and
// the very end (outro exits are expected and not worth optimizing).
const MID_SCAN_START = 0.08;
const MID_SCAN_END = 0.92;
// Shorts never reach the Analytics curve query; anything shorter is skipped.
const LONG_FORM_MIN_SEC = 120;
// Early exit below this is normal churn, not a writing problem — prescribing
// "denser opening" against healthy numbers just churns a working formula.
const EARLY_EXIT_CONCERN_PCT = 15;

export interface RetentionPoint {
  // Position in the video, 0..1 (elapsedVideoTimeRatio bucket).
  elapsed: number;
  // Fraction of starters still watching at that position (audienceWatchRatio;
  // can exceed 1 on rewatched moments).
  watching: number;
}

export interface RetentionInsight {
  // Percent of starters gone by EARLY_MARK (0-100).
  earlyExitPct: number;
  // Elapsed ratio (0..1) where the steepest mid-video drop begins.
  steepestDropAt: number;
  // Size of that drop in percentage points of the starting audience.
  steepestDropPct: number;
}

// --- Pure helpers (unit-tested) -------------------------------------------------

// Reduces one retention curve to the two numbers that matter. Null when the
// curve is too sparse to trust.
export function analyzeRetention(points: RetentionPoint[]): RetentionInsight | null {
  if (points.length < RETENTION_MIN_POINTS) return null;
  const sorted = [...points].sort((a, b) => a.elapsed - b.elapsed);

  const atEarly = sorted.filter((p) => p.elapsed <= EARLY_MARK).at(-1) ?? sorted[0]!;
  const earlyExitPct = Math.max(0, Math.min(100, (1 - atEarly.watching) * 100));

  let steepestDropAt = 0;
  let steepestDropPct = 0;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]!;
    const b = sorted[i + 1]!;
    if (a.elapsed < MID_SCAN_START || b.elapsed > MID_SCAN_END) continue;
    const drop = (a.watching - b.watching) * 100;
    if (drop > steepestDropPct) {
      steepestDropPct = drop;
      steepestDropAt = a.elapsed;
    }
  }
  return { earlyExitPct, steepestDropAt, steepestDropPct };
}

// Maps an elapsed ratio to a 1-based section number. Approximate by design —
// sections are near-equal narration blocks and the directive only needs to
// point the writer at the right neighborhood, not a timestamp.
export function sectionForElapsed(elapsed: number, sectionCount: number = SECTION_COUNT): number {
  if (sectionCount <= 0) return 1;
  const clamped = Math.max(0, Math.min(0.999, elapsed));
  return Math.floor(clamped * sectionCount) + 1;
}

// Averages the per-video insights into one channel-level pacing directive for
// the script prompt. Null when no video produced a usable curve.
export function buildRetentionDirective(
  insights: RetentionInsight[],
  sectionCount: number = SECTION_COUNT,
): string | null {
  const usable = insights.filter((i) => Number.isFinite(i.earlyExitPct));
  if (usable.length === 0) return null;
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const earlyExit = avg(usable.map((i) => i.earlyExitPct));
  const withDrop = usable.filter((i) => i.steepestDropPct > 0);

  const lines = [
    'RETENTION FEEDBACK (measured on this channel\'s recent videos — let it shape pacing, never mention it in the narration):',
    earlyExit > EARLY_EXIT_CONCERN_PCT
      ? `- ~${Math.round(earlyExit)}% of viewers leave within the first ~5% of the video. Make the opening even denser: hook, promise tail, then the FIRST concrete scene within the first three sentences. No throat-clearing.`
      : `- Early retention is healthy (~${Math.round(earlyExit)}% leave within the first ~5%). Keep the current cold-open formula — do not restructure the opening.`,
  ];
  if (withDrop.length > 0) {
    const dropAt = avg(withDrop.map((i) => i.steepestDropAt));
    const dropPct = avg(withDrop.map((i) => i.steepestDropPct));
    const section = sectionForElapsed(dropAt, sectionCount);
    lines.push(
      `- The steepest mid-video drop (~${Math.round(dropPct)} points of audience) starts around the ${Math.round(
        dropAt * 100,
      )}% mark — roughly section ${section} of ${sectionCount}. End the section BEFORE that zone on your strongest unresolved hook, and open section ${section} by paying off a withheld answer, not with setup.`,
    );
  }
  return lines.join('\n');
}

// --- Network fetch (best-effort, non-fatal) --------------------------------------

function getClients() {
  if (!YT_CLIENT_ID || !YT_CLIENT_SECRET || !YT_REFRESH_TOKEN) {
    throw new Error('YouTube OAuth env vars missing (YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REFRESH_TOKEN)');
  }
  const oauth = new google.auth.OAuth2(YT_CLIENT_ID, YT_CLIENT_SECRET);
  oauth.setCredentials({ refresh_token: YT_REFRESH_TOKEN });
  return {
    analytics: google.youtubeAnalytics({ version: 'v2', auth: oauth }),
    data: google.youtube({ version: 'v3', auth: oauth }),
  };
}

// Most recent long-form video ids from the uploads playlist (mirrors
// listUploadedTitles, but keeps the ids and filters Shorts out by duration).
async function recentLongFormIds(
  data: ReturnType<typeof google.youtube>,
  max: number,
): Promise<string[]> {
  const ch = await data.channels.list({ part: ['contentDetails'], mine: true });
  const uploads = ch.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) return [];
  const res = await data.playlistItems.list({
    part: ['contentDetails'],
    playlistId: uploads,
    maxResults: 50,
  });
  const ids = (res.data.items ?? [])
    .map((i) => i.contentDetails?.videoId)
    .filter((id): id is string => Boolean(id));
  if (ids.length === 0) return [];
  const details = await data.videos.list({ part: ['contentDetails'], id: ids.slice(0, 50) });
  const longForm = new Set(
    (details.data.items ?? [])
      .filter((v) => parseIsoDuration(v.contentDetails?.duration) >= LONG_FORM_MIN_SEC)
      .map((v) => v.id ?? ''),
  );
  return ids.filter((id) => longForm.has(id)).slice(0, max);
}

async function fetchCurve(
  analytics: ReturnType<typeof google.youtubeAnalytics>,
  videoId: string,
): Promise<RetentionPoint[]> {
  const endDate = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - ANALYTICS_LOOKBACK_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const res = await analytics.reports.query({
    ids: 'channel==MINE',
    startDate,
    endDate,
    metrics: 'audienceWatchRatio',
    dimensions: 'elapsedVideoTimeRatio',
    filters: `video==${videoId}`,
  });
  return (res.data.rows ?? []).map((r) => ({
    elapsed: Number(r[0]) || 0,
    watching: Number(r[1]) || 0,
  }));
}

// Main entry, called before generateEpisode. Returns the pacing directive or
// undefined (disabled / no data / any failure) — the script prompt is unchanged
// in that case, mirroring validateTopicDemand's contract.
export async function fetchRetentionDirective(): Promise<string | undefined> {
  if (!ENABLE_ANALYTICS_FEEDBACK) return undefined;
  try {
    const { analytics, data } = getClients();
    const ids = await recentLongFormIds(data, RETENTION_SAMPLE_VIDEOS);
    if (ids.length === 0) {
      log('Retention feedback: no long-form videos found yet — skipping.');
      return undefined;
    }
    const insights: RetentionInsight[] = [];
    for (const id of ids) {
      const curve = await fetchCurve(analytics, id);
      const insight = analyzeRetention(curve);
      if (insight) insights.push(insight);
    }
    const directive = buildRetentionDirective(insights);
    if (!directive) {
      log('Retention feedback: no usable retention curves yet (young channel) — skipping.');
      return undefined;
    }
    log(`Retention feedback: directive built from ${insights.length} video curve(s).`);
    return directive;
  } catch (e) {
    log(`Retention feedback skipped (continuing): ${(e as Error).message}`);
    return undefined;
  }
}
