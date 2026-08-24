import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Shared right-click menu for every icon in the Studio dock.
 *
 * Same glass as the rest of the chrome (`lg-menu`), hanging above the icon
 * the way a macOS Dock menu does. Callers pass a list of rows; this owns
 * outside-click / Escape dismiss so each strip doesn't reimplement it.
 *
 * Portaled to <body>: the dock pill's own backdrop-filter makes it a CSS
 * "backdrop root", so a descendant's backdrop-filter could only sample the
 * pill's painted box — and this menu hangs above the pill, over nothing it
 * may read, which rendered the glass as bare see-through tint. Rendering at
 * the body (the same escape AppIconPicker gets from Radix's portal) lets the
 * menu blur the actual desktop behind it. The in-place <span> is only the
 * measuring anchor: its parent is the icon wrapper the menu aligns to.
 */

const PANEL = "lg-menu fixed z-50 min-w-[11rem] p-1";
const GAP_PX = 8; // was mb-2 against the icon wrapper

export function DockContextMenu({ open, onClose, align = "center", items = [] }) {
  const ref = useRef(null);
  const anchorRef = useRef(null);
  const [pos, setPos] = useState(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Measure the icon wrapper (the anchor span's parent) each time the menu
  // opens. The dock is fixed chrome, so the rect stays valid while open.
  useLayoutEffect(() => {
    if (!open) return;
    const rect = anchorRef.current?.parentElement?.getBoundingClientRect();
    if (!rect) return;
    const bottom = window.innerHeight - rect.top + GAP_PX;
    if (align === "start") {
      setPos({ bottom, left: rect.left, transform: "none" });
    } else if (align === "end") {
      setPos({ bottom, left: rect.right, transform: "translateX(-100%)" });
    } else {
      setPos({ bottom, left: rect.left + rect.width / 2, transform: "translateX(-50%)" });
    }
  }, [open, align]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onCloseRef.current?.();
    };
    const onKey = (e) => {
      if (e.key === "Escape") onCloseRef.current?.();
    };
    const onBlur = () => onCloseRef.current?.();
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onBlur);
    };
  }, [open]);

  return (
    <>
      <span ref={anchorRef} hidden aria-hidden="true" />
      {open && pos
        ? createPortal(
            <div
              ref={ref}
              role="menu"
              className={PANEL}
              style={{ bottom: pos.bottom, left: pos.left, transform: pos.transform }}
            >
              {items.map((row, i) =>
                row?.separator ? (
                  <div
                    key={`sep-${i}`}
                    className="mx-1.5 my-1 h-px bg-black/[0.08] dark:bg-white/[0.1]"
                  />
                ) : (
                  <button
                    key={row.label}
                    type="button"
                    role="menuitem"
                    disabled={row.disabled}
                    onClick={() => {
                      onClose?.();
                      row.onClick?.();
                    }}
                    className={`lg-menu-row block w-full rounded-[0.5rem] px-2.5 py-[0.35rem] text-left text-[12px] ${
                      row.danger
                        ? "text-red-600 dark:text-red-400"
                        : "text-black/80 dark:text-white/85"
                    } ${row.disabled ? "cursor-default opacity-40" : ""}`}
                  >
                    {row.label}
                  </button>
                ),
              )}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

/** Surface Home chat. Optional prompt lands in the composer, unsent. */
export function openLyknChat(prompt) {
  const text = String(prompt || "").trim();
  if (text) {
    window.dispatchEvent(
      new CustomEvent("lykn-home-compose-insert", { detail: { text } }),
    );
  }
  window.dispatchEvent(new CustomEvent("lykn-studio-open-chat"));
}
