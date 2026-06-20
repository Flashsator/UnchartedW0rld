// Weekly READ-ONLY funnel report. Tracks whether the Shorts -> long-video
// funnel is improving over time, since YouTube's API can't attribute a specific
// long-video view to a specific Short. Run manually with
//   npx tsx scripts/funnelReport.ts
// or on a schedule via .github/workflows/funnel-report.yml. It only READS
// analytics (yt-analytics.readonly) and never edits a video.
//
// What it measures (and why):
//  - Shorts are the channel's reach engine; long videos are the destination.
//  - The only automated Short->long link is the description "Full video" line,
//    whose clicks show up in long-video analytics roughly as EXT_URL /
//    NO_LINK_OTHER. RELATED_VIDEO is algorithmic (browse/suggested), NOT funnel.
//  - So "funnel views" = EXT_URL + NO_LINK_OTHER on long videos. If the funnel
//    is working, that number (and its share) should rise as we make the link
//    more visible (pinned comments, Studio related-video cards).
//  - Per-Short averageViewPercentage tells us how many viewers even reach the
//    end — relevant to whether an end-card lever could ever be seen.
import fs from 'node:fs';
import { google } from 'googleapis';
import { YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REFRESH_TOKEN } from '../src/config.js';

const oauth = new google.auth.OAuth2(YT_CLIENT_ID, YT_CLIENT_SECRET);
oauth.setCredentials({ refresh_token: YT_REFRESH_TOKEN });
const yt = google.youtube({ version: 'v3', auth: oauth });
const ytA = google.youtubeAnalytics({ version: 'v2', auth: oauth });

const SHORT_MAX_SEC = 180;
const WINDOW_DAYS = 28;
// Long-video traffic-source types that approximate the Shorts description-link
// funnel (vs RELATED_VIDEO = algorithmic suggestions).
const FUNNEL_SOURCES = new Set(['EXT_URL', 'NO_LINK_OTHER']);

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function isoSec(iso?: string | null): number {
  if (!iso) return 0;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  return m ? (+(m[1] ?? 0)) * 3600 + (+(m[2] ?? 0)) * 60 + (+(m[3] ?? 0)) : 0;
}

type Meta = { title: string; sec: number; pub: string };

async function main(): Promise<void> {
  const end = new Date();
  const start = new Date(end.getTime() - WINDOW_DAYS * 86_400_000);
  const START = ymd(start);
  const END = ymd(end);

  const ch = await yt.channels.list({ part: ['contentDetails'], mine: true });
  const uploads = ch.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) throw new Error('no uploads playlist');
  const pl = await yt.playlistItems.list({ part: ['contentDetails'], playlistId: uploads, maxResults: 50 });
  const ids = (pl.data.items ?? []).map((i) => i.contentDetails?.videoId).filter((x): x is string => !!x);
  if (ids.length === 0) throw new Error('no uploads found');

  const vres = await yt.videos.list({ part: ['snippet', 'contentDetails'], id: ids });
  const meta = new Map<string, Meta>(
    (vres.data.items ?? []).map((v) => [
      v.id ?? '',
      {
        title: v.snippet?.title ?? '',
        sec: isoSec(v.contentDetails?.duration),
        pub: v.snippet?.publishedAt ?? '',
      },
    ]),
  );

  const rep = await ytA.reports.query({
    ids: 'channel==MINE',
    startDate: START,
    endDate: END,
    metrics: 'views,averageViewPercentage',
    dimensions: 'video',
    filters: `video==${ids.join(',')}`,
    sort: '-views',
  });
  const headers = (rep.data.columnHeaders ?? []).map((h) => h.name ?? '');
  const col = (name: string) => headers.indexOf(name);

  let shortCount = 0;
  let shortViews = 0;
  let avgViewPctSum = 0;
  const longIds: string[] = [];
  for (const row of rep.data.rows ?? []) {
    const id = String(row[col('video')]);
    const views = Number(row[col('views')]);
    const avp = Number(row[col('averageViewPercentage')]);
    const isShort = (meta.get(id)?.sec ?? 0) <= SHORT_MAX_SEC;
    if (isShort) {
      shortCount += 1;
      shortViews += views;
      avgViewPctSum += avp;
    } else {
      longIds.push(id);
    }
  }

  // Per-long traffic source breakdown -> funnel vs related vs total.
  type LongRow = { id: string; title: string; total: number; funnel: number; related: number };
  const longRows: LongRow[] = [];
  let longViews = 0;
  let funnelViews = 0;
  for (const id of longIds) {
    let total = 0;
    let funnel = 0;
    let related = 0;
    try {
      const ts = await ytA.reports.query({
        ids: 'channel==MINE',
        startDate: START,
        endDate: END,
        metrics: 'views',
        dimensions: 'insightTrafficSourceType',
        filters: `video==${id}`,
        sort: '-views',
      });
      for (const row of ts.data.rows ?? []) {
        const src = String(row[0]);
        const v = Number(row[1]);
        total += v;
        if (FUNNEL_SOURCES.has(src)) funnel += v;
        if (src === 'RELATED_VIDEO') related += v;
      }
    } catch {
      // leave zeros for this video; non-fatal
    }
    longViews += total;
    funnelViews += funnel;
    longRows.push({ id, title: meta.get(id)?.title ?? '', total, funnel, related });
  }
  longRows.sort((a, b) => b.total - a.total);

  const avgShortViewPct = shortCount ? avgViewPctSum / shortCount : 0;
  const funnelShare = longViews ? (funnelViews / longViews) * 100 : 0;

  const lines: string[] = [];
  lines.push(`# Shorts → long-video funnel report`);
  lines.push(`Window: ${START} → ${END} (last ${WINDOW_DAYS} days)`);
  lines.push('');
  lines.push(`## Headline`);
  lines.push(`- Shorts: **${shortViews.toLocaleString()}** views across ${shortCount} videos (avg ${avgShortViewPct.toFixed(0)}% watched)`);
  lines.push(`- Long videos: **${longViews.toLocaleString()}** views across ${longRows.length} videos`);
  lines.push(`- **Funnel views into long videos (EXT_URL + NO_LINK_OTHER): ${funnelViews.toLocaleString()} (${funnelShare.toFixed(1)}% of long-video views)**`);
  lines.push(`- Reach→funnel ratio: ${shortViews.toLocaleString()} Short views produced ${funnelViews.toLocaleString()} funnel views into long content`);
  lines.push('');
  lines.push(`## Per long video`);
  lines.push(`| views | funnel | related | funnel% | title |`);
  lines.push(`|---:|---:|---:|---:|:--|`);
  for (const r of longRows) {
    const pct = r.total ? ((r.funnel / r.total) * 100).toFixed(0) : '0';
    lines.push(`| ${r.total} | ${r.funnel} | ${r.related} | ${pct}% | ${r.title.slice(0, 48)} |`);
  }
  lines.push('');
  lines.push(`_Funnel = description "Full video" link clicks (approx). RELATED_VIDEO is algorithmic suggestions, not the funnel. Rising funnel views/share = the Short→long link is getting more visible._`);

  const report = lines.join('\n');
  console.log(report);
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    try {
      fs.appendFileSync(summaryFile, report + '\n');
    } catch {
      // non-fatal
    }
  }
}

main().catch((e) => {
  console.error('Funnel report FAILED:', (e as Error).message);
  process.exit(1);
});
