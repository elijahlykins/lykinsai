// Vault content parsing helpers.
//
// Vault notes are stored in the `notes` table with their plaintext body
// in `notes.content`. When a note has attachments (images, videos, YouTube
// embeds, bookmarks, spreadsheets, generic links) we suffix the body
// with an `[ATTACHMENTS_JSON:[…]]` marker holding a JSON array. This
// keeps the schema flat (no second table, no jsonb column) while still
// letting the renderer reconstruct rich attachments at read time.
//
// Both the synthesis-layer DetailPanel / NeuronPanel and the Vault page
// itself rely on this parser, so it lives next to the storage helpers
// rather than inside any single page module — that would force a
// circular import when NeuronPanel pulls it in (SynthesisLayer
// → NeuronPanel → SynthesisLayer).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type VaultAttachment = any;

export interface ParsedVaultContent {
  body: string;
  attachments: VaultAttachment[];
}

export function parseVaultContent(raw: string): ParsedVaultContent {
  const marker = "[ATTACHMENTS_JSON:";
  const start = raw.indexOf(marker);
  if (start === -1) return { body: raw.trim(), attachments: [] };
  const body = raw.slice(0, start).trim();
  try {
    const jsonStart = start + marker.length;
    let depth = 0;
    let jsonEnd = jsonStart;
    for (let i = jsonStart; i < raw.length; i++) {
      if (raw[i] === "[") depth++;
      else if (raw[i] === "]") {
        depth--;
        if (depth === 0) {
          jsonEnd = i;
          break;
        }
      }
    }
    const json = raw.slice(jsonStart, jsonEnd + 1);
    return { body, attachments: JSON.parse(json) };
  } catch {
    return { body, attachments: [] };
  }
}

// Best-effort resolution of an attachment's underlying Supabase Storage
// (bucket, path) tuple. Used by the renderer to refresh expired signed
// URLs. Three shapes are recognised:
//
//   1. Explicit `storagePath` (+ optional `storageBucket`) — written by
//      the modern upload flow which knows the bucket up front.
//   2. Public storage URL — `/storage/v1/object/public/<bucket>/<path>`.
//      Older attachments persisted the public link directly.
//   3. Signed storage URL — `/storage/v1/object/sign/<bucket>/<path>?…`.
//      Used to be returned by the legacy share flow; we strip the query
//      string and treat the path as the source of truth.
//
// Returns `null` for `data:` URLs (inline base64), external HTTPs links
// (YouTube, articles, etc.), or anything we can't parse into a bucket/
// path pair — the renderer falls back to the raw `url` in that case.
export function resolveStorageTarget(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  att: any,
): { bucket: string; path: string } | null {
  const explicitPath = String(att?.storagePath || "").trim();
  if (explicitPath) {
    return {
      bucket: String(att.storageBucket || "user-files").trim() || "user-files",
      path: explicitPath,
    };
  }
  const url = String(att?.url || "").trim();
  if (!url || url.startsWith("data:")) return null;
  try {
    const parsed = new URL(url);
    const p = parsed.pathname || "";
    const pubMatch = p.match(/\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/);
    if (pubMatch) {
      return {
        bucket: decodeURIComponent(pubMatch[1]),
        path: decodeURIComponent(pubMatch[2]),
      };
    }
    const sigMatch = p.match(/\/storage\/v1\/object\/sign\/([^/]+)\/(.+)$/);
    if (sigMatch) {
      return {
        bucket: decodeURIComponent(sigMatch[1]),
        path: decodeURIComponent(sigMatch[2].split("?")[0]),
      };
    }
  } catch {
    /* not a URL — fall through to null */
  }
  return null;
}
