/**
 * Which chats have a Build-workspace project — the continuity half of the
 * build-surface decision.
 *
 * A chat that built in the workspace must STAY a workspace chat: "add a
 * level", "fix the bug", "install it" the next morning all belong to the same
 * on-disk project, even when the composer chip is no longer create:webapp
 * (sticky-session demotion, a reload, or the user typing from Chat view).
 * Without this memory the buildWorkspace flag flapped per turn and follow-ups
 * silently fell back to the in-chat artifact pipeline — the visible symptom
 * was the AI "switching" build surfaces mid-project.
 *
 * localStorage-backed so it survives reloads, newest-last with a cap so it
 * can never grow unbounded.
 */

const STORAGE_KEY = "lykn_workspace_build_chats";
const MAX_CHATS = 200;

function storage(): Storage | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function readIds(): string[] {
  const store = storage();
  if (!store) return [];
  try {
    const parsed = JSON.parse(store.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string" && !!id)
      : [];
  } catch {
    return [];
  }
}

/** Remember that this chat builds in the workspace. Idempotent. */
export function markWorkspaceChat(chatId: string): void {
  const id = String(chatId || "").trim();
  const store = storage();
  if (!id || !store) return;
  const ids = readIds().filter((x) => x !== id);
  ids.push(id);
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(ids.slice(-MAX_CHATS)));
  } catch {
    /* quota or private mode — continuity degrades to per-session */
  }
}

/** True when this chat has built in the workspace before. */
export function isWorkspaceChat(chatId: string): boolean {
  const id = String(chatId || "").trim();
  if (!id) return false;
  return readIds().includes(id);
}
