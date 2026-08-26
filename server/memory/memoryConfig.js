// ============================================================================
// server/memory/memoryConfig.js — tunable constants for the Markdown memory core
// ============================================================================
// Memory Architecture Replacement, Phase 1. Every budget in the new memory
// system lives here so cost tuning is a one-file change. The entire point of
// this architecture is to cost less than Synthesis — keep these small.

/** V1 memory categories. Deliberately tiny ontology — resist growing it. */
export const MEMORY_TYPES = Object.freeze([
  'profile',
  'preferences',
  'goals',
  'decisions',
  'project',
  'topic',
  'relationships',
]);

/** Statuses a memory document can hold. */
export const MEMORY_STATUSES = Object.freeze(['active', 'archived']);

// --- Size caps (chars). The DB CHECK ceiling is 32768; the service budget
// --- stays well below it so compaction has headroom before writes hard-fail.
export const MEMORY_MARKDOWN_MAX_CHARS = 24_000;
export const MEMORY_SUMMARY_MAX_CHARS = 600;
export const MEMORY_NAME_MAX_CHARS = 120;
export const MEMORY_DESCRIPTION_MAX_CHARS = 300;
export const MEMORY_PATH_MAX_CHARS = 120;
/** Serialized provenance meta cap — provenance is a note, not a payload. */
export const MEMORY_META_MAX_CHARS = 2_000;
/** memory_create requires meaningful durable content, not a stub. */
export const MEMORY_MIN_CREATE_CHARS = 20;

// --- Hybrid retrieval token budgets ---------------------------------------
/** L0 — tiny automatic context (profile/preferences summaries only). */
export const MEMORY_L0_TOKEN_BUDGET = 300;
/** L1 — compact registry of paths + descriptions + summaries. */
export const MEMORY_REGISTRY_TOKEN_BUDGET = 700;
/** L2 — full documents loaded per turn. Default 0; hard max below. */
export const MEMORY_MAX_SELECTED_DOCUMENTS = 3;
/** L2 — total full-Markdown tokens allowed per turn across selections. */
export const MEMORY_DEEP_READ_TOKEN_BUDGET = 3_000;
/** Single memory_read output ceiling (backstop; write caps keep docs smaller). */
export const MEMORY_READ_MAX_TOKENS = 6_500;

// --- Maintenance thresholds (event/threshold driven, one document at a time)
/** A document at/over this size should be compacted before it hits the cap. */
export const MEMORY_COMPACTION_TRIGGER_CHARS = 16_000;
/** Exact-duplicate line ratio that flags a document for compaction. */
export const MEMORY_COMPACTION_DUPLICATE_RATIO = 0.2;

/**
 * Rough token estimate (~4 chars/token for English). Mirrors the repo-wide
 * convention (synthesis-service.js estimateTokensApprox, usageTracking.js
 * estimateTokens). Duplicated as a one-liner on purpose: synthesis-service.js
 * is a planned-legacy module and the new core must not depend on it.
 * @param {string} text
 * @returns {number}
 */
export function estimateMemoryTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}
