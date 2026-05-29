import fs from 'node:fs';
import path from 'node:path';
import {
  ASSETS_DIR,
  BROLL_CLIP_SEC,
  BROLL_MIN_HEIGHT,
  FREESOUND_API_KEY,
  PEXELS_API_KEY,
  PIXABAY_API_KEY,
  WORK_DIR,
} from './config.js';
import type { BrollClip } from './types.js';
import {
  downloadFile,
  ensureDir,
  fetchJson,
  ffprobeDuration,
  log,
  pickRandom,
  safeFilename,
  shuffle,
} from './utils.js';

const MUSIC_FALLBACK_DIR = path.join(ASSETS_DIR, 'music_fallback');
// Remembers the last BGM track so back-to-back episodes don't reuse the same
// music. Persisted like the tone/thumb anti-repeat state.
const LAST_BGM_FILE = path.join(WORK_DIR, '.last-bgm');

type PexelsVideo = {
  width: number;
  height: number;
  video_files: Array<{
    link: string;
    width: number;
    height: number;
    file_type: string;
    quality: string;
  }>;
};

type PexelsResp = { videos: PexelsVideo[] };

type PixabayVideo = {
  videos: {
    large?: { url: string; width: number; height: number };
    medium?: { url: string; width: number; height: number };
  };
};

type PixabayResp = { hits: PixabayVideo[] };

type FreesoundResp = {
  results: Array<{
    id: number;
    name: string;
    duration: number;
    previews: { 'preview-hq-mp3': string };
  }>;
};

async function searchPexels(query: string): Promise<string[]> {
  if (!PEXELS_API_KEY) return [];
  const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=15&orientation=landscape`;
  try {
    const data = await fetchJson<PexelsResp>(url, {
      headers: { Authorization: PEXELS_API_KEY },
    });
    const links: string[] = [];
    for (const v of data.videos) {
      const file = v.video_files.find(
        (f) =>
          f.file_type === 'video/mp4' &&
          f.height >= BROLL_MIN_HEIGHT &&
          f.height >= f.width,
      ) || v.video_files.find((f) => f.file_type === 'video/mp4' && f.height >= 720);
      if (file) links.push(file.link);
    }
    return links;
  } catch (e) {
    log(`Pexels search failed: ${(e as Error).message}`);
    return [];
  }
}

async function searchPixabay(query: string): Promise<string[]> {
  if (!PIXABAY_API_KEY) return [];
  const url = `https://pixabay.com/api/videos/?key=${PIXABAY_API_KEY}&q=${encodeURIComponent(query)}&per_page=15&safesearch=true`;
  try {
    const data = await fetchJson<PixabayResp>(url);
    const links: string[] = [];
    for (const v of data.hits) {
      const f = v.videos.large ?? v.videos.medium;
      if (f) links.push(f.url);
    }
    return links;
  } catch (e) {
    log(`Pixabay search failed: ${(e as Error).message}`);
    return [];
  }
}

export async function fetchBroll(
  query: string,
  sectionDuration: number,
  workDir: string,
  usedUrls: Set<string>,
): Promise<BrollClip[]> {
  const cacheDir = ensureDir(path.join(workDir, 'broll'));
  const needed = Math.max(1, Math.ceil(sectionDuration / BROLL_CLIP_SEC));

  const [pexels, pixabay] = await Promise.all([
    searchPexels(query),
    searchPixabay(query),
  ]);
  const pool = shuffle([...pexels, ...pixabay]).filter((u) => !usedUrls.has(u));

  const clips: BrollClip[] = [];
  for (const url of pool) {
    if (clips.length >= needed) break;
    try {
      const name = safeFilename(`${query}_${clips.length}_${Date.now()}.mp4`);
      const dest = path.join(cacheDir, name);
      await downloadFile(url, dest);
      const dur = await ffprobeDuration(dest);
      if (dur < 2) {
        fs.unlinkSync(dest);
        continue;
      }
      usedUrls.add(url);
      clips.push({ path: dest, duration: dur, width: 1920, height: 1080 });
    } catch (e) {
      log(`Broll download failed: ${(e as Error).message}`);
    }
  }

  if (clips.length === 0) {
    throw new Error(`No b-roll for query "${query}" — check Pexels/Pixabay API keys`);
  }
  return clips;
}

async function searchFreesound(
  query: string,
  filter: string,
  sort = 'downloads_desc',
): Promise<FreesoundResp> {
  if (!FREESOUND_API_KEY) throw new Error('FREESOUND_API_KEY missing');
  const params = new URLSearchParams({
    query,
    filter,
    sort,
    fields: 'id,name,duration,previews',
    page_size: '20',
    token: FREESOUND_API_KEY,
  });
  return fetchJson<FreesoundResp>(`https://freesound.org/apiv2/search/text/?${params}`);
}

function listLocalMp3sRecursive(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listLocalMp3sRecursive(full));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.mp3')) {
      out.push(full);
    }
  }
  return out;
}

function pickLocalBgm(queries: string[]): string | null {
  if (!fs.existsSync(MUSIC_FALLBACK_DIR)) return null;
  const tokens = queries
    .flatMap((q) => q.toLowerCase().split(/\s+/))
    .filter((t) => t.length >= 4);
  const all = listLocalMp3sRecursive(MUSIC_FALLBACK_DIR);
  if (all.length === 0) return null;

  const scored = all.map((file) => {
    const hay = path.relative(MUSIC_FALLBACK_DIR, file).toLowerCase();
    const score = tokens.reduce((acc, t) => (hay.includes(t) ? acc + 1 : acc), 0);
    return { file, score };
  });
  const maxScore = scored.reduce((m, s) => Math.max(m, s.score), 0);
  const pool = maxScore > 0 ? scored.filter((s) => s.score === maxScore) : scored;

  // Avoid replaying the previous episode's track. Only fall back to allowing it
  // when the matched pool has nothing else to offer.
  let last: string | null = null;
  try {
    last = fs.readFileSync(LAST_BGM_FILE, 'utf-8').trim();
  } catch {
    // No previous run recorded — use the full matched pool.
  }
  const fresh = pool.filter((s) => s.file !== last);
  const chosen = pickRandom(fresh.length > 0 ? fresh : pool).file;

  try {
    fs.mkdirSync(WORK_DIR, { recursive: true });
    fs.writeFileSync(LAST_BGM_FILE, chosen, 'utf-8');
  } catch {
    // Persistence is best-effort.
  }
  return chosen;
}

export async function fetchBgm(queries: string[], workDir: string): Promise<string> {
  const cacheDir = ensureDir(path.join(workDir, 'audio'));

  const local = pickLocalBgm(queries);
  if (local) {
    const dest = path.join(cacheDir, `bgm_${safeFilename(path.basename(local))}`);
    fs.copyFileSync(local, dest);
    log(`BGM (local Pixabay library): ${path.relative(MUSIC_FALLBACK_DIR, local)}`);
    return dest;
  }

  if (!FREESOUND_API_KEY) {
    throw new Error(
      `No local BGM in ${MUSIC_FALLBACK_DIR} and FREESOUND_API_KEY missing. ` +
        'Run scripts/scrape_pixabay_music.ts to populate the local library.',
    );
  }

  const candidates = shuffle(queries);
  const filters = [
    'duration:[90 TO 600] tag:music avg_rating:[3 TO *]',
    'duration:[60 TO 600] tag:music',
    'duration:[60 TO 600]',
  ];

  for (const query of candidates) {
    for (const filter of filters) {
      const data = await searchFreesound(query, filter, 'downloads_desc');
      if (data.results.length === 0) continue;
      const top = data.results.slice(0, 8);
      const pick = pickRandom(top);
      const dest = path.join(cacheDir, `bgm_${pick.id}.mp3`);
      await downloadFile(pick.previews['preview-hq-mp3'], dest);
      log(`BGM: "${pick.name}" (${pick.duration.toFixed(1)}s) — query "${query}" filter="${filter}"`);
      return dest;
    }
    log(`BGM query "${query}" — no Freesound hits across all filters, trying next`);
  }

  const genericFallbacks = ['ambient music', 'cinematic underscore', 'background music', 'ambient pad'];
  for (const generic of genericFallbacks) {
    const data = await searchFreesound(generic, 'duration:[60 TO 600]', 'downloads_desc');
    if (data.results.length === 0) continue;
    const top = data.results.slice(0, 8);
    const pick = pickRandom(top);
    const dest = path.join(cacheDir, `bgm_${pick.id}.mp3`);
    await downloadFile(pick.previews['preview-hq-mp3'], dest);
    log(`BGM (generic fallback): "${pick.name}" (${pick.duration.toFixed(1)}s) — query "${generic}"`);
    return dest;
  }

  throw new Error(`No Freesound BGM for any query [${queries.join(', ')}] or generic fallbacks`);
}

export async function fetchAmbient(query: string, workDir: string): Promise<string> {
  const cacheDir = ensureDir(path.join(workDir, 'audio'));
  const data = await searchFreesound(query, 'duration:[6 TO 60]');
  if (data.results.length === 0) {
    throw new Error(`No Freesound ambient for query "${query}"`);
  }
  const pick = pickRandom(data.results);
  const dest = path.join(cacheDir, `ambient_${pick.id}.mp3`);
  await downloadFile(pick.previews['preview-hq-mp3'], dest);
  log(`Ambient: "${pick.name}" (${pick.duration.toFixed(1)}s)`);
  return dest;
}
