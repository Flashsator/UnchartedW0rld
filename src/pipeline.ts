import fs from 'node:fs';
import path from 'node:path';
import {
  BGM_VOLUME,
  CHANNEL_FOOTER,
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
import { buildAttribution, shortsMusicLine } from './attribution.js';
import { listUploadedTitles, uploadVideo } from './youtube.js';
import { extractIconEvents } from './iconExtractor.js';
import { computeCutTimes } from './cuts.js';
import { buildShortsManifest, planShortsForToday, publishAtFor } from './shortsGen.js';
import type { Episode, Interlude, MusicCredit, RenderManifest, RuntimeProfile } from './types.js';
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

  log(`=== Wild Anomalies — ${series.name} (${series.key}) ===`);
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
  // Pull recently-published titles so the generator avoids repeating topics.
  // The channel is the durable source of truth; this is best-effort and
  // returns [] on any API failure.
  const priorTitles = await listUploadedTitles();
  if (priorTitles.length > 0) {
    log(`Topic dedup: avoiding ${priorTitles.length} already-published titles.`);
  }
  const { episode, hookPattern } = await generateEpisode(series, structure, voice, subTheme, priorTitles);
  fs.writeFileSync(path.join(runDir, 'episode.json'), JSON.stringify(episode, null, 2));

  log('Step 2/8: Synthesize narration');
  const sectionAudios = await synthesize(episode, runDir, [voice.id], {
    rate: tone.rate,
    pitch: tone.pitch,
  });

  log('Step 3/8: Fetch b-roll for each section');
  const used = new Set<string>();
  // Records which stock libraries actually contributed footage, so the
  // description credits only the sources truly used (not just the ones enabled).
  const footageUsed = new Set<string>();
  const broll: string[][] = [];
  for (const sec of sectionAudios) {
    const clips = await fetchBroll(sec.visual, sec.duration, runDir, used, footageUsed);
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
    const visuals = await fetchBroll(interludeVisualQuery, INTERLUDE_SEC, runDir, used, footageUsed);
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
    outro: { durationSec: OUTRO_SUBSCRIBE_SEC },
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
  const attribution = buildAttribution(musicCredits, footageSources);
  const fullDescription = [episode.description, chapters, CHANNEL_FOOTER, attribution]
    .filter(Boolean)
    .join('\n\n');
  const episodeForUpload: Episode = { ...episode, description: fullDescription };
  fs.writeFileSync(path.join(runDir, 'description.txt'), fullDescription);
  log(`Description composed (${fullDescription.length} chars) → ${path.join(runDir, 'description.txt')}`);

  const bgmCreditLine = shortsMusicLine(bgm.credit);

  if (DRY_RUN) {
    log(`DRY_RUN=1 — skipping YouTube upload. Final: ${finalVideo}`);
    await runShortsPipeline(manifest, episode, series.categoryId, runDir, today, null, bgmCreditLine);
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
  const videoId = await uploadVideo(finalVideo, thumbPath, episodeForUpload, series.categoryId, {
    publishAt,
  });
  // Long-form is live — record the lock so any later same-day run aborts above.
  writeUploadLock(today);
  log(`Done. https://youtu.be/${videoId} (scheduled ${publishAt.toISOString()})`);

  await runShortsPipeline(manifest, episode, series.categoryId, runDir, today, videoId, bgmCreditLine);
}

async function runShortsPipeline(
  manifest: RenderManifest,
  episode: Episode,
  categoryId: string,
  runDir: string,
  today: string,
  longVideoId: string | null,
  musicCredit: string,
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
      musicCredit,
    });
    log(`Short ${k} uploaded: https://youtu.be/${shortId} (scheduled ${publishAt.toISOString()})`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
