// Shared detector + event bus for the server-side synthesis-neuron-cap
// trigger defined in
// `supabase-migrations/066_synthesis_neuron_cap_trigger.sql`.
//
// Free users get the synthesis layer up to PLAN_LIMITS.free.synthesisNodes
// explicit neurons (grids + vault notes + ratified beliefs + manual facts
// + perspectives). When they hit it, the DB raises
// `synthesis_neuron_cap_reached` on any new explicit neuron INSERT. The
// client-side SynthesisLayer paywall already gates the page render, but
// callers writing through other code paths (NeuronCreationModal, manual
// belief save, perspective save, MCP tool relays) need to recognise the
// error and surface a friendly upgrade modal rather than the raw PG
// message.
//
// Mirrors the shape of `vaultCapError.ts` deliberately — the upgrade
// modal listening on `useUsageGate` treats both events the same way.

export const SYNTHESIS_CAP_EVENT = "lykn:synthesis-cap-reached";

type MaybeError = unknown;

function toRecord(err: MaybeError): Record<string, unknown> | null {
  if (!err || typeof err !== "object") return null;
  return err as Record<string, unknown>;
}

/** True if the given Supabase/PG error came from the synthesis-cap trigger. */
export function isSynthesisCapError(err: MaybeError): boolean {
  const r = toRecord(err);
  if (!r) return false;
  // PG surfaces the trigger error through several fields depending on the
  // wire format. Be robust: check message / details / hint / code, plus
  // any wrapped `cause` object the server may have attached. The trigger
  // raises with SQLSTATE 'check_violation' (23514) + a message body that
  // starts with the literal token below; structured detail JSON from the
  // server's MCP handlers may also forward `reason` or `error_code`.
  const haystacks: string[] = [];
  for (const k of ["message", "details", "hint", "code", "reason", "error", "error_code"]) {
    const v = r[k];
    if (typeof v === "string") haystacks.push(v);
  }
  if (r.cause && typeof r.cause === "object") {
    const c = r.cause as Record<string, unknown>;
    for (const k of ["message", "details", "hint", "code", "reason", "error_code"]) {
      const v = c[k];
      if (typeof v === "string") haystacks.push(v);
    }
  }
  return haystacks.some((s) => s.includes("synthesis_neuron_cap_reached"));
}

/**
 * Dispatches the synthesis-cap event so `useUsageGate` can pop the upgrade
 * modal. Returns true when the error was recognised and handled (caller
 * should treat it as a "soft" failure and stop propagating).
 */
export function notifySynthesisCapIfApplicable(err: MaybeError): boolean {
  if (!isSynthesisCapError(err)) return false;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(SYNTHESIS_CAP_EVENT));
  }
  return true;
}
