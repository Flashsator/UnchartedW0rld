import fs from 'node:fs';
import path from 'node:path';
import { CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN } from './config.js';
import { ensureDir, log } from './utils.js';

// Shared Cloudflare Workers AI FLUX.2 [klein] 9B image generation, used by both
// the thumbnail cover (thumbnail.ts) and the b-roll explainer-card illustration
// fallback (brollArt.ts). The model takes multipart form fields and returns the
// image as a base64 string in JSON.
const FLUX_MODEL = '@cf/black-forest-labs/flux-2-klein-9b';
export const FLUX_STEPS = Number(process.env.FLUX_STEPS ?? 20);

// FLUX runs a safety classifier on the GENERATED image (error code 3030, "Your
// output has been flagged"). Violence/threat-leaning wording — predator, hunts,
// kill, prey, dark — steers the model toward aggressive/teeth/blood compositions
// the classifier then rejects, even with "no gore, no blood" appended. Soften
// those words BEFORE sending to FLUX so generation reliably passes. This is
// especially load-bearing now that topic selection is tuned toward predation /
// threat drama — exactly the wording the classifier dislikes. Pure and
// unit-tested; applies to the FLUX prompt only, never to stock-search queries
// (real keywords find better photos and those APIs have no such moderation).
const MODERATION_SOFTEN: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bpredators?\b/gi, 'hunter'],
  [/\bhunts\b/gi, 'stalks'],
  [/\bhunting\b/gi, 'stalking'],
  [/\bhunt\b/gi, 'stalk'],
  [/\bpreys?\b/gi, 'target'],
  [/\bkilling\b/gi, 'catching'],
  [/\bkiller\b/gi, 'hunter'],
  [/\bkills\b/gi, 'catches'],
  [/\bkill\b/gi, 'catch'],
  [/\battacks?\b/gi, 'approach'],
  [/\battacking\b/gi, 'approaching'],
  [/\bcorpse\b/gi, 'remains'],
  [/\bcarcass\b/gi, 'remains'],
  [/\bdeadly\b/gi, 'formidable'],
  [/\bdarkness\b/gi, 'twilight'],
  [/\bdark\b/gi, 'low-light'],
];

export function softenForModeration(prompt: string): string {
  return MODERATION_SOFTEN.reduce((s, [re, to]) => s.replace(re, to), prompt);
}

// Generates one image via FLUX and writes it to outPath. Returns true on
// success. Best-effort: returns false (never throws) on missing credentials, an
// HTTP error, or a response with no image field — so a caller can quietly fall
// back to its non-AI path. `label` prefixes the log lines so each caller's logs
// read sensibly.
export async function generateFluxImage(
  prompt: string,
  outPath: string,
  width: number,
  height: number,
  steps: number = FLUX_STEPS,
  label = 'FLUX',
): Promise<boolean> {
  if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN) return false;
  const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run/${FLUX_MODEL}`;
  try {
    const form = new FormData();
    form.append('prompt', prompt);
    form.append('width', String(width));
    form.append('height', String(height));
    form.append('steps', String(steps));
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}` },
      body: form,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as { result?: { image?: string } };
    const b64 = data.result?.image;
    if (!b64) throw new Error('response had no image field');
    ensureDir(path.dirname(outPath));
    fs.writeFileSync(outPath, Buffer.from(b64, 'base64'));
    log(`${label}: FLUX.2 [klein] 9B image generated`);
    return true;
  } catch (e) {
    log(`${label}: FLUX generation failed (${(e as Error).message})`);
    return false;
  }
}
