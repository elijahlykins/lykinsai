import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const SHOW_DELAY_MS = 420;
const HIDE_DELAY_MS = 80;
const MAX_WIDTH = 260;
const GAP = 8;

function normalizeText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function visibleLabel(el) {
  if (!el) return "";
  const parts = [];
  const walk = (node) => {
    if (!node) return;
    if (node.nodeType === 3) {
      parts.push(node.textContent || "");
      return;
    }
    if (node.nodeType !== 1) return;
    if (node.getAttribute("aria-hidden") === "true") return;
    if (node.classList?.contains("sr-only")) return;
    for (const child of node.childNodes) walk(child);
  };
  walk(el);
  return normalizeText(parts.join(""));
}

function isRedundant(el, text) {
  const visible = visibleLabel(el);
  if (!visible) return false;
  if (visible === text) return true;
  // Labeled dock / pill buttons already spell out their job.
  if (visible.length >= 2 && text.length <= visible.length + 2 && visible.includes(text)) {
    return true;
  }
  // "Glass" button + "Glass theme" tip — visible word already carries the meaning.
  if (visible.length >= 3 && (text.startsWith(`${visible} `) || text.endsWith(` ${visible}`))) {
    return true;
  }
  return false;
}

function readTipText(el) {
  if (!el || el.nodeType !== 1) return "";
  if (el.hasAttribute("data-no-tip")) return "";
  const raw =
    el.getAttribute("data-tip") ||
    el.getAttribute("title") ||
    (el.matches("button, [role='button'], a, summary")
      ? el.getAttribute("aria-label")
      : null);
  return normalizeText(raw);
}

function findTipTarget(start, root) {
  let el = start;
  while (el && el !== root) {
    if (el.nodeType === 1) {
      const text = readTipText(el);
      if (text) {
        // Still strip native title so OS bubbles don't appear on labeled controls.
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
  if (!el.getAttribute("data-tip")) {
    el.setAttribute("data-tip", title);
  }
  // Drop native OS tooltip so it doesn't fight the glass bubble.
  el.removeAttribute("title");
}

function placeTip(anchorRect, tipWidth, tipHeight) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = anchorRect.left + anchorRect.width / 2 - tipWidth / 2;
  left = Math.min(Math.max(GAP, left), vw - tipWidth - GAP);

  let top = anchorRect.bottom + GAP;
  let side = "bottom";
  if (top + tipHeight + GAP > vh) {
    top = anchorRect.top - tipHeight - GAP;
    side = "top";
  }
  if (top < GAP) {
    top = Math.min(anchorRect.bottom + GAP, vh - tipHeight - GAP);
    side = "bottom";
  }
  return { left, top, side };
}

/**
 * Studio-wide frosted description boxes for icon controls.
 * Uses existing title / aria-label / data-tip copy — no per-button wrappers.
 */
export default function StudioHoverTips({ rootRef }) {
  const [tip, setTip] = useState(null);
  const showTimer = useRef(null);
  const hideTimer = useRef(null);
  const activeEl = useRef(null);
  const tipVisible = useRef(false);
  const tipRef = useRef(null);

  useEffect(() => {
    const root = rootRef?.current || document.body;

    const clearTimers = () => {
      if (showTimer.current) {
        clearTimeout(showTimer.current);
        showTimer.current = null;
      }
      if (hideTimer.current) {
        clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
    };

    const hide = () => {
      clearTimers();
      activeEl.current = null;
      tipVisible.current = false;
      setTip(null);
    };

    const scheduleHide = () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(hide, HIDE_DELAY_MS);
    };

    const showFor = (hit) => {
      stashNativeTitle(hit.el);
      activeEl.current = hit.el;
      tipVisible.current = true;
      const rect = hit.el.getBoundingClientRect();
      // Provisional placement; refined after measure.
      setTip({
        text: hit.text,
        left: rect.left,
        top: rect.bottom + GAP,
        side: "bottom",
        anchor: {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          right: rect.right,
          bottom: rect.bottom,
        },
      });
    };

    const onPointerOver = (e) => {
      const hit = findTipTarget(e.target, root);
      if (!hit) {
        scheduleHide();
        return;
      }
      if (activeEl.current === hit.el && tipVisible.current) {
        if (hideTimer.current) {
          clearTimeout(hideTimer.current);
          hideTimer.current = null;
        }
        return;
      }
      clearTimers();
      if (activeEl.current && activeEl.current !== hit.el) {
        tipVisible.current = false;
        setTip(null);
      }
      showTimer.current = setTimeout(() => showFor(hit), SHOW_DELAY_MS);
    };

    const onPointerDown = () => hide();
    const onScroll = () => hide();
    const onKeyDown = (e) => {
      if (e.key === "Escape") hide();
    };
    const onBlur = () => hide();

    root.addEventListener("pointerover", onPointerOver);
    root.addEventListener("pointerdown", onPointerDown, true);
    root.addEventListener("scroll", onScroll, true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onBlur);

    return () => {
      clearTimers();
      root.removeEventListener("pointerover", onPointerOver);
      root.removeEventListener("pointerdown", onPointerDown, true);
      root.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onBlur);
    };
  }, [rootRef]);

  // After mount / text change, measure and clamp into the viewport.
  useEffect(() => {
    if (!tip || !tipRef.current) return;
    const node = tipRef.current;
    const tipWidth = Math.min(node.offsetWidth || 0, MAX_WIDTH);
    const tipHeight = node.offsetHeight || 0;
    const next = placeTip(tip.anchor, tipWidth, tipHeight);
    if (
      Math.abs(next.left - tip.left) > 0.5 ||
      Math.abs(next.top - tip.top) > 0.5 ||
      next.side !== tip.side
    ) {
      setTip((prev) => (prev ? { ...prev, ...next } : prev));
    }
  }, [tip]);

  if (!tip) return null;

  return createPortal(
    <div
      ref={tipRef}
      role="tooltip"
      data-side={tip.side}
      className="lykn-hover-tip"
      style={{
        left: tip.left,
        top: tip.top,
        maxWidth: MAX_WIDTH,
      }}
    >
      {tip.text}
    </div>,
    document.body
  );
}
