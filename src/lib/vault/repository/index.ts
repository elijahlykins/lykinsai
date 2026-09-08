/**
 * Picking a vault backend.
 *
 * On the desktop shell (store bridge present), LOCAL IS THE DEFAULT: a fresh
 * install reads and writes this device from the first session, and generated
 * media never becomes a cloud object. The localStorage preference is an
 * explicit opt-out ("0"), not an opt-in — it exists for users who started on
 * the cloud vault and haven't copied their items down yet (the Local Vault
 * settings pane owns that migration and the switch).
 *
 * In a plain browser there is no local store at all, so Supabase is the only
 * answer regardless of the preference.
 *
 * The preference lives in localStorage because backend selection happens
 * during render, before any async call could resolve it.
 */

import { isDesktopShell } from "@/lib/webAppAccess";
import { createLocalVaultRepository } from "./localRepository";
import { createSupabaseVaultRepository } from "./supabaseRepository";
import type { VaultBackend, VaultRepository } from "./types";

export const LOCAL_VAULT_PREF_KEY = "lykn_local_vault";

/** Whether this build can reach a local store at all. */
export function isLocalVaultAvailable(): boolean {
  try {
    return isDesktopShell() && Boolean((window as any)?.lykn?.store);
  } catch {
    return false;
  }
}

export function isLocalVaultEnabled(): boolean {
  if (!isLocalVaultAvailable()) return false;
  try {
    // Default ON: only an explicit "0" (the settings switch) selects the cloud
    // vault. Unset — every fresh install — means local.
    return window.localStorage.getItem(LOCAL_VAULT_PREF_KEY) !== "0";
  } catch {
    // Private browsing and some hardened profiles throw on localStorage. With
    // no way to read the opt-out, stay local — that is the desktop default.
    return true;
  }
}

export function setLocalVaultEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(LOCAL_VAULT_PREF_KEY, enabled ? "1" : "0");
  } catch {
    /* preference is best-effort */
  }
}

export function activeVaultBackend(): VaultBackend {
  return isLocalVaultEnabled() ? "local" : "supabase";
}

/**
 * The repository the vault should use right now.
 *
 * Instances are cheap but not free — the Supabase one remembers which column
 * set its database accepts — so they are cached per backend and user.
 */
let cached: { key: string; repository: VaultRepository } | null = null;

export function getVaultRepository(userId: string | null | undefined): VaultRepository {
  const backend = activeVaultBackend();
  const key = `${backend}:${userId || ""}`;
  if (cached?.key === key) return cached.repository;

  const repository =
    backend === "local"
      ? createLocalVaultRepository()
      : createSupabaseVaultRepository(String(userId || ""));

  cached = { key, repository };
  return repository;
}

/** Drop the cached instance — call after switching backends. */
export function resetVaultRepository(): void {
  cached = null;
}

export * from "./types";
export * from "./mediaUrl";
export * from "./writes";
export { createLocalVaultRepository } from "./localRepository";
export { createSupabaseVaultRepository } from "./supabaseRepository";
