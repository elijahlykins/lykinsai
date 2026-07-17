/**
 * Service-role project state push for cron jobs (Night Shift).
 * Mirrors mcp-tools/pushProjectState supersession semantics.
 */

const STATE_KEY_MAX = 80;
const STATE_VALUE_MAX = 2000;

function isValidStateKey(key) {
  return /^[a-z][a-z0-9_]{0,79}$/.test(key);
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} admin
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} opts.projectId
 * @param {string} opts.stateKey
 * @param {string} opts.stateValue
 * @param {string} [opts.setByClient='night-shift']
 * @param {string|null} [opts.reason]
 */
export async function pushProjectStateAdmin(admin, {
  userId,
  projectId,
  stateKey,
  stateValue,
  setByClient = 'night-shift',
  reason = null,
}) {
  const key = String(stateKey || '').trim().toLowerCase();
  if (!isValidStateKey(key)) {
    throw new Error(`invalid state_key: ${stateKey}`);
  }
  const value = String(stateValue || '').trim().slice(0, STATE_VALUE_MAX);
  if (!value) throw new Error('state_value is required');

  const supersededAt = new Date().toISOString();
  const { error: supErr } = await admin
    .from('lykn_project_state')
    .update({ superseded_at: supersededAt })
    .eq('user_id', userId)
    .eq('project_id', projectId)
    .eq('state_key', key)
    .is('superseded_at', null);
  if (supErr) throw new Error(`supersede failed: ${supErr.message}`);

  const { data: inserted, error: insErr } = await admin
    .from('lykn_project_state')
    .insert({
      user_id: userId,
      project_id: projectId,
      state_key: key,
      state_value: value,
      set_by_client: setByClient,
      reason: reason ? String(reason).trim().slice(0, 320) : null,
    })
    .select('id, state_key, created_at')
    .single();
  if (insErr) throw new Error(`state insert failed: ${insErr.message}`);

  await admin
    .from('lykn_projects')
    .update({ last_active_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', projectId)
    .then(() => {}, () => {});

  return inserted;
}

export const MORNING_BRIEF_STATE_KEY = 'morning_brief';
