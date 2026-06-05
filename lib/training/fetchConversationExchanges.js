import { TRAINING_CHAT_SURFACES } from './constants.js';

const DEFAULT_EXCHANGE_LIMIT = 80;

/**
 * Load recent ai_conversation_memory rows for training export.
 * Main /app chat (surface chat, or legacy grid tag). Vault is excluded.
 * Honors chat_retention_days when set on preferences.
 */
export async function fetchConversationExchanges(client, userId, opts = {}) {
  if (!client || !userId) return [];

  const surfaces = opts.surfaces || TRAINING_CHAT_SURFACES;
  const limit = Math.min(Math.max(Number(opts.limit) || DEFAULT_EXCHANGE_LIMIT, 1), 120);
  let query = client
    .from('ai_conversation_memory')
    .select('id, user_message, assistant_message, surface, surface_title, created_at')
    .eq('user_id', userId)
    .in('surface', surfaces)
    .order('created_at', { ascending: false })
    .limit(limit);

  const retentionDays = opts.chatRetentionDays;
  if (retentionDays != null && Number.isFinite(Number(retentionDays))) {
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - Number(retentionDays));
    query = query.gte('created_at', cutoff.toISOString());
  }

  const { data, error } = await query;
  if (error) {
    console.warn('[training] fetchConversationExchanges:', error.message);
    return [];
  }

  return (data || []).slice().reverse();
}

export async function fetchUserTrainingPreferences(client, userId) {
  if (!client || !userId) {
    return { trainingOptOut: false, chatRetentionDays: null };
  }
  const { data, error } = await client
    .from('lykn_user_preferences')
    .select('training_opt_out, chat_retention_days')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    console.warn('[training] fetchUserTrainingPreferences:', error.message);
    return { trainingOptOut: false, chatRetentionDays: null };
  }

  return {
    trainingOptOut: !!data?.training_opt_out,
    chatRetentionDays: data?.chat_retention_days ?? null,
  };
}
