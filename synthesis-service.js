// ============================================================================
// synthesis-service.js — legacy-named vault retrieval index helper
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

import { contextualizeChunks } from './lib/rag/contextualize.js';

// ---------------------------------------------------------------------------
// Chunking (Level 2 — "stop splitting blindly")
// ---------------------------------------------------------------------------
// The old splitter cut the text every 900 chars regardless of where it landed,
// routinely slicing through the middle of a sentence so neither half embedded
// cleanly. This version is STRUCTURE- and SENTENCE-aware:
//   • short docs stay whole (one chunk) — no fragmentation of a tweet/note;
//   • long docs split on paragraph then sentence boundaries, never mid-sentence
//     (unless a single sentence is itself larger than the hard ceiling);
//   • consecutive chunks share a one-sentence overlap so a fact spanning a
//     boundary is still recoverable from either side;
//   • a runt tail chunk is merged back into its predecessor.
//
// Sizing is token-budgeted via a chars≈tokens/4 heuristic. Target ~275 tokens
// per chunk (good recall granularity) with a ~400-token hard ceiling. This is
// the single source of truth — server.js imports it (no more drifting copy).
export const SYNTHESIS_CHUNK_CHARS = 1100; // ~275 tokens target
const SYNTHESIS_CHUNK_MAX_CHARS = 1600; // ~400 tokens hard ceiling / keep-whole threshold
const SYNTHESIS_CHUNK_MIN_CHARS = 250; // merge a tail smaller than this
export const SYNTHESIS_MAX_CHUNKS = 64;
export const SYNTHESIS_EMBED_BATCH = 32;

const SYNTHESIS_INPUT_CAP = 200_000;

/** Rough token estimate (OpenAI BPE averages ~4 chars/token for English). */
export function estimateTokensApprox(text) {
  return Math.ceil(String(text || '').length / 4);
}

/** Split a paragraph into sentence-ish units without breaking decimals/abbrevs too badly. */
function splitSentences(paragraph) {
  const p = String(paragraph || '').trim();
  if (!p) return [];
  // Break after . ! ? (and closing quote/paren) when followed by whitespace +
  // a capital/quote/digit — keeps "3.5", "e.g." etc. mostly intact.
  const parts = p.split(/(?<=[.!?]["')\]]?)\s+(?=[A-Z0-9"'(\[])/);
  return parts.map((s) => s.trim()).filter(Boolean);
}

/**
 * Break raw text into ordered "units" (heading lines, list items, sentences)
 * that we never split across — the atoms the packer assembles into chunks.
 */
function textToUnits(text) {
  const units = [];
  // Paragraph blocks first (blank-line separated). Headings/list lines survive
  // as their own blocks because they're typically on their own line.
  const blocks = text.split(/\n{2,}/);
  for (const block of blocks) {
    const b = block.trim();
    if (!b) continue;
    // A markdown heading or a short single line stays atomic.
    const isHeading = /^#{1,6}\s/.test(b) || /^([-*+]|\d+[.)])\s/.test(b);
    if (isHeading || b.length <= SYNTHESIS_CHUNK_CHARS) {
      units.push(b);
      continue;
    }
    for (const s of splitSentences(b)) units.push(s);
  }
  return units;
}

/** Hard-split a single oversized unit on char boundaries (last resort). */
function hardSplit(unit) {
  const out = [];
  for (let i = 0; i < unit.length; i += SYNTHESIS_CHUNK_MAX_CHARS) {
    out.push(unit.slice(i, i + SYNTHESIS_CHUNK_MAX_CHARS));
  }
  return out;
}

/**
 * Structure/sentence-aware chunker. Returns an array of chunk strings.
 * Single source of truth shared by the reindex API and connector adapters.
 */
export function chunkTextForSynthesis(raw) {
  const t = String(raw || '').trim().slice(0, SYNTHESIS_INPUT_CAP);
  if (t.length < 8) return [];
  if (t.length <= SYNTHESIS_CHUNK_MAX_CHARS) return [t];

  const units = textToUnits(t);
  if (units.length === 0) return [t.slice(0, SYNTHESIS_CHUNK_MAX_CHARS)];

  const chunks = [];
  let current = [];
  let currentLen = 0;

  const flush = () => {
    if (!current.length) return;
    chunks.push(current.join(' ').trim());
    // One-unit overlap: carry the last sentence forward, but only if it's small
    // enough to be a cheap bridge (not a whole oversized paragraph).
    const last = current[current.length - 1];
    current = last && last.length <= 300 ? [last] : [];
    currentLen = current.reduce((a, u) => a + u.length + 1, 0);
  };

  for (const rawUnit of units) {
    if (chunks.length >= SYNTHESIS_MAX_CHUNKS) break;
    const pieces = rawUnit.length > SYNTHESIS_CHUNK_MAX_CHARS ? hardSplit(rawUnit) : [rawUnit];
    for (const unit of pieces) {
      const addLen = unit.length + 1;
      // If adding this unit overflows the target and we already have content,
      // flush first so we break on the boundary, not inside the unit.
      if (currentLen > 0 && currentLen + addLen > SYNTHESIS_CHUNK_CHARS) {
        flush();
        if (chunks.length >= SYNTHESIS_MAX_CHUNKS) break;
      }
      current.push(unit);
      currentLen += addLen;
    }
  }
  if (current.length && chunks.length < SYNTHESIS_MAX_CHUNKS) {
    chunks.push(current.join(' ').trim());
  }

  // Merge a runt final chunk into its predecessor (overlap can leave a tiny tail).
  if (
    chunks.length >= 2 &&
    chunks[chunks.length - 1].length < SYNTHESIS_CHUNK_MIN_CHARS
  ) {
    const tail = chunks.pop();
    chunks[chunks.length - 1] = `${chunks[chunks.length - 1]} ${tail}`.slice(
      0,
      SYNTHESIS_CHUNK_MAX_CHARS + 400,
    );
  }

  return chunks.filter((c) => c && c.length >= 8).slice(0, SYNTHESIS_MAX_CHUNKS);
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
 * Embed a single query/text string into a 1536-dim vector. Returns the float
 * array on success, or `null` if embeddings are unavailable (no API key,
 * empty/too-short input, or a transient OpenAI failure). Callers MUST treat
 * `null` as "semantic search unavailable" and fall back gracefully — never
 * throw. Used by the agent-facing vault search to embed the user's query
 * before hitting the admin match RPC.
 *
 * @param {string} text
 * @returns {Promise<number[]|null>}
 */
export async function embedSingleText(text) {
  const input = String(text || '').trim().slice(0, 8000);
  if (input.length < 4) return null;
  const out = await openAiEmbedMany([input]);
  return out && out[0] ? out[0] : null;
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

  const baseChunks = chunkTextForSynthesis(text);

  // Empty content → drop any existing chunks (cleared note edge case).
  if (baseChunks.length === 0) {
    await supabaseAdmin
      .from('lykn_synthesis_chunks')
      .delete()
      .eq('user_id', userId)
      .eq('source_type', sourceType)
      .eq('source_id', String(sourceId));
    return { ok: true, chunks: 0, skipped: true, reason: 'no_content' };
  }

  // Contextual Retrieval (Level 4): prepend a situating line to each chunk
  // before embedding. No-op unless RAG_CONTEXTUAL_RETRIEVAL=1. We store the
  // contextualized text so snippets and the hash-skip stay consistent with
  // what was embedded.
  const chunks = await contextualizeChunks(text, baseChunks, {
    title: String(metadata?.title || ''),
  });

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
    // `total_chunks` lets retrieval do parent/sentence-window expansion (pull
    // neighbouring chunk_index rows) without an extra count query.
    metadata: { ...metadata, chunk_index, total_chunks: chunks.length },
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
