import { AbsoluteFill } from 'remotion';
import type { ShortsManifest } from '../src/types';
import { ShortsScene } from './scenes/ShortsScene';

export const ShortsVideo: React.FC<{ manifest: ShortsManifest }> = ({ manifest }) => {
  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      <ShortsScene manifest={manifest} />
    </AbsoluteFill>
  );
};
