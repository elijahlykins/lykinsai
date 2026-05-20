// ============================================================================
// conceptEmbedding.js — embed-on-write helper for lykn_concepts
// ============================================================================
// Mirrors factEmbedding.js. The nightly conceptsJob (jobs/conceptsJob.js)
// needs a vector space over concept labels for two reasons:
//
//   1. Cluster-to-concept dedup: when the job names a new chunk
//      cluster, it compares the proposed name's embedding to every
//      live concept's embedding. > 0.85 cosine → attach to the
//      existing concept instead of minting a duplicate.
//
//   2. Briefing / graph cross-links: a fact or belief whose
//      embedding is > 0.80 cosine to a concept gets a row in
//      concept_facts / concept_beliefs even if the cluster didn't
//      surface it directly.
//
// Design notes (same shape as factEmbedding.js):
//
//   • Fire-and-forget. Concept writes don't block on the embedding
//     round-trip — a concept landing without an embedding still
//     renders fine; the nightly dedup just can't catch it until
//     a later run / backfill fills it in.
//
//   • Same model + dims as everything else: text-embedding-3-small
//     @ 1536d, matching the ivfflat index in migration 056. If you
//     ever change the model, change ALL embedding sites (this file,
//     factEmbedding.js, server.js helpers, all three ivfflat indexes
//     in 047 / 049 / 056) together — mismatched dims silently return
//     zero recall.
//
//   • Usage logging is best-effort.

import { logAiUsage } from './usageTracking.js';

const EMBED_MODEL = 'text-embedding-3-small';
const EMBED_DIMS = 1536;
const MAX_INPUT_CHARS = 8000;

/**
 * Compute the embedding for a concept label. Returns the 1536-d
 * vector, or null on any error path. Concept labels are short
 * (≤128 chars by the migration's CHECK constraint) so we don't
 * need the long-text slicing fact embedding does — but we keep
 * the same shape for symmetry.
 */
export async function embedConceptLabel(text, { userId = null } = {}) {
  if (!process.env.OPENAI_API_KEY) return null;
  const input = String(text || '').trim().slice(0, MAX_INPUT_CHARS);
  if (input.length < 2) return null;

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
      console.warn('⚠️ conceptEmbedding HTTP', res.status);
      return null;
    }
    const data = await res.json();
    const emb = data?.data?.[0]?.embedding;
    if (!Array.isArray(emb) || emb.length !== EMBED_DIMS) return null;

    if (userId) {
      try {
        const promptTokens =
          data?.usage?.prompt_tokens ||
          data?.usage?.total_tokens ||
          Math.ceil(input.length / 4);
        logAiUsage({
          userId,
          actionType: 'embedding_concept_write',
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
    console.warn('⚠️ conceptEmbedding error:', e?.message || e);
    return null;
  }
}

/**
 * Compute and persist an embedding for a concept row. Fire-and-forget:
 * caller passes the concept row's `id` and `label` and we UPDATE in
 * place with both `embedding` and `embedded_at`. Pass a service-role
 * client for the nightly job, or the authenticated client for the
 * user-create REST endpoint.
 */
export async function embedAndPersistConcept(client, { conceptId, userId, label }) {
  if (!client || !conceptId || !label) return;
  try {
    const emb = await embedConceptLabel(label, { userId });
    if (!emb) return;
    const { error } = await client
      .from('lykn_concepts')
      .update({
        embedding: emb,
        embedded_at: new Date().toISOString(),
      })
      .eq('id', conceptId)
      .eq('user_id', userId);
    if (error) {
      console.warn('⚠️ embedAndPersistConcept update:', error.message);
    }
  } catch (e) {
    console.warn('⚠️ embedAndPersistConcept threw:', e?.message || e);
  }
}

/**
 * Compute the normalised dedup slug for a concept label. Mirrors the
 * lower(trim(...)) shape enforced by the partial unique index in
 * migration 056. Application MUST use this helper everywhere a slug
 * is computed so a backfill and the nightly job converge on the same
 * key.
 */
export function conceptSlug(label) {
  return String(label || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 128);
}
