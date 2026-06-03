import path from 'node:path';
import { SERIES_POOL, type ThumbLayout } from '../src/config.js';
import { makeThumbnail } from '../src/thumbnail.js';
import { setThumbnail } from '../src/youtube.js';
import { ensureDir } from '../src/utils.js';

// One-off: today's long-form (Boquila vine) shipped with a flat gradient cover
// because Pollinations returned 402. Rebuild the cover from an Unsplash photo
// (via makeThumbnail's new fallback) and re-apply it to the live video.
const VIDEO_ID = 'lIH1RCaWu5k';
const TITLE = "Case File: The Chilean Vine That Copies Leaves It Can't See";
const SERIES_KEY = 'nature';
const LAYOUT: ThumbLayout = 'q_diag_split';
// Concept tuned to terms that return strong on-topic Unsplash photos
// (vine climbing a forest tree / mossy bark / green leaves).
const CONCEPT = 'vine climbing a forest tree, lush green leaves, mossy bark, soft misty daylight';
const WORD = 'MIMIC';

async function main(): Promise<void> {
  const series = SERIES_POOL.find((s) => s.key === SERIES_KEY);
  if (!series) throw new Error(`series ${SERIES_KEY} not found`);
  const workDir = ensureDir(path.join(process.cwd(), 'out', 'thumb_replace', VIDEO_ID));
  const thumbPath = await makeThumbnail(TITLE, series, LAYOUT, workDir, CONCEPT, WORD);
  console.log(`thumbnail built: ${thumbPath}`);
  await setThumbnail(VIDEO_ID, thumbPath);
  console.log(`done: replaced thumbnail on ${VIDEO_ID}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
