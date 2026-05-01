/**
 * Robust parser/serializer for the `[ATTACHMENTS_JSON:...]` marker we embed
 * inside vault note `content`.
 *
 * Earlier versions counted square brackets to find the end of the marker.
 * That works for typical payloads but breaks the moment a JSON string value
 * contains `[` or `]` — e.g. a filename like `report[2025].pdf` — because
 * the literal brackets desynchronise the counter and the slice ends in the
 * wrong place. Symptoms range from `JSON.parse` throwing to corrupted
 * updates that lose attachment data.
 *
 * The scanner here keeps track of JSON string state (quotes, escape
 * sequences) so brackets inside strings are ignored, then validates with
 * `JSON.parse` before claiming a span. If parsing fails we return `null`
 * and callers fall back to the dedicated `attachments` column.
 *
 * The on-disk format is unchanged (`[ATTACHMENTS_JSON:[{...},{...}]]`), so
 * this fix needs no migration.
 */

const MARKER = "[ATTACHMENTS_JSON:";

export interface AttachmentsMarkerSpan {
  /** Index of the opening `[` of `[ATTACHMENTS_JSON:` in the source content. */
  start: number;
  /** Index of the JSON array's opening `[`. */
  jsonStart: number;
  /** Index immediately after the JSON array's closing `]`. */
  jsonEnd: number;
  /** Index immediately after the marker's outer `]`, suitable for `slice()`. */
  markerEnd: number;
  /** The successfully parsed attachments array. */
  attachments: unknown[];
}

/**
 * Locates the `[ATTACHMENTS_JSON:...]` marker in `content` and returns the
 * span plus parsed attachments. Returns `null` when the marker is absent or
 * the JSON cannot be parsed (caller should treat that as "no marker").
 */
export function findAttachmentsMarker(content: string): AttachmentsMarkerSpan | null {
  if (!content) return null;
  const start = content.indexOf(MARKER);
  if (start === -1) return null;

  const jsonStart = start + MARKER.length;
  if (content[jsonStart] !== "[") return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  let jsonEnd = -1;

  for (let i = jsonStart; i < content.length; i += 1) {
    const ch = content[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        jsonEnd = i + 1;
        break;
      }
    }
  }

  if (jsonEnd === -1) return null;

  let attachments: unknown[];
  try {
    const parsed = JSON.parse(content.slice(jsonStart, jsonEnd));
    if (!Array.isArray(parsed)) return null;
    attachments = parsed;
  } catch {
    return null;
  }

  // Marker's outer `]` sits right after the JSON array's closing `]`.
  let markerEnd = jsonEnd;
  if (content[markerEnd] === "]") markerEnd += 1;

  return { start, jsonStart, jsonEnd, markerEnd, attachments };
}

/** Returns the parsed attachments from the marker (or an empty array). */
export function parseAttachmentsFromContent(content: string): unknown[] {
  const span = findAttachmentsMarker(content);
  return span ? span.attachments : [];
}

/** Removes the marker from `content`, collapsing extra blank lines. */
export function stripAttachmentsMarker(content: string): string {
  if (!content) return "";
  const span = findAttachmentsMarker(content);
  if (!span) return String(content);
  return `${content.slice(0, span.start)}${content.slice(span.markerEnd)}`
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Serializes attachments into the canonical marker string. */
export function buildAttachmentsMarker(attachments: unknown[]): string {
  return `${MARKER}${JSON.stringify(attachments)}]`;
}

/**
 * Returns `content` with the marker replaced (or appended) with the given
 * attachments. Trims trailing whitespace and collapses 3+ blank lines.
 */
export function withAttachmentsMarker(
  content: string,
  attachments: unknown[],
): string {
  const raw = String(content || "");
  const payload = buildAttachmentsMarker(attachments);
  const span = findAttachmentsMarker(raw);
  if (!span) {
    return `${raw.trim()}\n\n${payload}`.trim();
  }
  return `${raw.slice(0, span.start)}${payload}${raw.slice(span.markerEnd)}`
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Convenience reader that consults the dedicated `attachments` column first
 * (if present) and falls back to the marker inside `content`. Mirrors the
 * fallback chain previously duplicated across the codebase.
 */
export function parseAttachmentsFromNote(
  note: { attachments?: unknown; content?: unknown } | null | undefined,
): unknown[] {
  if (!note) return [];
  const out: unknown[] = [];

  const attCol = note.attachments;
  if (Array.isArray(attCol)) {
    out.push(...attCol);
  } else if (typeof attCol === "string" && attCol.trim()) {
    try {
      const parsed = JSON.parse(attCol);
      if (Array.isArray(parsed)) out.push(...parsed);
    } catch {
      /* fall through to marker */
    }
  }

  if (out.length === 0) {
    const content = typeof note.content === "string" ? note.content : "";
    out.push(...parseAttachmentsFromContent(content));
  }

  return out.filter(Boolean);
}

/**
 * Patches a single attachment inside the marker by index. Returns the new
 * content string, or `null` when the marker / index is missing. Use this
 * instead of hand-rolling JSON splicing in callers.
 */
export function patchAttachmentInContent(
  content: string,
  index: number,
  patch: Record<string, unknown>,
): string | null {
  const span = findAttachmentsMarker(content);
  if (!span) return null;
  if (!Number.isInteger(index) || index < 0 || index >= span.attachments.length) {
    return null;
  }
  const next = span.attachments.slice();
  const target = (next[index] && typeof next[index] === "object") ? next[index] : {};
  next[index] = { ...(target as Record<string, unknown>), ...patch };
  return withAttachmentsMarker(content, next);
}
