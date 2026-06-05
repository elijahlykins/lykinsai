/** ~1000 words per chunk (spec default for document prompts). */
export const DEFAULT_WORDS_PER_CHUNK = 1000;

const DEFAULT_MIN_CHUNK_CHARS = 200;

/**
 * Split prose into fixed-size word windows for document training prompts.
 */
export function chunkTextByWords(text, wordsPerChunk = DEFAULT_WORDS_PER_CHUNK) {
  const words = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  if (!words.length) return [];

  const chunks = [];
  for (let i = 0; i < words.length; i += wordsPerChunk) {
    const slice = words.slice(i, i + wordsPerChunk).join(' ');
    if (slice.length >= DEFAULT_MIN_CHUNK_CHARS) chunks.push(slice);
  }
  return chunks;
}

/**
 * Turn vault note records into bounded document chunks for Claude.
 */
export function expandNotesToDocumentChunks(notes, opts = {}) {
  const wordsPerChunk = opts.wordsPerChunk || DEFAULT_WORDS_PER_CHUNK;
  const maxChunks = Math.min(Math.max(Number(opts.maxChunks) || 12, 1), 30);
  const out = [];

  for (const note of notes || []) {
    const parts = chunkTextByWords(note.text, wordsPerChunk);
    for (let i = 0; i < parts.length; i += 1) {
      out.push({
        note_id: note.id,
        title: note.title,
        source: note.source,
        chunk_index: i,
        chunk_count: parts.length,
        text: `Title: ${note.title}\n\n${parts[i]}`,
      });
      if (out.length >= maxChunks) return out;
    }
  }
  return out;
}
