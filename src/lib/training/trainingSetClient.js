import { supabase } from "@/lib/supabase";
import { API_BASE_URL } from "@/lib/api-config";

const TRAINING_FETCH_INIT = { cache: "no-store" };

async function authHeaders() {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token || "";
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function appendVaultTags(qs, vaultTags) {
  const tags = (vaultTags || []).map((t) => String(t || "").trim()).filter(Boolean);
  if (tags.length) qs.set("vault_tags", JSON.stringify(tags));
}

function appendKnowledgeParams(qs, {
  vaultNoteIds = [],
  synthesisMode = "all",
  excludedBeliefIds = [],
  includedNeurons = [],
} = {}) {
  const noteIds = (vaultNoteIds || []).map((id) => String(id || "").trim()).filter(Boolean);
  if (noteIds.length) qs.set("vault_note_ids", JSON.stringify(noteIds));
  if (synthesisMode && synthesisMode !== "all") qs.set("synthesis_mode", synthesisMode);
  const excluded = (excludedBeliefIds || []).map((id) => String(id || "").trim()).filter(Boolean);
  if (excluded.length) qs.set("excluded_belief_ids", JSON.stringify(excluded));
  const neurons = (includedNeurons || [])
    .map((n) => ({ kind: String(n?.kind || "").trim(), id: String(n?.id || "").trim() }))
    .filter((n) => n.kind && n.id);
  if (neurons.length) qs.set("included_synthesis_neurons", JSON.stringify(neurons));
}

export function trainingKnowledgeFromDraft(draft) {
  return {
    vaultNoteIds: draft?.includedVaultNoteIds || [],
    synthesisMode: draft?.synthesisKnowledgeMode || "all",
    excludedBeliefIds: draft?.excludedSynthesisBeliefIds || [],
    includedNeurons: draft?.includedSynthesisNeurons || [],
  };
}

export async function fetchTrainingSourcesPreview({
  vaultSource = "synthesis",
  includeChats = false,
  vaultTags = [],
  vaultNoteIds = [],
  synthesisMode = "all",
  excludedBeliefIds = [],
  includedNeurons = [],
} = {}) {
  const qs = new URLSearchParams({ vault_source: vaultSource });
  if (includeChats) qs.set("include_chats", "1");
  appendVaultTags(qs, vaultTags);
  appendKnowledgeParams(qs, { vaultNoteIds, synthesisMode, excludedBeliefIds, includedNeurons });
  const res = await fetch(`${API_BASE_URL}/api/v1/training-sets/sources-preview?${qs}`, {
    ...TRAINING_FETCH_INIT,
    headers: await authHeaders(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.message || body?.error || `HTTP ${res.status}`);
  }
  return body;
}

export async function startTrainingSetGeneration({
  vaultSource = "synthesis",
  includeChats = false,
  vaultTags = [],
  vaultNoteIds = [],
  synthesisMode = "all",
  excludedBeliefIds = [],
  includedNeurons = [],
} = {}) {
  const tags = (vaultTags || []).map((t) => String(t || "").trim()).filter(Boolean);
  const noteIds = (vaultNoteIds || []).map((id) => String(id || "").trim()).filter(Boolean);
  const excluded = (excludedBeliefIds || []).map((id) => String(id || "").trim()).filter(Boolean);
  const neurons = (includedNeurons || [])
    .map((n) => ({ kind: String(n?.kind || "").trim(), id: String(n?.id || "").trim() }))
    .filter((n) => n.kind && n.id);
  const res = await fetch(`${API_BASE_URL}/api/v1/training-sets/generate`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({
      vault_source: vaultSource,
      include_chats: !!includeChats,
      ...(tags.length ? { vault_tags: tags } : {}),
      ...(noteIds.length ? { vault_note_ids: noteIds } : {}),
      ...(synthesisMode && synthesisMode !== "all" ? { synthesis_mode: synthesisMode } : {}),
      ...(excluded.length ? { excluded_belief_ids: excluded } : {}),
      ...(neurons.length ? { included_synthesis_neurons: neurons } : {}),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const hint =
      res.status === 404
        ? " API route not found — restart `node server.js` after pulling the training-sets changes."
        : "";
    throw new Error((body?.message || body?.error || `HTTP ${res.status}`) + hint);
  }
  return body.job;
}

export async function fetchTrainingSetJob(jobId) {
  const res = await fetch(`${API_BASE_URL}/api/v1/training-sets/${jobId}`, {
    ...TRAINING_FETCH_INIT,
    headers: await authHeaders(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.message || body?.error || `HTTP ${res.status}`);
  }
  return body.job;
}

export async function fetchLatestTrainingSetJob() {
  const res = await fetch(`${API_BASE_URL}/api/v1/training-sets/latest`, {
    ...TRAINING_FETCH_INIT,
    headers: await authHeaders(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.message || body?.error || `HTTP ${res.status}`);
  }
  return body.job;
}

/**
 * Poll until ready, failed, or timeout.
 */
export async function downloadTrainingSetFile(jobId, format = "canonical") {
  const res = await fetch(
    `${API_BASE_URL}/api/v1/training-sets/${jobId}/download?format=${encodeURIComponent(format)}&_=${Date.now()}`,
    { ...TRAINING_FETCH_INIT, headers: await authHeaders() },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.message || body?.error || `HTTP ${res.status}`);
  }
  return res.blob();
}

export function trainingJobProgress(status) {
  if (status === "ready") return 100;
  if (status === "running") return 55;
  if (status === "failed") return 100;
  return 12;
}

export function trainingJobLabel(status, job) {
  const vault = job?.vault_source || job?.metadata?.vault_source;
  const usesVault = vault === "all" || vault === "tagged" || vault === "selected";
  const usesChats = !!job?.metadata?.include_chats;
  if (status === "queued") {
    if (usesVault && usesChats) return "Queued (synthesis, vault, chats)…";
    if (usesVault) return "Queued (vault + synthesis)…";
    if (usesChats) return "Queued (synthesis + chats)…";
    return "Queued…";
  }
  if (status === "running") {
    if (usesVault && usesChats) return "Generating synthesis, vault, and chat pairs…";
    if (usesVault) return "Generating pairs from vault + synthesis…";
    if (usesChats) return "Generating synthesis + chat pairs…";
    return "Generating training pairs…";
  }
  if (status === "ready") return "Training set ready";
  if (status === "failed") return "Generation failed";
  return status;
}

export function formatTrainingSourceSummary(metadata) {
  if (!metadata?.sources) return null;
  const syn = metadata.sources.synthesis_layer ?? 0;
  const doc = metadata.sources.raw_documents ?? 0;
  const chat = metadata.sources.past_conversations ?? 0;
  const parts = [];
  if (syn > 0) parts.push(`${syn} synthesis`);
  if (doc > 0) parts.push(`${doc} vault`);
  if (chat > 0) parts.push(`${chat} chats`);
  return parts.length ? parts.join(" · ") : null;
}

export function formatTrainingJobStamp(job) {
  if (!job?.id) return null;
  const when = job.completed_at || job.updated_at || job.created_at;
  if (!when) return `Run ${job.id.slice(0, 8)}`;
  try {
    const d = new Date(when);
    return `Run ${job.id.slice(0, 8)} · ${d.toLocaleString()}`;
  } catch {
    return `Run ${job.id.slice(0, 8)}`;
  }
}

export async function pollTrainingSetJob(jobId, { intervalMs = 2000, timeoutMs = 600_000, onTick } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = await fetchTrainingSetJob(jobId);
    onTick?.(job);
    if (job.status === "ready" || job.status === "failed") return job;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("Training set generation timed out");
}
