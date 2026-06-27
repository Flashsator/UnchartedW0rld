import fs from 'node:fs';
import path from 'node:path';
import {
  ASSETS_DIR,
  BROLL_CLIP_SEC,
  BROLL_MIN_HEIGHT,
  BROLL_VISION_QA_MAX_CHECKS,
  COVERR_API_KEY,
  ENABLE_BROLL_VISION_QA,
  PEXELS_API_KEY,
  PIXABAY_API_KEY,
  SHORTS_CLIP_SEC,
  UNSPLASH_ACCESS_KEY,
  VIDEO_FPS,
  VIDEO_H,
  VIDEO_W,
  WORK_DIR,
} from './config.js';
import { visionRejectsClip } from './brollVision.js';
import type { BrollClip, ImageCredit, MusicCredit } from './types.js';
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
  url?: string;
  duration?: number;
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
  tags?: string;
  duration?: number;
  videos: {
    large?: { url: string; width: number; height: number };
    medium?: { url: string; width: number; height: number };
  };
};

type PixabayResp = { hits: PixabayVideo[] };

type CoverrVideo = {
  title?: string;
  duration?: number;
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

export type BrollOrientation = 'landscape' | 'portrait';

// Knobs the b-roll fetchers thread down to the provider searchers.
export type BrollFetchOpts = {
  // Portrait mode exists for Shorts-native footage; landscape is the default
  // long-form path.
  orientation?: BrollOrientation;
  // Pixabay search category (e.g. 'animals', 'nature'). Constrains Pixabay's
  // fuzzy matcher to the right corner of its library so a thin query degrades
  // to on-theme footage instead of arbitrary scenery.
  pixabayCategory?: string;
  // The episode subject (anchorVisual's subject noun). When set, each downloaded
  // clip is tagged onSubject by matching its provider metadata against this — the
  // signal the explainer-card decider uses to prove a slot is off-subject.
  subject?: string;
};

// Mutable per-beat vision-QA budget. `checks` counts how many candidates this
// beat has vision-checked (capped at BROLL_VISION_QA_MAX_CHECKS); `passed` flips
// once one clip clears QA, after which the beat's remaining fills are trusted.
// Threaded through a beat's query variants so the cap is a true per-beat ceiling.
type BrollQaBudget = { checks: number; passed: boolean };

// One downloadable search result, normalized across providers.
export type StockCandidate = {
  url: string;
  source: string;
  // Provider-supplied descriptive text for THIS clip (Pixabay tags, the Pexels
  // page slug, a Coverr title) used for relevance checking. Absent when the
  // provider exposes nothing per-clip.
  meta?: string;
  // Provider-reported clip length in seconds, when exposed.
  duration?: number;
  // Height in px of the rendition we'd download, when the provider reports it.
  // Used only to DEMOTE weak-resolution clips to the back of the pool —
  // relevance decides what's in the pool, resolution never excludes a clip.
  height?: number;
};

// The Shorts frame is 9:16 at 1080 wide, so a portrait clip needs ~1920px of
// height to fill it 1:1. 1280 (720x1280) is the lowest accepted fallback —
// still sharper than center-cropping a 1080p landscape clip, which leaves only
// ~607px of usable width.
const PORTRAIT_MIN_HEIGHT = 1920;
const PORTRAIT_FALLBACK_MIN_HEIGHT = 1280;
const LANDSCAPE_FALLBACK_MIN_HEIGHT = 720;

export type StockVideoFile = {
  link: string;
  width: number;
  height: number;
  file_type: string;
};

// Picks which rendition of one clip to download. The orientation must actually
// match (the old code's first-choice condition was inverted — `height >= width`
// selected PORTRAIT files on a landscape search, so the 720p fallback always
// won and every Pexels download was 720p in a 1080p render). Among renditions
// meeting the quality floor the SMALLEST is taken: the render output caps the
// useful resolution, a 4K master only costs download time and CI disk. Below
// the floor, the largest available is the least-bad fallback. A LANDSCAPE clip
// is never rejected on resolution alone — a soft, on-subject clip beats a sharp
// off-subject one, so the lowest tier returns the largest rendition and the
// pool ordering demotes it instead (see orderPoolByPreference). Portrait keeps
// its 1280 hard floor: below that, center-cropping a relevant 1080p landscape
// clip (the guaranteed fallback path) is sharper than the portrait file itself.
// Pure and exported for testing.
export function pickBestVideoFile(
  files: StockVideoFile[],
  orientation: BrollOrientation = 'landscape',
): StockVideoFile | null {
  const fitsOrientation =
    orientation === 'portrait'
      ? (f: StockVideoFile) => f.height > f.width
      : (f: StockVideoFile) => f.width >= f.height;
  const floor = orientation === 'portrait' ? PORTRAIT_MIN_HEIGHT : BROLL_MIN_HEIGHT;
  const fallbackFloor =
    orientation === 'portrait' ? PORTRAIT_FALLBACK_MIN_HEIGHT : LANDSCAPE_FALLBACK_MIN_HEIGHT;
  const oriented = files.filter((f) => f.file_type === 'video/mp4' && fitsOrientation(f));
  const atFloor = oriented.filter((f) => f.height >= floor);
  if (atFloor.length > 0) {
    return atFloor.reduce((best, f) => (f.height < best.height ? f : best));
  }
  const fallback = oriented.filter((f) => f.height >= fallbackFloor);
  if (fallback.length > 0) {
    return fallback.reduce((best, f) => (f.height > best.height ? f : best));
  }
  if (orientation === 'landscape' && oriented.length > 0) {
    return oriented.reduce((best, f) => (f.height > best.height ? f : best));
  }
  return null;
}

// A Pexels video's page URL ends in a human-written slug naming the clip
// (".../video/a-cat-drinking-water-855282/") — the only per-clip description
// the API exposes. Turned into plain words for relevance matching. Pure and
// exported for testing.
export function pexelsSlugText(pageUrl: string | undefined): string | undefined {
  if (!pageUrl) return undefined;
  const m = pageUrl.match(/\/video\/([a-z0-9-]+?)(?:-\d+)?\/?$/i);
  if (!m) return undefined;
  const text = m[1]!.replace(/-/g, ' ').trim();
  // Untitled Pexels videos have numeric-only page URLs (".../video/3045163/").
  // That's NOT descriptive metadata — returning it would make the relevance
  // filter drop a perfectly good candidate for "zero token overlap".
  if (!/[a-z]/i.test(text)) return undefined;
  return text || undefined;
}

// Light singular/plural folding so 'cats' matches 'cat' without an NLP
// dependency; tokens under 3 chars are noise ('in', 'of') and dropped.
function relevanceTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3)
    .map((t) => (t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t));
}

// Whether a downloaded clip can be PROVEN on- or off-subject from its provider
// metadata. Returns `true` when a subject token appears in the clip's metadata,
// `false` when the metadata exists but names none of the subject tokens (proven
// off-subject), and `undefined` when there's nothing to judge on (no metadata or
// no subject) — absence of evidence, left alone by the card decider. Reuses the
// same tokenizer as the relevance filter so the two paths agree. Pure and
// exported for testing.
export function isClipOnSubject(
  meta: string | undefined,
  subject: string | undefined,
): boolean | undefined {
  if (!meta || !subject) return undefined;
  const subjectTokens = relevanceTokens(subject);
  if (subjectTokens.length === 0) return undefined;
  const metaTokens = new Set(relevanceTokens(meta));
  return subjectTokens.some((t) => metaTokens.has(t));
}

// Drops candidates whose own metadata provably mismatches the query, and floats
// subject matches to the front. Providers fuzzy-match a thin query into
// whatever they have (the narration/visual drift viewers notice), and per-clip
// metadata is the only signal that exposes it: a candidate WITH metadata
// sharing zero tokens with the query is dropped; candidates without metadata
// are kept — absence of evidence isn't a mismatch. Candidates whose metadata
// names the query's LEADING token (the subject noun, per anchorVisual) move
// ahead of the rest; original order is otherwise preserved. Pure and exported
// for testing.
export function filterAndRankByRelevance(
  candidates: StockCandidate[],
  query: string,
): StockCandidate[] {
  const queryTokens = relevanceTokens(query);
  if (queryTokens.length === 0) return candidates;
  const subject = queryTokens[0]!;
  const kept = candidates
    .map((c) => {
      if (!c.meta) return { c, overlap: -1, hasSubject: false };
      const metaTokens = new Set(relevanceTokens(c.meta));
      const overlap = queryTokens.reduce((a, t) => a + (metaTokens.has(t) ? 1 : 0), 0);
      return { c, overlap, hasSubject: metaTokens.has(subject) };
    })
    .filter((s) => s.overlap !== 0);
  return [
    ...kept.filter((s) => s.hasSubject).map((s) => s.c),
    ...kept.filter((s) => !s.hasSubject).map((s) => s.c),
  ];
}

// Round-robin merge that preserves each provider's own result order — their
// ranking IS relevance signal. (The old full-pool shuffle made a provider's
// 15th-best result as likely to download first as anyone's best match.) Pure
// and exported for testing.
export function interleaveRoundRobin<T>(groups: T[][]): T[] {
  const out: T[] = [];
  const longest = groups.reduce((m, g) => Math.max(m, g.length), 0);
  for (let i = 0; i < longest; i++) {
    for (const g of groups) {
      const item = g[i];
      if (item !== undefined) out.push(item);
    }
  }
  return out;
}

// Pixabay categories matching the channel's three series. No 'insects'
// category exists — 'animals' is the closest superset. Unknown keys return
// undefined (no category constraint). Pure and exported for testing.
const PIXABAY_SERIES_CATEGORY: Record<string, string> = {
  animals: 'animals',
  insects: 'animals',
  plants: 'nature',
};

export function pixabayCategoryForSeries(seriesKey: string): string | undefined {
  return PIXABAY_SERIES_CATEGORY[seriesKey];
}

async function searchPexels(
  query: string,
  orientation: BrollOrientation = 'landscape',
): Promise<StockCandidate[]> {
  if (!PEXELS_API_KEY) return [];
  const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=15&orientation=${orientation}`;
  try {
    const data = await fetchJson<PexelsResp>(url, {
      headers: { Authorization: PEXELS_API_KEY },
    });
    const out: StockCandidate[] = [];
    for (const v of data.videos) {
      const file = pickBestVideoFile(v.video_files, orientation);
      if (!file) continue;
      out.push({
        url: file.link,
        source: 'Pexels',
        meta: pexelsSlugText(v.url),
        duration: v.duration,
        height: file.height,
      });
    }
    return out;
  } catch (e) {
    log(`Pexels search failed: ${(e as Error).message}`);
    return [];
  }
}

async function searchPixabay(
  query: string,
  orientation: BrollOrientation = 'landscape',
  category?: string,
): Promise<StockCandidate[]> {
  if (!PIXABAY_API_KEY) return [];
  // video_type=film keeps out animations/motion-graphics renders, which read
  // as off-brand filler between real wildlife footage.
  const url =
    `https://pixabay.com/api/videos/?key=${PIXABAY_API_KEY}&q=${encodeURIComponent(query)}` +
    `&per_page=15&safesearch=true&video_type=film` +
    (category ? `&category=${encodeURIComponent(category)}` : '');
  try {
    const data = await fetchJson<PixabayResp>(url);
    const out: StockCandidate[] = [];
    for (const v of data.hits) {
      const f = v.videos.large ?? v.videos.medium;
      if (!f) continue;
      // Pixabay has no orientation parameter, so orientation is enforced from
      // the rendition's own reported dimensions instead.
      if (orientation === 'portrait') {
        if (!(f.height > f.width && f.height >= PORTRAIT_FALLBACK_MIN_HEIGHT)) continue;
      } else if (f.height > f.width) {
        continue;
      }
      out.push({
        url: f.url,
        source: 'Pixabay',
        meta: v.tags,
        duration: v.duration,
        height: f.height,
      });
    }
    return out;
  } catch (e) {
    log(`Pixabay search failed: ${(e as Error).message}`);
    return [];
  }
}

// Coverr is a free, commercial-use cinematic stock-video library. We request
// landscape clips at least BROLL_MIN_HEIGHT tall (Coverr reports max_width/
// max_height per clip) and return their direct mp4 URLs, same contract as the
// Pexels/Pixabay searchers. Coverr's catalog is essentially all landscape, so
// portrait searches skip it entirely.
async function searchCoverr(
  query: string,
  orientation: BrollOrientation = 'landscape',
): Promise<StockCandidate[]> {
  if (!COVERR_API_KEY || orientation === 'portrait') return [];
  const url =
    `https://api.coverr.co/videos?query=${encodeURIComponent(query)}` +
    `&page_size=15&urls=true&api_key=${COVERR_API_KEY}`;
  try {
    const data = await fetchJson<CoverrResp>(url);
    const out: StockCandidate[] = [];
    for (const v of data.hits) {
      const link = v.urls?.mp4 ?? v.urls?.mp4_download;
      if (!link) continue;
      // Skip portrait clips when Coverr reports dimensions (the catalog is
      // essentially all landscape anyway). Low resolution does NOT exclude a
      // clip — the pool ordering demotes it instead, so a relevant soft clip
      // still beats an off-subject sharp one.
      if (v.max_width && v.max_height && v.max_height > v.max_width) continue;
      out.push({
        url: link,
        source: 'Coverr',
        meta: v.title,
        duration: v.duration,
        height: v.max_height,
      });
    }
    return out;
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

type CommonsImageInfo = {
  url?: string;
  descriptionurl?: string;
  mime?: string;
  width?: number;
  height?: number;
  extmetadata?: Record<string, { value?: string } | undefined>;
};

type CommonsPage = { title?: string; imageinfo?: CommonsImageInfo[] };

type CommonsResp = { query?: { pages?: Record<string, CommonsPage> } };

// Wikimedia asks API clients to identify themselves with a descriptive,
// contactable User-Agent; an anonymous default risks being throttled or blocked.
const COMMONS_UA =
  'WildAnomaliesBot/1.0 (autonomous science channel; contact via YouTube @WildAnomalies)';

// Strips HTML tags and the few common entities out of a Commons extmetadata
// value (the "Artist" field is usually an <a>/<span> blob) down to a clean
// single-line credit. Pure and exported for testing.
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// CC BY-SA's share-alike clause could force the whole video to be licensed
// CC BY-SA, which is a problem for a monetized channel, so the gap-fill accepts
// only permissive licenses: CC0, public domain, and plain CC BY (never -SA, -NC,
// or -ND, and not copyleft like GFDL/FAL). An image whose license can't be
// confirmed permissive is dropped — we'd rather fall through to Unsplash than
// embed an unclear or share-alike license. Pure and exported for testing.
export function isPermissiveLicense(license: string): boolean {
  const l = license.toLowerCase();
  if (!l) return false;
  if (l.includes('cc0') || l.includes('public domain') || l.includes('pdm') || l === 'pd') {
    return true;
  }
  // Plain CC BY only — any share-alike / non-commercial / no-derivatives is out.
  return l.includes('cc by') && !l.includes('sa') && !l.includes('nc') && !l.includes('nd');
}

// Parses a Commons generator=search + imageinfo response into usable landscape
// photo URLs, each paired with its CC attribution. Pure and exported for
// testing. Keeps only JPEG/PNG raster photos at least `minHeight` tall and at
// least as wide as tall (so the Ken Burns crop fills 16:9 without gutting the
// image — portraits and tiny thumbnails are dropped) AND carrying a permissive
// license (isPermissiveLicense).
export function parseCommonsResults(
  resp: CommonsResp,
  minHeight: number,
): Array<{ url: string; credit: ImageCredit }> {
  const pages = resp.query?.pages;
  if (!pages) return [];
  const out: Array<{ url: string; credit: ImageCredit }> = [];
  for (const page of Object.values(pages)) {
    const info = page.imageinfo?.[0];
    if (!info?.url) continue;
    const mime = info.mime ?? '';
    if (mime !== 'image/jpeg' && mime !== 'image/png') continue;
    const w = info.width ?? 0;
    const h = info.height ?? 0;
    if (h < minHeight || w < h) continue;
    const meta = info.extmetadata ?? {};
    const license = stripHtml(meta.LicenseShortName?.value ?? '');
    if (!isPermissiveLicense(license)) continue;
    const author = stripHtml(meta.Artist?.value ?? '').slice(0, 80) || 'Unknown author';
    const title = (page.title ?? '')
      .replace(/^File:/i, '')
      .replace(/\.[a-z0-9]+$/i, '')
      .trim();
    out.push({
      url: info.url,
      credit: {
        title: title || 'Wikimedia Commons image',
        author,
        license,
        url: info.descriptionurl ?? '',
      },
    });
  }
  return out;
}

// Wikimedia Commons is keyless and title-matches the actual species name, so it
// is the b-roll gap-fill of last resort that still returns a REAL photo of an
// obscure subject — where the video providers (and Unsplash) only fuzzy-match a
// no-result query into generic unrelated scenery. Each photo carries its own
// CC author/license credit for the description's attribution block.
async function searchCommons(query: string): Promise<Array<{ url: string; credit: ImageCredit }>> {
  const url =
    `https://commons.wikimedia.org/w/api.php?action=query&format=json` +
    `&generator=search&gsrsearch=${encodeURIComponent(query)}` +
    `&gsrnamespace=6&gsrlimit=15&prop=imageinfo&iiprop=url%7Cmime%7Csize%7Cextmetadata`;
  try {
    const data = await fetchJson<CommonsResp>(url, {
      headers: { 'User-Agent': COMMONS_UA },
    });
    return parseCommonsResults(data, BROLL_MIN_HEIGHT);
  } catch (e) {
    log(`Commons search failed: ${(e as Error).message}`);
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
    // Commons/Unsplash stills are fetched by title/keyword match to the actual
    // subject, so they are on-subject by construction — never a card candidate.
    return { path: dest, duration: dur, width: VIDEO_W, height: VIDEO_H, onSubject: true };
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

// Fetch a STILL image for a "rest beat" slot (long-form anti-fatigue): prefer an
// on-subject Unsplash photo (the same kind of subject-matched still the b-roll
// gap-fill already trusts), else freeze a midpoint frame of the already-chosen,
// already-vetted clip so the rest beat is guaranteed on-subject. Returns the
// absolute image path, or null if nothing could be produced. Best-effort: any
// failure returns null so the caller keeps the moving clip — zero regression.
export async function fetchRestStill(
  clip: BrollClip,
  subject: string | undefined,
  cacheDir: string,
  usedUrls: Set<string>,
  sourcesUsed?: Set<string>,
): Promise<string | null> {
  const subj = subject?.trim();
  if (subj && UNSPLASH_ACCESS_KEY) {
    try {
      const photos = shuffle(await searchUnsplash(subj)).filter((u) => !usedUrls.has(u));
      const photoUrl = photos[0];
      if (photoUrl) {
        const dest = path.join(cacheDir, safeFilename(`rest_${subj}_${brollSeq++}_${Date.now()}.jpg`));
        await downloadFile(photoUrl, dest);
        usedUrls.add(photoUrl);
        sourcesUsed?.add('Unsplash');
        log(`Rest still: Unsplash photo for "${subj}"`);
        return dest;
      }
    } catch (e) {
      log(`Rest still Unsplash failed: ${(e as Error).message}`);
    }
  }
  try {
    const dest = path.join(cacheDir, safeFilename(`rest_freeze_${brollSeq++}_${Date.now()}.jpg`));
    const mid = Number.isFinite(clip.duration) && clip.duration > 0 ? clip.duration / 2 : 0;
    await run('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-ss', mid.toFixed(2),
      '-i', clip.path,
      '-frames:v', '1',
      '-q:v', '2',
      dest,
    ]);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
      log('Rest still: freeze-frame of chosen clip');
      return dest;
    }
    return null;
  } catch (e) {
    log(`Rest still freeze-frame failed: ${(e as Error).message}`);
    return null;
  }
}

// Floor on how far a beat query may be broadened. The subject noun leads every
// anchored beat query (see anchorVisual in scriptGen), so keeping at least this
// many leading words always retains the subject — a missed specific shot
// degrades to a broader shot of the SAME subject, never to generic/unrelated
// footage.
const MIN_QUERY_WORDS = 2;

// Progressive relaxations of a beat query, most specific first: the full query,
// then the same query with its trailing modifier word dropped, and so on, never
// shorter than MIN_QUERY_WORDS. Pure and exported for testing. e.g.
// relaxedQueryVariants('giant cave spider hunting in the dark') ->
//   ['giant cave spider hunting in the dark', '...in the', '...in', '...hunting', 'giant cave spider', 'giant cave'].
// Because the subject leads the query, every variant still shows the subject, so
// when an exact narration shot can't be found the footage stays on-topic rather
// than drifting to something unrelated.
export function relaxedQueryVariants(query: string): string[] {
  const words = query.split(/\s+/).filter(Boolean);
  if (words.length <= MIN_QUERY_WORDS) {
    const joined = words.join(' ');
    return joined ? [joined] : [];
  }
  const variants: string[] = [];
  for (let end = words.length; end >= MIN_QUERY_WORDS; end--) {
    variants.push(words.slice(0, end).join(' '));
  }
  return variants;
}

// Reorders a relevance-ranked candidate pool so technically weak clips (too
// short to fill a cut slot, or below the 720p landscape floor) sit at the BACK
// rather than being excluded: subject relevance decides membership, technical
// quality only decides order. Relative order within each tier is preserved, so
// the relevance ranking survives the reshuffle. Pure and exported for testing.
export function orderPoolByPreference(candidates: StockCandidate[]): StockCandidate[] {
  const isWeak = (c: StockCandidate) =>
    (c.duration !== undefined && c.duration < BROLL_CLIP_SEC) ||
    (c.height !== undefined && c.height < LANDSCAPE_FALLBACK_MIN_HEIGHT);
  return [...candidates.filter((c) => !isWeak(c)), ...candidates.filter(isWeak)];
}

// Downloads up to `remaining` distinct video clips for ONE concrete query string
// (no relaxation here) from the three video providers, deduping against usedUrls.
// `qaState` carries the vision-QA budget for ONE beat across its relaxed-query
// variants, so the cap is a true per-beat ceiling rather than resetting each
// time the query broadens (see fetchClipsForQuery).
async function downloadVideoClips(
  query: string,
  remaining: number,
  cacheDir: string,
  usedUrls: Set<string>,
  sourcesUsed: Set<string> | undefined,
  clips: BrollClip[],
  opts: BrollFetchOpts = {},
  qaState: BrollQaBudget = { checks: 0, passed: false },
): Promise<void> {
  if (remaining <= 0) return;
  const orientation = opts.orientation ?? 'landscape';
  const [pexels, pixabay, coverr] = await Promise.all([
    searchPexels(query, orientation),
    searchPixabay(query, orientation, opts.pixabayCategory),
    searchCoverr(query, orientation),
  ]);
  // Per provider: drop candidates whose own metadata mismatches the query and
  // keep each provider's relevance ranking; then round-robin across providers
  // (in a shuffled provider order so no single library always leads).
  // Candidates the provider reports as shorter than one cut slot go to the
  // back of the line — usable, but only after every full-length option.
  const groups = shuffle(
    [pexels, pixabay, coverr].map((g) => filterAndRankByRelevance(g, query)),
  );
  const merged = interleaveRoundRobin(groups).filter((c) => !usedUrls.has(c.url));
  const pool = orderPoolByPreference(merged);
  let added = 0;
  // Vision QA verifies this beat's PRIMARY shot actually depicts the query —
  // metadata can be thin or wrong, so a clip can pass the text filter yet show
  // the wrong thing. Once one clip passes we trust the rest of this beat's fills,
  // and the check count is capped PER BEAT (qaState is shared across the beat's
  // query variants) so a hard-to-match beat is never starved into stills by a
  // picky model. Long-form (landscape) only; Shorts center-crop the already-
  // verified long clips. Best-effort: when disabled or on any infra error
  // visionRejectsClip returns false, so the loop behaves exactly as before.
  const qaEligible = ENABLE_BROLL_VISION_QA && orientation === 'landscape';
  for (const cand of pool) {
    if (added >= remaining) break;
    const { url, source } = cand;
    try {
      const name = safeFilename(`${query}_${brollSeq++}_${Date.now()}.mp4`);
      const dest = path.join(cacheDir, name);
      await downloadFile(url, dest);
      const dur = await ffprobeDuration(dest);
      if (dur < 2) {
        fs.unlinkSync(dest);
        continue;
      }
      if (qaEligible && !qaState.passed && qaState.checks < BROLL_VISION_QA_MAX_CHECKS) {
        qaState.checks++;
        if (await visionRejectsClip(dest, dur, query)) {
          fs.unlinkSync(dest);
          usedUrls.add(url); // proven off-subject — don't re-pick it elsewhere
          continue;
        }
        qaState.passed = true;
      }
      usedUrls.add(url);
      sourcesUsed?.add(source);
      clips.push({
        path: dest,
        duration: dur,
        width: orientation === 'portrait' ? 1080 : 1920,
        height: orientation === 'portrait' ? 1920 : 1080,
        meta: cand.meta,
        onSubject: isClipOnSubject(cand.meta, opts.subject),
      });
      added++;
    } catch (e) {
      log(`Broll download failed: ${(e as Error).message}`);
    }
  }
}

// Fetches up to `count` distinct clips for a single stock query: video providers
// first (Pexels/Pixabay/Coverr), then Unsplash Ken Burns stills to fill any gap.
// Both passes try the most specific query first and only broaden it toward the
// subject (relaxedQueryVariants) as far as needed to fill the section, so the
// footage tracks the narration as closely as the stock libraries allow. Records
// contributing sources for attribution and dedupes against usedUrls so a clip
// never repeats across beats or sections. Returns however many it found
// (possibly fewer than count, possibly zero for an obscure subject).
async function fetchClipsForQuery(
  query: string,
  count: number,
  cacheDir: string,
  usedUrls: Set<string>,
  sourcesUsed?: Set<string>,
  commonsCredits?: ImageCredit[],
  opts: BrollFetchOpts = {},
): Promise<BrollClip[]> {
  if (count <= 0) return [];

  const variants = relaxedQueryVariants(query);
  const clips: BrollClip[] = [];
  // One vision-QA budget for this beat, shared across its query variants so the
  // cap is per-beat (not reset every time the query broadens).
  const qaState: BrollQaBudget = { checks: 0, passed: false };

  // Video providers, most specific variant first. Stop broadening the moment the
  // section's quota is met so common subjects never widen past the exact shot.
  for (const variant of variants) {
    if (clips.length >= count) break;
    await downloadVideoClips(
      variant,
      count - clips.length,
      cacheDir,
      usedUrls,
      sourcesUsed,
      clips,
      opts,
      qaState,
    );
  }

  // The still-photo gap-fills below render Ken Burns clips at the 16:9 project
  // resolution, which would defeat the point of a portrait fetch — portrait
  // callers have the long section's landscape clips as their fallback instead.
  if (opts.orientation === 'portrait') return clips;

  // Still short after the video providers? Fill the remaining slots with Ken
  // Burns stills. Wikimedia Commons goes FIRST because it title-matches the
  // actual species: for an OBSCURE subject — where the video providers and
  // Unsplash both just fuzzy-match a no-result query into generic unrelated
  // scenery — Commons returns a real photo of the thing being narrated. This is
  // the safety net that keeps the footage on-subject instead of drifting to
  // random landscapes. For common subjects the video providers already met the
  // quota, so this never runs. Each used photo records its CC credit.
  if (clips.length < count) {
    for (const variant of variants) {
      if (clips.length >= count) break;
      const found = shuffle(await searchCommons(variant)).filter((c) => !usedUrls.has(c.url));
      for (const { url, credit } of found) {
        if (clips.length >= count) break;
        const clip = await makeKenBurnsClip(url, variant, cacheDir, brollSeq++);
        if (!clip) continue;
        usedUrls.add(url);
        commonsCredits?.push(credit);
        clips.push(clip);
        log(`B-roll gap filled with Wikimedia Commons still for "${variant}" (${credit.license})`);
      }
    }
  }

  // Unsplash is the final aesthetic filler when Commons also came up short, again
  // most specific first, so the section never replays a clip and still shows the
  // subject.
  if (clips.length < count && UNSPLASH_ACCESS_KEY) {
    for (const variant of variants) {
      if (clips.length >= count) break;
      const photos = shuffle(await searchUnsplash(variant)).filter((u) => !usedUrls.has(u));
      for (const photoUrl of photos) {
        if (clips.length >= count) break;
        const clip = await makeKenBurnsClip(photoUrl, variant, cacheDir, brollSeq++);
        if (!clip) continue;
        usedUrls.add(photoUrl);
        sourcesUsed?.add('Unsplash');
        clips.push(clip);
        log(`B-roll gap filled with Unsplash Ken Burns still for "${variant}"`);
      }
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
  commonsCredits?: ImageCredit[],
  opts: BrollFetchOpts = {},
): Promise<BrollClip[]> {
  const cacheDir = ensureDir(path.join(workDir, 'broll'));
  const needed = Math.max(1, Math.ceil(sectionDuration / BROLL_CLIP_SEC));
  const clips = await fetchClipsForQuery(
    query,
    needed,
    cacheDir,
    usedUrls,
    sourcesUsed,
    commonsCredits,
    opts,
  );
  if (clips.length === 0) {
    throw new Error(
      `No b-roll for query "${query}" — check Pexels/Pixabay/Coverr/Unsplash API keys`,
    );
  }
  return clips;
}

// --- Hero-reuse shot assembly ------------------------------------------------
// One beat = one narration moment. A beat used to be filled with up to N *random*
// downloaded clips, so a single moment could flash a dozen different individuals
// of the subject (the "red spider suddenly becomes a green spider" glitch).
// Instead a beat now downloads AT MOST MAX_DISTINCT_CLIPS_PER_BEAT distinct clips
// and fills any remaining slots with DIFFERENT time windows of the beat's first
// ("hero") clip — the renderer's per-slot kenBurnsFor(clipIdx) varies the camera,
// so a reused segment reads as "another shot of the same individual". Allowing a
// couple of distinct clips per beat (not exactly one) gives the eye a little
// honest variety while still capping how many different individuals one moment
// can show.
const MAX_DISTINCT_CLIPS_PER_BEAT = 2;

// Expands a per-beat slot count into an ordered list of shots. Shot 0 of a beat
// is the hero itself; reuseOrdinal ≥1 marks a reused segment of that hero.
// Narration order is preserved (beats in order, slots in order). Pure and
// exported for testing. e.g. planSectionShots([2,1]) ->
// [{0,0},{0,1},{1,0}].
export function planSectionShots(slotsPerBeat: number[]): Array<{ beatIndex: number; reuseOrdinal: number }> {
  const shots: Array<{ beatIndex: number; reuseOrdinal: number }> = [];
  for (let b = 0; b < slotsPerBeat.length; b++) {
    const n = Math.max(0, Math.floor(slotsPerBeat[b] ?? 0));
    for (let r = 0; r < n; r++) shots.push({ beatIndex: b, reuseOrdinal: r });
  }
  return shots;
}

// The ffmpeg [ss, ss+t] window for the `ordinal`-th reused segment of a hero
// clip. Returns null when there is nothing to cut (ordinal 0, or the hero is no
// longer than one shot — reuse the whole hero in that case). The window always
// extends to the clip's end, so t ≥ perShotSec and the renderer never freezes on
// a too-short segment. Pure and exported for testing.
export function segmentWindow(ordinal: number, perShotSec: number, clipDurationSec: number): { ss: number; t: number } | null {
  if (ordinal <= 0) return null;
  if (!Number.isFinite(perShotSec) || !Number.isFinite(clipDurationSec)) return null;
  if (perShotSec <= 0 || clipDurationSec <= 0) return null;
  if (clipDurationSec <= perShotSec) return null;     // too short → reuse whole hero
  const maxStart = clipDurationSec - perShotSec;
  const ss = Math.min(ordinal * perShotSec, maxStart);
  const t = clipDurationSec - ss;                     // extend to clip end; t ≥ perShot, never freezes
  return { ss, t };
}

// Decides what a beat's `reuseOrdinal`-th shot is, given how many DISTINCT clips
// were actually downloaded for that beat. The first `distinctCount` ordinals map
// straight to those distinct clips; any ordinal beyond them is a time-window
// segment of the beat's first ("hero") clip, with the segment ordinal restarted
// at 1 — so the first reused segment starts at ss = perShot exactly as it did
// when only one clip was downloaded. Pure and exported for testing.
export function shotSource(
  reuseOrdinal: number,
  distinctCount: number,
): { kind: 'clip'; index: number } | { kind: 'segment'; ordinal: number } {
  if (reuseOrdinal < distinctCount) return { kind: 'clip', index: reuseOrdinal };
  return { kind: 'segment', ordinal: reuseOrdinal - distinctCount + 1 };
}

// Cuts the [ss, ss+t] window of a hero clip into a new file. The segment is the
// same individual and framing, so it inherits the hero's dimensions, metadata,
// and on-subject verdict. Best-effort: returns null on any ffmpeg/ffprobe
// failure or a sub-1s result so the caller falls back to reusing the whole hero.
async function cutClipSegment(
  hero: BrollClip,
  ss: number,
  t: number,
  cacheDir: string,
): Promise<BrollClip | null> {
  const dest = path.join(cacheDir, safeFilename(`seg_${brollSeq++}_${Date.now()}.mp4`));
  try {
    await run('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-ss', ss.toFixed(2),
      '-i', hero.path,
      '-t', t.toFixed(2),
      '-an',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-pix_fmt', 'yuv420p',
      dest,
    ]);
    const dur = await ffprobeDuration(dest);
    if (!Number.isFinite(dur) || dur < 1) {
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
      return null;
    }
    return {
      path: dest,
      duration: dur,
      width: hero.width,
      height: hero.height,
      meta: hero.meta,
      onSubject: hero.onSubject,
    };
  } catch (e) {
    log(`Clip segment cut failed: ${(e as Error).message}`);
    if (fs.existsSync(dest)) {
      try { fs.unlinkSync(dest); } catch { /* best-effort cleanup */ }
    }
    return null;
  }
}

// The clips for beat `i`: its own downloaded list if non-empty, else the nearest
// neighbor's list (searched outward) so a beat whose query came up empty still
// reuses an on-section individual instead of dropping the slot. Empty only when
// no beat in the section found anything.
function clipsForBeat(clipLists: readonly BrollClip[][], i: number): BrollClip[] {
  if (clipLists[i]?.length) return clipLists[i]!;
  for (let d = 1; d < clipLists.length; d++) {
    if (clipLists[i - d]?.length) return clipLists[i - d]!;
    if (clipLists[i + d]?.length) return clipLists[i + d]!;
  }
  return [];
}

// Builds `needed` shots across the ordered `queries`. Each beat downloads at most
// MAX_DISTINCT_CLIPS_PER_BEAT distinct clips (capped at its own slot count) and
// fills any remaining slots with distinct segments of its first ("hero") clip
// (see the hero-reuse note above), so a section shows at most a couple of
// individuals per beat instead of a dozen. perShot is the section's
// seconds-per-shot, used to size each reused segment window.
async function assembleHeroReuseShots(
  queries: string[],
  needed: number,
  perShot: number,
  cacheDir: string,
  usedUrls: Set<string>,
  sourcesUsed: Set<string> | undefined,
  commonsCredits: ImageCredit[] | undefined,
  opts: BrollFetchOpts,
): Promise<BrollClip[]> {
  const allocation = allocateClipsAcrossBeats(needed, queries.length);

  // Up to MAX_DISTINCT_CLIPS_PER_BEAT distinct downloads per beat that owns ≥1
  // slot (never more than the beat's slot count). clipLists[i] is empty when beat
  // i got no slot or its query found nothing.
  const clipLists: BrollClip[][] = [];
  for (let i = 0; i < queries.length; i++) {
    const slots = allocation[i]!;
    if (slots <= 0) {
      clipLists.push([]);
      continue;
    }
    const got = await fetchClipsForQuery(
      queries[i]!,
      Math.min(MAX_DISTINCT_CLIPS_PER_BEAT, slots),
      cacheDir,
      usedUrls,
      sourcesUsed,
      commonsCredits,
      opts,
    );
    clipLists.push(got);
  }

  // Realize each planned shot: the first few ordinals map to the beat's distinct
  // downloaded clips, anything beyond them is a distinct time-window cut of the
  // beat's first ("hero") clip (see shotSource).
  const shots: BrollClip[] = [];
  for (const { beatIndex, reuseOrdinal } of planSectionShots(allocation)) {
    const clips = clipsForBeat(clipLists, beatIndex);
    if (clips.length === 0) continue;
    const src = shotSource(reuseOrdinal, clips.length);
    if (src.kind === 'clip') {
      shots.push(clips[src.index]!);
      continue;
    }
    const hero = clips[0]!;
    const win = segmentWindow(src.ordinal, perShot, hero.duration);
    const seg = win ? await cutClipSegment(hero, win.ss, win.t, cacheDir) : null;
    // No distinct segment could be cut (hero too short to subdivide, or the cut
    // failed) — DROP this extra slot rather than push the hero's frame-0 footage
    // a second time, which would show two identical opening shots back to back.
    // The distinct clips are always kept, and computeCutTimes re-spreads the
    // section over the returned clip count, so a shorter list stays consistent.
    if (!seg) continue;
    shots.push(seg);
  }
  return shots;
}

// Fetches footage that tracks the narration beat by beat. `beats` is an ordered
// list of stock queries (one per narration moment). The total clip count is
// still sized to the section duration so the cut rhythm matches a single-query
// section, and it is distributed across the beats IN ORDER — so each shot
// depicts what is being said at that point in the narration. Each beat downloads
// at most MAX_DISTINCT_CLIPS_PER_BEAT distinct clips and fills any remaining
// slots with distinct segments of its first clip (assembleHeroReuseShots), so a
// section never flashes a dozen different individuals of the subject.
export async function fetchBrollForBeats(
  beats: string[],
  sectionDuration: number,
  workDir: string,
  usedUrls: Set<string>,
  sourcesUsed?: Set<string>,
  commonsCredits?: ImageCredit[],
  opts: BrollFetchOpts = {},
  // Seconds-per-shot for this section (defaults to BROLL_CLIP_SEC). The narrative
  // arc passes a smaller value for montage-paced sections and a larger one for
  // calm ones, so the cut cadence varies across the episode instead of holding a
  // flat metronome (see sectionClipSeconds in cuts.ts).
  clipSec: number = BROLL_CLIP_SEC,
): Promise<BrollClip[]> {
  const cacheDir = ensureDir(path.join(workDir, 'broll'));
  const queries = beats.map((b) => b.trim()).filter(Boolean);
  if (queries.length === 0) {
    throw new Error('fetchBrollForBeats called with no queries');
  }
  // At least one clip per beat, but never fewer than the pace-adjusted duration.
  const perShot = clipSec > 0 ? clipSec : BROLL_CLIP_SEC;
  const needed = Math.max(queries.length, Math.ceil(sectionDuration / perShot));
  const clips = await assembleHeroReuseShots(
    queries,
    needed,
    perShot,
    cacheDir,
    usedUrls,
    sourcesUsed,
    commonsCredits,
    opts,
  );

  // An empty result is NOT thrown: a section whose every beat came up empty
  // across providers → Commons → Unsplash is a genuinely unfilmable subject
  // (invariant #3, which the topic-demand gate blocks upstream). The caller
  // (pipeline) reads an empty return as the signal to backfill on-subject
  // footage borrowed from other sections rather than hard-failing the whole run.
  // The `queries.length === 0` throw above is deliberately KEPT separate: that's
  // an upstream script-gen defect (a section with no beats at all) that must
  // surface, not be papered over with borrowed footage.
  if (clips.length === 0) {
    log(`No b-roll for any beat of [${queries.join(' | ')}] — caller will backfill from other sections`);
  }
  return clips;
}

// Last-resort cross-section backfill (pure). A section reaches here only when
// EVERY one of its beats came up empty across providers → Commons → Unsplash AND
// no sibling beat in the section had footage to borrow (clipsForBeat), i.e. a
// genuinely unfilmable subject — the invariant #3 smell the topic-demand gate
// now blocks upstream. The episode subject is constant, so footage already
// fetched for OTHER sections is still on-subject: reuse it here rather than
// hard-failing the whole run at step 3/8. Cycles the pool so a long section gets
// variety instead of one clip looped. Returns [] when the pool is empty (no
// footage anywhere yet — the caller then fails loudly, since a video with zero
// footage must never ship). NOT a strategy — a real on-subject fetch always
// wins; this only keeps a partial-failure run alive and on-topic.
export function backfillSectionClips(pool: readonly BrollClip[], needed: number): BrollClip[] {
  if (pool.length === 0 || needed <= 0) return [];
  const out: BrollClip[] = [];
  for (let i = 0; i < needed; i++) out.push(pool[i % pool.length]!);
  return out;
}

// Portrait-native b-roll for one Short (#6). Best-effort BY DESIGN: every
// Short already has the long section's landscape clips (center-cropped by the
// renderer) as a working fallback, so this returns whatever portrait footage
// it found — possibly [] — instead of throwing. Beats are queried in narration
// order; like the long-form path, each beat uses at most a couple of distinct
// clips and reuses distinct segments of its first clip for the rest
// (assembleHeroReuseShots), so a Short never flashes a different individual every
// cut. Cuts faster than the long-form via the tighter SHORTS_CLIP_SEC quota.
export async function fetchShortsBroll(
  beats: string[],
  narrationSec: number,
  workDir: string,
  usedUrls: Set<string>,
  pixabayCategory?: string,
): Promise<BrollClip[]> {
  const cacheDir = ensureDir(path.join(workDir, 'broll'));
  const queries = beats.map((b) => b.trim()).filter(Boolean);
  if (queries.length === 0) return [];
  const opts: BrollFetchOpts = { orientation: 'portrait', pixabayCategory };
  const needed = Math.max(1, Math.ceil(narrationSec / SHORTS_CLIP_SEC));
  return assembleHeroReuseShots(
    queries,
    needed,
    SHORTS_CLIP_SEC,
    cacheDir,
    usedUrls,
    undefined,
    undefined,
    opts,
  );
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

// The yt_music library is organized by mood folder ({Ambient,Cinematic,
// Classical}-{Calm,Dark,Dramatic}). These map an episode's music tags to the
// folder MOOD it should draw from, so an ominous episode never lands a "calm"
// bed (or vice versa) just because a filename token happened to coincide.
const MOOD_KEYWORDS: Record<string, string[]> = {
  dramatic: ['dramatic', 'epic', 'intense', 'powerful', 'battle', 'cosmic', 'sci-fi'],
  dark: [
    'dark', 'suspense', 'mysterious', 'ominous', 'creeping', 'eerie', 'tense',
    'investigative', 'curious', 'cerebral', 'ancient', 'abyssal', 'deep',
  ],
  calm: ['calm', 'gentle', 'serene', 'soft', 'peaceful', 'organic', 'nature', 'botanical'],
};

// How many recent tracks to avoid replaying. Kept small so a pruned library
// never starves the picker; persisted newline-separated in LAST_BGM_FILE.
const BGM_HISTORY = 4;

// The dominant mood(s) an episode's music queries ask for: the mood family with
// the most keyword hits (ties allowed). Empty when nothing matches, which lets
// the picker fall back to the whole library.
export function preferredMoods(queries: string[]): string[] {
  const text = queries.join(' ').toLowerCase();
  const counts = Object.entries(MOOD_KEYWORDS).map(([mood, kws]) => ({
    mood,
    hits: kws.reduce((a, k) => a + (text.includes(k) ? 1 : 0), 0),
  }));
  const max = counts.reduce((m, c) => Math.max(m, c.hits), 0);
  if (max === 0) return [];
  return counts.filter((c) => c.hits === max).map((c) => c.mood);
}

// The mood folder a track lives in, read from its assets-relative path
// (e.g. "yt_music/Cinematic-Dark/...") -> "dark". Pure on the path string so it
// is unit-testable. Returns null for tracks outside a recognized mood folder.
export function moodFromPath(relPath: string): string | null {
  const p = relPath.toLowerCase();
  if (p.includes('dramatic')) return 'dramatic';
  if (p.includes('dark')) return 'dark';
  if (p.includes('calm')) return 'calm';
  return null;
}

function loadBgmHistory(): string[] {
  try {
    return fs
      .readFileSync(LAST_BGM_FILE, 'utf-8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, BGM_HISTORY);
  } catch {
    return [];
  }
}

function saveBgmHistory(chosenKey: string, recent: string[]): void {
  try {
    fs.mkdirSync(WORK_DIR, { recursive: true });
    const next = [chosenKey, ...recent.filter((k) => k !== chosenKey)].slice(0, BGM_HISTORY);
    fs.writeFileSync(LAST_BGM_FILE, next.join('\n'), 'utf-8');
  } catch {
    // Persistence is best-effort.
  }
}

function pickLocalBgm(queries: string[]): string | null {
  const sourcePool = eligibleTracks();
  if (sourcePool.length === 0) return null;

  // 1) Bias to the episode's mood folder. If that mood isn't represented in the
  //    (possibly pruned) library, fall back to the whole pool rather than fail.
  const moods = preferredMoods(queries);
  const moodMatched =
    moods.length > 0
      ? sourcePool.filter((f) => {
          const m = moodFromPath(musicRelKey(f));
          return m !== null && moods.includes(m);
        })
      : [];
  const moodPool = moodMatched.length > 0 ? moodMatched : sourcePool;

  // 2) Within the mood pool, rank by filename/path token overlap (secondary).
  const tokens = queries
    .flatMap((q) => q.toLowerCase().split(/\s+/))
    .filter((t) => t.length >= 4);
  const scored = moodPool.map((file) => {
    const hay = musicRelKey(file).toLowerCase();
    const score = tokens.reduce((acc, t) => (hay.includes(t) ? acc + 1 : acc), 0);
    return { file, score };
  });
  const maxScore = scored.reduce((m, s) => Math.max(m, s.score), 0);
  const pool = maxScore > 0 ? scored.filter((s) => s.score === maxScore) : scored;

  // 3) Avoid the last BGM_HISTORY tracks so a small library doesn't loop fast.
  //    Only relax this when the matched pool has nothing fresher to offer.
  const recent = loadBgmHistory();
  const fresh = pool.filter((s) => !recent.includes(musicRelKey(s.file)));
  const chosen = pickRandom(fresh.length > 0 ? fresh : pool).file;

  saveBgmHistory(musicRelKey(chosen), recent);
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
