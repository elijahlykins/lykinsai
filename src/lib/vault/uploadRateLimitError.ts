// Shared detector + event bus for the upload rate-limit trigger defined in
// `supabase-migrations/033_upload_rate_trigger.sql`.
//
// The client throttles big drops itself (see startVaultUploads in
// uploadPipeline.ts), so this fires mostly when:
//   • A tampered client bypasses the pacing
//   • Two tabs/sessions upload at once and collectively exceed the window
//   • Plan data is stale (just downgraded, still uploading fast)
//
// When the trigger raises `upload_rate_limit: ...` we dispatch an event that
// `useUsageGate` listens to so the existing upgrade modal surfaces the issue
// instead of failing silently with a generic "upload failed" toast.

export const UPLOAD_RATE_LIMIT_EVENT = "lykn:upload-rate-limit";

type MaybeError = unknown;

function toRecord(err: MaybeError): Record<string, unknown> | null {
  if (!err || typeof err !== "object") return null;
  return err as Record<string, unknown>;
}

/** True if the given Supabase/PG error came from the upload-rate trigger. */
export function isUploadRateLimitError(err: MaybeError): boolean {
  const r = toRecord(err);
  if (!r) return false;
  const haystacks = [r.message, r.details, r.hint]
    .filter((v): v is string => typeof v === "string");
  return haystacks.some((s) => s.includes("upload_rate_limit"));
}

export interface UploadRateLimitDetail {
  /** "minute" | "hour" if we can tell from the message, else null. */
  window: "minute" | "hour" | null;
}

function parseWindow(err: MaybeError): UploadRateLimitDetail["window"] {
  const r = toRecord(err);
  if (!r) return null;
  const msg = typeof r.message === "string" ? r.message : "";
  if (msg.includes("per minute")) return "minute";
  if (msg.includes("per hour")) return "hour";
  return null;
}

/**
 * Dispatches the rate-limit event so `useUsageGate` can pop its upgrade
 * modal. Returns true when the error was recognised and handled (caller
 * should treat it as a soft failure and stop propagating).
 */
export function notifyUploadRateLimitIfApplicable(err: MaybeError): boolean {
  if (!isUploadRateLimitError(err)) return false;
  if (typeof window !== "undefined") {
    const detail: UploadRateLimitDetail = { window: parseWindow(err) };
    window.dispatchEvent(
      new CustomEvent(UPLOAD_RATE_LIMIT_EVENT, { detail }),
    );
  }
  return true;
}
