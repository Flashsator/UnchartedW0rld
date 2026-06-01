import fs from 'node:fs';
import path from 'node:path';
import {
  COLD_OPEN_SEC,
  DRY_RUN,
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
  pickThumbLayout,
  pickTone,
  pickVoice,
  seriesForToday,
} from './config.js';
import { generateEpisode, generateShortsBlurb } from './scriptGen.js';
import { synthesize } from './tts.js';
import { fetchAmbient, fetchBgm, fetchBroll } from './stock.js';
import { makeThumbnail } from './thumbnail.js';
import { renderVideo, renderShorts } from './render.js';
import { buildChapters, muxAudio, muxShortsAudio, writeSrt } from './mux.js';
import { uploadVideo } from './youtube.js';
import { extractIconEvents } from './iconExtractor.js';
import { computeCutTimes } from './cuts.js';
import { buildShortsManifest, planShortsForToday, publishAtFor } from './shortsGen.js';
import type { Episode, Interlude, RenderManifest, RuntimeProfile } from './types.js';
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
  const thumbLayout = pickThumbLayout();
  const subTheme = pickSubTheme(series);

  log(`=== UnchartedW0rld — ${series.name} (${series.key}) ===`);
  log(
    `Profile: voice=${voice.label} (fixed) | tone=${tone.label} (rate ${tone.rate}, pitch ${tone.pitch}) | structure=${structure.label} (${structure.key}) | thumb=${thumbLayout} | sub-theme="${subTheme}" | target=${TARGET_MINUTES}min`,
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
  const { episode, hookPattern } = await generateEpisode(series, structure, voice, subTheme);
  fs.writeFileSync(path.join(runDir, 'episode.json'), JSON.stringify(episode, null, 2));

  log('Step 2/8: Synthesize narration');
  const sectionAudios = await synthesize(episode, runDir, [voice.id], {
    rate: tone.rate,
    pitch: tone.pitch,
  });

  log('Step 3/8: Fetch b-roll for each section');
  const used = new Set<string>();
  const broll: string[][] = [];
  for (const sec of sectionAudios) {
    const clips = await fetchBroll(sec.visual, sec.duration, runDir, used);
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
  const bgmPath = await fetchBgm(bgmQueries, runDir);

  const interludes: Interlude[] = [];
  for (let k = 0; k < interludeCount; k++) {
    log(`Step 5/8: Fetch interlude ${k + 1}/${interludeCount} (ambient audio + b-roll)`);
    const audio = await fetchAmbient(series.ambientQuery, runDir);
    if (!audio) {
      log(`Interlude ${k + 1}/${interludeCount} skipped — no ambient audio available`);
      continue;
    }
    const visuals = await fetchBroll(series.ambientQuery, INTERLUDE_SEC, runDir, used);
    interludes.push({
      afterSectionIndex: interludePositions[k]!,
      durationSec: INTERLUDE_SEC,
      visualPath: relAsset(runDir, visuals[0]!.path),
      audioPath: audio,
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
    outro: { durationSec: OUTRO_SUBSCRIBE_SEC },
    bgmPath,
    bgmVolume: 0.35,
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

  if (DRY_RUN) {
    log(`DRY_RUN=1 — skipping YouTube upload. Final: ${finalVideo}`);
    await runShortsPipeline(manifest, episode, series.categoryId, runDir, today, null);
    return;
  }

  const chapters = buildChapters(manifest);
  const episodeForUpload: Episode = chapters
    ? { ...episode, description: `${episode.description}\n\n${chapters}` }
    : episode;
  // Publish at today's US-afternoon slot (19:00 UTC) deterministically, instead
  // of drifting with render duration. If that moment has already passed (e.g. a
  // late manual dispatch), fall back to the fixed offset from now.
  const nowTs = new Date();
  let publishAt = publishAtFor(0, nowTs);
  if (publishAt.getTime() <= nowTs.getTime()) {
    publishAt = new Date(nowTs.getTime() + PUBLISH_OFFSET_HOURS * 3600_000);
  }
  const videoId = await uploadVideo(finalVideo, thumbPath, episodeForUpload, series.categoryId, {
    publishAt,
  });
  // Long-form is live — record the lock so any later same-day run aborts above.
  writeUploadLock(today);
  log(`Done. https://youtu.be/${videoId} (scheduled ${publishAt.toISOString()})`);

  await runShortsPipeline(manifest, episode, series.categoryId, runDir, today, videoId);
}

async function runShortsPipeline(
  manifest: RenderManifest,
  episode: Episode,
  categoryId: string,
  runDir: string,
  today: string,
  longVideoId: string | null,
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
    const sm = buildShortsManifest(manifest, episode, entry);
    if (!sm) continue;
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

    const publishAt = publishAtFor(entry.daysAhead);
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
    });
    log(`Short ${k} uploaded: https://youtu.be/${shortId} (scheduled ${publishAt.toISOString()})`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
