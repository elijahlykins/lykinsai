// ============================================================================
// lib/rag/contextualize.js — Contextual Retrieval (Anthropic-style)
// ============================================================================
// A chunk ripped out of a long document loses its context: "it raised prices
// 12%" is unsearchable if the chunk never says WHO or WHAT. Contextual
// Retrieval fixes this by prepending a short, model-written sentence that
// situates each chunk inside its parent document BEFORE embedding it. Anthropic
// reported large drops in retrieval failure from exactly this step.
//
// We do it in ONE batched LLM call per document (doc + numbered chunks → a
// context line per chunk) instead of Anthropic's per-chunk+prompt-cache
// approach, which keeps cost/latency bounded without prompt caching.
//
// FULLY OPT-IN + DEGRADE-SAFE: returns the chunks UNCHANGED unless
// RAG_CONTEXTUAL_RETRIEVAL=1 and an OpenAI key is present. Any failure returns
// the originals, so ingest never breaks. Enabling it only affects newly
// (re)embedded sources — existing chunks keep working until reindexed.

const CONTEXTUALIZE_MODEL = process.env.RAG_CONTEXTUAL_MODEL || 'gpt-4o-mini';
const MAX_CHUNKS_PER_CALL = 24;
const DOC_CHARS_FOR_CONTEXT = 8000;

export function contextualRetrievalEnabled() {
  return process.env.RAG_CONTEXTUAL_RETRIEVAL === '1' && !!process.env.OPENAI_API_KEY;
}

/**
 * Prepend a one-line situating context to each chunk. Returns a string[] the
 * same length and order as `chunks`. On disable/failure returns `chunks` as-is.
 *
 * @param {string} fullText           The parent document text.
 * @param {string[]} chunks           Chunk bodies (from chunkTextForSynthesis).
 * @param {Object} [opts]
 * @param {string} [opts.title]
 * @param {number} [opts.timeoutMs=15000]
 * @returns {Promise<string[]>}
 */
export async function contextualizeChunks(fullText, chunks, { title = '', timeoutMs = 15000 } = {}) {
  const list = Array.isArray(chunks) ? chunks : [];
  if (!contextualRetrievalEnabled() || list.length === 0) return list;
  // Not worth a model call for a single small chunk — it already is the doc.
  if (list.length === 1) return list;

  const doc = String(fullText || '').replace(/\s+/g, ' ').trim().slice(0, DOC_CHARS_FOR_CONTEXT);
  if (!doc) return list;

  const out = [...list];
  try {
    for (let start = 0; start < list.length; start += MAX_CHUNKS_PER_CALL) {
      const batch = list.slice(start, start + MAX_CHUNKS_PER_CALL);
      const numbered = batch
        .map((c, i) => `[${i}] ${String(c).replace(/\s+/g, ' ').slice(0, 500)}`)
        .join('\n');
      const res = await Promise.race([
        fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: CONTEXTUALIZE_MODEL,
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
              {
                role: 'system',
                content:
                  'For each numbered chunk, write a SHORT (max 20 words) context sentence that situates it within the document so it is self-contained for search. Mention the document subject and what the chunk is about. Respond ONLY as JSON: {"contexts":{"0":"...","1":"..."}} keyed by chunk index.',
              },
              {
                role: 'user',
                content: `Document${title ? ` titled "${title}"` : ''}:\n${doc}\n\nChunks:\n${numbered}`,
              },
            ],
          }),
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('contextualize_timeout')), timeoutMs)),
      ]);
      if (!res.ok) throw new Error(`openai_http_${res.status}`);
      const data = await res.json();
      let contexts = {};
      try {
        const parsed = JSON.parse(data?.choices?.[0]?.message?.content || '{}');
        contexts = parsed?.contexts && typeof parsed.contexts === 'object' ? parsed.contexts : {};
      } catch {
        continue; // leave this batch unprefixed
      }
      for (let i = 0; i < batch.length; i++) {
        const ctx = String(contexts[i] ?? contexts[String(i)] ?? '').trim();
        if (ctx) out[start + i] = `${ctx}\n\n${batch[i]}`;
      }
    }
    return out;
  } catch (e) {
    console.warn('[rag:contextualize] failed, embedding raw chunks:', e?.message || e);
    return list;
  }
}
