import React, { memo, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Youtube, AlertCircle } from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";
import { extractYouTubeVideoId, getYouTubeEmbedUrl } from "@/canvas/utils/youtube";
import { BlockHoverToolbar } from "./BlockHoverToolbar";
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

type ResizeMode = "corner";
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

export const YouTubeBlock = memo(function YouTubeBlock({ id, onMinimize, onMenu }: { id: string; onMinimize?: (id: string) => void; onMenu?: (id: string, rect: DOMRect) => void }) {
  const block = useCanvasStore((s) => s.blocks[id]);
  const selectBlocks = useCanvasStore((s) => s.selectBlocks);
  const toggleSelect = useCanvasStore((s) => s.toggleSelect);
  const isSelected = useCanvasStore((s) => s.selectedIds.includes(id));
  const moveBlocksFromSnapshot = useCanvasStore((s) => s.moveBlocksFromSnapshot);
  const gridSize = useCanvasStore((s) => s.gridSize);
  const updateBlock = useCanvasStore((s) => s.updateBlock);
  const pushHistory = useCanvasStore((s) => s.pushHistory);

  const dragRef = useRef<DragState | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);
  const endResizeCleanupRef = useRef<(() => void) | null>(null);
  const [videoFailed, setVideoFailed] = useState(false);

  const style = useMemo(() => {
    if (!block) return null;
    const blockType = String((block as any).type || "");
    if (blockType === "youtube" || (blockType === "create" && (block as any).mode === "video")) {
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
  const videoId = isCreate ? String((block as any).data?.videoId || "") : String((block as any).videoId || "");
  const url = isCreate ? String((block as any).data?.url || "") : String((block as any).url || "");
  const mime = isCreate ? String((block as any).data?.mime || "") : "";
  const fileName = isCreate ? String((block as any).data?.name || "") : "";
  if (!videoId && !url) return null;
  const resolvedVideoId = String(videoId || extractYouTubeVideoId(url || "") || "").trim();
  const isYouTubeVideo = Boolean(resolvedVideoId);
  const embedUrl = isYouTubeVideo ? getYouTubeEmbedUrl(resolvedVideoId) : "";
  const extension = String(fileName || url).split(".").pop()?.toLowerCase() || "";
  const sourceMime = mime || (extension === "mov" ? "video/quicktime" : "");

  useEffect(() => {
    setVideoFailed(false);
  }, [url, mime, fileName, isYouTubeVideo]);

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
    const z = (useCanvasStore.getState() as any).camera?.zoom || 1;
    const dx = (e.clientX - d.startClientX) / z;
    const dy = (e.clientY - d.startClientY) / z;
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

  const open = () => {
    const link = String(url || "").trim();
    if (!link) return;
    try {
      window.open(link, "_blank", "noopener,noreferrer");
    } catch {
      // ignore
    }
  };

  return (
    <div
      data-canvas-block
      data-self-drag
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
      }}
      onPointerMove={(e) => {
        const r = resizeRef.current;
        if (r && r.pointerId === e.pointerId) {
          // Fail-safe: if mouse button released, stop.
          if (e.pointerType === "mouse" && e.buttons === 0) {
            endResize(e.pointerId);
            return;
          }
          const rz = (useCanvasStore.getState() as any).camera?.zoom || 1;
          const dx = (e.clientX - r.startClientX) / rz;
          const dy = (e.clientY - r.startClientY) / rz;
          if (r.raf != null) return;
          r.raf = window.requestAnimationFrame(() => {
            const rr = resizeRef.current;
            if (!rr) return;
            rr.raf = null;

            const min = Math.max(1, Math.floor(gridSize || 24));

            const byX = dx;
            const byY = dy * rr.aspect;
            const deltaW = Math.abs(byX) >= Math.abs(byY) ? byX : byY;
            const nextW = snapSize(rr.startW + deltaW);
            const nextH = snapSize(nextW / rr.aspect);
            updateBlock(id, {
              x: rr.startX,
              y: rr.startY,
              width: Math.max(min, nextW),
              height: Math.max(min, nextH),
            });
          });
          return;
        }
      }}
      onPointerUp={(e) => {
        endResize(e.pointerId);
      }}
      onPointerCancel={(e) => {
        endResize(e.pointerId);
      }}
      onLostPointerCapture={(e) => {
        endResize(e.pointerId);
      }}
    >
      <BlockHoverToolbar blockId={id} onMinimize={onMinimize} onMenu={onMenu} />

      {/* tab-shaped drag handle above the video */}
      <div
        data-drag-handle
        className="absolute z-30 cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity"
        style={{
          left: "8px",
          top: "-20px",
          width: "72px",
          height: "20px",
          background: "linear-gradient(180deg, rgba(255,255,255,0.72), rgba(255,255,255,0.48))",
          backdropFilter: "blur(8px)",
          borderRadius: "8px 8px 0 0",
          border: "1px solid rgba(255,255,255,0.55)",
          borderBottom: "none",
          boxShadow: "0 -2px 8px rgba(0,0,0,0.08)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
        onPointerDown={startDragStrip}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
        onLostPointerCapture={onDragEnd}
        title="Drag to move"
      >
        <span style={{ width: 16, height: 2, borderRadius: 1, background: "rgba(0,0,0,0.25)" }} />
      </div>

      <div className={`glass-block overflow-hidden relative ${isSelected ? "omnia-selected-glass" : ""}`} style={{ width: "100%", height: "100%" }}>
        {isYouTubeVideo ? (
          <iframe
            src={embedUrl}
            title="YouTube video"
            className="absolute inset-0 w-full h-full"
            allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
          />
        ) : (
          <>
            <video
              className="absolute inset-0 w-full h-full object-contain bg-black/35"
              controls
              preload="metadata"
              playsInline
              onError={() => setVideoFailed(true)}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <source src={url} type={sourceMime || undefined} />
              <source src={url} />
            </video>
            {videoFailed && (
              <div className="absolute inset-0 z-20 bg-black/55 backdrop-blur-sm flex items-center justify-center p-4">
                <div className="rounded-xl border border-white/20 bg-black/40 text-white p-4 max-w-sm text-center space-y-2">
                  <div className="flex items-center justify-center gap-2">
                    <AlertCircle className="w-4 h-4" />
                    <span className="text-sm font-medium">Video couldn't play inline</span>
                  </div>
                  <p className="text-xs text-white/85">
                    This `.mov` may use a codec your browser cannot decode. Open it in a new tab or download to play externally.
                  </p>
                  <button
                    type="button"
                    className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg glass-control hover:opacity-90 text-xs"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      open();
                    }}
                  >
                    <ExternalLink className="w-3 h-3" />
                    Open Video
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        <button
          type="button"
          className="absolute top-2 right-12 z-20 w-9 h-9 rounded-lg glass-control hover:opacity-90 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            open();
          }}
          title={isYouTubeVideo ? "Open on YouTube" : "Open video"}
        >
          <ExternalLink className="w-4 h-4" />
        </button>

        <div className="absolute bottom-2 left-2 z-20 px-2 h-7 rounded-lg bg-white/22 dark:bg-white/10 border border-white/18 flex items-center gap-2 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity">
          <Youtube className="w-4 h-4" />
          <div className="text-xs text-gray-900 dark:text-gray-100">{isYouTubeVideo ? "YouTube" : "Video"}</div>
        </div>
      </div>

      {/* Resize handles (same as ImageBlock) */}
      <div className="absolute inset-0 pointer-events-none">
        {/* Bottom-right corner scale */}
        <div
          data-resize-handle
          className="absolute right-0 bottom-0 w-5 h-5 pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity"
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

