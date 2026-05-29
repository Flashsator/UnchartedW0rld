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
};

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
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
    const prefix = opts.longVideoId ? `Full video: https://youtu.be/${opts.longVideoId}\n\n` : '';
    const suffix = description.toLowerCase().includes('#shorts') ? '' : '\n\n#Shorts';
    description = `${prefix}${description}${suffix}`;
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
