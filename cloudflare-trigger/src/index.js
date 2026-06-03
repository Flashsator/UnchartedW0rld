/**
 * Cloudflare Worker — reliable cron trigger for the Daily video pipeline.
 *
 * GitHub's own `schedule:` cron is best-effort and can be delayed by hours
 * during peak load. This Worker fires on Cloudflare's cron (sub-minute jitter)
 * and dispatches the workflow via the GitHub REST API instead.
 *
 * Secrets (set via `wrangler secret put`):
 *   GH_PAT — fine-grained PAT scoped to this repo with "Actions: write".
 */

const REPO = "Flashsator/UnchartedW0rld";
const WORKFLOW_FILE = "daily.yml";
const REF = "main";

async function dispatch(env) {
  const url = `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GH_PAT}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "uncharted-daily-trigger",
    },
    body: JSON.stringify({ ref: REF }),
  });

  // 204 No Content = success. Anything else is a failure worth surfacing.
  if (res.status !== 204) {
    const detail = await res.text();
    throw new Error(`workflow_dispatch failed: ${res.status} ${detail}`);
  }
}

export default {
  // Cloudflare cron trigger (schedule defined in wrangler.toml).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dispatch(env));
  },

  // Manual smoke test: visit the Worker URL to fire a dispatch on demand.
  async fetch(request, env) {
    try {
      await dispatch(env);
      return new Response("Dispatched daily.yml on main\n", { status: 200 });
    } catch (err) {
      return new Response(`Error: ${err.message}\n`, { status: 500 });
    }
  },
};
