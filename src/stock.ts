import fs from 'node:fs';
import path from 'node:path';
import {
  ASSETS_DIR,
  BROLL_CLIP_SEC,
  BROLL_MIN_HEIGHT,
  COVERR_API_KEY,
  PEXELS_API_KEY,
  PIXABAY_API_KEY,
  UNSPLASH_ACCESS_KEY,
  VIDEO_FPS,
  VIDEO_H,
  VIDEO_W,
  WORK_DIR,
} from './config.js';
import type { BrollClip, MusicCredit } from './types.js';
import {
  downloadFile,
  ensureDir,
  fetchJson,
  ffprobeDuration,
  log,
  pickRandom,
  run,
  safeFilename,
  shuffle,
} from './utils.js';

// Official YouTube Audio Library tracks (manually downloaded from Studio and
// committed). This is the ONLY music source: it is the one library YouTube does
// not Content-ID-claim, so it never costs the channel monetization.
const YT_MUSIC_DIR = path.join(ASSETS_DIR, 'yt_music');
// Dedicated nature / white-noise / birdsong / insect beds for interludes ONLY.
// Unlike yt_music these never enter the main-BGM pool (pickLocalBgm), so they can
// decorate segment transitions without ever playing under the whole narration.
// Files here must still be named "Title - Artist.mp3" for attribution, and come
// from a Content-ID-safe source (e.g. the YouTube Audio Library ambience/SFX).
const AMBIENT_DIR = path.join(ASSETS_DIR, 'ambient_nature');
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

// YouTube Audio Library tracks are named "Title - Artist.mp3". Derive the credit
// from the filename so the description's attribution block needs no extra
// metadata. The "_" the library uses in place of "/" (illegal in filenames) is
// restored, e.g. "Doug Maxwell_Media Right Productions" -> ".../...".
export function parseTrackCredit(file: string): MusicCredit {
  const base = path.basename(file).replace(/\.mp3$/i, '');
  const sep = base.lastIndexOf(' - ');
  if (sep === -1) return { title: base.trim(), artist: '' };
  return {
    title: base.slice(0, sep).trim(),
    artist: base.slice(sep + 3).trim().replace(/_/g, '/'),
  };
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

type CoverrVideo = {
  max_width?: number;
  max_height?: number;
  aspect_ratio?: string;
  urls?: {
    mp4?: string;
    mp4_download?: string;
    mp4_preview?: string;
  };
};

type CoverrResp = { hits: CoverrVideo[] };

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

// Coverr is a free, commercial-use cinematic stock-video library. We request
// landscape clips at least BROLL_MIN_HEIGHT tall (Coverr reports max_width/
// max_height per clip) and return their direct mp4 URLs, same contract as the
// Pexels/Pixabay searchers.
async function searchCoverr(query: string): Promise<string[]> {
  if (!COVERR_API_KEY) return [];
  const url =
    `https://api.coverr.co/videos?query=${encodeURIComponent(query)}` +
    `&page_size=15&urls=true&api_key=${COVERR_API_KEY}`;
  try {
    const data = await fetchJson<CoverrResp>(url);
    const links: string[] = [];
    for (const v of data.hits) {
      const link = v.urls?.mp4 ?? v.urls?.mp4_download;
      if (!link) continue;
      // Skip portrait clips and anything below our minimum height when Coverr
      // reports dimensions; accept when it doesn't (most Coverr clips are 1080p+).
      if (v.max_height && v.max_height < BROLL_MIN_HEIGHT) continue;
      if (v.max_width && v.max_height && v.max_height > v.max_width) continue;
      links.push(link);
    }
    return links;
  } catch (e) {
    log(`Coverr search failed: ${(e as Error).message}`);
    return [];
  }
}

type UnsplashPhoto = {
  width?: number;
  height?: number;
  urls?: { full?: string; regular?: string; raw?: string };
};

type UnsplashResp = { results: UnsplashPhoto[] };

// Unsplash gives still photos only, so it is a *fallback* for b-roll: each photo
// is turned into a slow Ken Burns clip (below) and used only when the video
// providers come up short for a section. Landscape-only so it fills 16:9.
// Exported so the thumbnail builder can reuse it as a background-image fallback
// when the generative image provider is unavailable.
export async function searchUnsplash(query: string): Promise<string[]> {
  if (!UNSPLASH_ACCESS_KEY) return [];
  const url =
    `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}` +
    `&per_page=15&orientation=landscape&content_filter=high`;
  try {
    const data = await fetchJson<UnsplashResp>(url, {
      headers: { Authorization: `Client-ID ${UNSPLASH_ACCESS_KEY}` },
    });
    const links: string[] = [];
    for (const p of data.results) {
      const link = p.urls?.full ?? p.urls?.regular ?? p.urls?.raw;
      if (link) links.push(link);
    }
    return links;
  } catch (e) {
    log(`Unsplash search failed: ${(e as Error).message}`);
    return [];
  }
}

// Turns a still photo into a BROLL_CLIP_SEC Ken Burns clip (slow centered
// zoom-in) at the project resolution/fps, so it flows through the same
// OffthreadVideo path as real footage. The large pre-upscale keeps the zoom
// smooth instead of stair-stepping. Returns null if the still can't be rendered.
async function makeKenBurnsClip(
  photoUrl: string,
  query: string,
  cacheDir: string,
  idx: number,
): Promise<BrollClip | null> {
  const stamp = Date.now();
  const imgPath = path.join(cacheDir, safeFilename(`kb_${query}_${idx}_${stamp}.jpg`));
  const dest = path.join(cacheDir, safeFilename(`kb_${query}_${idx}_${stamp}.mp4`));
  const frames = Math.round(BROLL_CLIP_SEC * VIDEO_FPS);
  try {
    await downloadFile(photoUrl, imgPath);
    const vf =
      `scale=4000:-1:flags=lanczos,` +
      `zoompan=z='min(zoom+0.0011,1.16)':d=${frames}` +
      `:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'` +
      `:s=${VIDEO_W}x${VIDEO_H}:fps=${VIDEO_FPS},` +
      `format=yuv420p`;
    await run('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-i', imgPath,
      '-vf', vf,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-pix_fmt', 'yuv420p',
      '-r', String(VIDEO_FPS),
      dest,
    ]);
    const dur = await ffprobeDuration(dest);
    if (!Number.isFinite(dur) || dur < 2) {
      fs.existsSync(dest) && fs.unlinkSync(dest);
      return null;
    }
    return { path: dest, duration: dur, width: VIDEO_W, height: VIDEO_H };
  } catch (e) {
    log(`Ken Burns clip failed: ${(e as Error).message}`);
    return null;
  } finally {
    if (fs.existsSync(imgPath)) {
      try {
        fs.unlinkSync(imgPath);
      } catch {
        // best-effort cleanup of the intermediate still
      }
    }
  }
}

// Monotonic counter so concurrent/repeat queries never collide on a cached
// filename (Date.now() alone can repeat within a millisecond on fast disks).
let brollSeq = 0;

// Fetches up to `count` distinct clips for a single stock query: video providers
// first (Pexels/Pixabay/Coverr), then Unsplash Ken Burns stills to fill any gap.
// Records contributing sources for attribution and dedupes against usedUrls so a
// clip never repeats across beats or sections. Returns however many it found
// (possibly fewer than count, possibly zero for an obscure query).
async function fetchClipsForQuery(
  query: string,
  count: number,
  cacheDir: string,
  usedUrls: Set<string>,
  sourcesUsed?: Set<string>,
): Promise<BrollClip[]> {
  if (count <= 0) return [];

  const [pexels, pixabay, coverr] = await Promise.all([
    searchPexels(query),
    searchPixabay(query),
    searchCoverr(query),
  ]);
  // Tag each candidate with its provider so we can record exactly which
  // libraries actually contributed footage to this video (for attribution).
  const tagged = [
    ...pexels.map((url) => ({ url, source: 'Pexels' })),
    ...pixabay.map((url) => ({ url, source: 'Pixabay' })),
    ...coverr.map((url) => ({ url, source: 'Coverr' })),
  ];
  const pool = shuffle(tagged).filter((c) => !usedUrls.has(c.url));

  const clips: BrollClip[] = [];
  for (const { url, source } of pool) {
    if (clips.length >= count) break;
    try {
      const name = safeFilename(`${query}_${brollSeq++}_${Date.now()}.mp4`);
      const dest = path.join(cacheDir, name);
      await downloadFile(url, dest);
      const dur = await ffprobeDuration(dest);
      if (dur < 2) {
        fs.unlinkSync(dest);
        continue;
      }
      usedUrls.add(url);
      sourcesUsed?.add(source);
      clips.push({ path: dest, duration: dur, width: 1920, height: 1080 });
    } catch (e) {
      log(`Broll download failed: ${(e as Error).message}`);
    }
  }

  // Still short after exhausting the video providers? Fill the remaining slots
  // with Unsplash Ken Burns stills so the section never replays the same clip.
  if (clips.length < count && UNSPLASH_ACCESS_KEY) {
    const photos = shuffle(await searchUnsplash(query)).filter((u) => !usedUrls.has(u));
    for (const photoUrl of photos) {
      if (clips.length >= count) break;
      const clip = await makeKenBurnsClip(photoUrl, query, cacheDir, brollSeq++);
      if (!clip) continue;
      usedUrls.add(photoUrl);
      sourcesUsed?.add('Unsplash');
      clips.push(clip);
      log(`B-roll gap filled with Unsplash Ken Burns still for "${query}"`);
    }
  }

  return clips;
}

// Splits `needed` clips across `beatCount` ordered beats as evenly as possible,
// giving the earlier beats the remainder so narration order is preserved. Pure
// and exported for testing. e.g. allocate(7, 3) -> [3, 2, 2].
export function allocateClipsAcrossBeats(needed: number, beatCount: number): number[] {
  if (beatCount <= 0) return [];
  const base = Math.floor(needed / beatCount);
  const rem = needed % beatCount;
  return Array.from({ length: beatCount }, (_, i) => base + (i < rem ? 1 : 0));
}

export async function fetchBroll(
  query: string,
  sectionDuration: number,
  workDir: string,
  usedUrls: Set<string>,
  sourcesUsed?: Set<string>,
): Promise<BrollClip[]> {
  const cacheDir = ensureDir(path.join(workDir, 'broll'));
  const needed = Math.max(1, Math.ceil(sectionDuration / BROLL_CLIP_SEC));
  const clips = await fetchClipsForQuery(query, needed, cacheDir, usedUrls, sourcesUsed);
  if (clips.length === 0) {
    throw new Error(
      `No b-roll for query "${query}" — check Pexels/Pixabay/Coverr/Unsplash API keys`,
    );
  }
  return clips;
}

// Fetches footage that tracks the narration beat by beat. `beats` is an ordered
// list of stock queries (one per narration moment). The total clip count is
// still sized to the section duration so the cut rhythm matches a single-query
// section, but it is distributed across the beats IN ORDER — so each shot
// depicts what is being said at that point in the narration. Beats whose query
// comes up short are topped up by re-querying the remaining beats in order.
export async function fetchBrollForBeats(
  beats: string[],
  sectionDuration: number,
  workDir: string,
  usedUrls: Set<string>,
  sourcesUsed?: Set<string>,
): Promise<BrollClip[]> {
  const cacheDir = ensureDir(path.join(workDir, 'broll'));
  const queries = beats.map((b) => b.trim()).filter(Boolean);
  if (queries.length === 0) {
    throw new Error('fetchBrollForBeats called with no queries');
  }
  // At least one clip per beat, but never fewer than the duration would need.
  const needed = Math.max(queries.length, Math.ceil(sectionDuration / BROLL_CLIP_SEC));
  const allocation = allocateClipsAcrossBeats(needed, queries.length);

  const clips: BrollClip[] = [];
  for (let i = 0; i < queries.length; i++) {
    const got = await fetchClipsForQuery(
      queries[i]!,
      allocation[i]!,
      cacheDir,
      usedUrls,
      sourcesUsed,
    );
    clips.push(...got);
  }

  // Some beat queries can come up short (obscure scenes). Top back up to the
  // duration-based count by re-querying beats in order, holding the cut pace.
  for (let i = 0; i < queries.length && clips.length < needed; i++) {
    const got = await fetchClipsForQuery(
      queries[i]!,
      needed - clips.length,
      cacheDir,
      usedUrls,
      sourcesUsed,
    );
    clips.push(...got);
  }

  if (clips.length === 0) {
    throw new Error(
      `No b-roll for any beat of [${queries.join(' | ')}] — check stock API keys`,
    );
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
export async function fetchBgm(
  queries: string[],
  workDir: string,
): Promise<{ path: string; credit: MusicCredit }> {
  const cacheDir = ensureDir(path.join(workDir, 'audio'));

  const local = pickLocalBgm(queries);
  if (local) {
    const dest = path.join(cacheDir, `bgm_${safeFilename(path.basename(local))}`);
    fs.copyFileSync(local, dest);
    log(`BGM: ${musicRelKey(local)}`);
    return { path: dest, credit: parseTrackCredit(local) };
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
// bed. Matches the YouTube Audio Library mood folders (e.g. "Ambient-Calm",
// "Classical-Calm").
const LOCAL_AMBIENT_PREFERRED = ['ambient', 'calm', 'nature'];

function pickLocalAmbient(): string | null {
  // Dedicated nature/white-noise beds (interlude-only, never main BGM) plus the
  // calmest YouTube Audio Library beds. Drawing from the union keeps variety so
  // every interlude isn't the same birdsong loop.
  const nature = playableTracksIn(AMBIENT_DIR);
  const all = eligibleTracks();
  const ytPreferred = all.filter((file) =>
    LOCAL_AMBIENT_PREFERRED.some((name) => musicRelKey(file).toLowerCase().includes(name)),
  );
  const pool = [...nature, ...ytPreferred];
  if (pool.length > 0) return pickRandom(pool);
  // No nature beds and no calm YT tracks — fall back to any eligible track.
  return all.length > 0 ? pickRandom(all) : null;
}

export async function fetchAmbient(
  query: string,
  workDir: string,
): Promise<{ path: string; credit: MusicCredit } | null> {
  const cacheDir = ensureDir(path.join(workDir, 'audio'));

  const local = pickLocalAmbient();
  if (local) {
    const dest = path.join(cacheDir, `ambient_local_${safeFilename(path.basename(local))}`);
    fs.copyFileSync(local, dest);
    log(`Ambient: ${musicRelKey(local)}`);
    return { path: dest, credit: parseTrackCredit(local) };
  }

  log(`No local ambient available for "${query}" — interlude will be skipped`);
  return null;
}
