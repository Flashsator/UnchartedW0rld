// One-off preview: generate full thumbnails (FLUX.2 [klein] 9B background +
// composited text card) across several series/layouts so the look can be
// eyeballed before relying on it in the daily pipeline.
// Run: npx tsx scripts/thumb_preview.ts
import path from 'node:path';
import { ROOT, SERIES_POOL, type ThumbLayout } from '../src/config.js';
import { makeThumbnail } from '../src/thumbnail.js';
import { ensureDir, log } from '../src/utils.js';

type Sample = { series: string; title: string; layout: ThumbLayout };

const SAMPLES: Sample[] = [
  // Previously flagged by FLUX output moderation (predator/hunts/dark);
  // re-run to confirm the prompt-softening lets it pass.
  { series: 'animals', title: 'Profile: The Predator That Hunts in the Dark', layout: 'q_giant_overlay' },
];

async function main(): Promise<void> {
  for (const s of SAMPLES) {
    const series = SERIES_POOL.find((x) => x.key === s.series)!;
    const workDir = ensureDir(path.join(ROOT, 'work', 'thumb-preview', s.series));
    const out = await makeThumbnail(s.title, series, s.layout, workDir);
    log(`Preview [${s.series}/${s.layout}]: ${out}`);
  }
}

main().catch((e) => {
  log('Preview failed:', (e as Error).message);
  process.exit(1);
});
