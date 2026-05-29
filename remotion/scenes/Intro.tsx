import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';

function pickTitleFontSize(title: string): number {
  const len = title.length;
  if (len <= 30) return 110;
  if (len <= 45) return 92;
  if (len <= 60) return 76;
  if (len <= 75) return 64;
  return 56;
}

export const Intro: React.FC<{ title: string; hook: string; series: string }> = ({
  title,
  hook,
  series,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const fadeIn = interpolate(frame, [0, fps * 0.4], [0, 1], {
    extrapolateRight: 'clamp',
  });
  const scale = interpolate(frame, [0, fps * 0.6], [0.92, 1], {
    extrapolateRight: 'clamp',
  });

  const titleFontSize = pickTitleFontSize(title);

  return (
    <AbsoluteFill
      style={{
        background:
          'radial-gradient(circle at 50% 40%, #1a2540 0%, #050a18 70%)',
        fontFamily: '"Inter", "Helvetica Neue", Arial, sans-serif',
        color: 'white',
        textAlign: 'center',
        padding: '0 120px',
      }}
    >
      <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
        <div
          style={{
            opacity: fadeIn,
            transform: `scale(${scale})`,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 28,
          }}
        >
          <div
            style={{
              backgroundColor: '#E50914',
              color: '#fff',
              padding: '10px 26px',
              borderRadius: 4,
              fontWeight: 800,
              letterSpacing: 6,
              fontSize: 26,
              textTransform: 'uppercase',
            }}
          >
            {series}
          </div>
          <div
            style={{
              fontSize: titleFontSize,
              fontWeight: 900,
              lineHeight: 1.05,
              letterSpacing: -1,
              maxWidth: 1600,
              textShadow: '0 6px 30px rgba(0,0,0,0.6)',
              wordBreak: 'break-word',
            }}
          >
            {title}
          </div>
          <div
            style={{
              fontSize: 36,
              fontWeight: 500,
              opacity: 0.85,
              maxWidth: 1300,
              fontStyle: 'italic',
            }}
          >
            {hook}
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
