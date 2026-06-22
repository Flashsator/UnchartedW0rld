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

const MCLAMP = { extrapolateLeft: 'clamp' as const, extrapolateRight: 'clamp' as const };

// Abstract animated corner motif — the fallback when a section names no subject
// with a faithful emoji. Pure geometry (rings / orbit / bars / dashed ring) so
// it asserts no creature (invariant #1 safe) while still giving the corner a
// designed beat. Transform/opacity (+ SVG stroke) only, like SketchRing.
function CornerMotif({ rel, variant, hue }: { rel: number; variant: number; hue: number }) {
  const color = `hsl(${hue}, 90%, 65%)`;
  const shadow = 'drop-shadow(0 6px 18px rgba(0,0,0,0.6))';
  const appear = interpolate(rel, [0, 0.25], [0, 1], MCLAMP);
  const core = (size: number) => (
    <div
      style={{
        position: 'absolute',
        left: '50%',
        top: '50%',
        width: size,
        height: size,
        marginLeft: -size / 2,
        marginTop: -size / 2,
        borderRadius: '50%',
        background: color,
        boxShadow: `0 0 26px ${color}`,
        opacity: appear * 0.9,
        transform: `scale(${appear})`,
      }}
    />
  );

  // 0 — expanding pulse rings emitted from a steady core.
  if (variant === 0) {
    return (
      <>
        {[0, 0.5, 1].map((phase, i) => {
          const ring = (rel * 0.8 + phase) % 1.5;
          const scale = 0.35 + ring * 0.7;
          const op = ring < 1 ? interpolate(ring, [0, 1], [0.85, 0], MCLAMP) : 0;
          return (
            <div
              key={i}
              style={{
                position: 'absolute',
                left: '50%',
                top: '50%',
                width: 150,
                height: 150,
                marginLeft: -75,
                marginTop: -75,
                borderRadius: '50%',
                border: `3px solid ${color}`,
                opacity: op,
                transform: `scale(${scale})`,
                filter: shadow,
              }}
            />
          );
        })}
        {core(34)}
      </>
    );
  }

  // 1 — a dot orbiting a faint ring: continuous motion without emission.
  if (variant === 1) {
    const ang = rel * 2.0; // rad/sec
    const R = 64;
    const x = Math.cos(ang) * R;
    const y = Math.sin(ang) * R;
    return (
      <>
        <div
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            width: 150,
            height: 150,
            marginLeft: -75,
            marginTop: -75,
            borderRadius: '50%',
            border: `2px solid ${color}`,
            opacity: appear * 0.45,
            filter: shadow,
          }}
        />
        <div
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            width: 26,
            height: 26,
            marginLeft: -13,
            marginTop: -13,
            borderRadius: '50%',
            background: color,
            boxShadow: `0 0 22px ${color}`,
            opacity: appear,
            transform: `translate(${x}px, ${y}px) scale(${appear})`,
          }}
        />
        {core(18)}
      </>
    );
  }

  // 2 — four bars that rise and breathe: a schematic "measurement", no subject.
  if (variant === 2) {
    return (
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          transform: 'translate(-50%, -50%)',
          display: 'flex',
          alignItems: 'flex-end',
          gap: 14,
          height: 150,
          filter: shadow,
        }}
      >
        {[0, 1, 2, 3].map((b) => {
          const wave = 0.5 + 0.5 * Math.sin(rel * 3.0 + b * 0.8);
          const h = 36 + wave * 96;
          return (
            <div
              key={b}
              style={{
                width: 22,
                height: h,
                borderRadius: 6,
                background: color,
                opacity: appear * 0.92,
                transformOrigin: 'bottom',
              }}
            />
          );
        })}
      </div>
    );
  }

  // 3 — a slow rotating dashed ring: reads as "observe / scan", no emission.
  const rot = rel * 38; // deg/sec
  const draw = interpolate(rel, [0.05, 0.6], [0, 1], MCLAMP);
  return (
    <>
      <svg
        viewBox="0 0 100 100"
        width={170}
        height={170}
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          transform: `translate(-50%, -50%) rotate(${rot}deg)`,
          opacity: draw * 0.9,
          filter: shadow,
        }}
      >
        <circle
          cx="50"
          cy="50"
          r="44"
          fill="none"
          stroke={color}
          strokeWidth="2.4"
          strokeDasharray="10 9"
          strokeLinecap="round"
        />
      </svg>
      {core(20)}
    </>
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

        const h = hashStr((ev.emoji ?? `motif${ev.motif}`) + i);
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
            {ev.emoji ? (
              <>
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
              </>
            ) : (
              <CornerMotif rel={rel} variant={ev.motif ?? 0} hue={hue} />
            )}
          </div>
        );
      })}
    </AbsoluteFill>
  );
}
