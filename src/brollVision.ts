import fs from 'node:fs';
import path from 'node:path';
import { ENABLE_BROLL_VISION_QA } from './config.js';
import { runClaudeCli } from './scriptGen.js';
import { log, run } from './utils.js';

// A relevance gate for downloaded b-roll. The metadata-only filter
// (filterAndRankByRelevance) can only read a provider's tags/slug, which are
// thin and sometimes wrong — so a clip can pass the text filter yet visually
// show the wrong thing. This samples one frame from the clip and asks the
// script-gen Claude CLI (which can read images) whether it actually depicts the
// narration shot. It is deliberately conservative: it only DROPS a clip the
// model can clearly confirm is unrelated, never on a borderline call.

// Where in the clip to sample the QA frame. Midpoint avoids the fade-in/letterbox
// at the very start and any tail black, landing on representative content.
const FRAME_AT_FRACTION = 0.5;
// Short cap so a QA call fails fast instead of inheriting the 20-min script-gen
// timeout — a single still verdict should take seconds.
const VISION_QA_TIMEOUT_MS = 90 * 1000;

// Parse the one-word verdict. Returns true ONLY when the reply clearly says FAIL
// and not PASS. Anything else — PASS, empty, or a rambling reply that mentions
// both — is treated as "do not reject": the gate is best-effort and must never
// starve a section over an ambiguous answer. Pure and exported for testing.
export function visionVerdictIsFail(out: string): boolean {
  return /\bFAIL\b/i.test(out) && !/\bPASS\b/i.test(out);
}

// The strict, conservative prompt. FAIL is reserved for footage that is CLEARLY
// unrelated to the shot, so an over-picky model can't push the section into the
// weaker stills fallback. Pure and exported for testing.
export function buildVisionPrompt(framePath: string, query: string): string {
  return `You are a relevance checker for a science documentary's B-roll footage.
Read the image file at: ${path.resolve(framePath)}
It is a single frame from a stock video clip meant to illustrate the narration shot: "${query}".
Reply FAIL only if the frame is CLEARLY unrelated to "${query}" — for example it shows a different kind of animal, plant or scene entirely, or an obviously generic shot (an unrelated landscape, a person, a city street, an office) with none of the intended subject visible.
If the frame plausibly shows the subject of "${query}" — even partially, stylized, blurred, dark, or from an unusual angle — reply PASS.
Reply with exactly one word: PASS or FAIL.`;
}

// Extract one JPEG frame at FRAME_AT_FRACTION of the clip. Downscaled — the
// model judges subject/scene, not sharpness, so a small frame is enough and
// keeps the read fast. Returns true if the frame file was written.
async function extractFrame(
  videoPath: string,
  durationSec: number,
  outPath: string,
): Promise<boolean> {
  const at = Math.max(0, durationSec * FRAME_AT_FRACTION);
  try {
    await run('ffmpeg', [
      '-y',
      '-loglevel',
      'error',
      '-ss',
      at.toFixed(2),
      '-i',
      videoPath,
      '-frames:v',
      '1',
      '-vf',
      'scale=640:-2',
      '-q:v',
      '4',
      outPath,
    ]);
    return fs.existsSync(outPath);
  } catch (e) {
    log(`B-roll vision QA: frame extract failed (${(e as Error).message})`);
    return false;
  }
}

// Returns true ONLY when a vision model can CLEARLY confirm the clip's midpoint
// frame is off-subject for `query` — the caller then drops the clip and tries
// the next candidate. Best-effort by design: disabled, any infra error, a frame
// it couldn't extract, or an ambiguous verdict all return FALSE (keep the clip),
// so the gate never starves a section below what the metadata-only pipeline
// would have shipped. Cleans up its temp frame.
export async function visionRejectsClip(
  videoPath: string,
  durationSec: number,
  query: string,
): Promise<boolean> {
  if (!ENABLE_BROLL_VISION_QA) return false;
  const framePath = videoPath.replace(/\.mp4$/i, '') + '.qa.jpg';
  const got = await extractFrame(videoPath, durationSec, framePath);
  if (!got) return false;
  try {
    const out = await runClaudeCli(buildVisionPrompt(framePath, query), {
      extraArgs: ['--allowedTools', 'Read'],
      timeoutMs: VISION_QA_TIMEOUT_MS,
    });
    const fail = visionVerdictIsFail(out);
    log(`B-roll vision QA "${query}": ${fail ? 'FAIL' : 'PASS'} (${out.trim().slice(0, 60)})`);
    return fail;
  } catch (e) {
    log(`B-roll vision QA unavailable, keeping clip (${(e as Error).message})`);
    return false;
  } finally {
    if (fs.existsSync(framePath)) {
      try {
        fs.unlinkSync(framePath);
      } catch {
        // best-effort cleanup of the intermediate QA frame
      }
    }
  }
}
