import {
  AbsoluteFill,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import type { SectionOverlay, WordTiming } from '../../src/types';

const DEFAULT_HOLD_SEC = 3.4;
const FADE_IN_SEC = 0.35;
const FADE_OUT_SEC = 0.5;

const ACCENT = '#FFE94A';
const TEXT_PRIMARY = '#FFFFFF';
const TEXT_MUTED = 'rgba(255, 255, 255, 0.72)';
const PROTECTION = 'rgba(0, 0, 0, 0.42)';

type Anchor = 'mid-right' | 'mid-left' | 'top-right' | 'top-left';

type ResolvedOverlay = {
  overlay: SectionOverlay;
  startSec: number;
  endSec: number;
  anchor: Anchor;
};

function findTriggerSec(triggerWord: string, words: WordTiming[]): number | null {
  const needle = triggerWord.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!needle) return null;
  for (const w of words) {
    const norm = w.text.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (norm === needle) return w.start;
  }
  for (const w of words) {
    const norm = w.text.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (norm.includes(needle) || needle.includes(norm)) return w.start;
  }
  return null;
}

function pickAnchor(idx: number, sectionIdx: number): Anchor {
  const order: Anchor[] = ['mid-right', 'mid-left', 'top-right', 'top-left'];
  return order[(idx + sectionIdx) % order.length]!;
}

function anchorStyle(anchor: Anchor): React.CSSProperties {
  switch (anchor) {
    case 'mid-right':
      return { right: 120, top: '38%' };
    case 'mid-left':
      return { left: 120, top: '38%' };
    case 'top-right':
      return { right: 120, top: 180 };
    case 'top-left':
    default:
      return { left: 120, top: 180 };
  }
}

function ProtectionBlock({ width, height }: { width: number; height: number }) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        width,
        height,
        background: `radial-gradient(ellipse at center, ${PROTECTION} 0%, ${PROTECTION} 55%, rgba(0,0,0,0) 100%)`,
        pointerEvents: 'none',
      }}
    />
  );
}

function StatBody({ overlay }: { overlay: SectionOverlay }) {
  return (
    <div style={{ position: 'relative', width: 540, padding: '32px 36px' }}>
      <ProtectionBlock width={540} height={260} />
      <div style={{ position: 'relative' }}>
        <div style={{ width: 96, height: 2, background: ACCENT, marginBottom: 26 }} />
        <div
          style={{
            fontFamily: '"Inter", "Helvetica Neue", system-ui, sans-serif',
            fontWeight: 800,
            fontSize: 132,
            lineHeight: 1,
            color: TEXT_PRIMARY,
            letterSpacing: '-0.02em',
          }}
        >
          {overlay.text}
        </div>
        {overlay.subtext ? (
          <div
            style={{
              marginTop: 22,
              fontFamily: '"Inter", "Helvetica Neue", system-ui, sans-serif',
              fontWeight: 500,
              fontSize: 28,
              lineHeight: 1.25,
              color: TEXT_PRIMARY,
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
            }}
          >
            {overlay.subtext}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function LabelBody({ overlay }: { overlay: SectionOverlay }) {
  return (
    <div style={{ position: 'relative', width: 620, padding: '28px 32px' }}>
      <ProtectionBlock width={620} height={170} />
      <div style={{ position: 'relative', display: 'flex', gap: 22 }}>
        <div style={{ width: 4, alignSelf: 'stretch', background: ACCENT }} />
        <div>
          <div
            style={{
              fontFamily: '"Inter", "Helvetica Neue", system-ui, sans-serif',
              fontWeight: 800,
              fontSize: 64,
              lineHeight: 1.05,
              color: TEXT_PRIMARY,
              letterSpacing: '0.02em',
              textTransform: 'uppercase',
            }}
          >
            {overlay.text}
          </div>
          {overlay.subtext ? (
            <div
              style={{
                marginTop: 12,
                fontFamily: '"Inter", "Helvetica Neue", system-ui, sans-serif',
                fontWeight: 500,
                fontSize: 26,
                color: TEXT_MUTED,
                letterSpacing: '0.06em',
              }}
            >
              {overlay.subtext}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// Bars are scaled to the larger of the two REAL magnitudes (the sanitizer has
// already verified both numbers are spoken in the narration), so the longer bar
// fills the row and the shorter is its honest proportion.
function CompareBody({ overlay, fillProgress }: { overlay: SectionOverlay; fillProgress: number }) {
  const leftV = overlay.compareLeftValue ?? 50;
  const rightV = overlay.compareRightValue ?? 50;
  const max = Math.max(leftV, rightV, 1);
  const leftPct = (leftV / max) * 100 * fillProgress;
  const rightPct = (rightV / max) * 100 * fillProgress;
  return (
    <div style={{ position: 'relative', width: 640, padding: '28px 32px' }}>
      <ProtectionBlock width={640} height={250} />
      <div style={{ position: 'relative' }}>
        <div
          style={{
            fontFamily: '"Inter", "Helvetica Neue", system-ui, sans-serif',
            fontWeight: 600,
            fontSize: 24,
            color: TEXT_PRIMARY,
            letterSpacing: '0.22em',
            textTransform: 'uppercase',
          }}
        >
          {overlay.compareLabel ?? ''}
        </div>
        <div style={{ width: '100%', height: 2, background: ACCENT, marginTop: 14, marginBottom: 28 }} />
        <CompareRow label={overlay.text} pct={leftPct} />
        <div style={{ height: 18 }} />
        <CompareRow label={overlay.compareWith ?? ''} pct={rightPct} />
      </div>
    </div>
  );
}

function CompareRow({ label, pct }: { label: string; pct: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
      <div
        style={{
          width: 110,
          fontFamily: '"Inter", "Helvetica Neue", system-ui, sans-serif',
          fontWeight: 700,
          fontSize: 28,
          color: TEXT_PRIMARY,
          letterSpacing: '0.04em',
        }}
      >
        {label}
      </div>
      <div style={{ flex: 1, height: 14, background: 'rgba(255,255,255,0.14)', position: 'relative' }}>
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            height: '100%',
            width: `${pct}%`,
            background: ACCENT,
          }}
        />
      </div>
    </div>
  );
}

type OverlayLayerProps = {
  overlays: SectionOverlay[];
  words: WordTiming[];
  sectionIdx: number;
};

export function OverlayLayer({ overlays, words, sectionIdx }: OverlayLayerProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;

  if (!overlays || overlays.length === 0) return null;

  const resolved: ResolvedOverlay[] = overlays
    .map((overlay, i) => {
      const startSec = findTriggerSec(overlay.triggerWord, words);
      if (startSec === null) return null;
      const holdSec = overlay.holdSec ?? DEFAULT_HOLD_SEC;
      return {
        overlay,
        startSec,
        endSec: startSec + holdSec,
        anchor: pickAnchor(i, sectionIdx),
      };
    })
    .filter((r): r is ResolvedOverlay => r !== null);

  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      {resolved.map((r, i) => {
        const rel = t - r.startSec;
        const total = r.endSec - r.startSec;
        if (rel < -0.05 || rel > total) return null;

        const fade = interpolate(
          rel,
          [0, FADE_IN_SEC, total - FADE_OUT_SEC, total],
          [0, 1, 1, 0],
          { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
        );
        const drift = interpolate(rel, [0, total], [12, 0], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        });
        const fillProgress = interpolate(rel, [FADE_IN_SEC, FADE_IN_SEC + 0.6], [0, 1], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        });

        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              ...anchorStyle(r.anchor),
              opacity: fade,
              transform: `translateY(${drift}px)`,
            }}
          >
            {r.overlay.kind === 'stat' ? <StatBody overlay={r.overlay} /> : null}
            {r.overlay.kind === 'label' ? <LabelBody overlay={r.overlay} /> : null}
            {r.overlay.kind === 'compare' ? (
              <CompareBody overlay={r.overlay} fillProgress={fillProgress} />
            ) : null}
          </div>
        );
      })}
    </AbsoluteFill>
  );
}
