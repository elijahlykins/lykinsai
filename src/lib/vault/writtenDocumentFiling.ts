/**
 * How a written HTML document is filed in AI Drive / Docs.
 *
 * The drive folder is derived from these tags (`isWrittenDocument` → "docs").
 * Keep this the single place that names them so chat persist, bot IPC save,
 * and the writer broadcast stay aligned.
 */

export const WRITTEN_DOCUMENT_FOLDER = "Generated";
export const WRITTEN_DOCUMENT_SOURCE = "ai_artifact";
export const WRITTEN_DOCUMENT_TAGS = ["html", "generated", "document"] as const;

const FILENAME_MAX = 80;

export function writtenDocumentFilename(
  title?: string,
  filename?: string,
): string {
  const given = String(filename || "").trim();
  if (given) {
    return /\.html?$/i.test(given) ? given : `${given}.html`;
  }
  const stem =
    String(title || "Document")
      .replace(/[\\/:*?"<>|]+/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[^\w\- ]+/g, "")
      .replace(/\s+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, FILENAME_MAX) || "Document";
  return `${stem}.html`;
}

/** Shared across Electron windows so overlay + Studio don't insert twice. */
export function writtenDocumentLockKey(filename: string, html: string): string {
  const body = String(html || "");
  return `lykn:written-doc:${filename}:${body.length}:${body.slice(0, 48)}:${body.slice(-48)}`;
}
