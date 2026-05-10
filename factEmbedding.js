// ============================================================================
// factEmbedding.js — embed-on-write helper for lykn_user_model_facts
// ============================================================================
// The nightly synthesis job (PR2) needs a vector space over facts: UMAP +
// HDBSCAN cluster facts, qualifying clusters become belief proposals.
// Migration 047 added `embedding vector(1536)` to lykn_user_model_facts;
// this module is the application-side responsibility for actually
// populating it.
//
// Design choices:
//
//   • Fire-and-forget. We do NOT block fact insertion on the embedding
//     round-trip. A fact landing without an embedding is fine — the
//     backfill script will pick it up later and the synthesis job
//     skips facts where embedding IS NULL anyway. The user-perceptible
//     write latency stays at one Supabase round-trip.
//
//   • No cache. server.js's openAiEmbedQueryText caches because the
//     retrieval path repeatedly embeds the same chat input. Fact writes
//     are write-once-per-text — caching would mostly miss. Skipping the
//     cache also means we don't carry server.js's memCache dependency
//     into this module.
//
//   • Same model + dimensions as everything else: text-embedding-3-small
//     @ 1536d, matching the ivfflat index in migration 047. If you ever
//     change the model, change ALL three sites (this file, the index,
//     and server.js's helpers) together — mismatched dims silently
//     return zero recall.
//
//   • Usage logging is best-effort. logAiUsage failures should never
//     prevent a fact embedding from being written.

import { logAiUsage } from './usageTracking.js';

const EMBED_MODEL = 'text-embedding-3-small';
const EMBED_DIMS = 1536;
const MAX_INPUT_CHARS = 8000;

/**
 * Compute the embedding for a single fact's text. Returns the 1536-d vector,
 * or null if anything went wrong (no API key, blank text, HTTP error,
 * malformed response). Callers are expected to no-op when null comes back.
 */
export async function embedFactText(text, { userId = null } = {}) {
  if (!process.env.OPENAI_API_KEY) return null;
  const input = String(text || '').trim().slice(0, MAX_INPUT_CHARS);
  if (input.length < 4) return null;

  try {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: EMBED_MODEL,
        dimensions: EMBED_DIMS,
        input,
      }),
    });
    if (!res.ok) {
      console.warn('⚠️ factEmbedding HTTP', res.status);
      return null;
    }
    const data = await res.json();
    const emb = data?.data?.[0]?.embedding;
    if (!Array.isArray(emb) || emb.length !== EMBED_DIMS) return null;

    // Best-effort usage tracking. We swallow any error — the embedding
    // itself is the deliverable, and a logging failure must not cause
    // the caller to retry or fall back.
    if (userId) {
      try {
        const promptTokens =
          data?.usage?.prompt_tokens ||
          data?.usage?.total_tokens ||
          Math.ceil(input.length / 4);
        logAiUsage({
          userId,
          actionType: 'embedding_fact_write',
          model: EMBED_MODEL,
          provider: 'openai',
          inputTokens: promptTokens,
          outputTokens: 0,
          metadata: { input_chars: input.length },
        }).catch(() => {});
      } catch {
        // No-op — never let logging interrupt the embed-on-write path.
      }
    }

    return emb;
  } catch (e) {
    console.warn('⚠️ factEmbedding error:', e?.message || e);
    return null;
  }
}

/**
 * Compute and persist an embedding for a fact row. Fire-and-forget shape:
 * returns immediately on the embedding side and logs failures rather than
 * surfacing them. Caller passes the `id` of the row just upserted; we
 * UPDATE in place with both `embedding` and `embedded_at`.
 *
 * The Supabase client passed in MUST be one that can update the fact row
 * — usually `supabaseAdmin` for service-role contexts, or the user's
 * authenticated client for RLS-bound paths.
 */
export async function embedAndPersistFact(client, { factId, userId, factText }) {
  if (!client || !factId || !factText) return;
  try {
    const emb = await embedFactText(factText, { userId });
    if (!emb) return;
    const { error } = await client
      .from('lykn_user_model_facts')
      .update({
        embedding: emb,
        embedded_at: new Date().toISOString(),
      })
      .eq('id', factId)
      .eq('user_id', userId);
    if (error) {
      console.warn('⚠️ embedAndPersistFact update:', error.message);
    }
  } catch (e) {
    console.warn('⚠️ embedAndPersistFact threw:', e?.message || e);
  }
}
