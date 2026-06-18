import {
  AbsoluteFill,
  OffthreadVideo,
  Sequence,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import type { RenderManifest, WordTiming } from '../../src/types';
import { FactCard } from './FactCard';
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
  sectionCount: number;
};

// How a given shot is animated. Most shots get the gentle Ken Burns pan; a shot
// landing on a spoken figure gets a quick emphasis push-in; the opening/closing
// establishing shot gets a composed, near-still cinematic push under letterbox.
type ClipTreatment = 'normal' | 'accent' | 'cinematic';

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

// Per-chapter colour grade. Stock nature footage lives in a narrow green/blue
// band; rotating a low-opacity soft-light tint per section lets the palette
// drift across the episode (warm open → cool → teal → rose → dusk → forest) so
// eight minutes don't read as one flat colour. Tints stay subtle: the footage
// still reads true, the eye just registers the chapter has turned.
const CHAPTER_GRADES = [
  'rgba(255, 178, 92, 0.16)', // warm amber
  'rgba(86, 152, 255, 0.15)', // cool blue
  'rgba(104, 226, 196, 0.14)', // teal
  'rgba(255, 122, 138, 0.13)', // rose
  'rgba(178, 150, 255, 0.14)', // violet dusk
  'rgba(150, 214, 120, 0.13)', // forest
];

// A shot is an "accent" candidate when a spoken figure (a token with a digit)
// falls inside its window — the factual beats the overlays also key off. Those
// get the emphasis push-in so the visuals punctuate the narration's hard facts.
function clipHasNumber(words: WordTiming[], startSec: number, endSec: number): boolean {
  return words.some(
    (w) => w.start >= startSec - 0.1 && w.start < endSec && /\d/.test(w.text),
  );
}

function KenBurnsClip({
  src,
  durationInFrames,
  motion,
  treatment,
}: {
  src: string;
  durationInFrames: number;
  motion: KenBurns;
  treatment: ClipTreatment;
}) {
  const frame = useCurrentFrame();
  const range = [0, durationInFrames];
  const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

  let scale: number;
  let tx = 0;
  let ty = 0;
  if (treatment === 'accent') {
    // Snap to a tighter framing in ~0.27s, then keep drifting in slowly: the
    // push reads as a deliberate beat on the figure, then settles so it holds.
    scale = interpolate(frame, [0, 8, durationInFrames], [1.0, 1.1, 1.14], clamp);
  } else if (treatment === 'cinematic') {
    // Establishing/closing shot: a near-still slow push, no pan, so the
    // letterboxed frame feels composed and gives the eye somewhere to rest.
    scale = interpolate(frame, range, [1.03, 1.07], clamp);
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

// Thin top/bottom bars that ease in for a cinematic establishing/closing shot.
// Opacity-only so it stays compositor-cheap; reserved for two shots per episode
// (the first section's opener, the last section's closer) to stay an accent,
// not a recurring gimmick.
function LetterboxBars({ durationInFrames }: { durationInFrames: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const fadeF = Math.round(0.5 * fps);
  const opacity = interpolate(
    frame,
    [0, fadeF, durationInFrames - fadeF, durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );
  const bar: React.CSSProperties = {
    position: 'absolute',
    left: 0,
    right: 0,
    height: '8%',
    background: '#000',
  };
  return (
    <AbsoluteFill style={{ pointerEvents: 'none', opacity }}>
      <div style={{ ...bar, top: 0 }} />
      <div style={{ ...bar, bottom: 0 }} />
    </AbsoluteFill>
  );
}

export function SectionScene({ section, index, sectionCount }: SectionSceneProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const totalSec = section.duration + section.gapAfterSec;
  const sectionFrames = Math.round(totalSec * fps);
  const clips = section.brollPaths;
  const cutTimes =
    section.cutTimes && section.cutTimes.length === clips.length
      ? section.cutTimes
      : clips.map((_, i) => (i * totalSec) / Math.max(1, clips.length));

  const fadeIn = interpolate(frame, [0, 8], [0, 1], { extrapolateRight: 'clamp' });
  const gapStartFrame = Math.round(section.duration * fps);
  const gapFadeOut = interpolate(
    frame,
    [gapStartFrame, gapStartFrame + Math.round(section.gapAfterSec * fps)],
    [1, 0.55],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );

  const isEdgeSection = index === 0 || index === sectionCount - 1;
  const grade = CHAPTER_GRADES[index % CHAPTER_GRADES.length]!;

  // Resolve each shot's treatment once. The opener/closer's first shot is
  // cinematic; up to two figure-bearing shots per section get the punch-in; the
  // rest pan normally. Capping accents keeps the device meaningful, not constant.
  let accentsLeft = 2;
  const treatments: ClipTreatment[] = clips.map((_, i) => {
    if (isEdgeSection && i === 0) return 'cinematic';
    const startSec = cutTimes[i]!;
    const endSec = i + 1 < cutTimes.length ? cutTimes[i + 1]! : totalSec;
    if (accentsLeft > 0 && clipHasNumber(section.words, startSec, endSec)) {
      accentsLeft--;
      return 'accent';
    }
    return 'normal';
  });

  return (
    <AbsoluteFill style={{ backgroundColor: 'black', opacity: fadeIn }}>
      {clips.map((p, i) => {
        const startFrame = Math.round(cutTimes[i]! * fps);
        const nextStart =
          i + 1 < cutTimes.length ? Math.round(cutTimes[i + 1]! * fps) : sectionFrames;
        const durFrames = Math.max(1, nextStart - startFrame);
        // A slot the planner proved off-subject is replaced by a self-built
        // explainer card instead of shipping unrelated footage. The card text
        // is lifted from this section's narration upstream, so no Ken Burns
        // clip / letterbox here — the card is the whole frame.
        const card = section.shotCards?.[i];
        if (card) {
          return (
            <Sequence key={i} from={startFrame} durationInFrames={durFrames}>
              <FactCard spec={card} />
            </Sequence>
          );
        }
        const motion = kenBurnsFor(i, index);
        const treatment = treatments[i]!;
        return (
          <Sequence key={i} from={startFrame} durationInFrames={durFrames}>
            <KenBurnsClip
              src={pathToSrc(p)}
              durationInFrames={durFrames}
              motion={motion}
              treatment={treatment}
            />
            {treatment === 'cinematic' ? <LetterboxBars durationInFrames={durFrames} /> : null}
          </Sequence>
        );
      })}
      {/* Per-chapter colour grade — blends with the footage, sits under the UI. */}
      <AbsoluteFill
        style={{ backgroundColor: grade, mixBlendMode: 'soft-light', pointerEvents: 'none' }}
      />
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
