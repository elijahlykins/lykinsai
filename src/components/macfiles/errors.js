/**
 * Plain-English wording for what the filesystem layer can refuse.
 *
 * Shared because the same failures surface in two places: inside the Vault's
 * file browser, and on the Studio desktop when something is dropped there.
 * They should read the same either way.
 */

const TEXT = {
  local_mode_off: "Local Mode is off.",
  not_synced: "Sync is off for that folder.",
  permission_denied: "macOS won't let LYKN read that folder.",
  name_taken: "Something with that name is already here.",
  empty_name: "A name is required.",
  reserved_name: "That name is reserved.",
  illegal_name: "Names can't contain a slash.",
  name_too_long: "That name is too long.",
  into_itself: "A folder can't be moved into itself.",
  no_sources: "Nothing to move.",
};

export const LOCAL_MODE_OFF = TEXT.local_mode_off;
export const NOT_SYNCED = TEXT.not_synced;

/**
 * A batch operation reports per-item failures, so prefer the specific reason
 * the first item gave over the generic one for the batch.
 */
export function describeFilesError(result) {
  const code = typeof result === "string" ? result : result?.failed?.[0]?.error || result?.error;
  return TEXT[code] || code || "Something went wrong.";
}
