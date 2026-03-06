import React, { memo, useMemo, useRef } from "react";
import { useCanvasStore } from "@/store/canvasStore";
import { snapToGrid } from "@/canvas/utils/snap";

type DragState = {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  originX: number;
  originY: number;
  raf: number | null;
  lastX: number;
  lastY: number;
  capturer: HTMLElement | null;
  snapshot: Array<{ id: string; x: number; y: number }>;
};

type PendingDragState = {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  originX: number;
  originY: number;
  capturer: HTMLElement;
  snapshot: Array<{ id: string; x: number; y: number }>;
};

type ResizeMode = "right" | "top" | "bottom" | "corner";

type ResizeState = {
  pointerId: number;
  mode: ResizeMode;
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
  startW: number;
  startH: number;
  aspect: number;
  maxW?: number;
  maxH?: number;
  cornerAxis?: "x" | "y";
  raf: number | null;
  capturer: HTMLElement | null;
};

export const ImageBlock = memo(function ImageBlock({ id }: { id: string }) {
  const block = useCanvasStore((s) => s.blocks[id]);
  const allBlocks = useCanvasStore((s) => s.blocks);
  const canvasWidth = useCanvasStore((s) => s.canvasWidth);
  const bringToFront = useCanvasStore((s) => s.bringToFront);
  const selectBlocks = useCanvasStore((s) => s.selectBlocks);
  const toggleSelect = useCanvasStore((s) => s.toggleSelect);
  const isSelected = useCanvasStore((s) => s.selectedIds.includes(id));
  const gridSize = useCanvasStore((s) => s.gridSize);
  const updateBlock = useCanvasStore((s) => s.updateBlock);
  const moveBlocksFromSnapshot = useCanvasStore((s) => s.moveBlocksFromSnapshot);
  const pushHistory = useCanvasStore((s) => s.pushHistory);

  const dragRef = useRef<DragState | null>(null);
  const pendingDragRef = useRef<PendingDragState | null>(null);
  const endDragCleanupRef = useRef<(() => void) | null>(null);
  const activeDragPointerIdRef = useRef<number | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);
  const endResizeCleanupRef = useRef<(() => void) | null>(null);
  const naturalAspectRef = useRef<number | null>(null);

  const style = useMemo(() => {
    if (!block) return null;
    if (block.type === "create" && ((block as any).mode === "image" || (block as any).mode === "generated")) {
      return {
        position: "absolute" as const,
        left: `${block.x}px`,
        top: `${block.y}px`,
        width: `${block.width}px`,
        height: `${block.height}px`,
        overflow: "visible",
      };
    }
    return {
      position: "absolute" as const,
      left: `${block.x}px`,
      top: `${block.y}px`,
      width: `${block.width}px`,
      height: `${block.height}px`,
      overflow: "visible",
    };
  }, [block]);

  if (!block || !style) return null;
  const isCreate = block.type === "create";
  const src = isCreate ? String((block as any).data?.src || "") : (block as any).src;
  if (!src) return null;

  const snapSize = (n: number) => {
    const g = Math.max(1, Math.floor(gridSize || 24));
    return Math.max(g, snapToGrid(n, g));
  };
  const snapDownSize = (n: number) => {
    const g = Math.max(1, Math.floor(gridSize || 24));
    if (!Number.isFinite(n as any)) return Number.POSITIVE_INFINITY;
    return Math.max(g, Math.floor(Number(n) / g) * g);
  };

  const endDrag = (pointerId: number) => {
    const activeId = activeDragPointerIdRef.current;
    const d = dragRef.current;
    const isThisDrag = (activeId != null && activeId === pointerId) || (d != null && d.pointerId === pointerId);
    if (!isThisDrag) return;

    if (d?.raf != null) window.cancelAnimationFrame(d.raf);
    if (endDragCleanupRef.current) {
      try {
        endDragCleanupRef.current();
      } catch {
        // ignore
      }
      endDragCleanupRef.current = null;
    }
    if (d?.capturer) {
      try {
        d.capturer.releasePointerCapture(pointerId);
      } catch {
        // ignore
      }
    }
    dragRef.current = null;
    activeDragPointerIdRef.current = null;
  };

  const endResize = (pointerId: number) => {
    const r = resizeRef.current;
    if (!r || r.pointerId !== pointerId) return;
    if (r.raf != null) window.cancelAnimationFrame(r.raf);
    if (endResizeCleanupRef.current) {
      try {
        endResizeCleanupRef.current();
      } catch {
        // ignore
      }
      endResizeCleanupRef.current = null;
    }
    if (r.capturer) {
      try {
        r.capturer.releasePointerCapture(pointerId);
      } catch {
        // ignore
      }
    }
    resizeRef.current = null;
  };

  const installGlobalResizeEndHandlers = (pointerId: number) => {
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      endResize(pointerId);
    };
    const onCancel = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      endResize(pointerId);
    };
    const onBlur = () => endResize(pointerId);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onCancel, true);
    window.addEventListener("blur", onBlur, true);
    endResizeCleanupRef.current = () => {
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onCancel, true);
      window.removeEventListener("blur", onBlur, true);
    };
  };

  const beginResize = (e: React.PointerEvent, mode: ResizeMode) => {
    e.stopPropagation();
    e.preventDefault();
    // Resizing should win over dragging.
    pendingDragRef.current = null;
    dragRef.current = null;

    bringToFront(id);
    pushHistory();

    const capturer = e.currentTarget as HTMLElement;
    // IMPORTANT:
    // - Corner scaling should preserve the *current* displayed aspect ratio, not snap back to the image's natural ratio.
    //   (Users may intentionally stretch first.)
    // - Natural aspect is still captured for future use, but not forced here.
    const aspect = Math.max(0.01, (block.width || 1) / Math.max(1, block.height || 1));
    let maxW = Number.POSITIVE_INFINITY;
    let maxH = Number.POSITIVE_INFINITY;
    const containerId = String((block as any)?.containerId || "");
    if (containerId) {
      const container: any = (allBlocks as any)?.[containerId];
      if (container && String(container.type || "") === "create") {
        const cRight = Number(container.x || 0) + Number(container.width || 0);
        const cBottom = Number(container.y || 0) + Number(container.height || 0);
        maxW = Math.max(gridSize, cRight - Number(block.x || 0));
        maxH = Math.max(gridSize, cBottom - Number(block.y || 0));
      }
    } else if (Number.isFinite(canvasWidth as any) && Number(canvasWidth) > 0) {
      maxW = Math.max(gridSize, Number(canvasWidth) - Number(block.x || 0));
    }

    resizeRef.current = {
      pointerId: e.pointerId,
      mode,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startX: block.x,
      startY: block.y,
      startW: block.width,
      startH: block.height,
      aspect,
      maxW,
      maxH,
      raf: null,
      capturer,
    };

    installGlobalResizeEndHandlers(e.pointerId);
    try {
      capturer.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  const installGlobalDragEndHandlers = (pointerId: number) => {
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      endDrag(pointerId);
    };
    const onCancel = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      endDrag(pointerId);
    };
    const onBlur = () => endDrag(pointerId);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onCancel, true);
    window.addEventListener("blur", onBlur, true);
    endDragCleanupRef.current = () => {
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onCancel, true);
      window.removeEventListener("blur", onBlur, true);
    };
  };

  const startDragFromPending = (pointerId: number) => {
    const p = pendingDragRef.current;
    if (!p || p.pointerId !== pointerId) return;

    bringToFront(id);
    pushHistory();

    activeDragPointerIdRef.current = pointerId;
    dragRef.current = {
      pointerId,
      startClientX: p.startClientX,
      startClientY: p.startClientY,
      originX: p.originX,
      originY: p.originY,
      raf: null,
      lastX: p.originX,
      lastY: p.originY,
      capturer: p.capturer,
      snapshot: p.snapshot,
    };
    pendingDragRef.current = null;
    installGlobalDragEndHandlers(pointerId);
    try {
      p.capturer.setPointerCapture(pointerId);
    } catch {
      // ignore
    }
  };

  return (
    <div
      data-canvas-block
      data-block-id={id}
      className="absolute group"
      style={style}
      onPointerDownCapture={(e) => {
        if (dragRef.current) return;
        if (e.button !== 0) return;
        const t = e.target as Element | null;
        if (t?.closest?.("[data-drag-handle]")) return;

        if (e.shiftKey) toggleSelect(id);
        else if (!isSelected) selectBlocks([id]);

        const state = useCanvasStore.getState();
        const sel = state.selectedIds;
        const idsForDrag = sel.includes(id) && sel.length > 1 ? sel : [id];
        const snapshot = idsForDrag.map((bid) => {
          const b = state.blocks[bid];
          return { id: bid, x: Number(b?.x) || 0, y: Number(b?.y) || 0 };
        });

        pendingDragRef.current = {
          pointerId: e.pointerId,
          startClientX: e.clientX,
          startClientY: e.clientY,
          originX: block.x,
          originY: block.y,
          capturer: e.currentTarget as HTMLElement,
          snapshot,
        };
      }}
      onPointerDown={(e) => {
        e.stopPropagation();
        bringToFront(id);
        // Selection is handled in onPointerDownCapture to avoid double-toggling.
      }}
      onPointerMove={(e) => {
        const r = resizeRef.current;
        if (r && r.pointerId === e.pointerId) {
          // Fail-safe: if the browser misses pointerup, stop on mouse button release.
          if (e.pointerType === "mouse" && e.buttons === 0) {
            endResize(e.pointerId);
            return;
          }
          const dx = e.clientX - r.startClientX;
          const dy = e.clientY - r.startClientY;
          if (r.raf != null) return;
          r.raf = window.requestAnimationFrame(() => {
            const rr = resizeRef.current;
            if (!rr) return;
            rr.raf = null;

            const min = Math.max(1, Math.floor(gridSize || 24));
            const bottom = rr.startY + rr.startH;
            const maxW = snapDownSize(rr.maxW ?? Number.POSITIVE_INFINITY);
            const maxH = snapDownSize(rr.maxH ?? Number.POSITIVE_INFINITY);

            if (rr.mode === "right") {
              let nextW = snapSize(rr.startW + dx);
              if (Number.isFinite(maxW)) nextW = Math.min(nextW, maxW);
              updateBlock(id, {
                x: rr.startX,
                y: rr.startY,
                width: Math.max(min, nextW),
              });
              return;
            }

            if (rr.mode === "top") {
              const nextH = snapSize(rr.startH - dy);
              const nextY = snapToGrid(bottom - nextH, min);
              updateBlock(id, { y: nextY, height: Math.max(min, nextH) });
              return;
            }

            if (rr.mode === "bottom") {
              let nextH = snapSize(rr.startH + dy);
              if (Number.isFinite(maxH)) nextH = Math.min(nextH, maxH);
              updateBlock(id, {
                x: rr.startX,
                y: rr.startY,
                height: Math.max(min, nextH),
              });
              return;
            }

            // corner scale: keep aspect ratio (simple + modern)
            // Avoid "glitch" when dragging diagonally by latching the dominant axis
            // once the user has moved a bit (prevents x/y flip-flopping).
            if (!rr.cornerAxis && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
              rr.cornerAxis = Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
            }
            const axis = rr.cornerAxis ?? (Math.abs(dx) >= Math.abs(dy) ? "x" : "y");
            const rawW = axis === "x" ? rr.startW + dx : (rr.startH + dy) * rr.aspect;
            let nextW = snapSize(rawW);
            if (Number.isFinite(maxW)) nextW = Math.min(nextW, maxW);
            let nextH = snapSize(nextW / rr.aspect);
            if (Number.isFinite(maxH) && nextH > maxH) {
              nextH = maxH;
              nextW = snapSize(nextH * rr.aspect);
            }
            if (Number.isFinite(maxW) && nextW > maxW) {
              nextW = maxW;
              nextH = snapSize(nextW / rr.aspect);
            }
            updateBlock(id, {
              x: rr.startX,
              y: rr.startY,
              width: Math.max(min, nextW),
              height: Math.max(min, nextH),
            });
          });
          return;
        }

        const p = pendingDragRef.current;
        if (!dragRef.current && p && p.pointerId === e.pointerId) {
          const dx = e.clientX - p.startClientX;
          const dy = e.clientY - p.startClientY;
          if (dx * dx + dy * dy > 36) startDragFromPending(e.pointerId);
        }

        const d = dragRef.current;
        if (!d || d.pointerId !== e.pointerId) return;
        if (e.pointerType === "mouse" && e.buttons === 0) {
          endDrag(e.pointerId);
          return;
        }
        const dx = e.clientX - d.startClientX;
        const dy = e.clientY - d.startClientY;
        d.lastX = d.originX + dx;
        d.lastY = d.originY + dy;
        if (d.raf != null) return;
        d.raf = window.requestAnimationFrame(() => {
          const d2 = dragRef.current;
          if (!d2) return;
          d2.raf = null;
          const dx2 = d2.lastX - d2.originX;
          const dy2 = d2.lastY - d2.originY;
          moveBlocksFromSnapshot(d2.snapshot, dx2, dy2, { snap: true });
        });
      }}
      onPointerUp={(e) => {
        endResize(e.pointerId);
        if (pendingDragRef.current?.pointerId === e.pointerId) pendingDragRef.current = null;
        endDrag(e.pointerId);
      }}
      onPointerCancel={(e) => {
        endResize(e.pointerId);
        if (pendingDragRef.current?.pointerId === e.pointerId) pendingDragRef.current = null;
        endDrag(e.pointerId);
      }}
      onLostPointerCapture={(e) => {
        endResize(e.pointerId);
        if (pendingDragRef.current?.pointerId === e.pointerId) pendingDragRef.current = null;
        endDrag(e.pointerId);
      }}
    >
      {/* Optional tiny drag strip for parity */}
      <div
        data-drag-handle
        className="absolute inset-x-0 top-0 h-3 z-30 cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity"
        onPointerDown={(e) => {
          e.stopPropagation();
          e.preventDefault();

          // If a resize is in progress, ignore.
          if (resizeRef.current) return;

          bringToFront(id);
          if (e.shiftKey) toggleSelect(id);
          else if (!isSelected) selectBlocks([id]);
          pushHistory();

          const state = useCanvasStore.getState();
          const sel = state.selectedIds;
          const idsForDrag = sel.includes(id) && sel.length > 1 ? sel : [id];
          const snapshot = idsForDrag.map((bid) => {
            const b = state.blocks[bid];
            return { id: bid, x: Number(b?.x) || 0, y: Number(b?.y) || 0 };
          });

          const capturer = e.currentTarget as HTMLElement;
          activeDragPointerIdRef.current = e.pointerId;
          pendingDragRef.current = null;
          dragRef.current = {
            pointerId: e.pointerId,
            startClientX: e.clientX,
            startClientY: e.clientY,
            originX: block.x,
            originY: block.y,
            raf: null,
            lastX: block.x,
            lastY: block.y,
            capturer,
            snapshot,
          };

          installGlobalDragEndHandlers(e.pointerId);
          try {
            capturer.setPointerCapture(e.pointerId);
          } catch {
            // ignore
          }
        }}
        onPointerUp={(e) => {
          endDrag(e.pointerId);
        }}
        onPointerCancel={(e) => {
          endDrag(e.pointerId);
        }}
        onLostPointerCapture={(e) => {
          endDrag(e.pointerId);
        }}
        title="Drag to move"
      />

      <div className={`glass-block overflow-hidden ${isSelected ? "omnia-selected-glass" : ""}`} style={{ width: "100%", height: "100%" }}>
        <img
          src={src}
          alt=""
          className="w-full h-full object-cover select-none pointer-events-none"
          draggable={false}
          onLoad={(e) => {
            const img = e.currentTarget;
            const w = Number(img.naturalWidth) || 0;
            const h = Number(img.naturalHeight) || 0;
            if (w > 0 && h > 0) naturalAspectRef.current = w / h;
          }}
        />
      </div>

      {/* Resize handles (simple + modern) */}
      <div className="absolute inset-0 pointer-events-none">
        {/* Right edge stretch */}
        <div
          className="absolute top-0 bottom-0 right-0 w-2 pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ cursor: "ew-resize" }}
          onPointerDown={(e) => beginResize(e, "right")}
          title="Resize width"
        />
        {/* Top edge stretch */}
        <div
          className="absolute left-0 right-0 top-0 h-2 pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ cursor: "ns-resize" }}
          onPointerDown={(e) => beginResize(e, "top")}
          title="Resize height"
        />
        {/* Bottom edge stretch */}
        <div
          className="absolute left-0 right-0 bottom-0 h-2 pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ cursor: "ns-resize" }}
          onPointerDown={(e) => beginResize(e, "bottom")}
          title="Resize height"
        />
        {/* Bottom-right corner scale */}
        <div
          className="absolute right-0 bottom-0 w-4 h-4 pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ cursor: "nwse-resize" }}
          onPointerDown={(e) => beginResize(e, "corner")}
          title="Scale"
        >
          <div
            className="w-full h-full rounded-sm"
            style={{
              background: "rgba(255,255,255,0.14)",
              border: "1px solid rgba(255,255,255,0.22)",
              boxShadow: "inset 0 0 18px rgba(110, 200, 255, 0.14)",
            }}
          />
        </div>
      </div>
    </div>
  );
});

