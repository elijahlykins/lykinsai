import { PLAN_LIMITS, VAULT_UPLOAD_LIMITS } from "@/lib/pricing-config";

export type VaultUploadFileEntry = {
  file: File;
  folderPath: string | null;
  filename: string;
};

export type PreflightRejectReason = "too_large" | "vault_full" | "vault_slots" | "batch_cap";

export type PreflightRejected = {
  filename: string;
  reason: PreflightRejectReason;
};

export type PreflightResult = {
  accepted: VaultUploadFileEntry[];
  rejected: PreflightRejected[];
  isBulkImport: boolean;
  /** null = unlimited plan headroom */
  remainingSlots: number | null;
};

type PlanId = keyof typeof PLAN_LIMITS;

function resolvePlan(planId: string | null | undefined): PlanId {
  if (planId && PLAN_LIMITS[planId as PlanId]) return planId as PlanId;
  return "free";
}

/**
 * Trim and validate a drop before any compression / storage work starts.
 * Applies per-file size limits, per-drop file caps, and plan vault headroom.
 */
export function preflightVaultUploadBatch(
  files: VaultUploadFileEntry[],
  planId: string | null | undefined,
  currentVaultCount: number,
): PreflightResult {
  const limits = PLAN_LIMITS[resolvePlan(planId)];
  const vaultCap = limits.vaultCards;
  const remainingSlots = Number.isFinite(vaultCap)
    ? Math.max(0, vaultCap - Math.max(0, currentVaultCount))
    : null;

  const dropCap =
    remainingSlots === null
      ? VAULT_UPLOAD_LIMITS.maxFilesPerDrop
      : Math.min(VAULT_UPLOAD_LIMITS.maxFilesPerDrop, remainingSlots);

  const accepted: VaultUploadFileEntry[] = [];
  const rejected: PreflightRejected[] = [];

  for (const entry of files) {
    const size = entry.file.size || 0;
    if (size > VAULT_UPLOAD_LIMITS.maxFileBytes) {
      rejected.push({ filename: entry.filename, reason: "too_large" });
      continue;
    }
    if (dropCap <= 0 || accepted.length >= dropCap) {
      let reason: PreflightRejectReason = "batch_cap";
      if (remainingSlots === 0) {
        reason = "vault_full";
      } else if (
        remainingSlots !== null &&
        dropCap < VAULT_UPLOAD_LIMITS.maxFilesPerDrop
      ) {
        reason = "vault_slots";
      }
      rejected.push({ filename: entry.filename, reason });
      continue;
    }
    accepted.push(entry);
  }

  return {
    accepted,
    rejected,
    isBulkImport: accepted.length >= VAULT_UPLOAD_LIMITS.bulkImportAiThreshold,
    remainingSlots,
  };
}

export function formatBytesShort(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${Math.round(bytes / (1024 * 1024))} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${bytes} B`;
}

export function summarizePreflightRejections(rejected: PreflightRejected[]): string | null {
  if (!rejected.length) return null;

  const tooLarge = rejected.filter((r) => r.reason === "too_large").length;
  const vaultFull = rejected.filter((r) => r.reason === "vault_full").length;
  const vaultSlots = rejected.filter((r) => r.reason === "vault_slots").length;
  const batchCap = rejected.filter((r) => r.reason === "batch_cap").length;

  const parts: string[] = [];
  if (tooLarge > 0) {
    parts.push(
      `${tooLarge} file${tooLarge === 1 ? "" : "s"} over the ${formatBytesShort(VAULT_UPLOAD_LIMITS.maxFileBytes)} limit`,
    );
  }
  if (vaultFull > 0) {
    parts.push(
      `${vaultFull} file${vaultFull === 1 ? "" : "s"} skipped — vault is full`,
    );
  }
  if (vaultSlots > 0) {
    parts.push(
      `${vaultSlots} file${vaultSlots === 1 ? "" : "s"} skipped — not enough vault slots left in this drop`,
    );
  }
  if (batchCap > 0) {
    parts.push(
      `${batchCap} file${batchCap === 1 ? "" : "s"} skipped — ${VAULT_UPLOAD_LIMITS.maxFilesPerDrop} files max per drop`,
    );
  }
  return parts.join(". ");
}
