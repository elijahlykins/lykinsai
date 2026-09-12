/**
 * Drag the Glass overlay by the glass card / collapsed bubble.
 *
 * macOS panel windows synthesize pointercancel / pointerup / mouseup as soon
 * as the HWND moves under the cursor. Ending the gesture on those events made
 * the bar look glued in place. Main follows the OS cursor from moveStart
 * until moveEnd; this file only owns the gesture.
 */

const CLICK_SLOP = 3;
const BUTTON_UP_GRACE_MS = 200;
const SPURIOUS_UP_MS = 80;

export const OVERLAY_DRAG_IGNORE =
  "button, textarea, input, a, select, #ask, .dot, .chat-q, .chat-a, .chat-a-actions, .attachments, .slash-path-menu, .prompt-queue, .mode-pill, .lang-pill, .more-drawer, .menu, .history-panel, .night-brief-close";

function overlayApi(api) {
  return api || (typeof window !== "undefined" ? window.lyknOverlay : null);
}

function eventRoot(root) {
  return root || (typeof window !== "undefined" ? window : null);
}

export function attachOverlayDrag({
  api,
  root,
  buttonUpGraceMs = BUTTON_UP_GRACE_MS,
  spuriousUpMs = SPURIOUS_UP_MS,
} = {}) {
  const enders = new Set();
  let overlayDragActive = false;

  function bind(el, { ignoreTarget, onClick, dragClass } = {}) {
    if (!el) return;
    let dragging = false;
    let moved = false;
    let pointerId = null;
    let startX = 0;
    let startY = 0;
    let lastX = 0;
    let lastY = 0;
    let pendingDx = 0;
    let pendingDy = 0;
    let raf = 0;
    let buttonUpAt = 0;
    let becameMovedAt = 0;
    let useCursorFollow = false;

    const lykn = () => overlayApi(api);

    const flushFallback = () => {
      raf = 0;
      if (!pendingDx && !pendingDy) return;
      const dx = pendingDx;
      const dy = pendingDy;
      pendingDx = 0;
      pendingDy = 0;
      try {
        lykn()?.moveBy?.(dx, dy);
      } catch (_) {
        /* older preload */
      }
    };

    const beginFollow = () => {
      const bridge = lykn();
      useCursorFollow = typeof bridge?.moveStart === "function";
      try {
        if (useCursorFollow) bridge.moveStart();
        else useCursorFollow = false;
      } catch (_) {
        useCursorFollow = false;
      }
    };

    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      overlayDragActive = false;
      const id = e && e.pointerId != null ? e.pointerId : pointerId;
      pointerId = null;
      buttonUpAt = 0;
      becameMovedAt = 0;
      if (dragClass) el.classList.remove(dragClass);
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      if (!useCursorFollow && (pendingDx || pendingDy)) flushFallback();
      try {
        if (id != null) el.releasePointerCapture(id);
      } catch (_) {
        /* already released */
      }
      try {
        lykn()?.moveEnd?.();
      } catch (_) {
        /* older preload */
      }
      if (onClick && !moved) onClick();
      moved = false;
      useCursorFollow = false;
    };

    const recapture = (e) => {
      if (!dragging) return;
      try {
        const id = e && e.pointerId != null ? e.pointerId : pointerId;
        if (id != null) el.setPointerCapture(id);
      } catch (_) {
        /* capture optional */
      }
    };

    enders.add(end);

    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (ignoreTarget && ignoreTarget(e.target)) return;
      if (dragging) end(e);
      dragging = true;
      overlayDragActive = true;
      moved = false;
      pointerId = e.pointerId;
      startX = e.screenX;
      startY = e.screenY;
      lastX = e.screenX;
      lastY = e.screenY;
      pendingDx = 0;
      pendingDy = 0;
      buttonUpAt = 0;
      becameMovedAt = 0;
      useCursorFollow = false;
      if (dragClass) el.classList.add(dragClass);
      try {
        el.setPointerCapture(e.pointerId);
      } catch (_) {
        /* capture optional */
      }
      if (typeof e.preventDefault === "function") e.preventDefault();
    });

    const onMove = (e) => {
      if (!dragging) return;
      if (pointerId != null && e.pointerId != null && e.pointerId !== pointerId) return;
      if ((e.buttons & 1) === 0) {
        const now = Date.now();
        if (!buttonUpAt) buttonUpAt = now;
        if (moved && now - buttonUpAt >= buttonUpGraceMs) {
          end(e);
          return;
        }
      } else {
        buttonUpAt = 0;
      }
      const travel = Math.abs(e.screenX - startX) + Math.abs(e.screenY - startY);
      if (!moved && travel >= CLICK_SLOP) {
        moved = true;
        becameMovedAt = Date.now();
        beginFollow();
      }
      if (!moved) return;
      if (useCursorFollow) return;
      const dx = e.screenX - lastX;
      const dy = e.screenY - lastY;
      if (!dx && !dy) return;
      lastX = e.screenX;
      lastY = e.screenY;
      pendingDx += dx;
      pendingDy += dy;
      if (!raf) raf = requestAnimationFrame(flushFallback);
    };

    const onUp = (e) => {
      if (!dragging) return;
      if (e && e.button != null && e.button !== 0) return;
      if (!moved) {
        end(e);
        return;
      }
      // setBounds on a panel window often synthesizes pointerup on the first
      // frame the HWND moves. Ignore that ghost; the real release comes later.
      if (becameMovedAt && Date.now() - becameMovedAt < spuriousUpMs) return;
      end(e);
    };

    const target = eventRoot(root);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", recapture);
    el.addEventListener("lostpointercapture", recapture);
    if (target) {
      target.addEventListener("pointermove", onMove, true);
      target.addEventListener("pointerup", onUp, true);
    }
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        if (document.hidden) end();
      });
    }
  }

  return {
    get active() {
      return overlayDragActive;
    },
    bind,
    cancel() {
      for (const end of enders) {
        try {
          end();
        } catch (_) {
          /* ignore */
        }
      }
    },
  };
}
