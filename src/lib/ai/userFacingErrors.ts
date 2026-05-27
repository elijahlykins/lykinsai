/**
 * Single source of truth for the copy users see when an AI request fails
 * AFTER our automatic recovery has been exhausted (server-side cross-
 * provider fallback chain, client-side silent retry).
 *
 * Why this lives in its own module:
 *   • Every chat surface (OmniaFocusedChat / OmniaSideRail via
 *     chatSendOrchestrator, useChatEngine, VaultNew) used to inline the
 *     same blame-the-model string. Drifting
 *     copy meant some surfaces said "this model isn't working — try
 *     another model" while others said "something went wrong" — neither
 *     of which is honest about WHO failed (the network / provider, not
 *     the user's chosen model) and the "try another model" instruction
 *     puts recovery work back on the user even though our server-side
 *     chain ALREADY tried every available model on their behalf.
 *   • Centralising it here means there's exactly one place to tune the
 *     message, and lint can flag any future inline copy that drifts.
 *
 * Voice rules for any copy in this module:
 *   1. Never blame the model the user picked. The fallback chain has
 *      already swapped it under the hood; the user's selection isn't
 *      the proximate cause of what they see.
 *   2. Never tell the user to switch models manually. If switching would
 *      help, the server already tried.
 *   3. Frame as transient ("just now", "in a moment") — because with the
 *      cross-provider chain in place, anything that reaches this copy
 *      is by definition a momentary outage, not a steady-state failure.
 */

/**
 * Default copy for the assistant bubble when the request comes back without
 * usable text after every server-side fallback AND the client-side silent
 * retry. Kept short so it doesn't dominate the chat thread; the chat surface
 * is responsible for showing a "Try again" affordance next to the message.
 */
export const AI_TEMPORARY_FAILURE_TEXT =
  "Hit a snag reaching the AI just now \u2014 give it another try in a moment.";

/**
 * Variant used for the chat status line (the small label under the input).
 * Same intent as the bubble text but compressed for a single-line readout.
 */
export const AI_TEMPORARY_FAILURE_STATUS =
  "Connection hiccup \u2014 tap send again to retry.";

/**
 * Variant used for the guest / preview chat surface (no logged-in user).
 * Slightly different framing because guests don't have the same
 * cross-provider fallback chain on the server (guest endpoint runs on a
 * stricter, cheaper model list) so a transient miss is more likely.
 */
export const AI_GUEST_TEMPORARY_FAILURE_TEXT =
  "The preview is having a quick hiccup \u2014 please try that again.";
