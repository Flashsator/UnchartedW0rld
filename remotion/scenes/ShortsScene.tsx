import {
  AbsoluteFill,
  OffthreadVideo,
  Sequence,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import type { ShortsManifest } from '../../src/types';
import { SubtitleOverlay } from './SubtitleOverlay';
import { OverlayLayer } from './OverlayLayer';

function pathToSrc(p: string): string {
  if (p.startsWith('http')) return p;
  return staticFile(p);
}

type KenBurns = {
  scaleFrom: number;
  scaleTo: number;
  xFrom: number;
  xTo: number;
  yFrom: number;
  yTo: number;
};

// The on-screen hook is the single biggest text block on the short. The text is
// already distilled to one short thought upstream (compactHook, ≤60 chars), so
// the font stays large and punchy and only eases down for the longest cases.
// Paired with the 3-line clamp below, this keeps the title to a tidy block near
// the top instead of swallowing the frame.
function hookFontSize(text: string): number {
  const len = text.trim().length;
  if (len <= 24) return 84;
  if (len <= 38) return 76;
  if (len <= 50) return 66;
  return 58;
}

function kenBurnsFor(clipIdx: number): KenBurns {
  switch (clipIdx % 4) {
    case 0:
      return { scaleFrom: 1.12, scaleTo: 1.22, xFrom: 0, xTo: -20, yFrom: 0, yTo: 14 };
    case 1:
      return { scaleFrom: 1.20, scaleTo: 1.10, xFrom: 14, xTo: 0, yFrom: -10, yTo: 0 };
    case 2:
      return { scaleFrom: 1.10, scaleTo: 1.20, xFrom: -14, xTo: 6, yFrom: 0, yTo: -10 };
    default:
      return { scaleFrom: 1.22, scaleTo: 1.10, xFrom: 0, xTo: 12, yFrom: 10, yTo: 0 };
  }
}

function KenBurnsClip({
  src,
  durationInFrames,
  motion,
}: {
  src: string;
  durationInFrames: number;
  motion: KenBurns;
}) {
  const frame = useCurrentFrame();
  const range = [0, durationInFrames];
  const scale = interpolate(frame, range, [motion.scaleFrom, motion.scaleTo], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const tx = interpolate(frame, range, [motion.xFrom, motion.xTo], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const ty = interpolate(frame, range, [motion.yFrom, motion.yTo], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <AbsoluteFill
      style={{
        transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
        transformOrigin: 'center center',
      }}
    >
      <OffthreadVideo
        src={src}
        muted
        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
      />
    </AbsoluteFill>
  );
}

type ShortsSceneProps = {
  manifest: ShortsManifest;
};

export function ShortsScene({ manifest }: ShortsSceneProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const totalFrames = Math.round(manifest.duration * fps);

  const clips = manifest.brollPaths;
  const cutTimes =
    manifest.cutTimes.length === clips.length
      ? manifest.cutTimes
      : clips.map((_, i) => (i * manifest.duration) / Math.max(1, clips.length));

  // End card: after the narration ends, a "subscribe + watch full video" panel
  // fades in over the outro window so the short doesn't stop abruptly.
  const narrationSec = manifest.narrationSec ?? manifest.duration;
  const endStart = Math.round(narrationSec * fps);
  const endOpacity = interpolate(frame, [endStart, endStart + 12], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const endPop = interpolate(frame, [endStart, endStart + 16], [0.86, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const fadeIn = interpolate(frame, [0, 8], [0, 1], { extrapolateRight: 'clamp' });
  // Title (series badge + hook) shows only at the start, then clears out so
  // the rest of the short is unobstructed.
  const hookOpacity = interpolate(
    frame,
    [0, 10, Math.round(fps * 3.5), Math.round(fps * 4.2)],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );

  return (
    <AbsoluteFill style={{ backgroundColor: 'black', opacity: fadeIn }}>
      {clips.map((p, i) => {
        const startFrame = Math.round(cutTimes[i]! * fps);
        const nextStart =
          i + 1 < cutTimes.length ? Math.round(cutTimes[i + 1]! * fps) : totalFrames;
        const durFrames = Math.max(1, nextStart - startFrame);
        const motion = kenBurnsFor(i);
        return (
          <Sequence key={i} from={startFrame} durationInFrames={durFrames}>
            <KenBurnsClip src={pathToSrc(p)} durationInFrames={durFrames} motion={motion} />
          </Sequence>
        );
      })}

      <AbsoluteFill
        style={{
          background:
            'linear-gradient(180deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0) 28%, rgba(0,0,0,0) 70%, rgba(0,0,0,0.7) 100%)',
          pointerEvents: 'none',
        }}
      />

      <div
        style={{
          position: 'absolute',
          top: 240,
          left: 56,
          right: 56,
          opacity: hookOpacity,
        }}
      >
        <div
          style={{
            display: 'inline-block',
            background: '#FFE94A',
            color: '#0A0A0A',
            padding: '10px 18px',
            fontFamily: '"Inter", "Helvetica Neue", system-ui, sans-serif',
            fontWeight: 800,
            fontSize: 28,
            letterSpacing: '0.22em',
            marginBottom: 24,
            textTransform: 'uppercase',
          }}
        >
          {manifest.series}
        </div>
        <div
          style={{
            color: '#fff',
            fontFamily: '"Inter", "Helvetica Neue", system-ui, sans-serif',
            fontWeight: 800,
            fontSize: hookFontSize(manifest.cardHook),
            lineHeight: 1.08,
            letterSpacing: '-0.01em',
            textShadow:
              '0 2px 14px rgba(0,0,0,0.9), 0 0 6px rgba(0,0,0,0.95)',
            display: '-webkit-box',
            WebkitLineClamp: 3,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {manifest.cardHook}
        </div>
      </div>

      <SubtitleOverlay words={manifest.words} variant="vertical" />
      <OverlayLayer
        overlays={manifest.overlays ?? []}
        words={manifest.words}
        sectionIdx={manifest.sectionIdx}
      />

      {endOpacity > 0 && (
        <AbsoluteFill
          style={{
            opacity: endOpacity,
            background:
              'radial-gradient(120% 80% at 50% 42%, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.86) 70%)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: '"Inter", "Helvetica Neue", system-ui, sans-serif',
            textAlign: 'center',
            padding: '0 80px',
          }}
        >
          <div
            style={{
              transform: `scale(${endPop})`,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
            }}
          >
            <div
              style={{
                color: '#fff',
                fontWeight: 800,
                fontSize: 64,
                lineHeight: 1.1,
                letterSpacing: '-0.01em',
                marginBottom: 48,
                textShadow: '0 2px 14px rgba(0,0,0,0.9)',
              }}
            >
              Watch the full video
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 22,
                background: '#FF0033',
                color: '#fff',
                padding: '28px 56px',
                borderRadius: 999,
                fontWeight: 800,
                fontSize: 56,
                letterSpacing: '0.02em',
                boxShadow: '0 14px 40px rgba(255,0,51,0.45)',
              }}
            >
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 64,
                  height: 64,
                  borderRadius: '50%',
                  background: '#fff',
                  color: '#FF0033',
                  fontSize: 40,
                }}
              >
                ▶
              </span>
              SUBSCRIBE
            </div>
            <div
              style={{
                marginTop: 40,
                color: '#FFE94A',
                fontWeight: 800,
                fontSize: 30,
                letterSpacing: '0.22em',
                textTransform: 'uppercase',
              }}
            >
              {manifest.series}
            </div>
          </div>
        </AbsoluteFill>
      )}

    </AbsoluteFill>
  );
}
