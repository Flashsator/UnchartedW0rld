import path from 'node:path';
import fs from 'node:fs';
import { SERIES_POOL, type ThumbLayout } from '../src/config.js';
import { makeThumbnail } from '../src/thumbnail.js';
import { ensureDir } from '../src/utils.js';

const TITLE = 'Illusory Truth: The Mind Glitch That Quietly Built Belief';
const SERIES_KEY = 'body';

const LAYOUTS: ThumbLayout[] = [
  'q_panel_right',
  'q_corner_dot',
  'q_band_word',
  'q_diag_split',
  'q_giant_overlay',
];

async function main(): Promise<void> {
  const series = SERIES_POOL.find((s) => s.key === SERIES_KEY);
  if (!series) throw new Error(`series ${SERIES_KEY} not found`);
  const layout = LAYOUTS[Math.floor(Math.random() * LAYOUTS.length)]!;
  const outDir = ensureDir(path.join(process.cwd(), 'out', 'thumb_full'));
  const workDir = ensureDir(path.join(outDir, 'work'));
  const p = await makeThumbnail(TITLE, series, layout, workDir);
  const out = path.join(outDir, `2026-05-29_Illusory_Truth_NEW_${layout}.jpg`);
  fs.copyFileSync(p, out);
  console.log(`layout: ${layout}`);
  console.log(`out: ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
