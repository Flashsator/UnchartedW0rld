import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import type { WordTiming } from '../../src/types';
import { chunkWords, type Cue } from '../../src/chunker';

type SubtitleVariant = 'horizontal' | 'vertical';

type SubtitleOverlayProps = {
  words: WordTiming[];
  variant?: SubtitleVariant;
};

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
  const maxWidth = isVertical ? '88%' : '78%';
  const fontSize = isVertical ? 82 : 60;
  const strokeWidth = isVertical ? '3px' : '2px';

  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: topPct,
          transform: `translate(-50%, ${lift}px)`,
          maxWidth,
          textAlign: 'center',
          opacity: fade,
        }}
      >
        <span
          style={{
            display: 'inline-block',
            color: '#ffffff',
            fontSize,
            lineHeight: 1.18,
            fontWeight: 800,
            letterSpacing: 0.4,
            fontFamily:
              '"Inter", "Segoe UI", "Helvetica Neue", system-ui, -apple-system, sans-serif',
            textShadow:
              '0 0 6px rgba(0,0,0,0.85), 0 4px 18px rgba(0,0,0,0.75), 0 2px 0 rgba(0,0,0,0.95)',
            WebkitTextStroke: `${strokeWidth} rgba(0,0,0,0.78)`,
            paintOrder: 'stroke fill',
          }}
        >
          {active.text}
        </span>
      </div>
    </AbsoluteFill>
  );
}
