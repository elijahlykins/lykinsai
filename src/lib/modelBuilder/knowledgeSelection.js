/** @typedef {'all' | 'selected'} SynthesisKnowledgeMode */
/** @typedef {'off' | 'all' | 'tags' | 'pick'} VaultKnowledgeMode */
/** @typedef {'belief' | 'fact' | 'rule' | 'concept'} SynthesisNeuronKind */

/** @typedef {{ kind: SynthesisNeuronKind, id: string, label?: string }} SynthesisNeuronRef */

export const SYNTHESIS_NEURON_KINDS = /** @type {const} */ ([
  "belief",
  "fact",
  "rule",
  "concept",
]);

export function neuronKey(kind, id) {
  return `${kind}:${id}`;
}

export function parseNeuronKey(key) {
  const raw = String(key || "");
  const idx = raw.indexOf(":");
  if (idx <= 0) return null;
  return { kind: raw.slice(0, idx), id: raw.slice(idx + 1) };
}

/** @param {unknown} raw */
/**
 * Map a clustered project member (graph node_id) → Model Builder neuron ref.
 * @param {{ nodeId?: string, label?: string | null, kind?: string | null } | null | undefined} member
 * @returns {SynthesisNeuronRef | null}
 */
export function projectMemberToSynthesisNeuron(member) {
  const nodeId = String(member?.nodeId || "").trim();
  if (!nodeId) return null;
  const label = String(member?.label || "").trim();
  const withLabel = label ? { label } : {};

  if (nodeId.startsWith("belief_")) {
    return { kind: "belief", id: nodeId.slice("belief_".length), ...withLabel };
  }
  if (nodeId.startsWith("fact_")) {
    return { kind: "fact", id: nodeId.slice("fact_".length), ...withLabel };
  }
  if (nodeId.startsWith("concept_")) {
    return { kind: "concept", id: nodeId.slice("concept_".length), ...withLabel };
  }
  return null;
}

/**
 * Map a clustered vault project member → vault note id for Model Builder.
 * Supports `vault_<noteId>` and `vault_<noteId>_att_<idx>` graph ids.
 * @param {{ nodeId?: string } | null | undefined} member
 * @returns {string | null}
 */
export function projectMemberToVaultNoteId(member) {
  const nodeId = String(member?.nodeId || "").trim();
  if (!nodeId.startsWith("vault_")) return null;
  const rest = nodeId.slice("vault_".length);
  // Connector rollups (`vault_source_gmail`, …) are not single note rows.
  if (rest.startsWith("source_")) return null;
  const attIdx = rest.indexOf("_att_");
  const noteId = attIdx >= 0 ? rest.slice(0, attIdx) : rest;
  const id = String(noteId || "").trim();
  return id.length > 0 ? id : null;
}

/** @param {unknown} members */
export function projectMembersToVaultNoteIds(members) {
  if (!Array.isArray(members)) return [];
  return sanitizeVaultNoteIds(
    members.map((m) => projectMemberToVaultNoteId(m)).filter(Boolean),
  );
}

/** @param {unknown} members */
export function projectMembersToSynthesisNeurons(members) {
  if (!Array.isArray(members)) return [];
  return sanitizeSynthesisNeuronRefs(
    members.map((m) => projectMemberToSynthesisNeuron(m)).filter(Boolean),
  );
}

/**
 * Build draft patch when linking / changing / clearing a connected project.
 * @param {object} draft
 * @param {{ id?: string, members?: unknown[] } | null | undefined} project
 * @param {{ previousProject?: { members?: unknown[] } | null, forceSelected?: boolean }} [opts]
 */
export function buildLinkedProjectPatch(draft, project, opts = {}) {
  const { previousProject = null, forceSelected = true } = opts;
  const prevNeurons = projectMembersToSynthesisNeurons(previousProject?.members || []);
  const prevKeys = new Set(prevNeurons.map((n) => neuronKey(n.kind, n.id)));
  const existing = draft.includedSynthesisNeurons || [];
  const kept = prevKeys.size
    ? existing.filter((n) => !prevKeys.has(neuronKey(n.kind, n.id)))
    : existing;

  const prevVaultIds = projectMembersToVaultNoteIds(previousProject?.members || []);
  const prevVaultSet = new Set(prevVaultIds);
  const existingVault = draft.includedVaultNoteIds || [];
  const keptVault = prevVaultSet.size
    ? existingVault.filter((id) => !prevVaultSet.has(id))
    : existingVault;

  if (!project?.id) {
    const patch = {
      linkedProjectId: null,
      includedSynthesisNeurons: sanitizeSynthesisNeuronRefs(kept),
      includedVaultNoteIds: sanitizeVaultNoteIds(keptVault),
    };
    if (!keptVault.length && (draft.vaultKnowledgeMode || "off") === "pick") {
      patch.vaultKnowledgeMode = "off";
      patch.vaultSource = vaultModeToVaultSource("off");
    }
    return patch;
  }

  const projectNeurons = projectMembersToSynthesisNeurons(project.members || []);
  const projectVaultIds = projectMembersToVaultNoteIds(project.members || []);
  const merged = sanitizeSynthesisNeuronRefs([...kept, ...projectNeurons]);
  const mergedVault = sanitizeVaultNoteIds([...keptVault, ...projectVaultIds]);
  const patch = {
    linkedProjectId: project.id,
    includedSynthesisNeurons: merged,
    includedVaultNoteIds: mergedVault,
  };

  if (forceSelected && (merged.length > 0 || projectNeurons.length > 0)) {
    patch.synthesisKnowledgeMode = "selected";
  }
  if (forceSelected && mergedVault.length > 0) {
    patch.vaultKnowledgeMode = "pick";
    patch.vaultSource = vaultModeToVaultSource("pick");
  }

  const beliefLabels = projectNeurons
    .filter((n) => n.kind === "belief" && n.label)
    .map((n) => String(n.label).trim())
    .filter(Boolean);
  if (beliefLabels.length) {
    const seen = new Set(beliefLabels.map((t) => t.toLowerCase()));
    const extra = (draft.beliefs || []).filter((b) => {
      const t = String(b || "").trim();
      return t && !seen.has(t.toLowerCase());
    });
    patch.beliefs = [...beliefLabels, ...extra];
  }

  return patch;
}

export function sanitizeSynthesisNeuronRefs(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const kind = String(item?.kind || "").trim();
    const id = String(item?.id || "").trim();
    if (!SYNTHESIS_NEURON_KINDS.includes(kind) || !id) continue;
    const key = neuronKey(kind, id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      kind,
      id,
      ...(String(item?.label || "").trim() ? { label: String(item.label).trim() } : {}),
    });
  }
  return out;
}

/** @param {unknown} raw */
export function sanitizeVaultNoteIds(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const id of raw) {
    const n = String(id || "").trim();
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/**
 * Map UI vault mode → persisted vault_source column.
 * @param {VaultKnowledgeMode} mode
 */
export function vaultModeToVaultSource(mode) {
  if (mode === "all") return "all";
  if (mode === "tags") return "tagged";
  if (mode === "pick") return "selected";
  return "synthesis";
}

/**
 * @param {string | undefined} vaultSource
 * @param {unknown} meta
 * @returns {VaultKnowledgeMode}
 */
export function vaultSourceToVaultMode(vaultSource, meta = {}) {
  if (vaultSource === "selected") return "pick";
  if (vaultSource === "all") return "all";
  if (vaultSource === "tagged") return "tags";
  const noteIds = sanitizeVaultNoteIds(meta.included_vault_note_ids ?? meta.includedVaultNoteIds);
  if (noteIds.length) return "pick";
  return "off";
}

/**
 * @param {object} meta
 * @returns {SynthesisKnowledgeMode}
 */
export function readSynthesisModeFromMeta(meta = {}) {
  const mode = meta.synthesis_knowledge_mode ?? meta.synthesisKnowledgeMode;
  if (mode === "selected") return "selected";
  const included = sanitizeSynthesisNeuronRefs(
    meta.included_synthesis_neurons ?? meta.includedSynthesisNeurons,
  );
  if (included.length) return "selected";
  return "all";
}

export function validateKnowledgeStep(draft) {
  const errors = [];
  const vaultMode = draft.vaultKnowledgeMode || "off";
  const synthesisMode = draft.synthesisKnowledgeMode || "all";

  if (vaultMode === "tags" && !(draft.vaultTags || []).length) {
    errors.push("Pick at least one vault tag, or change vault scope.");
  }
  if (vaultMode === "pick" && !(draft.includedVaultNoteIds || []).length) {
    errors.push("Select at least one vault file, or change vault scope.");
  }
  if (synthesisMode === "selected" && !(draft.includedSynthesisNeurons || []).length) {
    errors.push("Select at least one synthesis neuron, or use the full synthesis layer.");
  }

  return { ok: errors.length === 0, errors };
}
