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
  "description": "string, 600-1000 chars, YouTube description with 3 hashtags at the end. The FIRST sentence must state the single most surprising fact of the episode (the payoff) before any location or setup — it is the only line viewers see before the fold, so it must hook. The first TWO sentences together must also naturally contain the subject's common name AND 1-2 phrases a curious viewer would actually type into YouTube search for this topic (e.g. 'how do cats drink water', 'why do termites explode') — woven into natural prose, NEVER a keyword list. Then expand.",
  "tags": ["10-15 single-word or 2-word tags. Include 3-4 BROAD high-search-volume terms a curious non-expert would actually type (e.g. 'weird animals', 'nature documentary', 'insect defense', 'did you know') alongside the precise scientific names — not only academic jargon"],
  "subject": "string, 1-3 words — the ONE concrete, photographable thing this whole episode is about (a creature, object, place, or person), e.g. 'cat', 'honeybee', 'octopus', 'Venus flytrap'. This is the visual anchor for EVERY b-roll query below. Must be a real, searchable noun, not an abstract idea. STOCK-FOOTAGE RULE (CRITICAL): pick a COMMON, widely-filmed creature that free stock libraries (Pexels, Pixabay) reliably have real video of — a familiar animal/insect/plant a stranger could picture instantly. Do NOT pick an obscure species stock libraries have never filmed (e.g. a rare bird like a 'chough', an unfilmed deep-sea worm); those force the b-roll onto generic unrelated scenery (random landscapes) because the providers fuzzy-match a no-result query. The SURPRISE must come from the ANGLE, not from an exotic subject: a familiar creature doing something almost nobody knows about.",
  "thumbnailConcept": "string, 8-20 words — a SINGLE concrete, photographable real-world scene for the thumbnail background that instantly reads as this topic to a stranger AND is visually dramatic through CONTRAST: a bright, vividly-lit, sharply-focused subject that pops off the frame, saturated color, a tense moment or unexpected pose, crisp directional or rim light that sculpts the subject. The subject must stay BRIGHT and clearly visible — 'dramatic' must NOT mean a dark, dim, or muddy image; never bury the subject in shadow (it renders unreadable on a phone feed). The subject must occupy a LARGE central portion of the frame (fill roughly half its width) so it stays instantly recognizable at small phone-feed thumbnail size — a tiny subject lost in a wide scene reads as nothing. Describe ONE clear subject + setting + lighting. NO abstract textures, NO extreme macro close-ups, NO collages, NO flat evenly-lit specimen shots, NO overall-dark scenes. Good: 'a single termite filling the frame, its back glowing vivid electric blue under crisp directional light, sharp against a clean contrasting background'. Bad: 'a termite on pale wood with a small blue patch, flat lighting', 'a dim dark moody scene', 'micro-detail biology', 'abstract neural patterns'.",
  "thumbnailWord": "string, ONE punchy uppercase word (3-8 letters) for the thumbnail caption — the single idea a viewer should feel. e.g., 'LISTEN', 'BURIED', 'WRONG'. Must NOT be a structural word like CASE/FILE/PROFILE, and must NOT repeat a word already in the title — it complements the title, it does not echo it.",
  "sections": [
    {
      "heading": "string, 3-6 words, what this beat is about — framed as a TEASE. Headings become the video's clickable chapter list, so a heading must name the mystery, never the solution: a viewer scanning the chapters must not be able to extract the episode's payoff. Good: 'The Blue Crystals on Its Back'. Bad: 'It Explodes Itself to Kill Ants'.",
      "narration": "string, ${wordsLo}-${wordsHi} words, ${structure.label} tone, no stage directions, no 'in this video', read aloud as natural English",
      "visual": "string, 6-12 words — a SINGLE summary b-roll query for this whole section (subject + the section's main scene). Used as the cold-open shot and a fallback. MUST start with the episode \"subject\". e.g. subject 'cave spider' -> 'cave spider crawling on wet rock in dark cave'. NEVER an abstract or tangential query that drops the subject (no bare 'old library', 'laboratory', 'starry sky', 'flowing data').",
      "visuals": ["3-6 strings, ORDERED to match this section's narration beat by beat. Split the narration into its successive moments and write ONE 6-12 word b-roll stock query per moment, in the SAME order they are spoken, so the footage shows what is being said as it is said. Each MUST start with the episode \"subject\", then that moment's scene/action/setting. e.g. narration goes rest -> feed -> attack, so visuals = ['cave spider resting in a dark rock crevice','cave spider wrapping a moth in silk','cave spider lunging at prey in the dark']. Cover the whole section in order; never drop the subject; no abstract or tangential shots."],
      "overlays": "optional array, 0-2 items, ONLY for sections 2, 3, 4, 5 — see Overlay Rules below",
      "shortsHook": "ONLY for sections 3 and 5 (omit the key everywhere else): string, 8-14 words — a standalone curiosity hook used as the TITLE of the Short cut from this section. It must name the subject by its common name, make a complete hooky claim a viewer with ZERO context understands instantly, and must NOT spoil this section's payoff or repeat the episode title. No clickbait lies: the claim must be real and actually delivered in THIS section's narration — never invent a number or fact for the hook."
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
- B-ROLL RELEVANCE (CRITICAL): every "visual" and every "visuals" entry must keep the "subject" visible. Lead each query with the subject noun, then vary the scene, action, or setting. The viewer should SEE the subject in most shots — not unrelated stock footage. If a beat is about history/discovery/data, still anchor on the subject (e.g. 'cave spider specimen under museum glass'), never a generic 'old archive' shot that drops it.
- SHOT-BY-SHOT (CRITICAL): "visuals" must walk this section's narration in order — the first entry depicts what is said first, the last entry what is said last, so the viewer is always looking at the thing currently being described. Do not repeat the same shot; advance the scene as the narration advances. Every entry stays anchored to the subject.

Sub-topic focus for this episode: ${subTheme}
- Pick one specific real subject that fits this sub-topic AND obeys the subject STOCK-FOOTAGE RULE above — a common, widely-filmed creature stock libraries actually have, never an obscure unfilmable species.
- Put the OBSCURITY in the ANGLE, not the animal: take a familiar, instantly-recognizable creature and reveal a half-forgotten, recently-confirmed, or counter-intuitive fact about it that almost nobody knows — e.g. 'cat' -> the gravity-defying way a cat actually laps water; 'housefly' -> it tastes with its feet; 'Venus flytrap' -> it counts to five before it snaps. A famous animal with a buried, surprising behavior beats an obscure species nobody can picture: stock footage exists, and viewers already care about the subject so the curiosity-gap title lands harder.
- Do NOT default to the dullest textbook fact about that famous creature either — the behavior/angle must still be genuinely strange, recently confirmed, or quietly buried, not common knowledge.

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
- ONE CONCRETE ODDITY: the title must contain a single hard, specific detail the viewer can picture — a number, a body part, a named action, a place — not only an abstract stake. "The Frog That Freezes Solid Every Winter and Wakes Up" (concrete: freezes solid) beats "The Frog With an Unbelievable Survival Secret" (abstract).

Packaging synergy (title + thumbnail are read together as ONE unit — design the gap on purpose):
- The title, "thumbnailWord", and "thumbnailConcept" are the three things a stranger sees at once in the feed. They must COMPLEMENT, never restate each other: the title frames the question or the stakes, the thumbnail image shows the visual jolt, and the thumbnailWord lands the single emotion. Together they should open a curiosity gap the viewer can only close by clicking.
- Do NOT let all three say the same thing. If the title already names the surprise, the thumbnailWord should name the FEELING or the unanswered "why/how" (e.g. title reveals an exploding termite -> thumbnailWord "WHY", not "EXPLODES"). If the title withholds, the thumbnail may show more.
- The thumbnailWord must add information or tension the title does not already carry — never a synonym of a title word.
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
- Every section except section 0 OPENS by advancing the thread, not recapping: drop straight into the next concrete beat (or land the answer the prior section withheld) within the first sentence. Never summarize what was just said — a recap is where viewers leave.
- Do NOT do mini-twists in every section. Follow the structural template above — the reversal / discovery / deepest layer happens at the section the template says, not earlier.
- PAYOFF CALLBACK: at the single section where this template lands its reveal, close the loop the cold open promised — one short sentence that points back at the section-0 promise (the question the viewer clicked for) right before paying it off. Exactly ONE callback, at the reveal only; never sprinkle recap callbacks across other sections. If the reveal section is 3 or 5 (a Shorts cut), phrase the callback context-free: restate the promise as a fresh claim, never "the question we opened with" / "at the start of this video".
- Section 1 introduces the specific subject by name without explaining everything.

Shorts cut rule (CRITICAL — sections 3 and 5 only):
- Sections 3 and 5 are republished VERBATIM as standalone Shorts, shown cold to viewers who have NOT seen any other part of the episode.
- Their FIRST sentence must stand alone for that cold viewer: name the subject by its common name and make one complete, hooky claim that needs zero prior context — while still advancing the long-form thread for the mid-episode viewer (a sharp restatement of exactly where the thread stands doubles as a cold open).
- Never open section 3 or 5 with a bare pronoun standing in for the subject, a callback phrase ("remember", "as we saw", "that same..."), or an unexplained term that was only introduced in an earlier section.
- If a section role above prescribes an opening line for section 3 or 5, rewrite that line so it names the subject and stands alone — the cold-open requirement wins.
- Give sections 3 and 5 — and ONLY them — the "shortsHook" field described in the Shape.`;
}

export async function generateEpisode(
  series: Series,
  structure: Structure,
  voice: Voice,
  subTheme: string,
  avoidTitles: string[] = [],
  winningTitles: string[] = [],
  topicDirective?: string,
  retentionDirective?: string,
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
  // The positive counterpart to avoidBlock: titles that earned the most clicks
  // and watch-time on this channel. The model studies their SHAPE (curiosity
  // gap, concrete stakes, verb energy) and reproduces it for a new subject — it
  // must not copy their wording or topic (those are in the avoid list anyway).
  const winBlock =
    winningTitles.length > 0
      ? `\n\nThese past titles performed BEST on this channel (highest click-through and watch-time). Study what makes them irresistible — the framing, the curiosity gap, the concrete stakes, the verb energy — then write your NEW title in that same spirit for a DIFFERENT subject. Let them also steer your ANGLE: within today's sub-topic focus, lean toward the KIND of surprise these winners promised (the same flavor of curiosity gap or stakes), not a flat encyclopedic overview. Do NOT copy their wording or reuse their topics:\n${winningTitles
          .slice(0, 8)
          .map((t) => `- ${t}`)
          .join('\n')}`
      : '';
  // Demand-validated topic steer (from topicResearch): a candidate angle that
  // scored well against real YouTube search results. A *steer*, not an order —
  // the model still owns subject choice and must keep every rule above (common
  // stock-filmed creature, no already-published collision).
  const directiveBlock = topicDirective
    ? `\n\nTOPIC STEER (validated against real YouTube search demand — prefer this angle if it fits all rules above):\n${topicDirective}`
    : '';
  // Measured pacing feedback (from retention.ts): where this channel's real
  // viewers leave. Shapes pacing only — never the facts, never the safety rules.
  const retentionBlock = retentionDirective ? `\n\n${retentionDirective}` : '';
  const userPrompt = `Series: ${series.name}
Theme: ${series.theme}
Sub-topic focus: ${subTheme}
Structural template: ${structure.label} (${structure.key})

Pick ONE specific surprising topic within this sub-topic focus that fits a ${TARGET_MINUTES}-minute mini-documentary. Use the "${hook.name}" hook style for the opening. Follow the ${structure.label} per-section role specification exactly. Write the full script JSON now.${avoidBlock}${winBlock}${directiveBlock}${retentionBlock}`;

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
export function spokenNumbers(narration: string): Set<string> {
  const out = new Set<string>();
  for (const m of narration.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const cleaned = m[0].replace(/,/g, '');
    const n = Number(cleaned);
    if (Number.isFinite(n)) out.add(String(n));
  }
  return out;
}

export function sanitizeOverlay(raw: unknown, narration: string): SectionOverlay | null {
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

// Upper bound on ordered shot-beat queries kept per section. More than this and
// each clip would be too short to read; the cap also bounds stock-API calls.
const MAX_SHOT_BEATS = 6;

// The ordered per-beat b-roll queries for a section: clean each, anchor it to the
// subject, drop blanks, and cap the count. Falls back to the single "visual"
// query (also subject-anchored) when the model omitted or emptied the array, so
// the pipeline always has at least one on-topic query to fetch.
function sanitizeVisuals(
  rawVisuals: unknown,
  fallbackVisual: string,
  subject: string,
): string[] {
  const list = Array.isArray(rawVisuals) ? rawVisuals : [];
  const cleaned = list
    .map((v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : ''))
    .filter(Boolean)
    .slice(0, MAX_SHOT_BEATS)
    .map((v) => anchorVisual(v, subject));
  if (cleaned.length > 0) return cleaned;
  return [anchorVisual(fallbackVisual, subject)];
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
    // stays on-topic even when the model writes an off-subject "visual", and
    // build the ordered per-beat shot list the pipeline fetches against.
    const base = {
      ...sec,
      visual: anchorVisual(sec.visual, subject),
      visuals: sanitizeVisuals(sec.visuals, sec.visual, subject),
      // Model JSON is an unchecked cast — a non-string shortsHook would throw
      // at the Shorts consumer, so normalize it to a trimmed string or drop it.
      shortsHook:
        typeof sec.shortsHook === 'string' && sec.shortsHook.trim()
          ? sec.shortsHook.trim()
          : undefined,
    };
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

// Exported so sibling modules (topicResearch, ctrRescue) can reuse the same
// headless-CLI plumbing (timeout, heartbeat, model pin) instead of duplicating it.
export function runClaudeCli(prompt: string): Promise<string> {
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

// High-traffic YouTube languages whose audiences mostly browse/search in their
// own language. We keep the channel English-primary (defaultLanguage stays
// 'en') and only ADD localized title/description metadata so these viewers can
// discover the video in their feed — the audio and on-screen text stay English.
export const LOCALIZE_LANGS: ReadonlyArray<{ code: string; name: string }> = [
  { code: 'es', name: 'Spanish' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'hi', name: 'Hindi' },
  { code: 'id', name: 'Indonesian' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'ja', name: 'Japanese' },
];

export type LocalizedText = { title: string; description: string };

// Translates the click-facing TITLE and the human PROSE blurb into each target
// language for YouTube `localizations`. Only the blurb is translated here; the
// caller re-appends the language-neutral chapters/links/attribution so
// timestamps and URLs are never mangled. Best-effort: any failure (CLI error,
// unparseable output, missing keys) yields an empty map and the upload proceeds
// English-only. Title is clamped to YouTube's 100-char limit per locale.
export async function translateMetadata(
  title: string,
  blurb: string,
  langs: ReadonlyArray<{ code: string; name: string }> = LOCALIZE_LANGS,
): Promise<Record<string, LocalizedText>> {
  try {
    const langList = langs.map((l) => `"${l.code}" (${l.name})`).join(', ');
    const prompt =
      `You are a localization expert for a science documentary YouTube channel.\n` +
      `Translate the TITLE and DESCRIPTION below into these languages: ${langList}.\n` +
      `Make the title natural and click-worthy in each language (not a stiff literal translation), max 100 characters.\n` +
      `Keep any proper nouns / species names that have no common translation as-is.\n` +
      `Return ONLY strict JSON keyed by language code, each value an object with "title" and "description". No commentary, no code fence.\n` +
      `Example shape: {"es":{"title":"...","description":"..."}}\n\n` +
      `TITLE:\n${title}\n\nDESCRIPTION:\n${blurb}`;
    const raw = await runClaudeCli(prompt);
    const out: Record<string, LocalizedText> = {};
    for (const candidate of extractJsonCandidates(raw)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(candidate);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== 'object') continue;
      for (const { code } of langs) {
        const entry = (parsed as Record<string, unknown>)[code];
        if (entry && typeof entry === 'object') {
          const t = (entry as Record<string, unknown>).title;
          const d = (entry as Record<string, unknown>).description;
          if (typeof t === 'string' && t.trim() && typeof d === 'string' && d.trim()) {
            out[code] = { title: t.trim().slice(0, 100), description: d.trim() };
          }
        }
      }
      if (Object.keys(out).length > 0) break;
    }
    return out;
  } catch (e) {
    console.log(`[localize] translation failed (continuing English-only): ${(e as Error).message}`);
    return {};
  }
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
// Exported so sibling modules parsing CLI JSON reuse the same tolerant scanner.
export function extractJsonCandidates(raw: string): string[] {
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
