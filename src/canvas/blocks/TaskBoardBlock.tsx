import React, { memo, useMemo, useRef } from "react";
import { X } from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";
import { snapToGrid } from "@/canvas/utils/snap";

type DragState = {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  raf: number | null;
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
  raf: number | null;
  capturer: HTMLElement | null;
};

export const TaskBoardBlock = memo(function TaskBoardBlock({ id }: { id: string }) {
  const block = useCanvasStore((s) => s.blocks[id]);
  const bringToFront = useCanvasStore((s) => s.bringToFront);
  const selectBlocks = useCanvasStore((s) => s.selectBlocks);
  const toggleSelect = useCanvasStore((s) => s.toggleSelect);
  const isSelected = useCanvasStore((s) => s.selectedIds.includes(id));
  const moveBlocksFromSnapshot = useCanvasStore((s) => s.moveBlocksFromSnapshot);
  const updateBlock = useCanvasStore((s) => s.updateBlock);
  const pushHistory = useCanvasStore((s) => s.pushHistory);
  const deleteBlock = useCanvasStore((s) => s.deleteBlock);
  const gridSize = useCanvasStore((s) => s.gridSize);

  const dragRef = useRef<DragState | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);

  if (!block || block.type !== "create" || (block as any).mode !== "taskboard") return null;

  const style = useMemo(
    () => ({
      position: "absolute" as const,
      left: `${block.x}px`,
      top: `${block.y}px`,
      width: `${block.width}px`,
      height: `${block.height}px`,
      overflow: "visible",
    }),
    [block.x, block.y, block.width, block.height]
  );

  const snapSize = (n: number) => {
    const g = Math.max(1, Math.floor(gridSize || 24));
    return Math.max(g, snapToGrid(n, g));
  };

  const title = String((block as any)?.data?.title || "Task Board");
  const rawCols = Array.isArray((block as any)?.data?.columns) ? (block as any).data.columns : [];
  const columns = rawCols.length
    ? rawCols
    : [
        { id: "todo", title: "To Do", cards: [] },
        { id: "inprogress", title: "In Progress", cards: [] },
        { id: "done", title: "Done", cards: [] },
      ];

  function beginResize(e: React.PointerEvent, modeIn: ResizeMode) {
    e.stopPropagation();
    e.preventDefault();
    bringToFront(id);
    pushHistory();
    resizeRef.current = {
      pointerId: e.pointerId,
      mode: modeIn,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startX: block.x,
      startY: block.y,
      startW: block.width,
      startH: block.height,
      raf: null,
      capturer: e.currentTarget as HTMLElement,
    };
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  }

  function startDragStrip(e: React.PointerEvent) {
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
      const b = (state.blocks as any)[bid];
      return { id: bid, x: Number(b?.x) || 0, y: Number(b?.y) || 0 };
    });

    dragRef.current = {
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      raf: null,
      capturer: e.currentTarget as HTMLElement,
      snapshot,
    };
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  }

  function onDragMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dx = e.clientX - d.startClientX;
    const dy = e.clientY - d.startClientY;
    if (d.raf != null) return;
    d.raf = window.requestAnimationFrame(() => {
      d.raf = null;
      moveBlocksFromSnapshot(d.snapshot as any, dx, dy, { snap: true, snapSize: Math.max(1, Math.floor(gridSize || 24)) });
    });
  }

  function endDrag(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    if (d.raf != null) window.cancelAnimationFrame(d.raf);
    try {
      d.capturer?.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    dragRef.current = null;
  }

  function onResizeMove(e: React.PointerEvent) {
    const rr = resizeRef.current;
    if (!rr || rr.pointerId !== e.pointerId) return;
    const dx = e.clientX - rr.startClientX;
    const dy = e.clientY - rr.startClientY;
    if (rr.raf != null) return;
    rr.raf = window.requestAnimationFrame(() => {
      rr.raf = null;
      let nextX = rr.startX;
      let nextY = rr.startY;
      let nextW = rr.startW;
      let nextH = rr.startH;

      if (rr.mode === "right") nextW = snapSize(rr.startW + dx);
      if (rr.mode === "top") {
        nextY = snapToGrid(rr.startY + dy, Math.max(1, Math.floor(gridSize || 24)));
        nextH = snapSize(rr.startH - (nextY - rr.startY));
      }
      if (rr.mode === "bottom") nextH = snapSize(rr.startH + dy);
      if (rr.mode === "corner") {
        nextW = snapSize(rr.startW + dx);
        nextH = snapSize(rr.startH + dy);
      }

      updateBlock(id, { x: nextX, y: nextY, width: Math.max(snapSize(8 * (gridSize || 24)), nextW), height: Math.max(snapSize(6 * (gridSize || 24)), nextH) } as any);
    });
  }

  function endResize(e: React.PointerEvent) {
    const rr = resizeRef.current;
    if (!rr || rr.pointerId !== e.pointerId) return;
    if (rr.raf != null) window.cancelAnimationFrame(rr.raf);
    try {
      rr.capturer?.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    resizeRef.current = null;
  }

  return (
    <div data-canvas-block data-block-id={id} className="absolute group" style={style}>
      <div
        data-drag-handle
        className="absolute inset-x-0 top-0 h-4 z-30 cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity"
        onPointerDown={startDragStrip}
        onPointerMove={onDragMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        title="Drag to move"
      />

      <div className="h-full w-full rounded-xl border border-white/45 bg-[linear-gradient(145deg,rgba(255,255,255,0.74),rgba(255,255,255,0.44))] shadow-[0_16px_36px_rgba(0,0,0,0.10)] backdrop-blur-md overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 border-b border-black/10 bg-white/45">
          <div className="text-xs font-semibold text-black/80 truncate">{title}</div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              deleteBlock(id as any);
            }}
            className="text-black/45 hover:text-black/75 text-xs leading-none px-1"
            title="Delete task board"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="h-[calc(100%-38px)] px-3 py-3 overflow-auto scrollbar-hide">
          <div className="grid gap-2 h-full" style={{ gridTemplateColumns: `repeat(${Math.max(1, columns.length)}, minmax(180px, 1fr))` }}>
            {columns.map((col: any, idx: number) => {
              const cards = Array.isArray(col?.cards) ? col.cards : [];
              return (
                <div key={String(col?.id || idx)} className="rounded-lg border border-black/10 bg-white/55 p-2 min-h-0 overflow-hidden">
                  <div className="text-[11px] font-semibold text-black/70 mb-2 truncate">{String(col?.title || `Column ${idx + 1}`)}</div>
                  <div className="space-y-2 overflow-auto max-h-[calc(100%-22px)] scrollbar-hide">
                    {cards.length ? (
                      cards.map((card: any, cIdx: number) => (
                        <div key={`${idx}-${cIdx}`} className="rounded-md border border-black/10 bg-white/80 px-2 py-1.5 text-[11px] text-black/80 leading-snug">
                          {String(card || "")}
                        </div>
                      ))
                    ) : (
                      <div className="rounded-md border border-dashed border-black/15 bg-white/45 px-2 py-2 text-[10px] text-black/45">No cards yet</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="absolute inset-0 pointer-events-none">
        <div
          data-resize-handle
          className="absolute top-0 bottom-0 right-0 w-2 pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ cursor: "ew-resize" }}
          onPointerDown={(e) => beginResize(e, "right")}
          onPointerMove={onResizeMove}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          onLostPointerCapture={endResize}
          title="Resize width"
        />
        <div
          data-resize-handle
          className="absolute left-0 right-0 top-0 h-2 pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ cursor: "ns-resize" }}
          onPointerDown={(e) => beginResize(e, "top")}
          onPointerMove={onResizeMove}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          onLostPointerCapture={endResize}
          title="Resize height"
        />
        <div
          data-resize-handle
          className="absolute left-0 right-0 bottom-0 h-2 pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ cursor: "ns-resize" }}
          onPointerDown={(e) => beginResize(e, "bottom")}
          onPointerMove={onResizeMove}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          onLostPointerCapture={endResize}
          title="Resize height"
        />
        <div
          data-resize-handle
          className="absolute right-0 bottom-0 w-4 h-4 pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ cursor: "nwse-resize" }}
          onPointerDown={(e) => beginResize(e, "corner")}
          onPointerMove={onResizeMove}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          onLostPointerCapture={endResize}
          title="Scale"
        />
      </div>
    </div>
  );
});

