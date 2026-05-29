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

export const AmbientBreather: React.FC<{ visualPath: string }> = ({ visualPath }) => {
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
    </AbsoluteFill>
  );
};
