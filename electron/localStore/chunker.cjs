/**
 * Structure- and sentence-aware chunker for the local retrieval index.
 *
 * This is a CommonJS port of `chunkTextForSynthesis` in synthesis-service.js.
 * The behaviour is deliberately identical: chunks produced on-device should be
 * interchangeable with the ones the server produced, so a vault imported from
 * Supabase retrieves the same way it did before the move.
 *
 * The rules, unchanged from the server copy:
 *   - short documents stay whole, so a one-line note is never fragmented;
 *   - long documents split on paragraph then sentence boundaries, never
 *     mid-sentence unless a single sentence exceeds the hard ceiling;
 *   - consecutive chunks share a one-sentence overlap, so a fact spanning a
 *     boundary is recoverable from either side;
 *   - a runt tail chunk is merged back into its predecessor.
 *
 * Sizing is unchanged too (~275 tokens target, ~400 ceiling at 4 chars/token).
 * That budget was picked for OpenAI's 8k-token embedder but it suits the local
 * model better than the server's did: bge-small truncates at 512 tokens, and a
 * 1600-character ceiling is ~400 tokens, comfortably inside the window. Raising
 * these numbers would silently start dropping the tail of every large chunk.
 */

const CHUNK_CHARS = 1100; // ~275 tokens target
const CHUNK_MAX_CHARS = 1600; // ~400 tokens ceiling / keep-whole threshold
const CHUNK_MIN_CHARS = 250; // merge a tail smaller than this
const MAX_CHUNKS = 64;
const INPUT_CAP = 200_000;

/** Rough token estimate (~4 chars/token for English). */
function estimateTokens(text) {
  return Math.ceil(String(text || "").length / 4);
}

/** Split a paragraph into sentence-ish units without mangling decimals/abbrevs. */
function splitSentences(paragraph) {
  const p = String(paragraph || "").trim();
  if (!p) return [];
  // Break after . ! ? (and any closing quote/paren) when followed by whitespace
  // and a capital, quote, or digit — keeps "3.5" and "e.g." mostly intact.
  return p
    .split(/(?<=[.!?]["')\]]?)\s+(?=[A-Z0-9"'(\[])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Break text into ordered "units" — headings, list items, sentences — the
 * atoms the packer assembles into chunks and never splits across.
 */
function textToUnits(text) {
  const units = [];
  for (const block of text.split(/\n{2,}/)) {
    const b = block.trim();
    if (!b) continue;
    const isListOrHeading = /^#{1,6}\s/.test(b) || /^([-*+]|\d+[.)])\s/.test(b);
    if (isListOrHeading || b.length <= CHUNK_CHARS) {
      units.push(b);
      continue;
    }
    for (const s of splitSentences(b)) units.push(s);
  }
  return units;
}

/** Last resort: split a single oversized unit on character boundaries. */
function hardSplit(unit) {
  const out = [];
  for (let i = 0; i < unit.length; i += CHUNK_MAX_CHARS) {
    out.push(unit.slice(i, i + CHUNK_MAX_CHARS));
  }
  return out;
}

/**
 * Split text into chunk strings ready to embed.
 * @param {string} raw
 * @returns {string[]}
 */
function chunkText(raw) {
  const t = String(raw || "").trim().slice(0, INPUT_CAP);
  if (t.length < 8) return [];
  if (t.length <= CHUNK_MAX_CHARS) return [t];

  const units = textToUnits(t);
  if (units.length === 0) return [t.slice(0, CHUNK_MAX_CHARS)];

  const chunks = [];
  let current = [];
  let currentLen = 0;

  const flush = () => {
    if (!current.length) return;
    chunks.push(current.join(" ").trim());
    // One-unit overlap: carry the last sentence forward, but only when it is
    // small enough to be a cheap bridge rather than a whole oversized block.
    const last = current[current.length - 1];
    current = last && last.length <= 300 ? [last] : [];
    currentLen = current.reduce((a, u) => a + u.length + 1, 0);
  };

  for (const rawUnit of units) {
    if (chunks.length >= MAX_CHUNKS) break;
    const pieces = rawUnit.length > CHUNK_MAX_CHARS ? hardSplit(rawUnit) : [rawUnit];
    for (const unit of pieces) {
      const addLen = unit.length + 1;
      // Overflow: flush first so the break lands on the boundary between units
      // rather than inside one.
      if (currentLen > 0 && currentLen + addLen > CHUNK_CHARS) {
        flush();
        if (chunks.length >= MAX_CHUNKS) break;
      }
      current.push(unit);
      currentLen += addLen;
    }
  }
  if (current.length && chunks.length < MAX_CHUNKS) {
    chunks.push(current.join(" ").trim());
  }

  // The overlap carry can leave a tiny tail; fold it back in.
  if (chunks.length >= 2 && chunks[chunks.length - 1].length < CHUNK_MIN_CHARS) {
    const tail = chunks.pop();
    chunks[chunks.length - 1] = `${chunks[chunks.length - 1]} ${tail}`.slice(
      0,
      CHUNK_MAX_CHARS + 400,
    );
  }

  return chunks.filter((c) => c && c.length >= 8).slice(0, MAX_CHUNKS);
}

module.exports = {
  chunkText,
  estimateTokens,
  splitSentences,
  textToUnits,
  CHUNK_CHARS,
  CHUNK_MAX_CHARS,
  CHUNK_MIN_CHARS,
  MAX_CHUNKS,
  INPUT_CAP,
};
