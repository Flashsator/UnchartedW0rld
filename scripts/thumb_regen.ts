import path from 'node:path';
import fs from 'node:fs';
import { SERIES_POOL, type ThumbLayout } from '../src/config.js';
import { makeThumbnail } from '../src/thumbnail.js';
import { ensureDir } from '../src/utils.js';

const TITLE = 'Case File: The Vestigial Ear Muscles That Still Listen';
const SERIES_KEY = 'body';

// Explicit, non-abstract concept: a clear human ear with visible sound waves
// flowing into it — instantly reads as "listening". Emphasize a SINGLE,
// anatomically correct ear so flux stops merging/distorting the pinna.
const CONCEPT =
  'profile of a single human head, one anatomically correct realistic human ear in sharp focus, natural ear proportions, faint glowing sound waves approaching the ear from the side, clean studio lighting, side portrait';

const LAYOUTS: ThumbLayout[] = [
  'q_giant_overlay',
  'q_panel_right',
  'q_corner_dot',
  'q_band_word',
  'q_diag_split',
];

async function main(): Promise<void> {
  const series = SERIES_POOL.find((s) => s.key === SERIES_KEY);
  if (!series) throw new Error(`series ${SERIES_KEY} not found`);
  const outDir = ensureDir(path.join(process.cwd(), 'out', 'thumb_regen'));
  for (const layout of LAYOUTS) {
    const workDir = ensureDir(path.join(outDir, `work_${layout}`));
    const p = await makeThumbnail(TITLE, series, layout, workDir, CONCEPT, 'LISTEN');
    const out = path.join(outDir, `vestigial_${layout}.jpg`);
    fs.copyFileSync(p, out);
    console.log(`layout=${layout} -> ${out}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
