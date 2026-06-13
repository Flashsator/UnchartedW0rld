import fs from 'node:fs';
import path from 'node:path';
import { google } from 'googleapis';
import {
  CONTENT_AUDIT_LOG_FILE,
  CONTENT_AUDIT_RECENT_COUNT,
  ENABLE_CONTENT_AUDIT,
  YT_CLIENT_ID,
  YT_CLIENT_SECRET,
  YT_REFRESH_TOKEN,
} from './config.js';
import { extractJsonCandidates, runClaudeCli } from './scriptGen.js';
import { log } from './utils.js';

// Content self-audit: every other feedback loop in this pipeline reacts to
// MEASURED analytics (CTR, retention, views) — invaluable, but silent until the
// channel has ~90 days of data. This pass instead critiques the actual shipped
// PACKAGING (title / pre-fold hook / tags) against the channel's own views
// playbook, qualitatively, the same way a human editor would. It needs no watch
// data, so it produces signal from day one. It is purely advisory: it appends a
// dated entry to a log and raises a non-failing GitHub Actions warning on a
// regression. It never touches a live video (ctrRescue owns that) and never
// fails the run.

// One uploaded video's packaging, as fed to the auditor.
export interface AuditVideo {
  title: string;
  // First sentence of the description — the only line a viewer sees before the
  // fold, so the highest-leverage hook in the whole listing.
  hookLine: string;
  tags: string[];
}

export interface AuditVerdict {
  // 1–10 overall packaging health of the recent set against the playbook.
  score: number;
  // True when the recent packaging is sliding back toward the banned patterns
  // (template promise tails, buried subjects, no long-tail tags, etc.).
  regression: boolean;
  // Concrete, actionable observations — what to change next, not praise.
  findings: string[];
  // The single highest-leverage fix, surfaced into the warning annotation.
  topFix: string;
}

// Below this score the run flags a regression even if the model didn't, so a
// quietly-degrading channel still trips the annotation.
const REGRESSION_SCORE = 5;

function getClient() {
  if (!YT_CLIENT_ID || !YT_CLIENT_SECRET || !YT_REFRESH_TOKEN) {
    throw new Error('YouTube OAuth env vars missing (YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REFRESH_TOKEN)');
  }
  const oauth = new google.auth.OAuth2(YT_CLIENT_ID, YT_CLIENT_SECRET);
  oauth.setCredentials({ refresh_token: YT_REFRESH_TOKEN });
  return google.youtube({ version: 'v3', auth: oauth });
}

// --- Pure helpers (unit-tested) ------------------------------------------------

// First sentence of a description = the pre-fold hook. Strips the trailing
// hashtag block and caps length so the prompt stays compact.
export function hookLineFromDescription(description: string): string {
  const firstPara = description.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
  const firstSentence = firstPara.split(/(?<=[.!?])\s/)[0] ?? firstPara;
  return firstSentence.replace(/#\w+/g, '').trim().slice(0, 160);
}

// The playbook the auditor scores against — kept in sync with the rules the
// script/thumbnail prompts already enforce so the audit measures the same bar.
const PLAYBOOK = [
  'Title front-loads the concrete subject + a surprising verb/noun within the first ~40 characters; no label prefixes (Case File:, Profile:) that bury the topic.',
  'The pre-fold hook (first description sentence) states the single most surprising payoff before any setup, and reads as natural prose.',
  'Tags mix broad high-volume terms with 2-4 long-tail multi-word phrase tags matching a real search query (where a small channel ranks).',
  'Across the set, titles vary their frame (not every title the same shape) while always surfacing concrete stakes — never generic wrapper words ("what X actually does", "the truth about X") with the shock hidden.',
  'No clickbait the script does not pay off; no fabricated specifics.',
];

export function buildAuditPrompt(videos: AuditVideo[]): string {
  const list = videos
    .map((v, i) => {
      const tags = v.tags.length > 0 ? v.tags.join(', ') : '(none)';
      return `${i + 1}. TITLE: ${v.title}\n   HOOK: ${v.hookLine || '(none)'}\n   TAGS: ${tags}`;
    })
    .join('\n');
  return (
    `You are the packaging editor for the YouTube science channel "Wild Anomalies". ` +
    `Audit the channel's ${videos.length} most recent uploads below against the PLAYBOOK. ` +
    `Be a harsh, specific critic — the goal is higher click-through and views, so reward nothing, only flag what to fix.\n\n` +
    `PLAYBOOK:\n${PLAYBOOK.map((p) => `- ${p}`).join('\n')}\n\n` +
    `RECENT UPLOADS:\n${list}\n\n` +
    `Output ONLY a JSON object: {"score": <1-10 overall packaging health>, ` +
    `"regression": <true if packaging is sliding toward generic/template/buried-subject patterns>, ` +
    `"findings": ["<concrete fix tied to a specific video or pattern>", ...up to 5], ` +
    `"topFix": "<the single highest-leverage change to make next>"}`
  );
}

// Tolerant parse of the CLI's JSON verdict (reuses scriptGen's scanner). Returns
// null on anything unusable so the caller simply logs nothing this run.
export function parseAuditVerdict(raw: string): AuditVerdict | null {
  for (const candidate of extractJsonCandidates(raw)) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed !== 'object' || parsed === null) continue;
      const o = parsed as Record<string, unknown>;
      const score = Number(o.score);
      if (!Number.isFinite(score)) continue;
      const findings = Array.isArray(o.findings)
        ? o.findings.filter((f): f is string => typeof f === 'string' && f.trim().length > 0)
        : [];
      const topFix = typeof o.topFix === 'string' ? o.topFix.trim() : '';
      // A sub-threshold score is a regression regardless of the model's own flag,
      // so a quietly-degrading channel can't score itself out of the warning.
      const regression = o.regression === true || score < REGRESSION_SCORE;
      return { score, regression, findings, topFix };
    } catch {
      // Not valid JSON — try the next blob.
    }
  }
  return null;
}

// Renders one dated, append-only log block.
export function formatAuditEntry(verdict: AuditVerdict, now: Date = new Date()): string {
  const date = now.toISOString().slice(0, 10);
  const head = `## ${date} — score ${verdict.score}/10${verdict.regression ? ' ⚠ REGRESSION' : ''}`;
  const fixes = verdict.findings.length > 0
    ? verdict.findings.map((f) => `- ${f}`).join('\n')
    : '- (no findings returned)';
  const top = verdict.topFix ? `\nTOP FIX: ${verdict.topFix}` : '';
  return `${head}\n${fixes}${top}\n`;
}

function appendAuditLog(entry: string, file: string = CONTENT_AUDIT_LOG_FILE): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, entry + '\n', 'utf-8');
  } catch (e) {
    log(`Content audit: could not persist log (continuing): ${(e as Error).message}`);
  }
}

// GitHub Actions surfaces a `::warning::` line (at column 0, no timestamp) as a
// non-failing annotation on the run summary — the lightest way to flag a
// regression to the human without reddening the build. Bypasses log() because the
// annotation protocol requires the marker to start the line.
function emitRegressionAnnotation(verdict: AuditVerdict): void {
  const fix = verdict.topFix || verdict.findings[0] || 'see work/.content-audit.log';
  process.stdout.write(`::warning title=Content packaging regression::score ${verdict.score}/10 — ${fix}\n`);
}

// --- Main entry (called at the end of the pipeline; non-fatal) -----------------

export async function auditRecentContent(): Promise<void> {
  if (!ENABLE_CONTENT_AUDIT) return;
  try {
    const yt = getClient();
    const ch = await yt.channels.list({ part: ['contentDetails'], mine: true });
    const uploads = ch.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploads) return;
    const pl = await yt.playlistItems.list({
      part: ['contentDetails'],
      playlistId: uploads,
      maxResults: CONTENT_AUDIT_RECENT_COUNT,
    });
    const ids = (pl.data.items ?? [])
      .map((i) => i.contentDetails?.videoId)
      .filter((id): id is string => Boolean(id));
    if (ids.length === 0) {
      log('Content audit: no uploads found yet — nothing to audit.');
      return;
    }

    const res = await yt.videos.list({ part: ['snippet'], id: ids });
    const videos: AuditVideo[] = (res.data.items ?? [])
      .map((v) => ({
        title: v.snippet?.title?.replace(/\s*#shorts\b/gi, '').trim() ?? '',
        hookLine: hookLineFromDescription(v.snippet?.description ?? ''),
        tags: v.snippet?.tags ?? [],
      }))
      .filter((v) => v.title.length > 0);
    if (videos.length === 0) {
      log('Content audit: recent uploads carried no usable titles — skipping.');
      return;
    }

    const raw = await runClaudeCli(buildAuditPrompt(videos));
    const verdict = parseAuditVerdict(raw);
    if (!verdict) {
      log('Content audit: could not parse a verdict from the CLI — skipping this run.');
      return;
    }

    appendAuditLog(formatAuditEntry(verdict));
    log(
      `Content audit: scored ${verdict.score}/10 over ${videos.length} recent uploads` +
        `${verdict.regression ? ' (REGRESSION flagged)' : ''}. ${verdict.findings.length} finding(s) logged.`,
    );
    if (verdict.regression) emitRegressionAnnotation(verdict);
  } catch (e) {
    const msg = (e as Error).message;
    if (/insufficient|scope|forbidden|permission|403/i.test(msg)) {
      log(`Content audit skipped: the YouTube token lacks read access (${msg}).`);
    } else {
      log(`Content audit skipped (continuing without it): ${msg}`);
    }
  }
}
