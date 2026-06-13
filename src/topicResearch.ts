import { google } from 'googleapis';
import {
  ENABLE_TOPIC_VALIDATION,
  TOPIC_CANDIDATE_COUNT,
  YT_CLIENT_ID,
  YT_CLIENT_SECRET,
  YT_REFRESH_TOKEN,
  type Series,
} from './config.js';
import { extractJsonCandidates, runClaudeCli } from './scriptGen.js';
import { median } from './ctrRescue.js';
import { log } from './utils.js';

// Topic demand validation: instead of trusting the script model's instinct for
// what people want to watch, propose a handful of candidate angles and score
// each against REAL YouTube search results — the median view count of the top
// hits for the angle's natural search query is a direct read on proven audience
// demand. The winner is fed to generateEpisode as a steer (not an order: the
// script model still owns the final episode and all its safety rules).
// Costs ~TOPIC_CANDIDATE_COUNT × 100 quota units per run (search.list) out of
// the 10k daily budget. Best-effort/non-fatal throughout.

export interface TopicCandidate {
  subject: string;
  angle: string;
  searchQuery: string;
}

export interface ScoredCandidate extends TopicCandidate {
  medianViews: number;
  // Lowest view count among the query's top hits. A high floor means even the
  // weakest top-ranked video still pulls real views, so the TOPIC reliably
  // delivers views to whoever ranks (not one viral outlier inflating the
  // median). Caveat: a high floor can ALSO signal that big channels already own
  // every top slot — proxy for "demand depth", not for "low competition". We
  // log it every run so the next few topic-validation lines can confirm winners
  // aren't all high-floor/high-competition before we lean harder on it.
  floorViews: number;
}

// A query whose top hits median ABOVE this is a saturated niche owned by
// mega-channels — unwinnable for a young, low-authority channel. BELOW the
// lower bound there is no real audience to capture. The sweet spot is proven
// demand we can still rank into.
const SATURATED_MEDIAN = 2_000_000;
const NO_DEMAND_MEDIAN = 15_000;

function getClient() {
  if (!YT_CLIENT_ID || !YT_CLIENT_SECRET || !YT_REFRESH_TOKEN) {
    throw new Error('YouTube OAuth env vars missing (YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REFRESH_TOKEN)');
  }
  const oauth = new google.auth.OAuth2(YT_CLIENT_ID, YT_CLIENT_SECRET);
  oauth.setCredentials({ refresh_token: YT_REFRESH_TOKEN });
  return google.youtube({ version: 'v3', auth: oauth });
}

// --- Pure helpers (unit-tested) -------------------------------------------------

// Parses the CLI's candidate list from raw model output. Tolerant of prose
// around the JSON (reuses scriptGen's scanner); drops malformed entries instead
// of failing the batch.
export function parseCandidates(raw: string, max: number = TOPIC_CANDIDATE_COUNT): TopicCandidate[] {
  for (const candidate of extractJsonCandidates(raw)) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      const list = Array.isArray(parsed)
        ? parsed
        : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { candidates?: unknown }).candidates)
          ? (parsed as { candidates: unknown[] }).candidates
          : null;
      if (!list) continue;
      const valid = list
        .filter(
          (c): c is TopicCandidate =>
            typeof c === 'object' &&
            c !== null &&
            typeof (c as TopicCandidate).subject === 'string' &&
            typeof (c as TopicCandidate).angle === 'string' &&
            typeof (c as TopicCandidate).searchQuery === 'string' &&
            (c as TopicCandidate).subject.trim().length > 0 &&
            (c as TopicCandidate).searchQuery.trim().length > 0,
        )
        .slice(0, max);
      if (valid.length > 0) return valid;
    } catch {
      // Not valid JSON — try the next candidate blob.
    }
  }
  return [];
}

// Winnable-demand pick. Raw "highest median" loses for a young, low-authority
// channel: the top-median queries are saturated mega-niches owned by huge
// channels we can't out-rank, and the very-low-median queries have no audience
// to capture. So we first keep only candidates inside the winnable band
// [NO_DEMAND_MEDIAN, SATURATED_MEDIAN]; among those we prefer the highest FLOOR
// (every top hit pulls real views = broad, repeatable demand rather than one
// viral outlier inflating the median), tie-broken by the higher median. Zero-
// scored candidates (no results / no stats) can never win, so when every probe
// failed — or nothing landed in the band — we fall back accordingly and the
// model keeps its own choice.
export function pickBestCandidate(scored: ScoredCandidate[]): ScoredCandidate | null {
  const withDemand = scored.filter((c) => c.medianViews > 0);
  if (withDemand.length === 0) return null;
  const winnable = withDemand.filter(
    (c) => c.medianViews >= NO_DEMAND_MEDIAN && c.medianViews <= SATURATED_MEDIAN,
  );
  const pool = winnable.length > 0 ? winnable : withDemand;
  return pool.reduce<ScoredCandidate | null>((acc, c) => {
    if (!acc) return c;
    if (c.floorViews !== acc.floorViews) return c.floorViews > acc.floorViews ? c : acc;
    return c.medianViews > acc.medianViews ? c : acc;
  }, null);
}

// Renders the winning candidate as the topic-steer block generateEpisode
// appends to its prompt.
export function buildTopicDirective(c: ScoredCandidate): string {
  return (
    `Subject: ${c.subject}\n` +
    `Angle: ${c.angle}\n` +
    `(Validated: YouTube search "${c.searchQuery}" — top results have a median of ` +
    `${Math.round(c.medianViews).toLocaleString('en-US')} views, so this angle has proven audience demand.)\n` +
    `SEO (search ranking — this is the MEASURED query that has demand): weave the exact phrase ` +
    `"${c.searchQuery}" verbatim into the first two sentences of the "description", and include it ` +
    `verbatim as one of the "tags". It must read as natural prose, never a keyword dump.`
  );
}

// --- Candidate generation + scoring ---------------------------------------------

async function proposeCandidates(
  series: Series,
  subTheme: string,
  avoidTitles: string[],
  winningTitles: string[],
): Promise<TopicCandidate[]> {
  // Without the avoid-list, the static popularity scoring re-elects the same
  // evergreen winner every week and the steer fights generateEpisode's own
  // dedup rule. Keep proposals clear of already-covered ground at the source.
  const avoidBlock =
    avoidTitles.length > 0
      ? `\n- the channel has ALREADY covered these — do NOT propose the same or a near-identical angle:\n` +
        avoidTitles.map((t) => `  • ${t}`).join('\n')
      : '';
  // Own-channel performance hint (deliberately soft — the channel is young and
  // a handful of videos is taste, not statistics, so this nudges the FLAVOR of
  // candidates rather than hard-weighting any topic or series).
  const winBlock =
    winningTitles.length > 0
      ? `\n- these past episodes performed BEST on this channel — bias candidates toward the same KIND of curiosity gap or stakes (different subjects, never a repeat):\n` +
        winningTitles
          .slice(0, 5)
          .map((t) => `  • ${t}`)
          .join('\n')
      : '';
  const prompt =
    `You plan episodes for "Wild Anomalies", a YouTube science mini-documentary channel. ` +
    `Today's series is "${series.name}" (theme: ${series.theme}); today's sub-theme: "${subTheme}".\n\n` +
    `Propose ${TOPIC_CANDIDATE_COUNT} candidate episode angles. HARD RULES for every candidate:\n` +
    `- subject MUST be a common, widely-filmed creature/plant that free stock-video libraries definitely have ` +
    `(cat, octopus, ant, sunflower...). NEVER an obscure species.\n` +
    `- the surprise lives in the ANGLE (a buried behavior, a counterintuitive mechanism), not in an exotic subject.\n` +
    `- searchQuery is what a curious viewer would actually type into YouTube for this angle ` +
    `(e.g. "how do cats drink water"), 3-8 words, no hashtags.` +
    avoidBlock +
    winBlock +
    `\n\nOutput ONLY a JSON array of ${TOPIC_CANDIDATE_COUNT} objects, each: ` +
    `{"subject": "...", "angle": "...", "searchQuery": "..."}`;
  const raw = await runClaudeCli(prompt);
  return parseCandidates(raw);
}

// Demand read for a query: the median view count of its top search hits (proven
// demand for the angle) plus the floor (lowest of those hits — how consistent
// that demand is). Both 0 on any failure so the candidate simply can't win.
async function scoreQuery(
  yt: ReturnType<typeof google.youtube>,
  query: string,
): Promise<{ medianViews: number; floorViews: number }> {
  try {
    const search = await yt.search.list({
      part: ['id'],
      q: query,
      type: ['video'],
      maxResults: 10,
      order: 'relevance',
    });
    const ids = (search.data.items ?? [])
      .map((i) => i.id?.videoId)
      .filter((id): id is string => Boolean(id));
    if (ids.length === 0) return { medianViews: 0, floorViews: 0 };
    const stats = await yt.videos.list({ part: ['statistics'], id: ids });
    const views = (stats.data.items ?? [])
      .map((v) => Number(v.statistics?.viewCount))
      .filter((n) => Number.isFinite(n));
    if (views.length === 0) return { medianViews: 0, floorViews: 0 };
    return { medianViews: median(views), floorViews: Math.min(...views) };
  } catch (e) {
    log(`Topic validation: scoring "${query}" failed (candidate scored 0): ${(e as Error).message}`);
    return { medianViews: 0, floorViews: 0 };
  }
}

// --- Main entry (called before generateEpisode; non-fatal) -----------------------

export async function validateTopicDemand(
  series: Series,
  subTheme: string,
  avoidTitles: string[] = [],
  winningTitles: string[] = [],
): Promise<string | undefined> {
  if (!ENABLE_TOPIC_VALIDATION) return undefined;
  try {
    const candidates = await proposeCandidates(series, subTheme, avoidTitles, winningTitles);
    if (candidates.length === 0) {
      log('Topic validation: no parsable candidates — falling back to the model\'s own choice.');
      return undefined;
    }
    const yt = getClient();
    const scored: ScoredCandidate[] = [];
    for (const c of candidates) {
      const { medianViews, floorViews } = await scoreQuery(yt, c.searchQuery);
      scored.push({ ...c, medianViews, floorViews });
      log(
        `Topic validation: "${c.searchQuery}" → median ${Math.round(medianViews).toLocaleString('en-US')} ` +
          `(floor ${Math.round(floorViews).toLocaleString('en-US')}) views`,
      );
    }
    const best = pickBestCandidate(scored);
    if (!best) {
      log('Topic validation: no candidate showed measurable demand — falling back.');
      return undefined;
    }
    log(`Topic validation: winner "${best.subject}" — ${best.searchQuery}`);
    return buildTopicDirective(best);
  } catch (e) {
    log(`Topic validation skipped (continuing): ${(e as Error).message}`);
    return undefined;
  }
}
