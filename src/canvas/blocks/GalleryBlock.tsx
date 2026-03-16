import React, { memo, useEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom";
import { Plus, Trash2, ImageIcon, X, LayoutGrid, MoreHorizontal, Copy, Palette, CopyPlus, Link } from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";
import { snapToGrid } from "@/canvas/utils/snap";
import { BlockHoverToolbar } from "./BlockHoverToolbar";

const CARD_BG_COLORS = [
  { label: "Default", value: "" },
  { label: "Blue", value: "rgba(59,130,246,0.08)" },
  { label: "Green", value: "rgba(22,163,74,0.08)" },
  { label: "Amber", value: "rgba(217,119,6,0.08)" },
  { label: "Red", value: "rgba(220,38,38,0.08)" },
  { label: "Purple", value: "rgba(124,58,237,0.08)" },
  { label: "Pink", value: "rgba(219,39,119,0.08)" },
  { label: "Teal", value: "rgba(15,118,110,0.08)" },
];

type GalleryCard = { id: string; title: string; description: string; imageUrl: string; color: string; tags: string[] };
type GalleryData = { title: string; cards: GalleryCard[]; columns: number };

const uid = () => Math.random().toString(36).slice(2, 9);

const DEFAULT_GALLERY: GalleryData = {
  title: "Gallery",
  columns: 3,
  cards: [
    { id: uid(), title: "Card One", description: "A brief description of this item", imageUrl: "", color: "rgba(59,130,246,0.08)", tags: ["design"] },
    { id: uid(), title: "Card Two", description: "Another item in the gallery", imageUrl: "", color: "rgba(22,163,74,0.08)", tags: ["dev"] },
    { id: uid(), title: "Card Three", description: "Yet another gallery card", imageUrl: "", color: "rgba(217,119,6,0.08)", tags: [] },
    { id: uid(), title: "Card Four", description: "More content here", imageUrl: "", color: "rgba(124,58,237,0.08)", tags: ["design"] },
  ],
};

function parseGallery(content: string): GalleryData {
  try {
    const d = JSON.parse(content);
    return { title: d.title || "Gallery", cards: d.cards || DEFAULT_GALLERY.cards, columns: d.columns || 3 };
  } catch {
    return { ...DEFAULT_GALLERY, cards: DEFAULT_GALLERY.cards.map((c) => ({ ...c, id: uid() })) };
  }
}

export const GalleryBlock = memo(function GalleryBlock({ id, onMinimize, onMenu }: { id: string; onMinimize?: (id: string) => void; onMenu?: (id: string, rect: DOMRect) => void }) {
  const block = useCanvasStore((s) => s.blocks[id]) as any;
  const updateBlock = useCanvasStore((s) => s.updateBlock);
  const pushHistory = useCanvasStore((s) => s.pushHistory);
  const gridSize = 24;

  const resizeRef = useRef<any>(null);
  const endResizeCleanupRef = useRef<(() => void) | null>(null);
  const [openCardId, setOpenCardId] = useState<string | null>(null);

  const gallery = useMemo(() => parseGallery(String(block?.content ?? "")), [block?.content]);

  const style = useMemo(() => {
    if (!block || block.format !== "gallery") return null;
    return { position: "absolute" as const, left: `${block.x}px`, top: `${block.y}px`, width: `${block.width}px`, height: `${block.height}px` };
  }, [block]);

  if (!block || block.format !== "gallery" || !style) return null;

  const save = (patch: Partial<GalleryData>) => {
    const next = { ...gallery, ...patch };
    pushHistory();
    updateBlock(id, { content: JSON.stringify(next) } as any);
  };

  const addCard = () => {
    save({ cards: [...gallery.cards, { id: uid(), title: "New Card", description: "", imageUrl: "", color: CARD_BG_COLORS[(gallery.cards.length % (CARD_BG_COLORS.length - 1)) + 1].value, tags: [] }] });
  };

  const snapSize = (n: number) => Math.max(gridSize, snapToGrid(n, gridSize));

  const endResize = (pointerId: number) => {
    const r = resizeRef.current;
    if (!r || r.pointerId !== pointerId) return;
    if (r.raf != null) window.cancelAnimationFrame(r.raf);
    if (endResizeCleanupRef.current) { try { endResizeCleanupRef.current(); } catch {} endResizeCleanupRef.current = null; }
    if (r.capturer) { try { r.capturer.releasePointerCapture(pointerId); } catch {} }
    resizeRef.current = null;
  };

  const beginResize = (e: React.PointerEvent, mode: "right" | "bottom" | "corner") => {
    e.stopPropagation(); e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const onUp = (ev: PointerEvent) => { if (ev.pointerId === e.pointerId) endResize(e.pointerId); };
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    endResizeCleanupRef.current = () => { window.removeEventListener("pointerup", onUp, true); window.removeEventListener("pointercancel", onUp, true); };
    resizeRef.current = { mode, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, origW: block.width, origH: block.height, raf: null, capturer: el };
  };

  const onResizeMove = (e: React.PointerEvent) => {
    const r = resizeRef.current;
    if (!r || r.pointerId !== e.pointerId) return;
    if (r.raf != null) window.cancelAnimationFrame(r.raf);
    const dx = e.clientX - r.startX; const dy = e.clientY - r.startY;
    r.raf = window.requestAnimationFrame(() => {
      updateBlock(id, { width: r.mode !== "bottom" ? snapSize(r.origW + dx) : r.origW, height: r.mode !== "right" ? snapSize(r.origH + dy) : r.origH } as any);
    });
  };

  const openCard = openCardId ? gallery.cards.find((c) => c.id === openCardId) : null;

  const onCardUpdate = (patch: Partial<GalleryCard>) => {
    if (!openCardId) return;
    pushHistory();
    const cards = gallery.cards.map((c) => c.id === openCardId ? { ...c, ...patch } : c);
    updateBlock(id, { content: JSON.stringify({ ...gallery, cards }) } as any);
  };

  const onCardDuplicate = () => {
    if (!openCardId) return;
    pushHistory();
    const idx = gallery.cards.findIndex((c) => c.id === openCardId);
    if (idx === -1) return;
    const copy = { ...gallery.cards[idx], id: uid() };
    const next = [...gallery.cards];
    next.splice(idx + 1, 0, copy);
    updateBlock(id, { content: JSON.stringify({ ...gallery, cards: next }) } as any);
    setOpenCardId(null);
  };

  const onCardDelete = () => {
    if (!openCardId) return;
    pushHistory();
    const cards = gallery.cards.filter((c) => c.id !== openCardId);
    updateBlock(id, { content: JSON.stringify({ ...gallery, cards }) } as any);
    setOpenCardId(null);
  };

  return (
    <div data-canvas-block data-block-id={id} style={style} className="group">
      <BlockHoverToolbar blockId={id} onMinimize={onMinimize} onMenu={onMenu} />
      <div className="w-full h-full rounded-lg border border-black/10 bg-white shadow-md flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-black/5 shrink-0" style={{ background: "rgba(0,0,0,0.015)" }} onPointerDown={(e) => e.stopPropagation()}>
          <input className="flex-1 text-[13px] font-semibold bg-transparent outline-none text-black/80 placeholder:text-black/30" value={gallery.title} onChange={(e) => save({ title: e.target.value })} placeholder="Gallery title" />
          <div className="flex items-center gap-0.5">
            {[2, 3, 4].map((n) => (
              <button key={n} type="button" className={`w-5 h-5 rounded text-center text-[10px] transition-colors ${gallery.columns === n ? "bg-blue-500/15 text-blue-600 font-medium" : "text-black/35 hover:bg-black/5"}`} onClick={() => save({ columns: n })}>{n}</button>
            ))}
          </div>
          <button type="button" className="flex items-center gap-1 text-[10px] text-blue-500 hover:text-blue-600 font-medium" onClick={addCard}><Plus className="w-3 h-3" /></button>
        </div>

        {/* Grid */}
        <div className="flex-1 overflow-y-auto p-2 gap-2 relative" style={{ display: "grid", gridTemplateColumns: `repeat(${gallery.columns}, 1fr)`, alignContent: "start" }} onPointerDown={(e) => e.stopPropagation()}>
          {gallery.cards.map((card) => (
            <div
              key={card.id}
              className="rounded-lg border border-black/6 overflow-hidden group/card cursor-pointer transition-shadow hover:shadow-sm"
              style={{ background: card.color || "#fff" }}
              onPointerUp={(e) => { if (e.button === 0) { e.stopPropagation(); setOpenCardId(card.id); } }}
            >
              {card.imageUrl ? (
                <div className="aspect-video bg-cover bg-center" style={{ backgroundImage: `url(${card.imageUrl})` }} />
              ) : (
                <div className="aspect-video flex items-center justify-center" style={{ background: "rgba(0,0,0,0.025)" }}>
                  <ImageIcon className="w-5 h-5 text-black/12" />
                </div>
              )}
              <div className="px-2.5 py-2 space-y-0.5">
                <div className="text-[12px] font-semibold text-black/75 truncate">{card.title || "Untitled"}</div>
                {card.description && <div className="text-[10px] text-black/40 line-clamp-2">{card.description}</div>}
                {card.tags?.length > 0 && (
                  <div className="flex flex-wrap gap-0.5 pt-0.5">
                    {card.tags.map((t, i) => <span key={i} className="text-[9px] px-1.5 py-px rounded-full bg-black/5 text-black/40 font-medium">{t}</span>)}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Card modal — portaled to body */}
      {openCard && ReactDOM.createPortal(
        <GalleryCardModal card={openCard} onUpdate={onCardUpdate} onDuplicate={onCardDuplicate} onDelete={onCardDelete} onClose={() => setOpenCardId(null)} />,
        document.body,
      )}

      {/* Resize handles */}
      <div data-resize-handle className="absolute top-0 right-0 h-full w-2 cursor-ew-resize opacity-0 group-hover:opacity-100 hover:bg-blue-400/20 transition-opacity rounded-r" onPointerDown={(e) => beginResize(e, "right")} onPointerMove={onResizeMove} />
      <div data-resize-handle className="absolute bottom-0 left-0 w-full h-2 cursor-ns-resize opacity-0 group-hover:opacity-100 hover:bg-blue-400/20 transition-opacity rounded-b" onPointerDown={(e) => beginResize(e, "bottom")} onPointerMove={onResizeMove} />
      <div data-resize-handle className="absolute bottom-0 right-0 w-4 h-4 cursor-nwse-resize opacity-0 group-hover:opacity-100 transition-opacity z-10" onPointerDown={(e) => beginResize(e, "corner")} onPointerMove={onResizeMove}>
        <svg viewBox="0 0 16 16" className="w-full h-full text-black/25"><path d="M14 14L6 14M14 14L14 6M14 14L8 8" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" /></svg>
      </div>
    </div>
  );
});

/* ─── Kept for backwards compatibility with Canvas.tsx import ─────────── */
export function GalleryModalPortal() { return null; }

/* ─── Gallery Card Modal ─────────────────────────────────────────────────── */

function GalleryCardModal({ card, onUpdate, onDuplicate, onDelete, onClose }: {
  card: GalleryCard;
  onUpdate: (patch: Partial<GalleryCard>) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const handleLocalFile = async (file: File) => {
    if (!file.type.startsWith("image/") && !/\.(heic|heif)$/i.test(file.name || "")) return;
    try {
      const { fileToDisplayableDataUrl } = await import("@/lib/heifToJpeg");
      const dataUrl = await fileToDisplayableDataUrl(file);
      onUpdate({ imageUrl: dataUrl });
      window.dispatchEvent(new CustomEvent("omnia_save_file_to_media", { detail: { file } }));
    } catch (err) {
      console.warn("[GalleryBlock] Failed to load image:", err);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);

    const pending = (window as any).__omnia_pending_memory;
    if (pending && typeof pending === "object") {
      (window as any).__omnia_pending_memory = null;
      const attachments = Array.isArray(pending.attachments) ? pending.attachments : [];
      const imgAtt = attachments.find((a: any) => a.type === "image" && a.url);
      if (imgAtt) { onUpdate({ imageUrl: imgAtt.url }); return; }
    }

    const files = e.dataTransfer.files;
    if (files.length > 0 && (files[0].type.startsWith("image/") || /\.(heic|heif)$/i.test(files[0].name || ""))) {
      handleLocalFile(files[0]);
      return;
    }

    const url = e.dataTransfer.getData("text/plain");
    if (url && /^https?:\/\/.+\.(jpg|jpeg|png|gif|webp|svg)/i.test(url)) {
      onUpdate({ imageUrl: url });
      window.dispatchEvent(new CustomEvent("omnia_save_to_media", { detail: { url, name: "Image", fileType: "image" } }));
    }
  };

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === "omnia-memory-drag-start" && e.data.data) {
        (window as any).__omnia_pending_memory = { ...e.data.data, timestamp: Date.now() };
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-[1000] flex items-center justify-center" onClick={onClose} onPointerDown={(e) => e.stopPropagation()}>
        <div className="bg-white rounded-xl shadow-2xl w-[480px] max-h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()} style={{ animation: "galleryModalIn 0.15s ease-out" }}>
          {/* Image area — drop zone + preview */}
          <div
            className={`relative w-full aspect-video shrink-0 transition-colors ${dragOver ? "ring-2 ring-blue-400 ring-inset" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
          >
            {card.imageUrl ? (
              <>
                <div className="w-full h-full bg-cover bg-center" style={{ backgroundImage: `url(${card.imageUrl})` }} />
                <div className="absolute inset-0 flex items-end justify-end gap-1.5 p-2 opacity-0 hover:opacity-100 transition-opacity" style={{ background: "linear-gradient(transparent 50%, rgba(0,0,0,0.4))" }}>
                  <button type="button" className="text-[10px] font-medium text-white/90 bg-black/40 hover:bg-black/60 backdrop-blur-sm px-2.5 py-1 rounded-md transition-colors" onClick={() => onUpdate({ imageUrl: "" })}>Remove</button>
                  <button type="button" className="text-[10px] font-medium text-white/90 bg-black/40 hover:bg-black/60 backdrop-blur-sm px-2.5 py-1 rounded-md transition-colors" onClick={() => fileInputRef.current?.click()}>Upload</button>
                  <button type="button" className="text-[10px] font-medium text-white/90 bg-black/40 hover:bg-black/60 backdrop-blur-sm px-2.5 py-1 rounded-md transition-colors" onClick={() => window.dispatchEvent(new CustomEvent("omnia_open_memory_sidebar"))}>Media</button>
                </div>
              </>
            ) : (
              <div className={`w-full h-full flex flex-col items-center justify-center gap-2 ${dragOver ? "bg-blue-50/60" : ""}`} style={{ background: dragOver ? undefined : (card.color || "rgba(0,0,0,0.03)") }}>
                {dragOver ? (
                  <>
                    <ImageIcon className="w-8 h-8 text-blue-400" />
                    <span className="text-[12px] text-blue-500 font-medium">Drop image here</span>
                  </>
                ) : (
                  <>
                    <ImageIcon className="w-8 h-8 text-black/10" />
                    <div className="flex items-center gap-2">
                      <button type="button" className="text-[11px] font-medium text-blue-500 hover:text-blue-600 bg-blue-50 hover:bg-blue-100/80 px-3 py-1.5 rounded-lg transition-colors" onClick={() => fileInputRef.current?.click()}>
                        Upload
                      </button>
                      <button
                        type="button"
                        className="text-[11px] font-medium text-black/50 hover:text-black/70 bg-black/4 hover:bg-black/8 px-3 py-1.5 rounded-lg transition-colors"
                        onClick={() => window.dispatchEvent(new CustomEvent("omnia_open_memory_sidebar"))}
                      >
                        Browse Media
                      </button>
                    </div>
                    <span className="text-[10px] text-black/20 mt-1">or drag an image here</span>
                  </>
                )}
              </div>
            )}
            <input ref={fileInputRef} type="file" accept="image/*,.heic,.heif" className="hidden" onChange={(e) => { if (e.target.files?.[0]) handleLocalFile(e.target.files[0]); e.target.value = ""; }} />
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
            <input className="w-full text-base font-semibold bg-transparent outline-none text-black/85 placeholder:text-black/30" value={card.title} placeholder="Card title" onChange={(e) => onUpdate({ title: e.target.value })} autoFocus />

            <div>
              <div className="flex items-center gap-1.5 mb-1.5">
                <Link className="w-3.5 h-3.5 text-black/35" />
                <span className="text-[11px] font-semibold text-black/45 uppercase tracking-wide">Image URL</span>
              </div>
              <input className="w-full rounded-lg border border-black/8 bg-gray-50/40 px-3 py-2 text-[12px] text-black/65 placeholder:text-black/25 outline-none focus:border-blue-400/40 focus:bg-white transition-colors" value={card.imageUrl} placeholder="Paste URL or drag from Media panel" onChange={(e) => onUpdate({ imageUrl: e.target.value })} />
            </div>

            <div>
              <div className="flex items-center gap-1.5 mb-1.5">
                <span className="text-[11px] font-semibold text-black/45 uppercase tracking-wide">Description</span>
              </div>
              <textarea className="w-full rounded-lg border border-black/8 bg-gray-50/40 px-3 py-2 text-[13px] text-black/70 placeholder:text-black/25 outline-none resize-none focus:border-blue-400/40 focus:bg-white transition-colors" rows={3} value={card.description} placeholder="Add a description..." onChange={(e) => onUpdate({ description: e.target.value })} />
            </div>

            <div>
              <div className="flex items-center gap-1.5 mb-1.5">
                <span className="text-[11px] font-semibold text-black/45 uppercase tracking-wide">Tags</span>
              </div>
              <input className="w-full rounded-lg border border-black/8 bg-gray-50/40 px-3 py-2 text-[12px] text-black/60 placeholder:text-black/25 outline-none focus:border-blue-400/40 focus:bg-white transition-colors" value={(card.tags || []).join(", ")} placeholder="Comma separated tags" onChange={(e) => onUpdate({ tags: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />
              {card.tags?.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {card.tags.map((t, i) => <span key={i} className="text-[10px] px-2 py-0.5 rounded-full bg-black/5 text-black/50 font-medium">{t}</span>)}
                </div>
              )}
            </div>

            <div>
              <div className="flex items-center gap-1.5 mb-1.5">
                <Palette className="w-3.5 h-3.5 text-black/35" />
                <span className="text-[11px] font-semibold text-black/45 uppercase tracking-wide">Card Color</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {CARD_BG_COLORS.map((c) => (
                  <button key={c.label} type="button" className={`w-7 h-7 rounded-full border-2 transition-all ${card.color === c.value ? "border-blue-500 scale-110" : "border-black/8 hover:border-black/15"}`} style={{ background: c.value || "#fff" }} title={c.label} onClick={() => onUpdate({ color: c.value })} />
                ))}
              </div>
            </div>

            <div className="flex items-center gap-2 pt-2 border-t border-black/5">
              <button type="button" className="flex items-center gap-1.5 text-[11px] text-black/50 hover:text-blue-500 font-medium px-2 py-1 rounded-md hover:bg-blue-50/50 transition-colors" onClick={onDuplicate}><CopyPlus className="w-3.5 h-3.5" /> Duplicate</button>
              <button type="button" className="flex items-center gap-1.5 text-[11px] text-red-400 hover:text-red-500 font-medium px-2 py-1 rounded-md hover:bg-red-50 transition-colors" onClick={onDelete}><Trash2 className="w-3.5 h-3.5" /> Delete</button>
              <div className="flex-1" />
              <button type="button" className="text-[11px] text-black/40 hover:text-black/60 font-medium px-3 py-1.5 rounded-md hover:bg-black/5 transition-colors" onClick={onClose}>Done</button>
            </div>
          </div>
        </div>
      </div>
      <style>{`@keyframes galleryModalIn { from { opacity: 0; transform: scale(0.95) translateY(8px); } to { opacity: 1; transform: scale(1) translateY(0); } }`}</style>
    </>
  );
}
