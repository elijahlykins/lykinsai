import React, { memo, useMemo, useRef, useState } from "react";
import { X, Image, Film, Link2, FileUp, Globe } from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";
import { snapToGrid } from "@/canvas/utils/snap";

type MediaMode = "picker" | "image" | "video" | "link" | "embed" | "file";

type MediaData = {
  mode: MediaMode;
  src?: string;
  url?: string;
  fileName?: string;
  mimeType?: string;
  embedHtml?: string;
};

function parseMediaData(content: string): MediaData {
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object") return { mode: parsed.mode || "picker", ...parsed };
  } catch { /* ignore */ }
  return { mode: "picker" };
}

const MEDIA_OPTIONS = [
  { mode: "image" as const, icon: Image, label: "Image", hint: "Upload or paste" },
  { mode: "video" as const, icon: Film, label: "Video", hint: "YouTube URL" },
  { mode: "link" as const, icon: Link2, label: "Link", hint: "Bookmark URL" },
  { mode: "embed" as const, icon: Globe, label: "Embed", hint: "Any URL" },
  { mode: "file" as const, icon: FileUp, label: "File", hint: "Upload file" },
];

export const MediaBlock = memo(function MediaBlock({ id }: { id: string }) {
  const block = useCanvasStore((s) => s.blocks[id]);
  const bringToFront = useCanvasStore((s) => s.bringToFront);
  const selectBlocks = useCanvasStore((s) => s.selectBlocks);
  const toggleSelect = useCanvasStore((s) => s.toggleSelect);
  const isSelected = useCanvasStore((s) => s.selectedIds.includes(id));
  const updateBlock = useCanvasStore((s) => s.updateBlock);
  const pushHistory = useCanvasStore((s) => s.pushHistory);
  const deleteBlock = useCanvasStore((s) => s.deleteBlock);
  const gridSize = useCanvasStore((s) => s.gridSize);
  const moveBlocksFromSnapshot = useCanvasStore((s) => s.moveBlocksFromSnapshot);

  const dragRef = useRef<any>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const resizeRef = useRef<any>(null);
  const endResizeCleanupRef = useRef<(() => void) | null>(null);
  const [urlDraft, setUrlDraft] = useState("");
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [urlMode, setUrlMode] = useState<"video" | "link" | "embed">("link");

  const style = useMemo(() => {
    if (!block || block.type !== "text" || (block as any).format !== "media") return null;
    return {
      position: "absolute" as const,
      left: `${block.x}px`,
      top: `${block.y}px`,
      width: `${block.width}px`,
      height: `${block.height}px`,
      overflow: "visible",
    };
  }, [block]);

  if (!block || block.type !== "text" || (block as any).format !== "media" || !style) return null;

  const media = parseMediaData(String((block as any).content || ""));

  const saveMedia = (data: Partial<MediaData>) => {
    const next = { ...media, ...data };
    pushHistory();
    updateBlock(id, { content: JSON.stringify(next) } as any);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      if (file.type.startsWith("image/")) {
        saveMedia({ mode: "image", src: dataUrl, fileName: file.name, mimeType: file.type });
        const g = gridSize || 24;
        updateBlock(id, { width: Math.max(g * 10, block.width), height: Math.max(g * 10, block.height) } as any);
      } else {
        saveMedia({ mode: "file", src: dataUrl, fileName: file.name, mimeType: file.type });
      }
    };
    reader.readAsDataURL(file);
  };

  const handleUrlSubmit = () => {
    if (!urlDraft.trim()) return;
    const url = urlDraft.trim();

    if (urlMode === "video") {
      const ytMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]+)/);
      if (ytMatch) {
        const embedUrl = `https://www.youtube.com/embed/${ytMatch[1]}`;
        saveMedia({ mode: "video", url: embedUrl, src: url });
        const g = gridSize || 24;
        updateBlock(id, { width: Math.max(g * 16, block.width), height: Math.max(g * 10, block.height) } as any);
      } else {
        saveMedia({ mode: "video", url, src: url });
      }
    } else if (urlMode === "embed") {
      saveMedia({ mode: "embed", url, src: url });
      const g = gridSize || 24;
      updateBlock(id, { width: Math.max(g * 16, block.width), height: Math.max(g * 12, block.height) } as any);
    } else {
      saveMedia({ mode: "link", url, src: url });
    }

    setUrlDraft("");
    setShowUrlInput(false);
  };

  const snapSize = (n: number) => {
    const g = Math.max(1, Math.floor(gridSize || 24));
    return Math.max(g, snapToGrid(n, g));
  };

  const endResize = (pointerId: number) => {
    const r = resizeRef.current;
    if (!r || r.pointerId !== pointerId) return;
    if (r.raf != null) window.cancelAnimationFrame(r.raf);
    if (endResizeCleanupRef.current) { try { endResizeCleanupRef.current(); } catch {} endResizeCleanupRef.current = null; }
    if (r.capturer) { try { r.capturer.releasePointerCapture(pointerId); } catch {} }
    resizeRef.current = null;
  };

  const installGlobalResizeEndHandlers = (pointerId: number) => {
    const onUp = (ev: PointerEvent) => { if (ev.pointerId === pointerId) endResize(pointerId); };
    const onCancel = (ev: PointerEvent) => { if (ev.pointerId === pointerId) endResize(pointerId); };
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

  const beginResize = (e: React.PointerEvent, mode: "right" | "bottom" | "corner") => {
    e.stopPropagation();
    e.preventDefault();
    bringToFront(id);
    if (!isSelected) selectBlocks([id]);
    pushHistory();
    const capturer = e.currentTarget as HTMLElement;
    resizeRef.current = {
      pointerId: e.pointerId, mode,
      startClientX: e.clientX, startClientY: e.clientY,
      startW: block.width, startH: block.height,
      raf: null, capturer,
    };
    installGlobalResizeEndHandlers(e.pointerId);
    try { capturer.setPointerCapture(e.pointerId); } catch {}
  };

  const startDrag = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
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
      pointerId: e.pointerId, startClientX: e.clientX, startClientY: e.clientY,
      originX: block.x, originY: block.y, raf: null, lastX: block.x, lastY: block.y,
      snapshot, capturer: e.currentTarget as HTMLElement,
    };
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch {}
  };

  const onDragMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    if (e.pointerType === "mouse" && e.buttons === 0) { dragRef.current = null; return; }
    d.lastX = d.originX + (e.clientX - d.startClientX);
    d.lastY = d.originY + (e.clientY - d.startClientY);
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
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
  };

  const renderContent = () => {
    if (media.mode === "picker" || !media.src) {
      return (
        <div className="h-full flex flex-col items-center justify-center gap-2 p-3">
          <div className="text-[11px] font-medium text-black/50 mb-1">Add media</div>
          <div className="grid grid-cols-3 gap-1.5 w-full max-w-[200px]">
            {MEDIA_OPTIONS.map((opt) => {
              const Icon = opt.icon;
              return (
                <button
                  key={opt.mode}
                  type="button"
                  className="flex flex-col items-center gap-0.5 p-2 rounded-lg border border-black/8 hover:bg-black/5 hover:border-black/15 transition-all"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (opt.mode === "image" || opt.mode === "file") {
                      if (opt.mode === "image") fileInputRef.current?.setAttribute("accept", "image/*");
                      else fileInputRef.current?.removeAttribute("accept");
                      fileInputRef.current?.click();
                    } else {
                      setUrlMode(opt.mode);
                      setShowUrlInput(true);
                    }
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  <Icon className="w-4 h-4 text-black/50" />
                  <span className="text-[9px] text-black/60 font-medium">{opt.label}</span>
                </button>
              );
            })}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={handleFileSelect}
          />
          {showUrlInput && (
            <div className="w-full max-w-[200px] mt-1">
              <input
                autoFocus
                className="w-full px-2 py-1 rounded border border-black/15 bg-white text-[11px] outline-none focus:border-blue-400"
                placeholder={urlMode === "video" ? "YouTube URL..." : urlMode === "embed" ? "Embed URL..." : "URL..."}
                value={urlDraft}
                onChange={(e) => setUrlDraft(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") handleUrlSubmit();
                  if (e.key === "Escape") { setShowUrlInput(false); setUrlDraft(""); }
                }}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
              />
            </div>
          )}
        </div>
      );
    }

    if (media.mode === "image") {
      return (
        <img
          src={media.src}
          alt={media.fileName || "image"}
          className="w-full h-full object-cover rounded"
          draggable={false}
        />
      );
    }

    if (media.mode === "video") {
      return (
        <iframe
          src={media.url || media.src}
          className="w-full h-full rounded"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
          style={{ border: "none" }}
        />
      );
    }

    if (media.mode === "embed") {
      return (
        <iframe
          src={media.url || media.src}
          className="w-full h-full rounded"
          style={{ border: "none" }}
          sandbox="allow-scripts allow-same-origin allow-popups"
        />
      );
    }

    if (media.mode === "link") {
      return (
        <a
          href={media.url || media.src}
          target="_blank"
          rel="noopener noreferrer"
          className="w-full h-full flex flex-col items-center justify-center gap-1 p-3 hover:bg-black/3 transition-colors rounded"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <Link2 className="w-6 h-6 text-blue-500/70" />
          <span className="text-[11px] text-blue-600/80 font-medium truncate max-w-full">{media.url || media.src}</span>
          <span className="text-[9px] text-black/40">Click to open</span>
        </a>
      );
    }

    if (media.mode === "file") {
      return (
        <div className="w-full h-full flex flex-col items-center justify-center gap-1 p-3">
          <FileUp className="w-6 h-6 text-black/40" />
          <span className="text-[11px] text-black/70 font-medium truncate max-w-full">{media.fileName || "File"}</span>
          <span className="text-[9px] text-black/40">{media.mimeType || "Unknown type"}</span>
        </div>
      );
    }

    return null;
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
        if (t?.closest?.("[data-delete-button]") || t?.closest?.("[data-resize-handle]") || t?.closest?.("[data-drag-handle]")) return;
        if (e.shiftKey) toggleSelect(id);
        else if (!isSelected) selectBlocks([id]);
      }}
      onPointerMove={(e) => {
        const r = resizeRef.current;
        if (!r || r.pointerId !== e.pointerId) return;
        if (e.pointerType === "mouse" && e.buttons === 0) { endResize(e.pointerId); return; }
        const dx = e.clientX - r.startClientX;
        const dy = e.clientY - r.startClientY;
        if (r.raf != null) return;
        r.raf = window.requestAnimationFrame(() => {
          const rr = resizeRef.current;
          if (!rr) return;
          rr.raf = null;
          const g = Math.max(1, Math.floor(gridSize || 24));
          const minW = g * 6;
          const minH = g * 4;
          if (rr.mode === "right") { updateBlock(id, { width: Math.max(minW, snapSize(rr.startW + dx)) } as any); return; }
          if (rr.mode === "bottom") { updateBlock(id, { height: Math.max(minH, snapSize(rr.startH + dy)) } as any); return; }
          updateBlock(id, { width: Math.max(minW, snapSize(rr.startW + dx)), height: Math.max(minH, snapSize(rr.startH + dy)) } as any);
        });
      }}
      onPointerUp={(e) => endResize(e.pointerId)}
      onPointerCancel={(e) => endResize(e.pointerId)}
      onLostPointerCapture={(e) => endResize(e.pointerId)}
    >
      <div className={`glass-block overflow-hidden relative ${isSelected ? "omnia-selected-glass" : ""}`} style={{ width: "100%", height: "100%" }}>
        <button
          data-delete-button
          type="button"
          className="absolute top-2 right-2 z-30 w-7 h-7 rounded-full glass-control hover:opacity-90 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity text-black/70 dark:text-white/70 hover:text-red-500 hover:ring-2 hover:ring-red-400/35 hover:shadow-[0_0_16px_rgba(248,113,113,0.35)]"
          onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onClick={(e) => { e.stopPropagation(); pushHistory(); deleteBlock(id); }}
          title="Delete"
        >
          <X className="w-3.5 h-3.5" />
        </button>

        <div
          data-drag-handle
          className="relative z-20 w-full cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ height: "8px" }}
          onPointerDown={startDrag}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
          onLostPointerCapture={onDragEnd}
          title="Drag to move"
        />

        <div className="w-full" style={{ height: "calc(100% - 8px)" }}>
          {renderContent()}
        </div>
      </div>

      {/* Resize handles */}
      <div className="absolute inset-0 pointer-events-none z-10">
        <div data-resize-handle className="absolute top-0 bottom-0 right-0 w-2 pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity" style={{ cursor: "ew-resize" }} onPointerDown={(e) => beginResize(e, "right")} />
        <div data-resize-handle className="absolute left-0 right-0 bottom-0 h-2 pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity" style={{ cursor: "ns-resize" }} onPointerDown={(e) => beginResize(e, "bottom")} />
        <div data-resize-handle className="absolute right-0 bottom-0 w-4 h-4 pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity" style={{ cursor: "nwse-resize" }} onPointerDown={(e) => beginResize(e, "corner")}>
          <div className="w-full h-full rounded-sm" style={{ background: "rgba(255,255,255,0.14)", border: "1px solid rgba(255,255,255,0.22)", boxShadow: "inset 0 0 18px rgba(110, 200, 255, 0.14)" }} />
        </div>
      </div>
    </div>
  );
});
