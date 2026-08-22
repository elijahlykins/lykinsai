import { useEffect, useRef } from "react";

/**
 * Shared right-click menu for every icon in the Studio dock.
 *
 * Same glass as the rest of the chrome (`lg-menu`), hanging above the icon
 * the way a macOS Dock menu does. Callers pass a list of rows; this owns
 * outside-click / Escape dismiss so each strip doesn't reimplement it.
 */

const PANEL =
  "lg-menu absolute bottom-full z-50 mb-2 min-w-[11rem] p-1";

function alignClass(align) {
  if (align === "start") return "left-0";
  if (align === "end") return "right-0";
  return "left-1/2 -translate-x-1/2";
}

export function DockContextMenu({ open, onClose, align = "center", items = [] }) {
  const ref = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onCloseRef.current?.();
    };
    const onKey = (e) => {
      if (e.key === "Escape") onCloseRef.current?.();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!open) return null;

  return (
    <div ref={ref} role="menu" className={`${PANEL} ${alignClass(align)}`}>
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
    </div>
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
