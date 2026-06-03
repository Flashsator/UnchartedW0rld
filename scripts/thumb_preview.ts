// One-off preview: generate a single full thumbnail (FLUX.2 [klein] 9B
// background + composited text card) so the new generator can be eyeballed
// before wiring it into the daily pipeline. Run: npx tsx scripts/thumb_preview.ts
import path from 'node:path';
import { ROOT, SERIES_POOL } from '../src/config.js';
import { makeThumbnail } from '../src/thumbnail.js';
import { ensureDir, log } from '../src/utils.js';

async function main(): Promise<void> {
  const series = SERIES_POOL.find((s) => s.key === 'ocean')!;
  const title = 'Profile: The Creature That Glows Where No Light Reaches';
  const layout = 'q_diag_split' as const;
  const workDir = ensureDir(path.join(ROOT, 'work', 'thumb-preview'));

  const out = await makeThumbnail(title, series, layout, workDir);
  log(`Preview thumbnail written: ${out}`);
}

main().catch((e) => {
  log('Preview failed:', (e as Error).message);
  process.exit(1);
});
