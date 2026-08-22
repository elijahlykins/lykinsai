/**
 * Opening the vault as a picker, and getting back what was chosen.
 *
 * The vault is the Finder window now — AI Drive and the folders on this Mac
 * behind one source list — so "add something from the vault" opens that window
 * in pick mode. It used to open a separate embedded copy of the old Vault page
 * in an iframe, which is why picking from a chat and picking from a project
 * looked like different products.
 *
 * Where the result goes depends on who asked, and that is the whole reason
 * `target` exists. The home bar wants the desktop chat to come forward with
 * the item attached; a chat that is already open wants it in the composer it
 * has; a project wants ids to cluster. One window, three ways home.
 */

import { openStudioTab } from "@/lib/studioTabs";

export type VaultPickTarget = "home" | "thread" | "project";

/**
 * `chat` is the spelling the home bar has always used and is still what its
 * URLs carry, so it keeps working; the others name themselves.
 */
const TARGET_PARAM: Record<VaultPickTarget, string> = {
  home: "chat",
  thread: "thread",
  project: "project",
};

/** Chosen AI Drive items, already in the payload shape a composer accepts. */
export const VAULT_PICK_ITEMS_EVENT = "lykn-chat-vault-add";
/** Chosen files on this Mac, as absolute paths. */
export const VAULT_PICK_PATHS_EVENT = "lykn-chat-vault-paths";
/** Chosen AI Drive rows, as vault ids, for the project pickers. */
export const VAULT_PICK_PROJECT_EVENT = "lykn-vault-project-pick";
/**
 * The picker is off screen — picked, cancelled or dismissed, which callers
 * that dimmed themselves to get out of its way can't tell apart and don't
 * need to.
 */
export const VAULT_PICK_CLOSED_EVENT = "lykn-vault-pick-closed";

/** Reads the target back off the vault window's own URL. */
export function pickTargetFromParams(params: URLSearchParams): VaultPickTarget | null {
  const raw = String(params.get("pick") || "").trim();
  if (!raw) return null;
  const found = (Object.keys(TARGET_PARAM) as VaultPickTarget[]).find(
    (target) => TARGET_PARAM[target] === raw,
  );
  return found ?? null;
}

/**
 * Opens the vault window in pick mode.
 *
 * @returns false when Studio isn't hosting this surface and so can't open a
 *   window — the caller is on the web build, where there is no Finder to open.
 */
export function openVaultPicker(target: VaultPickTarget): boolean {
  // Landing on AI Drive rather than a disk folder: what people mean by "from
  // the vault" is what LYKN saved, and the sidebar is right there for the rest.
  return openStudioTab("vault", `/vault?pane=drive&pick=${TARGET_PARAM[target]}`);
}

/** Hands the picked items to whoever opened the picker. */
export function deliverVaultPick(event: string, detail: unknown): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(event, { detail }));
}

/** Closes the vault window once a pick is done or abandoned. */
export function closeVaultPicker(): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem("lykn_vault_pick_for_chat");
  } catch {
    /* the pick param goes with the window either way */
  }
  window.dispatchEvent(new CustomEvent("lykn-studio-close-app", { detail: { id: "vault" } }));
  window.dispatchEvent(new CustomEvent(VAULT_PICK_CLOSED_EVENT));
}
