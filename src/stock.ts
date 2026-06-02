import fs from 'node:fs';
import path from 'node:path';
import {
  ASSETS_DIR,
  BROLL_CLIP_SEC,
  BROLL_MIN_HEIGHT,
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

// Official YouTube Audio Library tracks (manually downloaded from Studio and
// committed). This is the ONLY music source: it is the one library YouTube does
// not Content-ID-claim, so it never costs the channel monetization.
const YT_MUSIC_DIR = path.join(ASSETS_DIR, 'yt_music');
// Tracks that have been Content-ID-claimed on a published video. One relative
// path per line (relative to assets/, forward slashes); '#' comments allowed.
// Listed tracks are never picked again.
const MUSIC_BLACKLIST_FILE = path.join(ASSETS_DIR, 'music_blacklist.txt');
// Remembers the last BGM track so back-to-back episodes don't reuse the same
// music. Persisted like the tone/thumb anti-repeat state.
const LAST_BGM_FILE = path.join(WORK_DIR, '.last-bgm');

// Normalize a track path to an assets-relative key (forward slashes) so it
// matches blacklist entries consistently across OSes.
function musicRelKey(file: string): string {
  return path.relative(ASSETS_DIR, file).split(path.sep).join('/');
}

function loadBlacklist(): Set<string> {
  const out = new Set<string>();
  if (!fs.existsSync(MUSIC_BLACKLIST_FILE)) return out;
  try {
    for (const raw of fs.readFileSync(MUSIC_BLACKLIST_FILE, 'utf-8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      out.add(line.split(path.sep).join('/'));
    }
  } catch (e) {
    log(`Music blacklist read failed: ${(e as Error).message}`);
  }
  return out;
}

// All mp3s under a library root minus anything on the blacklist.
function playableTracksIn(root: string): string[] {
  const blacklist = loadBlacklist();
  return listLocalMp3sRecursive(root).filter((file) => !blacklist.has(musicRelKey(file)));
}

// Eligible tracks: official YouTube Audio Library only, minus the blacklist.
function eligibleTracks(): string[] {
  return playableTracksIn(YT_MUSIC_DIR);
}

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
  const tokens = queries
    .flatMap((q) => q.toLowerCase().split(/\s+/))
    .filter((t) => t.length >= 4);
  const sourcePool = eligibleTracks();
  if (sourcePool.length === 0) return null;

  const scored = sourcePool.map((file) => {
    const hay = musicRelKey(file).toLowerCase();
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

// BGM is drawn only from official YouTube Audio Library tracks committed under
// assets/yt_music/ — the one source YouTube does not Content-ID-claim. Tracks
// listed in assets/music_blacklist.txt (claimed on a prior video) are skipped
// entirely. No online source is fetched at run time.
export async function fetchBgm(queries: string[], workDir: string): Promise<string> {
  const cacheDir = ensureDir(path.join(workDir, 'audio'));

  const local = pickLocalBgm(queries);
  if (local) {
    const dest = path.join(cacheDir, `bgm_${safeFilename(path.basename(local))}`);
    fs.copyFileSync(local, dest);
    log(`BGM: ${musicRelKey(local)}`);
    return dest;
  }

  throw new Error(
    `No usable BGM: add official YouTube Audio Library .mp3 tracks to ` +
      `${YT_MUSIC_DIR} and commit them (see that folder's README).`,
  );
}

// Interlude ambience is decorative. A missing clip must never abort the whole
// run, so fetchAmbient draws only from the committed local royalty-free library
// and returns null when it is empty — the caller then skips that interlude.

// Folder-name keywords marking the most atmospheric beds for interludes. mux
// trims every interlude to INTERLUDE_SEC, so a long music track is fine as a
// bed. Matches both the YouTube Audio Library mood folders (e.g. "Ambient -Calm",
// "Classical-Calm") and the Pixabay tag folders.
const LOCAL_AMBIENT_PREFERRED = ['ambient', 'calm', 'nature'];

function pickLocalAmbient(): string | null {
  // Same source policy as BGM (YouTube Audio Library only, Pixabay behind the
  // escape hatch), then prefer the calmest beds within whatever is eligible.
  const all = eligibleTracks();
  if (all.length === 0) return null;
  const preferred = all.filter((file) =>
    LOCAL_AMBIENT_PREFERRED.some((name) => musicRelKey(file).toLowerCase().includes(name)),
  );
  const pool = preferred.length > 0 ? preferred : all;
  return pickRandom(pool);
}

export async function fetchAmbient(query: string, workDir: string): Promise<string | null> {
  const cacheDir = ensureDir(path.join(workDir, 'audio'));

  const local = pickLocalAmbient();
  if (local) {
    const dest = path.join(cacheDir, `ambient_local_${safeFilename(path.basename(local))}`);
    fs.copyFileSync(local, dest);
    log(`Ambient: ${musicRelKey(local)}`);
    return dest;
  }

  log(`No local ambient available for "${query}" — interlude will be skipped`);
  return null;
}
