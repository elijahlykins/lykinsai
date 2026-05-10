// =====================================================================
// jobs/runSynthesis.js — cron entrypoint
// =====================================================================
// `node jobs/runSynthesis.js` — invoked by Render cron @ 3am UTC
// (see render.yaml). Loads .env, runs synthesisJob across every user
// with embedded facts, exits non-zero on uncaught errors so Render
// flags failed runs.

import 'dotenv/config';
import { runSynthesisForAllUsers } from './synthesisJob.js';

const trigger = process.argv.includes('--manual') ? 'manual' : 'cron';

(async () => {
  const startedAt = Date.now();
  console.log(`🌙 runSynthesis: starting (trigger=${trigger})`);
  try {
    const summaries = await runSynthesisForAllUsers({ trigger });
    const totals = summaries.reduce(
      (acc, s) => {
        if (s.error) acc.error_users += 1;
        acc.proposals += s.proposals_written || 0;
        acc.clusters += s.clusters_found || 0;
        return acc;
      },
      { proposals: 0, clusters: 0, error_users: 0 },
    );
    const duration = Date.now() - startedAt;
    console.log(
      `🌙 runSynthesis: done. users=${summaries.length} clusters=${totals.clusters} proposals=${totals.proposals} errored_users=${totals.error_users} ${duration}ms`,
    );
    if (totals.error_users > 0) {
      // Non-zero exit so Render's cron-failure alerting fires when a
      // significant fraction of users hit errors. We don't fail on any
      // single user's error (that's logged + recorded in lykn_synthesis_runs)
      // — only when something systemic is wrong.
      const failRatio = totals.error_users / Math.max(summaries.length, 1);
      if (failRatio > 0.25) {
        console.error('❌ runSynthesis: >25% of users errored, exiting 1');
        process.exit(1);
      }
    }
    process.exit(0);
  } catch (err) {
    console.error('❌ runSynthesis: top-level failure:', err?.stack || err?.message || err);
    process.exit(1);
  }
})();
