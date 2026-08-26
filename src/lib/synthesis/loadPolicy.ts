/**
 * Retained vault/conversation retrieval load discipline.
 *
 * Phases (implement gradually; do not fan out N queries per keystroke):
 *
 * 1. Schema live — zero extra queries until code calls RPC/inserts.
 * 2. Retrieval — one embed + one RPC per chat turn. Server logs 📊 min/mean/max
 *    similarity + per source_type counts (tune SYNTHESIS_MATCH_THRESHOLD from data).
 * 3. Retrieval index writer — `scheduleSynthesisReindex` + POST /api/synthesis/reindex
 *    (debounced, batch embeds, replace rows per source). Chunks: 900 chars with
 *    100-char overlap (server `SYNTHESIS_CHUNK_*` constants).
 */

export const SYNTHESIS_LOAD_POLICY = {
  /** Max chunks returned per semantic search call (DB caps at 32). */
  retrievalTopK: 8,
  /** Default similarity floor — align with match_lykn_synthesis_chunks default. */
  matchThreshold: 0.55,
  /** Rows per batch insert from the embed worker. */
  chunkInsertBatch: 24,
  /**
   * Minimum time between re-embedding the same logical source (board, note,
   * etc.). Acts as a per-source coalescence window: rapid saves (e.g. a user
   * typing into a board) all collapse into one POST /api/synthesis/reindex
   * after the user pauses for this long.
   *
   * Was 60_000 — that read as a UX lag because saved-but-not-yet-embedded
   * notes don't appear in semantic Vault retrieval until the chunks land.
   * Tightened to 15s; the
   * server-side embed budget is bounded by the chunk cap per source (64
   * chunks, embedded in a single OpenAI batch) so the marginal cost per
   * coalesced save is small.
   */
  minEmbedIntervalMs: 15_000,
  /** Server-side cache for retrieval (optional; Phase 2+). */
  retrievalCacheTtlMs: 45_000,
} as const;

export type SynthesisSourceType =
  | "vault_note"
  | "grid_board"
  | "conversation_exchange"
  | "project_file"
  | "profile_snapshot";
