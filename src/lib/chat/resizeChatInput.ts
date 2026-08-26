// Auto-grow chat composer textarea: grows with content between a per-element
// min height (data-min-h, default 36px) and 180px, then scrolls. Single
// shared implementation for useChatEngine and LyknChatComposer, which
// previously each carried an identical copy (deduped in chat engine
// decomposition Wave 1, see docs/REFACTOR_LOG.md).
export function resizeChatInputEl(el: HTMLTextAreaElement | null) {
  if (!el) return;
  const maxH = 180;
  el.style.height = "auto";
  const minH = el.dataset.minH ? Number(el.dataset.minH) : 36;
  const nextH = Math.min(maxH, Math.max(minH, el.scrollHeight));
  el.style.height = `${nextH}px`;
  el.style.overflowY = el.scrollHeight > maxH ? "auto" : "hidden";
}
