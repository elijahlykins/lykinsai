import { supabase } from "@/lib/supabase";
import { API_BASE_URL } from "@/lib/api-config";
import {
  DEFAULT_STANDARD_MODEL,
  OPEN_SOURCE_MODEL_OPTIONS,
  normalizeVaultSource,
} from "@/lib/modelBuilder/draftDefaults";
import {
  readSynthesisModeFromMeta,
  sanitizeSynthesisNeuronRefs,
  sanitizeVaultNoteIds,
  vaultModeToVaultSource,
  vaultSourceToVaultMode,
} from "@/lib/modelBuilder/knowledgeSelection";
import { normalizeModelBehavior } from "@/lib/modelBuilder/modelBehaviorSettings";
import { resolveSystemPromptForDraft } from "@/lib/modelBuilder/syncSystemPromptBasics";
import {
  DEFAULT_MODEL_CAPABILITIES,
  capabilitiesToRuntimeToolNames,
  runtimeToolsToCapabilities,
  sanitizeModelCapabilities,
} from "@/lib/modelBuilder/modelCapabilitiesCatalog";

const FETCH_INIT = { cache: "no-store" };

async function authHeaders() {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token || "";
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/** Map builder draft → API body (snake_case). */
export function draftToApiBody(draft, { trainingSetId } = {}) {
  const baseKind = draft.baseKind === "open_source" ? "open_source" : "standard";
  const vaultKnowledgeMode = draft.vaultKnowledgeMode || vaultSourceToVaultMode(draft.vaultSource, {
    included_vault_note_ids: draft.includedVaultNoteIds,
  });
  const vaultSource = vaultModeToVaultSource(vaultKnowledgeMode);
  const synthesisKnowledgeMode = draft.synthesisKnowledgeMode || "all";
  const includedVaultNoteIds = sanitizeVaultNoteIds(draft.includedVaultNoteIds);
  const includedSynthesisNeurons = sanitizeSynthesisNeuronRefs(draft.includedSynthesisNeurons);

  return {
    id: draft.id || undefined,
    name: draft.name,
    base_kind: baseKind,
    base_model_id:
      baseKind === "open_source"
        ? draft.openSourceModelId
        : draft.standardModelId || draft.baseModelId,
    system_prompt: resolveSystemPromptForDraft(draft),
    beliefs: draft.beliefs || [],
    rules: draft.rules || [],
    vault_source: vaultSource,
    training_mode: draft.trainingMode || "prompt_only",
    training_epochs: draft.trainingEpochs ?? 3,
    include_chats: !!draft.includeChats,
    placed_blocks: draft.placedBlocks || [],
    training_set_id: trainingSetId || draft.trainingSetId || null,
    is_main_agent: !!draft.isMainAgent,
    sub_model_ids: draft.isMainAgent ? (draft.subModelIds || []) : [],
    chat_tools_enabled: draft.chatToolsEnabled !== false,
    chat_tool_names: capabilitiesToRuntimeToolNames(
      sanitizeModelCapabilities(draft.modelCapabilities || []),
    ),
    metadata: (() => {
      const description = (draft.description || "").trim();
      const excluded = draft.excludedSynthesisBeliefIds || [];
      const vaultTags = (draft.vaultTags || [])
        .map((t) => String(t || "").trim())
        .filter(Boolean);
      const modelCapabilities = sanitizeModelCapabilities(draft.modelCapabilities || []);
      const behavior = {
        response_length: draft.responseLength || "medium",
        ...(String(draft.responseTone || "").trim()
          ? { response_tone: String(draft.responseTone).trim() }
          : {}),
      };
      const linkedProjectId = String(draft.linkedProjectId || "").trim();
      const subModelIds = (draft.subModelIds || [])
        .map((id) => String(id || "").trim())
        .filter((id) => id.length > 8);
      return {
        ...(description ? { description } : {}),
        ...(linkedProjectId ? { linked_project_id: linkedProjectId } : {}),
        ...(excluded.length ? { excluded_synthesis_belief_ids: excluded } : {}),
        ...(vaultTags.length ? { vault_tags: vaultTags } : {}),
        ...(includedVaultNoteIds.length ? { included_vault_note_ids: includedVaultNoteIds } : {}),
        ...(synthesisKnowledgeMode === "selected" && includedSynthesisNeurons.length
          ? {
              synthesis_knowledge_mode: "selected",
              included_synthesis_neurons: includedSynthesisNeurons,
            }
          : synthesisKnowledgeMode === "selected"
            ? { synthesis_knowledge_mode: "selected" }
            : {}),
        ...(modelCapabilities.length ? { model_capabilities: modelCapabilities } : {}),
        ...(subModelIds.length ? { sub_model_ids: subModelIds } : {}),
        behavior,
      };
    })(),
  };
}

export function apiModelToDraft(model) {
  if (!model) return null;
  const baseKind = model.baseKind === "open_source" ? "open_source" : "standard";
  const meta = model.metadata || {};
  const vaultSource = normalizeVaultSource(model.vaultSource);
  const includedVaultNoteIds = sanitizeVaultNoteIds(
    meta.included_vault_note_ids ?? meta.includedVaultNoteIds,
  );
  const synthesisKnowledgeMode = readSynthesisModeFromMeta(meta);
  const includedSynthesisNeurons = sanitizeSynthesisNeuronRefs(
    meta.included_synthesis_neurons ?? meta.includedSynthesisNeurons,
  );
  return {
    id: model.id,
    name: model.name,
    description: (model.metadata?.description || "").trim(),
    status: model.status,
    baseKind,
    standardModelId:
      baseKind === "standard"
        ? model.baseModelId || model.standardModelId || DEFAULT_STANDARD_MODEL
        : model.standardModelId || DEFAULT_STANDARD_MODEL,
    openSourceModelId:
      baseKind === "open_source"
        ? model.baseModelId || model.openSourceModelId || OPEN_SOURCE_MODEL_OPTIONS[0].id
        : model.openSourceModelId || OPEN_SOURCE_MODEL_OPTIONS[0].id,
    beliefs: model.beliefs || [],
    excludedSynthesisBeliefIds:
      meta.excluded_synthesis_belief_ids ||
      meta.excludedSynthesisBeliefIds ||
      [],
    synthesisKnowledgeMode,
    includedSynthesisNeurons,
    linkedProjectId: String(
      meta.linked_project_id ?? meta.linkedProjectId ?? "",
    ).trim() || null,
    rules: model.rules || [],
    vaultSource,
    vaultKnowledgeMode: vaultSourceToVaultMode(vaultSource, meta),
    vaultTags: meta.vault_tags || meta.vaultTags || [],
    includedVaultNoteIds,
    ...normalizeModelBehavior(model.metadata || {}),
    systemPrompt: model.systemPrompt || "",
    trainingMode: model.trainingMode || "prompt_only",
    trainingEpochs: model.trainingEpochs ?? 3,
    includeChats: !!model.includeChats,
    placedBlocks: model.placedBlocks?.length ? model.placedBlocks : ["base", "beliefs", "prompt"],
    trainingSetId: model.trainingSetId || null,
    publishedAt: model.publishedAt || null,
    isMainAgent: !!model.isMainAgent,
    subModelIds: (() => {
      const raw = meta.sub_model_ids ?? meta.subModelIds ?? [];
      return Array.isArray(raw) ? raw.map((id) => String(id)) : [];
    })(),
    chatToolsEnabled:
      model.metadata?.chat_tools_enabled !== false && model.metadata?.chatToolsEnabled !== false,
    modelCapabilities: (() => {
      const meta = model.metadata || {};
      if (meta.chat_tools_enabled === false || meta.chatToolsEnabled === false) return [];
      if (Array.isArray(meta.model_capabilities)) {
        return sanitizeModelCapabilities(meta.model_capabilities);
      }
      if (Array.isArray(meta.modelCapabilities)) {
        return sanitizeModelCapabilities(meta.modelCapabilities);
      }
      const legacyTools = meta.chat_tool_names ?? meta.chatToolNames;
      if (Array.isArray(legacyTools) && legacyTools.length) {
        const inferred = runtimeToolsToCapabilities(legacyTools);
        if (inferred.length) return inferred;
      }
      return [...DEFAULT_MODEL_CAPABILITIES];
    })(),
    updatedAt: model.updatedAt || new Date().toISOString(),
  };
}

export async function fetchPublishedCustomModels() {
  const res = await fetch(`${API_BASE_URL}/api/v1/custom-models/published`, {
    ...FETCH_INIT,
    headers: await authHeaders(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.message || body?.error || `HTTP ${res.status}`);
  }
  return body.models || [];
}

export async function fetchLatestCustomModel() {
  const res = await fetch(`${API_BASE_URL}/api/v1/custom-models/latest`, {
    ...FETCH_INIT,
    headers: await authHeaders(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.message || body?.error || `HTTP ${res.status}`);
  }
  return body.model;
}

export async function fetchCustomModels() {
  const res = await fetch(`${API_BASE_URL}/api/v1/custom-models`, {
    ...FETCH_INIT,
    headers: await authHeaders(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.message || body?.error || `HTTP ${res.status}`);
  }
  return body.models || [];
}

export async function fetchCustomModel(id) {
  const res = await fetch(`${API_BASE_URL}/api/v1/custom-models/${encodeURIComponent(id)}`, {
    ...FETCH_INIT,
    headers: await authHeaders(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.message || body?.error || `HTTP ${res.status}`);
  }
  return body.model;
}

export async function saveCustomModelDraft(draft, { trainingSetId } = {}) {
  const payload = draftToApiBody(draft, { trainingSetId });
  const url = payload.id
    ? `${API_BASE_URL}/api/v1/custom-models/${payload.id}`
    : `${API_BASE_URL}/api/v1/custom-models`;
  const res = await fetch(url, {
    method: payload.id ? "PATCH" : "POST",
    headers: await authHeaders(),
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const hint =
      res.status === 404
        ? " Apply migration 076_lykn_custom_models.sql and restart the server."
        : "";
    throw new Error((body?.message || body?.error || `HTTP ${res.status}`) + hint);
  }
  return body.model;
}

export async function deleteCustomModel(modelId) {
  const id = String(modelId || "").trim();
  if (!id) throw new Error("Missing model id.");
  const res = await fetch(`${API_BASE_URL}/api/v1/custom-models/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: await authHeaders(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.message || body?.error || `HTTP ${res.status}`);
  }
  return body;
}

export async function publishCustomModel(draft, { trainingSetId } = {}) {
  const payload = draftToApiBody(draft, { trainingSetId });
  const url = payload.id
    ? `${API_BASE_URL}/api/v1/custom-models/${payload.id}/publish`
    : `${API_BASE_URL}/api/v1/custom-models/publish`;
  const res = await fetch(url, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const hint =
      res.status === 404
        ? " Apply migration 076_lykn_custom_models.sql and restart the server."
        : "";
    throw new Error((body?.message || body?.error || `HTTP ${res.status}`) + hint);
  }
  return body.model;
}
