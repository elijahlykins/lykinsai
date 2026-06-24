// =====================================================================
// jobs/runVaultReconciler.js — cron entrypoint
// =====================================================================
// `node jobs/runVaultReconciler.js` — invoked by Render cron (see
// render.yaml). Loads .env, runs one reconciliation pass, exits non-zero on
// uncaught errors so Render flags failed runs.
//
// SAFE BY DEFAULT — dry-run, detection only. Mutations are opt-in:
//
//   --apply          mark row-without-file orphans as upload_state='missing'
//   --delete-leaked  ALSO delete truly-leaked files (file-without-row). This
//                    is the destructive sweep (step 3) and is additionally
//                    gated by the VAULT_RECONCILER_DELETE_ENABLED env flag, so
//                    flipping it on in production is a deliberate config change.
//   --grace=<min>        grace window for missing-object detection (default 30)
//   --leak-grace=<min>   grace window for leaked-file detection (default 60)
//
// Examples:
//   node jobs/runVaultReconciler.js                      # dry-run report
//   node jobs/runVaultReconciler.js --apply              # flag missing rows
//   VAULT_RECONCILER_DELETE_ENABLED=1 \
//     node jobs/runVaultReconciler.js --apply --delete-leaked

import 'dotenv/config';
import { runVaultReconciler } from './vaultReconcilerJob.js';

function intArg(flag, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`${flag}=`));
  if (!hit) return fallback;
  const n = parseInt(hit.split('=')[1], 10);
  return Number.isFinite(n) ? n : fallback;
}

const apply = process.argv.includes('--apply');
const wantDeleteLeaked = process.argv.includes('--delete-leaked');
// Destructive deletion is double-gated: the CLI flag AND the env switch.
const deleteEnabled = String(process.env.VAULT_RECONCILER_DELETE_ENABLED || '') === '1';
const deleteLeaked = wantDeleteLeaked && deleteEnabled;

if (wantDeleteLeaked && !deleteEnabled) {
  console.warn(
    '⚠️  --delete-leaked requested but VAULT_RECONCILER_DELETE_ENABLED!=1 — ' +
      'leaked-file deletion stays OFF (detection only).',
  );
}

(async () => {
  const startedAt = Date.now();
  console.log(
    `🧹 runVaultReconciler: starting (dryRun=${!apply} deleteLeaked=${deleteLeaked})`,
  );
  try {
    const summary = await runVaultReconciler({
      dryRun: !apply,
      deleteLeaked,
      graceMinutes: intArg('--grace', undefined),
      leakGraceMinutes: intArg('--leak-grace', undefined),
    });
    console.log('🧹 runVaultReconciler: done.', JSON.stringify(summary, null, 2));
    console.log(`🧹 runVaultReconciler: ${Date.now() - startedAt}ms`);
    process.exit(0);
  } catch (err) {
    console.error('❌ runVaultReconciler: top-level failure:', err?.stack || err?.message || err);
    process.exit(1);
  }
})();
