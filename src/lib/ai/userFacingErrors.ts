/**
 * Single source of truth for user-visible copy when something fails on the
 * wire (API, SSE, Supabase, OAuth, MCP). Never surface stable error codes,
 * HTTP status strings, or Postgres messages in the product UI.
 *
 * Avoid "trouble connecting" — it fires on stalls/timeouts (image gen,
 * long builds) that are not real connection failures and reads as broken.
 */

/** Soft generic fallback when we have no better context-specific copy. */
export const CONNECTION_TROUBLE_TEXT = "That didn't work. Try again in a moment.";

/** Image generation / image-mode failures (stall, provider, quota). */
export const IMAGE_GEN_FAILURE_TEXT =
  "Couldn't create that image. Try again in a moment.";

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
