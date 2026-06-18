// --- count-up number animation ----------------------------------------------
// Stat cards and compare bars animate their figure from 0 up to the real value
// as the card reveals, so the data reads as a beat instead of a static number.
// Only the spoken value is ever shown — counting changes presentation, not data.
// Shared by the in-frame overlays (OverlayLayer) and the full-frame explainer
// cards (FactCard), so both animate a figure the same way.

export function easeOutCubic(p: number): number {
  const c = Math.max(0, Math.min(1, p));
  return 1 - Math.pow(1 - c, 3);
}

export function groupThousands(intPart: string): string {
  const neg = intPart.startsWith('-');
  const digits = neg ? intPart.slice(1) : intPart;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return neg ? `-${grouped}` : grouped;
}

export type ParsedStat = {
  prefix: string;
  suffix: string;
  value: number;
  decimals: number;
  grouped: boolean;
};

// Pulls the numeric core out of a stat string ("$1,200", "47%", "1986"),
// keeping any non-numeric prefix/suffix so it can be re-attached each frame.
export function parseStatNumber(text: string): ParsedStat | null {
  const m = text.match(/^(\D*?)(-?\d[\d,]*(?:\.\d+)?)(.*)$/s);
  if (!m) return null;
  const numStr = m[2] ?? '';
  const cleaned = numStr.replace(/,/g, '');
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  const dot = cleaned.indexOf('.');
  return {
    prefix: m[1] ?? '',
    suffix: m[3] ?? '',
    value,
    decimals: dot >= 0 ? cleaned.length - dot - 1 : 0,
    grouped: numStr.includes(','),
  };
}

export function renderCount(parsed: ParsedStat, progress: number): string {
  const current = parsed.value * easeOutCubic(progress);
  const [intPart, frac] = current.toFixed(parsed.decimals).split('.');
  const grouped = parsed.grouped ? groupThousands(intPart!) : intPart!;
  const body = frac !== undefined ? `${grouped}.${frac}` : grouped;
  return `${parsed.prefix}${body}${parsed.suffix}`;
}

// Stat-card text: counts the embedded number, leaving $/%/+ intact. A stat with
// no parseable number (rare) renders unchanged.
export function animatedStatText(text: string, progress: number): string {
  const parsed = parseStatNumber(text);
  return parsed ? renderCount(parsed, progress) : text;
}

// Compare-bar value: a plain number, grouped once it reaches the thousands.
export function animatedNumber(value: number, progress: number): string {
  const decimals = Number.isInteger(value) ? 0 : (String(value).split('.')[1]?.length ?? 0);
  return renderCount({ prefix: '', suffix: '', value, decimals, grouped: value >= 1000 }, progress);
}
