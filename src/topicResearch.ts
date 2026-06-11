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
}

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

// The winner is simply the candidate whose search query surfaces the most-viewed
// existing videos. Zero-scored candidates (no results / no stats) never win, so
// when every probe failed we return null and the model keeps its own choice.
export function pickBestCandidate(scored: ScoredCandidate[]): ScoredCandidate | null {
  const best = scored.reduce<ScoredCandidate | null>(
    (acc, c) => (c.medianViews > (acc?.medianViews ?? 0) ? c : acc),
    null,
  );
  return best && best.medianViews > 0 ? best : null;
}

// Renders the winning candidate as the topic-steer block generateEpisode
// appends to its prompt.
export function buildTopicDirective(c: ScoredCandidate): string {
  return (
    `Subject: ${c.subject}\n` +
    `Angle: ${c.angle}\n` +
    `(Validated: YouTube search "${c.searchQuery}" — top results have a median of ` +
    `${Math.round(c.medianViews).toLocaleString('en-US')} views, so this angle has proven audience demand.)`
  );
}

// --- Candidate generation + scoring ---------------------------------------------

async function proposeCandidates(
  series: Series,
  subTheme: string,
  avoidTitles: string[],
): Promise<TopicCandidate[]> {
  // Without the avoid-list, the static popularity scoring re-elects the same
  // evergreen winner every week and the steer fights generateEpisode's own
  // dedup rule. Keep proposals clear of already-covered ground at the source.
  const avoidBlock =
    avoidTitles.length > 0
      ? `\n- the channel has ALREADY covered these — do NOT propose the same or a near-identical angle:\n` +
        avoidTitles.map((t) => `  • ${t}`).join('\n')
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
    `\n\nOutput ONLY a JSON array of ${TOPIC_CANDIDATE_COUNT} objects, each: ` +
    `{"subject": "...", "angle": "...", "searchQuery": "..."}`;
  const raw = await runClaudeCli(prompt);
  return parseCandidates(raw);
}

// Median view count of the top search hits for this query — proven demand for
// the angle. 0 on any failure so the candidate simply can't win.
async function scoreQuery(yt: ReturnType<typeof google.youtube>, query: string): Promise<number> {
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
    if (ids.length === 0) return 0;
    const stats = await yt.videos.list({ part: ['statistics'], id: ids });
    const views = (stats.data.items ?? [])
      .map((v) => Number(v.statistics?.viewCount))
      .filter((n) => Number.isFinite(n));
    return median(views);
  } catch (e) {
    log(`Topic validation: scoring "${query}" failed (candidate scored 0): ${(e as Error).message}`);
    return 0;
  }
}

// --- Main entry (called before generateEpisode; non-fatal) -----------------------

export async function validateTopicDemand(
  series: Series,
  subTheme: string,
  avoidTitles: string[] = [],
): Promise<string | undefined> {
  if (!ENABLE_TOPIC_VALIDATION) return undefined;
  try {
    const candidates = await proposeCandidates(series, subTheme, avoidTitles);
    if (candidates.length === 0) {
      log('Topic validation: no parsable candidates — falling back to the model\'s own choice.');
      return undefined;
    }
    const yt = getClient();
    const scored: ScoredCandidate[] = [];
    for (const c of candidates) {
      const medianViews = await scoreQuery(yt, c.searchQuery);
      scored.push({ ...c, medianViews });
      log(
        `Topic validation: "${c.searchQuery}" → median ${Math.round(medianViews).toLocaleString('en-US')} views`,
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
