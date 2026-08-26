import fs from 'node:fs';
import path from 'node:path';
import { ENABLE_BROLL_AI_ART } from './config.js';
import { generateFluxImage, softenForModeration } from './flux.js';
import { runClaudeCli } from './scriptGen.js';
import { ensureDir, log } from './utils.js';
import type { BrollCard } from './types.js';

// Stylized AI illustration as the BACKGROUND of an explainer FactCard (opt-in,
// ENABLE_BROLL_AI_ART). This never replaces real footage — it only upgrades a
// slot the card decider (brollCards.ts) already turned into a FactCard because
// the footage was PROVEN off-subject. The card's on-screen text stays verbatim
// narration, so the illustration is decorative background only and invariant #1
// holds. Trust-safety is enforced two ways: the prompt forces a clearly
// NON-photoreal illustration (so it can't masquerade as real footage on a
// science channel), and a vision-QA gate drops anything with an anatomical error
// or that reads as a photo. Any gate-off / generation / QA failure returns null
// so the caller keeps the schematic card — a clean, invariant-safe fallback.
// Long-form only. Pure parts unit-tested in test/brollArt.test.ts.

// Long-form frame size.
const ART_W = 1920;
const ART_H = 1080;
const ART_QA_TIMEOUT_MS = 3 * 60 * 1000;

// Pure: the FLUX prompt for a card illustration, built from the card's own
// verbatim clause (headline) and subject (caption). Forces a flat, diagrammatic,
// clearly-illustrated look and bans any rendered text/number (the card's own
// verbatim text is the only wording on screen — invariant #1). Moderation-flagged
// wording (predation/threat, which topic selection now leans into) is softened
// via the shared helper so FLUX's safety classifier doesn't reject it. Exported
// for unit tests.
export function buildIllustrationPrompt(card: BrollCard): string {
  const subject = (card.caption ?? '').trim();
  const clause = card.headline.trim();
  const concept = subject ? `${subject} — ${clause}` : clause;
  const base =
    `${concept}. ` +
    `Flat vector scientific illustration, editorial infographic style, clean diagrammatic shapes, ` +
    `limited muted palette, subtle textured background, clearly a stylized illustration and NOT a ` +
    `photograph, no photorealism, simple centered composition with a clear central area, ` +
    `anatomically correct and true to the real species, ` +
    `no text, no letters, no words, no numbers, no captions, no watermark, no logo, no gore, no blood`;
  return softenForModeration(base);
}

// Pure: a verdict string counts as a drop only on a clear FAIL token. Exported
// for unit tests.
export function illustrationVerdictIsFail(out: string): boolean {
  return /\bFAIL\b/i.test(out);
}

// Vision QA: unlike the thumbnail (where an unavailable checker ACCEPTS the image
// because a cover must exist), an unverifiable illustration must NOT ship — the
// schematic card is a perfectly good invariant-safe fallback — so ANY QA failure
// or infra error DROPS the illustration (conservative by design).
async function passesArtQa(imgPath: string, card: BrollCard): Promise<boolean> {
  const subject = (card.caption ?? '').trim() || card.headline.trim();
  const prompt = `You are a quality checker for a science channel's explainer graphics.
Read the image file at: ${path.resolve(imgPath)}
It is a stylized illustration meant to depict: ${subject}.
Reply FAIL only if at least one of these is CLEARLY true:
- it shows a living creature with an obvious anatomical error (wrong number of legs, limbs, wings or eyes; fused, duplicated or missing body parts)
- it is photorealistic enough to be mistaken for a real photograph or video still
- it contains rendered text, letters, numbers, captions or a watermark
- the subject is unrecognizable or clearly not "${subject}"
Otherwise reply PASS. A clean, flat, stylized/diagrammatic illustration is exactly what we want.
Reply with exactly one word: PASS or FAIL.`;
  try {
    const out = await runClaudeCli(prompt, {
      extraArgs: ['--allowedTools', 'Read'],
      timeoutMs: ART_QA_TIMEOUT_MS,
    });
    const failed = illustrationVerdictIsFail(out);
    log(`B-roll art: QA verdict ${failed ? 'FAIL' : 'PASS'} (${out.trim().slice(0, 80)})`);
    return !failed;
  } catch (e) {
    log(`B-roll art: QA unavailable — dropping illustration (${(e as Error).message})`);
    return false;
  }
}

// Generates + QAs one illustration for a card. Returns the absolute image path on
// success, or null (gate off, generation failed, or QA dropped it) so the caller
// keeps the schematic card. The per-episode cap is enforced by the caller
// (pipeline), since it spans sections. Best-effort/non-fatal throughout.
export async function generateCardIllustration(
  card: BrollCard,
  runDir: string,
  seq: number,
): Promise<string | null> {
  if (!ENABLE_BROLL_AI_ART) return null;
  try {
    const dir = ensureDir(path.join(runDir, 'cardart'));
    const outPath = path.join(dir, `card_${seq}_${Date.now()}.jpg`);
    const ok = await generateFluxImage(buildIllustrationPrompt(card), outPath, ART_W, ART_H, undefined, 'B-roll art');
    if (!ok) return null;
    if (!(await passesArtQa(outPath, card))) {
      try {
        fs.unlinkSync(outPath);
      } catch {
        // best-effort cleanup
      }
      return null;
    }
    return outPath;
  } catch (e) {
    log(`B-roll art: illustration failed (continuing): ${(e as Error).message}`);
    return null;
  }
}
