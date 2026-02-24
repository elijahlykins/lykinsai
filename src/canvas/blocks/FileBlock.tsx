import React, { memo, useMemo, useRef } from "react";
import { Paperclip, Download } from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";

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

export const FileBlock = memo(function FileBlock({ id }: { id: string }) {
  const block = useCanvasStore((s) => s.blocks[id]);
  const bringToFront = useCanvasStore((s) => s.bringToFront);
  const selectBlocks = useCanvasStore((s) => s.selectBlocks);
  const toggleSelect = useCanvasStore((s) => s.toggleSelect);
  const isSelected = useCanvasStore((s) => s.selectedIds.includes(id));
  const moveBlocksFromSnapshot = useCanvasStore((s) => s.moveBlocksFromSnapshot);

  const dragRef = useRef<DragState | null>(null);

  const style = useMemo(() => {
    if (!block) return null;
    if (block.type === "file" || (block.type === "create" && block.mode === "embed")) {
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
  const data = isCreate ? (block as any).data || {} : block;
  const dataUrl = String(data.dataUrl || "");
  if (!dataUrl) return null;

  const startDragStrip = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    bringToFront(id);
    if (e.shiftKey) toggleSelect(id);
    else if (!isSelected) selectBlocks([id]);

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

  const download = () => {
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = data.name || "file";
    a.rel = "noreferrer";
    a.click();
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
        if (e.shiftKey) toggleSelect(id);
        else if (!isSelected) selectBlocks([id]);
      }}
      onPointerDown={(e) => {
        e.stopPropagation();
        bringToFront(id);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        try {
          window.open(dataUrl, "_blank", "noopener,noreferrer");
        } catch {
          download();
        }
      }}
    >
      <div className={`glass-block overflow-hidden relative ${isSelected ? "omnia-selected-glass" : ""}`} style={{ width: "100%", height: "100%" }}>
        {/* top grab strip */}
        <div
          data-drag-handle
          className="w-full cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ height: "8px" }}
          onPointerDown={startDragStrip}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
          onLostPointerCapture={onDragEnd}
          title="Drag to move"
        />

        <div className="w-full" style={{ height: "calc(100% - 8px)" }}>
          <div className="h-full w-full px-3 py-2 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-white/18 dark:bg-white/10 border border-white/18 flex items-center justify-center shrink-0">
              <Paperclip className="w-4 h-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{data.name || "Attachment"}</div>
              <div className="text-xs text-gray-600/80 dark:text-gray-300/70 truncate">{data.mime || "file"}</div>
            </div>
            <button
              type="button"
              className="w-9 h-9 rounded-lg bg-white/18 dark:bg-white/10 border border-white/18 hover:bg-white/26 dark:hover:bg-white/14 flex items-center justify-center shrink-0"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                download();
              }}
              title="Download"
            >
              <Download className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});

