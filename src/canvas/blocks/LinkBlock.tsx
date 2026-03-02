import React, { memo, useMemo, useRef } from "react";
import { ExternalLink, FileText, Link as LinkIcon, Music2, Video, X } from "lucide-react";
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

type ResizeState = {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
  startW: number;
  startH: number;
  aspect: number;
  maxW: number;
  maxH: number;
  raf: number | null;
  capturer: HTMLElement | null;
};

function safeHostname(urlStr: string) {
  try {
    const u = new URL(urlStr);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function fileNameFromUrl(input: string) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    return decodeURIComponent(String(u.pathname || "").split("/").pop() || "");
  } catch {
    const noQuery = raw.split("?")[0].split("#")[0];
    return decodeURIComponent(noQuery.split("/").pop() || "");
  }
}

function extensionFromName(name: string) {
  return String(name || "").split(".").pop()?.toLowerCase() || "";
}

function inferPreviewKind(url: string, mimeHint: string, nameHint: string) {
  const mime = String(mimeHint || "").toLowerCase();
  const ext = extensionFromName(nameHint || fileNameFromUrl(url));
  if (mime.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "heic"].includes(ext)) return "image";
  if (mime.startsWith("video/") || ["mp4", "mov", "webm", "mkv", "avi"].includes(ext)) return "video";
  if (mime.startsWith("audio/") || ["mp3", "wav", "m4a", "ogg", "aac", "flac"].includes(ext)) return "audio";
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  return "link";
}

export const LinkBlock = memo(function LinkBlock({ id }: { id: string }) {
  const block = useCanvasStore((s) => s.blocks[id]);
  const allBlocks = useCanvasStore((s) => s.blocks);
  const bringToFront = useCanvasStore((s) => s.bringToFront);
  const selectBlocks = useCanvasStore((s) => s.selectBlocks);
  const toggleSelect = useCanvasStore((s) => s.toggleSelect);
  const isSelected = useCanvasStore((s) => s.selectedIds.includes(id));
  const moveBlocksFromSnapshot = useCanvasStore((s) => s.moveBlocksFromSnapshot);
  const updateBlock = useCanvasStore((s) => s.updateBlock);
  const gridSize = useCanvasStore((s) => s.gridSize);
  const canvasWidth = useCanvasStore((s) => s.canvasWidth);
  const pushHistory = useCanvasStore((s) => s.pushHistory);
  const deleteBlock = useCanvasStore((s) => s.deleteBlock);

  const dragRef = useRef<DragState | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);

  const style = useMemo(() => {
    if (!block) return null;
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
  const data = (block as any).data || {};
  const url = isCreate ? String(data.url || data.dataUrl || "") : String((block as any).url || "");
  const name = isCreate ? String(data.name || fileNameFromUrl(url) || "Attachment") : "Link";
  const mime = isCreate ? String(data.mime || "") : "";
  if (!url) return null;

  const host = safeHostname(url);
  const previewKind = inferPreviewKind(url, mime, name);
  const snapSize = (n: number) => {
    const g = Math.max(1, Math.floor(gridSize || 24));
    return Math.max(g, snapToGrid(n, g));
  };
  const snapDownSize = (n: number) => {
    const g = Math.max(1, Math.floor(gridSize || 24));
    if (!Number.isFinite(n as any)) return Number.POSITIVE_INFINITY;
    return Math.max(g, Math.floor(Number(n) / g) * g);
  };

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

  const beginResize = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    bringToFront(id);
    pushHistory();
    const capturer = e.currentTarget as HTMLElement;
    const aspect = Math.max(0.01, Number(block.width || 1) / Math.max(1, Number(block.height || 1)));
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
      startClientX: e.clientX,
      startClientY: e.clientY,
      startX: Number(block.x || 0),
      startY: Number(block.y || 0),
      startW: Number(block.width || 1),
      startH: Number(block.height || 1),
      aspect,
      maxW,
      maxH,
      raf: null,
      capturer,
    };
    try {
      capturer.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  const onDragMove = (e: React.PointerEvent) => {
    const r = resizeRef.current;
    if (r && r.pointerId === e.pointerId) {
      const dx = e.clientX - r.startClientX;
      const dy = e.clientY - r.startClientY;
      if (r.raf != null) return;
      r.raf = window.requestAnimationFrame(() => {
        const rr = resizeRef.current;
        if (!rr) return;
        rr.raf = null;
        const byX = dx;
        const byY = dy * rr.aspect;
        const deltaW = Math.abs(byX) >= Math.abs(byY) ? byX : byY;
        const maxW = snapDownSize(rr.maxW);
        const maxH = snapDownSize(rr.maxH);

        let nextW = snapSize(rr.startW + deltaW);
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
        if (Number.isFinite(maxH) && nextH > maxH) {
          nextH = maxH;
        }
        updateBlock(id, {
          x: rr.startX,
          y: rr.startY,
          width: nextW,
          height: nextH,
        } as any);
      });
      return;
    }

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
    const r = resizeRef.current;
    if (r && r.pointerId === e.pointerId) {
      if (r.raf != null) window.cancelAnimationFrame(r.raf);
      resizeRef.current = null;
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      return;
    }

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
    const targetUrl = String(url || "").trim();
    if (!targetUrl) return;
    try {
      window.open(targetUrl, "_blank", "noopener,noreferrer");
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
        if (t?.closest?.("[data-delete-button]")) return;
        if (e.shiftKey) toggleSelect(id);
        else if (!isSelected) selectBlocks([id]);
      }}
      onPointerDown={(e) => {
        e.stopPropagation();
        bringToFront(id);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        open();
      }}
    >
      <div className={`glass-block overflow-hidden relative ${isSelected ? "omnia-selected-glass" : ""}`} style={{ width: "100%", height: "100%" }}>
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
        <div className="w-full relative" style={{ height: "calc(100% - 8px)" }}>
          {previewKind === "image" && (
            <img
              src={url}
              alt={name}
              className="w-full h-full object-contain"
              draggable={false}
              onPointerDown={(e) => e.stopPropagation()}
            />
          )}
          {previewKind === "video" && (
            <video
              src={url}
              className="w-full h-full object-contain bg-black/30"
              controls
              onPointerDown={(e) => e.stopPropagation()}
            />
          )}
          {previewKind === "audio" && (
            <div className="h-full w-full flex items-center justify-center px-3">
              <div className="w-full rounded-xl border border-white/30 bg-white/20 dark:bg-black/25 p-3">
                <div className="flex items-center gap-2 text-xs mb-2 text-black/80 dark:text-white/85">
                  <Music2 className="w-4 h-4" />
                  <span className="truncate">{name}</span>
                </div>
                <audio src={url} controls className="w-full" onPointerDown={(e) => e.stopPropagation()} />
              </div>
            </div>
          )}
          {previewKind === "pdf" && (
            <iframe
              src={url}
              title={name || "PDF"}
              className="w-full h-full border-0 bg-white"
              onPointerDown={(e) => e.stopPropagation()}
            />
          )}
          {previewKind === "link" && (
            <button
              type="button"
              className="w-full h-full px-3 py-2 flex items-center gap-3 text-left"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                open();
              }}
              title={url}
            >
              <div className="w-9 h-9 rounded-lg bg-white/18 dark:bg-white/10 border border-white/18 flex items-center justify-center shrink-0">
                <LinkIcon className="w-4 h-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{host || name || "Link"}</div>
                <div className="text-xs text-gray-600/80 dark:text-gray-300/70 truncate">{url}</div>
              </div>
              <div className="w-9 h-9 rounded-lg bg-white/18 dark:bg-white/10 border border-white/18 flex items-center justify-center shrink-0">
                <ExternalLink className="w-4 h-4" />
              </div>
            </button>
          )}

          <button
            data-delete-button
            type="button"
            className="absolute top-2 right-2 z-20 w-7 h-7 rounded-full glass-control hover:opacity-90 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity text-black/70 dark:text-white/70 hover:text-red-500"
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onClick={(e) => {
              e.stopPropagation();
              pushHistory();
              deleteBlock(id);
            }}
            title="Delete"
          >
            <X className="w-3.5 h-3.5" />
          </button>

          <button
            type="button"
            className="absolute top-2 right-11 z-20 w-8 h-8 rounded-lg glass-control hover:opacity-90 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              open();
            }}
            title="Open"
          >
            {previewKind === "pdf" ? <FileText className="w-4 h-4" /> : previewKind === "video" ? <Video className="w-4 h-4" /> : <ExternalLink className="w-4 h-4" />}
          </button>
        </div>

        <div className="absolute inset-0 pointer-events-none">
          <div
            data-resize-handle
            className="absolute right-0 bottom-0 w-5 h-5 pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity"
            style={{ cursor: "nwse-resize" }}
            onPointerDown={beginResize}
            onPointerMove={onDragMove}
            onPointerUp={onDragEnd}
            onPointerCancel={onDragEnd}
            onLostPointerCapture={onDragEnd}
            title="Resize"
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
    </div>
  );
});

