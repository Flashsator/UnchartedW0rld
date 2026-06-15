import {
  AbsoluteFill,
  OffthreadVideo,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

function pathToSrc(p: string): string {
  if (p.startsWith('http')) return p;
  return staticFile(p);
}

// Brand accent, shared with the subtitle highlight and overlay cards.
const ACCENT = '#FFE94A';

// The chapter card that turns the breather into a designed act break: a small
// kicker, an accent rule, and the title of the chapter the episode is turning
// into. Entrance/exit are transform + opacity only.
function ChapterCard({ label, durationInFrames }: { label: string; durationInFrames: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const total = durationInFrames / fps;

  // Fade the card in once the footage has settled, hold, then fade out before
  // the cut to the next section.
  const opacity = interpolate(
    t,
    [0.5, 1.1, total - 1.1, total - 0.4],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );
  const lift = interpolate(t, [0.5, 1.2], [16, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  // The accent rule draws in from the left as the card arrives.
  const ruleScale = interpolate(t, [0.6, 1.3], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill
      style={{
        pointerEvents: 'none',
        justifyContent: 'center',
        alignItems: 'center',
        opacity,
        transform: `translateY(${lift}px)`,
      }}
    >
      <div style={{ width: '72%', maxWidth: 1200, textAlign: 'center' }}>
        <div
          style={{
            fontFamily: '"Inter", "Helvetica Neue", system-ui, sans-serif',
            fontWeight: 700,
            fontSize: 26,
            letterSpacing: '0.42em',
            textTransform: 'uppercase',
            color: ACCENT,
            marginBottom: 26,
          }}
        >
          Coming up
        </div>
        <div
          style={{
            width: 120,
            height: 3,
            margin: '0 auto 30px',
            background: ACCENT,
            transform: `scaleX(${ruleScale})`,
            transformOrigin: 'center',
          }}
        />
        <div
          style={{
            fontFamily: '"Inter", "Helvetica Neue", system-ui, sans-serif',
            fontWeight: 800,
            fontSize: 84,
            lineHeight: 1.06,
            letterSpacing: '-0.01em',
            color: '#FFFFFF',
            textShadow: '0 2px 24px rgba(0,0,0,0.55)',
          }}
        >
          {label}
        </div>
      </div>
    </AbsoluteFill>
  );
}

export const AmbientBreather: React.FC<{ visualPath: string; label?: string }> = ({
  visualPath,
  label,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const fadeIn = Math.round(0.4 * fps);
  const fadeOut = Math.round(0.5 * fps);
  const opacity = interpolate(
    frame,
    [0, fadeIn, durationInFrames - fadeOut, durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );

  return (
    <AbsoluteFill style={{ backgroundColor: 'black', opacity }}>
      <OffthreadVideo
        src={pathToSrc(visualPath)}
        muted
        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
      />
      {label ? (
        <>
          {/* Darken the footage so the chapter title stays legible. */}
          <AbsoluteFill
            style={{ background: 'rgba(0,0,0,0.46)', pointerEvents: 'none' }}
          />
          <ChapterCard label={label} durationInFrames={durationInFrames} />
        </>
      ) : null}
    </AbsoluteFill>
  );
};
