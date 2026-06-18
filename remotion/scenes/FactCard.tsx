import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import type { BrollCard } from '../../src/types';
import { ICON_DICT } from '../../src/iconDict';
import { animatedStatText } from '../lib/countUp';

// A self-built, full-frame motion-graphic "explainer card" rendered into a
// b-roll slot that has no on-subject footage. Everything here is presentation:
// the text comes pre-built from the section's OWN narration (see brollCards.ts),
// so this component never invents data — it only animates a figure or clause it
// was handed. All motion is transform/opacity only (compositor-friendly).

const DEFAULT_ACCENT = '#FFE94A';
const FONT = '"Inter", "Helvetica Neue", system-ui, sans-serif';

// rgba() from a #RRGGBB hex so the accent can tint backgrounds at low alpha.
function hexA(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) || 0;
  const g = parseInt(h.slice(2, 4), 16) || 0;
  const b = parseInt(h.slice(4, 6), 16) || 0;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Fact headlines vary in length; scale the type so a short clause reads as a
// punch and a long one still fits two comfortable lines.
function headlineFactSize(text: string): number {
  const n = text.length;
  if (n <= 24) return 96;
  if (n <= 40) return 80;
  if (n <= 60) return 66;
  return 56;
}

// Best subject emoji for the card, matched over the caption + headline words
// (with light -s plural folding). Decorative only; absent for most subjects.
function findEmoji(spec: BrollCard): string | null {
  const text = `${spec.caption ?? ''} ${spec.headline}`.toLowerCase();
  for (const raw of text.split(/[^a-z]+/)) {
    if (!raw) continue;
    const word = raw.length > 3 && raw.endsWith('s') ? raw.slice(0, -1) : raw;
    if (ICON_DICT[word]) return ICON_DICT[word]!;
  }
  return null;
}

// Per-word cascade timing for a fact headline: word i fades + rises starting at
// CASCADE_START, each offset by CASCADE_STEP, over CASCADE_WINDOW. Every word
// clamps to rest (opacity 1, no lift) so the settled card is a static block.
const CASCADE_START = 0.2;
const CASCADE_STEP = 0.06;
const CASCADE_WINDOW = 0.4;
const WORD_RISE = 16;

export function FactCard({ spec }: { spec: BrollCard }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

  const accent = spec.accent || DEFAULT_ACCENT;
  const fade = interpolate(t, [0, 0.4], [0, 1], clamp);
  const lift = interpolate(t, [0, 0.5], [20, 0], clamp);
  const ruleScale = interpolate(t, [0.15, 0.75], [0, 1], clamp);
  const countProgress = interpolate(t, [0.25, 1.15], [0, 1], clamp);

  // Slow background drift: the accent wash translates + scales gently across the
  // whole card so it reads as living atmosphere, not a flat panel. Transform only.
  const driftX = interpolate(t, [0, 4], [0, -46], clamp);
  const driftScale = interpolate(t, [0, 4], [1.06, 1.14], clamp);
  // Gentle continuous float on the content block once it has settled, so a long
  // hold never looks frozen. Low amplitude, slow period; sin(0) = 0 at entry.
  const float = Math.sin(t * 0.9) * 5;
  // Emoji overshoot pop on entry, clamped to rest at scale 1.
  const emojiScale = interpolate(t, [0.1, 0.34, 0.5], [0.6, 1.08, 1], clamp);

  const emoji = findEmoji(spec);
  const isStat = spec.kind === 'stat';
  const factWords = isStat ? [] : spec.headline.split(/\s+/).filter(Boolean);

  return (
    <AbsoluteFill style={{ backgroundColor: '#0c0f0d' }}>
      {/* Accent-tinted wash so the card reads as part of the series palette. */}
      <AbsoluteFill
        style={{
          background: `linear-gradient(150deg, ${hexA(accent, 0.16)} 0%, rgba(12,15,13,0) 55%)`,
          transform: `translateX(${driftX}px) scale(${driftScale})`,
          transformOrigin: 'left center',
        }}
      />
      {/* Faint diagonal grain for texture, not a flat panel. */}
      <AbsoluteFill
        style={{
          backgroundImage:
            'repeating-linear-gradient(135deg, rgba(255,255,255,0.018) 0px, rgba(255,255,255,0.018) 1px, rgba(0,0,0,0) 1px, rgba(0,0,0,0) 4px)',
        }}
      />
      {/* Vignette to seat the text and match the cinematic footage around it. */}
      <AbsoluteFill
        style={{
          background:
            'radial-gradient(ellipse at center, rgba(0,0,0,0) 45%, rgba(0,0,0,0.55) 100%)',
        }}
      />

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
          {emoji ? (
            <div
              style={{
                fontSize: 96,
                lineHeight: 1,
                marginBottom: 26,
                transform: `scale(${emojiScale})`,
                transformOrigin: 'left center',
              }}
            >
              {emoji}
            </div>
          ) : null}

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
              fontSize: isStat ? 280 : headlineFactSize(spec.headline),
              lineHeight: isStat ? 0.95 : 1.08,
              color: '#FFFFFF',
              letterSpacing: isStat ? '-0.02em' : '-0.01em',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {isStat
              ? animatedStatText(spec.headline, countProgress)
              : factWords.map((word, i) => {
                  // Each word rises + fades in narration order, then clamps to rest.
                  const localT = t - (CASCADE_START + i * CASCADE_STEP);
                  const wordFade = interpolate(localT, [0, CASCADE_WINDOW], [0, 1], clamp);
                  const wordRise = interpolate(localT, [0, CASCADE_WINDOW], [WORD_RISE, 0], clamp);
                  return (
                    <span
                      key={i}
                      style={{
                        display: 'inline-block',
                        marginRight: '0.28em',
                        opacity: wordFade,
                        transform: `translateY(${wordRise}px)`,
                      }}
                    >
                      {word}
                    </span>
                  );
                })}
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}
