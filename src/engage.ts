import fs from 'node:fs';
import path from 'node:path';
import { google } from 'googleapis';
import {
  AUTO_COMMENT_MAX_PER_RUN,
  AUTO_COMMENT_RECENT_DAYS,
  COMMENTED_VIDEOS_FILE,
  ENABLE_AUTO_COMMENT,
  YT_CLIENT_ID,
  YT_CLIENT_SECRET,
  YT_REFRESH_TOKEN,
} from './config.js';
import { runClaudeCli } from './scriptGen.js';
import { log } from './utils.js';

// Auto engagement comments: early comments + replies are one of the few
// engagement signals the channel can seed itself, and a creator question pinned
// under a fresh video reliably starts the thread. Comments can only be posted on
// PUBLIC videos (the API rejects private/scheduled ones), and uploads go public
// hours after the run, so each run comments on videos published by PREVIOUS
// runs — a housekeeping pass, not part of the upload itself.

function getClient() {
  if (!YT_CLIENT_ID || !YT_CLIENT_SECRET || !YT_REFRESH_TOKEN) {
    throw new Error('YouTube OAuth env vars missing (YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REFRESH_TOKEN)');
  }
  const oauth = new google.auth.OAuth2(YT_CLIENT_ID, YT_CLIENT_SECRET);
  oauth.setCredentials({ refresh_token: YT_REFRESH_TOKEN });
  return google.youtube({ version: 'v3', auth: oauth });
}

// --- State file (video ids already commented on, one per line) ----------------

export function loadCommentedIds(file: string = COMMENTED_VIDEOS_FILE): Set<string> {
  try {
    return new Set(
      fs
        .readFileSync(file, 'utf-8')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

export function saveCommentedIds(ids: Set<string>, file: string = COMMENTED_VIDEOS_FILE): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [...ids].join('\n'), 'utf-8');
  } catch (e) {
    log(`Auto-comment: could not persist state (continuing): ${(e as Error).message}`);
  }
}

// --- Pure helpers (unit-tested) ------------------------------------------------

// Recovers the long video's URL from a Short's own description ("▶ Full video:"
// line written by shortsDescription in youtube.ts), so a Short's comment can
// funnel viewers to the long version.
export function extractFullVideoUrl(description: string): string | null {
  const m = description.match(/▶ Full video:\s*(https:\/\/youtu\.be\/[\w-]+)/);
  return m ? m[1]! : null;
}

// Deterministic fallback when the CLI comment generation fails — still a real
// question, still carries the funnel link when there is one.
export function fallbackComment(fullVideoUrl: string | null): string {
  return fullVideoUrl
    ? `Which part surprised you the most? The full story is here: ${fullVideoUrl}`
    : 'Which part surprised you the most? Tell us below.';
}

// A video is a comment target when it's public, recent, and not yet commented.
export function isCommentTarget(
  v: { id: string; privacyStatus?: string; publishedAt?: string },
  alreadyCommented: ReadonlySet<string>,
  now: Date = new Date(),
  recentDays: number = AUTO_COMMENT_RECENT_DAYS,
): boolean {
  if (!v.id || alreadyCommented.has(v.id)) return false;
  if (v.privacyStatus !== 'public') return false;
  if (!v.publishedAt) return false;
  const ageMs = now.getTime() - new Date(v.publishedAt).getTime();
  return ageMs >= 0 && ageMs <= recentDays * 86_400_000;
}

// --- Comment text -------------------------------------------------------------

async function writeCommentText(title: string, fullVideoUrl: string | null): Promise<string> {
  try {
    const prompt =
      `You run the YouTube science channel "Wild Anomalies". Write ONE comment to post under your own video titled:\n` +
      `"${title}"\n\n` +
      `Goal: spark replies. Ask a single genuine, specific question viewers will want to answer ` +
      `(an opinion, a guess, or their own experience tied to this topic). ` +
      `Under 140 characters. No hashtags, no links, no emoji, no quotation marks, no preface. ` +
      `Output ONLY the comment text.`;
    const raw = (await runClaudeCli(prompt)).trim().replace(/^["']|["']$/g, '').replace(/\s+/g, ' ');
    // This text goes verbatim onto a public video with no human in between —
    // gate it hard. Anything that smells like a preface/refusal, isn't a
    // question, or blew past the length cap gets replaced by the deterministic
    // fallback rather than posted.
    const looksLikePreface = /^(here|sure|okay|of course|certainly|i can|i'd|as an ai|i'm sorry|i cannot)/i.test(raw);
    const question =
      raw.length > 0 && raw.length <= 200 && raw.includes('?') && !looksLikePreface
        ? raw
        : fallbackComment(null);
    return fullVideoUrl ? `${question}\n\n▶ Full story: ${fullVideoUrl}` : question;
  } catch (e) {
    log(`Auto-comment: CLI text generation failed, using fallback: ${(e as Error).message}`);
    return fallbackComment(fullVideoUrl);
  }
}

// --- Main entry (called at the end of the pipeline; non-fatal) -----------------

export async function autoCommentOnRecentVideos(): Promise<void> {
  if (!ENABLE_AUTO_COMMENT) return;
  try {
    const yt = getClient();
    const commented = loadCommentedIds();

    // Recent uploads via the uploads playlist (includes Shorts), newest first.
    const ch = await yt.channels.list({ part: ['contentDetails'], mine: true });
    const uploads = ch.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploads) return;
    const pl = await yt.playlistItems.list({
      part: ['contentDetails'],
      playlistId: uploads,
      maxResults: 25,
    });
    const ids = (pl.data.items ?? [])
      .map((i) => i.contentDetails?.videoId)
      .filter((id): id is string => Boolean(id));
    if (ids.length === 0) return;

    // Privacy status + publish time + title/description in one batch call.
    const res = await yt.videos.list({ part: ['snippet', 'status'], id: ids });
    const targets = (res.data.items ?? [])
      .map((v) => ({
        id: v.id ?? '',
        title: v.snippet?.title ?? '',
        description: v.snippet?.description ?? '',
        privacyStatus: v.status?.privacyStatus ?? undefined,
        publishedAt: v.snippet?.publishedAt ?? undefined,
      }))
      .filter((v) => isCommentTarget(v, commented))
      .slice(0, AUTO_COMMENT_MAX_PER_RUN);

    if (targets.length === 0) {
      log('Auto-comment: no new public videos to comment on.');
      return;
    }

    for (const v of targets) {
      try {
        const fullVideoUrl = extractFullVideoUrl(v.description);
        const text = await writeCommentText(v.title, fullVideoUrl);
        await yt.commentThreads.insert({
          part: ['snippet'],
          requestBody: {
            snippet: {
              videoId: v.id,
              topLevelComment: { snippet: { textOriginal: text } },
            },
          },
        });
        commented.add(v.id);
        // Persist after EVERY successful post: a crash later in the loop must
        // not lose a posted id, or the next run double-comments that video.
        saveCommentedIds(commented);
        log(`Auto-comment: posted on ${v.id} ("${v.title.slice(0, 60)}")`);
      } catch (e) {
        // Per-video failure (e.g. comments disabled) — keep going on the rest.
        log(`Auto-comment: failed on ${v.id} (continuing): ${(e as Error).message}`);
      }
    }
  } catch (e) {
    log(`Auto-comment skipped (continuing): ${(e as Error).message}`);
  }
}
