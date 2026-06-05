import { IMAGE_GEN_MONTHLY_LIMIT } from './constants.js';

function monthStartIso() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
}

function nextMonthStartIso() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();
}

/**
 * Count successful in-chat image generations this calendar month.
 */
export async function getImageGenUsage(supabaseAdmin, userId) {
  if (!supabaseAdmin || !userId) {
    return {
      ok: false,
      error: 'unauthenticated',
      used: 0,
      limit: IMAGE_GEN_MONTHLY_LIMIT,
      remaining: 0,
    };
  }

  const from = monthStartIso();
  const { count, error } = await supabaseAdmin
    .from('ai_usage_logs')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('action_type', 'image_gen')
    .gte('created_at', from);

  if (error) {
    return {
      ok: false,
      error: error.message || 'quota_lookup_failed',
      used: 0,
      limit: IMAGE_GEN_MONTHLY_LIMIT,
      remaining: 0,
    };
  }

  const used = count || 0;
  const limit = IMAGE_GEN_MONTHLY_LIMIT;
  return {
    ok: true,
    used,
    limit,
    remaining: Math.max(0, limit - used),
    resets_at: nextMonthStartIso(),
  };
}

export async function assertImageGenQuota(supabaseAdmin, userId) {
  const usage = await getImageGenUsage(supabaseAdmin, userId);
  if (!usage.ok) return usage;
  if (usage.used >= usage.limit) {
    return {
      ok: false,
      error: 'image_gen_monthly_limit_reached',
      message: `You've used all ${usage.limit} AI image generations this month. Resets ${usage.resets_at?.slice(0, 10) || 'next month'}.`,
      ...usage,
    };
  }
  return { ok: true, ...usage };
}
