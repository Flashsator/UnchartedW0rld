import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

export const Outro: React.FC = () => {
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
          gap: 60,
        }}
      >
        <div
          style={{
            fontSize: 80,
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
            padding: '32px 80px',
            borderRadius: 70,
            fontSize: 76,
            fontWeight: 900,
            letterSpacing: 2,
            boxShadow: '0 18px 60px rgba(229,9,20,0.55)',
          }}
        >
          <span
            style={{
              fontSize: 70,
              lineHeight: 0.7,
              display: 'inline-block',
              transform: 'translateY(2px)',
            }}
          >
            ▶
          </span>
          SUBSCRIBE
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
