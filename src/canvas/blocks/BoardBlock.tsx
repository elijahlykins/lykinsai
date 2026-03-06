import React, { memo, useEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom";
import { Plus, MoreHorizontal, Copy, Trash2, Palette, CopyPlus, X, Tag, AlignLeft, CheckSquare, Square, Pencil, Eye } from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";
import { snapToGrid } from "@/canvas/utils/snap";

const CARD_COLORS = [
  { label: "Default", value: "" },
  { label: "Blue", value: "rgba(59,130,246,0.08)" },
  { label: "Green", value: "rgba(22,163,74,0.08)" },
  { label: "Amber", value: "rgba(217,119,6,0.08)" },
  { label: "Red", value: "rgba(220,38,38,0.08)" },
  { label: "Purple", value: "rgba(124,58,237,0.08)" },
  { label: "Pink", value: "rgba(219,39,119,0.08)" },
  { label: "Teal", value: "rgba(15,118,110,0.08)" },
];

const CARD_BORDER_MAP: Record<string, string> = {
  "rgba(59,130,246,0.08)": "rgba(59,130,246,0.18)",
  "rgba(22,163,74,0.08)": "rgba(22,163,74,0.18)",
  "rgba(217,119,6,0.08)": "rgba(217,119,6,0.18)",
  "rgba(220,38,38,0.08)": "rgba(220,38,38,0.18)",
  "rgba(124,58,237,0.08)": "rgba(124,58,237,0.18)",
  "rgba(219,39,119,0.08)": "rgba(219,39,119,0.18)",
  "rgba(15,118,110,0.08)": "rgba(15,118,110,0.18)",
};

const LABEL_PALETTE = [
  { bg: "rgba(59,130,246,0.15)", text: "#3b82f6" },
  { bg: "rgba(22,163,74,0.15)", text: "#16a34a" },
  { bg: "rgba(217,119,6,0.15)", text: "#d97706" },
  { bg: "rgba(220,38,38,0.15)", text: "#dc2626" },
  { bg: "rgba(124,58,237,0.15)", text: "#7c3aed" },
  { bg: "rgba(219,39,119,0.15)", text: "#db2777" },
  { bg: "rgba(15,118,110,0.15)", text: "#0f766e" },
];

const DEFAULT_LABEL_NAMES = ["Blue", "Green", "Amber", "Red", "Purple", "Pink", "Teal"];

type LabelDef = { id: string; name: string; colorIdx: number };
type Checklist = { id: string; text: string; done: boolean };
type Card = { id: string; text: string; color?: string; description?: string; labelIds?: string[]; checklist?: Checklist[] };
type Column = { id: string; title: string; cards: Card[] };
type BoardData = { columns: Column[]; labelDefs?: LabelDef[] };

const uid = () => Math.random().toString(36).slice(2, 9);

function defaultLabelDefs(): LabelDef[] {
  return DEFAULT_LABEL_NAMES.map((name, i) => ({ id: uid(), name, colorIdx: i }));
}

const DEFAULT_BOARD: BoardData = {
  columns: [
    { id: uid(), title: "To Do", cards: [{ id: uid(), text: "First task" }, { id: uid(), text: "Second task" }] },
    { id: uid(), title: "In Progress", cards: [{ id: uid(), text: "Working on this" }] },
    { id: uid(), title: "Done", cards: [] },
  ],
  labelDefs: defaultLabelDefs(),
};

function parseBoard(content: string): BoardData {
  try {
    const d = JSON.parse(content);
    const cols = d.columns || DEFAULT_BOARD.columns;
    let labelDefs: LabelDef[] = d.labelDefs;
    if (!labelDefs || labelDefs.length === 0) {
      labelDefs = defaultLabelDefs();
    }
    return { columns: cols, labelDefs };
  } catch {
    return {
      columns: DEFAULT_BOARD.columns.map((c) => ({ ...c, id: uid(), cards: c.cards.map((cd) => ({ ...cd, id: uid() })) })),
      labelDefs: defaultLabelDefs(),
    };
  }
}

type CardMenuState = { colId: string; cardId: string; x: number; y: number; showColors: boolean } | null;
type OpenCard = { colId: string; cardId: string } | null;

export const BoardBlock = memo(function BoardBlock({ id }: { id: string }) {
  const block = useCanvasStore((s) => s.blocks[id]) as any;
  const updateBlock = useCanvasStore((s) => s.updateBlock);
  const pushHistory = useCanvasStore((s) => s.pushHistory);
  const bringToFront = useCanvasStore((s) => s.bringToFront);
  const gridSize = 24;

  const resizeRef = useRef<any>(null);
  const endResizeCleanupRef = useRef<(() => void) | null>(null);
  const [dragCard, setDragCard] = useState<{ cardId: string; fromCol: string } | null>(null);
  const [cardMenu, setCardMenu] = useState<CardMenuState>(null);
  const [openCard, setOpenCard] = useState<OpenCard>(null);

  const board = useMemo(() => parseBoard(String(block?.content ?? "")), [block?.content]);
  const labelDefs = board.labelDefs || [];

  const style = useMemo(() => {
    if (!block || block.format !== "board") return null;
    return { position: "absolute" as const, left: `${block.x}px`, top: `${block.y}px`, width: `${block.width}px`, height: `${block.height}px` };
  }, [block]);

  if (!block || block.format !== "board" || !style) return null;

  const save = (patch: Partial<BoardData>) => {
    pushHistory();
    const next = { columns: board.columns, labelDefs: board.labelDefs, ...patch };
    updateBlock(id, { content: JSON.stringify(next) } as any);
  };

  const saveCols = (cols: Column[]) => save({ columns: cols });

  const addColumn = () => saveCols([...board.columns, { id: uid(), title: "New Column", cards: [] }]);
  const removeColumn = (colId: string) => saveCols(board.columns.filter((c) => c.id !== colId));
  const renameColumn = (colId: string, title: string) => saveCols(board.columns.map((c) => c.id === colId ? { ...c, title } : c));
  const addCard = (colId: string) => saveCols(board.columns.map((c) => c.id === colId ? { ...c, cards: [...c.cards, { id: uid(), text: "" }] } : c));

  const updateCard = (colId: string, cardId: string, patch: Partial<Card>) => {
    saveCols(board.columns.map((c) => c.id === colId ? { ...c, cards: c.cards.map((cd) => cd.id === cardId ? { ...cd, ...patch } : cd) } : c));
  };

  const removeCard = (colId: string, cardId: string) => saveCols(board.columns.map((c) => c.id === colId ? { ...c, cards: c.cards.filter((cd) => cd.id !== cardId) } : c));

  const duplicateCard = (colId: string, cardId: string) => {
    saveCols(board.columns.map((c) => {
      if (c.id !== colId) return c;
      const idx = c.cards.findIndex((cd) => cd.id === cardId);
      if (idx === -1) return c;
      const orig = c.cards[idx];
      const copy = { ...orig, id: uid(), checklist: orig.checklist?.map((cl) => ({ ...cl, id: uid() })) };
      const next = [...c.cards];
      next.splice(idx + 1, 0, copy);
      return { ...c, cards: next };
    }));
  };

  const copyCardText = (colId: string, cardId: string) => {
    const col = board.columns.find((c) => c.id === colId);
    const card = col?.cards.find((cd) => cd.id === cardId);
    if (card?.text) navigator.clipboard.writeText(card.text);
  };

  const moveCard = (cardId: string, fromColId: string, toColId: string) => {
    if (fromColId === toColId) return;
    let card: Card | null = null;
    const cols = board.columns.map((c) => {
      if (c.id === fromColId) {
        card = c.cards.find((cd) => cd.id === cardId) || null;
        return { ...c, cards: c.cards.filter((cd) => cd.id !== cardId) };
      }
      return c;
    });
    if (!card) return;
    saveCols(cols.map((c) => c.id === toColId ? { ...c, cards: [...c.cards, card!] } : c));
  };

  const updateLabelDef = (labelId: string, patch: Partial<LabelDef>) => {
    save({ labelDefs: labelDefs.map((l) => l.id === labelId ? { ...l, ...patch } : l) });
  };

  const getCard = (colId: string, cardId: string): Card | undefined => {
    return board.columns.find((c) => c.id === colId)?.cards.find((cd) => cd.id === cardId);
  };

  const getColumnTitle = (colId: string): string => {
    return board.columns.find((c) => c.id === colId)?.title || "";
  };

  const getLabelDef = (labelId: string): LabelDef | undefined => labelDefs.find((l) => l.id === labelId);

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
    e.stopPropagation(); e.preventDefault(); bringToFront(id);
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

  const colWidth = board.columns.length > 0 ? `${100 / board.columns.length}%` : "100%";
  const activeCard = openCard ? getCard(openCard.colId, openCard.cardId) : null;

  return (
    <div data-canvas-block data-block-id={id} style={style} className="group" onPointerDown={() => bringToFront(id)}>
      <div className="w-full h-full rounded-lg border border-black/10 bg-white/95 shadow-md flex flex-col overflow-hidden">
        <div className="flex-1 flex gap-0 overflow-x-auto min-h-0" onPointerDown={(e) => e.stopPropagation()}>
          {board.columns.map((col) => (
            <div key={col.id} className="flex flex-col border-r border-black/5 last:border-r-0 min-w-[140px]" style={{ width: colWidth }}>
              <div className="flex items-center gap-1 px-2.5 py-1.5 border-b border-black/5 shrink-0" style={{ background: "rgba(0,0,0,0.015)" }}>
                <input className="flex-1 text-[11px] font-semibold bg-transparent outline-none text-black/65 uppercase tracking-wide min-w-0" value={col.title} onChange={(e) => renameColumn(col.id, e.target.value)} />
                <span className="text-[10px] text-black/25 font-medium bg-black/4 rounded-full w-4 h-4 flex items-center justify-center shrink-0">{col.cards.length}</span>
                <button type="button" className="text-black/15 hover:text-red-500 shrink-0 ml-0.5" onClick={() => removeColumn(col.id)}><Trash2 className="w-3 h-3" /></button>
              </div>
              <div
                className="flex-1 overflow-y-auto p-1.5 space-y-1 transition-colors"
                onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add("bg-blue-50/40"); }}
                onDragLeave={(e) => { e.currentTarget.classList.remove("bg-blue-50/40"); }}
                onDrop={(e) => { e.preventDefault(); e.currentTarget.classList.remove("bg-blue-50/40"); if (dragCard) moveCard(dragCard.cardId, dragCard.fromCol, col.id); setDragCard(null); }}
              >
                {col.cards.map((card) => {
                  const bg = card.color || "";
                  const border = bg ? (CARD_BORDER_MAP[bg] || "rgba(0,0,0,0.06)") : "rgba(0,0,0,0.06)";
                  const cardLabels = (card.labelIds || []).map(getLabelDef).filter(Boolean) as LabelDef[];
                  const hasDesc = !!card.description;
                  const hasChecklist = card.checklist && card.checklist.length > 0;
                  const checkDone = card.checklist?.filter((c) => c.done).length || 0;
                  const checkTotal = card.checklist?.length || 0;
                  return (
                    <div
                      key={card.id}
                      className="group/card relative rounded-md px-2 py-1.5 cursor-grab active:cursor-grabbing transition-all hover:shadow-sm"
                      style={{ background: bg || "#fff", border: `1px solid ${border}` }}
                      draggable
                      onDragStart={() => setDragCard({ cardId: card.id, fromCol: col.id })}
                      onDragEnd={() => setDragCard(null)}
                      onPointerUp={(e) => { if (e.button === 0) { e.stopPropagation(); setOpenCard({ colId: col.id, cardId: card.id }); } }}
                    >
                      {cardLabels.length > 0 && (
                        <div className="flex flex-wrap gap-0.5 mb-1">
                          {cardLabels.map((ld) => {
                            const pal = LABEL_PALETTE[ld.colorIdx % LABEL_PALETTE.length];
                            return <span key={ld.id} className="text-[8px] font-medium px-1.5 py-px rounded-full" style={{ background: pal.bg, color: pal.text }}>{ld.name}</span>;
                          })}
                        </div>
                      )}
                      <button type="button" className="absolute top-1 right-1 w-5 h-5 flex items-center justify-center rounded opacity-0 group-hover/card:opacity-100 hover:bg-black/6 transition-all z-[1]" onClick={(e) => { e.stopPropagation(); const rect = e.currentTarget.getBoundingClientRect(); setCardMenu((prev) => prev?.cardId === card.id ? null : { colId: col.id, cardId: card.id, x: rect.right, y: rect.bottom + 2, showColors: false }); }} onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()}>
                        <MoreHorizontal className="w-3 h-3 text-black/40" />
                      </button>
                      <span className="text-[12px] leading-[18px] text-black/75 truncate pr-5">{card.text || <span className="text-black/25">Untitled</span>}</span>
                      {(hasDesc || hasChecklist) && (
                        <div className="flex items-center gap-2 mt-1">
                          {hasDesc && <AlignLeft className="w-3 h-3 text-black/20" />}
                          {hasChecklist && <span className={`flex items-center gap-0.5 text-[9px] font-medium ${checkDone === checkTotal && checkTotal > 0 ? "text-green-600" : "text-black/30"}`}><CheckSquare className="w-3 h-3" /> {checkDone}/{checkTotal}</span>}
                        </div>
                      )}
                    </div>
                  );
                })}
                <button type="button" className="w-full flex items-center justify-center gap-1 text-[10px] text-black/25 hover:text-blue-500 py-1 rounded hover:bg-blue-50/40 transition-colors" onClick={() => addCard(col.id)}><Plus className="w-3 h-3" /></button>
              </div>
            </div>
          ))}
          <div className="flex items-start pt-6 px-2 shrink-0">
            <button type="button" className="flex items-center gap-1 text-[10px] text-black/25 hover:text-blue-500 whitespace-nowrap" onClick={addColumn}><Plus className="w-3 h-3" /> Column</button>
          </div>
        </div>
      </div>

      {/* Card context menu — portaled to body so fixed positioning works under canvas transform */}
      {cardMenu && ReactDOM.createPortal(
        <>
          <div className="fixed inset-0 z-[998]" onClick={() => setCardMenu(null)} />
          <div className="fixed z-[999] bg-white rounded-lg shadow-lg border border-black/10 py-1 min-w-[150px] text-xs" style={{ left: `${cardMenu.x}px`, top: `${cardMenu.y}px`, transform: "translateX(-100%)" }}>
            {!cardMenu.showColors ? (
              <>
                <button type="button" className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-black/70 hover:bg-black/4 transition-colors" onClick={() => { setOpenCard({ colId: cardMenu.colId, cardId: cardMenu.cardId }); setCardMenu(null); }}><Eye className="w-3.5 h-3.5 text-black/40" /> View</button>
                <button type="button" className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-black/70 hover:bg-black/4 transition-colors" onClick={() => { duplicateCard(cardMenu.colId, cardMenu.cardId); setCardMenu(null); }}><CopyPlus className="w-3.5 h-3.5 text-black/40" /> Duplicate</button>
                <button type="button" className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-black/70 hover:bg-black/4 transition-colors" onClick={() => { copyCardText(cardMenu.colId, cardMenu.cardId); setCardMenu(null); }}><Copy className="w-3.5 h-3.5 text-black/40" /> Copy text</button>
                <button type="button" className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-black/70 hover:bg-black/4 transition-colors" onClick={() => setCardMenu({ ...cardMenu, showColors: true })}><Palette className="w-3.5 h-3.5 text-black/40" /> Card color</button>
                <div className="my-1 border-t border-black/6" />
                <button type="button" className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-red-500 hover:bg-red-50 transition-colors" onClick={() => { removeCard(cardMenu.colId, cardMenu.cardId); setCardMenu(null); }}><Trash2 className="w-3.5 h-3.5" /> Delete</button>
              </>
            ) : (
              <>
                <div className="px-3 py-1 text-[10px] text-black/40 font-medium uppercase tracking-wide">Card Color</div>
                {CARD_COLORS.map((c) => (
                  <button key={c.label} type="button" className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-black/70 hover:bg-black/4 transition-colors" onClick={() => { updateCard(cardMenu.colId, cardMenu.cardId, { color: c.value }); setCardMenu(null); }}>
                    <span className="w-3.5 h-3.5 rounded-full border border-black/10 shrink-0" style={{ background: c.value || "#fff" }} />{c.label}
                  </button>
                ))}
              </>
            )}
          </div>
        </>,
        document.body,
      )}

      {/* Card detail modal — portaled to body so it centers on the viewport */}
      {openCard && activeCard && ReactDOM.createPortal(
        <CardDetailModal
          card={activeCard}
          colTitle={getColumnTitle(openCard.colId)}
          labelDefs={labelDefs}
          onUpdate={(patch) => updateCard(openCard.colId, openCard.cardId, patch)}
          onUpdateLabel={updateLabelDef}
          onClose={() => setOpenCard(null)}
        />,
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

/* ─── Card Detail Modal ──────────────────────────────────────────────────── */

function CardDetailModal({ card, colTitle, labelDefs, onUpdate, onUpdateLabel, onClose }: {
  card: Card;
  colTitle: string;
  labelDefs: LabelDef[];
  onUpdate: (patch: Partial<Card>) => void;
  onUpdateLabel: (labelId: string, patch: Partial<LabelDef>) => void;
  onClose: () => void;
}) {
  const [newCheckItem, setNewCheckItem] = useState("");
  const [editingLabelId, setEditingLabelId] = useState<string | null>(null);
  const editLabelRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (editingLabelId) { setEditingLabelId(null); return; }
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, editingLabelId]);

  useEffect(() => {
    if (editingLabelId && editLabelRef.current) editLabelRef.current.focus();
  }, [editingLabelId]);

  const toggleLabel = (labelId: string) => {
    const ids = card.labelIds || [];
    onUpdate({ labelIds: ids.includes(labelId) ? ids.filter((l) => l !== labelId) : [...ids, labelId] });
  };

  const addCheckItem = () => {
    if (!newCheckItem.trim()) return;
    const list = card.checklist || [];
    onUpdate({ checklist: [...list, { id: uid(), text: newCheckItem.trim(), done: false }] });
    setNewCheckItem("");
  };

  const toggleCheckItem = (itemId: string) => {
    onUpdate({ checklist: (card.checklist || []).map((c) => c.id === itemId ? { ...c, done: !c.done } : c) });
  };

  const updateCheckItem = (itemId: string, text: string) => {
    onUpdate({ checklist: (card.checklist || []).map((c) => c.id === itemId ? { ...c, text } : c) });
  };

  const removeCheckItem = (itemId: string) => {
    onUpdate({ checklist: (card.checklist || []).filter((c) => c.id !== itemId) });
  };

  const checkDone = card.checklist?.filter((c) => c.done).length || 0;
  const checkTotal = card.checklist?.length || 0;
  const checkPercent = checkTotal > 0 ? Math.round((checkDone / checkTotal) * 100) : 0;

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-[1000] flex items-center justify-center" onClick={onClose} onPointerDown={(e) => e.stopPropagation()}>
        <div className="bg-white rounded-xl shadow-2xl w-[480px] max-h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()} style={{ animation: "cardModalIn 0.15s ease-out" }}>
          {/* Header */}
          <div className="flex items-start gap-3 px-5 pt-5 pb-3">
            <div className="flex-1 min-w-0">
              <input className="w-full text-base font-semibold bg-transparent outline-none text-black/85 placeholder:text-black/30" value={card.text} placeholder="Card title" onChange={(e) => onUpdate({ text: e.target.value })} autoFocus />
              <div className="text-[11px] text-black/35 mt-0.5">in <span className="font-medium text-black/50">{colTitle}</span></div>
            </div>
            <button type="button" className="w-7 h-7 rounded-md flex items-center justify-center hover:bg-black/5 text-black/35 hover:text-black/60 transition-colors shrink-0" onClick={onClose}><X className="w-4 h-4" /></button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto px-5 pb-5 space-y-5">
            {/* Labels */}
            <section>
              <div className="flex items-center gap-1.5 mb-2">
                <Tag className="w-3.5 h-3.5 text-black/35" />
                <span className="text-[11px] font-semibold text-black/50 uppercase tracking-wide">Labels</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {labelDefs.map((ld) => {
                  const pal = LABEL_PALETTE[ld.colorIdx % LABEL_PALETTE.length];
                  const active = (card.labelIds || []).includes(ld.id);
                  const isEditing = editingLabelId === ld.id;
                  return (
                    <div key={ld.id} className="group/lbl relative flex items-center gap-0">
                      {isEditing ? (
                        <input
                          ref={editLabelRef}
                          className="text-[11px] font-medium px-2.5 py-1 rounded-full outline-none min-w-[50px] w-[80px]"
                          style={{ background: pal.bg, color: pal.text, boxShadow: `inset 0 0 0 1.5px ${pal.text}55` }}
                          value={ld.name}
                          onChange={(e) => onUpdateLabel(ld.id, { name: e.target.value })}
                          onBlur={() => setEditingLabelId(null)}
                          onKeyDown={(e) => { if (e.key === "Enter") setEditingLabelId(null); }}
                        />
                      ) : (
                        <>
                          <button
                            type="button"
                            className="text-[11px] font-medium px-2.5 py-1 rounded-full transition-all"
                            style={{
                              background: active ? pal.bg : "rgba(0,0,0,0.04)",
                              color: active ? pal.text : "rgba(0,0,0,0.4)",
                              boxShadow: active ? `inset 0 0 0 1px ${pal.text}33` : "none",
                            }}
                            onClick={() => toggleLabel(ld.id)}
                          >
                            {ld.name}
                          </button>
                          <button
                            type="button"
                            className="w-4 h-4 flex items-center justify-center rounded-full opacity-0 group-hover/lbl:opacity-100 hover:bg-black/8 transition-all -ml-1"
                            style={{ color: active ? pal.text : "rgba(0,0,0,0.35)" }}
                            onClick={() => setEditingLabelId(ld.id)}
                          >
                            <Pencil className="w-2.5 h-2.5" />
                          </button>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>

            {/* Description */}
            <section>
              <div className="flex items-center gap-1.5 mb-2">
                <AlignLeft className="w-3.5 h-3.5 text-black/35" />
                <span className="text-[11px] font-semibold text-black/50 uppercase tracking-wide">Description</span>
              </div>
              <textarea className="w-full rounded-lg border border-black/8 bg-gray-50/50 px-3 py-2 text-[13px] text-black/75 placeholder:text-black/30 outline-none resize-none transition-colors focus:border-blue-400/40 focus:bg-white" rows={4} value={card.description || ""} placeholder="Add a detailed description..." onChange={(e) => onUpdate({ description: e.target.value })} />
            </section>

            {/* Checklist */}
            <section>
              <div className="flex items-center gap-1.5 mb-2">
                <CheckSquare className="w-3.5 h-3.5 text-black/35" />
                <span className="text-[11px] font-semibold text-black/50 uppercase tracking-wide">Checklist</span>
                {checkTotal > 0 && <span className={`text-[10px] font-medium ml-auto ${checkDone === checkTotal ? "text-green-600" : "text-black/30"}`}>{checkPercent}%</span>}
              </div>
              {checkTotal > 0 && (
                <div className="w-full h-1.5 rounded-full bg-black/5 mb-2 overflow-hidden">
                  <div className="h-full rounded-full transition-all duration-300" style={{ width: `${checkPercent}%`, background: checkDone === checkTotal ? "#16a34a" : "#3b82f6" }} />
                </div>
              )}
              <div className="space-y-1">
                {(card.checklist || []).map((item) => (
                  <div key={item.id} className="group/check flex items-center gap-2 py-0.5 rounded hover:bg-black/2 px-1 -mx-1">
                    <button type="button" className="shrink-0 text-black/40 hover:text-blue-500" onClick={() => toggleCheckItem(item.id)}>
                      {item.done ? <CheckSquare className="w-4 h-4 text-blue-500" /> : <Square className="w-4 h-4" />}
                    </button>
                    <input className={`flex-1 text-[13px] bg-transparent outline-none min-w-0 ${item.done ? "line-through text-black/35" : "text-black/70"}`} value={item.text} onChange={(e) => updateCheckItem(item.id, e.target.value)} />
                    <button type="button" className="shrink-0 opacity-0 group-hover/check:opacity-100 text-black/20 hover:text-red-500 transition-opacity" onClick={() => removeCheckItem(item.id)}><X className="w-3 h-3" /></button>
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-2 mt-1.5">
                <input className="flex-1 text-[12px] bg-transparent outline-none text-black/60 placeholder:text-black/25 border-b border-transparent focus:border-black/10 py-0.5" placeholder="Add an item..." value={newCheckItem} onChange={(e) => setNewCheckItem(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addCheckItem(); }} />
                <button type="button" className="text-[11px] text-blue-500 hover:text-blue-600 font-medium shrink-0" onClick={addCheckItem}>Add</button>
              </div>
            </section>
          </div>
        </div>
      </div>
      <style>{`@keyframes cardModalIn { from { opacity: 0; transform: scale(0.95) translateY(8px); } to { opacity: 1; transform: scale(1) translateY(0); } }`}</style>
    </>
  );
}
