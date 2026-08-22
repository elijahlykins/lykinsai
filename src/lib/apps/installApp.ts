/**
 * Promoting a chat artifact into an installed app.
 *
 * The preview in chat is deliberately throwaway: it runs in an opaque-origin
 * iframe with no storage, and its hosted copy expires. Installing takes the
 * same source and gives it a permanent home on this device — its own origin,
 * its own database, and an icon in the dock.
 *
 * Everything here is desktop-only. In a browser there is no local store to
 * install into, so the UI hides the affordance rather than offering something
 * that would half-work.
 */

import type { ChatArtifact } from "@/lib/ai/chatArtifacts";

export type AppRecord = {
  id: string;
  name: string;
  icon?: string | null;
  /** "user" once the person picked the icon themselves; null when it came from the manifest. */
  icon_source?: string | null;
  description?: string | null;
  version: number;
  entry?: string | null;
  capabilities?: string[];
  grants?: Record<string, boolean>;
  opened_at?: string | null;
  created_at?: string;
};

type AppsBridge = {
  list: () => Promise<{ ok: boolean; apps?: AppRecord[] }>;
  install: (payload: {
    id?: string | null;
    title?: string;
    files: Array<{ path: string; content: string }>;
    entry?: string | null;
    icon?: string | null;
    sourceChat?: string | null;
  }) => Promise<{ ok: boolean; app?: AppRecord; error?: string; hint?: string }>;
  open: (id: string) => Promise<{ ok: boolean; error?: string }>;
  uninstall: (id: string) => Promise<{ ok: boolean }>;
  setIcon: (id: string, icon: string | null) => Promise<{ ok: boolean; app?: AppRecord }>;
  /** The app's project files, for editing it again in Build mode. */
  files: (id: string) => Promise<{
    ok: boolean;
    data?: Array<{ path: string; content: string; updated_at?: string }>;
  }>;
  verify: (id: string) => Promise<{ ok: boolean; hint?: string; errors?: unknown[] }>;
  permissions: (id: string) => Promise<{
    ok: boolean;
    capabilities?: string[];
    grants?: Record<string, boolean>;
    catalog?: Record<string, { label: string; detail: string; implicit?: boolean }>;
  }>;
  setPermission: (id: string, capability: string, allowed: boolean) => Promise<{ ok: boolean }>;
  stats: (id: string) => Promise<{ ok: boolean; data?: { rows: number; dataBytes: number } }>;
  dataCollections: (id: string) => Promise<{ ok: boolean; data?: Array<{ collection: string; count: number }> }>;
  clearData: (id: string, collection?: string | null) => Promise<{ ok: boolean }>;
  onChanged: (cb: (payload: { id?: string; action?: string }) => void) => () => void;
};

/**
 * One shape rather than a discriminated union: this project compiles with
 * `strict` off, where a `ok: true | false` discriminant does not narrow, so a
 * union here would force callers into casts.
 */
export type InstallResult = { ok: boolean; app?: AppRecord; error?: string };

function bridge(): AppsBridge | null {
  if (typeof window === "undefined") return null;
  const api = (window as any).lykn?.apps;
  return api && typeof api.install === "function" ? (api as AppsBridge) : null;
}

/** True when this build can install apps at all (desktop shell with a local store). */
export function isAppInstallAvailable(): boolean {
  return bridge() !== null;
}

/**
 * Can this artifact be installed?
 *
 * Any React artifact with source qualifies, including a single file — plenty of
 * genuinely useful apps are one component, and requiring a manifest or multiple
 * files would hide the button exactly when someone asks for "a simple notes
 * app". A stray Install on a one-off page costs the user a button they ignore;
 * a missing one on a real app looks like the feature is broken.
 */
export function looksInstallable(artifact: ChatArtifact | null | undefined): boolean {
  if (!artifact || artifact.toolName !== "lykn_build_react_artifact") return false;
  if (Array.isArray(artifact.files) && artifact.files.length > 0) return true;
  return typeof artifact.code === "string" && artifact.code.trim().length > 0;
}

/**
 * Files to install. A single-file artifact is wrapped into a project so the
 * install path only ever deals with one shape.
 */
function projectFiles(artifact: ChatArtifact): Array<{ path: string; content: string }> {
  if (Array.isArray(artifact.files) && artifact.files.length) {
    return artifact.files.map((f) => ({ path: String(f.path), content: String(f.content ?? "") }));
  }
  if (typeof artifact.code === "string" && artifact.code.trim()) {
    return [{ path: "App.jsx", content: artifact.code }];
  }
  return [];
}

/**
 * Install (or update) an artifact as an app.
 *
 * Pass `existingId` to update in place — the id is the app's origin, so reusing
 * it is what keeps the data the user already put into the app.
 */
export async function installArtifactAsApp(
  artifact: ChatArtifact,
  opts: { existingId?: string | null; sourceChat?: string | null; icon?: string | null } = {},
): Promise<InstallResult> {
  const api = bridge();
  if (!api) return { ok: false, error: "Installing apps needs the LYKN desktop app." };

  const files = projectFiles(artifact);
  if (!files.length) return { ok: false, error: "This artifact has no source to install." };

  try {
    const result = await api.install({
      id: opts.existingId ?? null,
      title: artifact.title || "App",
      files,
      entry: artifact.entry ?? null,
      icon: opts.icon ?? null,
      sourceChat: opts.sourceChat ?? null,
    });

    if (!result?.ok || !result.app) {
      // `hint` is the compiler's own message and is far more actionable than
      // the error code, so it wins when both are present.
      return { ok: false, error: result?.hint || result?.error || "Install failed." };
    }
    return { ok: true, app: result.app };
  } catch (err: any) {
    return { ok: false, error: err?.message || "Install failed." };
  }
}

export async function listInstalledApps(): Promise<AppRecord[]> {
  const api = bridge();
  if (!api) return [];
  try {
    const res = await api.list();
    return res?.ok && Array.isArray(res.apps) ? res.apps : [];
  } catch {
    return [];
  }
}

/** The app's own origin. Its id is the hostname, which is what isolates it. */
export function appWindowUrl(id: string): string {
  return `lykn-app://${id}/`;
}

/**
 * Installed apps share the desktop's window list with Browser, Calendar and the
 * rest, so their ids have to live in the same namespace without colliding with
 * a built-in one.
 */
export const APP_WINDOW_PREFIX = "app:";

export function appWindowId(id: string): string {
  return `${APP_WINDOW_PREFIX}${id}`;
}

export function appIdFromWindowId(windowId: string): string | null {
  return typeof windowId === "string" && windowId.startsWith(APP_WINDOW_PREFIX)
    ? windowId.slice(APP_WINDOW_PREFIX.length)
    : null;
}

/** Fired so the desktop can host the app itself; see `openInstalledApp`. */
export const OPEN_APP_EVENT = "lykn:open-app";

/**
 * Open an app.
 *
 * On the Studio desktop this becomes a window you can drag like any other, and
 * the desktop claims the request by cancelling this event. Everywhere else —
 * Settings in a standalone window, or before the desktop has mounted — there is
 * nothing to host it, so it falls back to a window of its own rather than
 * appearing not to open at all.
 */
export async function openInstalledApp(id: string): Promise<boolean> {
  if (typeof window !== "undefined") {
    const claimed = !window.dispatchEvent(
      new CustomEvent(OPEN_APP_EVENT, { detail: { id }, cancelable: true }),
    );
    if (claimed) return true;
  }
  const api = bridge();
  if (!api) return false;
  try {
    return (await api.open(id))?.ok === true;
  } catch {
    return false;
  }
}

/**
 * Set an installed app's icon. Pass null to go back to the default one.
 *
 * The choice outlives rebuilds: main records that it came from the user, so the
 * next time the app is edited and reinstalled the manifest cannot overwrite it.
 */
export async function setAppIcon(id: string, icon: string | null): Promise<boolean> {
  const api = bridge();
  if (!api || typeof api.setIcon !== "function") return false;
  try {
    return (await api.setIcon(id, icon))?.ok === true;
  } catch {
    return false;
  }
}

export async function uninstallApp(id: string): Promise<boolean> {
  const api = bridge();
  if (!api) return false;
  try {
    return (await api.uninstall(id))?.ok === true;
  } catch {
    return false;
  }
}

/** Subscribe to install/uninstall from any window. Returns an unsubscribe fn. */
export function onAppsChanged(
  cb: (payload: { id?: string; action?: string }) => void,
): () => void {
  const api = bridge();
  if (!api) return () => {};
  try {
    return api.onChanged((payload) => cb(payload || {}));
  } catch {
    return () => {};
  }
}

export { bridge as appsBridge };
