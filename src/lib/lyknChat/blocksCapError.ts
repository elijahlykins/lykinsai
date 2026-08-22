// Shared detector + event bus for the server-side blocks-per-grid trigger
// defined in `supabase-migrations/031_blocks_per_grid_trigger.sql`.
//
// Chat snapshots used to carry a blocks array. The DB trigger still rejects
// oversized snapshots; if a stale client hits that, show the same upgrade
// modal instead of a silent save-failure.

import { BLOCK_LIMIT_EVENT } from "@/lib/useUsageGate";

type MaybeError = unknown;

function toRecord(err: MaybeError): Record<string, unknown> | null {
  if (!err || typeof err !== "object") return null;
  return err as Record<string, unknown>;
}

/** True if the given Supabase/PG error came from the blocks-per-grid trigger. */
export function isBlocksCapError(err: MaybeError): boolean {
  const r = toRecord(err);
  if (!r) return false;
  const haystacks = [r.message, r.details, r.hint]
    .filter((v): v is string => typeof v === "string");
  return haystacks.some((s) => s.includes("blocks_per_grid_cap_reached"));
}

/**
 * Dispatches the shared block-limit event so `useUsageGate` pops the same
 * upgrade modal shown by the in-memory cap. Returns true when the error was
 * recognised.
 */
export function notifyBlocksCapIfApplicable(err: MaybeError): boolean {
  if (!isBlocksCapError(err)) return false;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(BLOCK_LIMIT_EVENT));
  }
  return true;
}
