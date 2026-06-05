import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { modelBuilderMenuPanelClass } from "@/components/modelBuilder/modelBuilderMenuStyles";

/**
 * Fixed-position menu portaled to document.body so it isn't clipped by scroll areas.
 */
export default function ModelBuilderAnchoredMenu({
  open,
  anchorRef,
  onClose,
  children,
  className,
  maxHeight = 220,
}) {
  const panelRef = useRef(null);
  const [style, setStyle] = useState(null);

  useEffect(() => {
    if (!open || !anchorRef?.current) {
      setStyle(null);
      return;
    }

    const update = () => {
      const el = anchorRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const gap = 8;
      const spaceBelow = window.innerHeight - rect.bottom - gap;
      const spaceAbove = rect.top - gap;
      const openUp = spaceBelow < 140 && spaceAbove > spaceBelow;
      const available = openUp ? spaceAbove - 8 : spaceBelow - 8;
      const height = Math.min(maxHeight, Math.max(120, available));

      setStyle({
        position: "fixed",
        left: rect.left,
        width: rect.width,
        maxHeight: height,
        zIndex: 300,
        ...(openUp
          ? { bottom: window.innerHeight - rect.top + gap }
          : { top: rect.bottom + gap }),
      });
    };

    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, anchorRef, maxHeight]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => {
      if (anchorRef?.current?.contains(e.target)) return;
      if (panelRef.current?.contains(e.target)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open, anchorRef, onClose]);

  if (!open || !style) return null;

  return createPortal(
    <ul
      ref={panelRef}
      role="listbox"
      style={style}
      className={cn(modelBuilderMenuPanelClass, className)}
    >
      {children}
    </ul>,
    document.body,
  );
}
