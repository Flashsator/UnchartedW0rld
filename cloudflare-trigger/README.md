# Cloudflare Worker — Daily video trigger

Reliable, fully-cloud replacement for GitHub's flaky `schedule:` cron. Fires on
Cloudflare's cron (sub-minute jitter) and dispatches `daily.yml` via the GitHub
REST API. Once deployed it runs forever with no machine of your own involved.

**Schedule:** `0 13 * * 1,3,6` (UTC) = **Taiwan 21:00, Mon/Wed/Sat**.
Change the `crons` line in `wrangler.toml` to adjust.

## One-time setup

1. **Create a fine-grained GitHub PAT** (least privilege):
   - GitHub → Settings → Developer settings → Fine-grained tokens → Generate new
   - Repository access: **only** `Flashsator/UnchartedW0rld`
   - Permissions: **Actions → Read and write** (nothing else)
   - Copy the token (starts with `github_pat_`)

2. **Install Wrangler and log in** (one time):
   ```bash
   npm install -g wrangler
   wrangler login
   ```

3. **Store the token as a Worker secret** (never commit it):
   ```bash
   cd cloudflare-trigger
   wrangler secret put GH_PAT
   # paste the github_pat_... value when prompted
   ```

4. **Deploy:**
   ```bash
   wrangler deploy
   ```

## Verify it works

- **Manual fire:** open the Worker URL printed by `wrangler deploy` in a browser.
  It should say `Dispatched daily.yml on main`, and a new run appears under
  GitHub Actions within seconds.
- Or from CLI: `gh run list --limit 3` — look for a fresh `workflow_dispatch` run.

## After confirming it works

Remove the GitHub-side `schedule:` block from `.github/workflows/daily.yml` so
the pipeline doesn't double-fire. Keep `workflow_dispatch:` (this Worker needs
it). If you'd rather keep GitHub's cron as a backup, leave it — just be aware it
can occasionally cause a second run on the same day.

## Notes

- The PAT lives only in Cloudflare's encrypted secret store, scoped to this one
  repo with Actions-only write. Rotate it if ever exposed.
- Cloudflare Workers free plan includes cron triggers at no cost.
