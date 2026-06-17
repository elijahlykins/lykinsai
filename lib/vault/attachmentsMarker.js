/**
 * Backend (Node/ESM) port of src/lib/vault/attachmentsMarker.ts.
 *
 * The frontend module is TypeScript and resolved via the Vite `@/` alias,
 * which backend `.js` files cannot import. This file mirrors that canonical
 * JSON-string-aware scanner so server-side strippers/parsers agree with the
 * client instead of using the old naive `\[ATTACHMENTS_JSON:[\s\S]*$` regex
 * (which deleted everything after the marker — silently dropping the
 * flattened body that connector-synced notes append below the marker).
 *
 * Keep this in sync with src/lib/vault/attachmentsMarker.ts.
 */

import { primaryAttachmentFromColumns } from "./attachmentType.js";

const MARKER = "[ATTACHMENTS_JSON:";

/**
 * Locates the `[ATTACHMENTS_JSON:...]` marker in `content` and returns the
 * span plus parsed attachments. Returns `null` when the marker is absent or
 * the JSON cannot be parsed.
 */
export function findAttachmentsMarker(content) {
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

  let attachments;
  try {
    const parsed = JSON.parse(content.slice(jsonStart, jsonEnd));
    if (!Array.isArray(parsed)) return null;
    attachments = parsed;
  } catch {
    return null;
  }

  let markerEnd = jsonEnd;
  if (content[markerEnd] === "]") markerEnd += 1;

  return { start, jsonStart, jsonEnd, markerEnd, attachments };
}

/** Returns the parsed attachments from the marker (or an empty array). */
export function parseAttachmentsFromContent(content) {
  const span = findAttachmentsMarker(content);
  return span ? span.attachments : [];
}

/** Removes the marker from `content`, collapsing extra blank lines. */
export function stripAttachmentsMarker(content) {
  if (!content) return "";
  const span = findAttachmentsMarker(content);
  if (!span) return String(content);
  return `${content.slice(0, span.start)}${content.slice(span.markerEnd)}`
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Serializes attachments into the canonical marker string. */
export function buildAttachmentsMarker(attachments) {
  return `${MARKER}${JSON.stringify(attachments)}]`;
}

/**
 * Returns `content` with the marker replaced (or appended) with the given
 * attachments. Trims trailing whitespace and collapses 3+ blank lines.
 */
export function withAttachmentsMarker(content, attachments) {
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
 * Consults the dedicated `attachments` column first (if present) and falls
 * back to the marker inside `content`.
 */
export function parseAttachmentsFromNote(note) {
  if (!note) return [];
  const out = [];

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

  // Marker fallback: reconstruct the primary attachment from the normalized
  // columns (migration 104) for marker-less rows.
  if (out.length === 0) {
    const fromCols = primaryAttachmentFromColumns(note);
    if (fromCols) out.push(fromCols);
  }

  return out.filter(Boolean);
}
