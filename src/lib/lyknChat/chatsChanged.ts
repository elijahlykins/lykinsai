/**
 * Cross-document "chat list changed" signal.
 *
 * The Studio glass window embeds the chat as a same-origin iframe, so a plain
 * window event dispatched from the chat document never reaches the Studio's
 * sidebar rail (a different document). `notifyLyknChatsChanged` therefore
 * dispatches the legacy same-window event AND bumps a localStorage ping key —
 * writing localStorage fires a `storage` event in every OTHER same-origin
 * document (parent shell, other windows/tabs), so all chat lists stay in sync
 * no matter which surface saved the chat.
 */
export const LYKN_CHATS_CHANGED_EVENT = "lykinsai_chats_changed";
const LS_PING_KEY = "lykn_chats_changed_ping";

export function notifyLyknChatsChanged(): void {
  try {
    window.dispatchEvent(new Event(LYKN_CHATS_CHANGED_EVENT));
  } catch {
    /* non-browser context */
  }
  try {
    localStorage.setItem(LS_PING_KEY, String(Date.now()));
  } catch {
    /* private mode / storage full — same-window event already fired */
  }
}

/** Subscribe to chat-list changes from THIS document and any same-origin
 *  sibling document (embedded chat iframe, other windows). Returns an
 *  unsubscribe function. */
export function subscribeLyknChatsChanged(cb: () => void): () => void {
  const onLocal = () => cb();
  const onStorage = (e: StorageEvent) => {
    if (e.key === LS_PING_KEY) cb();
  };
  window.addEventListener(LYKN_CHATS_CHANGED_EVENT, onLocal);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(LYKN_CHATS_CHANGED_EVENT, onLocal);
    window.removeEventListener("storage", onStorage);
  };
}
