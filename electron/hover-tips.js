/**
 * Frosted hover description boxes for Electron chrome (overlay, agent-stage, panel).
 * Reads title / data-tip / aria-label on buttons — same language as StudioHoverTips.
 */
(function lyknHoverTips() {
  if (window.__lyknHoverTips) return;
  window.__lyknHoverTips = true;

  const SHOW_DELAY_MS = 420;
  const HIDE_DELAY_MS = 80;
  const MAX_WIDTH = 260;
  const GAP = 8;

  const tipEl = document.createElement("div");
  tipEl.className = "lykn-hover-tip";
  tipEl.setAttribute("role", "tooltip");
  tipEl.hidden = true;
  document.documentElement.appendChild(tipEl);

  let showTimer = null;
  let hideTimer = null;
  let activeEl = null;

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function visibleLabel(el) {
    const parts = [];
    const walk = (node) => {
      if (!node) return;
      if (node.nodeType === 3) {
        parts.push(node.textContent || "");
        return;
      }
      if (node.nodeType !== 1) return;
      if (node.getAttribute("aria-hidden") === "true") return;
      if (node.classList && node.classList.contains("sr-only")) return;
      for (const child of node.childNodes) walk(child);
    };
    walk(el);
    return normalizeText(parts.join(""));
  }

  function isRedundant(el, text) {
    const visible = visibleLabel(el);
    if (!visible) return false;
    if (visible === text) return true;
    if (visible.length >= 2 && text.length <= visible.length + 2 && visible.includes(text)) {
      return true;
    }
    if (visible.length >= 3 && (text.startsWith(visible + " ") || text.endsWith(" " + visible))) {
      return true;
    }
    return false;
  }

  function readTipText(el) {
    if (!el || el.nodeType !== 1 || el.hasAttribute("data-no-tip")) return "";
    const raw =
      el.getAttribute("data-tip") ||
      el.getAttribute("title") ||
      (el.matches("button, [role='button'], a, summary")
        ? el.getAttribute("aria-label")
        : null);
    return normalizeText(raw);
  }

  function findTipTarget(start) {
    let el = start;
    while (el && el !== document.documentElement) {
      if (el.nodeType === 1) {
        const text = readTipText(el);
        if (text) {
          stashNativeTitle(el);
          if (!isRedundant(el, text)) {
            return { el, text: readTipText(el) || text };
          }
        }
      }
      el = el.parentElement;
    }
    return null;
  }

  function stashNativeTitle(el) {
    if (!el?.hasAttribute?.("title")) return;
    const title = el.getAttribute("title");
    if (!title) return;
    if (!el.getAttribute("data-tip")) el.setAttribute("data-tip", title);
    el.removeAttribute("title");
  }

  function place(anchor) {
    const tipWidth = Math.min(tipEl.offsetWidth || 0, MAX_WIDTH);
    const tipHeight = tipEl.offsetHeight || 0;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = anchor.left + anchor.width / 2 - tipWidth / 2;
    left = Math.min(Math.max(GAP, left), vw - tipWidth - GAP);
    let top = anchor.bottom + GAP;
    let side = "bottom";
    if (top + tipHeight + GAP > vh) {
      top = anchor.top - tipHeight - GAP;
      side = "top";
    }
    if (top < GAP) {
      top = Math.min(anchor.bottom + GAP, vh - tipHeight - GAP);
      side = "bottom";
    }
    tipEl.style.left = `${left}px`;
    tipEl.style.top = `${top}px`;
    tipEl.dataset.side = side;
  }

  function hide() {
    if (showTimer) clearTimeout(showTimer);
    if (hideTimer) clearTimeout(hideTimer);
    showTimer = hideTimer = null;
    activeEl = null;
    tipEl.hidden = true;
    tipEl.textContent = "";
  }

  function showFor(hit) {
    stashNativeTitle(hit.el);
    activeEl = hit.el;
    tipEl.textContent = hit.text;
    tipEl.hidden = false;
    tipEl.style.maxWidth = `${MAX_WIDTH}px`;
    place(hit.el.getBoundingClientRect());
  }

  document.addEventListener(
    "pointerover",
    (e) => {
      const hit = findTipTarget(e.target);
      if (!hit) {
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = setTimeout(hide, HIDE_DELAY_MS);
        return;
      }
      if (activeEl === hit.el && !tipEl.hidden) {
        if (hideTimer) {
          clearTimeout(hideTimer);
          hideTimer = null;
        }
        return;
      }
      if (showTimer) clearTimeout(showTimer);
      if (hideTimer) clearTimeout(hideTimer);
      showTimer = setTimeout(() => showFor(hit), SHOW_DELAY_MS);
    },
    true
  );

  document.addEventListener("pointerdown", hide, true);
  document.addEventListener("scroll", hide, true);
  window.addEventListener("blur", hide);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hide();
  });
})();
