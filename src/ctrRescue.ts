import fs from 'node:fs';
import path from 'node:path';
import { google } from 'googleapis';
import {
  ACTIVE_SERIES_POOL,
  CTR_RESCUED_FILE,
  CTR_RESCUE_MAX_AGE_DAYS,
  CTR_RESCUE_MIN_AGE_DAYS,
  CTR_RESCUE_MIN_IMPRESSIONS,
  CTR_RESCUE_THRESHOLD,
  ENABLE_CTR_RESCUE,
  WEEKDAY_SERIES_MAP,
  WORK_DIR,
  YT_CLIENT_ID,
  YT_CLIENT_SECRET,
  YT_REFRESH_TOKEN,
  type Series,
} from './config.js';
import { runClaudeCli } from './scriptGen.js';
import { makeThumbnail } from './thumbnail.js';
import { loadLayoutLog, pickThumbLayoutWeighted, recordThumbLayout } from './thumbLayoutStats.js';
import { setThumbnail, updateVideoTitle } from './youtube.js';
import { log, parseIsoDuration } from './utils.js';

// Re-exported for existing consumers/tests that import it from here.
export { parseIsoDuration } from './utils.js';

// CTR rescue loop: thumbnail and title are the two packaging levers that can be
// swapped on an already-published video without re-uploading. Each run finds at
// most ONE long-form video whose CTR is demonstrably below the channel's own
// median (enough impressions to be a verdict, young enough that a swap still
// changes the video's trajectory) and pulls ONE lever — alternating between
// thumbnail and title across runs, so over time the rescue log doubles as an
// A/B record of which lever actually moves CTR on this channel. One rescue per
// run keeps FLUX inside the free tier and makes each swap a clean experiment;
// each video is rescued at most once so packaging never thrashes back and forth.

// Shorts are excluded: their feed surface barely shows the thumbnail, so a swap
// can't move their CTR. Anything longer than this is long-form here.
const LONG_FORM_MIN_SEC = 120;

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

// --- State file ("videoId<TAB>lever" per line, in rescue order) -------------------

export type RescueLever = 'thumbnail' | 'title';

export interface RescueRecord {
  videoId: string;
  lever: RescueLever;
}

// Bare-id lines (the pre-title-lever format) read as thumbnail rescues, so an
// existing state file stays valid.
export function parseRescueState(text: string): RescueRecord[] {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const [videoId, lever] = line.split('\t').map((s) => s?.trim());
      if (!videoId) return null;
      return { videoId, lever: lever === 'title' ? 'title' : 'thumbnail' } as RescueRecord;
    })
    .filter((r): r is RescueRecord => r !== null);
}

// Strict alternation: thumbnail first (the stronger lever), then title, and so
// on. Over time this yields matched samples of both levers for comparison.
export function nextRescueLever(last: RescueLever | null | undefined): RescueLever {
  return last === 'thumbnail' ? 'title' : 'thumbnail';
}

export function loadRescueRecords(file: string = CTR_RESCUED_FILE): RescueRecord[] {
  try {
    return parseRescueState(fs.readFileSync(file, 'utf-8'));
  } catch {
    return [];
  }
}

export function saveRescueRecords(records: RescueRecord[], file: string = CTR_RESCUED_FILE): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, records.map((r) => `${r.videoId}\t${r.lever}`).join('\n'), 'utf-8');
  } catch (e) {
    log(`CTR rescue: could not persist state (continuing): ${(e as Error).message}`);
  }
}

// --- Pure helpers (unit-tested) -------------------------------------------------

// One video's measured packaging performance, joined from Analytics (metrics)
// and the Data API (title, publish time, duration).
export interface RescueRow {
  videoId: string;
  title: string;
  publishedAt: string;
  durationSec: number;
  impressions: number;
  // Click-through rate on impressions (0–100), as the Analytics API reports it.
  ctr: number;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

// A video can be rescued when it's long-form, not yet rescued, old enough that
// its CTR is measured on real impressions, and young enough that a better
// thumbnail still changes its trajectory.
export function isRescueCandidate(
  row: RescueRow,
  alreadyRescued: ReadonlySet<string>,
  now: Date = new Date(),
  opts: { minAgeDays?: number; maxAgeDays?: number; minImpressions?: number } = {},
): boolean {
  const minAgeDays = opts.minAgeDays ?? CTR_RESCUE_MIN_AGE_DAYS;
  const maxAgeDays = opts.maxAgeDays ?? CTR_RESCUE_MAX_AGE_DAYS;
  const minImpressions = opts.minImpressions ?? CTR_RESCUE_MIN_IMPRESSIONS;
  if (!row.videoId || alreadyRescued.has(row.videoId)) return false;
  if (row.durationSec < LONG_FORM_MIN_SEC) return false;
  if (row.impressions < minImpressions) return false;
  const ageDays = (now.getTime() - new Date(row.publishedAt).getTime()) / 86_400_000;
  return ageDays >= minAgeDays && ageDays <= maxAgeDays;
}

// Picks the single worst-CTR candidate that sits below threshold × the median
// CTR of ALL measured long-form videos (the wider set keeps the median stable
// even when only one or two videos are in the rescue window). Null when nothing
// is genuinely underperforming — most runs.
export function pickRescueTarget(
  candidates: RescueRow[],
  allMeasured: RescueRow[],
  threshold: number = CTR_RESCUE_THRESHOLD,
): RescueRow | null {
  if (candidates.length === 0) return null;
  const med = median(allMeasured.map((r) => r.ctr));
  if (med <= 0) return null;
  const cutoff = med * threshold;
  const below = candidates.filter((r) => r.ctr < cutoff);
  if (below.length === 0) return null;
  return below.reduce((worst, r) => (r.ctr < worst.ctr ? r : worst));
}

// The episode's series is recoverable from its publish weekday: long videos
// only go out on the fixed themed days (Mon=animals, Wed=insects, Fri=plants).
export function seriesForPublishedAt(publishedAt: string): Series {
  const key = WEEKDAY_SERIES_MAP[new Date(publishedAt).getUTCDay()];
  return ACTIVE_SERIES_POOL.find((s) => s.key === key) ?? ACTIVE_SERIES_POOL[0]!;
}

// --- Title lever -------------------------------------------------------------------

// YouTube's hard title limit.
const TITLE_MAX_CHARS = 100;

// Asks the script CLI for a sharper title for an underperforming video. The
// rewrite must stay true to the published video (invariant #1 extends to
// packaging: no promising content the video doesn't deliver), so the prompt
// only reframes what the current title already claims. Null on any failure or
// unusable output — the caller falls back to the thumbnail lever.
export async function generateRescueTitle(currentTitle: string): Promise<string | null> {
  const prompt = `An educational science mini-documentary on YouTube is underperforming on click-through rate. Rewrite its title to be more clickable WITHOUT changing what the video is about.

Current title: ${currentTitle}

Rules:
- Same subject, same claim — only sharpen the framing. Do NOT invent facts, numbers, or promises the current title doesn't already make.
- Open a curiosity gap: concrete stakes or a specific oddity, not vague hype.
- Under ${TITLE_MAX_CHARS} characters. No clickbait ALL-CAPS words, no emojis, no quotation marks, no trailing punctuation.
- It must read clearly differently from the current title.

Output ONLY the new title text, nothing else.`;
  try {
    const raw = (await runClaudeCli(prompt)).trim();
    const title = raw.split(/\r?\n/)[0]?.replace(/^["']|["']$/g, '').trim() ?? '';
    if (!title || title.length > TITLE_MAX_CHARS) return null;
    if (title.toLowerCase() === currentTitle.trim().toLowerCase()) return null;
    // Programmatic claim guard (the prompt rule alone isn't enough for a live
    // swap): a number the current title never made is a fabricated claim.
    const newNums = title.match(/\d[\d,.]*/g) ?? [];
    if (newNums.some((n) => !currentTitle.includes(n))) return null;
    // Meta/preface output ("Here's a sharper title:") passes the length checks
    // but must never ship.
    if (/^(here|sure|okay|certainly|new title)\b/i.test(title) || /[:：]$/.test(title)) return null;
    return title;
  } catch (e) {
    log(`CTR rescue: title generation failed (${(e as Error).message})`);
    return null;
  }
}

// --- Main entry (called at the end of the pipeline; non-fatal) ------------------

export async function rescueWorstPackaging(): Promise<void> {
  if (!ENABLE_CTR_RESCUE) return;
  try {
    const { analytics, data } = getClients();
    const records = loadRescueRecords();
    const rescued = new Set(records.map((r) => r.videoId));

    const endDate = new Date().toISOString().slice(0, 10);
    const startDate = new Date(Date.now() - CTR_RESCUE_MAX_AGE_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const res = await analytics.reports.query({
      ids: 'channel==MINE',
      startDate,
      endDate,
      metrics: 'impressions,impressionClickThroughRate',
      dimensions: 'video',
      sort: '-impressions',
      maxResults: 50,
    });
    const headers = (res.data.columnHeaders ?? []).map((h) => h.name ?? '');
    const iVideo = headers.indexOf('video');
    const iImpr = headers.indexOf('impressions');
    const iCtr = headers.indexOf('impressionClickThroughRate');
    const rows = res.data.rows ?? [];
    if (iVideo < 0 || iImpr < 0 || iCtr < 0 || rows.length === 0) {
      log('CTR rescue: no impression data reported yet (young channel) — skipping.');
      return;
    }

    // Join in title / publish time / duration from the Data API.
    const ids = rows.map((r) => String(r[iVideo])).filter(Boolean);
    const detailById = new Map<string, { title: string; publishedAt: string; durationSec: number }>();
    for (let i = 0; i < ids.length; i += 50) {
      const d = await data.videos.list({
        part: ['snippet', 'contentDetails'],
        id: ids.slice(i, i + 50),
      });
      for (const item of d.data.items ?? []) {
        if (!item.id) continue;
        detailById.set(item.id, {
          title: item.snippet?.title ?? '',
          publishedAt: item.snippet?.publishedAt ?? '',
          durationSec: parseIsoDuration(item.contentDetails?.duration),
        });
      }
    }

    const measured: RescueRow[] = rows
      .map((r) => {
        const videoId = String(r[iVideo]);
        const detail = detailById.get(videoId);
        return {
          videoId,
          title: detail?.title ?? '',
          publishedAt: detail?.publishedAt ?? '',
          durationSec: detail?.durationSec ?? 0,
          impressions: Number(r[iImpr]) || 0,
          ctr: Number(r[iCtr]) || 0,
        };
      })
      .filter(
        (r) =>
          r.title.length > 0 &&
          r.durationSec >= LONG_FORM_MIN_SEC &&
          r.impressions >= CTR_RESCUE_MIN_IMPRESSIONS,
      );

    const candidates = measured.filter((r) => isRescueCandidate(r, rescued));
    const target = pickRescueTarget(candidates, measured);
    if (!target) {
      log('CTR rescue: no underperforming video found — nothing to do.');
      return;
    }

    let lever = nextRescueLever(records.at(-1)?.lever ?? null);
    log(
      `CTR rescue: ${lever} lever on ${target.videoId} ` +
        `("${target.title.slice(0, 60)}", CTR ${target.ctr.toFixed(2)}% ` +
        `on ${target.impressions} impressions, channel median ${median(
          measured.map((r) => r.ctr),
        ).toFixed(2)}%)`,
    );

    if (lever === 'title') {
      const newTitle = await generateRescueTitle(target.title);
      if (newTitle) {
        await updateVideoTitle(target.videoId, newTitle);
        log(`CTR rescue: replaced title on ${target.videoId} → "${newTitle}"`);
      } else {
        // Unusable rewrite — fall back to the thumbnail lever so the run's one
        // rescue slot isn't wasted (and the alternation retries title next time).
        log('CTR rescue: title rewrite unusable — falling back to the thumbnail lever.');
        lever = 'thumbnail';
      }
    }

    if (lever === 'thumbnail') {
      const series = seriesForPublishedAt(target.publishedAt);
      // CTR-weighted layout draw, excluding the layout this video already wears
      // (when logged) so the replacement is guaranteed to look different.
      const currentLayout =
        loadLayoutLog().find((e) => e.videoId === target.videoId)?.layout ?? null;
      // persist:false — the no-repeat state belongs to the daily upload draw.
      const layout = pickThumbLayoutWeighted(measured, currentLayout, false);
      // Dedicated subdir so the rescue render never clobbers this run's own
      // work/thumb output.
      const rescueDir = path.join(WORK_DIR, 'ctr_rescue');
      const thumbPath = await makeThumbnail(target.title, series, layout, rescueDir);
      await setThumbnail(target.videoId, thumbPath);
      recordThumbLayout(target.videoId, layout);
      log(`CTR rescue: replaced thumbnail on ${target.videoId} (layout: ${layout})`);
    }

    saveRescueRecords([...records, { videoId: target.videoId, lever }]);
  } catch (e) {
    log(`CTR rescue skipped (continuing): ${(e as Error).message}`);
  }
}
