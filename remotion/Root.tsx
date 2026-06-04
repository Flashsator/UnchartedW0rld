import { Composition, getInputProps } from 'remotion';
import { MainVideo } from './MainVideo';
import { ShortsVideo } from './ShortsVideo';
import type { RenderManifest, ShortsManifest } from '../src/types';

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
    </>
  );
};
