import path from 'node:path';
import { SERIES_POOL, type ThumbLayout } from '../src/config.js';
import { makeThumbnail } from '../src/thumbnail.js';
import { ensureDir } from '../src/utils.js';

const LAYOUTS: ThumbLayout[] = [
  'q_panel_right',
  'q_corner_dot',
  'q_band_word',
  'q_diag_split',
  'q_giant_overlay',
];

const TITLES = [
  'Illusory Truth: The Mind Glitch That Quietly Built Belief',
  '1960: The Expedition That Found Kentucky\'s Blue People',
  'The Ocean Current That\'s Quietly Dying',
  'A Star That Breaks One Rule Of Physics',
];

async function main(): Promise<void> {
  const outDir = ensureDir(path.join(process.cwd(), 'out', 'thumb_smoketest'));

  for (let i = 0; i < LAYOUTS.length; i++) {
    const layout = LAYOUTS[i]!;
    const title = TITLES[i % TITLES.length]!;
    const series = SERIES_POOL[i % SERIES_POOL.length]!;
    const workDir = ensureDir(path.join(outDir, `${i}_${layout}`));
    const p = await makeThumbnail(title, series, layout, workDir);
    const out = path.join(outDir, `${i}_${layout}_${series.key}.jpg`);
    const fs = await import('node:fs');
    fs.copyFileSync(p, out);
    console.log(`[${i}] ${layout} (${series.key}) → ${out}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
