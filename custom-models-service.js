// ============================================================================
// custom-models-service.js — Model Builder persist + publish
// ============================================================================

import {
  capabilitiesToRuntimeToolNames,
  sanitizeModelCapabilities,
} from './lib/modelBuilder/modelCapabilitiesCatalog.js';
import { sanitizeChatToolNames } from './lib/modelBuilder/customModelChatTools.js';

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ALLOWED_VAULT_SOURCES = new Set(['all', 'synthesis', 'tagged', 'selected']);
const ALLOWED_TRAINING_MODES = new Set(['prompt_only', 'lora', 'full']);
const ALLOWED_BASE_KINDS = new Set(['standard', 'open_source']);

export class CustomModelValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CustomModelValidationError';
  }
}

function sanitizeName(raw) {
  const s = String(raw || '').trim();
  if (s.length < 1 || s.length > 120) {
    throw new CustomModelValidationError('Model name must be 1–120 characters.');
  }
  if (/^untitled model$/i.test(s)) {
    throw new CustomModelValidationError('Give your model a name before saving.');
  }
  return s;
}

function sanitizeSystemPrompt(raw) {
  const s = String(raw || '').trim();
  if (s.length < 20) {
    throw new CustomModelValidationError('System prompt is too short (min 20 characters).');
  }
  if (s.length > 48_000) {
    throw new CustomModelValidationError('System prompt is too long (max 48k characters).');
  }
  return s;
}

function sanitizeBeliefs(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((b) => String(b || '').trim())
    .filter(Boolean)
    .slice(0, 80);
}

function sanitizeRules(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const r of raw.slice(0, 80)) {
    const iff = String(r?.if || '').trim();
    const then = String(r?.then || '').trim();
    if (!iff || !then) continue;
    const entry = { if: iff, then };
    const beliefId = String(r?.belief_id || r?.beliefId || '').trim();
    const beliefText = String(r?.belief_text || r?.beliefText || '').trim();
    if (beliefId) entry.belief_id = beliefId;
    if (beliefText) entry.belief_text = beliefText;
    out.push(entry);
  }
  return out;
}

function sanitizePlacedBlocks(raw) {
  if (!Array.isArray(raw)) return ['base'];
  const blocks = raw.map((b) => String(b || '').trim()).filter(Boolean);
  return blocks.length ? blocks.slice(0, 20) : ['base'];
}

function sanitizeSubModelIds(raw, selfId) {
  const self = String(selfId || '').trim();
  const ids = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const item of ids) {
    const id = String(item || '').trim();
    if (!UUID_RE.test(id)) continue;
    if (self && id === self) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= 12) break;
  }
  return out;
}

function sanitizeCustomModelMetadata(rawMeta, body = {}, { selfId } = {}) {
  const meta =
    rawMeta && typeof rawMeta === 'object' && !Array.isArray(rawMeta) ? { ...rawMeta } : {};
  const toolsOff =
    body.chat_tools_enabled === false ||
    body.chatToolsEnabled === false ||
    meta.chat_tools_enabled === false ||
    meta.chatToolsEnabled === false;
  if (toolsOff) {
    meta.chat_tools_enabled = false;
    meta.chat_tool_names = [];
    meta.model_capabilities = [];
    return meta;
  }
  const capsRaw =
    body.model_capabilities ??
    body.modelCapabilities ??
    meta.model_capabilities ??
    meta.modelCapabilities;
  if (capsRaw !== undefined) {
    meta.model_capabilities = sanitizeModelCapabilities(capsRaw);
    meta.chat_tools_enabled = meta.model_capabilities.length > 0;
    meta.chat_tool_names = sanitizeChatToolNames(
      capabilitiesToRuntimeToolNames(meta.model_capabilities),
    );
    return meta;
  }
  const namesRaw =
    body.chat_tool_names ??
    body.chatToolNames ??
    body.enabled_chat_tools ??
    meta.chat_tool_names ??
    meta.chatToolNames ??
    meta.enabled_chat_tools;
  if (namesRaw !== undefined) {
    meta.chat_tools_enabled = true;
    meta.chat_tool_names = sanitizeChatToolNames(namesRaw);
  }
  const subRaw =
    body.sub_model_ids ??
    body.subModelIds ??
    meta.sub_model_ids ??
    meta.subModelIds;
  if (subRaw !== undefined) {
    meta.sub_model_ids = sanitizeSubModelIds(subRaw, selfId);
  }
  return meta;
}

async function clearOtherMainAgents(client, userId, keepModelId) {
  if (!client || !userId || !keepModelId) return;
  const { error } = await client
    .from('lykn_custom_models')
    .update({ is_main_agent: false })
    .eq('user_id', userId)
    .eq('is_main_agent', true)
    .neq('id', keepModelId);
  if (error) throw new Error(error.message);
}

export function buildModelPayloadFromBody(body = {}) {
  const baseKind = ALLOWED_BASE_KINDS.has(body.base_kind) ? body.base_kind : 'standard';
  const baseModelId = String(
    body.base_model_id ||
      (baseKind === 'open_source' ? body.open_source_model_id : body.standard_model_id) ||
      'lykn',
  ).trim();
  if (!baseModelId) throw new CustomModelValidationError('base_model_id is required.');

  const vaultSource = ALLOWED_VAULT_SOURCES.has(body.vault_source)
    ? body.vault_source
    : 'synthesis';
  let trainingMode = ALLOWED_TRAINING_MODES.has(body.training_mode)
    ? body.training_mode
    : 'prompt_only';
  if (trainingMode === 'full') trainingMode = 'lora';
  let trainingEpochs = Number(body.training_epochs);
  if (!Number.isFinite(trainingEpochs)) trainingEpochs = 3;
  trainingEpochs = Math.min(20, Math.max(1, Math.round(trainingEpochs)));

  const trainingSetId = body.training_set_id ? String(body.training_set_id).trim() : null;

  if (trainingMode === 'lora' && baseKind !== 'open_source') {
    throw new CustomModelValidationError(
      'LoRA training requires an open-weight base model in the Base block.',
    );
  }

  const isMainAgent =
    body.is_main_agent === true ||
    body.isMainAgent === true ||
    body.metadata?.is_main_agent === true ||
    body.metadata?.isMainAgent === true;
  const selfId = body.id ? String(body.id).trim() : null;

  return {
    name: sanitizeName(body.name),
    base_kind: baseKind,
    base_model_id: baseModelId.slice(0, 128),
    system_prompt: sanitizeSystemPrompt(body.system_prompt),
    beliefs: sanitizeBeliefs(body.beliefs),
    rules: sanitizeRules(body.rules),
    vault_source: vaultSource,
    training_mode: trainingMode,
    training_epochs: trainingEpochs,
    include_chats: !!body.include_chats,
    placed_blocks: sanitizePlacedBlocks(body.placed_blocks),
    training_set_id: trainingSetId || null,
    is_main_agent: isMainAgent,
    metadata: (() => {
      const meta = sanitizeCustomModelMetadata(body.metadata, body, { selfId });
      if (!isMainAgent) meta.sub_model_ids = [];
      return meta;
    })(),
  };
}

async function assertTrainingSetOwned(client, userId, trainingSetId) {
  if (!trainingSetId) return null;
  const { data, error } = await client
    .from('lykn_training_sets')
    .select('id, status')
    .eq('id', trainingSetId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new CustomModelValidationError('Linked training set not found.');
  if (data.status !== 'ready') {
    throw new CustomModelValidationError('Linked training set is not ready yet.');
  }
  return data.id;
}

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

export function clientModelToDraft(model) {
  if (!model) return null;
  const meta = model.metadata || {};
  return {
    id: model.id,
    name: model.name,
    status: model.status,
    isMainAgent: !!model.isMainAgent,
    subModelIds: Array.isArray(meta.sub_model_ids)
      ? meta.sub_model_ids
      : Array.isArray(meta.subModelIds)
        ? meta.subModelIds
        : [],
    baseKind: model.baseKind || 'standard',
    standardModelId:
      model.baseKind === 'standard'
        ? model.baseModelId || model.standardModelId
        : model.standardModelId,
    openSourceModelId:
      model.baseKind === 'open_source'
        ? model.baseModelId || model.openSourceModelId
        : model.openSourceModelId,
    beliefs: model.beliefs || [],
    rules: model.rules || [],
    vaultSource: model.vaultSource || 'synthesis',
    systemPrompt: model.systemPrompt || '',
    trainingMode: model.trainingMode || 'prompt_only',
    trainingEpochs: model.trainingEpochs ?? 3,
    includeChats: !!model.includeChats,
    placedBlocks: model.placedBlocks || ['base', 'beliefs', 'prompt'],
    trainingSetId: model.trainingSetId || null,
    publishedAt: model.publishedAt || null,
    updatedAt: model.updatedAt || new Date().toISOString(),
  };
}

export async function listCustomModels(client, userId, { limit = 20 } = {}) {
  const { data, error } = await client
    .from('lykn_custom_models')
    .select(SELECT_COLS)
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 50));
  if (error) throw new Error(error.message);
  return (data || []).map(modelRowToClient);
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

export async function getLatestCustomModel(client, userId) {
  const { data, error } = await client
    .from('lykn_custom_models')
    .select(SELECT_COLS)
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return modelRowToClient(data);
}

export async function createCustomModel(client, userId, body, { publish = false } = {}) {
  const payload = buildModelPayloadFromBody(body);
  if (payload.training_set_id) {
    payload.training_set_id = await assertTrainingSetOwned(client, userId, payload.training_set_id);
  }

  const now = new Date().toISOString();
  const row = {
    user_id: userId,
    ...payload,
    status: publish ? 'published' : 'draft',
    published_at: publish ? now : null,
    updated_at: now,
  };

  const { data, error } = await client
    .from('lykn_custom_models')
    .insert(row)
    .select(SELECT_COLS)
    .single();
  if (error) throw new Error(error.message);
  if (row.is_main_agent && data?.id) {
    await clearOtherMainAgents(client, userId, data.id);
  }
  return modelRowToClient(data);
}

function mergeClientBody(existing, body = {}) {
  return {
    id: existing?.id,
    name: body.name ?? existing?.name,
    base_kind: body.base_kind ?? existing?.baseKind,
    base_model_id: body.base_model_id ?? existing?.baseModelId,
    system_prompt: body.system_prompt ?? existing?.systemPrompt,
    beliefs: body.beliefs ?? existing?.beliefs,
    rules: body.rules ?? existing?.rules,
    vault_source: body.vault_source ?? existing?.vaultSource,
    training_mode: body.training_mode ?? existing?.trainingMode,
    training_epochs: body.training_epochs ?? existing?.trainingEpochs,
    include_chats: body.include_chats ?? existing?.includeChats,
    placed_blocks: body.placed_blocks ?? existing?.placedBlocks,
    training_set_id: body.training_set_id ?? existing?.trainingSetId,
    metadata: body.metadata ?? existing?.metadata,
    is_main_agent: body.is_main_agent ?? body.isMainAgent ?? existing?.isMainAgent,
    sub_model_ids: body.sub_model_ids ?? body.subModelIds,
  };
}

export async function updateCustomModel(client, userId, modelId, body, { publish = false } = {}) {
  const existing = await getCustomModel(client, userId, modelId);
  if (!existing) return null;

  const payload = buildModelPayloadFromBody(mergeClientBody(existing, body));
  if (payload.training_set_id) {
    payload.training_set_id = await assertTrainingSetOwned(client, userId, payload.training_set_id);
  }

  const now = new Date().toISOString();
  const patch = {
    ...payload,
    updated_at: now,
  };
  if (publish) {
    patch.status = 'published';
    patch.published_at = now;
  }

  const { data, error } = await client
    .from('lykn_custom_models')
    .update(patch)
    .eq('id', modelId)
    .eq('user_id', userId)
    .select(SELECT_COLS)
    .single();
  if (error) throw new Error(error.message);
  if (patch.is_main_agent && data?.id) {
    await clearOtherMainAgents(client, userId, data.id);
  }
  return modelRowToClient(data);
}

export async function saveCustomModelDraft(client, userId, body) {
  const id = body.id ? String(body.id).trim() : null;
  if (id) {
    const updated = await updateCustomModel(client, userId, id, body, { publish: false });
    if (updated) return updated;
  }
  return createCustomModel(client, userId, body, { publish: false });
}

export async function publishCustomModel(client, userId, body) {
  const id = body.id ? String(body.id).trim() : null;
  if (id) {
    const updated = await updateCustomModel(client, userId, id, body, { publish: true });
    if (updated) return updated;
  }
  return createCustomModel(client, userId, body, { publish: true });
}

export async function deleteCustomModel(client, userId, modelId) {
  const { error } = await client
    .from('lykn_custom_models')
    .delete()
    .eq('id', modelId)
    .eq('user_id', userId);
  if (error) throw new Error(error.message);
}
