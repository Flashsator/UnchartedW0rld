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
// That ≤60-char cap keeps even the largest tier to ~2 lines, so the title sits
// as a tidy block near the top instead of swallowing the frame — which is why
// the headline can render as per-word spans (no line-clamp; a clamp would crop
// the cascade's translateY entrance).
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
  isFirst = false,
}: {
  src: string;
  durationInFrames: number;
  motion: KenBurns;
  isFirst?: boolean;
}) {
  const frame = useCurrentFrame();
  const range = [0, durationInFrames];
  const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

  let scale: number;
  let tx = 0;
  let ty = 0;
  if (isFirst) {
    // Snap-zoom landing on the Short's first shot: a fast push-in over the first
    // ~0.3s, then a slow drift, so the open lands on motion instead of a slow
    // creep. No pan — a centered punch reads as a confident "snap to". The short-
    // clip guard keeps interpolate's input range strictly increasing.
    scale =
      durationInFrames <= 12
        ? interpolate(frame, [0, durationInFrames], [1.26, 1.14], clamp)
        : interpolate(frame, [0, 9, durationInFrames], [1.26, 1.15, 1.12], clamp);
  } else {
    scale = interpolate(frame, range, [motion.scaleFrom, motion.scaleTo], clamp);
    tx = interpolate(frame, range, [motion.xFrom, motion.xTo], clamp);
    ty = interpolate(frame, range, [motion.yFrom, motion.yTo], clamp);
  }
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

  // End card: only when the manifest carries an outro window (outroSec > 0)
  // does the "subscribe + watch full video" panel fade in after the narration.
  // The pipeline currently ships outroSec = 0 so Shorts loop seamlessly
  // (replay rate is an algorithm signal); the card is kept for reversibility.
  const hasOutro = (manifest.outroSec ?? 0) > 0.1;
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

  // Near-hard cut in: a Short's first frame is both its swipe-decision moment and
  // its poster still, so we don't burn ~0.3s fading up from black. 3 frames
  // (~0.1s) just softens the very first frame against a decode pop, then the shot
  // is fully up — the viewer lands on the footage, not a black screen.
  const fadeIn = interpolate(frame, [0, 3], [0, 1], { extrapolateRight: 'clamp' });
  const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

  // Title (series badge + hook) shows only at the start, then clears out so the
  // rest of the short is unobstructed. The hold scales to the hook's length: a
  // short punch clears fast (it shouldn't loiter over the footage), a 3-line hook
  // gets longer to read. ~13 chars/sec, floored/capped so it never snaps away or
  // overstays.
  const hookHoldSec = Math.min(4.6, Math.max(2.4, manifest.cardHook.length / 13));
  const hookOutStart = Math.round(fps * hookHoldSec);
  // Macro envelope for the whole title block: fully ON from frame 0 (the per-word
  // cascade below owns the intro reveal, so the container must NOT also ramp up or
  // the leading words would double-fade), held through hookOutStart, then faded
  // out before the footage takes the frame back.
  const hookEnvelope = interpolate(
    frame,
    [0, hookOutStart, hookOutStart + Math.round(fps * 0.7)],
    [1, 1, 0],
    clamp,
  );
  // Badge stinger: the series chip stamps in first with a quick overshoot, a beat
  // ahead of the headline, so the open reads as a designed title hit rather than a
  // static label. transform + opacity only.
  const badgeIn = interpolate(frame, [0, 7], [0, 1], clamp);
  const badgeScale = interpolate(frame, [0, 5, 10], [0.7, 1.06, 1], clamp);
  // Headline kinetic cascade: each word rises + fades in on a small stagger so the
  // hook builds like motion graphics instead of one static block dropped on frame
  // 0 — the single biggest fix for the "reads like a narrated article" feel. The
  // cascade is bounded to ~CASCADE_WINDOW frames regardless of word count so a long
  // hook never drags past the swipe-decision moment. compactHook is ≤60 chars
  // upstream, so it stays ≤3 lines without a hard clamp (a clamp + per-word lift
  // would clip the entrance).
  const hookWords = manifest.cardHook.trim().split(/\s+/).filter(Boolean);
  const CASCADE_WINDOW = 16;
  const WORD_RISE = 7;
  // Loop-back: in the final ~1.2s the same hook card fades back in, so when the
  // Short loops (outroSec = 0, no end card) the seam lands back on the opening
  // hook instead of a bare last frame — the curiosity gap re-arms and replay
  // rate (a Shorts ranking signal) climbs. Skipped when the reversible end card
  // is active, which already owns the tail. Per-word opacities are clamped to 1
  // by then, so the block simply re-appears without re-cascading.
  const loopBackStart = totalFrames - Math.round(fps * 1.2);
  const loopBackOpacity = hasOutro
    ? 0
    : interpolate(
        frame,
        [loopBackStart, loopBackStart + Math.round(fps * 0.5)],
        [0, 1],
        clamp,
      );
  const titleOpacity = Math.max(hookEnvelope, loopBackOpacity);

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
            <KenBurnsClip
              src={pathToSrc(p)}
              durationInFrames={durFrames}
              motion={motion}
              isFirst={i === 0}
            />
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
          opacity: titleOpacity,
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
            opacity: badgeIn,
            transform: `scale(${badgeScale})`,
            transformOrigin: 'left center',
          }}
        >
          {manifest.series}
        </div>
        <div>
          {hookWords.map((word, i) => {
            const startF =
              hookWords.length > 1 ? (i / (hookWords.length - 1)) * CASCADE_WINDOW : 0;
            const wOpacity = interpolate(frame, [startF, startF + WORD_RISE], [0, 1], clamp);
            const wLift = interpolate(frame, [startF, startF + WORD_RISE], [20, 0], clamp);
            return (
              <span
                key={i}
                style={{
                  display: 'inline-block',
                  marginRight: '0.28em',
                  opacity: wOpacity,
                  transform: `translateY(${wLift}px)`,
                  color: '#fff',
                  fontFamily: '"Inter", "Helvetica Neue", system-ui, sans-serif',
                  fontWeight: 800,
                  fontSize: hookFontSize(manifest.cardHook),
                  lineHeight: 1.08,
                  letterSpacing: '-0.01em',
                  textShadow: '0 2px 14px rgba(0,0,0,0.9), 0 0 6px rgba(0,0,0,0.95)',
                }}
              >
                {word}
              </span>
            );
          })}
        </div>
      </div>

      <SubtitleOverlay words={manifest.words} variant="vertical" />
      <OverlayLayer
        overlays={manifest.overlays ?? []}
        words={manifest.words}
        sectionIdx={manifest.sectionIdx}
      />

      {hasOutro && endOpacity > 0 && (
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
