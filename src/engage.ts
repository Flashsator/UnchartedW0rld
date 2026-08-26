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
//
// This same entry point is driven by TWO triggers: the daily pipeline run (13:00
// UTC, comments on already-public earlier videos) and a standalone comment-pass
// workflow (~1h after each publish slot, so today's upload gets its comment
// within hours instead of waiting ~2 days for the next Mon/Wed/Fri run — well
// past a Short's key push window). Those two runs do NOT share the local
// .commented-videos state file, so a live commentThreads check
// (channelAlreadyCommented) is the real cross-run idempotency guard: before
// posting we confirm our own channel hasn't already commented on the video.

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
// question, still carries the funnel link when there is one. Phrased as an
// easy yes/no so it invites a reply even without topic specifics.
export function fallbackComment(fullVideoUrl: string | null): string {
  return fullVideoUrl
    ? `Did this surprise you — yes or no? The full story is here: ${fullVideoUrl}`
    : 'Did this surprise you — yes or no? Tell us why below.';
}

// Parses an ISO-8601 duration (YouTube contentDetails.duration, e.g. "PT58S",
// "PT9M42S", "PT1H2M3S") into whole seconds. Returns 0 on anything unparseable
// so an unknown duration classifies as "not a Short" (long-video treatment) —
// the safe default, since it just means the comment keeps its old behavior.
// Pure and unit-tested.
export function parseIsoDurationSec(iso: string): number {
  const m = /^P(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso ?? '');
  if (!m) return 0;
  const [h, mi, s] = [m[1], m[2], m[3]].map((x) => (x ? Number(x) : 0));
  return h! * 3600 + mi! * 60 + s!;
}

// A Short is a vertical clip of at most ~3 minutes; this channel's Shorts are
// ~55-58s while long videos are ~9-10 min, so the 180s line is unambiguous. A
// duration of 0 (unparseable) is NOT a Short.
export function isShortDuration(sec: number): boolean {
  return sec > 0 && sec <= 180;
}

// Orders the comment targets so Shorts come FIRST (stable within each group,
// preserving the caller's newest-first order). Shorts are the channel's reach
// and subscriber engine, so under the AUTO_COMMENT_MAX_PER_RUN cap they must be
// seeded before long videos rather than losing every slot to a same-day long
// upload. Pure and unit-tested.
export function orderCommentTargets<T extends { isShort: boolean }>(targets: readonly T[]): T[] {
  return [...targets.filter((t) => t.isShort), ...targets.filter((t) => !t.isShort)];
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

// True when any top-level comment on the video was authored by our own channel.
// The local .commented-videos state file isn't shared between the daily pipeline
// run and the standalone comment-pass workflow, so this live read — not the
// state file — is what actually prevents double-commenting the same video.
// Pure so it can be unit-tested without the API.
export function channelAlreadyCommented(
  threads: ReadonlyArray<{
    snippet?: {
      topLevelComment?: {
        snippet?: { authorChannelId?: { value?: string | null } | null } | null;
      } | null;
    } | null;
  }>,
  myChannelId: string,
): boolean {
  if (!myChannelId) return false;
  return threads.some(
    (t) => t.snippet?.topLevelComment?.snippet?.authorChannelId?.value === myChannelId,
  );
}

// --- Comment text -------------------------------------------------------------

async function writeCommentText(
  title: string,
  fullVideoUrl: string | null,
  isShort: boolean,
): Promise<string> {
  // Subscriber strategy: a Short's comment is PURE reply-bait — a link dilutes
  // the reply intent and pushes the near-dead Short→long funnel (~0.26%
  // clickthrough), so Shorts carry no URL (the description's own "▶ Full video:"
  // line is untouched, so the funnel link itself isn't removed). Long videos keep
  // the funnel append (they never carry one today anyway — extractFullVideoUrl
  // only matches a Short's description — so this is a no-op guard, kept for when a
  // long-form cross-link is wanted again).
  const linkUrl = isShort ? null : fullVideoUrl;
  try {
    const shortsNote = isShort
      ? `This is a fast, muted, vertical Short, so the question must be answerable in ONE second ` +
        `from what the viewer just watched — a snap either/or or "guess before the reveal". `
      : '';
    const prompt =
      `You run the YouTube science channel "Wild Anomalies". Write ONE comment to post under your own video titled:\n` +
      `"${title}"\n\n` +
      `Goal: spark replies. Ask ONE short question that is effortless to answer — ideally an ` +
      `either/or choice or a "guess before you look it up" prompt tied to THIS specific topic ` +
      `(binary and guess questions pull far more replies than open-ended ones). ` +
      shortsNote +
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
    return linkUrl ? `${question}\n\n▶ Full story: ${linkUrl}` : question;
  } catch (e) {
    log(`Auto-comment: CLI text generation failed, using fallback: ${(e as Error).message}`);
    return fallbackComment(linkUrl);
  }
}

// Live idempotency guard: has our own channel already posted a top-level comment
// on this video? A failure to check (comments disabled, quota, transient) is
// treated as "not commented" so a legit target isn't skipped — a duplicate
// insert is far less likely (and lower harm) than never commenting.
async function channelHasCommentLive(
  yt: ReturnType<typeof getClient>,
  videoId: string,
  myChannelId: string,
): Promise<boolean> {
  try {
    const res = await yt.commentThreads.list({
      part: ['snippet'],
      videoId,
      maxResults: 100,
      order: 'time',
      textFormat: 'plainText',
    });
    return channelAlreadyCommented(res.data.items ?? [], myChannelId);
  } catch (e) {
    log(`Auto-comment: live comment check failed for ${videoId} (continuing): ${(e as Error).message}`);
    return false;
  }
}

// --- Main entry (called at the end of the pipeline; non-fatal) -----------------

export async function autoCommentOnRecentVideos(): Promise<void> {
  if (!ENABLE_AUTO_COMMENT) return;
  try {
    const yt = getClient();
    const commented = loadCommentedIds();

    // Recent uploads via the uploads playlist (includes Shorts), newest first.
    // Fetch our own channel id in the same call — it powers the live dedupe guard
    // (channelAlreadyCommented) so the two triggers never double-comment.
    const ch = await yt.channels.list({ part: ['id', 'contentDetails'], mine: true });
    const myChannelId = ch.data.items?.[0]?.id ?? '';
    if (!myChannelId) {
      // Should never happen with a valid OAuth token; surface it because it
      // disables the live dedupe guard (the state file is the only fallback).
      log('Auto-comment: could not resolve own channel id — live dedupe disabled this run.');
    }
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

    // Privacy status + publish time + title/description + duration in one batch
    // call (contentDetails.duration classifies Shorts vs long videos).
    const res = await yt.videos.list({ part: ['snippet', 'status', 'contentDetails'], id: ids });
    const eligible = (res.data.items ?? [])
      .map((v) => ({
        id: v.id ?? '',
        title: v.snippet?.title ?? '',
        description: v.snippet?.description ?? '',
        privacyStatus: v.status?.privacyStatus ?? undefined,
        publishedAt: v.snippet?.publishedAt ?? undefined,
        isShort: isShortDuration(parseIsoDurationSec(v.contentDetails?.duration ?? '')),
      }))
      .filter((v) => isCommentTarget(v, commented));
    // Shorts first (the subscriber engine), then long — so the per-run cap never
    // starves Shorts when a long video is uploaded the same day.
    const targets = orderCommentTargets(eligible).slice(0, AUTO_COMMENT_MAX_PER_RUN);

    if (targets.length === 0) {
      log('Auto-comment: no new public videos to comment on.');
      return;
    }

    for (const v of targets) {
      try {
        // Cross-run guard: a prior trigger (daily run vs comment-pass) may have
        // already commented on this video without this run's state file knowing.
        // Confirm live before posting so we never double-comment.
        if (myChannelId && (await channelHasCommentLive(yt, v.id, myChannelId))) {
          commented.add(v.id);
          saveCommentedIds(commented);
          log(`Auto-comment: ${v.id} already has our comment (live check) — skipping.`);
          continue;
        }
        const fullVideoUrl = extractFullVideoUrl(v.description);
        const text = await writeCommentText(v.title, fullVideoUrl, v.isShort);
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
