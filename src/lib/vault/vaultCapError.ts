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
  // PG can surface the trigger error via several fields depending on the
  // wire format. Be robust: check message/details/hint substrings,
  // structured error codes (some triggers RAISE with custom SQLSTATE
  // 'P0001' + a message body that contains 'vault_cap_reached'), and any
  // structured detail object the server may have attached.
  const haystacks: string[] = [];
  if (typeof r.message === "string") haystacks.push(r.message);
  if (typeof r.details === "string") haystacks.push(r.details);
  if (typeof r.hint === "string") haystacks.push(r.hint);
  if (typeof r.code === "string") haystacks.push(r.code);
  if (r.cause && typeof r.cause === "object") {
    const c = r.cause as Record<string, unknown>;
    for (const k of ["message", "details", "hint", "code"]) {
      const v = c[k];
      if (typeof v === "string") haystacks.push(v);
    }
  }
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
