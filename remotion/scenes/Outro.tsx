import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

// Keep the end-card title to a couple of lines so it never overflows the card.
function clampTitle(text: string, max = 72): string {
  const clean = text.trim().replace(/\s+/g, ' ');
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

export const Outro: React.FC<{ watchNextTitle?: string }> = ({ watchNextTitle }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const slideIn = spring({
    frame,
    fps,
    config: { damping: 12, mass: 0.7, stiffness: 120 },
  });
  const translateY = interpolate(slideIn, [0, 1], [220, 0]);

  const bouncePhase = Math.max(0, frame - fps * 1.0);
  const bounce = Math.sin((bouncePhase / fps) * Math.PI * 2 * 2) * 8;

  const pulse = 1 + Math.sin((frame / fps) * Math.PI * 2 * 1.5) * 0.04;

  const fadeOut = interpolate(
    frame,
    [fps * 5, fps * 6],
    [1, 0],
    { extrapolateRight: 'clamp', extrapolateLeft: 'clamp' },
  );

  // Watch-next card lands a beat after the subscribe pill (compositor-friendly:
  // transform/opacity only). Only rendered when the analytics loop supplied a
  // proven title — otherwise the outro stays the plain CTA it always was.
  const nextTitle = watchNextTitle ? clampTitle(watchNextTitle) : '';
  const nextOpacity = interpolate(frame, [fps * 1.1, fps * 1.7], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const nextRise = interpolate(frame, [fps * 1.1, fps * 1.7], [40, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill
      style={{
        background: 'radial-gradient(circle at 50% 50%, #14172c 0%, #050610 80%)',
        fontFamily: '"Inter", "Helvetica Neue", Arial, sans-serif',
        color: 'white',
        opacity: fadeOut,
      }}
    >
      <AbsoluteFill
        style={{
          justifyContent: 'center',
          alignItems: 'center',
          flexDirection: 'column',
          gap: nextTitle ? 44 : 60,
        }}
      >
        <div
          style={{
            fontSize: nextTitle ? 64 : 80,
            fontWeight: 900,
            letterSpacing: -1,
            textShadow: '0 4px 24px rgba(0,0,0,0.5)',
          }}
        >
          Thanks for watching
        </div>

        <div
          style={{
            transform: `translateY(${translateY + bounce}px) scale(${pulse})`,
            display: 'flex',
            alignItems: 'center',
            gap: 24,
            background: '#E50914',
            color: '#fff',
            padding: nextTitle ? '24px 64px' : '32px 80px',
            borderRadius: 70,
            fontSize: nextTitle ? 60 : 76,
            fontWeight: 900,
            letterSpacing: 2,
            boxShadow: '0 18px 60px rgba(229,9,20,0.55)',
          }}
        >
          <span
            style={{
              fontSize: nextTitle ? 56 : 70,
              lineHeight: 0.7,
              display: 'inline-block',
              transform: 'translateY(2px)',
            }}
          >
            ▶
          </span>
          SUBSCRIBE
        </div>

        {nextTitle ? (
          <div
            style={{
              marginTop: 16,
              width: 1180,
              maxWidth: '82%',
              display: 'flex',
              alignItems: 'center',
              gap: 28,
              padding: '26px 40px',
              borderRadius: 24,
              background: 'rgba(255,255,255,0.06)',
              border: '2px solid rgba(255,255,255,0.16)',
              boxShadow: '0 14px 50px rgba(0,0,0,0.45)',
              opacity: nextOpacity,
              transform: `translateY(${nextRise}px)`,
              willChange: 'transform, opacity',
            }}
          >
            <div
              style={{
                flexShrink: 0,
                width: 84,
                height: 84,
                borderRadius: 18,
                background: '#E50914',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 44,
                boxShadow: '0 8px 24px rgba(229,9,20,0.5)',
              }}
            >
              ▶
            </div>
            <div style={{ textAlign: 'left', minWidth: 0 }}>
              <div
                style={{
                  fontSize: 26,
                  fontWeight: 800,
                  letterSpacing: 3,
                  color: '#9aa3c7',
                  textTransform: 'uppercase',
                  marginBottom: 6,
                }}
              >
                Watch next
              </div>
              <div
                style={{
                  fontSize: 40,
                  fontWeight: 800,
                  lineHeight: 1.15,
                  color: '#ffffff',
                  textShadow: '0 2px 10px rgba(0,0,0,0.5)',
                }}
              >
                {nextTitle}
              </div>
            </div>
          </div>
        ) : null}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
