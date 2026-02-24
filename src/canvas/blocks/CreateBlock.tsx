import React, { memo, useMemo, useRef, useState } from "react";
import { useCanvasStore } from "@/store/canvasStore";
import { Trash2 } from "lucide-react";
import { snapToGrid } from "@/canvas/utils/snap";
import { ImageBlock } from "@/canvas/blocks/ImageBlock";
import { FileBlock } from "@/canvas/blocks/FileBlock";
import { LinkBlock } from "@/canvas/blocks/LinkBlock";
import { YouTubeBlock } from "@/canvas/blocks/YouTubeBlock";
import { DesignBlock } from "@/canvas/blocks/DesignBlock";
import { CodeBlock } from "@/canvas/blocks/CodeBlock";
import { SpreadsheetBlock } from "@/canvas/blocks/SpreadsheetBlock";
import { SheetBlock } from "@/canvas/blocks/SheetBlock";
import { TaskBoardBlock } from "@/canvas/blocks/TaskBoardBlock";

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
  raf: number | null;
  capturer: HTMLElement | null;
};

export const CreateBlock = memo(function CreateBlock({
  id,
  autoResize = false,
  onAutoResizeReady,
}: {
  id: string;
  autoResize?: boolean;
  onAutoResizeReady?: () => void;
}) {
  const block = useCanvasStore((s) => s.blocks[id]);
  const gridSize = useCanvasStore((s) => s.gridSize);
  const bringToFront = useCanvasStore((s) => s.bringToFront);
  const selectBlocks = useCanvasStore((s) => s.selectBlocks);
  const toggleSelect = useCanvasStore((s) => s.toggleSelect);
  const isSelected = useCanvasStore((s) => s.selectedIds.includes(id));
  const moveBlocksFromSnapshot = useCanvasStore((s) => s.moveBlocksFromSnapshot);
  const updateBlock = useCanvasStore((s) => s.updateBlock);
  const pushHistory = useCanvasStore((s) => s.pushHistory);
  const deleteBlock = useCanvasStore((s) => s.deleteBlock);
  const [showShapes, setShowShapes] = useState(false);
  const [showPresets, setShowPresets] = useState(false);

  const dragRef = useRef<DragState | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);

  if (!block || block.type !== "create") return null;

  const mode = block.mode;
  const kind = block.data?.kind;

  const style = useMemo(() => {
    return {
      position: "absolute" as const,
      left: `${block.x}px`,
      top: `${block.y}px`,
      width: `${block.width}px`,
      height: `${block.height}px`,
      overflow: "visible",
    };
  }, [block]);

  if (mode === "shape") {
    const shape = String((block as any).data?.shape || "rectangle");
    const stroke = "none";
    const fill = "#000000";
    return (
      <div
        data-canvas-block
        data-block-id={id}
        className="absolute group"
        style={style}
      >
        {/* drag strip */}
        <div
          data-drag-handle
          className="absolute inset-x-0 top-0 h-3 z-30 cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity"
          onPointerDown={startDragStrip}
          onPointerMove={onDragMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onLostPointerCapture={endDrag}
          title="Drag to move"
        />
        <svg className="w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
          {shape === "rectangle" && <rect x="0" y="0" width="100" height="100" fill={fill} stroke={stroke} />}
          {shape === "line" && <line x1="0" y1="50" x2="100" y2="50" stroke={fill} strokeWidth="6" />}
          {shape === "arrow" && (
            <>
              <line x1="0" y1="50" x2="80" y2="50" stroke={fill} strokeWidth="6" />
              <polygon points="80,35 100,50 80,65" fill={fill} />
            </>
          )}
          {shape === "ellipse" && <ellipse cx="50" cy="50" rx="50" ry="50" fill={fill} />}
          {shape === "triangle" && <polygon points="50,0 0,100 100,100" fill={fill} />}
          {shape === "diamond" && <polygon points="50,0 100,50 50,100 0,50" fill={fill} />}
          {shape === "hexagon" && <polygon points="25,0 75,0 100,50 75,100 25,100 0,50" fill={fill} />}
          {shape === "star" && <polygon points="50,0 61,35 98,35 67,57 79,91 50,70 21,91 33,57 2,35 39,35" fill={fill} />}
        </svg>
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
          />
        </div>
      </div>
    );
  }
  if (mode === "image" || mode === "generated") return <ImageBlock id={id} />;
  if (mode === "design") return <DesignBlock id={id} />;
  if (mode === "taskboard") return <TaskBoardBlock id={id} />;
  if (mode === "video") return <YouTubeBlock id={id} />;

  if (mode === "embed") {
    if (kind === "spreadsheet") return <SpreadsheetBlock id={id} />;
    if (kind === "sheet") return <SheetBlock id={id} />;
    if (kind === "code") return <CodeBlock id={id} />;
    if (block.data?.dataUrl) return <FileBlock id={id} />;
    if (block.data?.url) return <LinkBlock id={id} />;
  }

  const snapSize = (n: number) => {
    const g = Math.max(1, Math.floor(gridSize || 24));
    return Math.max(g, snapToGrid(n, g));
  };

  function beginResize(e: React.PointerEvent, modeIn: ResizeMode) {
    e.stopPropagation();
    e.preventDefault();
    if (autoResize && onAutoResizeReady) onAutoResizeReady();
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
    if (autoResize && onAutoResizeReady) onAutoResizeReady();
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
  }

  function onDragMove(e: React.PointerEvent) {
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
  }

  function endDrag(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    dragRef.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  }

  const endResize = (pointerId: number) => {
    const r = resizeRef.current;
    if (!r || r.pointerId !== pointerId) return;
    if (r.raf != null) window.cancelAnimationFrame(r.raf);
    resizeRef.current = null;
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
        if (autoResize && onAutoResizeReady) onAutoResizeReady();
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
            const nextW = snapSize(rr.startW + dx);
            const nextH = snapSize(rr.startH + dy);
            updateBlock(id, { width: Math.max(min, nextW), height: Math.max(min, nextH) });
          });
        }
      }}
      onPointerUp={(e) => endResize(e.pointerId)}
      onPointerCancel={(e) => endResize(e.pointerId)}
      onLostPointerCapture={(e) => endResize(e.pointerId)}
    >
      {/* top bar menu (stub) */}
      {isSelected && (
        <div
          className="absolute -top-10 left-0 z-30 h-9 rounded-full glass-control flex items-center gap-2 px-3"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <label
            className="h-5 w-5 rounded-full border border-white/40 shadow-sm"
            style={{
              background: (block as any).data?.bgColor || "rgba(255,255,255,0.6)",
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <input
              type="color"
              aria-label="Canvas block color"
              className="h-0 w-0 opacity-0"
              onChange={(e) => {
                const next = e.currentTarget.value;
                updateBlock(id, { data: { ...(block as any).data, bgColor: next } } as any);
              }}
              onClick={(e) => e.stopPropagation()}
            />
          </label>
          <div className="w-px h-4 bg-black/10 dark:bg-white/10" />
          <button
            type="button"
            className="text-[11px] text-black/70"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setShowShapes((v) => !v)}
          >
            Shapes
          </button>
          <div className="w-px h-4 bg-black/10 dark:bg-white/10" />
          <button
            type="button"
            className="text-[11px] text-black/70"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setShowPresets((v) => !v)}
          >
            Presets
          </button>
          <div className="w-px h-4 bg-black/10 dark:bg-white/10" />
          <button
            type="button"
            className="h-6 w-6 rounded-full flex items-center justify-center text-black/70"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => deleteBlock(id)}
            title="Delete canvas"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {isSelected && showShapes && (
        <div
          className="absolute -top-10 left-[10.5rem] z-30 h-9 rounded-full glass-control flex items-center gap-3 px-3"
          onPointerDown={(e) => e.stopPropagation()}
        >
          {[
            { id: "circle", label: "Circle" },
            { id: "square", label: "Square" },
            { id: "triangle", label: "Triangle" },
          ].map((shape) => (
            <button
              key={shape.id}
              type="button"
              className="h-6 w-6 rounded-md border border-white/40 bg-white/60 backdrop-blur-sm flex items-center justify-center text-black/70"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => {
                updateBlock(id, { data: { ...(block as any).data, shape: shape.id } } as any);
              }}
              title={shape.label}
            >
              {shape.id === "circle" && <div className="h-3 w-3 rounded-full border border-black/60" />}
              {shape.id === "square" && <div className="h-3 w-3 border border-black/60" />}
              {shape.id === "triangle" && (
                <div
                  className="h-0 w-0"
                  style={{
                    borderLeft: "6px solid transparent",
                    borderRight: "6px solid transparent",
                    borderBottom: "10px solid rgba(0,0,0,0.6)",
                  }}
                />
              )}
            </button>
          ))}
        </div>
      )}

      {isSelected && showPresets && (
        <div
          className="absolute -top-10 left-[20.5rem] z-30 rounded-2xl glass-control px-2 py-2 text-[11px] text-black/70"
          onPointerDown={(e) => e.stopPropagation()}
        >
          {[
            { id: "social", label: "Social Media (1080×1080)", w: 1080, h: 1080 },
            { id: "logo", label: "Logo (1024×1024)", w: 1024, h: 1024 },
            { id: "presentation", label: "Presentation (1920×1080)", w: 1920, h: 1080 },
            { id: "business", label: "Business Card (1050×600)", w: 1050, h: 600 },
            { id: "web", label: "Web Page (1440×900)", w: 1440, h: 900 },
            { id: "poster", label: "Poster (2000×3000)", w: 2000, h: 3000 },
          ].map((preset) => (
            <button
              key={preset.id}
              type="button"
              className="block w-full text-left rounded-lg px-2 py-1 hover:opacity-90"
              onClick={() => {
                const g = Math.max(1, Math.floor(gridSize || 24));
                const w = snapSize(preset.w);
                const h = snapSize(preset.h);
                updateBlock(id, { width: w, height: h } as any);
                window.dispatchEvent(new CustomEvent("omnia_fit_block", { detail: { id } }));
                setShowPresets(false);
              }}
            >
              {preset.label}
            </button>
          ))}
        </div>
      )}

      {/* drag strip */}
      <div
        data-drag-handle
        className="absolute inset-x-0 top-0 h-3 z-30 cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity"
        onPointerDown={startDragStrip}
        onPointerMove={onDragMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        title="Drag to move"
      />

      {(() => {
        const shape = (block as any).data?.shape || "square";
        const shapeStyle: React.CSSProperties =
          shape === "circle"
            ? { borderRadius: "9999px" }
            : shape === "triangle"
            ? { clipPath: "polygon(50% 0%, 0% 100%, 100% 100%)" }
            : {};
        return (
          <div
            className={`${isSelected ? "ring-1 ring-black/10" : ""}`}
            style={{
              width: "100%",
              height: "100%",
              backgroundColor: (block as any).data?.bgColor || "#ffffff",
              boxShadow: "0 12px 30px rgba(0,0,0,0.12)",
              ...shapeStyle,
            }}
          />
        );
      })()}

      {/* Resize handles */}
      <div className="absolute inset-0 pointer-events-none">
        <div
          data-resize-handle
          className={`absolute top-0 bottom-0 right-0 w-2 pointer-events-auto transition-opacity ${autoResize ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
          style={{ cursor: "ew-resize" }}
          onPointerDown={(e) => beginResize(e, "right")}
          title="Resize width"
        />
        <div
          data-resize-handle
          className={`absolute left-0 right-0 top-0 h-2 pointer-events-auto transition-opacity ${autoResize ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
          style={{ cursor: "ns-resize" }}
          onPointerDown={(e) => beginResize(e, "top")}
          title="Resize height"
        />
        <div
          data-resize-handle
          className={`absolute left-0 right-0 bottom-0 h-2 pointer-events-auto transition-opacity ${autoResize ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
          style={{ cursor: "ns-resize" }}
          onPointerDown={(e) => beginResize(e, "bottom")}
          title="Resize height"
        />
        <div
          data-resize-handle
          className={`absolute right-0 bottom-0 w-4 h-4 pointer-events-auto transition-opacity ${autoResize ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
          style={{ cursor: "nwse-resize" }}
          onPointerDown={(e) => beginResize(e, "corner")}
          title="Scale"
        />
      </div>
    </div>
  );
});
