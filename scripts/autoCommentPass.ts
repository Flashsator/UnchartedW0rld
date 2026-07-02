// Standalone auto-comment pass. Posts the engagement comment on videos that have
// JUST gone public, WITHOUT waiting for the next Mon/Wed/Fri pipeline run.
//
// Why this exists: YouTube rejects comments on scheduled/private videos, and the
// daily pipeline runs at 13:00 UTC while that day's upload only goes public at
// 19:00 UTC (long) / 21:00 UTC (same-day teaser Short). So the pipeline can't
// comment on today's video — it would otherwise wait ~2 days for the next run,
// long past a Short's key early-push window. This pass runs ~1h after the publish
// slots (see .github/workflows/comment-pass.yml) so the comment lands within
// hours of the video going public.
//
// It reuses autoCommentOnRecentVideos unchanged, which is idempotent via a live
// commentThreads check (channelAlreadyCommented), so it never double-comments a
// video the daily run already handled — no shared state file needed.
//
// Run locally: ENABLE_AUTO_COMMENT=1 npx tsx scripts/autoCommentPass.ts
import { autoCommentOnRecentVideos } from '../src/engage.js';

autoCommentOnRecentVideos()
  .then(() => {
    console.log('Auto-comment pass complete.');
    process.exit(0);
  })
  .catch((e) => {
    console.error('Auto-comment pass FAILED:', (e as Error).message);
    process.exit(1);
  });
