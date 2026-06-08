import {
  AbsoluteFill,
  OffthreadVideo,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

function pathToSrc(p: string): string {
  if (!p) return '';
  if (p.startsWith('http')) return p;
  return staticFile(p);
}

// The cold open shows the episode hook as bold on-screen text so a scrolling
// viewer can read the promise in the first seconds — the single biggest lever on
// retention. The raw hook can be two sentences; distil it to one punchy thought
// (first sentence, then a generous char cap for the 1080-tall long-form frame).
const HOOK_MAX_CHARS = 95;

function compactHook(text: string): string {
  const clean = text.trim().replace(/\s+/g, ' ');
  if (!clean) return '';
  const firstSentence = clean.match(/^.*?[.!?](?:\s|$)/)?.[0].trim() ?? clean;
  if (firstSentence.length <= HOOK_MAX_CHARS) return firstSentence;
  const words = firstSentence.split(' ');
  let out = '';
  for (const w of words) {
    if ((out ? `${out} ${w}` : w).length > HOOK_MAX_CHARS - 1) break;
    out = out ? `${out} ${w}` : w;
  }
  return `${(out || firstSentence.slice(0, HOOK_MAX_CHARS - 1)).trimEnd()}…`;
}

export const ColdOpen: React.FC<{ visualPath: string; hook?: string }> = ({ visualPath, hook }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  const zoom = interpolate(frame, [0, durationInFrames], [1.04, 1.12]);
  const vignette = interpolate(
    frame,
    [0, durationInFrames * 0.6, durationInFrames],
    [0.55, 0.5, 0.7],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );
  const fadeOut = interpolate(
    frame,
    [durationInFrames - 6, durationInFrames],
    [1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );

  // Hook text slides up + fades in (compositor-friendly: transform/opacity only).
  const hookText = hook ? compactHook(hook) : '';
  const hookOpacity = interpolate(frame, [6, 24], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const hookRise = interpolate(frame, [6, 24], [44, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill style={{ backgroundColor: 'black', opacity: fadeOut }}>
      {visualPath ? (
        <OffthreadVideo
          src={pathToSrc(visualPath)}
          muted
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            transform: `scale(${zoom})`,
            transformOrigin: 'center',
          }}
        />
      ) : null}
      <AbsoluteFill
        style={{
          background: `radial-gradient(ellipse at center, rgba(0,0,0,0) 35%, rgba(0,0,0,${vignette}) 100%)`,
          pointerEvents: 'none',
        }}
      />
      <AbsoluteFill
        style={{
          background:
            'linear-gradient(180deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0) 18%, rgba(0,0,0,0) 70%, rgba(0,0,0,0.75) 100%)',
          pointerEvents: 'none',
        }}
      />
      {hookText ? (
        <AbsoluteFill
          style={{
            justifyContent: 'flex-end',
            alignItems: 'center',
            padding: '0 8% 9%',
            pointerEvents: 'none',
          }}
        >
          <h1
            style={{
              margin: 0,
              maxWidth: '84%',
              textAlign: 'center',
              color: '#ffffff',
              fontFamily: 'Inter, Arial, sans-serif',
              fontWeight: 800,
              fontSize: 64,
              lineHeight: 1.16,
              letterSpacing: '-0.01em',
              textWrap: 'balance',
              textShadow: '0 2px 18px rgba(0,0,0,0.65), 0 1px 3px rgba(0,0,0,0.85)',
              opacity: hookOpacity,
              transform: `translateY(${hookRise}px)`,
              willChange: 'transform, opacity',
            }}
          >
            {hookText}
          </h1>
        </AbsoluteFill>
      ) : null}
    </AbsoluteFill>
  );
};
