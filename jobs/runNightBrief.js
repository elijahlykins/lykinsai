// =====================================================================
// jobs/runNightBrief.js — cron entrypoint for Night Shift (Phase 0)
// =====================================================================
// `node jobs/runNightBrief.js` — invoked by Render cron @ 4:30 UTC
// (after synthesis, concepts, vault reconciler).
//
// Manual dev:
//   npm run night-shift:brief
//     → uses NIGHT_SHIFT_USER_EMAIL or NIGHT_SHIFT_USER_ID from .env
//   npm run night-shift:brief -- --all
//     → every opted-in user (cron-like)
//   npm run night-shift:brief -- --user=you@example.com

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { runNightBriefForAllUsers, runNightBriefForUser } from './nightBriefJob.js';
import { parseNightShiftTier } from '../lib/nightShift/stewardTier.js';
import { resolveNightShiftUserId } from '../lib/nightShift/resolveNightShiftUser.js';

const trigger = process.argv.includes('--manual') ? 'manual' : 'cron';
const runAll = process.argv.includes('--all');
const userArg = process.argv.find((a) => a.startsWith('--user='));
const singleUserArg = userArg ? userArg.slice('--user='.length).trim() : null;

function buildAdminClient() {
  const url = process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('runNightBrief: missing VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env');
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

(async () => {
  const startedAt = Date.now();
  console.log(`🌙 runNightBrief: starting (trigger=${trigger})`);
  try {
    let summaries;

    if (trigger === 'manual' && !runAll && !singleUserArg) {
      const admin = buildAdminClient();
      const resolved = await resolveNightShiftUserId(admin, { manual: true });
      const label = resolved.email || resolved.userId;
      console.log(`🌙 runNightBrief: manual user ${label} (${resolved.source})`);

      const { data: prefs } = await admin
        .from('lykn_user_preferences')
        .select('night_shift_tier')
        .eq('user_id', resolved.userId)
        .maybeSingle();
      const tier = parseNightShiftTier(prefs?.night_shift_tier);
      const summary = await runNightBriefForUser(admin, resolved.userId, { trigger, tier });
      summaries = [{ user_id: resolved.userId, tier, ...summary }];
    } else if (singleUserArg) {
      const admin = buildAdminClient();
      const resolved = await resolveNightShiftUserId(admin, { userArg: singleUserArg, manual: true });
      const label = resolved.email || resolved.userId;
      console.log(`🌙 runNightBrief: user ${label} (${resolved.source})`);

      const { data: prefs } = await admin
        .from('lykn_user_preferences')
        .select('night_shift_tier')
        .eq('user_id', resolved.userId)
        .maybeSingle();
      const tier = parseNightShiftTier(prefs?.night_shift_tier);
      const summary = await runNightBriefForUser(admin, resolved.userId, { trigger, tier });
      summaries = [{ user_id: resolved.userId, tier, ...summary }];
    } else {
      summaries = await runNightBriefForAllUsers({ trigger });
    }

    const totals = summaries.reduce(
      (acc, s) => {
        if (s.error) acc.error_users += 1;
        acc.briefed += s.projects_briefed || 0;
        acc.skipped += s.projects_skipped || 0;
        acc.triaged += s.steward_triaged || 0;
        acc.executed += s.steward_executed || 0;
        acc.delegated += s.steward_delegated || 0;
        return acc;
      },
      { briefed: 0, skipped: 0, triaged: 0, executed: 0, delegated: 0, error_users: 0 },
    );
    const duration = Date.now() - startedAt;
    console.log(
      `🌙 runNightBrief: done. users=${summaries.length} briefed_projects=${totals.briefed} skipped=${totals.skipped} steward_triaged=${totals.triaged} steward_executed=${totals.executed} steward_delegated=${totals.delegated} errored_users=${totals.error_users} ${duration}ms`,
    );
    if (totals.error_users > 0) {
      const failRatio = totals.error_users / Math.max(summaries.length, 1);
      if (failRatio > 0.25) {
        console.error('❌ runNightBrief: >25% of users errored, exiting 1');
        process.exit(1);
      }
    }
    process.exit(0);
  } catch (err) {
    console.error('❌ runNightBrief: top-level failure:', err?.stack || err?.message || err);
    process.exit(1);
  }
})();
