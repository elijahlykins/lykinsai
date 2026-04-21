// Shared detector + event bus for the server-side vault-cap trigger defined
// in `supabase-migrations/029_vault_cap_trigger.sql`.
//
// The client already refuses to save past the cap (`checkVaultLimit` in
// useUsageGate.js), so this fires only in edge cases: stale plan data, a race
// between two tabs, or a tampered client. When the DB trigger raises
// `vault_cap_reached: ...` we surface the existing upgrade modal instead of
// failing silently.

export const VAULT_CAP_EVENT = "lykn:vault-cap-reached";

type MaybeError = unknown;

function toRecord(err: MaybeError): Record<string, unknown> | null {
  if (!err || typeof err !== "object") return null;
  return err as Record<string, unknown>;
}

/** True if the given Supabase/PG error came from the vault-cap trigger. */
export function isVaultCapError(err: MaybeError): boolean {
  const r = toRecord(err);
  if (!r) return false;
  const haystacks = [r.message, r.details, r.hint]
    .filter((v): v is string => typeof v === "string");
  return haystacks.some((s) => s.includes("vault_cap_reached"));
}

/**
 * Dispatches the vault-cap event so `useUsageGate` can pop its upgrade modal.
 * Returns true when the error was recognised and handled (caller should treat
 * it as a "soft" failure and stop propagating).
 */
export function notifyVaultCapIfApplicable(err: MaybeError): boolean {
  if (!isVaultCapError(err)) return false;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(VAULT_CAP_EVENT));
  }
  return true;
}
