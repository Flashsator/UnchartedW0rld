import { spawn } from 'node:child_process';
import {
  SECTION_COUNT,
  TARGET_MINUTES,
  TARGET_WORDS,
  WORDS_PER_SECTION,
  type HookPattern,
  type Series,
  type Structure,
  type Voice,
} from './config.js';
import type { Episode, SectionOverlay } from './types.js';
import { log } from './utils.js';

const wordsLo = Math.max(20, Math.round(WORDS_PER_SECTION * 0.85));
const wordsHi = Math.round(WORDS_PER_SECTION * 1.4);

// Scripts have been coming back ~1/4 of the target length, which under-fills the
// runtime and starves retention. Reject anything egregiously short and let the
// existing retry take another pass; accept the last attempt regardless so the
// pipeline never stalls. 0.6 is lenient enough to pass once the model writes at
// a normal length, while still catching the ~300-word failures.
const MIN_TOTAL_WORDS = Math.round(TARGET_WORDS * 0.6);

function totalNarrationWords(ep: Episode): number {
  return ep.sections.reduce(
    (sum, s) => sum + (s.narration?.trim().split(/\s+/).filter(Boolean).length ?? 0),
    0,
  );
}

const PROMISE_TAIL_PHRASINGS: string[] = [
  "By the end of this video, you'll know <specific reveal> — and why almost no one talks about it.",
  "Stay with me. The part they leave out is the part that matters.",
  `In the next ${TARGET_MINUTES} minutes, we'll show you the detail every documentary skips.`,
  "What comes next is the part no documentary tells you.",
  "Before this video ends, you'll see why researchers stopped publishing about <specific thing>.",
  "Watch closely — there is a detail in this story almost everyone misses.",
  "By the last frame, you'll understand why this was almost never reported.",
  "Stay with me. The strangest part of this is not what you think it is.",
  "What we're about to show you was quietly confirmed and quietly forgotten.",
  "Keep watching — the implication at the end is the reason we made this.",
];

function pickHookPattern(structure: Structure): HookPattern {
  const pool = structure.hookPatterns;
  return pool[Math.floor(Math.random() * pool.length)]!;
}

// Normalizes a title to a set of meaningful word tokens for overlap scoring.
// Drops punctuation, lowercases, and removes short/common stop-words so the
// comparison keys on the topic nouns rather than filler.
const TITLE_STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'that',
  'this', 'why', 'how', 'what', 'when', 'is', 'was', 'are', 'were', 'be', 'no',
  'one', 'we', 'you', 'it', 'its', 'as', 'at', 'by', 'from', 'about',
]);

function titleTokens(title: string): Set<string> {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !TITLE_STOP_WORDS.has(w));
  return new Set(words);
}

// Jaccard similarity over the meaningful tokens of two titles (0–1).
function titleSimilarity(a: string, b: string): number {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  const union = ta.size + tb.size - shared;
  return union === 0 ? 0 : shared / union;
}

// A generated title collides with an already-published one when their
// meaningful-token overlap crosses this threshold — high enough to ignore
// incidental shared words, low enough to catch "same topic, reworded".
const TITLE_DUPLICATE_THRESHOLD = 0.5;

function findTitleCollision(title: string, avoidTitles: string[]): string | undefined {
  return avoidTitles.find((t) => titleSimilarity(title, t) >= TITLE_DUPLICATE_THRESHOLD);
}

function resolveSectionRoles(structure: Structure): string[] {
  const roles = structure.sectionRoles.slice(0, SECTION_COUNT);
  while (roles.length < SECTION_COUNT) {
    const idx = roles.length;
    const isLast = idx === SECTION_COUNT - 1;
    roles.push(
      isLast
        ? 'CLOSING IMPLICATION. One reflective line that lingers. Not a recap, not a CTA.'
        : 'CONTINUE. Add a layer of evidence or detail that escalates the previous section and ends on a hook into the next.',
    );
  }
  return roles;
}

function buildSystemPrompt(
  hook: HookPattern,
  structure: Structure,
  voice: Voice,
  subTheme: string,
): string {
  const roles = resolveSectionRoles(structure);
  const rolesBlock = roles
    .map((role, i) => `- Section ${i}: ${role}`)
    .join('\n');

  return `You write narration scripts for a daily YouTube mini-documentary channel called "Wild Anomalies". The channel publishes investigative discovery-style episodes about the living world — the strange biology, behavior, and survival strategies of animals, insects, and plants, from mammals and birds to insects and the plants that quietly break biology.

This episode's structural template: ${structure.label}
${structure.structuralMantra}

You always output ONE JSON object, nothing else. No markdown fences, no preface, no trailing commentary.

Shape:
{
  "title": "string, 50-70 chars, ${structure.label} framing, no clickbait lies",
  "hook": "string, 1 sentence, 8-14 words — the cold-open line of section 0",
  "description": "string, 600-1000 chars, YouTube description with 3 hashtags at the end. The FIRST sentence must state the single most surprising fact of the episode (the payoff) before any location or setup — it is the only line viewers see before the fold, so it must hook. Then expand.",
  "tags": ["10-15 single-word or 2-word tags. Include 3-4 BROAD high-search-volume terms a curious non-expert would actually type (e.g. 'weird animals', 'nature documentary', 'insect defense', 'did you know') alongside the precise scientific names — not only academic jargon"],
  "subject": "string, 1-3 words — the ONE concrete, photographable thing this whole episode is about (a creature, object, place, or person), e.g. 'cave spider', 'glass frog', 'Roman aqueduct'. This is the visual anchor for EVERY b-roll query below. Must be a real, searchable noun, not an abstract idea.",
  "thumbnailConcept": "string, 8-20 words — a SINGLE concrete, photographable real-world scene for the thumbnail background that instantly reads as this topic to a stranger AND is visually dramatic through CONTRAST: a bright, vividly-lit, sharply-focused subject that pops off the frame, saturated color, a tense moment or unexpected pose, crisp directional or rim light that sculpts the subject. The subject must stay BRIGHT and clearly visible — 'dramatic' must NOT mean a dark, dim, or muddy image; never bury the subject in shadow (it renders unreadable on a phone feed). Describe ONE clear subject + setting + lighting. NO abstract textures, NO extreme macro close-ups, NO collages, NO flat evenly-lit specimen shots, NO overall-dark scenes. Good: 'a single termite filling the frame, its back glowing vivid electric blue under crisp directional light, sharp against a clean contrasting background'. Bad: 'a termite on pale wood with a small blue patch, flat lighting', 'a dim dark moody scene', 'micro-detail biology', 'abstract neural patterns'.",
  "thumbnailWord": "string, ONE punchy uppercase word (3-8 letters) for the thumbnail caption — the single idea a viewer should feel. e.g., 'LISTEN', 'BURIED', 'WRONG'. Must NOT be a structural word like CASE/FILE/PROFILE.",
  "sections": [
    {
      "heading": "string, 3-6 words, what this beat is about",
      "narration": "string, ${wordsLo}-${wordsHi} words, ${structure.label} tone, no stage directions, no 'in this video', read aloud as natural English",
      "visual": "string, 6-12 words for this section's b-roll stock-footage search. MUST start with the episode \"subject\" so the footage shows it, then add this beat's scene/action/setting. e.g. subject 'cave spider' -> 'cave spider crawling on wet rock in dark cave'. NEVER an abstract or tangential query that drops the subject (no bare 'old library', 'laboratory', 'starry sky', 'flowing data').",
      "overlays": "optional array, 0-2 items, ONLY for sections 2, 3, 4, 5 — see Overlay Rules below"
    }
  ]
}

Overlay Rules (CRITICAL):
- ONLY sections at index 2, 3, 4, 5 may include overlays. Sections 0, 1, 6 MUST NOT include the "overlays" field at all (omit the key entirely).
- Each overlay is one of three kinds:
  * { "kind": "stat", "triggerWord": "<single word from this section's narration>", "text": "<short value, e.g., '47%', '1986', '12,000'>", "subtext": "<2-5 word context, e.g., 'OF FOSSILS MISIDENTIFIED'>" }
  * { "kind": "label", "triggerWord": "<single word from this section's narration>", "text": "<proper noun or term, e.g., 'TROGLORAPTOR'>", "subtext": "<short meta, e.g., 'genus · 2010'>" }
  * { "kind": "compare", "triggerWord": "<single word from this section's narration>", "compareLabel": "<2-3 word unit/metric title, e.g., 'VENOM (MG)'>", "text": "<left side label, e.g., 'JUVENILE'>", "compareWith": "<right side label, e.g., 'ADULT'>", "compareLeftValue": <real number stated in this section's narration>, "compareRightValue": <real number stated in this section's narration> }
- Use "compare" ONLY when the narration states TWO real numbers that measure the SAME thing in the SAME unit, so the bars are an honest proportion. compareLeftValue and compareRightValue MUST each appear verbatim as a number in this section's narration. If you do not have two such real numbers, use "stat" instead — never fabricate magnitudes to fill a bar.
- "triggerWord" MUST be an exact word that appears verbatim in that section's narration text (case-insensitive). Pick a meaningful word, not a generic one like "the" or "and".
- Maximum 2 overlays per section. Prefer 1 overlay if there is only one strong data point.
- An overlay may ONLY surface a number, percentage, date, name, or term that is actually stated in that section's narration. NEVER invent a figure, magnitude, or comparison value — no made-up percentages, no fabricated "X vs Y" bars. If the exact value is not spoken in the narration, do not create the overlay.
- If a section has no overlay-worthy content, omit the "overlays" field for that section.

Rules:
- Exactly ${SECTION_COUNT} sections.
- LENGTH IS MANDATORY. Total narration MUST be about ${TARGET_WORDS} words (±10%) across all ${SECTION_COUNT} sections combined — this is what fills the ~${TARGET_MINUTES}-minute video. Each section except the short closer must be a FULL ${wordsLo}-${wordsHi} words: develop the beat with 6-10 sentences of concrete detail — a named example, a figure, a vivid scene — not one terse paragraph. A script far under ${TARGET_WORDS} words is too short and will be rejected. Write long, specific narration, never a summary.
- Never break the fourth wall ("welcome back", "in today's video", "don't forget to subscribe" — handled separately).
- Cite specific numbers, species, places, dates where they sharpen the story.
- No emoji, no markdown inside narration.
- B-ROLL RELEVANCE (CRITICAL): every section's "visual" query must keep the "subject" visible. Lead each query with the subject noun, then vary the scene, action, or setting. The viewer should SEE the subject in most shots — not unrelated stock footage. If a beat is about history/discovery/data, still anchor on the subject (e.g. 'cave spider specimen under museum glass'), never a generic 'old archive' shot that drops it.

Sub-topic focus for this episode: ${subTheme}
- Pick one specific real subject that fits this sub-topic.
- Do NOT default to the most famous example in the field — pick something obscure, recently confirmed, half-forgotten, or quietly buried in literature.

Tone for this structural template:
- ${structure.toneInstruction}
- Avoid hype words ("incredible", "amazing", "mind-blowing"). Strangeness stays strange.
- Avoid happy-doc framings ("isn't nature wonderful"). Stay specific, restrained.

Title style:
- Stay in THIS episode's title frame — ${structure.titleStyleNote} Keep that voice; the frame is meant to vary episode to episode, so do NOT flatten every title into the same shape.
- Within that frame, SURFACE THE STAKES: the concrete subject and its single most surprising action, consequence, or outcome from this script must be present and prominent — a strong verb or a high-stakes noun. The frame is the wrapper; the shock is the payload. Never let generic wrapper words ("what … actually does", "the truth about …") fill the title while the surprising thing stays vague or hidden.
- Good — frame kept, shock visible: "The Termite That Explodes Itself to Kill Ants". Weak — wrapper with the shock buried: "What the Blue Crystals on This Termite's Back Actually Do".
- 50-70 chars. No clickbait lies — the payoff must be real and delivered in the script.
- Never invent specific institutions, document numbers, or named whistleblowers. Plausible and generic only.
- No exclamation marks. No emoji. No ALL CAPS except a single word for emphasis at most.

Narrator note:
- The narrator is ${voice.gender === 'female' ? 'a woman' : 'a man'} with ${voice.accent === 'gb' ? 'a British' : 'an American'} accent (${voice.label}). Avoid script lines that assume the opposite gender. Otherwise stay neutral first-person plural ("we") or second person ("you").

Opening rule (CRITICAL — TWO-PART OPEN, THIS RUN'S HOOK STYLE: "${hook.name}"):
- Sentence 1 of section 0 IS the hook. Style rule: ${hook.rule}
- Example of this style: "${hook.example}"
- The "hook" JSON field must match sentence 1 of section 0 verbatim.
- No "Did you know", no "welcome", no title card phrasing, no setup. Go straight in.

- Sentence 2 of section 0 is the PROMISE TAIL — a single sentence that tells the viewer what they will discover, framed as quietly withheld from public attention. Pick ONE phrasing from this list and adapt it to today's specific topic:
${PROMISE_TAIL_PHRASINGS.map((p) => `  * "${p}"`).join('\n')}
  Make the promise concrete and ominous, not generic.
- Sentence 3 onwards in section 0 begins the actual narrative as section 0's role specifies.

Per-section roles (every section, in order — follow EXACTLY):
${rolesBlock}

Pacing rules (every section):
- Vary sentence length — short, punchy clues mixed with longer descriptive stacks.
- Every section except the last ends on a hook into the next: an unresolved detail, a "but here is where it stops making sense", an unanswered question that the next section will pick up.
- Do NOT do mini-twists in every section. Follow the structural template above — the reversal / discovery / deepest layer happens at the section the template says, not earlier.
- Section 1 introduces the specific subject by name without explaining everything.`;
}

export async function generateEpisode(
  series: Series,
  structure: Structure,
  voice: Voice,
  subTheme: string,
  avoidTitles: string[] = [],
): Promise<{ episode: Episode; hookPattern: string }> {
  const hook = pickHookPattern(structure);
  // Feed recently-published titles to the model so it steers away from topics
  // we've already covered. Cap the list so the prompt stays bounded.
  const avoidBlock =
    avoidTitles.length > 0
      ? `\n\nAlready published on this channel — pick a DIFFERENT subject, do NOT cover any of these topics again:\n${avoidTitles
          .slice(0, 40)
          .map((t) => `- ${t}`)
          .join('\n')}`
      : '';
  const userPrompt = `Series: ${series.name}
Theme: ${series.theme}
Sub-topic focus: ${subTheme}
Structural template: ${structure.label} (${structure.key})

Pick ONE specific surprising topic within this sub-topic focus that fits a ${TARGET_MINUTES}-minute mini-documentary. Use the "${hook.name}" hook style for the opening. Follow the ${structure.label} per-section role specification exactly. Write the full script JSON now.${avoidBlock}`;

  const fullPrompt = `${buildSystemPrompt(hook, structure, voice, subTheme)}\n\n---\n\n${userPrompt}`;

  // Generation is stochastic and the CLI occasionally emits a malformed or
  // truncated payload; retry once before failing the whole pipeline. A title
  // that collides with an already-published topic also triggers a regenerate,
  // but we accept the last attempt regardless so the pipeline never stalls.
  let lastErr: Error | undefined;
  for (let attempt = 1; attempt <= SCRIPT_GEN_ATTEMPTS; attempt++) {
    log(
      `Generating script via Claude Code CLI for series "${series.name}" (hook: ${hook.name}, structure: ${structure.key}, sub-theme: ${subTheme}, attempt ${attempt}/${SCRIPT_GEN_ATTEMPTS})...`,
    );
    const raw = await runClaudeCli(fullPrompt);
    try {
      const parsed = parseEpisodeJson(raw);
      validateEpisode(parsed);
      const normalized = normalizeEpisode(parsed, series, subTheme);
      const collision = findTitleCollision(normalized.title, avoidTitles);
      const wordCount = totalNarrationWords(normalized);
      const tooShort = wordCount < MIN_TOTAL_WORDS;
      if ((collision || tooShort) && attempt < SCRIPT_GEN_ATTEMPTS) {
        if (collision) {
          log(
            `Topic collision: "${normalized.title}" overlaps already-published "${collision}". Regenerating (attempt ${attempt}/${SCRIPT_GEN_ATTEMPTS})...`,
          );
        }
        if (tooShort) {
          log(
            `Script only ${wordCount} words (floor ${MIN_TOTAL_WORDS} for ~${TARGET_WORDS}-word target). Regenerating (attempt ${attempt}/${SCRIPT_GEN_ATTEMPTS})...`,
          );
        }
        continue;
      }
      if (collision) {
        log(
          `Topic still overlaps "${collision}" after ${attempt} attempts; accepting to avoid stalling the pipeline.`,
        );
      }
      if (tooShort) {
        log(
          `Script still only ${wordCount} words after ${attempt} attempts; accepting to avoid stalling the pipeline.`,
        );
      }
      log(
        `Script: "${normalized.title}" — ${normalized.sections.length} sections, ${wordCount} words, ${normalized.tags.length} tags, desc ${normalized.description.length} chars`,
      );
      return { episode: normalized, hookPattern: hook.name };
    } catch (err) {
      lastErr = err as Error;
      log(`Script generation attempt ${attempt}/${SCRIPT_GEN_ATTEMPTS} failed: ${lastErr.message}`);
    }
  }
  throw lastErr ?? new Error('Script generation failed');
}

// Writes a fresh, punchy 1–2 sentence description for a Short via the same
// Claude CLI used for scripts. Shorts must NOT reuse the long video's full
// description. Non-fatal: any CLI failure falls back to the section hook's first
// sentence so the Short still uploads.
export async function generateShortsBlurb(
  shortTitle: string,
  hook: string,
  topic: string,
): Promise<string> {
  const fallback = hook.split(/(?<=[.!?])\s+/)[0]?.trim() || hook.trim();
  const prompt = `Write a YouTube Shorts description for the clip below.
Rules: one or two short sentences, under 180 characters total, punchy and curiosity-driven.
No hashtags, no links, no emojis, no surrounding quotation marks, no preface. Output ONLY the description text.

Title: ${shortTitle}
Hook: ${hook}${topic ? `\nTopic context: ${topic.slice(0, 400)}` : ''}`;
  try {
    const raw = (await runClaudeCli(prompt)).trim();
    const clean = raw
      .replace(/^["']|["']$/g, '')
      .replace(/#\S+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return clean || fallback;
  } catch (err) {
    log(`Shorts blurb generation failed, using hook: ${(err as Error).message}`);
    return fallback;
  }
}

function toHashtag(tag: string): string {
  const cleaned = tag.replace(/[^A-Za-z0-9]+/g, '');
  return cleaned ? `#${cleaned}` : '';
}

const OVERLAY_ALLOWED_SECTIONS = new Set([2, 3, 4, 5]);

// Every numeric figure spoken in the narration, normalized so "12,000", "47%"
// and "1850." all reduce to a bare comparable form ("12000", "47", "1850").
// Used to keep compare-overlay bar magnitudes honest: the model may only chart
// numbers it actually said, never invented 1-100 placeholders.
function spokenNumbers(narration: string): Set<string> {
  const out = new Set<string>();
  for (const m of narration.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const cleaned = m[0].replace(/,/g, '');
    const n = Number(cleaned);
    if (Number.isFinite(n)) out.add(String(n));
  }
  return out;
}

function sanitizeOverlay(raw: unknown, narration: string): SectionOverlay | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const kind = typeof o.kind === 'string' ? o.kind : '';
  if (kind !== 'stat' && kind !== 'label' && kind !== 'compare') return null;
  const triggerWord = typeof o.triggerWord === 'string' ? o.triggerWord.trim() : '';
  const text = typeof o.text === 'string' ? o.text.trim() : '';
  if (!triggerWord || !text) return null;
  const narrationLower = narration.toLowerCase();
  if (!narrationLower.includes(triggerWord.toLowerCase())) return null;
  const subtext = typeof o.subtext === 'string' ? o.subtext.trim() : undefined;
  if (kind === 'compare') {
    const compareWith = typeof o.compareWith === 'string' ? o.compareWith.trim() : '';
    const compareLabel = typeof o.compareLabel === 'string' ? o.compareLabel.trim() : '';
    const leftV = Number(o.compareLeftValue);
    const rightV = Number(o.compareRightValue);
    if (!compareWith || !compareLabel) return null;
    if (!Number.isFinite(leftV) || !Number.isFinite(rightV)) return null;
    if (leftV < 0 || rightV < 0) return null;
    // Both bar magnitudes must be real figures the narration actually states —
    // this is what stops the "YOUNG 20 / OLD 90" style fabricated bars. If
    // either value was invented, drop the overlay rather than chart a lie.
    const nums = spokenNumbers(narration);
    if (!nums.has(String(leftV)) || !nums.has(String(rightV))) return null;
    return {
      kind: 'compare',
      triggerWord,
      text,
      compareWith,
      compareLabel,
      compareLeftValue: leftV,
      compareRightValue: rightV,
    };
  }
  return { kind, triggerWord, text, subtext };
}

// The episode's visual anchor: the model's "subject" when usable, otherwise the
// most meaningful title tokens, falling back to the sub-theme. Kept short so it
// reads as a clean stock-search noun phrase.
function deriveSubject(ep: Episode, subTheme: string): string {
  const raw = typeof ep.subject === 'string' ? ep.subject.replace(/\s+/g, ' ').trim() : '';
  if (raw) return raw.slice(0, 60);
  const tokens = [...titleTokens(ep.title)];
  if (tokens.length > 0) return tokens.slice(0, 2).join(' ');
  return subTheme;
}

// Guarantees a section's b-roll query stays on-topic: if the model's "visual"
// already names the subject (or its head noun), leave it; otherwise prepend the
// subject so the stock search is biased toward footage that actually shows it.
function anchorVisual(visual: string, subject: string): string {
  const v = (visual ?? '').trim();
  if (!subject) return v;
  const subjLower = subject.toLowerCase();
  const head = subjLower.split(/\s+/).filter(Boolean).pop() ?? subjLower;
  const vLower = v.toLowerCase();
  if (vLower.includes(subjLower) || (head.length >= 4 && vLower.includes(head))) {
    return v;
  }
  return v ? `${subject} ${v}` : subject;
}

function normalizeEpisode(ep: Episode, series: Series, subTheme: string): Episode {
  const fallbackTags = [
    series.name.replace(/\s+/g, ''),
    subTheme.replace(/\s+/g, ''),
    'documentary',
    'shorts',
    'facts',
    'science',
  ];
  const rawTags = (ep.tags ?? []).map((t) => String(t).trim()).filter(Boolean);
  const tags = rawTags.length >= 5 ? rawTags : Array.from(new Set([...rawTags, ...fallbackTags]));

  const hashtags = tags
    .slice(0, 3)
    .map(toHashtag)
    .filter(Boolean)
    .join(' ');

  let description = (ep.description ?? '').trim();
  if (!description) {
    description = `${ep.hook}\n\nA short mini-documentary from Wild Anomalies on ${subTheme}.`;
  }
  if (hashtags && !/#[A-Za-z0-9]+/.test(description)) {
    description = `${description}\n\n${hashtags}`;
  }
  if (description.length > 4900) description = description.slice(0, 4900);

  const subject = deriveSubject(ep, subTheme);

  const sections = ep.sections.map((sec, i) => {
    // Anchor every section's b-roll query to the episode subject so the footage
    // stays on-topic even when the model writes an off-subject "visual".
    const base = { ...sec, visual: anchorVisual(sec.visual, subject) };
    if (!OVERLAY_ALLOWED_SECTIONS.has(i)) {
      const { overlays: _unused, ...rest } = base;
      void _unused;
      return rest;
    }
    const rawOverlays = Array.isArray(sec.overlays) ? sec.overlays : [];
    const clean = rawOverlays
      .map((o) => sanitizeOverlay(o, sec.narration))
      .filter((o): o is SectionOverlay => o !== null)
      .slice(0, 2);
    if (clean.length === 0) {
      const { overlays: _unused, ...rest } = base;
      void _unused;
      return rest;
    }
    return { ...base, overlays: clean };
  });

  const thumbnailConcept =
    typeof ep.thumbnailConcept === 'string' && ep.thumbnailConcept.trim()
      ? ep.thumbnailConcept.trim()
      : undefined;
  const thumbnailWord =
    typeof ep.thumbnailWord === 'string' && ep.thumbnailWord.trim()
      ? ep.thumbnailWord.trim().toUpperCase()
      : undefined;

  return { ...ep, subject, description, tags, sections, thumbnailConcept, thumbnailWord };
}

// Hard cap on the headless `claude` call. Generating a full long-form script is
// a single large completion that, in text mode, only prints once it finishes —
// so a too-tight cap looks identical to a hang (blank stdout, then SIGKILL).
// A short "say PONG" prompt returns instantly in the same CI env, so the cap
// only needs to cover real generation time. 20 min leaves ample headroom while
// still failing fast if the CLI is genuinely stuck.
const CLAUDE_CLI_TIMEOUT_MS = 20 * 60 * 1000;
// Emit an elapsed-time heartbeat so a long-running generation is visibly making
// progress (vs. a true hang) in CI logs, where text mode is otherwise silent.
const CLAUDE_HEARTBEAT_MS = 30 * 1000;
// One retry covers a single malformed/truncated generation without burning a
// whole CI run; more than that risks doubling an already ~18-min step for little
// additional payoff.
const SCRIPT_GEN_ATTEMPTS = 2;

// Pin the headless CLI to a fixed model so generation cost/quota is predictable
// and independent of whatever the account's default happens to be.
// To switch models, change this one line:
//   - 'claude-opus-4-8'    → highest quality, burns more quota
//   - 'claude-sonnet-4-6'  → faster, cheaper, plenty for documentary scripts
const CLAUDE_MODEL = 'claude-opus-4-8';

function runClaudeCli(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'text', '--model', CLAUDE_MODEL];
    const proc = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    const startedAt = Date.now();
    console.log(`[claude] spawned (prompt ${prompt.length} chars); waiting for completion…`);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(heartbeat);
      fn();
    };
    const heartbeat = setInterval(() => {
      const secs = Math.round((Date.now() - startedAt) / 1000);
      console.log(`[claude] still generating — ${secs}s elapsed, ${stdout.length} bytes received`);
    }, CLAUDE_HEARTBEAT_MS);
    // Kill a genuinely hung CLI and report what it managed to emit so the cause
    // is visible in the logs instead of a blank hang.
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      finish(() =>
        reject(
          new Error(
            `claude CLI timed out after ${CLAUDE_CLI_TIMEOUT_MS / 1000}s. ` +
              `stderr: ${stderr.slice(-1000) || '(empty)'} | stdout: ${stdout.slice(-500) || '(empty)'}`,
          ),
        ),
      );
    }, CLAUDE_CLI_TIMEOUT_MS);
    proc.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf-8');
    });
    proc.stderr.on('data', (c: Buffer) => {
      const s = c.toString('utf-8');
      stderr += s;
      // Stream live so the CI log shows progress/blockers in real time.
      process.stderr.write(s);
    });
    proc.on('error', (err) => finish(() => reject(err)));
    proc.on('close', (code) => {
      finish(() => {
        if (code !== 0) {
          reject(new Error(`claude CLI exited ${code}: ${stderr.slice(-500)}`));
          return;
        }
        const secs = Math.round((Date.now() - startedAt) / 1000);
        console.log(`[claude] completed in ${secs}s, ${stdout.length} bytes`);
        resolve(stdout.trim());
      });
    });
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

// Extracts every balanced, top-level {...} object from a string, tracking
// string literals and escapes so braces inside JSON strings never confuse the
// scanner. Returned in source order.
function extractBalancedObjects(s: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        objects.push(s.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return objects;
}

// Builds ordered JSON candidate strings from raw CLI output: fenced blocks
// first, then every balanced top-level object, then the whole trimmed string.
function extractJsonCandidates(raw: string): string[] {
  const candidates: string[] = [];
  const fenceRe = /```(?:json)?\s*([\s\S]+?)\s*```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(raw)) !== null) {
    const inner = m[1]!.trim();
    if (inner) candidates.push(inner);
  }
  candidates.push(...extractBalancedObjects(raw));
  const trimmed = raw.trim();
  if (trimmed) candidates.push(trimmed);
  return [...new Set(candidates)];
}

// Parses the CLI output into an Episode, tolerating preamble prose, code
// fences, and trailing text. Picks the largest candidate that parses and has
// the episode shape, so a short preamble object never wins over the real
// script. Throws with a raw-output snippet so failures stay diagnosable.
function parseEpisodeJson(raw: string): Episode {
  let best: Episode | undefined;
  let bestLen = -1;
  for (const candidate of extractJsonCandidates(raw)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as { sections?: unknown }).sections) &&
      candidate.length > bestLen
    ) {
      best = parsed as Episode;
      bestLen = candidate.length;
    }
  }
  if (!best) {
    const snippet = raw.length > 800 ? `${raw.slice(0, 800)}…` : raw;
    throw new Error(
      `Could not parse episode JSON from Claude CLI output (${raw.length} bytes). Raw output: ${snippet}`,
    );
  }
  return best;
}

function validateEpisode(ep: Episode): void {
  if (!ep.title || !ep.hook || !Array.isArray(ep.sections)) {
    throw new Error('Episode JSON missing required fields');
  }
  if (ep.sections.length < SECTION_COUNT - 1 || ep.sections.length > SECTION_COUNT + 1) {
    throw new Error(`Expected ~${SECTION_COUNT} sections, got ${ep.sections.length}`);
  }
  for (const [i, s] of ep.sections.entries()) {
    if (!s.heading || !s.narration || !s.visual) {
      throw new Error(`Section ${i} missing fields`);
    }
  }
}
