// =====================================================================
// jobs/runConcepts.js — cron entrypoint for the concept clustering job
// =====================================================================
// `node jobs/runConcepts.js` — runs the concept synthesis pipeline
// across every user with enough embedded chunks. Mirrors
// jobs/runSynthesis.js for the belief job.

import 'dotenv/config';
import { runConceptsForAllUsers } from './conceptsJob.js';

const trigger = process.argv.includes('--manual') ? 'manual' : 'cron';

(async () => {
  const startedAt = Date.now();
  console.log(`🧩 runConcepts: starting (trigger=${trigger})`);
  try {
    const summaries = await runConceptsForAllUsers({ trigger });
    const totals = summaries.reduce(
      (acc, s) => {
        if (s.error) acc.error_users += 1;
        acc.proposed += s.concepts_proposed || 0;
        acc.attached += s.concepts_attached || 0;
        acc.links += s.concepts_links_written || 0;
        return acc;
      },
      { proposed: 0, attached: 0, links: 0, error_users: 0 },
    );
    const duration = Date.now() - startedAt;
    console.log(
      `🧩 runConcepts: done. users=${summaries.length} proposed=${totals.proposed} attached=${totals.attached} links=${totals.links} errored_users=${totals.error_users} ${duration}ms`,
    );
    if (totals.error_users > 0) {
      const failRatio = totals.error_users / Math.max(summaries.length, 1);
      if (failRatio > 0.25) {
        console.error('❌ runConcepts: >25% of users errored, exiting 1');
        process.exit(1);
      }
    }
    process.exit(0);
  } catch (err) {
    console.error('❌ runConcepts: top-level failure:', err?.stack || err?.message || err);
    process.exit(1);
  }
})();
