import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import type { BrollCard } from '../../src/types';
import { collectCardIcons } from '../../src/iconDict';
import { animatedStatText } from '../lib/countUp';

// A self-built, full-frame motion-graphic "explainer card" rendered into a
// b-roll slot that has no on-subject footage. Everything here is presentation:
// the text comes pre-built from the section's OWN narration (see brollCards.ts),
// so this component never invents data — it only animates a figure or clause it
// was handed. Subject emoji are decorative (they depict a subject the narration
// already names; see iconDict.ts). The layout adapts to how many subjects the
// clause names so a process beat reads as a tiny SCHEMATIC, not a text slide:
//   2 icons → a relation diagram (A → B with a drawn connector + travelling pulse)
//   1 icon → a focal node with concentric pulse rings
//   0 icons → an editorial text card with the key word accented
// All motion is transform/opacity only (compositor-friendly) and clamps to rest.

const DEFAULT_ACCENT = '#FFC24A';
const FONT = '"Inter", "Helvetica Neue", system-ui, sans-serif';
type Clamp = { extrapolateLeft: 'clamp'; extrapolateRight: 'clamp' };
const CLAMP: Clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' };

// rgba() from a #RRGGBB hex so the accent can tint backgrounds at low alpha.
function hexA(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) || 0;
  const g = parseInt(h.slice(2, 4), 16) || 0;
  const b = parseInt(h.slice(4, 6), 16) || 0;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Fact headlines vary in length; scale the type so a short clause reads as a
// punch and a long one still fits comfortably. `compact` shrinks the scale for
// the diagram/focal layouts where the clause sits under a graphic.
function factSize(text: string, compact: boolean): number {
  const n = text.length;
  if (compact) {
    if (n <= 32) return 60;
    if (n <= 56) return 50;
    return 44;
  }
  if (n <= 24) return 96;
  if (n <= 40) return 80;
  if (n <= 60) return 66;
  return 56;
}

// Per-word cascade timing for a clause: word i fades + rises starting at
// CASCADE_START, each offset by CASCADE_STEP, over CASCADE_WINDOW. Every word
// clamps to rest (opacity 1, no lift) so the settled card is a static block.
const CASCADE_START = 0.2;
const CASCADE_STEP = 0.06;
const CASCADE_WINDOW = 0.4;
const WORD_RISE = 16;

// Index of the single longest content word, to accent it on the text layout.
// Pure highlight of an existing word — no rewording (invariant #1 holds).
function emphasisIndex(words: readonly string[]): number {
  let best = -1;
  let bestLen = 4; // ignore short function words
  words.forEach((w, i) => {
    const len = w.replace(/[^A-Za-z]/g, '').length;
    if (len > bestLen) {
      bestLen = len;
      best = i;
    }
  });
  return best;
}

// A clause rendered as a per-word cascade. `align` and `emphasizeLongest` let
// the same primitive serve the centered diagram/focal clauses and the
// left-aligned editorial text card.
function WordCascade({
  text,
  t,
  fontSize,
  accent,
  align,
  emphasizeLongest = false,
  startAt = CASCADE_START,
}: {
  text: string;
  t: number;
  fontSize: number;
  accent: string;
  align: 'left' | 'center';
  emphasizeLongest?: boolean;
  startAt?: number;
}) {
  const words = text.split(/\s+/).filter(Boolean);
  const hi = emphasizeLongest ? emphasisIndex(words) : -1;
  return (
    <div
      style={{
        fontFamily: FONT,
        fontWeight: 800,
        fontSize,
        lineHeight: 1.1,
        color: '#FFFFFF',
        letterSpacing: '-0.01em',
        textAlign: align,
      }}
    >
      {words.map((word, i) => {
        const localT = t - (startAt + i * CASCADE_STEP);
        const wordFade = interpolate(localT, [0, CASCADE_WINDOW], [0, 1], CLAMP);
        const wordRise = interpolate(localT, [0, CASCADE_WINDOW], [WORD_RISE, 0], CLAMP);
        return (
          <span
            key={i}
            style={{
              display: 'inline-block',
              marginRight: '0.28em',
              opacity: wordFade,
              transform: `translateY(${wordRise}px)`,
              color: i === hi ? accent : undefined,
            }}
          >
            {word}
          </span>
        );
      })}
    </div>
  );
}

// A subject emoji seated in an accent ring. Pops in (overshoot) at `delay`, then
// breathes gently so a long hold never freezes. Transform/opacity only.
function IconNode({
  emoji,
  accent,
  t,
  size,
  delay,
}: {
  emoji: string;
  accent: string;
  t: number;
  size: number;
  delay: number;
}) {
  const lt = t - delay;
  const pop = interpolate(lt, [0, 0.22, 0.34], [0.5, 1.1, 1], CLAMP);
  const breath = 1 + Math.sin(Math.max(0, lt) * 1.4) * 0.012;
  const fade = interpolate(lt, [0, 0.2], [0, 1], CLAMP);
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: `radial-gradient(circle at 50% 42%, ${hexA(accent, 0.22)} 0%, rgba(10,12,14,0.9) 70%)`,
        border: `4px solid ${accent}`,
        boxShadow: `0 0 60px ${hexA(accent, 0.35)}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        opacity: fade,
        transform: `scale(${pop * breath})`,
      }}
    >
      <div style={{ fontSize: size * 0.5, lineHeight: 1 }}>{emoji}</div>
    </div>
  );
}

// The accent kicker + underline shared by the centered (icon) layouts.
function Kicker({ label, accent, t }: { label: string; accent: string; t: number }) {
  const ruleScale = interpolate(t, [0.15, 0.7], [0, 1], CLAMP);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: 30 }}>
      {label ? (
        <div
          style={{
            fontFamily: FONT,
            fontWeight: 700,
            fontSize: 30,
            color: accent,
            letterSpacing: '0.24em',
            textTransform: 'uppercase',
            marginBottom: 18,
            textAlign: 'center',
          }}
        >
          {label}
        </div>
      ) : null}
      <div
        style={{
          width: 120,
          height: 4,
          background: accent,
          transform: `scaleX(${ruleScale})`,
        }}
      />
    </div>
  );
}

// Two subject nodes joined by a connector that draws in, then emits a travelling
// pulse from A to B — a schematic of the process the clause describes. The
// arrow's direction follows narration order (the actor is named first), so it
// reads as flow without asserting any new claim.
const NODE = 230;
const CONNECTOR = 360;
function RelationDiagram({ icons, accent, t }: { icons: string[]; accent: string; t: number }) {
  const lineScale = interpolate(t, [0.55, 1.0], [0, 1], CLAMP);
  const headFade = interpolate(t, [0.98, 1.18], [0, 1], CLAMP);
  // Travelling pulse: repeats after the line is drawn; opacity arcs 0→1→0 so it
  // reads as a packet emitted at A and absorbed at B.
  const pulseT = Math.max(0, t - 1.05);
  const cycle = (pulseT * 0.5) % 1;
  const pulseX = cycle * CONNECTOR;
  const pulseOpacity = t > 1.05 ? Math.sin(cycle * Math.PI) : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <IconNode emoji={icons[0]!} accent={accent} t={t} size={NODE} delay={0.12} />
      <div style={{ width: CONNECTOR, height: NODE, position: 'relative' }}>
        {/* drawn connector line */}
        <div
          style={{
            position: 'absolute',
            top: NODE / 2 - 2,
            left: 0,
            width: CONNECTOR,
            height: 4,
            background: hexA(accent, 0.85),
            transform: `scaleX(${lineScale})`,
            transformOrigin: 'left center',
          }}
        />
        {/* arrowhead at B */}
        <div
          style={{
            position: 'absolute',
            top: NODE / 2 - 13,
            left: CONNECTOR - 18,
            width: 0,
            height: 0,
            borderTop: '13px solid transparent',
            borderBottom: '13px solid transparent',
            borderLeft: `20px solid ${accent}`,
            opacity: headFade,
          }}
        />
        {/* travelling pulse packet */}
        <div
          style={{
            position: 'absolute',
            top: NODE / 2 - 9,
            left: -9,
            width: 18,
            height: 18,
            borderRadius: '50%',
            background: accent,
            boxShadow: `0 0 22px ${hexA(accent, 0.9)}`,
            opacity: pulseOpacity,
            transform: `translateX(${pulseX}px)`,
          }}
        />
      </div>
      <IconNode emoji={icons[1]!} accent={accent} t={t} size={NODE} delay={0.3} />
    </div>
  );
}

// Deterministic 0..2 from the clause text so the focal motif varies card-to-card
// across one episode — a single-subject episode (e.g. owls) otherwise repeats the
// identical focal graphic with only the caption changing — while staying stable
// for a given card. Pure.
function focalVariant(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h % 3;
}

// The accent treatment ringing a focal node. Three motifs so repeated focal
// cards don't look identical, and so the outward "sonar" emission (which reads as
// sound and rarely matches the clause) is only ONE of three rather than every
// card. All transform/opacity (compositor-friendly). Variants 1/2 keep a gentle
// continuous ambient motion (breath / slow rotation) — like the card's existing
// float/breath — so a long hold never freezes, never a layout-bound property.
const FOCAL = 300;
function FocalMotif({ accent, t, variant }: { accent: string; t: number; variant: number }) {
  // 0 — expanding concentric rings: a focal pulse (the original look).
  if (variant === 0) {
    return (
      <>
        {[0, 0.5, 1].map((phase, i) => {
          const ring = (t * 0.45 + phase) % 1.5; // staggered, repeating 0→1.5
          const ringScale = 1 + ring * 0.9;
          const ringOpacity = ring < 1 ? interpolate(ring, [0, 1], [0.35, 0], CLAMP) : 0;
          return (
            <div
              key={i}
              style={{
                position: 'absolute',
                width: FOCAL,
                height: FOCAL,
                borderRadius: '50%',
                border: `3px solid ${accent}`,
                opacity: ringOpacity,
                transform: `scale(${ringScale})`,
              }}
            />
          );
        })}
      </>
    );
  }
  // 1 — a steady halo that breathes in place: spotlight, no outward emission.
  if (variant === 1) {
    const breath = 1 + Math.sin(t * 1.1) * 0.03;
    const glow = interpolate(t, [0, 0.6], [0, 1], CLAMP);
    return (
      <>
        <div
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            width: FOCAL * 1.2,
            height: FOCAL * 1.2,
            borderRadius: '50%',
            background: `radial-gradient(circle, ${hexA(accent, 0.18)} 0%, rgba(0,0,0,0) 68%)`,
            opacity: glow,
            transform: `translate(-50%, -50%) scale(${breath})`,
          }}
        />
        <div
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            width: FOCAL,
            height: FOCAL,
            borderRadius: '50%',
            border: `2px solid ${hexA(accent, 0.55)}`,
            opacity: glow,
            transform: 'translate(-50%, -50%)',
          }}
        />
      </>
    );
  }
  // 2 — a slow rotating dashed ring: reads as "observe / focus", not emit.
  const rot = t * 34; // deg/sec, gentle
  const draw = interpolate(t, [0.1, 0.7], [0, 1], CLAMP);
  return (
    <svg
      viewBox="0 0 100 100"
      width={FOCAL * 1.12}
      height={FOCAL * 1.12}
      style={{
        position: 'absolute',
        left: '50%',
        top: '50%',
        transform: `translate(-50%, -50%) rotate(${rot}deg)`,
        opacity: draw,
      }}
    >
      <circle
        cx="50"
        cy="50"
        r="46"
        fill="none"
        stroke={accent}
        strokeWidth="1.6"
        strokeDasharray="9 8"
        strokeLinecap="round"
      />
    </svg>
  );
}

// One subject node seated inside one of the focal motifs above — a focal
// "here is the subject" beat for a clause that names a single creature/plant.
function FocalNode({
  emoji,
  accent,
  t,
  variant,
}: {
  emoji: string;
  accent: string;
  t: number;
  variant: number;
}) {
  return (
    <div style={{ position: 'relative', width: FOCAL, height: FOCAL, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <FocalMotif accent={accent} t={t} variant={variant} />
      <IconNode emoji={emoji} accent={accent} t={t} size={FOCAL * 0.74} delay={0.12} />
    </div>
  );
}

// Shared atmospheric backdrop: drifting accent wash + grain + vignette so the
// card reads as part of the cinematic footage around it, not a flat panel.
function CardBackdrop({ accent, t }: { accent: string; t: number }) {
  const driftX = interpolate(t, [0, 4], [0, -46], CLAMP);
  const driftScale = interpolate(t, [0, 4], [1.06, 1.14], CLAMP);
  return (
    <>
      <AbsoluteFill
        style={{
          background: `linear-gradient(150deg, ${hexA(accent, 0.16)} 0%, rgba(12,15,13,0) 55%)`,
          transform: `translateX(${driftX}px) scale(${driftScale})`,
          transformOrigin: 'left center',
        }}
      />
      <AbsoluteFill
        style={{
          backgroundImage:
            'repeating-linear-gradient(135deg, rgba(255,255,255,0.018) 0px, rgba(255,255,255,0.018) 1px, rgba(0,0,0,0) 1px, rgba(0,0,0,0) 4px)',
        }}
      />
      <AbsoluteFill
        style={{
          background:
            'radial-gradient(ellipse at center, rgba(0,0,0,0) 45%, rgba(0,0,0,0.55) 100%)',
        }}
      />
    </>
  );
}

export function FactCard({ spec }: { spec: BrollCard }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;

  const accent = spec.accent || DEFAULT_ACCENT;
  const fade = interpolate(t, [0, 0.4], [0, 1], CLAMP);
  const lift = interpolate(t, [0, 0.5], [20, 0], CLAMP);
  const float = Math.sin(t * 0.9) * 5; // gentle settle float so a long hold isn't frozen

  const isStat = spec.kind === 'stat';
  // Icons follow the on-screen clause (spec.headline), NOT the subject carried in
  // the caption. Keying off the caption injected the SAME subject emoji into every
  // card of a single-subject episode (e.g. an owl episode), so every fact card
  // landed on the 1-icon focal layout and rendered an identical graphic with only
  // the text changing. Off the verbatim clause the visual matches the words shown
  // and varies naturally across the episode (two named subjects → relation diagram,
  // one → focal node, none → editorial text). The caption still labels the subject.
  const icons = collectCardIcons(spec.headline, 2);

  // Stat → big count-up number (the figure is the star); a focal icon is wrong
  // for a number, so stats stay the editorial left block.
  if (isStat) {
    const countProgress = interpolate(t, [0.25, 1.15], [0, 1], CLAMP);
    const ruleScale = interpolate(t, [0.15, 0.75], [0, 1], CLAMP);
    return (
      <AbsoluteFill style={{ backgroundColor: '#0A0C0E' }}>
        <CardBackdrop accent={accent} t={t} />
        <AbsoluteFill
          style={{
            justifyContent: 'center',
            alignItems: 'flex-start',
            padding: '0 160px',
            opacity: fade,
            transform: `translateY(${lift + float}px)`,
          }}
        >
          <div style={{ maxWidth: 1500 }}>
            {spec.caption ? (
              <div
                style={{
                  fontFamily: FONT,
                  fontWeight: 700,
                  fontSize: 30,
                  color: accent,
                  letterSpacing: '0.24em',
                  textTransform: 'uppercase',
                  marginBottom: 22,
                }}
              >
                {spec.caption}
              </div>
            ) : null}
            <div
              style={{
                width: 140,
                height: 4,
                background: accent,
                marginBottom: 34,
                transform: `scaleX(${ruleScale})`,
                transformOrigin: 'left center',
              }}
            />
            <div
              style={{
                fontFamily: FONT,
                fontWeight: 800,
                fontSize: 280,
                lineHeight: 0.95,
                color: '#FFFFFF',
                letterSpacing: '-0.02em',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {animatedStatText(spec.headline, countProgress)}
            </div>
          </div>
        </AbsoluteFill>
      </AbsoluteFill>
    );
  }

  // Fact with two named subjects → a relation/process diagram.
  if (icons.length >= 2) {
    return (
      <AbsoluteFill style={{ backgroundColor: '#0A0C0E' }}>
        <CardBackdrop accent={accent} t={t} />
        <AbsoluteFill
          style={{
            justifyContent: 'center',
            alignItems: 'center',
            padding: '0 140px',
            opacity: fade,
            transform: `translateY(${lift + float}px)`,
          }}
        >
          <Kicker label={spec.caption ?? ''} accent={accent} t={t} />
          <RelationDiagram icons={icons} accent={accent} t={t} />
          <div style={{ maxWidth: 1300, marginTop: 56 }}>
            <WordCascade
              text={spec.headline}
              t={t}
              fontSize={factSize(spec.headline, true)}
              accent={accent}
              align="center"
              startAt={0.6}
            />
          </div>
        </AbsoluteFill>
      </AbsoluteFill>
    );
  }

  // Fact with one named subject → a focal node.
  if (icons.length === 1) {
    return (
      <AbsoluteFill style={{ backgroundColor: '#0A0C0E' }}>
        <CardBackdrop accent={accent} t={t} />
        <AbsoluteFill
          style={{
            justifyContent: 'center',
            alignItems: 'center',
            padding: '0 140px',
            opacity: fade,
            transform: `translateY(${lift + float}px)`,
          }}
        >
          <Kicker label={spec.caption ?? ''} accent={accent} t={t} />
          <FocalNode emoji={icons[0]!} accent={accent} t={t} variant={focalVariant(spec.headline)} />
          <div style={{ maxWidth: 1300, marginTop: 48 }}>
            <WordCascade
              text={spec.headline}
              t={t}
              fontSize={factSize(spec.headline, true)}
              accent={accent}
              align="center"
              startAt={0.5}
            />
          </div>
        </AbsoluteFill>
      </AbsoluteFill>
    );
  }

  // Fact with no recognizable subject → editorial text card, key word accented.
  const ruleScale = interpolate(t, [0.15, 0.75], [0, 1], CLAMP);
  return (
    <AbsoluteFill style={{ backgroundColor: '#0A0C0E' }}>
      <CardBackdrop accent={accent} t={t} />
      <AbsoluteFill
        style={{
          justifyContent: 'center',
          alignItems: 'flex-start',
          padding: '0 160px',
          opacity: fade,
          transform: `translateY(${lift + float}px)`,
        }}
      >
        <div style={{ maxWidth: 1500 }}>
          {spec.caption ? (
            <div
              style={{
                fontFamily: FONT,
                fontWeight: 700,
                fontSize: 30,
                color: accent,
                letterSpacing: '0.24em',
                textTransform: 'uppercase',
                marginBottom: 22,
              }}
            >
              {spec.caption}
            </div>
          ) : null}
          <div
            style={{
              width: 140,
              height: 4,
              background: accent,
              marginBottom: 34,
              transform: `scaleX(${ruleScale})`,
              transformOrigin: 'left center',
            }}
          />
          <WordCascade
            text={spec.headline}
            t={t}
            fontSize={factSize(spec.headline, false)}
            accent={accent}
            align="left"
            emphasizeLongest
          />
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}
