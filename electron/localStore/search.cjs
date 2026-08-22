/**
 * Retrieval for the local store: FTS5 lexical ranking, brute-force vector
 * similarity, and rank fusion over the two.
 *
 * This is the on-device replacement for `lib/rag/vaultHybrid.js`, which fused
 * the `search_notes_bm25()` RPC with a pgvector match. The shape is the same;
 * only the two retrievers changed.
 *
 * No vector index. Embeddings are L2-normalized on write, so similarity is a
 * dot product over a contiguous Float32Array. Measured in this runtime: 4.4 ms
 * at 5k chunks, 68 ms at 100k, both at 384 dimensions. An ANN index would add a
 * native dependency to solve a problem that does not exist at these sizes.
 */

const db = require("./db.cjs");

// Mirrors RRF_DEFAULT_K in lib/rag/rrf.js. That module is ESM and this runs in
// the CommonJS main process, so the constant and the fusion loop are restated
// here rather than imported. The server copy goes away when the cloud vault
// does; consolidate then.
const RRF_K = 60;

const DEFAULT_LIMIT = 20;

// ---------------------------------------------------------------------------
// Lexical (FTS5 + bm25)
// ---------------------------------------------------------------------------

/**
 * Turn free text into a valid FTS5 MATCH expression.
 *
 * Raw user input cannot go straight into MATCH — characters like `"`, `*`, `:`
 * and `-` are operators and throw a syntax error. Tokenizing to word
 * characters and quoting each term sidesteps the grammar entirely.
 */
function toMatchQuery(text, { operator = "AND" } = {}) {
  const tokens = String(text || "")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu);
  if (!tokens || !tokens.length) return "";
  const unique = [...new Set(tokens)].slice(0, 24);
  return unique.map((t) => `"${t}"`).join(` ${operator} `);
}

function runLexical(matchQuery, { kind, limit }) {
  const params = [matchQuery];
  let kindClause = "";
  if (kind) {
    kindClause = "AND i.kind = ?";
    params.push(String(kind));
  }
  // bm25() returns a negative score where more negative is a better match, so
  // ascending order puts the strongest hits first.
  return db
    .get()
    .prepare(
      `SELECT i.id AS id, bm25(items_fts) AS score
         FROM items_fts
         JOIN items i ON i.rowid = items_fts.rowid
        WHERE items_fts MATCH ?
          AND i.deleted_at IS NULL
          ${kindClause}
        ORDER BY score ASC
        LIMIT ?`,
    )
    .all(...params, limit);
}

/**
 * Lexical search over items. Tries an AND query first for precision and falls
 * back to OR when that returns nothing, so a long natural-language question
 * still finds something.
 */
function lexicalSearch(query, { kind, limit = DEFAULT_LIMIT } = {}) {
  const capped = Math.max(1, Math.min(Number(limit) || DEFAULT_LIMIT, 200));

  const strict = toMatchQuery(query, { operator: "AND" });
  if (!strict) return [];

  try {
    const hits = runLexical(strict, { kind, limit: capped });
    if (hits.length) return hits;
    const loose = toMatchQuery(query, { operator: "OR" });
    return loose === strict ? [] : runLexical(loose, { kind, limit: capped });
  } catch (err) {
    // A malformed MATCH should degrade to "no lexical hits", not break search.
    console.error("[LYKN] lexical search failed:", err?.message);
    return [];
  }
}

/** Full-text over chat messages, returning the threads they belong to. */
function searchMessages(query, { limit = DEFAULT_LIMIT } = {}) {
  const match = toMatchQuery(query, { operator: "AND" });
  if (!match) return [];
  const capped = Math.max(1, Math.min(Number(limit) || DEFAULT_LIMIT, 200));
  try {
    return db
      .get()
      .prepare(
        `SELECT m.id AS id, m.thread_id AS thread_id, bm25(messages_fts) AS score
           FROM messages_fts
           JOIN messages m ON m.rowid = messages_fts.rowid
          WHERE messages_fts MATCH ?
          ORDER BY score ASC
          LIMIT ?`,
      )
      .all(match, capped);
  } catch (err) {
    console.error("[LYKN] message search failed:", err?.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Vectors
// ---------------------------------------------------------------------------

function toFloat32(embedding) {
  if (embedding instanceof Float32Array) return embedding;
  if (Array.isArray(embedding)) return Float32Array.from(embedding);
  if (embedding instanceof Uint8Array) {
    return new Float32Array(
      embedding.buffer.slice(embedding.byteOffset, embedding.byteOffset + embedding.byteLength),
    );
  }
  throw new TypeError("embedding must be a Float32Array, number[], or Uint8Array");
}

/** L2-normalize in place so cosine similarity reduces to a dot product. */
function normalize(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i += 1) sum += vec[i] * vec[i];
  const magnitude = Math.sqrt(sum);
  if (magnitude > 0) {
    const inverse = 1 / magnitude;
    for (let i = 0; i < vec.length; i += 1) vec[i] *= inverse;
  }
  return vec;
}

// Deserializing every BLOB on every query is the slow part, not the arithmetic.
// The matrix is held as one contiguous Float32Array and rebuilt only after a
// write, which is what makes the benchmarked numbers achievable in practice.
let cache = null;

function invalidateCache() {
  cache = null;
}

function buildCache() {
  const rows = db
    .get()
    .prepare(
      `SELECT c.id, c.source_kind, c.source_id, c.chunk_index, c.dims, c.embedding
         FROM chunks c
         LEFT JOIN items i ON i.id = c.source_id AND c.source_kind = 'item'
        WHERE c.source_kind <> 'item' OR i.deleted_at IS NULL
        ORDER BY c.id ASC`,
    )
    .all();

  if (!rows.length) {
    cache = { dims: 0, count: 0, matrix: new Float32Array(0), meta: [] };
    return cache;
  }

  const dims = Number(rows[0].dims);
  const usable = rows.filter((r) => Number(r.dims) === dims);
  const matrix = new Float32Array(usable.length * dims);
  const meta = new Array(usable.length);

  usable.forEach((row, index) => {
    const blob = row.embedding;
    const vec = new Float32Array(
      blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength),
    );
    matrix.set(vec.subarray(0, dims), index * dims);
    meta[index] = {
      id: row.id,
      sourceKind: row.source_kind,
      sourceId: row.source_id,
      chunkIndex: row.chunk_index,
    };
  });

  cache = { dims, count: usable.length, matrix, meta };
  return cache;
}

function getCache() {
  return cache || buildCache();
}

/**
 * Replace every chunk for one source in a single transaction.
 *
 * @param {"item"|"thread"} sourceKind
 * @param {string} sourceId
 * @param {{text: string, embedding: Float32Array|number[]}[]} chunks
 * @param {string} model Identifier stored per row, so swapping the embedding
 *   model can invalidate and re-embed only what is stale.
 */
function putChunks(sourceKind, sourceId, chunks, model) {
  const list = Array.isArray(chunks) ? chunks : [];
  const stamp = new Date().toISOString();

  const result = db.transaction((handle) => {
    handle
      .prepare("DELETE FROM chunks WHERE source_kind = ? AND source_id = ?")
      .run(String(sourceKind), String(sourceId));

    const insert = handle.prepare(
      `INSERT INTO chunks (source_kind, source_id, chunk_index, text, embedding, dims, model, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    list.forEach((chunk, index) => {
      const vec = normalize(toFloat32(chunk.embedding));
      insert.run(
        String(sourceKind),
        String(sourceId),
        index,
        String(chunk.text || ""),
        new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength),
        vec.length,
        String(model || "unknown"),
        stamp,
      );
    });

    return { ok: true, count: list.length };
  });

  invalidateCache();
  return result;
}

function deleteChunks(sourceKind, sourceId) {
  db.get()
    .prepare("DELETE FROM chunks WHERE source_kind = ? AND source_id = ?")
    .run(String(sourceKind), String(sourceId));
  invalidateCache();
  return { ok: true };
}

/** Sources whose chunks were embedded with a different model than `model`. */
function staleSources(model) {
  return db
    .get()
    .prepare(
      `SELECT DISTINCT source_kind, source_id FROM chunks WHERE model <> ?`,
    )
    .all(String(model));
}

function chunkStats() {
  const row = db
    .get()
    .prepare("SELECT COUNT(*) AS n, COUNT(DISTINCT source_id) AS sources FROM chunks")
    .get();
  return { chunks: Number(row?.n || 0), sources: Number(row?.sources || 0) };
}

/**
 * Brute-force cosine similarity, best first.
 *
 * @param {Float32Array|number[]} queryEmbedding
 * @param {object} [opts]
 * @param {number} [opts.limit=20]     Chunk hits to return.
 * @param {number} [opts.minScore=0]   Drop weak matches.
 * @param {"item"|"thread"} [opts.sourceKind]
 */
function semanticSearch(queryEmbedding, { limit = DEFAULT_LIMIT, minScore = 0, sourceKind } = {}) {
  const index = getCache();
  if (!index.count) return [];

  const query = normalize(toFloat32(queryEmbedding));
  if (query.length !== index.dims) {
    // A dimension mismatch means the model changed without a re-embed pass.
    // Returning nothing is better than returning noise.
    console.error(
      `[LYKN] embedding dimension mismatch: query ${query.length}, index ${index.dims}`,
    );
    return [];
  }

  const { dims, count, matrix, meta } = index;
  const scores = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    const offset = i * dims;
    let dot = 0;
    for (let j = 0; j < dims; j += 1) dot += matrix[offset + j] * query[j];
    scores[i] = dot;
  }

  const capped = Math.max(1, Math.min(Number(limit) || DEFAULT_LIMIT, 200));
  const candidates = [];
  for (let i = 0; i < count; i += 1) {
    if (scores[i] < minScore) continue;
    if (sourceKind && meta[i].sourceKind !== sourceKind) continue;
    candidates.push(i);
  }
  candidates.sort((a, b) => scores[b] - scores[a]);

  return candidates.slice(0, capped).map((i) => ({
    ...meta[i],
    score: scores[i],
  }));
}

// ---------------------------------------------------------------------------
// Fusion
// ---------------------------------------------------------------------------

/**
 * Reciprocal rank fusion. Position-based, so a bm25 score and a cosine score
 * never have to be put on a common scale.
 *
 * @param {{label: string, weight?: number, ids: string[]}[]} lists
 */
function fuse(lists, { k = RRF_K, limit } = {}) {
  const accumulator = new Map();

  for (const list of Array.isArray(lists) ? lists : []) {
    if (!list || !Array.isArray(list.ids)) continue;
    const weight = Number.isFinite(list.weight) && list.weight > 0 ? list.weight : 1;
    const label = list.label || "list";

    list.ids.forEach((rawId, index) => {
      const id = String(rawId || "");
      if (!id) return;
      const rank = index + 1;
      let entry = accumulator.get(id);
      if (!entry) {
        entry = { id, score: 0, ranks: {}, sources: [] };
        accumulator.set(id, entry);
      }
      entry.score += weight / (k + rank);
      if (entry.ranks[label] == null || rank < entry.ranks[label]) entry.ranks[label] = rank;
      if (!entry.sources.includes(label)) entry.sources.push(label);
    });
  }

  const fused = [...accumulator.values()].sort((a, b) => b.score - a.score);
  return Number.isFinite(limit) && limit > 0 ? fused.slice(0, limit) : fused;
}

/**
 * The whole retrieval path: lexical + semantic, fused, hydrated back to items.
 *
 * `queryEmbedding` is optional — without it this degrades to pure lexical
 * search, which is what happens before the embedding model has finished
 * warming up or while a re-embed pass is running.
 */
function hybridSearch(query, { queryEmbedding, kind, limit = DEFAULT_LIMIT, candidateDepth = 50 } = {}) {
  const depth = Math.max(limit, Math.min(Number(candidateDepth) || 50, 200));

  const lexical = lexicalSearch(query, { kind, limit: depth });
  const lists = [{ label: "lexical", ids: lexical.map((h) => h.id) }];

  if (queryEmbedding) {
    const dense = semanticSearch(queryEmbedding, { limit: depth, sourceKind: "item" });
    // Several chunks can point at one item; keep first (best) occurrence.
    const seen = new Set();
    const ids = [];
    for (const hit of dense) {
      if (seen.has(hit.sourceId)) continue;
      seen.add(hit.sourceId);
      ids.push(hit.sourceId);
    }
    lists.push({ label: "semantic", ids });
  }

  const fused = fuse(lists, { limit });
  if (!fused.length) return [];

  const placeholders = fused.map(() => "?").join(", ");
  const rows = db
    .get()
    .prepare(`SELECT * FROM items WHERE id IN (${placeholders})`)
    .all(...fused.map((f) => f.id));

  const byId = new Map(rows.map((r) => [r.id, r]));
  return fused
    .map((hit) => {
      const row = byId.get(hit.id);
      if (!row) return null;
      return {
        ...row,
        tags: row.tags ? JSON.parse(row.tags) : [],
        _score: hit.score,
        _ranks: hit.ranks,
        _sources: hit.sources,
      };
    })
    .filter(Boolean);
}

module.exports = {
  toMatchQuery,
  lexicalSearch,
  searchMessages,
  putChunks,
  deleteChunks,
  staleSources,
  chunkStats,
  semanticSearch,
  hybridSearch,
  fuse,
  invalidateCache,
  normalize,
  RRF_K,
};
