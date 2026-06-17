// ============================================================================
// custom-models-service.js — published custom model read path
// ============================================================================
//
// The Model Builder create/edit/publish flow was retired along with its UI.
// What remains is the read path the chat runtime uses to load a user's
// published custom models (getCustomModel / listPublishedCustomModels) so they
// can still be selected and run in chat.

const SELECT_COLS = [
  'id',
  'user_id',
  'name',
  'status',
  'base_kind',
  'base_model_id',
  'system_prompt',
  'beliefs',
  'rules',
  'vault_source',
  'training_mode',
  'training_epochs',
  'include_chats',
  'placed_blocks',
  'training_set_id',
  'metadata',
  'is_main_agent',
  'created_at',
  'updated_at',
  'published_at',
].join(', ');

export function modelRowToClient(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    baseKind: row.base_kind,
    baseModelId: row.base_model_id,
    standardModelId: row.base_kind === 'standard' ? row.base_model_id : null,
    openSourceModelId: row.base_kind === 'open_source' ? row.base_model_id : null,
    systemPrompt: row.system_prompt,
    beliefs: row.beliefs || [],
    rules: row.rules || [],
    vaultSource: row.vault_source,
    trainingMode: row.training_mode,
    trainingEpochs: row.training_epochs,
    includeChats: !!row.include_chats,
    placedBlocks: row.placed_blocks || [],
    trainingSetId: row.training_set_id,
    isMainAgent: !!row.is_main_agent,
    metadata: row.metadata || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
  };
}

export async function getCustomModel(client, userId, modelId) {
  const { data, error } = await client
    .from('lykn_custom_models')
    .select(SELECT_COLS)
    .eq('id', modelId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return modelRowToClient(data);
}

export async function listPublishedCustomModels(client, userId, { limit = 20 } = {}) {
  const { data, error } = await client
    .from('lykn_custom_models')
    .select(SELECT_COLS)
    .eq('user_id', userId)
    .eq('status', 'published')
    .order('published_at', { ascending: false, nullsFirst: false })
    .order('updated_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 50));
  if (error) throw new Error(error.message);
  return (data || []).map(modelRowToClient);
}
