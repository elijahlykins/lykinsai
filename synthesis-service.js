// ============================================================================
// synthesis-service.js — embed + store helper for the synthesis layer
// ============================================================================
// Self-contained mirror of the synthesis embed/store path in server.js, made
// importable from backend modules that need to reindex on behalf of the user
// (currently: connectors/* for input-tool imports). server.js keeps its own
// inline copy so this extraction adds zero risk to existing call sites; we
// just have one extra place to maintain the chunker config until/unless we
// fully consolidate.
//
// Why this exists
// ---------------
// The Notion / GitHub / Slack / etc. connector adapters write rows into
// `notes` via the service-role admin client. The frontend's reindex bridge
// (src/lib/synthesis/queueReindex.ts) never sees those writes, so the AI's
// semantic retrieval can't find connector-imported content. Calling this
// module's `embedAndStoreChunks` inside the adapter's save path closes that
// loop — the same vector chunks the chat layer reads from get populated for
// connector-sourced notes too.
//
// Failure mode
// ------------
// Embeddings cost money and can rate-limit. If embed fails, we log + return
// `{ ok: false }` and the caller should NOT throw — the row is still in the
// vault and the next sync will retry the embed. We never want a transient
// OpenAI 429 to prevent users from seeing their Notion pages.
// ============================================================================

const SYNTHESIS_CHUNK_CHARS = 900;
const SYNTHESIS_CHUNK_OVERLAP = 100;
const SYNTHESIS_MAX_CHUNKS = 64;
const SYNTHESIS_EMBED_BATCH = 32;

// Mirror of server.js#chunkTextForSynthesis. Keep in sync if either changes.
export function chunkTextForSynthesis(raw) {
  const t = String(raw || '').trim().slice(0, 200_000);
  if (t.length < 8) return [];
  if (t.length <= SYNTHESIS_CHUNK_CHARS) return [t];
  const step = Math.max(1, SYNTHESIS_CHUNK_CHARS - SYNTHESIS_CHUNK_OVERLAP);
  const out = [];
  for (let i = 0; i < t.length && out.length < SYNTHESIS_MAX_CHUNKS; i += step) {
    out.push(t.slice(i, i + SYNTHESIS_CHUNK_CHARS));
  }
  return out;
}

async function openAiEmbedMany(strings) {
  if (!process.env.OPENAI_API_KEY || !strings.length) return null;
  const MAX_RETRIES = 5;
  const all = [];
  for (let i = 0; i < strings.length; i += SYNTHESIS_EMBED_BATCH) {
    const batch = strings.slice(i, i + SYNTHESIS_EMBED_BATCH);
    let res;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'text-embedding-3-small',
          dimensions: 1536,
          input: batch,
        }),
      });
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('retry-after'), 10);
        const delayMs = retryAfter > 0 ? retryAfter * 1000 : Math.min(1000 * 2 ** attempt, 30_000);
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      break;
    }
    if (!res || !res.ok) return null;
    const data = await res.json();
    const items = Array.isArray(data?.data) ? data.data : [];
    items.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    for (const item of items) {
      const emb = item?.embedding;
      if (!Array.isArray(emb) || emb.length !== 1536) return null;
      all.push(emb);
    }
  }
  return all.length === strings.length ? all : null;
}

/**
 * Embed `text` into `lykn_synthesis_chunks` for one source (e.g. one vault
 * note). Idempotent: hash-skips when nothing changed; upserts on the unique
 * `(user_id, source_type, source_id, chunk_index)` constraint; trims tail
 * chunks if the new version has fewer chunks than the previous one.
 *
 * @param {object} args
 * @param {object} args.supabaseAdmin  service-role client (required)
 * @param {string} args.userId         owner of the source
 * @param {string} args.sourceType     must be one of: 'vault_note', 'grid_board',
 *                                     'conversation_exchange' (matches server.js's
 *                                     SYNTHESIS_ALLOWED_SOURCES)
 * @param {string} args.sourceId       e.g. notes.id
 * @param {string} args.text           full text body to chunk + embed
 * @param {object} [args.metadata]     per-chunk metadata (title, source, etc.)
 * @returns {Promise<{ok: boolean, chunks: number, skipped?: boolean, reason?: string}>}
 */
export async function embedAndStoreChunks({
  supabaseAdmin,
  userId,
  sourceType,
  sourceId,
  text,
  metadata = {},
}) {
  if (!supabaseAdmin) return { ok: false, chunks: 0, reason: 'no_supabase_admin' };
  if (!userId || !sourceType || !sourceId) {
    return { ok: false, chunks: 0, reason: 'missing_required_args' };
  }
  if (!process.env.OPENAI_API_KEY) {
    return { ok: false, chunks: 0, reason: 'openai_key_missing' };
  }

  const chunks = chunkTextForSynthesis(text);

  // Empty content → drop any existing chunks (cleared note edge case).
  if (chunks.length === 0) {
    await supabaseAdmin
      .from('lykn_synthesis_chunks')
      .delete()
      .eq('user_id', userId)
      .eq('source_type', sourceType)
      .eq('source_id', String(sourceId));
    return { ok: true, chunks: 0, skipped: true, reason: 'no_content' };
  }

  // Hash-skip: if existing chunks match exactly, don't burn embed budget.
  try {
    const { data: existing } = await supabaseAdmin
      .from('lykn_synthesis_chunks')
      .select('chunk_index, content')
      .eq('user_id', userId)
      .eq('source_type', sourceType)
      .eq('source_id', String(sourceId))
      .order('chunk_index');
    if (Array.isArray(existing) && existing.length === chunks.length) {
      let allMatch = true;
      for (let i = 0; i < chunks.length; i++) {
        if (String(existing[i]?.content || '') !== String(chunks[i] || '')) {
          allMatch = false;
          break;
        }
      }
      if (allMatch) return { ok: true, chunks: existing.length, skipped: true };
    }
  } catch {
    // Optimization only; fall through to embed.
  }

  const embeddings = await openAiEmbedMany(chunks);
  if (!embeddings) return { ok: false, chunks: 0, reason: 'embed_failed' };

  const rows = chunks.map((content, chunk_index) => ({
    user_id: userId,
    source_type: sourceType,
    source_id: String(sourceId),
    chunk_index,
    content,
    embedding: embeddings[chunk_index],
    metadata: { ...metadata, chunk_index },
  }));

  const { error: upsertErr } = await supabaseAdmin
    .from('lykn_synthesis_chunks')
    .upsert(rows, { onConflict: 'user_id,source_type,source_id,chunk_index' });
  if (upsertErr) return { ok: false, chunks: 0, reason: `upsert_failed: ${upsertErr.message}` };

  // Best-effort tail cleanup if the new version has fewer chunks than the
  // previous one. Failure here only degrades precision marginally — recall
  // stays correct because the live chunks were already upserted above.
  try {
    await supabaseAdmin
      .from('lykn_synthesis_chunks')
      .delete()
      .eq('user_id', userId)
      .eq('source_type', sourceType)
      .eq('source_id', String(sourceId))
      .gte('chunk_index', rows.length);
  } catch {
    // ignore
  }

  return { ok: true, chunks: rows.length };
}
