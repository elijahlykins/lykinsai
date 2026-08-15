import { useEffect, useMemo, useState } from "react";

import { getLocalModeCached, setLocalMode, subscribeLocalMode } from "@/lib/localMode";

/**
 * "Sync with Mac" — the allowlist of folders LYKN and its AI may read on this
 * machine. It is set up in the welcome flow and can be changed afterwards from
 * Settings → Workspace, Mac Files, or the Vault's Local Mode switch.
 *
 * The list itself lives in the main process. Local Mode is the switch that lets
 * anything read through it at all, so syncing a folder turns Local Mode on —
 * behind the same one-time consent the Vault switch records.
 */

const CONSENT_KEY = "lykn_local_mode_consented";

/** The Electron bridge, or null on the web (where there is no Mac to sync). */
export function macSyncBridge() {
  const b = typeof window !== "undefined" ? window.lykn : null;
  return b && typeof b.macSyncGet === "function" ? b : null;
}

function hasConsented() {
  try {
    return localStorage.getItem(CONSENT_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberConsent() {
  try {
    localStorage.setItem(CONSENT_KEY, "1");
  } catch {
    /* consent still holds for this session */
  }
}

/**
 * Live view of the allowlist plus the actions that change it. `syncAll` is the
 * default: the whole home folder, with `folders` kept around so switching back
 * to a hand-picked list doesn't lose it.
 */
export function useMacSync() {
  const api = useMemo(() => macSyncBridge(), []);
  const [localModeOn, setLocalModeOn] = useState(getLocalModeCached);
  const [sync, setSync] = useState({ syncAll: true, folders: [] });
  const [busy, setBusy] = useState(false);
  // True while the access explainer is up, before Local Mode is granted.
  const [confirming, setConfirming] = useState(false);

  useEffect(() => subscribeLocalMode(setLocalModeOn), []);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    const apply = (payload) => {
      if (cancelled) return;
      setSync({
        syncAll: payload?.syncAll !== false,
        folders: payload?.syncedFolders || [],
      });
    };
    api
      .macSyncGet()
      .then((r) => {
        if (r?.ok) apply(r);
      })
      .catch(() => {});
    const off = api.onMacSyncChanged?.(apply);
    return () => {
      cancelled = true;
      off?.();
    };
  }, [api]);

  const save = async (next) => {
    if (!api) return;
    setSync(next);
    try {
      await api.macSyncSet({ syncAll: next.syncAll, syncedFolders: next.folders });
    } catch {
      /* main broadcasts the authoritative state back */
    }
  };

  const grantAccess = async () => {
    setBusy(true);
    try {
      await setLocalMode(true);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return {
    available: !!api,
    /** LYKN can read the synced folders (Local Mode is on). */
    enabled: localModeOn,
    syncAll: sync.syncAll,
    folders: sync.folders,
    busy,
    confirming,
    /** Nothing is readable: a hand-picked list with nothing picked yet. */
    empty: !sync.syncAll && sync.folders.length === 0,

    requestToggle: (next) => {
      if (!next) {
        setConfirming(false);
        void setLocalMode(false);
        return;
      }
      // First time granting file access on this device: explain it first.
      if (!hasConsented()) {
        setConfirming(true);
        return;
      }
      void grantAccess();
    },

    confirmEnable: () => {
      rememberConsent();
      void grantAccess();
    },

    cancelEnable: () => setConfirming(false),

    setSyncAll: (next) => void save({ ...sync, syncAll: next === true }),

    /** Native folder picker — sync Documents, a project, … */
    addFolders: async () => {
      if (!api) return;
      setBusy(true);
      try {
        const res = await api.macSyncPickFolder();
        if (!res?.ok || !res.folders?.length) return;
        const merged = [...sync.folders];
        for (const folder of res.folders) if (!merged.includes(folder)) merged.push(folder);
        await save({ syncAll: false, folders: merged });
        await setLocalMode(true);
      } finally {
        setBusy(false);
      }
    },

    removeFolder: (folder) =>
      void save({ ...sync, folders: sync.folders.filter((f) => f !== folder) }),
  };
}
