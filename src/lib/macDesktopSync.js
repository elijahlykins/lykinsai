import { useEffect, useMemo, useState } from "react";

import { getLocalModeCached, setLocalMode, subscribeLocalMode } from "@/lib/localMode";
import { setFolderSynced } from "@/lib/macSync";
import { attachMacPathsToHomeChat } from "@/lib/homeChatFiles";

/**
 * "Sync my Desktop" — the folders and files sitting on the user's real Mac
 * desktop, mirrored onto the LYKN Home desktop.
 *
 * The mirror itself only reads: it lists the folder and opens items in the app
 * that owns them, and dragging a mirrored icon around Home stores a position
 * here rather than touching disk. Dropping a file onto the LYKN desktop does
 * write — it moves the file into the Desktop folder — but that's an explicit
 * act by the user, and it shows that one file without turning the mirror on.
 *
 * Which folders are mirrored lives on the same `lykinsai_settings` blob as the
 * Home widget switches, so Settings → Display keeps one persist path. Reading
 * the files themselves still goes through Local Mode and the synced-folders
 * allowlist in the main process — this module only turns those on.
 */

const SETTINGS_KEY = "lykinsai_settings";

/** Fallback for a Mac whose Desktop path we could not resolve over IPC. */
export const FALLBACK_DESKTOP_PATH = "~/Desktop";

/** The Electron bridge, or null on the web (where there is no Mac to mirror). */
export function macFsBridge() {
  const b = typeof window !== "undefined" ? window.lykn : null;
  return b && typeof b.macFsList === "function" ? b : null;
}

export function shortenHome(p) {
  return String(p || "").replace(/^\/Users\/[^/]+/, "~");
}

/** Display name for a mirrored folder ("Desktop", "Screenshots", …). */
export function folderLabel(p) {
  const parts = String(p || "").split("/").filter(Boolean);
  return parts[parts.length - 1] || String(p || "");
}

function normalizeFolders(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    const folder = String(raw || "").trim().replace(/\/+$/, "");
    if (folder && !out.includes(folder)) out.push(folder);
  }
  return out;
}

/** Which folders are mirrored on Home, from the settings blob. */
export function readDesktopSync() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    const cfg = saved.desktopSync;
    if (cfg && typeof cfg === "object") {
      return { enabled: cfg.enabled === true, folders: normalizeFolders(cfg.folders) };
    }
  } catch {
    /* nothing mirrored */
  }
  return { enabled: false, folders: [] };
}

function sameConfig(a, b) {
  return a.enabled === b.enabled && a.folders.join("|") === b.folders.join("|");
}

/** Live view of the mirror config — follows Settings without a reload. */
export function useDesktopSync() {
  const [config, setConfig] = useState(readDesktopSync);
  useEffect(() => {
    const sync = () =>
      setConfig((prev) => {
        const next = readDesktopSync();
        return sameConfig(prev, next) ? prev : next;
      });
    window.addEventListener("lykinsai_settings_changed", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("lykinsai_settings_changed", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return config;
}

function isInsideFolder(child, parent) {
  const c = String(child || "").replace(/\/+$/, "");
  const p = String(parent || "").replace(/\/+$/, "");
  return !!p && (c === p || c.startsWith(`${p}/`));
}

/** The real Desktop path on this Mac, or the `~` fallback if IPC is unhappy. */
export async function resolveDesktopPath(api) {
  try {
    const r = await api?.macFsHome?.();
    if (r?.ok && r.desktop) return r.desktop;
  } catch {
    /* fall through */
  }
  return FALLBACK_DESKTOP_PATH;
}

/* ── Dropped items ────────────────────────────────────────────────────────
   Files the user dragged onto the LYKN desktop. These show up on Home whether
   or not the folder mirror is on, and they're deliberately NOT the same thing:
   mirroring pulls in everything in a folder, while this is only what the user
   put here by hand. Dropping one file is not consent to surface the rest.

   Only paths are kept. The files themselves live on disk in the Desktop
   folder, so this list is a view, not a copy — anything that disappears from
   disk gets pruned on the next read. ────────────────────────────────────── */

const DROPS_KEY = "lykn_desktop_drops";
const DROPS_EVENT = "lykn_desktop_drops_changed";

export function readDesktopDrops() {
  try {
    const parsed = JSON.parse(localStorage.getItem(DROPS_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((p) => typeof p === "string" && p) : [];
  } catch {
    return [];
  }
}

function writeDesktopDrops(paths) {
  try {
    localStorage.setItem(DROPS_KEY, JSON.stringify(paths));
  } catch {
    return;
  }
  window.dispatchEvent(new CustomEvent(DROPS_EVENT));
}

/** Remember items just dropped on Home. Returns how many were new. */
export function addDesktopDrops(paths) {
  const current = readDesktopDrops();
  const added = paths.filter((p) => p && !current.includes(p));
  if (added.length) writeDesktopDrops([...current, ...added]);
  return added.length;
}

/** Forget items that are no longer on disk, or that the user cleared. */
export function forgetDesktopDrops(paths) {
  const gone = new Set(paths);
  const current = readDesktopDrops();
  const next = current.filter((p) => !gone.has(p));
  if (next.length !== current.length) writeDesktopDrops(next);
}

/** Live view of the dropped items, following drops from anywhere. */
export function useDesktopDrops() {
  const [drops, setDrops] = useState(readDesktopDrops);
  useEffect(() => {
    const sync = () =>
      setDrops((prev) => {
        const next = readDesktopDrops();
        return prev.join("|") === next.join("|") ? prev : next;
      });
    window.addEventListener(DROPS_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(DROPS_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return drops;
}

/**
 * Make the mirrored folders readable: Local Mode on, and each folder covered
 * by the synced-folders allowlist (a no-op while the whole home folder is
 * synced, which is the default).
 */
export async function grantMirrorAccess(api, folders) {
  if (!api) return;
  await setLocalMode(true);
  try {
    const cfg = await api.macSyncGet();
    if (!cfg?.ok) return;
    const synced = cfg.syncedFolders || [];
    const excluded = cfg.excludedFolders || [];
    // A folder is missing if the allowlist doesn't reach it, and also if its own
    // sync switch is off — mirroring the Desktop is a request to see it, so a
    // Desktop that was switched off has to come back on.
    const missing = folders.filter((f) => {
      if (f.startsWith("~")) return false;
      if (excluded.some((e) => isInsideFolder(f, e))) return true;
      return cfg.syncAll === false && !synced.some((s) => isInsideFolder(f, s));
    });
    for (const folder of missing) await setFolderSynced(api, folder, true);
  } catch {
    /* main broadcasts the authoritative state back */
  }
}

/** Same one-time consent the Vault's Local Mode switch records. */
const CONSENT_KEY = "lykn_local_mode_consented";

function hasConsented() {
  try {
    return localStorage.getItem(CONSENT_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Everything Settings → Display needs to drive "Sync my Desktop": the current
 * folder list, whether the desktop shell can mirror at all, and the actions
 * that turn it on (which also grant the file access the mirror reads through).
 *
 * `value` is the `desktopSync` slice of the settings blob; `onChange` persists
 * a new slice through the modal's own persist path.
 */
export function useDesktopMirrorSettings(value, onChange) {
  const api = useMemo(() => macFsBridge(), []);
  const enabled = value?.enabled === true;
  const folders = useMemo(() => normalizeFolders(value?.folders), [value?.folders]);
  const [localModeOn, setLocalModeOn] = useState(getLocalModeCached);
  const [busy, setBusy] = useState(false);
  // True while the explainer card is showing, before access is granted.
  const [confirming, setConfirming] = useState(false);

  useEffect(() => subscribeLocalMode(setLocalModeOn), []);

  const turnOn = async () => {
    setBusy(true);
    try {
      const next = folders.length ? folders : [await resolveDesktopPath(api)];
      await grantMirrorAccess(api, next);
      onChange({ enabled: true, folders: next });
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return {
    available: !!api,
    enabled,
    folders,
    busy,
    confirming,
    /** Local Mode was switched off elsewhere, so the mirror can't read disk. */
    blocked: enabled && !localModeOn,

    requestToggle: (next) => {
      if (!next) {
        // Leave Local Mode alone — chat and the Files tab may still want it.
        setConfirming(false);
        onChange({ enabled: false, folders });
        return;
      }
      // First time granting file access on this device: explain it first.
      if (!localModeOn && !hasConsented()) {
        setConfirming(true);
        return;
      }
      void turnOn();
    },

    confirmEnable: () => {
      try {
        localStorage.setItem(CONSENT_KEY, "1");
      } catch {
        /* proceed for this session */
      }
      void turnOn();
    },

    cancelEnable: () => setConfirming(false),

    /** Native folder picker — mirror Documents, Downloads, a project, … */
    addFolders: async () => {
      if (!api) return;
      setBusy(true);
      try {
        const res = await api.macSyncPickFolder();
        if (!res?.ok || !res.folders?.length) return;
        const merged = normalizeFolders([
          ...(folders.length ? folders : [await resolveDesktopPath(api)]),
          ...res.folders,
        ]);
        await grantMirrorAccess(api, merged);
        onChange({ enabled: true, folders: merged });
      } finally {
        setBusy(false);
      }
    },

    removeFolder: (folder) => {
      const next = folders.filter((f) => f !== folder);
      // Nothing left to mirror — that's the same as switching it off.
      onChange({ enabled: next.length > 0 && enabled, folders: next });
    },
  };
}

/**
 * Hand a mirrored item to LYKN chat. Same handoff the Files browser uses: the
 * file lands on the desktop chat bar as an attachment, and the question is
 * whatever the user types next.
 */
export function askLyknAboutPath(fullPath) {
  attachMacPathsToHomeChat([fullPath]);
}
