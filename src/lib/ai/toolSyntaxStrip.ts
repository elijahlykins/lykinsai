/**
 * Strip model-emitted tool-call syntax from chat text.
 *
 * Mirrors the server-side stripper in chat-agent-loop.js. Some models echo
 * literal invocations (especially during project-write turns) instead of
 * using the native tool channel — e.g.:
 *   <tool_use name="lykn_pushProjectState" arguments="..." />
 *   [lykn_updateProject({ "project_id": "..." })]
 *
 * The stream variant holds partial openers back; the final variant removes
 * complete patterns from the finished reply.
 */

const STRIP_PATTERNS: RegExp[] = [
  // Supabase storage URLs must never reach the user — images/files render
  // via artifact cards, so a raw signed URL in the text is always a leak.
  // Remove the markdown image/link wrapper first, then any bare URL.
  /!\[[^\]]*\]\(\s*https?:\/\/[a-z0-9-]+\.supabase\.co\/[^)]*\)/gi,
  /\[[^\]]*\]\(\s*https?:\/\/[a-z0-9-]+\.supabase\.co\/[^)]*\)/gi,
  /<?https?:\/\/[a-z0-9-]+\.supabase\.co\/[^\s)>\]]+>?/gi,
  /\[\s*lykn_\w+\s*\([\s\S]*?\)\s*\]/g,
  /\blykn_\w+\s*\(\s*\{[\s\S]*?\}\s*\)/g,
  /\blykn_\w+\s*\(\s*\)/g,
  /<tool_use\b[^>]*\/>/gi,
  /<tool_use\b[^>]*>[\s\S]*?<\/tool_use>/gi,
  /<\/?tool_use\b[^>]*>/gi,
  /<tool[_a-z]*[^>]*>[\s\S]*?<\/tool[_a-z]*>/gi,
  /<\/?tool[_a-z]*[^>]*>/gi,
  /<function[_a-z]*[^>]*>[\s\S]*?<\/function[_a-z]*>/gi,
  /<\/?function[_a-z]*[^>]*>/gi,
];

const STREAM_OPENERS: RegExp[] = [
  /<tool_use\b/i,
  /<tool[_a-z]*/i,
  /<function[_a-z]*/i,
  /\[\s*lykn_/,
  /\blykn_\w+\s*\(/,
  // Hold the tail once a Supabase URL (or its markdown wrapper) starts so a
  // half-streamed signed URL can't flush before it's complete + stripped.
  /!?\[[^\]]*\]\(\s*https?:\/\/[a-z0-9-]+\.supabase\.co/i,
  /https?:\/\/[a-z0-9-]+\.supabase\.co/i,
];

/** Partial prefix at the tail of a streaming buffer. */
const STREAM_PARTIAL_TAIL =
  /(?:<t(?:o(?:o(?:l(?:_(?:u(?:s(?:e)?)?)?)?)?)?)?|<f(?:u(?:n(?:c(?:t(?:i(?:o(?:n)?)?)?)?)?)?)?|\[(?:\s*lykn_)?|lykn_\w*)$/i;

function applyStripPatterns(text: string): string {
  let out = text;
  for (const re of STRIP_PATTERNS) {
    out = out.replace(re, "");
  }
  return out;
}

function cutAtEarliestOpener(text: string): number {
  let earliest = -1;
  for (const re of STREAM_OPENERS) {
    const m = re.exec(text);
    if (m && (earliest < 0 || m.index < earliest)) earliest = m.index;
  }
  return earliest;
}

/**
 * Streaming-safe: hide complete patterns and cut before any unclosed opener.
 */
export function stripToolSyntaxFromStream(text: string): string {
  let working = applyStripPatterns(text);
  const openerIdx = cutAtEarliestOpener(working);
  if (openerIdx >= 0) {
    working = working.slice(0, openerIdx).trimEnd();
  } else {
    const partial = working.match(STREAM_PARTIAL_TAIL);
    if (partial && partial.index !== undefined) {
      working = working.slice(0, partial.index).trimEnd();
    }
  }
  return working;
}

/** Final pass once the stream is complete. Idempotent. */
export function stripToolSyntaxFromFinal(text: string): string {
  return applyStripPatterns(text)
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}
