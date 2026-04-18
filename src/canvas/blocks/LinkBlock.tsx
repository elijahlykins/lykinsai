import React, { memo, useMemo, useRef } from "react";
import { Music2 } from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";
import { snapToGrid } from "@/canvas/utils/snap";
import { BlockHoverToolbar } from "./BlockHoverToolbar";
import { detectSocialPlatform, isSocialEmbedType } from "@/canvas/utils/socialEmbed";
import { SocialEmbedInline } from "./SocialEmbedBlock";
import LinkPreview from "@/components/LinkPreview";

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

type ResizeMode = "right" | "bottom" | "corner";
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
  maxW: number;
  maxH: number;
  raf: number | null;
  capturer: HTMLElement | null;
};

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

function inferPreviewKind(url: string, mimeHint: string, nameHint: string, oembedType?: string) {
  if (isSocialEmbedType(oembedType)) return "social-embed";
  if (detectSocialPlatform(url)) return "social-embed";
  const mime = String(mimeHint || "").toLowerCase();
  const ext = extensionFromName(nameHint || fileNameFromUrl(url));
  if (mime.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "heic", "heif"].includes(ext)) return "image";
  if (mime.startsWith("video/") || ["mp4", "mov", "webm", "mkv", "avi"].includes(ext)) return "video";
  if (mime.startsWith("audio/") || ["mp3", "wav", "m4a", "ogg", "aac", "flac"].includes(ext)) return "audio";
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  return "link";
}

export const LinkBlock = memo(function LinkBlock({ id, onMinimize, onMenu }: { id: string; onMinimize?: (id: string) => void; onMenu?: (id: string, rect: DOMRect) => void }) {
  const block = useCanvasStore((s) => s.blocks[id]);
  const allBlocks = useCanvasStore((s) => s.blocks);
  const selectBlocks = useCanvasStore((s) => s.selectBlocks);
  const toggleSelect = useCanvasStore((s) => s.toggleSelect);
  const isSelected = useCanvasStore((s) => s.selectedIds.includes(id));
  const moveBlocksFromSnapshot = useCanvasStore((s) => s.moveBlocksFromSnapshot);
  const updateBlock = useCanvasStore((s) => s.updateBlock);
  const gridSize = useCanvasStore((s) => s.gridSize);
  const pushHistory = useCanvasStore((s) => s.pushHistory);

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

  const oembedType = isCreate ? String(data.oembedType || "") : "";
  const previewKind = inferPreviewKind(url, mime, name, oembedType);
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

  const beginResize = (e: React.PointerEvent, mode: ResizeMode = "corner") => {
    e.stopPropagation();
    e.preventDefault();
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
    }
    resizeRef.current = {
      pointerId: e.pointerId,
      mode,
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
      const rz = (useCanvasStore.getState() as any).camera?.zoom || 1;
      const dx = (e.clientX - r.startClientX) / rz;
      const dy = (e.clientY - r.startClientY) / rz;
      if (r.raf != null) return;
      r.raf = window.requestAnimationFrame(() => {
        const rr = resizeRef.current;
        if (!rr) return;
        rr.raf = null;
        const min = Math.max(1, Math.floor(gridSize || 24));
        const maxW = snapDownSize(rr.maxW);
        const maxH = snapDownSize(rr.maxH);

        if (rr.mode === "right") {
          let nextW = snapSize(rr.startW + dx);
          if (Number.isFinite(maxW)) nextW = Math.min(nextW, maxW);
          updateBlock(id, { x: rr.startX, y: rr.startY, width: Math.max(min, nextW) } as any);
          return;
        }

        if (rr.mode === "bottom") {
          let nextH = snapSize(rr.startH + dy);
          if (Number.isFinite(maxH)) nextH = Math.min(nextH, maxH);
          updateBlock(id, { x: rr.startX, y: rr.startY, height: Math.max(min, nextH) } as any);
          return;
        }

        const byX = dx;
        const byY = dy * rr.aspect;
        const deltaW = Math.abs(byX) >= Math.abs(byY) ? byX : byY;

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
          width: Math.max(min, nextW),
          height: Math.max(min, nextH),
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
      moveBlocksFromSnapshot(d2.snapshot, d2.lastX - d2.originX, d2.lastY - d2.originY, { snap: false });
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
    if (d.raf != null) {
      window.cancelAnimationFrame(d.raf);
      d.raf = null;
    }
    if (d.snapshot?.length) {
      moveBlocksFromSnapshot(d.snapshot, d.lastX - d.originX, d.lastY - d.originY, { snap: true });
    }
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
      onDoubleClick={(e) => {
        e.stopPropagation();
        open();
      }}
    >
      <BlockHoverToolbar blockId={id} onMinimize={onMinimize} onMenu={onMenu} />
      {/* tab-shaped drag handle above the block */}
      <div
        data-drag-handle
        className="absolute z-30 cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity"
        style={{
          left: "8px",
          top: "-20px",
          width: "72px",
          height: "20px",
          background: "linear-gradient(180deg, rgba(255,255,255,0.72), rgba(255,255,255,0.48))",
          backdropFilter: "blur(4px)",
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
        <div className="w-full relative" style={{ height: "100%" }}>
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
          {previewKind === "social-embed" && (
            <SocialEmbedInline
              platform={oembedType || detectSocialPlatform(url) || "instagram"}
              oembedHtml={String(data.oembedHtml || "")}
              url={url}
              thumbnailUrl={String(data.ogImage || data.image || "")}
              title={String(data.ogTitle || "")}
              authorName={String(data.authorName || "")}
              authorHandle={String(data.authorHandle || "")}
            />
          )}
          {previewKind === "link" && (
            <LinkPreview
              url={url}
              title={String(data.ogTitle || "")}
              description={String(data.ogDescription || "")}
              image={String(data.ogImage || "")}
              siteName={String(data.ogSiteName || "")}
              favicon={String(data.ogFavicon || "")}
              authorName={String(data.authorName || "")}
              authorHandle={String(data.authorHandle || "")}
              oembedType={String(data.oembedType || "")}
              variant="canvas"
              onOpen={open}
            />
          )}

        </div>

        <div className="absolute inset-0 pointer-events-none">
          {/* Right edge stretch */}
          <div
            data-resize-handle
            className="absolute top-0 bottom-0 right-0 w-2 pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity"
            style={{ cursor: "ew-resize" }}
            onPointerDown={(e) => beginResize(e, "right")}
            onPointerMove={onDragMove}
            onPointerUp={onDragEnd}
            onPointerCancel={onDragEnd}
            onLostPointerCapture={onDragEnd}
            title="Resize width"
          />
          {/* Bottom edge stretch */}
          <div
            data-resize-handle
            className="absolute left-0 right-0 bottom-0 h-2 pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity"
            style={{ cursor: "ns-resize" }}
            onPointerDown={(e) => beginResize(e, "bottom")}
            onPointerMove={onDragMove}
            onPointerUp={onDragEnd}
            onPointerCancel={onDragEnd}
            onLostPointerCapture={onDragEnd}
            title="Resize height"
          />
          {/* Bottom-right corner scale */}
          <div
            data-resize-handle
            className="absolute right-0 bottom-0 w-5 h-5 pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity"
            style={{ cursor: "nwse-resize" }}
            onPointerDown={(e) => beginResize(e, "corner")}
            onPointerMove={onDragMove}
            onPointerUp={onDragEnd}
            onPointerCancel={onDragEnd}
            onLostPointerCapture={onDragEnd}
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
    </div>
  );
});

