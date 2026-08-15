/**
 * Attachment handoff for the home-desktop chat bar.
 *
 * The bar hands prompts to the real chat surface through sessionStorage (cold
 * surface) plus a DOM event (warm one), but File objects can't be serialized.
 * They park here instead: the Studio swaps tabs rather than reloading, so both
 * sides share one JS context and the surface can claim the files when it
 * consumes the pending send.
 */

/** @type {File[]} */
let pendingFiles = [];

export function setPendingHomeChatFiles(files) {
  pendingFiles = Array.from(files || []);
}

/** Claim the parked files — one consumer only, so a later send starts clean. */
export function takePendingHomeChatFiles() {
  const claimed = pendingFiles;
  pendingFiles = [];
  return claimed;
}
