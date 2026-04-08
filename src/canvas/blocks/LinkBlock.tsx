import React, { memo, useMemo, useRef } from "react";
import { ExternalLink, FileText, Globe, Link as LinkIcon, Music2, Video } from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";
import { snapToGrid } from "@/canvas/utils/snap";
import { BlockHoverToolbar } from "./BlockHoverToolbar";
import { detectSocialPlatform, isSocialEmbedType } from "@/canvas/utils/socialEmbed";
import { SocialEmbedInline } from "./SocialEmbedBlock";

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

  const host = safeHostname(url);
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
          {previewKind === "link" && (() => {
            const ogTitle = String(data.ogTitle || "").trim();
            const ogDesc = String(data.ogDescription || "").trim();
            const ogImage = String(data.ogImage || "").trim();
            const ogSiteName = String(data.ogSiteName || "").trim();
            const ogFavicon = String(data.ogFavicon || "").trim();
            const oembedType = String(data.oembedType || "").trim();
            const authorName = String(data.authorName || "").trim();
            const authorHandle = String(data.authorHandle || "").trim();
            const hasOg = Boolean(ogTitle);

            if (oembedType === "twitter" && ogDesc) {
              return (
                <button
                  type="button"
                  className="w-full h-full flex flex-col text-left overflow-hidden group/bm"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); open(); }}
                  title={url}
                >
                  <div className="p-4 flex flex-col gap-2.5 h-full">
                    <div className="flex items-center gap-2">
                      <svg viewBox="0 0 24 24" className="w-4 h-4 shrink-0 fill-current text-gray-800 dark:text-gray-200" aria-hidden="true">
                        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                      </svg>
                      <div className="min-w-0 flex-1">
                        <span className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate block leading-tight">{authorName}</span>
                        {authorHandle && <span className="text-[0.625rem] text-gray-500 dark:text-gray-400 truncate block leading-tight">{authorHandle}</span>}
                      </div>
                      <ExternalLink className="w-3 h-3 opacity-0 group-hover/bm:opacity-60 transition-opacity shrink-0" />
                    </div>
                    <p className="text-[13px] text-gray-800 dark:text-gray-200 leading-relaxed flex-1 overflow-hidden whitespace-pre-line line-clamp-[12]">{ogDesc}</p>
                    <div className="flex items-center gap-1.5 text-gray-400 dark:text-gray-500 pt-1 border-t border-gray-200/50 dark:border-white/8">
                      <span className="text-[0.6rem]">X (Twitter)</span>
                    </div>
                  </div>
                </button>
              );
            }

            if (hasOg) {
              const domain = ogSiteName || host;
              return (
                <button
                  type="button"
                  className="w-full h-full flex flex-col text-left overflow-hidden group/bm"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); open(); }}
                  title={url}
                >
                  {ogImage && (
                    <div className="w-full flex-1 min-h-0 overflow-hidden bg-black/5">
                      <img
                        src={ogImage}
                        alt=""
                        className="w-full h-full object-cover group-hover/bm:scale-[1.03] transition-transform duration-300"
                        draggable={false}
                        onError={(e) => { (e.currentTarget as HTMLElement).parentElement!.style.display = "none"; }}
                      />
                    </div>
                  )}
                  <div className="p-3 space-y-1 shrink-0">
                    <div className="flex items-center gap-1.5 text-gray-500 dark:text-gray-400">
                      {ogFavicon ? (
                        <img src={ogFavicon} alt="" className="w-3.5 h-3.5 rounded-sm" onError={(e) => { (e.currentTarget as HTMLElement).style.display = "none"; }} />
                      ) : (
                        <Globe className="w-3.5 h-3.5" />
                      )}
                      <span className="text-[0.625rem] font-medium truncate">{domain}</span>
                      <ExternalLink className="w-2.5 h-2.5 ml-auto opacity-0 group-hover/bm:opacity-100 transition-opacity" />
                    </div>
                    <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 leading-snug line-clamp-2">{ogTitle}</p>
                    {ogDesc && <p className="text-xs text-gray-600/80 dark:text-gray-300/70 leading-relaxed line-clamp-2">{ogDesc}</p>}
                  </div>
                </button>
              );
            }
            return (
              <button
                type="button"
                className="w-full h-full px-3 py-2 flex items-center gap-3 text-left"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); open(); }}
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
            );
          })()}

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

