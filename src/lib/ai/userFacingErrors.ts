/**
 * Single source of truth for user-visible copy when something fails on the
 * wire (API, SSE, Supabase, OAuth, MCP). Never surface stable error codes,
 * HTTP status strings, or Postgres messages in the product UI.
 */

/** Canonical message for any connectivity / server / provider failure. */
export const CONNECTION_TROUBLE_TEXT =
  "Sorry, we're having trouble connecting right now.";

/**
 * Map any caught error (Error, string, API `{ error }` slug, HTTP text) to
 * safe copy. Intentionally ignores the raw value — logs belong in the console.
 */
export function toUserFacingError(_raw?: unknown): string {
  return CONNECTION_TROUBLE_TEXT;
}

/**
 * Assistant bubble when chat returns no usable text after fallbacks + retry.
 */
export const AI_TEMPORARY_FAILURE_TEXT = CONNECTION_TROUBLE_TEXT;

/** Compressed status line under the chat input. */
export const AI_TEMPORARY_FAILURE_STATUS = CONNECTION_TROUBLE_TEXT;

/** Guest / landing preview chat failures. */
export const AI_GUEST_TEMPORARY_FAILURE_TEXT = CONNECTION_TROUBLE_TEXT;
