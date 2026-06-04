// Re-composite previously-generated previews from their cached backgrounds
// (work/thumb-preview/.../thumb/bg.jpg) using the current no-dim compositing.
// Does NOT call FLUX, so it costs zero image-generation quota.
// Run: npx tsx scripts/thumb_recompose.ts
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, SERIES_POOL, type ThumbLayout } from '../src/config.js';
import { composeThumbnail } from '../src/thumbnail.js';
import { log } from '../src/utils.js';

type Item = { dir: string; series: string; title: string; layout: ThumbLayout };

const ITEMS: Item[] = [
  { dir: 'thumb-preview/thumb', series: 'ocean', title: 'Profile: The Creature That Glows Where No Light Reaches', layout: 'q_diag_split' },
  { dir: 'thumb-preview/nature/thumb', series: 'nature', title: 'Case File: The Lake That Turns Animals to Stone', layout: 'q_band_word' },
  { dir: 'thumb-preview/cosmos/thumb', series: 'cosmos', title: 'The Star That Should Not Exist', layout: 'q_corner_dot' },
  { dir: 'thumb-preview/animals/thumb', series: 'animals', title: 'Profile: The Predator That Hunts in the Dark', layout: 'q_giant_overlay' },
  { dir: 'thumb-preview/history/thumb', series: 'history', title: 'What They Found Beneath the Desert', layout: 'q_panel_right' },
];

async function main(): Promise<void> {
  for (const it of ITEMS) {
    const thumbDir = path.join(ROOT, 'work', it.dir);
    const bgPath = path.join(thumbDir, 'bg.jpg');
    if (!fs.existsSync(bgPath)) {
      log(`Skip ${it.series}: no cached bg at ${bgPath}`);
      continue;
    }
    const series = SERIES_POOL.find((x) => x.key === it.series)!;
    const outPath = path.join(thumbDir, 'thumbnail.jpg');
    await composeThumbnail(bgPath, it.title, series, it.layout, outPath);
    log(`Recomposed [${it.series}]: ${outPath}`);
  }
}

main().catch((e) => {
  log('Recompose failed:', (e as Error).message);
  process.exit(1);
});
