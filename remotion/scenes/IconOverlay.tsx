import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import type { IconEvent } from '../../src/types';

const HOLD_SEC = 1.8;

type IconOverlayProps = {
  events: IconEvent[];
};

type Style = 'pop' | 'slide' | 'orbit' | 'pulse';
type Corner = 'tr' | 'tl' | 'br' | 'bl';

const STYLES: Style[] = ['pop', 'slide', 'orbit', 'pulse'];
const CORNERS: Corner[] = ['tr', 'tl', 'tr', 'br'];

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function cornerPos(corner: Corner): React.CSSProperties {
  switch (corner) {
    case 'tr':
      return { right: 130, top: 130 };
    case 'tl':
      return { left: 130, top: 130 };
    case 'br':
      return { right: 130, bottom: 230 };
    case 'bl':
    default:
      return { left: 130, bottom: 230 };
  }
}

function SketchRing({ rel, hue }: { rel: number; hue: number }) {
  const total = 260;
  const dash = interpolate(rel, [0, 0.6], [total, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const fade = interpolate(rel, [0, 0.15, HOLD_SEC - 0.5, HOLD_SEC], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const rot = interpolate(rel, [0, HOLD_SEC], [-8, 6]);
  return (
    <svg
      viewBox="0 0 100 100"
      width={300}
      height={300}
      style={{
        position: 'absolute',
        left: '50%',
        top: '50%',
        transform: `translate(-50%, -50%) rotate(${rot}deg)`,
        opacity: fade * 0.85,
        pointerEvents: 'none',
      }}
    >
      <circle
        cx="50"
        cy="50"
        r="41"
        fill="none"
        stroke={`hsl(${hue}, 90%, 65%)`}
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={total}
        strokeDashoffset={dash}
        style={{ filter: 'drop-shadow(0 0 8px rgba(0,0,0,0.7))' }}
      />
    </svg>
  );
}

export function IconOverlay({ events }: IconOverlayProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;

  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      {events.map((ev, i) => {
        const rel = t - ev.start;
        if (rel < -0.05 || rel > HOLD_SEC) return null;
        const localFrame = Math.max(0, Math.round(rel * fps));

        const h = hashStr(ev.emoji + i);
        const style = STYLES[h % STYLES.length]!;
        const corner = CORNERS[h % CORNERS.length]!;
        const useSketch = (h >> 3) % 2 === 0;
        const hue = (h * 47) % 360;

        const pop = spring({
          frame: localFrame,
          fps,
          config: { damping: 9, mass: 0.6, stiffness: 180 },
        });
        const fade = interpolate(rel, [0, 0.15, HOLD_SEC - 0.4, HOLD_SEC], [0, 1, 1, 0], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        });

        let transform = '';
        if (style === 'pop') {
          const scale = interpolate(pop, [0, 1], [0.2, 1]);
          const drift = interpolate(rel, [0, HOLD_SEC], [0, -28]);
          transform = `translateY(${drift}px) scale(${scale})`;
        } else if (style === 'slide') {
          const slide = interpolate(pop, [0, 1], [120, 0]);
          const xSign = corner === 'tl' || corner === 'bl' ? -1 : 1;
          transform = `translateX(${slide * xSign}px) scale(${interpolate(pop, [0, 1], [0.6, 1])})`;
        } else if (style === 'orbit') {
          const scale = interpolate(pop, [0, 1], [0.3, 1]);
          const rot = interpolate(rel, [0, HOLD_SEC], [-25, 12]);
          const drift = interpolate(rel, [0, HOLD_SEC], [0, -20]);
          transform = `translateY(${drift}px) rotate(${rot}deg) scale(${scale})`;
        } else {
          const pulseT = Math.sin(rel * Math.PI * 2.2);
          const base = interpolate(pop, [0, 1], [0.3, 1]);
          const scale = base * (1 + pulseT * 0.06);
          const drift = interpolate(rel, [0, HOLD_SEC], [0, -18]);
          transform = `translateY(${drift}px) scale(${scale})`;
        }

        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              ...cornerPos(corner),
              width: 280,
              height: 280,
              opacity: fade,
            }}
          >
            {useSketch ? <SketchRing rel={rel} hue={hue} /> : null}
            <div
              style={{
                position: 'absolute',
                left: '50%',
                top: '50%',
                fontSize: 200,
                lineHeight: 1,
                transform: `translate(-50%, -50%) ${transform}`,
                filter: 'drop-shadow(0 10px 30px rgba(0,0,0,0.7))',
                fontFamily:
                  '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif',
              }}
            >
              {ev.emoji}
            </div>
          </div>
        );
      })}
    </AbsoluteFill>
  );
}
