import { Composition, getInputProps } from 'remotion';
import { MainVideo } from './MainVideo';
import { ShortsVideo } from './ShortsVideo';
import { FactCard } from './scenes/FactCard';
import type { BrollCard, RenderManifest, ShortsManifest } from '../src/types';

const FALLBACK_MANIFEST: RenderManifest = {
  series: 'Wild Earth Files',
  title: 'Untitled',
  hook: 'Did you know?',
  coldOpenVisualPath: '',
  intro: { durationSec: 0 },
  sections: [],
  interludes: [],
  outro: { durationSec: 6 },
  bgmPath: '',
  bgmVolume: 0.35,
  totalDuration: 30,
};

const FALLBACK_SHORTS: ShortsManifest = {
  series: 'Wild Earth Files',
  longTitle: 'Untitled',
  shortsTitle: 'Untitled #Shorts',
  hook: 'Did you know?',
  cardHook: 'Did you know?',
  sectionIdx: 0,
  audioPath: '',
  duration: 30,
  narrationSec: 27.4,
  outroSec: 2.6,
  brollPaths: [],
  cutTimes: [],
  words: [],
  bgmPath: '',
  bgmVolume: 0.35,
};

const FPS = 30;

// Standalone preview specs for the explainer-card compositions below — let
// `npm run studio` (and `remotion still`) eyeball the FactCard design in
// isolation, both the fact and stat variants.
const PREVIEW_FACT_CARD: BrollCard = {
  kind: 'fact',
  headline: 'It can survive temperatures that would freeze most life',
  caption: 'Tardigrade',
  accent: '#FFC24A',
};

const PREVIEW_STAT_CARD: BrollCard = {
  kind: 'stat',
  headline: '1,200',
  caption: 'Years Without Water',
  accent: '#34D399',
};

function isShortsManifest(m: RenderManifest | ShortsManifest | undefined): m is ShortsManifest {
  return !!m && 'sectionIdx' in m && 'duration' in m && !('sections' in m);
}

export const Root: React.FC = () => {
  const inputProps = getInputProps() as { manifest?: RenderManifest | ShortsManifest };
  const incoming = inputProps.manifest;

  const longManifest: RenderManifest = incoming && !isShortsManifest(incoming) ? incoming : FALLBACK_MANIFEST;
  const shortsManifest: ShortsManifest = incoming && isShortsManifest(incoming) ? incoming : FALLBACK_SHORTS;

  const longFrames = Math.max(30, Math.round(longManifest.totalDuration * FPS));
  const shortsFrames = Math.max(30, Math.round(shortsManifest.duration * FPS));

  return (
    <>
      <Composition
        id="MainVideo"
        component={MainVideo}
        durationInFrames={longFrames}
        fps={FPS}
        width={1920}
        height={1080}
        defaultProps={{ manifest: longManifest }}
      />
      <Composition
        id="ShortsVideo"
        component={ShortsVideo}
        durationInFrames={shortsFrames}
        fps={FPS}
        width={1080}
        height={1920}
        defaultProps={{ manifest: shortsManifest }}
      />
      <Composition
        id="FactCardFact"
        component={FactCard}
        durationInFrames={120}
        fps={FPS}
        width={1920}
        height={1080}
        defaultProps={{ spec: PREVIEW_FACT_CARD }}
      />
      <Composition
        id="FactCardStat"
        component={FactCard}
        durationInFrames={120}
        fps={FPS}
        width={1920}
        height={1080}
        defaultProps={{ spec: PREVIEW_STAT_CARD }}
      />
    </>
  );
};
