/**
 * Place a chat-bar dropdown over its trigger. Menus have to sit as siblings of
 * the glass pill (an ancestor with backdrop-filter is a backdrop root, so a
 * nested popover would render flat), so left/bottom are measured from the
 * wrapper rather than the button.
 *
 * Slate is a two-row shell — the triggers live on the bottom row — so "above
 * the bar" is the wrong box; this sits 8px above the control itself.
 */
export function barMenuOffset(wrapEl, triggerEl, panelEl) {
  if (!wrapEl || !triggerEl) return {};
  const wrap = wrapEl.getBoundingClientRect();
  const trig = triggerEl.getBoundingClientRect();
  const menuWidth = panelEl?.offsetWidth || 208;
  const left = trig.left - wrap.left;
  const maxLeft = Math.max(0, wrap.width - menuWidth);
  return {
    left: Math.min(Math.max(0, left), maxLeft),
    bottom: wrap.bottom - trig.top + 8,
  };
}
