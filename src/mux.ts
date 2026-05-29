import fs from 'node:fs';
import path from 'node:path';
import type { RenderManifest } from './types.js';
import { chunkWords } from './chunker.js';
import { ensureDir, log, run } from './utils.js';

type InterludeWithStart = {
  afterSectionIndex: number;
  durationSec: number;
  audioPath: string;
  startSec: number;
};

function buildTimeline(manifest: RenderManifest): {
  sectionStarts: number[];
  interludes: InterludeWithStart[];
} {
  const sectionStarts: number[] = [];
  const interludes: InterludeWithStart[] = [];
  const interludesByAfter = new Map<number, RenderManifest['interludes'][number]>();
  for (const il of manifest.interludes) interludesByAfter.set(il.afterSectionIndex, il);

  let cursor = manifest.intro.durationSec;
  for (let i = 0; i < manifest.sections.length; i++) {
    const sec = manifest.sections[i]!;
    sectionStarts.push(cursor);
    cursor += sec.duration + sec.gapAfterSec;
    const il = interludesByAfter.get(i);
    if (il) {
      interludes.push({
        afterSectionIndex: i,
        durationSec: il.durationSec,
        audioPath: il.audioPath,
        startSec: cursor,
      });
      cursor += il.durationSec;
    }
  }
  return { sectionStarts, interludes };
}

export async function muxAudio(
  videoIn: string,
  manifest: RenderManifest,
  outPath: string,
): Promise<string> {
  ensureDir(path.dirname(outPath));

  const { sectionStarts, interludes } = buildTimeline(manifest);
  const totalDur = manifest.totalDuration;
  const args: string[] = ['-y', '-i', videoIn];

  args.push('-i', manifest.bgmPath);
  for (const il of interludes) args.push('-i', il.audioPath);
  const narrStartIdx = 2 + interludes.length;
  for (const s of manifest.sections) args.push('-i', s.audioPath);

  const filter: string[] = [];
  const SR = 48000;
  const fmt = `aresample=${SR},aformat=sample_fmts=fltp:channel_layouts=stereo`;

  const coldOpenSec = manifest.intro.durationSec;
  const duckCurve = coldOpenSec > 0
    ? `,volume='if(lt(t,${coldOpenSec.toFixed(3)}),0.35,1)':eval=frame`
    : '';
  filter.push(
    `[1:a]${fmt},aloop=loop=-1:size=2e9,atrim=0:${totalDur.toFixed(3)},afade=t=in:st=0:d=1,afade=t=out:st=${(totalDur - 1).toFixed(3)}:d=1,volume=${manifest.bgmVolume}${duckCurve}[bgm]`,
  );

  const stingLabels: string[] = [];
  if (coldOpenSec > 0) {
    const sub = manifest.sting?.subFreq ?? 46;
    const top = manifest.sting?.topFreq ?? 190;
    const topDur = manifest.sting?.topDuration ?? 0.55;
    filter.push(
      `sine=frequency=${sub}:duration=${(coldOpenSec + 0.2).toFixed(3)}:sample_rate=${SR},${fmt},afade=t=in:st=0:d=0.02,afade=t=out:st=${Math.max(0, coldOpenSec - 0.4).toFixed(3)}:d=0.6,volume=0.85[sting_sub]`,
    );
    filter.push(
      `sine=frequency=${top}:duration=${topDur.toFixed(3)}:sample_rate=${SR},${fmt},afade=t=out:st=0:d=${topDur.toFixed(3)},volume=0.32[sting_top]`,
    );
    stingLabels.push('sting_sub', 'sting_top');
  }

  const ambLabels: string[] = [];
  interludes.forEach((il, k) => {
    const inputIdx = 2 + k;
    const delayMs = Math.round(il.startSec * 1000);
    const label = `amb${k}`;
    filter.push(
      `[${inputIdx}:a]${fmt},atrim=0:${il.durationSec.toFixed(3)},afade=t=in:st=0:d=0.6,afade=t=out:st=${(il.durationSec - 0.8).toFixed(3)}:d=0.8,adelay=${delayMs}|${delayMs},volume=0.85[${label}]`,
    );
    ambLabels.push(label);
  });

  // Section transition whooshes: brown-noise burst, bandpassed low, at each
  // section start except section 0 (cold open's sting already covers that).
  const whooshLabels: string[] = [];
  for (let i = 1; i < sectionStarts.length; i++) {
    const startSec = sectionStarts[i]!;
    if (startSec <= 0.1) continue;
    const delayMs = Math.round(startSec * 1000);
    const label = `wh${i}`;
    filter.push(
      `anoisesrc=d=0.42:c=brown:sample_rate=${SR},${fmt},` +
        `bandpass=f=240:width_type=h:w=220,` +
        `afade=t=in:st=0:d=0.03,afade=t=out:st=0.18:d=0.22,` +
        `adelay=${delayMs}|${delayMs},volume=0.20[${label}]`,
    );
    whooshLabels.push(label);
  }

  // Icon event audio pops: sub thump + bright tip aligned with each emoji
  // overlay so the visual punch is also audible.
  const popLabels: string[] = [];
  manifest.sections.forEach((sec, i) => {
    sec.iconEvents.forEach((ev, k) => {
      const startSec = sectionStarts[i]! + ev.start;
      if (startSec < 0) return;
      const subDelay = Math.round(startSec * 1000);
      const topDelay = Math.max(0, Math.round((startSec - 0.005) * 1000));
      const subLabel = `pops_${i}_${k}`;
      const topLabel = `popt_${i}_${k}`;
      filter.push(
        `sine=frequency=72:duration=0.14:sample_rate=${SR},${fmt},` +
          `afade=t=in:st=0:d=0.004,afade=t=out:st=0.05:d=0.09,` +
          `adelay=${subDelay}|${subDelay},volume=0.30[${subLabel}]`,
      );
      filter.push(
        `sine=frequency=920:duration=0.06:sample_rate=${SR},${fmt},` +
          `afade=t=in:st=0:d=0.002,afade=t=out:st=0.012:d=0.048,` +
          `adelay=${topDelay}|${topDelay},volume=0.12[${topLabel}]`,
      );
      popLabels.push(subLabel, topLabel);
    });
  });

  const narrLabels: string[] = [];
  manifest.sections.forEach((_, i) => {
    const inputIdx = narrStartIdx + i;
    const delayMs = Math.round(sectionStarts[i]! * 1000);
    const label = `n${i}`;
    filter.push(`[${inputIdx}:a]${fmt},adelay=${delayMs}|${delayMs},volume=1.6[${label}]`);
    narrLabels.push(label);
  });

  const narrConcat = narrLabels.map((l) => `[${l}]`).join('');
  filter.push(
    `${narrConcat}amix=inputs=${narrLabels.length}:duration=longest:normalize=0,apad=whole_dur=${totalDur.toFixed(3)},atrim=0:${totalDur.toFixed(3)}[narr_mix]`,
  );
  filter.push(`[narr_mix]asplit=2[narr_sc][narr_out]`);

  filter.push(`[bgm][narr_sc]sidechaincompress=threshold=0.04:ratio=12:attack=20:release=400[bgm_d]`);

  const ambConcat = ambLabels.map((l) => `[${l}]`).join('');
  const stingConcat = stingLabels.map((l) => `[${l}]`).join('');
  const whooshConcat = whooshLabels.map((l) => `[${l}]`).join('');
  const popConcat = popLabels.map((l) => `[${l}]`).join('');
  const finalMixInputs = `[bgm_d]${ambConcat}${stingConcat}${whooshConcat}${popConcat}[narr_out]`;
  const finalMixCount =
    2 + ambLabels.length + stingLabels.length + whooshLabels.length + popLabels.length;
  filter.push(
    `${finalMixInputs}amix=inputs=${finalMixCount}:duration=longest:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11,alimiter=limit=0.97[aout]`,
  );

  const filterStr = filter.join(';');

  args.push(
    '-filter_complex', filterStr,
    '-map', '0:v',
    '-map', '[aout]',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-t', totalDur.toFixed(3),
    outPath,
  );

  log('Muxing audio with ffmpeg...');
  await run('ffmpeg', args);
  log(`Mux complete: ${outPath}`);
  return outPath;
}

// Builds a YouTube chapter block from the section timeline. YouTube requires the
// first timestamp to be 0:00 and at least 3 chapters ≥10s apart — section 0 is
// pinned to 0:00 (it covers the cold open), and section durations guarantee the
// spacing. Returns '' if there aren't enough sections to form valid chapters.
export function buildChapters(manifest: RenderManifest): string {
  const { sectionStarts } = buildTimeline(manifest);
  if (manifest.sections.length < 3) return '';
  const lines = manifest.sections.map((sec, i) => {
    const t = i === 0 ? 0 : sectionStarts[i]!;
    return `${fmtChapterTime(t)} ${sec.heading}`;
  });
  return `Chapters:\n${lines.join('\n')}`;
}

function fmtChapterTime(t: number): string {
  const total = Math.floor(t);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function writeSrt(manifest: RenderManifest, outPath: string): string {
  const { sectionStarts } = buildTimeline(manifest);
  const lines: string[] = [];
  let cueIdx = 1;

  for (let i = 0; i < manifest.sections.length; i++) {
    const sec = manifest.sections[i]!;
    const cues = chunkWords(sec.words);
    for (const cue of cues) {
      const start = sectionStarts[i]! + cue.start;
      const end = sectionStarts[i]! + cue.end;
      lines.push(String(cueIdx++));
      lines.push(`${fmtSrtTime(start)} --> ${fmtSrtTime(end)}`);
      lines.push(cue.text);
      lines.push('');
    }
  }

  fs.writeFileSync(outPath, lines.join('\n'), 'utf-8');
  log(`SRT written: ${outPath}`);
  return outPath;
}

export async function muxShortsAudio(
  videoIn: string,
  narrationMp3: string,
  bgmPath: string,
  bgmVolume: number,
  totalDur: number,
  outPath: string,
  narrationDur?: number,
): Promise<string> {
  ensureDir(path.dirname(outPath));
  const SR = 48000;
  const fmt = `aresample=${SR},aformat=sample_fmts=fltp:channel_layouts=stereo`;
  // Narration stops at narrationDur (defaults to the whole clip); BGM keeps
  // playing through the end-card outro [narrationDur, totalDur].
  const narrDur = Math.min(narrationDur ?? totalDur, totalDur);
  const args: string[] = ['-y', '-i', videoIn, '-i', bgmPath, '-i', narrationMp3];

  const filter: string[] = [
    `[1:a]${fmt},aloop=loop=-1:size=2e9,atrim=0:${totalDur.toFixed(3)},afade=t=in:st=0:d=0.6,afade=t=out:st=${(totalDur - 0.8).toFixed(3)}:d=0.8,volume=${bgmVolume}[bgm]`,
    `[2:a]${fmt},atrim=0:${narrDur.toFixed(3)},afade=t=out:st=${Math.max(0, narrDur - 0.25).toFixed(3)}:d=0.25,volume=1.6[narr]`,
    `[narr]asplit=2[narr_sc][narr_out]`,
    `[bgm][narr_sc]sidechaincompress=threshold=0.05:ratio=10:attack=15:release=350[bgm_d]`,
    `[bgm_d][narr_out]amix=inputs=2:duration=longest:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11,alimiter=limit=0.97[aout]`,
  ];

  args.push(
    '-filter_complex',
    filter.join(';'),
    '-map',
    '0:v',
    '-map',
    '[aout]',
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-t',
    totalDur.toFixed(3),
    outPath,
  );

  log('Muxing shorts audio with ffmpeg...');
  await run('ffmpeg', args);
  log(`Shorts mux complete: ${outPath}`);
  return outPath;
}

function fmtSrtTime(t: number): string {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const ms = Math.floor((t - Math.floor(t)) * 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${String(ms).padStart(3, '0')}`;
}
function pad(n: number): string {
  return String(n).padStart(2, '0');
}
