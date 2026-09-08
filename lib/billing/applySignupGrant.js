/**
 * Grant the one-time $20 signup usage and persist the in-app notice flag.
 */

import {
  USER_PREFERENCE_DEFAULTS,
  mergePreferenceRow,
} from '../account/preferencePatch.js';
import { SIGNUP_GRANT_USD } from './planCatalog.js';
import {
  SIGNUP_GRANT_NOTICE,
  SIGNUP_GRANT_NOTICE_META_KEY,
  isSignupGrantNoticeSeen,
  signupGrantNoticeAfterGrant,
} from './signupGrantNotice.js';
import { ensureSignupGrant } from './usageBalance.js';

async function readPreferenceMetadata(supabaseAdmin, userId) {
  if (!supabaseAdmin || !userId) return {};
  const { data, error } = await supabaseAdmin
    .from('lykn_user_preferences')
    .select('metadata')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) return {};
  return data?.metadata && typeof data.metadata === 'object' ? data.metadata : {};
}

async function persistSignupGrantNoticePending(supabaseAdmin, userId) {
  if (!supabaseAdmin || !userId) return;
  const { data: existing, error: readErr } = await supabaseAdmin
    .from('lykn_user_preferences')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (readErr) throw readErr;
  if (isSignupGrantNoticeSeen(existing?.metadata)) return;
  const row = {
    user_id: userId,
    ...mergePreferenceRow(existing || { ...USER_PREFERENCE_DEFAULTS, user_id: userId }, {
      metadata: { [SIGNUP_GRANT_NOTICE_META_KEY]: SIGNUP_GRANT_NOTICE.PENDING },
    }),
  };
  const { error } = await supabaseAdmin
    .from('lykn_user_preferences')
    .upsert(row, { onConflict: 'user_id' });
  if (error) throw error;
}

/**
 * Grant the $20 if needed, then return whether the Studio notice should show.
 * Preference writes are best-effort: a failed pending flag still reports
 * `notice: true` on the first grant so this session can show the card.
 */
export async function applySignupGrant({ userId, supabaseAdmin } = {}) {
  const grant = await ensureSignupGrant(userId);
  let metadata = {};
  try {
    metadata = await readPreferenceMetadata(supabaseAdmin, userId);
  } catch {
    metadata = {};
  }
  const next = signupGrantNoticeAfterGrant(metadata, grant);
  if (next.persistPending) {
    try {
      await persistSignupGrantNoticePending(supabaseAdmin, userId);
    } catch (err) {
      console.warn('⚠️ signup grant notice pending failed:', err?.message || err);
    }
  }
  return {
    grant,
    notice: next.notice,
    amountUsd: SIGNUP_GRANT_USD,
  };
}
