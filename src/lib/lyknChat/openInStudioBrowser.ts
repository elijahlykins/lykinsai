/**
 * Route http(s) clicks from chat (artifacts, sources, markdown links) into
 * the LYKN in-app browser — each open creates a new agent tab so the AI can
 * act on that page independently. The native agent side chat opens with
 * that tab — not the home Chat / Build / Imagine / Research composer.
 *
 * Preference order:
 *  1. studioOpenUrl — fresh labeled agent tab + Studio Browser tab switch
 *  2. openExternal — desktop bridge → lykn:open-url → also a fresh agent tab
 *
 * Artifacts should use openArtifactInStudioBrowser (URL + optional srcDoc).
 *
 * Returns true when the desktop bridge handled the URL (caller should
 * preventDefault); false means fall back to the default <a> / window.open.
 */

import { getActiveThreadChatId } from "@/lib/chat/chatThreadRuntime";
import {
  bindBrowserTabChat,
  markPendingBrowserChat,
} from "@/lib/lyknChat/browserChatAttach";

export const STUDIO_SHOW_BROWSER_EVENT = "lykn-studio-show-browser";

type OpenResult = { ok?: boolean; id?: string; agentId?: string };

type LyknStudioBridge = {
  studioOpenUrl?: (
    url: string,
    title?: string,
    opts?: { chatId?: string },
  ) => Promise<OpenResult | unknown>;
  studioOpenArtifact?: (payload: {
    url?: string;
    html?: string;
    title?: string;
    kind?: string;
    chatId?: string;
  }) => Promise<OpenResult | unknown>;
  openExternal?: (url: string, title?: string) => void;
};

/** @deprecated Kept for call-site compatibility; every open is a new agent now. */
export type OpenInStudioBrowserOptions = {
  newTab?: boolean;
  chatId?: string;
};

function lyknBridge(): LyknStudioBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { lykn?: LyknStudioBridge }).lykn;
}

function activeChatId(explicit?: string): string {
  return String(explicit || getActiveThreadChatId() || "").trim();
}

export type ShowStudioBrowserDetail = {
  chatId?: string;
  agentId?: string;
  url?: string;
  title?: string;
  openRail?: boolean;
};

function showStudioBrowserTab(detail: ShowStudioBrowserDetail = {}) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(STUDIO_SHOW_BROWSER_EVENT, { detail }),
  );
}

function showOpenedTab(
  result: OpenResult | unknown,
  meta: { url?: string; title?: string; chatId?: string },
) {
  const payload = result && typeof result === "object" ? (result as OpenResult) : {};
  const agentId = String(payload.id || payload.agentId || "").trim();
  // The tab id is known now — pair it with the conversation that opened it,
  // so the browser rail shows that chat instead of a fresh agent thread.
  if (agentId && meta.chatId) {
    bindBrowserTabChat(agentId, meta.chatId, { url: meta.url, title: meta.title });
  }
  showStudioBrowserTab({
    agentId: agentId || undefined,
    url: meta.url,
    title: meta.title,
    openRail: true,
  });
}

/** True when the desktop app can open URLs in the LYKN browser. */
export function studioBrowserAvailable(): boolean {
  const lykn = lyknBridge();
  return (
    typeof lykn?.studioOpenArtifact === "function" ||
    typeof lykn?.studioOpenUrl === "function" ||
    typeof lykn?.openExternal === "function"
  );
}

/**
 * Open a URL in the LYKN in-app browser as a new agent.
 * Returns true when handled (caller should preventDefault).
 */
export function openInStudioBrowser(
  url: string,
  title?: string,
  opts?: OpenInStudioBrowserOptions,
): boolean {
  const target = String(url || "").trim();
  if (!/^https?:\/\//i.test(target)) return false;
  const lykn = lyknBridge();
  if (!lykn) return false;
  const chatId = activeChatId(opts?.chatId);

  try {
    // Prefer studioOpenUrl so each link/artifact gets its own labeled agent.
    if (typeof lykn.studioOpenUrl === "function") {
      // Park the chat id before the tab id exists — the rail claims it the
      // moment the new tab reports in, even if that beats the open's reply.
      if (chatId) markPendingBrowserChat(chatId);
      showStudioBrowserTab({
        url: target,
        title,
        openRail: true,
      });
      void Promise.resolve(
        lykn.studioOpenUrl(target, title, {
          chatId: chatId || undefined,
        }),
      )
        .then((res) => showOpenedTab(res, { url: target, title, chatId }))
        .catch(() => {});
      return true;
    }
    if (typeof lykn.openExternal === "function") {
      if (chatId) markPendingBrowserChat(chatId);
      lykn.openExternal(target, title);
      showStudioBrowserTab({ url: target, title, openRail: true });
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Open a chat artifact in the LYKN browser as a new agent.
 * Passes hosted preview URL and/or inline HTML so the page still paints when
 * the signed file-proxy link is slow or expired.
 */
export function openArtifactInStudioBrowser(artifact: {
  previewUrl?: string | null;
  downloadUrl?: string | null;
  srcDoc?: string | null;
  title?: string | null;
  kind?: string | null;
}, opts?: OpenInStudioBrowserOptions): boolean {
  const lykn = lyknBridge();
  if (!lykn) return false;

  const url = String(artifact.previewUrl || artifact.downloadUrl || "").trim();
  const html = typeof artifact.srcDoc === "string" ? artifact.srcDoc : "";
  const title = String(artifact.title || "Artifact").trim() || "Artifact";
  const kind = String(artifact.kind || "artifact").trim() || "artifact";
  const chatId = activeChatId(opts?.chatId);

  if (!/^https?:\/\//i.test(url) && !html.trim()) return false;

  try {
    if (typeof lykn.studioOpenArtifact === "function") {
      if (chatId) markPendingBrowserChat(chatId);
      showStudioBrowserTab({
        url: url || undefined,
        title,
        openRail: true,
      });
      void Promise.resolve(
        lykn.studioOpenArtifact({
          url: /^https?:\/\//i.test(url) ? url : undefined,
          html: html.trim() || undefined,
          title,
          kind,
          chatId: chatId || undefined,
        }),
      )
        .then((res) => showOpenedTab(res, { url: url || undefined, title, chatId }))
        .catch(() => {});
      return true;
    }
    if (/^https?:\/\//i.test(url)) {
      return openInStudioBrowser(url, title, opts);
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Click handler for anchors that should stay inside LYKN.
 * preventDefault when the desktop bridge handled the navigation.
 */
export function handleLyknBrowserClick(
  e: { preventDefault: () => void; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; button?: number },
  url: string,
  title?: string,
  opts?: OpenInStudioBrowserOptions,
): boolean {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return false;
  if (!openInStudioBrowser(url, title, opts)) return false;
  e.preventDefault();
  return true;
}
