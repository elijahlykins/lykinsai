/**
 * Attachment handoff for the home-desktop chat bar.
 *
 * The bar hands prompts to the real chat surface through sessionStorage (cold
 * surface) plus a DOM event (warm one), but File objects can't be serialized.
 * They park here instead: the Studio swaps tabs rather than reloading, so both
 * sides share one JS context and the surface can claim the files when it
 * consumes the pending send.
 */

import { macFileUrl } from "@/components/macfiles/preview";

/** @type {File[]} */
let pendingFiles = [];

/** @typedef {{ name: string, path: string, listing: string }} MacFolderSnapshot */

/** @type {MacFolderSnapshot[]} */
let pendingFolders = [];

/** @type {string[]} */
let pendingVaultPaths = [];

const VAULT_PATHS_QUEUED_EVENT = "lykn-vault-paths-queued";

/** @type {string[]} */
let pendingChatPaths = [];

const CHAT_PATHS_QUEUED_EVENT = "lykn-home-chat-paths-queued";

export function setPendingHomeChatFiles(files) {
  pendingFiles = Array.from(files || []);
}

/** Claim the parked files — one consumer only, so a later send starts clean. */
export function takePendingHomeChatFiles() {
  const claimed = pendingFiles;
  pendingFiles = [];
  return claimed;
}

export function setPendingHomeChatFolders(folders) {
  pendingFolders = Array.isArray(folders) ? folders.slice() : [];
}

/** Claim parked folder snapshots — same one-consumer rule as files. */
export function takePendingHomeChatFolders() {
  const claimed = pendingFolders;
  pendingFolders = [];
  return claimed;
}

/** Queue a desktop-to-Vault drop before opening AI Drive. */
export function queueVaultMacPaths(paths) {
  pendingVaultPaths = Array.isArray(paths) ? paths.filter(Boolean) : [];
  if (pendingVaultPaths.length && typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(VAULT_PATHS_QUEUED_EVENT));
  }
}

/** Claim one queued desktop-to-Vault drop. */
export function takeQueuedVaultMacPaths() {
  const claimed = pendingVaultPaths;
  pendingVaultPaths = [];
  return claimed;
}

export function onVaultMacPathsQueued(handler) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(VAULT_PATHS_QUEUED_EVENT, handler);
  return () => window.removeEventListener(VAULT_PATHS_QUEUED_EVENT, handler);
}

/**
 * Hand real files to the desktop chat bar by path — what "Ask LYKN about
 * this" does from the Files window and from a desktop icon. They land as the
 * same chips a drag onto the bar leaves.
 *
 * Queued rather than handed over directly: the bar is unmounted while Split
 * View or a zoomed window covers the desktop, and the window being asked
 * about is often the thing in the way, so it claims whatever is waiting when
 * it comes back.
 */
export function attachMacPathsToHomeChat(paths) {
  const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
  if (!list.length) return;
  pendingChatPaths = [...pendingChatPaths, ...list];
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(CHAT_PATHS_QUEUED_EVENT));
  }
}

/** Claim the queued paths — one consumer only, like the parked files. */
export function takeQueuedHomeChatPaths() {
  const claimed = pendingChatPaths;
  pendingChatPaths = [];
  return claimed;
}

export function onHomeChatPathsQueued(handler) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(CHAT_PATHS_QUEUED_EVENT, handler);
  return () => window.removeEventListener(CHAT_PATHS_QUEUED_EVENT, handler);
}

/** @type {File[]} */
let queuedChatFiles = [];

const CHAT_FILES_QUEUED_EVENT = "lykn-home-chat-files-queued";

/**
 * The same "Ask LYKN about this" handoff for a file with no path on disk — one
 * LYKN generated, or one that lives in the vault. The bytes are already in hand
 * by the time we get here, so they queue as Files rather than as paths to read.
 */
export function attachFilesToHomeChat(files) {
  const list = Array.from(files || []).filter(Boolean);
  if (!list.length) return;
  queuedChatFiles = [...queuedChatFiles, ...list];
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(CHAT_FILES_QUEUED_EVENT));
  }
}

/** Claim the queued files — one consumer only, like the queued paths. */
export function takeQueuedHomeChatFiles() {
  const claimed = queuedChatFiles;
  queuedChatFiles = [];
  return claimed;
}

export function onHomeChatFilesQueued(handler) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(CHAT_FILES_QUEUED_EVENT, handler);
  return () => window.removeEventListener(CHAT_FILES_QUEUED_EVENT, handler);
}

/**
 * Staged builds on the chat bar. Unlike files, these are NOT take-once: Home
 * can mount more than one bar (desktop pill + Chat window), and the in-page
 * composer is CSS-hidden on Home. A one-consumer queue parked the chip on
 * whichever listener ran first — often a bar the user cannot see.
 *
 * Module state is the source of truth. Every bar syncs from the event detail
 * (and from this list on mount). Send and chip-remove clear it.
 */
/** @type {unknown[]} */
let stagedChatArtifacts = [];

const CHAT_ARTIFACTS_QUEUED_EVENT = "lykn-home-chat-artifacts-queued";

/** @type {unknown[]} */
let pendingChatArtifacts = [];

export function homeChatArtifactKey(artifact) {
  const id = String(artifact?.id || "").trim();
  if (id) return id;
  return String(artifact?.title || "").trim();
}

function emitStagedChatArtifacts() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(CHAT_ARTIFACTS_QUEUED_EVENT, {
      detail: { artifacts: stagedChatArtifacts.slice() },
    }),
  );
}

export function listStagedHomeChatArtifacts() {
  return stagedChatArtifacts.slice();
}

/**
 * Hand an already-made build to the chat bar. The chip is the artifact —
 * sending then takes the edit route when the user asks for a change in Build.
 */
export function attachArtifactToHomeChat(artifact) {
  if (!artifact || typeof artifact !== "object") return;
  const key = homeChatArtifactKey(artifact);
  if (key && stagedChatArtifacts.some((row) => homeChatArtifactKey(row) === key)) {
    emitStagedChatArtifacts();
    return;
  }
  stagedChatArtifacts = [...stagedChatArtifacts, artifact];
  emitStagedChatArtifacts();
}

export function unstageHomeChatArtifact(key) {
  const want = String(key || "").trim();
  if (!want) return;
  const next = stagedChatArtifacts.filter((row) => homeChatArtifactKey(row) !== want);
  if (next.length === stagedChatArtifacts.length) return;
  stagedChatArtifacts = next;
  emitStagedChatArtifacts();
}

export function clearStagedHomeChatArtifacts() {
  if (!stagedChatArtifacts.length) return;
  stagedChatArtifacts = [];
  emitStagedChatArtifacts();
}

/** Current staged builds. Does not consume — every visible bar needs the same list. */
export function takeQueuedHomeChatArtifacts() {
  return stagedChatArtifacts.slice();
}

export function onHomeChatArtifactsQueued(handler) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(CHAT_ARTIFACTS_QUEUED_EVENT, handler);
  return () => window.removeEventListener(CHAT_ARTIFACTS_QUEUED_EVENT, handler);
}

/** Park artifacts on a home-bar send so the chat surface can claim them. */
export function setPendingHomeChatArtifacts(artifacts) {
  pendingChatArtifacts = Array.isArray(artifacts) ? artifacts.filter(Boolean) : [];
}

export function takePendingHomeChatArtifacts() {
  const claimed = pendingChatArtifacts;
  pendingChatArtifacts = [];
  return claimed;
}

export function fileNameFromPath(p) {
  const parts = String(p || "")
    .replace(/\/+$/, "")
    .split("/")
    .filter(Boolean);
  return parts[parts.length - 1] || "file";
}

/** Desktop icons only carry paths. Pull the bytes over lykn-mac:// so the
 *  composer can treat them like files picked from the + button. Folders and
 *  anything the allowlist refuses come back empty, not thrown. */
export async function filesFromMacPaths(paths) {
  const out = [];
  for (const p of paths || []) {
    const file = await fileFromMacPath(p);
    if (file) out.push(file);
  }
  return out;
}

async function fileFromMacPath(path) {
  const url = macFileUrl(path);
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob || blob.size === 0) return null;
    const type = blob.type && blob.type !== "application/octet-stream" ? blob.type : "";
    return new File([blob], fileNameFromPath(path), { type, lastModified: Date.now() });
  } catch {
    return null;
  }
}

/**
 * Expand desktop paths into the same entries the vault upload pipeline gets
 * from its native file/folder picker. Folder traversal stays behind the
 * Electron allowlist, and is capped just past the vault's 200-file drop limit
 * so a very large folder cannot pull thousands of files into renderer memory.
 */
export async function vaultEntriesFromMacPaths(paths, maxFiles = 201) {
  const api =
    typeof window !== "undefined" ? /** @type {any} */ (window).lykn?.files : null;
  const out = [];

  const addFile = async (path, folderPath = null) => {
    if (out.length >= maxFiles) return;
    const file = await fileFromMacPath(path);
    if (file) out.push({ file, folderPath, filename: file.name });
  };

  const addFolder = async (path, folderPath) => {
    if (out.length >= maxFiles || typeof api?.list !== "function") return;
    let listing;
    try {
      listing = await api.list({ path });
    } catch {
      return;
    }
    if (!listing?.ok) return;
    for (const entry of listing.entries || []) {
      if (out.length >= maxFiles) break;
      if (entry.type === "dir" && !entry.package) {
        await addFolder(entry.path, `${folderPath}/${entry.name}`);
      } else {
        await addFile(entry.path, folderPath);
      }
    }
  };

  for (const rawPath of paths || []) {
    if (out.length >= maxFiles) break;
    const path = String(rawPath || "").replace(/\/+$/, "");
    if (!path) continue;

    let listing = null;
    if (typeof api?.list === "function") {
      try {
        listing = await api.list({ path });
      } catch {
        listing = null;
      }
    }

    if (listing?.ok) {
      const rootName = fileNameFromPath(path);
      for (const entry of listing.entries || []) {
        if (out.length >= maxFiles) break;
        if (entry.type === "dir" && !entry.package) {
          await addFolder(entry.path, `${rootName}/${entry.name}`);
        } else {
          await addFile(entry.path, rootName);
        }
      }
    } else {
      await addFile(path);
    }
  }

  return out;
}

/** Snapshot a desktop folder so chat can answer "what's in this" without
 *  wandering the rest of the disk. Caps the listing; the model can still
 *  local_list_dir the same path if it needs more. */
export async function snapshotMacFolders(paths) {
  const api =
    typeof window !== "undefined" ? /** @type {any} */ (window).lykn?.files : null;
  /** @type {MacFolderSnapshot[]} */
  const out = [];
  for (const raw of paths || []) {
    const path = String(raw || "").replace(/\/+$/, "");
    if (!path) continue;
    const name = fileNameFromPath(path);
    let body = `Path: ${path}`;
    if (typeof api?.list === "function") {
      try {
        const listing = await api.list({ path });
        if (listing?.ok) {
          const entries = listing.entries || [];
          const lines = entries.slice(0, 120).map((e) => {
            const folder = e.type === "dir" && !e.package;
            return `  - ${e.name}${folder ? "/" : ""}`;
          });
          const extra =
            entries.length > 120 ? `\n  - …and ${entries.length - 120} more` : "";
          body += `\n${entries.length} item${entries.length === 1 ? "" : "s"}:\n${lines.join("\n")}${extra}`;
        } else {
          body += `\n(Listing failed. Call local_list_dir with this exact path.)`;
        }
      } catch {
        body += `\n(Listing failed. Call local_list_dir with this exact path.)`;
      }
    } else {
      body += `\n(No local file list available. Call local_list_dir with this exact path.)`;
    }
    out.push({ name, path, listing: `Attached folder "${name}"\n${body}` });
  }
  return out;
}
