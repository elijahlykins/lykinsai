import React, { memo, useEffect, useMemo, useRef } from "react";
import { X } from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";
import { snapToGrid } from "@/canvas/utils/snap";

function normalizeNewlines(s: string) {
  return String(s ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function extractTextFromEditable(el: HTMLElement | null) {
  if (!el) return "";
  const parts: string[] = [];
  const appendText = (t: string) => {
    if (!t) return;
    parts.push(t);
  };
  const appendBreak = () => {
    const last = parts[parts.length - 1] ?? "";
    if (!last.endsWith("\n")) parts.push("\n");
  };
  const isBlockTag = (tag: string) => tag === "DIV" || tag === "P" || tag === "LI";
  const walk = (node: Node | null) => {
    if (!node) return;
    if (node.nodeType === Node.TEXT_NODE) {
      appendText((node as Text).textContent ?? "");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = (node as Element).tagName;
    if (tag === "BR") {
      appendBreak();
      return;
    }
    const children = Array.from(node.childNodes || []);
    for (const child of children) walk(child);
    if (isBlockTag(tag)) appendBreak();
  };
  walk(el);
  return normalizeNewlines(parts.join(""));
}

function getEditorPlainText(el: HTMLElement | null) {
  if (!el) return "";
  // Prefer DOM-walk extraction so empty lines (Enter spam) are preserved reliably.
  const extracted = extractTextFromEditable(el);
  if (extracted.length) return extracted;
  // Fallback (should be rare)
  return normalizeNewlines(String(el.textContent ?? ""));
}

function getCaretOffsetInElement(el: HTMLElement) {
  const sel = window.getSelection?.();
  if (!sel || sel.rangeCount === 0) return 0;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer)) return 0;
  const pre = range.cloneRange();
  pre.selectNodeContents(el);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString().length;
}

function setCaretOffsetInElement(el: HTMLElement | null, offset: number) {
  if (!el) return;
  const sel = window.getSelection?.();
  if (!sel) return;
  const range = document.createRange();
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let remaining = Math.max(0, Math.floor(offset || 0));
  let node: Text | null = walker.nextNode() as Text | null;
  while (node) {
    const len = node.textContent?.length ?? 0;
    if (remaining <= len) {
      range.setStart(node, remaining);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      return;
    }
    remaining -= len;
    node = walker.nextNode() as Text | null;
  }
  range.selectNodeContents(el);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

function measureSheetTextFits(args: { text: string; widthPx: number; heightPx: number; sampleEl: HTMLElement | null }) {
  const { text, widthPx, heightPx, sampleEl } = args;
  const measurer = document.createElement("div");
  measurer.style.position = "fixed";
  measurer.style.left = "-100000px";
  measurer.style.top = "-100000px";
  measurer.style.visibility = "hidden";
  measurer.style.pointerEvents = "none";
  measurer.style.whiteSpace = "pre-wrap";
  measurer.style.wordBreak = "break-word";
  measurer.style.overflow = "hidden";
  measurer.style.width = `${Math.max(0, widthPx)}px`;
  measurer.style.height = `${Math.max(0, heightPx)}px`;
  measurer.style.boxSizing = "border-box";
  try {
    if (sampleEl) {
      const cs = window.getComputedStyle(sampleEl);
      measurer.style.fontFamily = cs.fontFamily;
      measurer.style.fontSize = cs.fontSize;
      measurer.style.fontWeight = cs.fontWeight;
      measurer.style.lineHeight = cs.lineHeight;
      measurer.style.letterSpacing = cs.letterSpacing;
      measurer.style.padding = cs.padding;
    }
  } catch {
    // ignore
  }
  measurer.textContent = text ?? "";
  document.body.appendChild(measurer);
  const fits = measurer.scrollHeight <= measurer.clientHeight + 1;
  document.body.removeChild(measurer);
  return fits;
}

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

export const SheetBlock = memo(function SheetBlock({ id }: { id: string }) {
  const block = useCanvasStore((s) => s.blocks[id]);
  const gridSize = useCanvasStore((s) => s.gridSize);
  const bringToFront = useCanvasStore((s) => s.bringToFront);
  const selectBlocks = useCanvasStore((s) => s.selectBlocks);
  const toggleSelect = useCanvasStore((s) => s.toggleSelect);
  const isSelected = useCanvasStore((s) => s.selectedIds.includes(id));
  const updateBlock = useCanvasStore((s) => s.updateBlock);
  const addSheetBlockAt = useCanvasStore((s) => s.addSheetBlockAt);
  const moveBlocksFromSnapshot = useCanvasStore((s) => s.moveBlocksFromSnapshot);
  const pushHistory = useCanvasStore((s) => s.pushHistory);
  const deleteBlock = useCanvasStore((s) => s.deleteBlock);

  const editorRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const paginatingRef = useRef(false);
  const lastEnterRef = useRef<number>(0);

  const style = useMemo(() => {
    if (!block || block.type !== "text") return null;
    const fmt = String(block.format || "rich");
    if (fmt !== "rich" && fmt !== "markdown" && fmt !== "plain") return null;
    return {
      position: "absolute" as const,
      left: `${block.x}px`,
      top: `${block.y}px`,
      width: `${block.width}px`,
      height: `${block.height}px`,
      overflow: "visible",
    };
  }, [block]);

  if (!block || block.type !== "text" || !style) return null;

  const g = Math.max(1, Math.floor(gridSize || 24));
  const defaultFontFamily =
    'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"';
  const defaultLetterSpacing = "-0.01em";

  // Keep DOM in sync from store when NOT focused.
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    if (document.activeElement === el) return;
    const next = String(block.content ?? "");
    // Use innerText so newline-only pages (Enter spam) remain consistent.
    const cur = getEditorPlainText(el);
    if (cur !== normalizeNewlines(next)) el.textContent = next;
  }, [block.content]);

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
      const dx2 = d2.lastX - d2.originX;
      const dy2 = d2.lastY - d2.originY;
      moveBlocksFromSnapshot(d2.snapshot, dx2, dy2, { snap: true });
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

  const paginateIfNeeded = () => {
    const el = editorRef.current;
    if (!el) return;
    if (paginatingRef.current) return;
    if (block.paginate === false) return;

    // Trigger pagination from actual overflow, not just string measurement.
    // This ensures "press Enter until full" still creates a new page.
    const overflowed = (el.scrollHeight || 0) > (el.clientHeight || 0) + 2;
    if (!overflowed) return;

    const fullText = getEditorPlainText(el);
    const caret = getCaretOffsetInElement(el);
    const rawText = normalizeNewlines(el.textContent ?? "");
    const atEndByRaw = caret >= Math.max(0, (rawText.length || 0) - 1);
    const atEndByFull = caret >= Math.max(0, (fullText.length || 0) - 1);
    const recentEnter = Date.now() - (lastEnterRef.current || 0) < 400;
    const atEnd = atEndByFull || atEndByRaw || (recentEnter && atEndByRaw);
    if (!atEnd) return;

    const groupId = block.groupId;
    const state = useCanvasStore.getState();
    const pages = Object.values(state.blocks).filter((b) => b.type === "sheet" && (b as any).groupId === groupId) as any[];
    const maxY = pages.reduce((m, bb) => Math.max(m, Number(bb?.y) || 0), -Infinity);
    const isLastPage = (block.y ?? 0) >= (Number.isFinite(maxY) ? maxY : (block.y ?? 0));
    if (!isLastPage) return;

    const widthPx = el.clientWidth;
    const heightPx = el.clientHeight;
    const fits = measureSheetTextFits({ text: fullText, widthPx, heightPx, sampleEl: el });
    if (fits) return;

    const existingPages = pages.length;
    const MAX_PAGES = 1000;
    if (existingPages >= MAX_PAGES) {
      // Safety cap: if someone creates an extreme number of pages, fall back to internal scroll
      // so the user can keep typing (but in normal use we keep fixed-page pagination).
      updateBlock(id, { paginate: false } as any);
      return;
    }

    paginatingRef.current = true;
    try {
      const gap = g; // 1 brick gap
      const maxNewPages = MAX_PAGES - existingPages;

      const chunks: string[] = [];
      let remaining = fullText;
      for (let i = 0; i < maxNewPages + 1; i += 1) {
        const ok = measureSheetTextFits({ text: remaining, widthPx, heightPx, sampleEl: el });
        if (ok) {
          chunks.push(remaining);
          remaining = "";
          break;
        }

        // Find largest prefix that fits.
        let lo = 0;
        let hi = remaining.length;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          const okMid = measureSheetTextFits({ text: remaining.slice(0, mid), widthPx, heightPx, sampleEl: el });
          if (okMid) lo = mid;
          else hi = mid - 1;
        }
        let split = Math.max(0, Math.min(remaining.length, lo));
        if (split >= remaining.length) split = Math.max(0, remaining.length - 1);
        const nl = remaining.lastIndexOf("\n", Math.max(0, split - 1));
        if (nl >= 0 && nl + 1 > 0 && nl + 1 < remaining.length) split = nl + 1;
        if (split <= 0 && remaining.length > 0) split = 1;

        chunks.push(remaining.slice(0, split));
        remaining = remaining.slice(split);
        if (remaining.length === 0) break;
        if (i >= maxNewPages - 1) break;
      }

      const hitLimitWithOverflow = remaining.length > 0 && existingPages + chunks.length >= MAX_PAGES;
      if (hitLimitWithOverflow) {
        // If we hit the hard page cap with overflow, fall back to internal scroll to avoid losing input.
        updateBlock(id, { paginate: false } as any);
        return;
      }

      const first = chunks[0] ?? "";
      const rest = chunks.slice(1);

      // Update current page to the first chunk (and keep DOM in sync).
      el.textContent = first;
      updateBlock(id, { content: first } as any);

      if (rest.length) {
        const baseX = block.x ?? 0;
        const startY = block.y ?? 0;
        const newIds: string[] = [];
        for (let idx = 0; idx < rest.length; idx += 1) {
          const textChunk = rest[idx];
          const y = startY + (block.height + gap) * (idx + 1);
          const snappedY = snapToGrid(y, g);
          const idNew = addSheetBlockAt(
            { x: baseX, y: snappedY },
            {
              width: block.width,
              height: block.height,
              content: textChunk,
              groupId,
            }
          );
          newIds.push(idNew);
        }

        const lastId = newIds[newIds.length - 1];
        requestAnimationFrame(() => {
          const lastEl = document.querySelector(`[data-canvas-sheet-root-id="${lastId}"]`) as HTMLElement | null;
          lastEl?.focus?.({ preventScroll: true } as any);
          try {
            lastEl?.scrollIntoView?.({ block: "nearest", inline: "nearest" } as any);
          } catch {
            // ignore
          }
          requestAnimationFrame(() => setCaretOffsetInElement(lastEl as any, getEditorPlainText(lastEl).length));
        });
      }
    } finally {
      setTimeout(() => {
        paginatingRef.current = false;
      }, 0);
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
        if (t?.closest?.("[data-delete-button]")) return;
        if (t?.closest?.("[data-drag-handle]")) return;
        if (e.shiftKey) toggleSelect(id);
        else if (!isSelected) selectBlocks([id]);
      }}
    >
      <div className={`glass-block overflow-hidden relative ${isSelected ? "omnia-selected-glass" : ""}`} style={{ width: "100%", height: "100%" }}>
        <button
          data-delete-button
          type="button"
          className="absolute top-2 right-2 z-30 w-7 h-7 rounded-full glass-control hover:opacity-90 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity text-black/70 dark:text-white/70 hover:text-red-500 hover:ring-2 hover:ring-red-400/35 hover:shadow-[0_0_16px_rgba(248,113,113,0.35)]"
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

        {/* Top grab bar (drag-only) */}
        <div
          data-drag-handle
          className="absolute inset-x-0 top-0 h-10 z-20 bg-white/22 dark:bg-white/8 backdrop-blur-xl border-b border-white/18 dark:border-white/10 cursor-grab active:cursor-grabbing rounded-t-[6px] opacity-0 group-hover:opacity-100 transition-opacity"
          onPointerDown={startDragStrip}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
          onLostPointerCapture={onDragEnd}
          title="Drag to move"
        />

        <div className="absolute inset-0 pt-10">
          <div
            ref={editorRef}
            data-canvas-sheet-root-id={id}
            contentEditable
            suppressContentEditableWarning
            spellCheck
            className="w-full h-full outline-none whitespace-pre-wrap break-words text-foreground"
            style={{
              fontFamily: defaultFontFamily,
              fontSize: 14,
              lineHeight: "24px",
              letterSpacing: defaultLetterSpacing,
              padding: "18px 18px",
              overflowY: block.paginate === false ? "auto" : "hidden",
              overflowX: "hidden",
            }}
            onFocus={() => {
              bringToFront(id);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                // After the browser inserts the new line, check for overflow pagination.
                lastEnterRef.current = Date.now();
                requestAnimationFrame(() => {
                  paginateIfNeeded();
                });
              }
              if (e.key !== "/") return;
              if (e.metaKey || e.ctrlKey || e.altKey) return;
              // Use "/" as a command trigger (do not insert the character).
              e.preventDefault();
              e.stopPropagation();
              const sel = window.getSelection?.();
              const r = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
              const rect = r ? r.getBoundingClientRect() : null;
              const fallback = (e.currentTarget as HTMLElement).getBoundingClientRect();
              const clientX = Math.floor((rect && rect.left) || fallback.left);
              const clientY = Math.floor((rect && rect.bottom) || fallback.top);
              window.dispatchEvent(new CustomEvent("omnia_slash_open", { detail: { clientX, clientY, source: { type: "sheet", id } } }));
            }}
            onBlur={() => {
              const el = editorRef.current;
              if (!el) return;
              updateBlock(id, { content: getEditorPlainText(el) } as any);
            }}
            onInput={() => {
              const el = editorRef.current;
              if (!el) return;
              if (paginatingRef.current) return;
              const next = getEditorPlainText(el);
              updateBlock(id, { content: next } as any);
              paginateIfNeeded();
            }}
          />
        </div>
      </div>
    </div>
  );
});

