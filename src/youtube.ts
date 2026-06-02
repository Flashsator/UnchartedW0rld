import fs from 'node:fs';
import { google } from 'googleapis';
import {
  PUBLISH_OFFSET_HOURS,
  YT_CLIENT_ID,
  YT_CLIENT_SECRET,
  YT_REFRESH_TOKEN,
} from './config.js';
import type { Episode } from './types.js';
import { log } from './utils.js';

function getClient() {
  if (!YT_CLIENT_ID || !YT_CLIENT_SECRET || !YT_REFRESH_TOKEN) {
    throw new Error('YouTube OAuth env vars missing (YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REFRESH_TOKEN)');
  }
  const oauth = new google.auth.OAuth2(YT_CLIENT_ID, YT_CLIENT_SECRET);
  oauth.setCredentials({ refresh_token: YT_REFRESH_TOKEN });
  return google.youtube({ version: 'v3', auth: oauth });
}

export type UploadOptions = {
  publishAt?: Date;
  isShorts?: boolean;
  longVideoId?: string;
  // Compact music attribution line (Shorts only — the long-form description is
  // composed upstream in the pipeline).
  musicCredit?: string;
};

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

// Shorts get a tight, scannable description — one hook sentence, the full-video
// link, and a handful of hashtags — NOT the long video's full description.
const SHORTS_HASHTAG_COUNT = 6;

function toHashtag(tag: string): string | null {
  const cleaned = tag.replace(/[^a-zA-Z0-9]/g, '');
  return cleaned ? `#${cleaned}` : null;
}

function shortsDescription(episode: Episode, longVideoId?: string, musicCredit?: string): string {
  // episode.description here is the LLM-written Shorts blurb (see
  // generateShortsBlurb / pipeline). Use it as-is; fall back to the hook's first
  // sentence only if the blurb is somehow empty.
  const blurb = episode.description?.trim() || episode.hook?.trim() || '';
  const lead = truncate(blurb, 220);
  const linkLine = longVideoId ? `▶ Full video: https://youtu.be/${longVideoId}` : '';
  const creditLine = musicCredit?.trim() || '';
  const hashtags = (episode.tags ?? [])
    .map(toHashtag)
    .filter((t): t is string => t !== null)
    .slice(0, SHORTS_HASHTAG_COUNT);
  const tagLine = [...hashtags, '#Shorts']
    .filter((t, i, a) => a.findIndex((x) => x.toLowerCase() === t.toLowerCase()) === i)
    .join(' ');
  return [lead, linkLine, creditLine, tagLine].filter(Boolean).join('\n\n');
}

// Fetches recent uploaded video titles from the channel so the script
// generator can avoid repeating already-published topics. The channel is the
// durable source of truth (vs. ephemeral CI cache); scheduled/private videos
// still appear in the owner's uploads playlist. Failures are non-fatal — we
// just continue without topic dedup.
export async function listUploadedTitles(maxResults = 60): Promise<string[]> {
  try {
    const yt = getClient();
    const ch = await yt.channels.list({ part: ['contentDetails'], mine: true });
    const uploads = ch.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploads) return [];
    const titles: string[] = [];
    let pageToken: string | undefined;
    do {
      const res = await yt.playlistItems.list({
        part: ['snippet'],
        playlistId: uploads,
        maxResults: 50,
        pageToken,
      });
      for (const item of res.data.items ?? []) {
        const title = item.snippet?.title?.replace(/\s*#shorts\b/gi, '').trim();
        if (title) titles.push(title);
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken && titles.length < maxResults);
    return [...new Set(titles)].slice(0, maxResults);
  } catch (e) {
    log(`Could not fetch uploaded titles (continuing without topic dedup): ${(e as Error).message}`);
    return [];
  }
}

export async function uploadVideo(
  videoPath: string,
  thumbnailPath: string | null,
  episode: Episode,
  categoryId: string,
  opts: UploadOptions = {},
): Promise<string> {
  const yt = getClient();

  const scheduledIso = (opts.publishAt ?? new Date(Date.now() + PUBLISH_OFFSET_HOURS * 3600_000)).toISOString();

  let title = episode.title.slice(0, 100);
  let description = episode.description;
  if (opts.isShorts) {
    if (!title.toLowerCase().includes('#shorts')) {
      title = `${truncate(title, 92)} #Shorts`;
    }
    description = shortsDescription(episode, opts.longVideoId, opts.musicCredit);
  }

  log(`Uploading${opts.isShorts ? ' shorts' : ''} to YouTube: ${title}`);
  const insertRes = await yt.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title,
        description,
        tags: episode.tags.slice(0, 20),
        categoryId,
        defaultLanguage: 'en',
        defaultAudioLanguage: 'en',
      },
      status: {
        privacyStatus: 'private',
        publishAt: scheduledIso,
        selfDeclaredMadeForKids: false,
      },
    },
    media: {
      body: fs.createReadStream(videoPath),
    },
  });

  const videoId = insertRes.data.id;
  if (!videoId) throw new Error('YouTube insert returned no id');
  log(`Uploaded video id ${videoId}, scheduled for ${scheduledIso}`);

  if (thumbnailPath) {
    await yt.thumbnails.set({
      videoId,
      media: { body: fs.createReadStream(thumbnailPath) },
    });
    log(`Thumbnail set on ${videoId}`);
  }

  return videoId;
}
