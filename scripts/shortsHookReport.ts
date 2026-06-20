// Weekly READ-ONLY Shorts hook report. Surfaces which Shorts hooks/titles are
// actually driving reach so we can keep sharpening the shortsHook prompt against
// real data. Run manually with
//   npx tsx scripts/shortsHookReport.ts
// or on a schedule via .github/workflows/shorts-hook-report.yml. It only READS
// analytics (yt-analytics.readonly) and never edits a video.
//
// What it measures (and why):
//  - Shorts are the channel's reach engine, and reach is driven by the hook's
//    FIRST LINE / title, not the topic. So we rank every Short by views and show
//    its title next to it — the pattern in the winners (concrete familiar subject
//    named first + a counterintuitive present-tense claim) is the signal we tune
//    the prompt toward.
//  - averageViewPercentage = how much of the Short people watch (retention /
//    replay proxy); likes/comments = engagement; subscribersGained = whether the
//    Short converts a viewer into a follower.
//  - A top-5 / bottom-5 split + channel averages make the winner vs flop contrast
//    legible at a glance.
import fs from 'node:fs';
import { google } from 'googleapis';
import { YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REFRESH_TOKEN } from '../src/config.js';

const oauth = new google.auth.OAuth2(YT_CLIENT_ID, YT_CLIENT_SECRET);
oauth.setCredentials({ refresh_token: YT_REFRESH_TOKEN });
const yt = google.youtube({ version: 'v3', auth: oauth });
const ytA = google.youtubeAnalytics({ version: 'v2', auth: oauth });

const SHORT_MAX_SEC = 180;
const WINDOW_DAYS = 120;
const TOP_N = 5;

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function isoSec(iso?: string | null): number {
  if (!iso) return 0;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  return m ? (+(m[1] ?? 0)) * 3600 + (+(m[2] ?? 0)) * 60 + (+(m[3] ?? 0)) : 0;
}

type Meta = { title: string; sec: number; pub: string };
type ShortRow = {
  id: string;
  title: string;
  sec: number;
  pub: string;
  views: number;
  viewPct: number;
  likes: number;
  comments: number;
  subs: number;
};

function avg(rows: ShortRow[], pick: (r: ShortRow) => number): number {
  return rows.length ? rows.reduce((s, r) => s + pick(r), 0) / rows.length : 0;
}

function row(r: ShortRow): string {
  const date = r.pub ? r.pub.slice(0, 10) : '—';
  return `| ${date} | ${r.sec}s | ${r.views} | ${r.viewPct.toFixed(0)}% | ${r.likes} | ${r.comments} | ${r.subs} | ${r.title.slice(0, 60)} |`;
}

const TABLE_HEADER = '| date | sec | views | view% | likes | comments | subs | title |';
const TABLE_DIVIDER = '|:--|--:|--:|--:|--:|--:|--:|:--|';

async function main(): Promise<void> {
  const end = new Date();
  const start = new Date(end.getTime() - WINDOW_DAYS * 86_400_000);
  const START = ymd(start);
  const END = ymd(end);

  const ch = await yt.channels.list({ part: ['contentDetails'], mine: true });
  const uploads = ch.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) throw new Error('no uploads playlist');

  // Page through the uploads playlist so older Shorts in the 120-day window are
  // included, not just the most recent 50.
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const pl = await yt.playlistItems.list({
      part: ['contentDetails'],
      playlistId: uploads,
      maxResults: 50,
      pageToken,
    });
    for (const i of pl.data.items ?? []) {
      const vid = i.contentDetails?.videoId;
      if (vid) ids.push(vid);
    }
    pageToken = pl.data.nextPageToken ?? undefined;
  } while (pageToken && ids.length < 200);
  if (ids.length === 0) throw new Error('no uploads found');

  // videos.list caps at 50 ids per call.
  const meta = new Map<string, Meta>();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const vres = await yt.videos.list({ part: ['snippet', 'contentDetails'], id: chunk });
    for (const v of vres.data.items ?? []) {
      meta.set(v.id ?? '', {
        title: v.snippet?.title ?? '',
        sec: isoSec(v.contentDetails?.duration),
        pub: v.snippet?.publishedAt ?? '',
      });
    }
  }

  const shortIds = ids.filter((id) => (meta.get(id)?.sec ?? 0) <= SHORT_MAX_SEC && (meta.get(id)?.sec ?? 0) > 0);
  if (shortIds.length === 0) throw new Error('no Shorts (<=180s) found in window');

  const rep = await ytA.reports.query({
    ids: 'channel==MINE',
    startDate: START,
    endDate: END,
    metrics: 'views,averageViewPercentage,likes,comments,subscribersGained',
    dimensions: 'video',
    filters: `video==${shortIds.join(',')}`,
    sort: '-views',
  });
  const headers = (rep.data.columnHeaders ?? []).map((h) => h.name ?? '');
  const col = (name: string) => headers.indexOf(name);

  const rows: ShortRow[] = [];
  for (const r of rep.data.rows ?? []) {
    const id = String(r[col('video')]);
    const m = meta.get(id);
    rows.push({
      id,
      title: m?.title ?? '',
      sec: m?.sec ?? 0,
      pub: m?.pub ?? '',
      views: Number(r[col('views')]) || 0,
      viewPct: Number(r[col('averageViewPercentage')]) || 0,
      likes: Number(r[col('likes')]) || 0,
      comments: Number(r[col('comments')]) || 0,
      subs: Number(r[col('subscribersGained')]) || 0,
    });
  }
  rows.sort((a, b) => b.views - a.views);

  const totalViews = rows.reduce((s, r) => s + r.views, 0);
  const lines: string[] = [];
  lines.push(`# Shorts hook report`);
  lines.push(`Window: ${START} → ${END} (last ${WINDOW_DAYS} days)`);
  lines.push('');
  lines.push(`## Channel averages (${rows.length} Shorts, ${totalViews.toLocaleString()} total views)`);
  lines.push(`- Avg views: **${avg(rows, (r) => r.views).toFixed(0)}**`);
  lines.push(`- Avg watched: **${avg(rows, (r) => r.viewPct).toFixed(0)}%**`);
  lines.push(`- Avg likes: ${avg(rows, (r) => r.likes).toFixed(1)} · comments: ${avg(rows, (r) => r.comments).toFixed(1)} · subs: ${avg(rows, (r) => r.subs).toFixed(1)}`);
  lines.push('');

  const top = rows.slice(0, TOP_N);
  const bottom = rows.length > TOP_N ? rows.slice(-TOP_N).reverse() : [];
  lines.push(`## Top ${top.length} by views`);
  lines.push(TABLE_HEADER);
  lines.push(TABLE_DIVIDER);
  for (const r of top) lines.push(row(r));
  lines.push('');
  if (bottom.length > 0) {
    lines.push(`## Bottom ${bottom.length} by views`);
    lines.push(TABLE_HEADER);
    lines.push(TABLE_DIVIDER);
    for (const r of bottom) lines.push(row(r));
    lines.push('');
  }

  lines.push(`## All Shorts (sorted by views)`);
  lines.push(TABLE_HEADER);
  lines.push(TABLE_DIVIDER);
  for (const r of rows) lines.push(row(r));
  lines.push('');
  lines.push(`_Reach is driven by the hook's first line / title. Winners name a concrete familiar subject in the first few words with a counterintuitive present-tense claim; abstract Title-Case titles flop. Use this to keep sharpening the shortsHook prompt in src/scriptGen.ts._`);

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
  console.error('Shorts hook report FAILED:', (e as Error).message);
  process.exit(1);
});
