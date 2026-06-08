import { AbsoluteFill, Sequence } from 'remotion';
import type { RenderManifest } from '../src/types';
import { SectionScene } from './scenes/SectionScene';
import { AmbientBreather } from './scenes/AmbientBreather';
import { ColdOpen } from './scenes/ColdOpen';
import { Outro } from './scenes/Outro';

const FPS = 30;

export const MainVideo: React.FC<{ manifest: RenderManifest }> = ({ manifest }) => {
  const interludeByAfter = new Map<number, RenderManifest['interludes'][number]>();
  for (const il of manifest.interludes) interludeByAfter.set(il.afterSectionIndex, il);

  type Placement =
    | { kind: 'section'; start: number; frames: number; sec: RenderManifest['sections'][number]; index: number }
    | { kind: 'interlude'; start: number; frames: number; visualPath: string };

  const placements: Placement[] = [];
  let cursor = Math.round(manifest.intro.durationSec * FPS);

  for (let i = 0; i < manifest.sections.length; i++) {
    const sec = manifest.sections[i]!;
    const frames = Math.round((sec.duration + sec.gapAfterSec) * FPS);
    placements.push({ kind: 'section', start: cursor, frames, sec, index: i });
    cursor += frames;
    const il = interludeByAfter.get(i);
    if (il) {
      const ilFrames = Math.round(il.durationSec * FPS);
      placements.push({ kind: 'interlude', start: cursor, frames: ilFrames, visualPath: il.visualPath });
      cursor += ilFrames;
    }
  }

  const outroFrames = Math.round(manifest.outro.durationSec * FPS);
  const outroStart = cursor;

  const introFrames = Math.round(manifest.intro.durationSec * FPS);

  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      {introFrames > 0 ? (
        <Sequence from={0} durationInFrames={introFrames}>
          <ColdOpen visualPath={manifest.coldOpenVisualPath} hook={manifest.hook} />
        </Sequence>
      ) : null}
      {placements.map((p, k) => {
        if (p.kind === 'section') {
          return (
            <Sequence key={`sec-${k}`} from={p.start} durationInFrames={p.frames}>
              <SectionScene section={p.sec} index={p.index} />
            </Sequence>
          );
        }
        return (
          <Sequence key={`int-${k}`} from={p.start} durationInFrames={p.frames}>
            <AmbientBreather visualPath={p.visualPath} />
          </Sequence>
        );
      })}

      <Sequence from={outroStart} durationInFrames={outroFrames}>
        <Outro />
      </Sequence>
    </AbsoluteFill>
  );
};
