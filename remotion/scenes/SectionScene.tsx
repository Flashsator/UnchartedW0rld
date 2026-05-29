import {
  AbsoluteFill,
  OffthreadVideo,
  Sequence,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import type { RenderManifest } from '../../src/types';
import { IconOverlay } from './IconOverlay';
import { OverlayLayer } from './OverlayLayer';
import { SubtitleOverlay } from './SubtitleOverlay';

type Section = RenderManifest['sections'][number];

function pathToSrc(p: string): string {
  if (p.startsWith('http')) return p;
  return staticFile(p);
}

type SectionSceneProps = {
  section: Section;
  index: number;
};

type KenBurns = {
  scaleFrom: number;
  scaleTo: number;
  xFrom: number;
  xTo: number;
  yFrom: number;
  yTo: number;
};

function kenBurnsFor(clipIdx: number, sectionIdx: number): KenBurns {
  const k = clipIdx + sectionIdx * 7;
  const pattern = k % 4;
  switch (pattern) {
    case 0:
      return { scaleFrom: 1.0, scaleTo: 1.07, xFrom: 0, xTo: -22, yFrom: 0, yTo: 0 };
    case 1:
      return { scaleFrom: 1.07, scaleTo: 1.0, xFrom: 22, xTo: 0, yFrom: 0, yTo: 0 };
    case 2:
      return { scaleFrom: 1.0, scaleTo: 1.06, xFrom: -18, xTo: 0, yFrom: 0, yTo: -10 };
    default:
      return { scaleFrom: 1.06, scaleTo: 1.0, xFrom: 0, xTo: 18, yFrom: 10, yTo: 0 };
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

export function SectionScene({ section, index }: SectionSceneProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const sectionFrames = Math.round((section.duration + section.gapAfterSec) * fps);
  const clips = section.brollPaths;
  const cutTimes = section.cutTimes && section.cutTimes.length === clips.length
    ? section.cutTimes
    : clips.map((_, i) => (i * (section.duration + section.gapAfterSec)) / Math.max(1, clips.length));

  const fadeIn = interpolate(frame, [0, 8], [0, 1], { extrapolateRight: 'clamp' });
  const gapStartFrame = Math.round(section.duration * fps);
  const gapFadeOut = interpolate(
    frame,
    [gapStartFrame, gapStartFrame + Math.round(section.gapAfterSec * fps)],
    [1, 0.55],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );

  return (
    <AbsoluteFill style={{ backgroundColor: 'black', opacity: fadeIn }}>
      {clips.map((p, i) => {
        const startFrame = Math.round(cutTimes[i]! * fps);
        const nextStart = i + 1 < cutTimes.length
          ? Math.round(cutTimes[i + 1]! * fps)
          : sectionFrames;
        const durFrames = Math.max(1, nextStart - startFrame);
        const motion = kenBurnsFor(i, index);
        return (
          <Sequence key={i} from={startFrame} durationInFrames={durFrames}>
            <KenBurnsClip src={pathToSrc(p)} durationInFrames={durFrames} motion={motion} />
          </Sequence>
        );
      })}
      <AbsoluteFill
        style={{
          background:
            'linear-gradient(180deg, rgba(0,0,0,0.0) 55%, rgba(0,0,0,0.65) 100%)',
          pointerEvents: 'none',
          opacity: gapFadeOut,
        }}
      />
      <SubtitleOverlay words={section.words} />
      <IconOverlay events={section.iconEvents} />
      <OverlayLayer overlays={section.overlays ?? []} words={section.words} sectionIdx={index} />
    </AbsoluteFill>
  );
}
