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

// Long-form captions are forced onto a single line (no wrap). The 1920px-wide
// frame at ~92% width fits ~50 chars at the base size, and 4-word cues are
// almost always shorter, so the base size is held for the overwhelming
// majority. The step-downs only kick in for the rare extra-long cue, purely as
// an overflow safety net.
function horizontalFontSize(text: string): number {
  const len = text.trim().length;
  if (len <= 48) return 60;
  if (len <= 56) return 52;
  return 46;
}

// Shorts captions are also kept to a single line. The portrait frame is only
// 1080px wide, so the base 82px only fits short cues; the size steps down as
// the cue gets longer so a 4-word cue still lands on one line at ~92% width.
// Short cues keep the big, punchy size.
function verticalFontSize(text: string): number {
  const len = text.trim().length;
  if (len <= 22) return 82;
  if (len <= 28) return 70;
  if (len <= 34) return 60;
  if (len <= 40) return 52;
  return 46;
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
  const { fps } = useVideoConfig();
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
  // Both layouts force a single line (no wrap). The font auto-shrinks per cue
  // so even a long 4-word cue fits one line within the box width.
  const maxWidth = isVertical ? '92%' : '92%';
  const fontSize = isVertical ? verticalFontSize(active.text) : horizontalFontSize(active.text);
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
          maxWidth,
          opacity: fade,
          display: 'flex',
          // Never wrap — both layouts keep the cue on a single line (the font
          // auto-shrinks per cue to make it fit).
          flexWrap: 'nowrap',
          justifyContent: 'center',
          alignItems: 'baseline',
          columnGap: isVertical ? 18 : 14,
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
            ? interpolate(t - w.start, [0, 0.1], [0.82, 1], {
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
