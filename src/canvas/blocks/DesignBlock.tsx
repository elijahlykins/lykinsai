import React, { memo, useMemo, useRef } from "react";
import { useCanvasStore } from "@/store/canvasStore";
import { snapToGrid } from "@/canvas/utils/snap";
import DesignBoardBlock from "@/omnia/DesignBoardBlock";

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
  cornerAxis?: "x" | "y";
  raf: number | null;
  capturer: HTMLElement | null;
};

export const DesignBlock = memo(function DesignBlock({ id }: { id: string }) {
  const block = useCanvasStore((s) => s.blocks[id]);
  const bringToFront = useCanvasStore((s) => s.bringToFront);
  const selectBlocks = useCanvasStore((s) => s.selectBlocks);
  const toggleSelect = useCanvasStore((s) => s.toggleSelect);
  const clearSelection = useCanvasStore((s) => s.clearSelection);
  const isSelected = useCanvasStore((s) => s.selectedIds.includes(id));
  const gridSize = useCanvasStore((s) => s.gridSize);
  const updateBlock = useCanvasStore((s) => s.updateBlock);
  const moveBlocksFromSnapshot = useCanvasStore((s) => s.moveBlocksFromSnapshot);
  const pushHistory = useCanvasStore((s) => s.pushHistory);

  const dragRef = useRef<DragState | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);
  const endResizeCleanupRef = useRef<(() => void) | null>(null);

  const style = useMemo(() => {
    if (!block) return null;
    if (block.type === "design" || (block.type === "create" && block.mode === "design")) {
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
  const board = isCreate ? (block as any).data?.board : (block as any).board;
  if (!board) return null;

  const snapSize = (n: number) => {
    const g = Math.max(1, Math.floor(gridSize || 24));
    return Math.max(g, snapToGrid(n, g));
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
    bringToFront(id);
    pushHistory();

    const capturer = e.currentTarget as HTMLElement;
    const aspect = Math.max(0.01, (block.width || 1) / Math.max(1, block.height || 1));
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

  const startDragStrip = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
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
      return { id: bid, x: Number((b as any)?.x) || 0, y: Number((b as any)?.y) || 0 };
    });

    dragRef.current = {
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      originX: block.x,
      originY: block.y,
      raf: null,
      lastX: block.x,
      lastY: block.y,
      snapshot,
      capturer: e.currentTarget as HTMLElement,
    };
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  const onDragMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    if (resizeRef.current?.pointerId === e.pointerId) return;
    if (e.pointerType === "mouse" && e.buttons === 0) {
      dragRef.current = null;
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
      moveBlocksFromSnapshot(d2.snapshot, d2.lastX - d2.originX, d2.lastY - d2.originY, { snap: true });
    });
  };

  const onDragEnd = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    dragRef.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
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
        if (e.button !== 0) return;
        const t = e.target as Element | null;
        if (t?.closest?.("[data-drag-handle]")) return;
        if (t?.closest?.("[data-resize-handle]")) return;
        if (e.shiftKey) toggleSelect(id);
        else if (!isSelected) selectBlocks([id]);
      }}
      onPointerDown={(e) => {
        e.stopPropagation();
        bringToFront(id);
      }}
      onPointerMove={(e) => {
        const r = resizeRef.current;
        if (r && r.pointerId === e.pointerId) {
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

            if (rr.mode === "right") {
              const nextW = snapSize(rr.startW + dx);
              updateBlock(id, { width: Math.max(min, nextW) });
              return;
            }
            if (rr.mode === "top") {
              const nextH = snapSize(rr.startH - dy);
              const nextY = snapToGrid(bottom - nextH, min);
              updateBlock(id, { y: nextY, height: Math.max(min, nextH) });
              return;
            }
            if (rr.mode === "bottom") {
              const nextH = snapSize(rr.startH + dy);
              updateBlock(id, { height: Math.max(min, nextH) });
              return;
            }

            if (!rr.cornerAxis && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
              rr.cornerAxis = Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
            }
            const axis = rr.cornerAxis ?? (Math.abs(dx) >= Math.abs(dy) ? "x" : "y");
            const rawW = axis === "x" ? rr.startW + dx : (rr.startH + dy) * rr.aspect;
            const nextW = snapSize(rawW);
            const nextH = snapSize(nextW / rr.aspect);
            updateBlock(id, { width: Math.max(min, nextW), height: Math.max(min, nextH) });
          });
          return;
        }
      }}
      onPointerUp={(e) => endResize(e.pointerId)}
      onPointerCancel={(e) => endResize(e.pointerId)}
      onLostPointerCapture={(e) => endResize(e.pointerId)}
    >
      {/* top grab strip */}
      <div
        data-drag-handle
        className="absolute inset-x-0 top-0 h-3 z-30 cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity"
        onPointerDown={startDragStrip}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
        onLostPointerCapture={onDragEnd}
        title="Drag to move"
      />

      <div className={`glass-block overflow-hidden relative ${isSelected ? "omnia-selected-glass" : ""}`} style={{ width: "100%", height: "100%" }}>
        <div className="absolute inset-0">
          <div data-canvas-design-root-id={id} className="w-full h-full">
            <DesignBoardBlock
              board={board}
              width={block.width}
              height={block.height}
              isSelected={isSelected}
              onBoardChange={(nextBoard: any) => updateBlock(id, { board: nextBoard } as any)}
              onRequestFocus={() => {
                bringToFront(id);
                selectBlocks([id]);
              }}
              onExitFocus={() => {
                clearSelection();
              }}
            />
          </div>
        </div>
      </div>

      {/* Resize handles */}
      <div className="absolute inset-0 pointer-events-none">
        <div
          data-resize-handle
          className="absolute top-0 bottom-0 right-0 w-2 pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ cursor: "ew-resize" }}
          onPointerDown={(e) => beginResize(e, "right")}
          title="Resize width"
        />
        <div
          data-resize-handle
          className="absolute left-0 right-0 top-0 h-2 pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ cursor: "ns-resize" }}
          onPointerDown={(e) => beginResize(e, "top")}
          title="Resize height"
        />
        <div
          data-resize-handle
          className="absolute left-0 right-0 bottom-0 h-2 pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ cursor: "ns-resize" }}
          onPointerDown={(e) => beginResize(e, "bottom")}
          title="Resize height"
        />
        <div
          data-resize-handle
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

