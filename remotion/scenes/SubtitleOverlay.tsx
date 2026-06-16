import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import type { WordTiming } from '../../src/types';
import { chunkWords, type Cue } from '../../src/chunker';

type SubtitleVariant = 'horizontal' | 'vertical';

type SubtitleOverlayProps = {
  words: WordTiming[];
  variant?: SubtitleVariant;
};

// Brand accent used for the currently-spoken word (matches the hook badge and
// end-card highlight elsewhere in the short).
const HIGHLIGHT = '#FFE94A';

// Both layouts force the cue onto a single line (no wrap). A coarse
// character-count bucket used to pick the size, but `maxWidth` does NOT shrink
// `nowrap` content — it only caps the box, so a long or wide-glyph 4-word cue
// (common on the narrow 1080px Shorts frame) spilled past the edge and clipped.
// Instead, derive the size from the actual pixel budget: estimate the rendered
// line width (glyph advance + per-letter tracking + inter-word gaps) and shrink
// the font until the line fits the usable width, clamped to a readable floor
// and the design-max so short cues stay big and punchy.
//
// Conservative em-advance for Inter weight 800 in sentence case; pairs with the
// `WIDTH_SAFETY` headroom below to absorb above-average-width cues and the
// active word's karaoke pop without ever overflowing.
const GLYPH_ADVANCE_RATIO = 0.56;
const WIDTH_SAFETY = 0.94;

type FitParams = {
  frameWidth: number;
  designMax: number;
  floor: number;
  columnGap: number;
  letterSpacing: number;
  widthPct: number;
};

function fitFontSize(cueWords: WordTiming[], p: FitParams): number {
  const glyphs = cueWords.reduce((n, w) => n + w.text.trim().length, 0);
  if (glyphs === 0) return p.designMax;
  const gaps = Math.max(0, cueWords.length - 1) * p.columnGap;
  const usable = p.frameWidth * p.widthPct * WIDTH_SAFETY - gaps;
  // usable >= glyphs * (GLYPH_ADVANCE_RATIO * size + letterSpacing) → solve size
  const size = (usable - glyphs * p.letterSpacing) / (glyphs * GLYPH_ADVANCE_RATIO);
  return Math.max(p.floor, Math.min(p.designMax, Math.floor(size)));
}

// The active word is the last one that has started. Holding the most recent
// word lit through the micro-gaps between words (rather than going blank) keeps
// the karaoke read continuous instead of flickering.
function activeWordIndex(cueWords: WordTiming[], t: number): number {
  let idx = 0;
  for (let i = 0; i < cueWords.length; i++) {
    if (cueWords[i]!.start <= t + 0.02) idx = i;
    else break;
  }
  return idx;
}

export function SubtitleOverlay({ words, variant = 'horizontal' }: SubtitleOverlayProps) {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const t = frame / fps;
  const cues: Cue[] = chunkWords(words);

  const active = cues.find((c) => t >= c.start - 0.05 && t <= c.end + 0.12);
  if (!active) return null;

  const inRel = t - active.start;
  const outRel = active.end - t;
  const fade = interpolate(
    Math.min(inRel, outRel),
    [-0.05, 0.08, 0.12],
    [0, 1, 1],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );
  const lift = interpolate(inRel, [0, 0.18], [10, 0], { extrapolateRight: 'clamp' });

  const isVertical = variant === 'vertical';
  const topPct = isVertical ? '60%' : '80%';
  // Both layouts force a single line (no wrap). The font is sized to the real
  // pixel budget per cue so even a long 4-word cue fits one line within the box.
  const widthPct = 0.92;
  const columnGap = isVertical ? 18 : 14;
  const fontSize = fitFontSize(active.words, {
    frameWidth: width,
    designMax: isVertical ? 82 : 60,
    floor: isVertical ? 34 : 38,
    columnGap,
    letterSpacing: 0.4,
    widthPct,
  });
  const strokeWidth = isVertical ? '3px' : '2px';

  const activeIdx = activeWordIndex(active.words, t);

  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: topPct,
          transform: `translate(-50%, ${lift}px)`,
          maxWidth: `${widthPct * 100}%`,
          opacity: fade,
          display: 'flex',
          // Never wrap — both layouts keep the cue on a single line (the font
          // auto-shrinks per cue to make it fit).
          flexWrap: 'nowrap',
          justifyContent: 'center',
          alignItems: 'baseline',
          columnGap,
          rowGap: isVertical ? 6 : 4,
        }}
      >
        {active.words.map((w, i) => {
          // Karaoke per-word highlight is a Shorts-only device: on mobile, often
          // muted and fast-scrolled, the lit word locks the eye and sets pace.
          // Long-form (16:9, lean-back, documentary tone) reads the whole line at
          // once, so it stays calm — uniform white, no recolor, no pop.
          const isActive = isVertical && i === activeIdx;
          // Quick pop as a word lights up, so the highlight reads as a beat
          // rather than a static recolor. transform scale doesn't reflow, so
          // neighbouring words stay put.
          const pop = isActive
            ? interpolate(t - w.start, [0, 0.08, 0.16], [0.82, 1.08, 1], {
                extrapolateLeft: 'clamp',
                extrapolateRight: 'clamp',
              })
            : 1;
          return (
            <span
              key={i}
              style={{
                display: 'inline-block',
                transform: `scale(${pop})`,
                transformOrigin: 'center bottom',
                color: isActive ? HIGHLIGHT : '#ffffff',
                fontSize,
                lineHeight: 1.18,
                fontWeight: 800,
                letterSpacing: 0.4,
                fontFamily:
                  '"Inter", "Segoe UI", "Helvetica Neue", system-ui, -apple-system, sans-serif',
                textShadow: isActive
                  ? '0 0 6px rgba(0,0,0,0.85), 0 4px 18px rgba(0,0,0,0.75), 0 2px 0 rgba(0,0,0,0.95), 0 0 22px rgba(255,233,74,0.45)'
                  : '0 0 6px rgba(0,0,0,0.85), 0 4px 18px rgba(0,0,0,0.75), 0 2px 0 rgba(0,0,0,0.95)',
                WebkitTextStroke: `${strokeWidth} rgba(0,0,0,0.78)`,
                paintOrder: 'stroke fill',
              }}
            >
              {w.text}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
}
