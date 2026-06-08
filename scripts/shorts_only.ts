// Standalone shorts generator: renders shorts from an ALREADY-rendered episode's
// saved manifest, without regenerating the script or re-rendering the long video.
//
// Usage:
//   tsx scripts/shorts_only.ts [runDirName]
// If runDirName is omitted, the most recently modified directory under work/ is used.
// SHORTS_PLAN_WEEKDAY controls how many shorts (1 or 3 => 2 shorts: same-day
// teaser + next-day; 5 => 3 shorts; other weekdays => none).
import fs from 'node:fs';
import path from 'node:path';
import { OUT_DIR, WORK_DIR } from '../src/config.js';
import { renderShorts } from '../src/render.js';
import { muxShortsAudio } from '../src/mux.js';
import { buildShortsManifest, planShortsForToday } from '../src/shortsGen.js';
import { ensureDir, log, safeFilename } from '../src/utils.js';
import type { Episode, RenderManifest } from '../src/types.js';

function resolveRunDir(): string {
  const arg = process.argv[2];
  if (arg) return path.join(WORK_DIR, arg);
  const dirs = fs
    .readdirSync(WORK_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(WORK_DIR, d.name))
    .filter((p) => fs.existsSync(path.join(p, 'manifest.json')));
  if (dirs.length === 0) throw new Error('No run dir with manifest.json under work/');
  dirs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return dirs[0]!;
}

async function main(): Promise<void> {
  const runDir = resolveRunDir();
  const runName = path.basename(runDir);
  const today = runName.slice(0, 10); // YYYY-MM-DD prefix
  log(`Shorts-only: using run dir ${runName}`);

  const manifest: RenderManifest = JSON.parse(
    fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf-8'),
  );
  const episode: Episode = JSON.parse(
    fs.readFileSync(path.join(runDir, 'episode.json'), 'utf-8'),
  );
  ensureDir(OUT_DIR);

  // Default to weekday 3 (=> 2 shorts) when nothing scheduled; SHORTS_PLAN_WEEKDAY overrides.
  const weekday = process.env.SHORTS_PLAN_WEEKDAY
    ? Number.parseInt(process.env.SHORTS_PLAN_WEEKDAY, 10)
    : 3;
  const plan = planShortsForToday(weekday);
  if (plan.length === 0) {
    log('Shorts-only: plan empty, nothing to do.');
    return;
  }

  log(`Shorts-only: generating ${plan.length} short(s).`);
  for (let k = 0; k < plan.length; k++) {
    const entry = plan[k]!;
    log(`Shorts ${k + 1}/${plan.length}: section ${entry.sectionIdx}`);
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
    log(`Short ${k} done: ${finalShort}`);
  }
  log('Shorts-only: complete.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
