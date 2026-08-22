/**
 * Taking an installed app back into Build mode.
 *
 * Installing is not a one-way door: the source that produced an app is kept in
 * its own store, so "edit this again" is a matter of reading it back and handing
 * it to the chat as the artifact being worked on. From there the normal refine
 * loop applies — the model patches the real source rather than guessing at what
 * the app used to be.
 *
 * Editing opens a fresh chat, which tears the old surface down and mounts a new
 * one — so the handoff is a stash the new surface picks up, and deliberately
 * NOT an event: dispatching one would be heard by the surface on its way out,
 * which would claim the app for the conversation the user just left.
 *
 * Only the app id crosses that gap. Reading the source is a store round-trip,
 * and doing it before the handoff meant a click on "Edit" sat on an empty chat
 * until it finished — and produced nothing at all when it failed. The chat
 * loads the source itself, so the surface can say what it is doing while it
 * happens. The live app is not opened: Edit means Build mode, not a preview.
 */

import type { ChatArtifact } from "@/lib/ai/chatArtifacts";
import type { AppRecord } from "@/lib/apps/installApp";
import { appsBridge, listInstalledApps } from "@/lib/apps/installApp";

const PENDING_KEY = "lykn_pending_app_edit";
/**
 * How long a handoff stays good for. The surface it is meant for mounts within
 * a frame or two; anything older was never picked up, and attaching it to the
 * next chat the user happens to open would be baffling.
 */
const PENDING_TTL_MS = 30_000;
// Which app each chat is editing. The stash above is a one-shot handoff, so
// without this a reload would leave the conversation talking about an app it
// no longer holds the source for — and the next "add a dark mode" would build
// a brand-new app instead of editing the one on the desktop.
const LINK_KEY = "lykn_app_edit_chats";
const LINK_LIMIT = 40;

export type PendingAppEdit = {
  appId: string;
  /** Shown while the source loads, so the surface can name what it is opening. */
  name?: string;
  /** Only when the caller already had it built; the chat loads it otherwise. */
  artifact?: ChatArtifact | null;
};

// The compiled output the runtime actually loads. It lives alongside the source
// in the store, but it is a build product: editing it would be pointless and
// installing rewrites it anyway.
const BUNDLE_PATH = ".lykn/bundle.js";

/** The app's source, as the model last wrote it. */
export async function readAppProject(
  appId: string,
): Promise<Array<{ path: string; content: string }>> {
  const api = appsBridge();
  if (!api) return [];
  try {
    const res = await api.files(appId);
    const rows = res?.ok && Array.isArray(res.data) ? res.data : [];
    return rows
      .filter((f: any) => f?.path && f.path !== BUNDLE_PATH)
      .map((f: any) => ({ path: String(f.path), content: String(f.content ?? "") }));
  } catch {
    return [];
  }
}

/** Prefix on artifacts that carry an installed app's source into Build mode. */
export const APP_EDIT_SEED_PREFIX = "installed-app:";

/** True when this is the source handoff from Edit — not a build the model made. */
export function isAppEditSeed(artifact: { id?: string } | null | undefined): boolean {
  return !!artifact && String(artifact.id || "").startsWith(APP_EDIT_SEED_PREFIX);
}

/**
 * Read an installed app and turn it into the source Build mode edits.
 *
 * Source only, deliberately no preview. Edit should enter Build mode with the
 * files attached, not pull the live app (or a second copy of it) up over chat.
 * The next message still patches this source; a later build from the model is
 * what opens the preview panel.
 *
 * Keeps `app.json` among the files on purpose: it carries the name, icon and
 * capabilities, so reinstalling after an edit doesn't quietly reset them.
 */
export async function appEditArtifact(app: AppRecord): Promise<ChatArtifact | null> {
  const files = await readAppProject(app.id);
  if (!files.length) return null;

  const entry =
    (app as any).entry ||
    (files.some((f) => f.path === "App.jsx") ? "App.jsx" : files[0].path);
  const title = app.name || "App";

  return {
    id: `${APP_EDIT_SEED_PREFIX}${app.id}`,
    kind: "html",
    format: "html",
    title,
    toolName: "lykn_build_react_artifact",
    installedAppId: app.id,
    files,
    entry,
    code: files.find((f) => f.path === entry)?.content,
  };
}

/**
 * Hand the app to the chat surface. Write this before opening chat — the new
 * surface reads it on mount, so the handoff never depends on landing in the
 * window between the listener going up and the source finishing loading.
 */
export function stashAppEdit(pending: PendingAppEdit): void {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify({ ...pending, at: Date.now() }));
  } catch {
    /* storage blocked — nothing to hand over, and the click does nothing */
  }
}

/** Read and clear the stashed edit, if there is a recent one. */
export function takePendingAppEdit(): PendingAppEdit | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(PENDING_KEY);
    const parsed = JSON.parse(raw) as PendingAppEdit & { at?: number };
    if (!parsed?.appId) return null;
    if (parsed.at && Date.now() - parsed.at > PENDING_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function readLinks(): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(LINK_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Tie a chat to the app it edits, for as long as the chat lives. */
export function rememberAppEdit(chatId: string, appId: string): void {
  if (!chatId || !appId) return;
  try {
    const links = readLinks();
    delete links[chatId];
    const trimmed = Object.entries(links).slice(-(LINK_LIMIT - 1));
    localStorage.setItem(
      LINK_KEY,
      JSON.stringify({ ...Object.fromEntries(trimmed), [chatId]: appId }),
    );
  } catch {
    /* storage blocked — the link lasts this session only */
  }
}

/** Drop the tie, once the app it points at is gone. */
export function forgetAppEdit(chatId: string): void {
  if (!chatId) return;
  try {
    const links = readLinks();
    delete links[chatId];
    localStorage.setItem(LINK_KEY, JSON.stringify(links));
  } catch {
    /* storage blocked — nothing was written to begin with */
  }
}

/** The app this chat edits, if it was opened from one. */
export function recallAppEdit(chatId: string): string | null {
  if (!chatId) return null;
  const found = readLinks()[chatId];
  return typeof found === "string" && found ? found : null;
}

/**
 * Rebuild the editing artifact for a remembered app.
 *
 * Reads the source fresh rather than caching it: the app may have been edited
 * from another chat, or reinstalled, since this one last saw it. Returns null
 * once the app is uninstalled, which is what drops a stale link.
 */
export async function appEditArtifactById(appId: string): Promise<ChatArtifact | null> {
  if (!appId) return null;
  const app = (await listInstalledApps()).find((a) => a.id === appId);
  return app ? appEditArtifact(app) : null;
}
