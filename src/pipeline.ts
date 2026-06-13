import fs from 'node:fs';
import path from 'node:path';
import {
  BGM_VOLUME,
  BROLL_CLIP_SEC,
  CHANNEL_FOOTER,
  COLD_OPEN_SEC,
  DRY_RUN,
  ENABLE_ANALYTICS_FEEDBACK,
  FORCE_RUN,
  INTER_SECTION_GAP_SEC,
  INTERLUDE_SEC,
  OUTRO_SUBSCRIBE_SEC,
  OUT_DIR,
  PUBLISH_OFFSET_HOURS,
  TARGET_MINUTES,
  UPLOAD_LOCK_FILE,
  WORK_DIR,
  pickStructure,
  pickSubTheme,
  pickTone,
  pickVoice,
  seriesForToday,
} from './config.js';
import { generateEpisode, generateShortsBlurb, translateMetadata } from './scriptGen.js';
import { synthesize } from './tts.js';
import {
  fetchAmbient,
  fetchBgm,
  fetchBroll,
  fetchBrollForBeats,
  fetchShortsBroll,
  pixabayCategoryForSeries,
} from './stock.js';
import { makeThumbnail } from './thumbnail.js';
import { renderVideo, renderShorts } from './render.js';
import { buildChapters, muxAudio, muxShortsAudio, writeSrt } from './mux.js';
import { buildAttribution, shortsMusicLine } from './attribution.js';
import { addToSeriesPlaylist, listUploadedTitles, uploadCaption, uploadVideo } from './youtube.js';
import { buildWatchNextBlock, fetchChannelPerformance, type VideoPerformance } from './analytics.js';
import { fetchRetentionDirective } from './retention.js';
import { pickThumbLayoutWeighted, recordThumbLayout } from './thumbLayoutStats.js';
import { validateTopicDemand } from './topicResearch.js';
import { autoCommentOnRecentVideos } from './engage.js';
import { rescueWorstPackaging } from './ctrRescue.js';
import { auditRecentContent } from './contentAudit.js';
import { extractIconEvents } from './iconExtractor.js';
import { computeCutTimes } from './cuts.js';
import { buildShortsManifest, planShortsForToday, publishAtFor } from './shortsGen.js';
import type {
  Episode,
  ImageCredit,
  Interlude,
  MusicCredit,
  RenderManifest,
  RuntimeProfile,
} from './types.js';
import { ensureDir, log, safeFilename } from './utils.js';

function relAsset(runDir: string, abs: string): string {
  return path.relative(runDir, abs).replace(/\\/g, '/');
}

function readUploadLock(): string | null {
  try {
    return fs.readFileSync(UPLOAD_LOCK_FILE, 'utf8').trim();
  } catch {
    return null;
  }
}

function writeUploadLock(date: string): void {
  fs.writeFileSync(UPLOAD_LOCK_FILE, date);
}

async function main(): Promise<void> {
  const series = seriesForToday();
  const voice = pickVoice();
  const tone = pickTone();
  const structure = pickStructure();
  const subTheme = pickSubTheme(series);

  log(`=== Wild Anomalies — ${series.name} (${series.key}) ===`);
  log(
    `Profile: voice=${voice.label} (fixed) | tone=${tone.label} (rate ${tone.rate}, pitch ${tone.pitch}) | structure=${structure.label} (${structure.key}) | sub-theme="${subTheme}" | target=${TARGET_MINUTES}min`,
  );

  const today = new Date().toISOString().slice(0, 10);
  const runDir = ensureDir(path.join(WORK_DIR, `${today}_${series.key}`));
  ensureDir(OUT_DIR);

  // Daily dedup lock: abort before any expensive work if a long-form video was
  // already published today (e.g. a manual re-run after a failure, followed by
  // the normal scheduled cron). DRY_RUN never uploads, so it's never blocked;
  // FORCE_RUN=1 overrides the lock for a deliberate same-day re-publish.
  if (!DRY_RUN && !FORCE_RUN && readUploadLock() === today) {
    log(
      `Upload lock: a long-form video was already published on ${today} — skipping this run. Set FORCE_RUN=1 to override.`,
    );
    return;
  }

  log('Step 1/8: Generate script');
  // Pull recently-published titles so the generator avoids repeating topics.
  // The channel is the durable source of truth; this is best-effort and
  // returns [] on any API failure.
  const priorTitles = await listUploadedTitles();
  if (priorTitles.length > 0) {
    log(`Topic dedup: avoiding ${priorTitles.length} already-published titles.`);
  }
  // Opt-in feedback loop: the channel's best-performing past videos (ranked by
  // CTR/retention/views). Feeds the title steer, the topic-candidate hint, the
  // description's "Watch next" links, and the CTR-weighted thumbnail-layout
  // pick. Best-effort — no-ops to [] when disabled or when the token lacks the
  // analytics scope.
  let topPerformers: VideoPerformance[] = [];
  let allPerformances: VideoPerformance[] = [];
  if (ENABLE_ANALYTICS_FEEDBACK) {
    ({ top: topPerformers, all: allPerformances } = await fetchChannelPerformance());
    if (topPerformers.length > 0) {
      log(`Analytics feedback: steering title toward ${topPerformers.length} proven winners.`);
    }
  }
  const winningTitles = topPerformers.map((p) => p.title);
  // Layout draw waits for the performance data: with enough measured uploads it
  // weights layouts by their real CTR, otherwise it's the same no-repeat
  // rotation as before. Fed the FULL measured set, not just the winners —
  // a layout only attached to low-CTR videos must show up to be penalized.
  const thumbLayout = pickThumbLayoutWeighted(allPerformances);
  log(`Thumb layout: ${thumbLayout}`);
  // Measured retention feedback: where this channel's viewers actually leave,
  // turned into a pacing directive for the script prompt. Best-effort —
  // undefined until the young channel accrues retention curves.
  const retentionDirective = await fetchRetentionDirective();
  // Opt-in topic steer: score a handful of candidate angles against real
  // YouTube search demand and prefer the proven winner. Best-effort — undefined
  // (disabled or any failure) leaves the script model's own topic choice intact.
  const topicDirective = await validateTopicDemand(series, subTheme, priorTitles, winningTitles);
  const { episode, hookPattern } = await generateEpisode(
    series,
    structure,
    voice,
    subTheme,
    priorTitles,
    winningTitles,
    topicDirective,
    retentionDirective,
  );
  fs.writeFileSync(path.join(runDir, 'episode.json'), JSON.stringify(episode, null, 2));

  log('Step 2/8: Synthesize narration');
  const sectionAudios = await synthesize(episode, runDir, [voice.id], {
    rate: tone.rate,
    pitch: tone.pitch,
  });

  log('Step 3/8: Fetch b-roll for each section');
  // Pixabay-only category constraint derived from today's series, so its fuzzy
  // matcher stays inside the right corner of the library.
  const pixabayCategory = pixabayCategoryForSeries(series.key);
  const used = new Set<string>();
  // Records which stock libraries actually contributed footage, so the
  // description credits only the sources truly used (not just the ones enabled).
  const footageUsed = new Set<string>();
  // Per-image CC credits for any Wikimedia Commons stills the b-roll gap-fill
  // pulled in (only happens when the video providers came up short — i.e. an
  // obscure subject). Threaded into the description's attribution block.
  const imageCredits: ImageCredit[] = [];
  const broll: string[][] = [];
  for (let i = 0; i < sectionAudios.length; i++) {
    const sec = sectionAudios[i]!;
    // Ordered per-beat shot list (subject-anchored in scriptGen) so footage
    // tracks the narration moment to moment; falls back to the single summary
    // query when the script model didn't provide beats.
    const beats = episode.sections[i]?.visuals?.length
      ? episode.sections[i]!.visuals!
      : [sec.visual];
    const clips = await fetchBrollForBeats(
      beats,
      sec.duration,
      runDir,
      used,
      footageUsed,
      imageCredits,
      { pixabayCategory },
    );
    broll.push(clips.map((c) => relAsset(runDir, c.path)));
  }

  const interludeCount = sectionAudios.length >= 3
    ? Math.max(1, Math.floor(sectionAudios.length / 3))
    : 0;
  const interludePositions: number[] = [];
  if (interludeCount > 0) {
    const step = sectionAudios.length / (interludeCount + 1);
    for (let k = 1; k <= interludeCount; k++) {
      interludePositions.push(Math.min(sectionAudios.length - 2, Math.round(step * k) - 1));
    }
  }

  const narrationSec = sectionAudios.reduce((a, s) => a + s.duration, 0);

  log(`Step 4/8: Fetch BGM + ${interludeCount} ambient interlude${interludeCount === 1 ? '' : 's'}`);
  const bgmQueries = [...series.musicQueries, ...structure.musicTags];
  const bgm = await fetchBgm(bgmQueries, runDir);
  const bgmPath = bgm.path;
  // BGM credit leads the attribution list; interlude tracks are appended below.
  const musicCredits: MusicCredit[] = [bgm.credit];

  // Interlude footage is anchored to the episode subject (when the script model
  // provided one) so even the breather shots stay on-topic; ambient *audio*
  // still uses the series' generic mood query. Falls back to the series ambient
  // query if no subject was resolved.
  const interludeVisualQuery = episode.subject?.trim() || series.ambientQuery;

  const interludes: Interlude[] = [];
  for (let k = 0; k < interludeCount; k++) {
    log(`Step 5/8: Fetch interlude ${k + 1}/${interludeCount} (ambient audio + b-roll)`);
    const ambient = await fetchAmbient(series.ambientQuery, runDir);
    if (!ambient) {
      log(`Interlude ${k + 1}/${interludeCount} skipped — no ambient audio available`);
      continue;
    }
    musicCredits.push(ambient.credit);
    const visuals = await fetchBroll(
      interludeVisualQuery,
      INTERLUDE_SEC,
      runDir,
      used,
      footageUsed,
      imageCredits,
      { pixabayCategory },
    );
    interludes.push({
      afterSectionIndex: interludePositions[k]!,
      durationSec: INTERLUDE_SEC,
      visualPath: relAsset(runDir, visuals[0]!.path),
      audioPath: ambient.path,
    });
  }

  const totalGapSec = INTER_SECTION_GAP_SEC * sectionAudios.length;
  const totalInterludeSec = interludes.reduce((a, i) => a + i.durationSec, 0);
  const totalDuration =
    COLD_OPEN_SEC +
    narrationSec +
    totalGapSec +
    totalInterludeSec +
    OUTRO_SUBSCRIBE_SEC;

  const coldOpenVisualPath = broll[0]?.[0] ?? '';

  const profile: RuntimeProfile = {
    voiceId: voice.id,
    voiceLabel: voice.label,
    toneKey: tone.key,
    toneLabel: tone.label,
    structureKey: structure.key,
    structureLabel: structure.label,
    thumbLayout,
    subTheme,
    hookPattern,
  };

  const manifest: RenderManifest = {
    series: series.name,
    title: episode.title,
    hook: episode.hook,
    coldOpenVisualPath,
    intro: { durationSec: COLD_OPEN_SEC },
    sections: sectionAudios.map((s, i) => ({
      heading: s.heading,
      audioPath: s.mp3Path,
      duration: s.duration,
      gapAfterSec: INTER_SECTION_GAP_SEC,
      brollPaths: broll[i]!,
      cutTimes: computeCutTimes(
        s.words,
        s.duration + INTER_SECTION_GAP_SEC,
        broll[i]!.length,
      ),
      words: s.words,
      iconEvents: extractIconEvents(s.words, `${s.heading} ${s.visual}`),
      overlays: episode.sections[i]?.overlays,
    })),
    interludes,
    outro: { durationSec: OUTRO_SUBSCRIBE_SEC, watchNextTitle: winningTitles[0] },
    bgmPath,
    bgmVolume: BGM_VOLUME,
    totalDuration,
    sting: {
      subFreq: structure.stingSubFreq,
      topFreq: structure.stingTopFreq,
      topDuration: structure.stingTopDuration,
    },
    profile,
  };
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  log(`Manifest: ${totalDuration.toFixed(1)}s total (${(totalDuration / 60).toFixed(1)} min)`);

  log('Step 6/8: Render Remotion video (silent)');
  const silentVideo = path.join(runDir, 'video_silent.mp4');
  await renderVideo(manifest, silentVideo, runDir);

  log('Step 7/8: Mux audio with ffmpeg');
  const finalName = `${today}_${safeFilename(episode.title)}.mp4`;
  const finalVideo = path.join(OUT_DIR, finalName);
  await muxAudio(silentVideo, manifest, finalVideo);
  writeSrt(manifest, path.join(runDir, 'captions.srt'));

  log('Step 8/8: Thumbnail + upload');
  const thumbPath = await makeThumbnail(
    episode.title,
    series,
    thumbLayout,
    runDir,
    episode.thumbnailConcept,
    episode.thumbnailWord,
  );
  const thumbOut = path.join(OUT_DIR, finalName.replace(/\.mp4$/, '.jpg'));
  fs.copyFileSync(thumbPath, thumbOut);
  log(`Thumbnail copied: ${thumbOut}`);

  // Compose the final description once (chapters + auto music/footage
  // attribution) so the exact text is verifiable on a dry run and reused
  // verbatim on upload. Crediting every YouTube Audio Library track used
  // satisfies the "attribution required" obligation automatically, every video.
  const chapters = buildChapters(manifest);
  // Only credit libraries that actually contributed footage, in a stable order.
  const footageSources = ['Pexels', 'Pixabay', 'Coverr', 'Unsplash'].filter((s) =>
    footageUsed.has(s),
  );
  const attribution = buildAttribution(musicCredits, footageSources, imageCredits);
  // "Watch next" cross-links to the channel's strongest long-form videos —
  // session watch-time is a heavy ranking signal and these links are free.
  // Empty string (young channel / analytics off) just drops out of the join.
  const watchNext = buildWatchNextBlock(topPerformers);
  const fullDescription = [episode.description, chapters, watchNext, CHANNEL_FOOTER, attribution]
    .filter(Boolean)
    .join('\n\n');
  const episodeForUpload: Episode = { ...episode, description: fullDescription };
  fs.writeFileSync(path.join(runDir, 'description.txt'), fullDescription);
  log(`Description composed (${fullDescription.length} chars) → ${path.join(runDir, 'description.txt')}`);

  const bgmCreditLine = shortsMusicLine(bgm.credit);

  if (DRY_RUN) {
    log(`DRY_RUN=1 — skipping YouTube upload. Final: ${finalVideo}`);
    await runShortsPipeline(manifest, episode, series.categoryId, runDir, today, null, bgmCreditLine, used, pixabayCategory);
    return;
  }

  // Publish at today's US-afternoon slot (19:00 UTC) deterministically, instead
  // of drifting with render duration. If that moment has already passed (e.g. a
  // late manual dispatch), fall back to the fixed offset from now.
  const nowTs = new Date();
  let publishAt = publishAtFor(0, nowTs);
  if (publishAt.getTime() <= nowTs.getTime()) {
    publishAt = new Date(nowTs.getTime() + PUBLISH_OFFSET_HOURS * 3600_000);
  }
  // Best-effort localized title/description so non-English viewers can discover
  // the video in their feed/search. Channel stays English-primary; we translate
  // only the title + prose blurb, then re-attach the language-neutral
  // chapters/footer/attribution so timestamps and URLs are never mangled.
  const translations = await translateMetadata(episode.title, episode.description);
  const localizations = Object.fromEntries(
    Object.entries(translations).map(([code, t]) => [
      code,
      {
        title: t.title,
        description: [t.description, chapters, watchNext, CHANNEL_FOOTER, attribution]
          .filter(Boolean)
          .join('\n\n'),
      },
    ]),
  );
  const localeCount = Object.keys(localizations).length;
  if (localeCount > 0) log(`Localized metadata into ${localeCount} languages: ${Object.keys(localizations).join(', ')}`);

  const videoId = await uploadVideo(finalVideo, thumbPath, episodeForUpload, series.categoryId, {
    publishAt,
    localizations,
  });
  // Long-form is live — record the lock so any later same-day run aborts above.
  writeUploadLock(today);
  // Log which thumbnail layout this video shipped with, so once its CTR is
  // measured the layout-learning picker can weight future draws by it.
  recordThumbLayout(videoId, thumbLayout);
  log(`Done. https://youtu.be/${videoId} (scheduled ${publishAt.toISOString()})`);

  // Best-effort enrichments (each self-contained & non-fatal): shelve the video
  // on its series playlist for binge/session watch-time, and ship a real
  // selectable caption track from the SRT we already wrote.
  await addToSeriesPlaylist(videoId, series.name, series.theme);
  await uploadCaption(videoId, path.join(runDir, 'captions.srt'));

  await runShortsPipeline(manifest, episode, series.categoryId, runDir, today, videoId, bgmCreditLine, used, pixabayCategory);

  // End-of-run housekeeping over PAST uploads (each opt-in via its env flag and
  // fully non-fatal): seed one engagement comment under each recently-public
  // video that lacks ours, rescue at most one underperforming long-form video's
  // packaging (alternating thumbnail/title lever), and run a qualitative
  // self-audit of recent packaging against the views playbook (advisory log +
  // non-failing warning; never edits a live video). Runs only on real
  // (non-DRY_RUN) runs — the early DRY_RUN return above skips it.
  await autoCommentOnRecentVideos();
  await rescueWorstPackaging();
  await auditRecentContent();
}

async function runShortsPipeline(
  manifest: RenderManifest,
  episode: Episode,
  categoryId: string,
  runDir: string,
  today: string,
  longVideoId: string | null,
  musicCredit: string,
  usedUrls: Set<string>,
  pixabayCategory?: string,
): Promise<void> {
  const utcDay = new Date().getUTCDay();
  const plan = planShortsForToday(utcDay);
  if (plan.length === 0) {
    log('Shorts: nothing scheduled for today.');
    return;
  }

  log(`Shorts: generating ${plan.length} short(s).`);
  for (let k = 0; k < plan.length; k++) {
    const entry = plan[k]!;
    log(`Shorts ${k + 1}/${plan.length}: section ${entry.sectionIdx}, publish +${entry.daysAhead}d`);
    const base = buildShortsManifest(manifest, episode, entry);
    if (!base) continue;

    // Portrait-native footage upgrade: by default a Short reuses the long
    // section's landscape clips, which the 9:16 renderer center-crops down to
    // ~1/3 of the frame. Best-effort fetch of true portrait clips for the same
    // narration beats (a throw here must never kill the remaining Shorts or the
    // post-upload housekeeping, so any failure just keeps the fallback).
    const epSection = episode.sections[entry.sectionIdx];
    const beats = epSection?.visuals?.length
      ? epSection.visuals
      : epSection?.visual
        ? [epSection.visual]
        : [];
    let portraitPaths: string[] = [];
    try {
      const portrait = await fetchShortsBroll(
        beats,
        base.narrationSec,
        runDir,
        usedUrls,
        pixabayCategory,
      );
      portraitPaths = portrait.map((c) => relAsset(runDir, c.path));
    } catch (e) {
      log(`Shorts ${k + 1}: portrait b-roll fetch failed, keeping landscape — ${(e as Error).message}`);
    }
    // Use the portrait clips when at least 2 turned up (a lone clip would make
    // the Short one static shot), leading the cut list, and top back up with
    // the landscape fallback clips to the duration-based quota: a short clip
    // list would stretch each cut slot past the clips' own length, and
    // OffthreadVideo does not loop — the tail would freeze on the last frame.
    // Cut times are rebuilt for the final clip count against the
    // already-trimmed words.
    const clipQuota = Math.max(1, Math.ceil(base.narrationSec / BROLL_CLIP_SEC));
    const sm =
      portraitPaths.length >= 2
        ? (() => {
            const brollPaths = [...portraitPaths, ...base.brollPaths].slice(0, clipQuota);
            return {
              ...base,
              brollPaths,
              cutTimes: computeCutTimes(base.words, base.narrationSec, brollPaths.length),
            };
          })()
        : base;
    if (portraitPaths.length >= 2) {
      log(
        `Shorts ${k + 1}: portrait-native b-roll (${portraitPaths.length} portrait, ${sm.brollPaths.length} total clips)`,
      );
    }
    fs.writeFileSync(path.join(runDir, `shorts_${k}.json`), JSON.stringify(sm, null, 2));

    const silentShort = path.join(runDir, `shorts_${k}_silent.mp4`);
    await renderShorts(sm, silentShort, runDir);

    const finalShort = path.join(
      OUT_DIR,
      `${today}_short${k}_${safeFilename(episode.title)}.mp4`,
    );
    await muxShortsAudio(silentShort, sm.audioPath, sm.bgmPath, sm.bgmVolume, sm.duration, finalShort, sm.narrationSec);

    if (DRY_RUN) {
      log(`DRY_RUN=1 — skipping shorts upload. Final: ${finalShort}`);
      continue;
    }

    // Same-day teasers (daysAhead 0) normally resolve to a future slot (run
    // starts 13:00 UTC, teaser publishes ~21:00 UTC). Guard the late-dispatch
    // edge: a past publishAt is rejected by the YouTube API, so fall back to a
    // fixed offset from now.
    let publishAt = publishAtFor(entry.daysAhead, new Date(), entry.publishHourUtc);
    if (publishAt.getTime() <= Date.now()) {
      publishAt = new Date(Date.now() + PUBLISH_OFFSET_HOURS * 3600_000);
    }
    const shortsBlurb = await generateShortsBlurb(sm.shortsTitle, sm.hook, episode.description);
    const shortsEpisode: Episode = {
      title: sm.shortsTitle,
      hook: sm.hook,
      description: shortsBlurb,
      tags: episode.tags,
      sections: [],
    };
    const shortId = await uploadVideo(finalShort, null, shortsEpisode, categoryId, {
      publishAt,
      isShorts: true,
      longVideoId: longVideoId ?? undefined,
      musicCredit,
    });
    log(`Short ${k} uploaded: https://youtu.be/${shortId} (scheduled ${publishAt.toISOString()})`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
