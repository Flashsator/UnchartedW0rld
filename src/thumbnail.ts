import path from 'node:path';
import sharp from 'sharp';
import { THUMB_H, THUMB_W, type Series, type ThumbLayout } from './config.js';
import { downloadFile, ensureDir, log } from './utils.js';

// Derive the visual subject from the episode title so the background image is
// about THIS episode, not just the generic series style. Drops any structural
// prefix ("Case File:", "Profile:", etc.) before the first colon.
function titleToSubject(title: string): string {
  const afterColon = title.includes(':') ? title.slice(title.indexOf(':') + 1) : title;
  return afterColon
    .replace(/[“”‘’"']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' :
    c === '<' ? '&lt;' :
    c === '>' ? '&gt;' :
    c === '"' ? '&quot;' : '&apos;',
  );
}

const STOPWORDS = new Set([
  'the', 'and', 'but', 'with', 'from', 'into', 'that', 'this', 'these', 'their',
  'about', 'which', 'where', 'while', 'after', 'before', 'every', 'over', 'under',
  'than', 'then', 'when', 'what', 'were', 'have', 'been', 'they', 'them', 'your',
  'will', 'would', 'could', 'should', 'just', 'like', 'also',
]);

const POWER_WORDS = ['WAIT', 'TRUTH', 'WRONG', 'HIDDEN', 'GONE', 'REAL', 'FAKE', 'WHY', 'HOW'];

// Curated to clean, high-contrast combinations only. White-on-black and
// yellow-on-black read reliably over any background image without clashing;
// the old red-block / neon-orange entries looked garish over the cool
// documentary photography this channel uses.
const PALETTES = [
  { block: '#000000', accent: '#FFFFFF', text: '#FFFFFF', textAlt: '#FFE94A', stroke: '#000000' }, // white on black (max contrast)
  { block: '#000000', accent: '#FFE94A', text: '#FFE94A', textAlt: '#FFFFFF', stroke: '#000000' }, // warm yellow on black
];

type Palette = (typeof PALETTES)[number];

// Structural prefixes that must never become the headline kicker word.
const KICKER_BLOCKLIST = new Set(['case', 'file', 'profile', 'report', 'log', 'files']);

function pickKicker(title: string): string {
  // Allow an explicit override (manual regen / concept control). Unset in the
  // normal pipeline, so default behavior stays the randomized title word.
  const override = process.env.THUMB_KICKER?.trim();
  if (override) return override.toUpperCase();
  // Strip the "Case File:" / "Profile:" prefix so the kicker comes from the
  // real subject, then drop those framing words even if they survive.
  const tokens = titleToSubject(title)
    .replace(/[^A-Za-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(
      (t) =>
        t.length >= 3 &&
        t.length <= 8 &&
        !STOPWORDS.has(t.toLowerCase()) &&
        !KICKER_BLOCKLIST.has(t.toLowerCase()),
    );
  if (tokens.length === 0) {
    return POWER_WORDS[Math.floor(Math.random() * POWER_WORDS.length)]!;
  }
  const punchy = tokens.filter((t) => /^[A-Z0-9]/.test(t));
  const pool = punchy.length > 0 ? punchy : tokens;
  return pool[Math.floor(Math.random() * pool.length)]!.toUpperCase();
}

type Variant = {
  palette: Palette;
  flipH: boolean;
  flipV: boolean;
  scale: number;
  posJitterX: number;
  posJitterY: number;
  rotation: number;
};

function pickVariant(): Variant {
  const palette = PALETTES[Math.floor(Math.random() * PALETTES.length)]!;
  return {
    palette,
    flipH: Math.random() < 0.5,
    flipV: Math.random() < 0.5,
    scale: 0.88 + Math.random() * 0.24,
    posJitterX: (Math.random() - 0.5) * 80,
    posJitterY: (Math.random() - 0.5) * 60,
    rotation: 0,
  };
}

// 1) q_panel_right — solid panel covers one side; single short word inside; accent seam.
function svgPanelRight(word: string, _series: Series, v: Variant): string {
  const panelW = Math.round(THUMB_W * (0.40 + Math.random() * 0.12));
  const onLeft = v.flipH;
  const panelX = onLeft ? 0 : THUMB_W - panelW;
  const seamX = onLeft ? panelW - 8 : panelX;
  const wordX = panelX + panelW / 2 + v.posJitterX * 0.3;
  // Cap font so the word always fits inside the panel width (long words like
  // "MUSCLES" were overflowing off the frame).
  const fitFont = (panelW * 0.84) / Math.max(word.length, 1) / 0.6;
  const fontSize = Math.round(Math.min(panelW * 0.32, 220 * v.scale, fitFont));
  const wordY = THUMB_H / 2 + fontSize * 0.35 + v.posJitterY * 0.5;
  return `
<svg width="${THUMB_W}" height="${THUMB_H}" xmlns="http://www.w3.org/2000/svg">
  <rect x="${panelX}" y="0" width="${panelW}" height="${THUMB_H}" fill="${v.palette.block}"/>
  <rect x="${seamX}" y="0" width="8" height="${THUMB_H}" fill="${v.palette.accent}"/>
  <text x="${wordX}" y="${wordY}" text-anchor="middle" font-family="Impact, 'Arial Black', sans-serif" font-weight="900" font-size="${fontSize}" fill="${v.palette.text}" stroke="${v.palette.stroke}" stroke-width="10" paint-order="stroke" letter-spacing="4">${escapeXml(word)}</text>
</svg>`;
}

// 2) q_corner_dot — circular badge in a corner with a short word.
function svgCornerDot(word: string, _series: Series, v: Variant): string {
  const r = Math.round(220 + Math.random() * 60);
  const margin = r + 60;
  const cx = v.flipH ? margin : THUMB_W - margin;
  const cy = v.flipV ? THUMB_H - margin : margin;
  const fontSize = Math.round(Math.min(r * 0.7, 150 * v.scale));
  return `
<svg width="${THUMB_W}" height="${THUMB_H}" xmlns="http://www.w3.org/2000/svg">
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="${v.palette.block}"/>
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${v.palette.accent}" stroke-width="10"/>
  <text x="${cx}" y="${cy + fontSize * 0.34}" text-anchor="middle" font-family="Impact, 'Arial Black', sans-serif" font-weight="900" font-size="${fontSize}" fill="${v.palette.text}" stroke="${v.palette.stroke}" stroke-width="8" paint-order="stroke" letter-spacing="3">${escapeXml(word)}</text>
</svg>`;
}

// 3) q_band_word — horizontal band (top or bottom) with a single short word centered.
function svgBandWord(kicker: string, _series: Series, v: Variant): string {
  const bandH = Math.round(220 + Math.random() * 60);
  const bandY = v.flipV ? 0 : THUMB_H - bandH;
  const seamY = v.flipV ? bandH - 6 : bandY;
  const fontSize = Math.round(Math.min(bandH * 0.7, 180 * v.scale));
  const baselineY = bandY + bandH * 0.7;
  return `
<svg width="${THUMB_W}" height="${THUMB_H}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="${bandY}" width="${THUMB_W}" height="${bandH}" fill="${v.palette.block}"/>
  <rect x="0" y="${seamY}" width="${THUMB_W}" height="6" fill="${v.palette.accent}"/>
  <text x="${THUMB_W / 2}" y="${baselineY}" text-anchor="middle" font-family="Impact, 'Arial Black', sans-serif" font-weight="900" font-size="${fontSize}" fill="${v.palette.text}" letter-spacing="6" stroke="${v.palette.stroke}" stroke-width="8" paint-order="stroke">${escapeXml(kicker)}</text>
</svg>`;
}

// 4) q_diag_split — diagonal polygon anchored to one of 4 corners; short word over seam.
function svgDiagSplit(word: string, _series: Series, v: Variant): string {
  const spanX = Math.round(THUMB_W * (0.55 + Math.random() * 0.25));
  const spanY = THUMB_H;
  let points: string;
  const onLeft = !v.flipH;
  if (!v.flipH && !v.flipV) {
    points = `0,0 ${spanX},0 0,${spanY}`;
  } else if (v.flipH && !v.flipV) {
    points = `${THUMB_W},0 ${THUMB_W - spanX},0 ${THUMB_W},${spanY}`;
  } else if (!v.flipH && v.flipV) {
    points = `0,${THUMB_H} ${spanX},${THUMB_H} 0,0`;
  } else {
    points = `${THUMB_W},${THUMB_H} ${THUMB_W - spanX},${THUMB_H} ${THUMB_W},0`;
  }
  const fontSize = Math.round(140 * v.scale);
  const margin = 70;
  const symbolX = onLeft ? margin : THUMB_W - margin;
  const anchor = onLeft ? 'start' : 'end';
  const symbolY = Math.round(THUMB_H * 0.5) + Math.round(fontSize * 0.34);
  return `
<svg width="${THUMB_W}" height="${THUMB_H}" xmlns="http://www.w3.org/2000/svg">
  <polygon points="${points}" fill="${v.palette.block}"/>
  <polygon points="${points}" fill="none" stroke="${v.palette.accent}" stroke-width="8"/>
  <text x="${symbolX}" y="${symbolY + v.posJitterY * 0.3}" text-anchor="${anchor}" font-family="Impact, 'Arial Black', sans-serif" font-weight="900" font-size="${fontSize}" fill="${v.palette.text}" stroke="${v.palette.stroke}" stroke-width="8" paint-order="stroke" letter-spacing="4">${escapeXml(word)}</text>
</svg>`;
}

// 5) q_giant_overlay — caption sits in a solid band pinned to the very bottom of
// the frame so the background image (top ~76%) stays completely unobstructed.
// A thin gradient feathers the band into the photo above it.
function svgGiantOverlay(word: string, _series: Series, v: Variant): string {
  const bandH = Math.round(THUMB_H * 0.22);
  const bandY = THUMB_H - bandH;
  const featherH = Math.round(bandH * 0.55);
  const featherY = bandY - featherH;
  // Fit the word to the band: width-capped so long words never overflow,
  // height-capped so it never grows past the band.
  const fitFont = (THUMB_W * 0.80) / Math.max(word.length, 1) / 0.58;
  const fontSize = Math.round(Math.min(fitFont, bandH * 0.62));
  const baselineY = Math.round(bandY + bandH * 0.5 + fontSize * 0.34);
  return `
<svg width="${THUMB_W}" height="${THUMB_H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="feather" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${v.palette.block}" stop-opacity="0"/>
      <stop offset="100%" stop-color="${v.palette.block}" stop-opacity="1"/>
    </linearGradient>
  </defs>
  <rect x="0" y="${featherY}" width="${THUMB_W}" height="${featherH}" fill="url(#feather)"/>
  <rect x="0" y="${bandY}" width="${THUMB_W}" height="${bandH}" fill="${v.palette.block}"/>
  <rect x="0" y="${bandY}" width="${THUMB_W}" height="6" fill="${v.palette.accent}"/>
  <text x="${THUMB_W / 2}" y="${baselineY}" text-anchor="middle" font-family="Impact, 'Arial Black', sans-serif" font-weight="900" font-size="${fontSize}" fill="${v.palette.text}" stroke="${v.palette.stroke}" stroke-width="10" paint-order="stroke" letter-spacing="6">${escapeXml(word)}</text>
</svg>`;
}

function buildSvgOverlay(
  title: string,
  series: Series,
  layout: ThumbLayout,
  kickerOverride?: string,
): { svg: Buffer; meta: string } {
  const v = pickVariant();
  // Decide the caption word once: explicit override (episode word / manual) wins,
  // else the randomized title word.
  const word = kickerOverride?.trim() ? kickerOverride.trim().toUpperCase() : pickKicker(title);
  const svgStr =
    layout === 'q_corner_dot' ? svgCornerDot(word, series, v) :
    layout === 'q_band_word' ? svgBandWord(word, series, v) :
    layout === 'q_diag_split' ? svgDiagSplit(word, series, v) :
    layout === 'q_giant_overlay' ? svgGiantOverlay(word, series, v) :
    svgPanelRight(word, series, v);
  const meta = `palette=${v.palette.block}/${v.palette.accent} word=${word} flipH=${v.flipH} flipV=${v.flipV} scale=${v.scale.toFixed(2)}`;
  return { svg: Buffer.from(svgStr), meta };
}

export async function makeThumbnail(
  title: string,
  series: Series,
  layout: ThumbLayout,
  workDir: string,
  // Optional explicit visual concept for the background. When set, it replaces
  // the auto-derived subject in the image prompt. Use when the auto subject
  // reads as abstract.
  conceptOverride?: string,
  // Optional explicit caption word. When set, overrides the randomized title
  // word so the cover text matches the chosen concept.
  kickerOverride?: string,
): Promise<string> {
  const outDir = ensureDir(path.join(workDir, 'thumb'));
  const bgPath = path.join(outDir, 'bg.jpg');

  const safeStyle = series.imageStyle
    .replace(/eerie/gi, 'mysterious')
    .replace(/cosmic horror/gi, 'cosmic awe')
    .replace(/medical cinematic/gi, 'scientific documentary')
    // "micro-detail" styling pushes body topics into unreadable abstract macro
    // texture (veiny close-ups). Drop it so the subject stays recognizable.
    .replace(/,?\s*micro-detail biology/gi, '')
    .replace(/,?\s*micro-detail/gi, '');
  const subject = conceptOverride?.trim() || titleToSubject(title);
  // Lead with the episode subject so the image actually depicts this topic, but
  // force a recognizable real-world composition: viewers must instantly read
  // WHAT it is. Extreme macro / abstract textures look like nothing.
  const prompt = `${subject}, clear recognizable real-world subject, cinematic medium shot, ${safeStyle}, photorealistic, sharp focus on the main subject, dramatic lighting, depth of field, 16:9, editorial documentary, vibrant colors, not abstract, no extreme macro close-up, no text, no letters, no words, no captions, no watermark, no logo, no gore, no blood`;
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${THUMB_W}&height=${THUMB_H}&nologo=true&model=flux`;

  log(`Thumbnail: requesting background image (layout: ${layout})...`);
  try {
    await downloadFile(url, bgPath);
  } catch (e) {
    log(`Pollinations failed, using gradient fallback: ${(e as Error).message}`);
    await sharp({
      create: {
        width: THUMB_W,
        height: THUMB_H,
        channels: 3,
        background: { r: 18, g: 30, b: 58 },
      },
    })
      .jpeg({ quality: 90 })
      .toFile(bgPath);
  }

  const { svg: overlaySvg, meta } = buildSvgOverlay(title, series, layout, kickerOverride);
  log(`Thumbnail variant: ${meta}`);
  const outPath = path.join(outDir, 'thumbnail.jpg');

  const dimmedBg = await sharp(bgPath)
    .resize(THUMB_W, THUMB_H, { fit: 'cover' })
    .modulate({ brightness: 0.55, saturation: 1.45 })
    .linear(1.15, -12)
    .toBuffer();

  await sharp(dimmedBg)
    .composite([{ input: overlaySvg, top: 0, left: 0 }])
    .jpeg({ quality: 92 })
    .toFile(outPath);

  log(`Thumbnail: ${outPath}`);
  return outPath;
}
