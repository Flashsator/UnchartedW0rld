import { google } from 'googleapis';
import {
  ANALYTICS_LOOKBACK_DAYS,
  ANALYTICS_TOP_N,
  YT_CLIENT_ID,
  YT_CLIENT_SECRET,
  YT_REFRESH_TOKEN,
} from './config.js';
import { log, parseIsoDuration } from './utils.js';

// A single video's performance, joined from the YouTube Analytics API (metrics)
// and the Data API (human title).
export interface VideoPerformance {
  videoId: string;
  title: string;
  views: number;
  // Average percentage of the video watched (0–100). Retention proxy.
  avgViewPct: number;
  // Click-through rate on impressions (0–100). Packaging/CTR proxy. May be
  // undefined when the channel is too small for YouTube to report it.
  ctr?: number;
  // Length in seconds (0 when unknown). Lets consumers separate long-form
  // from Shorts, e.g. the description's "Watch next" links.
  durationSec?: number;
}

// CTR is the strongest packaging signal, retention the strongest "the video
// delivered" signal; raw views is a weak tiebreak (and conflates age/promo).
const METRIC_WEIGHTS = { ctr: 0.55, retention: 0.3, views: 0.15 } as const;

// Min-max normalize to 0..1. Missing values (NaN) map to 0 so they neither win
// nor poison the blend; an all-equal column maps every present value to 0.5.
function minMax(values: number[]): number[] {
  const present = values.filter((v) => Number.isFinite(v));
  if (present.length === 0) return values.map(() => 0);
  const min = Math.min(...present);
  const max = Math.max(...present);
  if (max === min) return values.map((v) => (Number.isFinite(v) ? 0.5 : 0));
  return values.map((v) => (Number.isFinite(v) ? (v - min) / (max - min) : 0));
}

// Pure ranking: scores each video by a weighted blend of CTR, retention and
// views (each min-max normalized across the set) and returns the full rows
// best-first. When no row carries CTR, that weight is dropped and the blend
// renormalizes. Exported so the ranking can be unit-tested without the network.
export function rankPerformersFull(rows: VideoPerformance[], topN: number): VideoPerformance[] {
  if (rows.length === 0 || topN <= 0) return [];
  const ctr = minMax(rows.map((r) => (typeof r.ctr === 'number' ? r.ctr : NaN)));
  const retention = minMax(rows.map((r) => r.avgViewPct));
  const views = minMax(rows.map((r) => r.views));

  const hasCtr = rows.some((r) => typeof r.ctr === 'number');
  const wCtr = hasCtr ? METRIC_WEIGHTS.ctr : 0;
  const wTotal = wCtr + METRIC_WEIGHTS.retention + METRIC_WEIGHTS.views;

  return rows
    .map((r, i) => ({
      row: r,
      score:
        (wCtr * (ctr[i] ?? 0) +
          METRIC_WEIGHTS.retention * (retention[i] ?? 0) +
          METRIC_WEIGHTS.views * (views[i] ?? 0)) /
        wTotal,
    }))
    .filter((s) => s.row.title.trim().length > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map((s) => s.row);
}

// Title-only view of the ranking, kept for the script generator's
// winning-titles steer (and existing tests).
export function rankPerformers(rows: VideoPerformance[], topN: number): string[] {
  return rankPerformersFull(rows, topN).map((r) => r.title);
}

// "Watch next" description block: links the strongest past LONG-FORM videos so
// a satisfied viewer rolls straight into another episode (session watch-time is
// a heavy ranking signal). Shorts are excluded — a Short link in a long-form
// description breaks the binge instead of feeding it. Empty string when nothing
// qualifies, so the description join just drops the block.
const WATCH_NEXT_MIN_DURATION_SEC = 120;
const WATCH_NEXT_MAX_LINKS = 3;

export function buildWatchNextBlock(
  performers: VideoPerformance[],
  max: number = WATCH_NEXT_MAX_LINKS,
): string {
  const longForm = performers.filter(
    (p) => (p.durationSec ?? 0) >= WATCH_NEXT_MIN_DURATION_SEC && p.videoId && p.title.trim(),
  );
  if (longForm.length === 0) return '';
  const lines = longForm
    .slice(0, max)
    .map((p) => `• ${p.title.trim()}\n  https://youtu.be/${p.videoId}`);
  return ['▶ Watch next:', ...lines].join('\n');
}

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

function isoDate(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

// Core metrics every channel can report. CTR is requested opportunistically —
// small channels sometimes can't surface impressionClickThroughRate, in which
// case the richer query 400s and we retry with the core set.
const CORE_METRICS = 'views,averageViewPercentage';
const RICH_METRICS = 'views,averageViewPercentage,impressionClickThroughRate';

// Resolves video ids to their (shorts-suffix-stripped) titles + durations,
// batched to the Data API's 50-id limit.
async function fetchDetails(
  data: ReturnType<typeof google.youtube>,
  ids: string[],
): Promise<Map<string, { title: string; durationSec: number }>> {
  const byId = new Map<string, { title: string; durationSec: number }>();
  for (let i = 0; i < ids.length; i += 50) {
    const res = await data.videos.list({
      part: ['snippet', 'contentDetails'],
      id: ids.slice(i, i + 50),
    });
    for (const item of res.data.items ?? []) {
      const title = item.snippet?.title?.replace(/\s*#shorts\b/gi, '').trim();
      if (item.id && title) {
        byId.set(item.id, {
          title,
          durationSec: parseIsoDuration(item.contentDetails?.duration),
        });
      }
    }
  }
  return byId;
}

// Pulls the channel's video performance: `top` is the ranked best-performers
// slice (title steer, "Watch next" links); `all` is EVERY measured row,
// unsliced — the thumbnail-layout learner needs the losers too, or a layout
// that ships low-CTR videos never appears in the data and is never penalized
// (survivorship bias). Best-effort and non-fatal: any failure (missing scope,
// no data, API error) logs a hint and returns empty sets so the pipeline is
// never blocked — mirrors listUploadedTitles in youtube.ts.
export async function fetchChannelPerformance(
  topN = ANALYTICS_TOP_N,
): Promise<{ top: VideoPerformance[]; all: VideoPerformance[] }> {
  try {
    const { analytics, data } = getClients();
    const startDate = isoDate(ANALYTICS_LOOKBACK_DAYS);
    const endDate = isoDate(0);

    const query = (metrics: string) =>
      analytics.reports.query({
        ids: 'channel==MINE',
        startDate,
        endDate,
        metrics,
        dimensions: 'video',
        sort: '-views',
        maxResults: 200,
      });

    let hasCtr = true;
    let res;
    try {
      res = await query(RICH_METRICS);
    } catch {
      hasCtr = false;
      res = await query(CORE_METRICS);
    }

    const headers = (res.data.columnHeaders ?? []).map((h) => h.name ?? '');
    const col = (name: string) => headers.indexOf(name);
    const iVideo = col('video');
    const iViews = col('views');
    const iRetention = col('averageViewPercentage');
    const iCtr = hasCtr ? col('impressionClickThroughRate') : -1;
    const rows = res.data.rows ?? [];
    if (iVideo < 0 || rows.length === 0) return { top: [], all: [] };

    const ids = rows.map((r) => String(r[iVideo])).filter(Boolean);
    const detailById = await fetchDetails(data, ids);

    const performances: VideoPerformance[] = rows
      .map((r) => {
        const videoId = String(r[iVideo]);
        const detail = detailById.get(videoId);
        return {
          videoId,
          title: detail?.title ?? '',
          views: iViews >= 0 ? Number(r[iViews]) || 0 : 0,
          avgViewPct: iRetention >= 0 ? Number(r[iRetention]) || 0 : 0,
          ctr: iCtr >= 0 ? Number(r[iCtr]) || 0 : undefined,
          durationSec: detail?.durationSec ?? 0,
        };
      })
      .filter((p) => p.title.trim().length > 0);

    return { top: rankPerformersFull(performances, topN), all: performances };
  } catch (e) {
    const msg = (e as Error).message;
    if (/insufficient|scope|forbidden|permission|403/i.test(msg)) {
      log(
        `Analytics feedback skipped: the YouTube refresh token lacks the yt-analytics.readonly scope. ` +
          `Re-mint YT_REFRESH_TOKEN with that scope added to activate the feedback loop. (${msg})`,
      );
    } else {
      log(`Analytics feedback skipped (continuing without it): ${msg}`);
    }
    return { top: [], all: [] };
  }
}

// Ranked-winners-only view, kept for callers that don't need the unsliced set.
export async function fetchTopPerformers(topN = ANALYTICS_TOP_N): Promise<VideoPerformance[]> {
  return (await fetchChannelPerformance(topN)).top;
}

// Title-only convenience wrapper (the script generator only needs the titles).
export async function fetchTopPerformingTitles(topN = ANALYTICS_TOP_N): Promise<string[]> {
  return (await fetchTopPerformers(topN)).map((p) => p.title);
}
