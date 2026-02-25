import React, { memo, useEffect, useMemo, useRef } from "react";
import { Trash2 } from "lucide-react";
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

type PendingDragState = {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  originX: number;
  originY: number;
  capturer: HTMLElement;
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
  startFontSize: number;
  raf: number | null;
  capturer: HTMLElement | null;
};

const TODO_LINE_RE = /^(\s*)(?:-\s*)?\[([ xX])\]\s+(.*)$/;

export const TextBlock = memo(function TextBlock({ id }: { id: string }) {
  const block = useCanvasStore((s) => s.blocks[id]);
  const bringToFront = useCanvasStore((s) => s.bringToFront);
  const selectBlocks = useCanvasStore((s) => s.selectBlocks);
  const toggleSelect = useCanvasStore((s) => s.toggleSelect);
  const isSelected = useCanvasStore((s) => s.selectedIds.includes(id));
  const gridSize = useCanvasStore((s) => s.gridSize);
  const updateBlock = useCanvasStore((s) => s.updateBlock);
  const deleteBlock = useCanvasStore((s) => s.deleteBlock);
  const moveBlocksFromSnapshot = useCanvasStore((s) => s.moveBlocksFromSnapshot);
  const pushHistory = useCanvasStore((s) => s.pushHistory);

  const dragRef = useRef<DragState | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const pendingContentRef = useRef<string | null>(null);
  const contentTimerRef = useRef<number | null>(null);
  const resizeRafRef = useRef<number | null>(null);
  const endDragCleanupRef = useRef<(() => void) | null>(null);
  const activeDragPointerIdRef = useRef<number | null>(null);
  const pendingDragRef = useRef<PendingDragState | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);

  const defaultFontFamily =
    'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"';
  const defaultLetterSpacing = "-0.01em";
  const brickPx = 24;
  // Make the initial line sit *inside* a single brick (24px) including padding.
  const paddingY = 2;
  const baseLineHeightPx = brickPx - paddingY * 2;

  const style = useMemo(() => {
    if (!block || block.type !== "text") return null;
    const isAiBubble = Boolean((block as any)?.data?.aiResponseBubble);
    return {
      position: "absolute" as const,
      left: `${block.x}px`,
      top: `${block.y}px`,
      width: `${block.width}px`,
      height: `${block.height}px`,
      overflow: "visible",
      zIndex: isAiBubble ? 90 : undefined,
    };
  }, [block, isSelected]);

  if (!block || block.type !== "text" || !style) return null;

  const isCanvasText = Boolean((block as any).data?.canvasText);

  const format = String(block.format || "rich");
  const canvasData = (block as any).data || {};
  const isAiResponseBubble = Boolean(canvasData.aiResponseBubble);
  const canvasFontFamily = canvasData.fontFamily;
  const canvasTextColor = canvasData.textColor;
  const canvasBold = Boolean(canvasData.bold);
  const canvasItalic = Boolean(canvasData.italic);
  const canvasUnderline = Boolean(canvasData.underline);
  const canvasStrike = Boolean(canvasData.strike);
  const legacyFormat =
    format === "heading-1" ? "h1" : format === "heading-2" ? "h2" : format === "heading-3" ? "h3" : "p";
  const baseFontSize = Number.isFinite(block.fontSize) ? Math.max(8, Math.floor(block.fontSize as number)) : 12;
  const formatFontSize =
    legacyFormat === "h1"
      ? Math.min(20, baseFontSize + 6)
      : legacyFormat === "h2"
        ? Math.min(18, baseFontSize + 4)
        : legacyFormat === "h3"
          ? Math.min(16, baseFontSize + 2)
          : baseFontSize;
  const formatFontWeight = legacyFormat === "p" ? 450 : 650;
  const formatLineHeightPx = legacyFormat === "h1" || legacyFormat === "h2" ? brickPx * 2 - paddingY * 2 : baseLineHeightPx;
  const aiTodoLines = useMemo(() => {
    if (!isAiResponseBubble) return [];
    const lines = String(block.content || "").split("\n");
    return lines
      .map((line, index) => {
        const match = String(line).match(TODO_LINE_RE);
        if (!match) return null;
        return {
          lineIndex: index,
          checked: String(match[2] || "").toLowerCase() === "x",
          text: String(match[3] || ""),
        };
      })
      .filter(Boolean) as Array<{ lineIndex: number; checked: boolean; text: string }>;
  }, [block.content, isAiResponseBubble]);
  const hasAiTodoLines = aiTodoLines.length > 0;

  const panelContainer = useCanvasStore((s) =>
    (block as any)?.containerId ? s.blocks[(block as any).containerId] : null
  );

  // Keep DOM in sync from store when NOT focused (avoids caret jumping during edits).
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    if (document.activeElement === el) return;
    const next = String(block.content ?? "");
    if ((el.textContent ?? "") !== next) el.textContent = next;
    // Also auto-grow for programmatic updates (e.g., AI typing into a block).
    scheduleAutoGrow();
  }, [block.content]);

  // When font size or format changes, re-measure so the box grows with the text.
  useEffect(() => {
    scheduleAutoGrow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [block.fontSize, formatLineHeightPx, isCanvasText]);

  const scheduleAutoGrow = () => {
    if (resizeRafRef.current != null) return;
    resizeRafRef.current = window.requestAnimationFrame(() => {
      resizeRafRef.current = null;
      const el = editorRef.current;
      if (!el) return;
      // Mirror BrickEditor: only grow, never shrink (avoid jitter).
      const g = Math.max(1, Math.floor(gridSize || 24));
      const widthExtraPx = 2; // tiny buffer to avoid horizontal clipping
      const rawW = (el.scrollWidth || 0) + widthExtraPx;
      const desiredWpx = Math.max(g, Math.ceil(rawW / g) * g);

      // Avoid "instant vertical growth" from tiny scrollHeight jitter:
      // only grow when content is meaningfully taller than current height.
      const rawH = el.scrollHeight || 0;
      const currentH = block.height || g;
      const shouldGrowH = rawH > currentH + 2;
      let desiredHpx = shouldGrowH ? Math.max(g, Math.ceil(rawH / g) * g) : currentH;
      if (isAiResponseBubble) {
        // AI responses should always snap to content height rows (including wrapped/new lines).
        desiredHpx = Math.max(g, Math.ceil((rawH + 2) / g) * g);
        // Also ensure explicit newline counts are honored.
        const lineCount = Math.max(1, String(block.content || "").split("\n").length);
        const newlineHeight = lineCount * g;
        desiredHpx = Math.max(desiredHpx, newlineHeight);
      }

      if (desiredWpx > (block.width || g) || desiredHpx > currentH) {
        updateBlock(id, {
          width: desiredWpx > (block.width || g) ? desiredWpx : block.width,
          height: desiredHpx > currentH ? desiredHpx : block.height,
        });
      }
    });
  };

  const endResize = (pointerId: number) => {
    const r = resizeRef.current;
    if (!r || r.pointerId !== pointerId) return;
    if (r.raf != null) window.cancelAnimationFrame(r.raf);
    resizeRef.current = null;
  };

  const beginResize = (e: React.PointerEvent, mode: ResizeMode) => {
    e.stopPropagation();
    e.preventDefault();
    bringToFront(id);
    pushHistory();
    resizeRef.current = {
      pointerId: e.pointerId,
      mode,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startX: block.x,
      startY: block.y,
      startW: block.width,
      startH: block.height,
      startFontSize: Number.isFinite(block.fontSize) ? Number(block.fontSize) : baseFontSize,
      raf: null,
      capturer: e.currentTarget as HTMLElement,
    };
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  const endDrag = (pointerId: number) => {
    // Always clean up even if dragRef isn't set yet (prevents "sticky" drags).
    const activeId = activeDragPointerIdRef.current;
    const d = dragRef.current;
    const isThisDrag = (activeId != null && activeId === pointerId) || (d != null && d.pointerId === pointerId);
    if (!isThisDrag) return;

    if (d?.raf != null) window.cancelAnimationFrame(d.raf);

    if (endDragCleanupRef.current) {
      try {
        endDragCleanupRef.current();
      } catch {
        // ignore
      }
      endDragCleanupRef.current = null;
    }

    // Release capture from the element that captured (important on Windows).
    if (d?.capturer) {
      try {
        d.capturer.releasePointerCapture(pointerId);
      } catch {
        // ignore
      }
    }

    dragRef.current = null;
    activeDragPointerIdRef.current = null;
  };

  const installGlobalDragEndHandlers = (pointerId: number) => {
    // Ensure we always end the drag even if pointerup happens outside the element/window.
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      endDrag(pointerId);
    };
    const onCancel = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      endDrag(pointerId);
    };
    const onBlur = () => {
      endDrag(pointerId);
    };
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onCancel, true);
    window.addEventListener("blur", onBlur, true);
    endDragCleanupRef.current = () => {
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onCancel, true);
      window.removeEventListener("blur", onBlur, true);
    };
  };

  const startDragFromPending = (pointerId: number) => {
    const p = pendingDragRef.current;
    if (!p || p.pointerId !== pointerId) return;

    // Drag should take precedence over typing: stop any active text edit immediately.
    const ae = document.activeElement as HTMLElement | null;
    if (ae?.isContentEditable) {
      try {
        ae.blur();
      } catch {
        // ignore
      }
    }
    try {
      editorRef.current?.blur();
    } catch {
      // ignore
    }

    bringToFront(id);
    pushHistory();

    // Set drag state BEFORE installing global end handlers (prevents races).
    activeDragPointerIdRef.current = pointerId;
    dragRef.current = {
      pointerId,
      startClientX: p.startClientX,
      startClientY: p.startClientY,
      originX: p.originX,
      originY: p.originY,
      raf: null,
      lastX: p.originX,
      lastY: p.originY,
      capturer: p.capturer,
      snapshot: p.snapshot,
    };

    pendingDragRef.current = null;
    installGlobalDragEndHandlers(pointerId);
    try {
      p.capturer.setPointerCapture(pointerId);
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
        // Allow "one grab" move: if the user drags more than a few px, move the block.
        // If they don't move, it behaves like a normal click-to-type.
        if (dragRef.current) return;
        if (e.button !== 0) return;
        const t = e.target as Element | null;
        if (t?.closest?.("[data-drag-handle]")) return;
        if (isCanvasText) {
          // Keep normal typing behavior for CanvasText.
        }

        // Selection rules:
        // - Shift+click toggles selection (multi-select)
        // - Clicking an already-selected block keeps the selection (so you can drag a group)
        // - Clicking an unselected block selects only that block
        if (e.shiftKey) toggleSelect(id);
        else if (!isSelected) selectBlocks([id]);

        const state = useCanvasStore.getState();
        const sel = state.selectedIds;
        const idsForDrag = sel.includes(id) && sel.length > 1 ? sel : [id];
        const snapshot = idsForDrag.map((bid) => {
          const b = state.blocks[bid];
          return { id: bid, x: Number(b?.x) || 0, y: Number(b?.y) || 0 };
        });

        pendingDragRef.current = {
          pointerId: e.pointerId,
          startClientX: e.clientX,
          startClientY: e.clientY,
          originX: block.x,
          originY: block.y,
          capturer: e.currentTarget as HTMLElement,
          snapshot,
        };
      }}
      onPointerDown={(e) => {
        e.stopPropagation();
        bringToFront(id);
        // Selection is handled in onPointerDownCapture to avoid double-toggling.
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
              const nextW = snapToGrid(rr.startW + dx, min);
              updateBlock(id, { width: Math.max(min, nextW) });
              return;
            }
            if (rr.mode === "top") {
              const nextH = snapToGrid(rr.startH - dy, min);
              const nextY = snapToGrid(bottom - nextH, min);
              updateBlock(id, { y: nextY, height: Math.max(min, nextH) });
              return;
            }
            if (rr.mode === "bottom") {
              const nextH = snapToGrid(rr.startH + dy, min);
              updateBlock(id, { height: Math.max(min, nextH) });
              return;
            }
            const nextW = snapToGrid(rr.startW + dx, min);
            const nextH = snapToGrid(rr.startH + dy, min);
            if (isCanvasText) {
              const scale = Math.min(
                Math.max(0.1, nextW / Math.max(1, rr.startW)),
                Math.max(0.1, nextH / Math.max(1, rr.startH))
              );
              const nextFont = Math.max(8, Math.round(rr.startFontSize * scale));
              updateBlock(id, { width: Math.max(min, nextW), height: Math.max(min, nextH), fontSize: nextFont } as any);
            } else {
              updateBlock(id, { width: Math.max(min, nextW), height: Math.max(min, nextH) });
            }
          });
          return;
        }
        // If we're not actively dragging yet, decide whether this becomes a drag.
        const p = pendingDragRef.current;
        if (!dragRef.current && p && p.pointerId === e.pointerId) {
          const dx = e.clientX - p.startClientX;
          const dy = e.clientY - p.startClientY;
          const dist2 = dx * dx + dy * dy;
          if (dist2 > 36) {
            // ~6px threshold
            startDragFromPending(e.pointerId);
          }
        }

        const d = dragRef.current;
        if (!d || d.pointerId !== e.pointerId) return;
        // Fail-safe: if the browser misses pointerup (often when releasing outside the window),
        // stop dragging as soon as we observe the mouse button is no longer held.
        if (e.pointerType === "mouse" && e.buttons === 0) {
          endDrag(e.pointerId);
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
      }}
      onPointerUp={(e) => {
        if (pendingDragRef.current?.pointerId === e.pointerId) pendingDragRef.current = null;
        endDrag(e.pointerId);
        endResize(e.pointerId);
      }}
      onPointerCancel={(e) => {
        if (pendingDragRef.current?.pointerId === e.pointerId) pendingDragRef.current = null;
        endDrag(e.pointerId);
        endResize(e.pointerId);
      }}
      onLostPointerCapture={(e) => {
        if (pendingDragRef.current?.pointerId === e.pointerId) pendingDragRef.current = null;
        endDrag(e.pointerId);
        endResize(e.pointerId);
      }}
    >
      {isCanvasText && isSelected && (
        <div
          className="absolute z-30 h-9 rounded-full glass-control flex items-center gap-2 px-3"
          style={{
            left: `${((panelContainer as any)?.x ?? block.x) - block.x}px`,
            top: `${((panelContainer as any)?.y ?? block.y) - block.y - 40}px`,
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <label
            className="h-5 w-5 rounded-full border border-white/40 shadow-sm"
            style={{ background: canvasTextColor || "rgba(0,0,0,0.7)" }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <input
              type="color"
              aria-label="Text color"
              className="h-0 w-0 opacity-0"
              onChange={(e) => {
                updateBlock(id, { data: { ...(block as any).data, textColor: e.currentTarget.value } } as any);
              }}
              onClick={(e) => e.stopPropagation()}
            />
          </label>
          <div className="w-px h-4 bg-black/10 dark:bg-white/10" />
          <select
            className="text-[11px] bg-transparent outline-none"
            value={canvasFontFamily || "Inter"}
            onChange={(e) => {
              updateBlock(id, { data: { ...(block as any).data, fontFamily: e.currentTarget.value } } as any);
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <option value="Inter">Inter</option>
            <option value="Arial">Arial</option>
            <option value="Georgia">Georgia</option>
            <option value="Times New Roman">Times</option>
            <option value="ui-monospace">Mono</option>
          </select>
          <div className="w-px h-4 bg-black/10 dark:bg-white/10" />
          <input
            type="number"
            min={8}
            max={96}
            value={Number.isFinite(block.fontSize) ? Number(block.fontSize) : baseFontSize}
            className="w-10 text-[11px] bg-transparent outline-none"
            onChange={(e) => updateBlock(id, { fontSize: Number(e.currentTarget.value || 12) } as any)}
            onPointerDown={(e) => e.stopPropagation()}
          />
          <div className="w-px h-4 bg-black/10 dark:bg-white/10" />
          <select
            className="text-[11px] bg-transparent outline-none"
            value={format}
            onChange={(e) => updateBlock(id, { format: e.currentTarget.value as any } as any)}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <option value="plain">Body</option>
            <option value="heading-1">H1</option>
            <option value="heading-2">H2</option>
            <option value="heading-3">H3</option>
          </select>
          <div className="w-px h-4 bg-black/10 dark:bg-white/10" />
          <button
            type="button"
            className={`text-[11px] ${canvasBold ? "font-semibold" : ""}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => updateBlock(id, { data: { ...(block as any).data, bold: !canvasBold } } as any)}
          >
            B
          </button>
          <button
            type="button"
            className={`text-[11px] ${canvasItalic ? "italic" : ""}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => updateBlock(id, { data: { ...(block as any).data, italic: !canvasItalic } } as any)}
          >
            I
          </button>
          <button
            type="button"
            className={`text-[11px] ${canvasUnderline ? "underline" : ""}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => updateBlock(id, { data: { ...(block as any).data, underline: !canvasUnderline } } as any)}
          >
            U
          </button>
          <button
            type="button"
            className={`text-[11px] ${canvasStrike ? "line-through" : ""}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => updateBlock(id, { data: { ...(block as any).data, strike: !canvasStrike } } as any)}
          >
            S
          </button>
          <button
            type="button"
            className="text-[11px]"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => updateBlock(id, { format: "list-unordered" } as any)}
          >
            List
          </button>
          <div className="w-px h-4 bg-black/10 dark:bg-white/10" />
          <button
            type="button"
            className="h-6 w-6 rounded-full flex items-center justify-center text-black/70"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => deleteBlock(id)}
            title="Delete"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
      {/* Drag handle strip (match BrickEditor behavior/feel) */}
      <div
        data-drag-handle
        className="absolute inset-x-0 top-0 h-3 z-30 cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity"
        onPointerDown={(e) => {
          e.stopPropagation();
          e.preventDefault();
          // Drag should take precedence over typing: stop any active text edit immediately.
          const ae = document.activeElement as HTMLElement | null;
          if (ae?.isContentEditable) {
            try {
              ae.blur();
            } catch {
              // ignore
            }
          }
          // Also blur this block's editor specifically (covers focus being on it).
          try {
            editorRef.current?.blur();
          } catch {
            // ignore
          }
          bringToFront(id);
          if (e.shiftKey) toggleSelect(id);
          else if (!isSelected) selectBlocks([id]);
          pushHistory();
          const capturer = e.currentTarget as HTMLElement;

          const state = useCanvasStore.getState();
          const sel = state.selectedIds;
          const idsForDrag = sel.includes(id) && sel.length > 1 ? sel : [id];
          const snapshot = idsForDrag.map((bid) => {
            const b = state.blocks[bid];
            return { id: bid, x: Number(b?.x) || 0, y: Number(b?.y) || 0 };
          });

          // Set drag state BEFORE installing global end handlers (prevents races).
          activeDragPointerIdRef.current = e.pointerId;
          pendingDragRef.current = null;
          dragRef.current = {
            pointerId: e.pointerId,
            startClientX: e.clientX,
            startClientY: e.clientY,
            originX: block.x,
            originY: block.y,
            raf: null,
            lastX: block.x,
            lastY: block.y,
            capturer,
            snapshot,
          };
          installGlobalDragEndHandlers(e.pointerId);
          try {
            capturer.setPointerCapture(e.pointerId);
          } catch {
            // ignore
          }
        }}
        onPointerUp={(e) => {
          // Some browsers/platforms dispatch pointerup directly on the capturer;
          // ensure we always end drag even if bubbling is interrupted.
          endDrag(e.pointerId);
        }}
        onPointerCancel={(e) => {
          endDrag(e.pointerId);
        }}
        onLostPointerCapture={(e) => {
          endDrag(e.pointerId);
        }}
        title="Drag to move"
      />

      <div
        className={`${isCanvasText ? "bg-transparent" : "glass-text-card"} ${isSelected ? "omnia-selected-glass" : ""}`}
        style={{
          height: "100%",
          minHeight: `${brickPx}px`,
          border: isCanvasText && isSelected ? "1px solid rgba(0,0,0,0.35)" : undefined,
          boxShadow: isCanvasText ? "none" : undefined,
          background: isCanvasText ? "transparent" : undefined,
        }}
      >
        {isAiResponseBubble ? (
          <button
            type="button"
            className="absolute top-0.5 right-1 z-20 text-[14px] leading-none text-black/65 hover:text-black px-0 py-0 bg-transparent border-0"
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              deleteBlock(id);
            }}
            title="Close AI response"
            aria-label="Close AI response"
          >
            ×
          </button>
        ) : null}
        {isAiResponseBubble && hasAiTodoLines ? (
          <div
            className="outline-none text-foreground whitespace-pre-wrap"
            style={{
              height: "100%",
              fontFamily: defaultFontFamily,
              fontSize: `${formatFontSize}px`,
              fontWeight: formatFontWeight as any,
              lineHeight: `${formatLineHeightPx}px`,
              letterSpacing: defaultLetterSpacing,
              paddingLeft: "8px",
              paddingRight: "18px",
              paddingTop: `${paddingY}px`,
              paddingBottom: `${paddingY}px`,
              margin: "0px",
              minHeight: `${brickPx}px`,
              wordBreak: "break-word",
              overflowWrap: "anywhere",
            }}
            onPointerDown={(e) => {
              e.stopPropagation();
              bringToFront(id);
            }}
          >
            {String(block.content || "")
              .split("\n")
              .map((line, lineIndex) => {
                const todo = aiTodoLines.find((t) => t.lineIndex === lineIndex);
                if (!todo) {
                  return (
                    <div key={`line-${lineIndex}`} className="whitespace-pre-wrap">
                      {line}
                    </div>
                  );
                }
                return (
                  <label key={`todo-${lineIndex}`} className={`flex items-start gap-2 ${todo.checked ? "brick-todo-done" : ""}`}>
                    <input
                      type="checkbox"
                      className="brick-todo-checkbox mt-[0.28rem] shrink-0"
                      checked={todo.checked}
                      onPointerDown={(e) => e.stopPropagation()}
                      onChange={(e) => {
                        const lines = String(block.content || "").split("\n");
                        const current = String(lines[lineIndex] || "");
                        if (!TODO_LINE_RE.test(current)) return;
                        lines[lineIndex] = current.replace(TODO_LINE_RE, (_, leading, __state, text) => {
                          const nextState = e.currentTarget.checked ? "x" : " ";
                          return `${leading}- [${nextState}] ${text}`;
                        });
                        updateBlock(id, { content: lines.join("\n") });
                      }}
                    />
                    <span className={todo.checked ? "line-through" : ""}>{todo.text}</span>
                  </label>
                );
              })}
          </div>
        ) : (
          <div
            ref={editorRef}
            data-canvas-text-editor-id={id}
            tabIndex={0}
            contentEditable
            suppressContentEditableWarning
            spellCheck={false}
            className={`outline-none text-foreground ${isCanvasText || isAiResponseBubble ? "whitespace-pre-wrap" : "whitespace-pre"}`}
            style={{
              height: "100%",
              fontFamily: isCanvasText && canvasFontFamily ? canvasFontFamily : defaultFontFamily,
              fontSize: `${formatFontSize}px`,
              fontWeight: (isCanvasText && canvasBold ? 700 : formatFontWeight) as any,
              fontStyle: isCanvasText && canvasItalic ? "italic" : "normal",
              textDecoration: isCanvasText
                ? `${canvasUnderline ? "underline" : ""}${canvasStrike ? " line-through" : ""}`.trim() || "none"
                : "none",
              color: isCanvasText && canvasTextColor ? canvasTextColor : undefined,
              lineHeight: `${formatLineHeightPx}px`,
              letterSpacing: defaultLetterSpacing,
              paddingLeft: "8px",
              paddingRight: isAiResponseBubble ? "18px" : "8px",
              paddingTop: `${paddingY}px`,
              paddingBottom: `${paddingY}px`,
              margin: "0px",
              minHeight: `${brickPx}px`,
              wordBreak: isCanvasText || isAiResponseBubble ? "break-word" : undefined,
              overflowWrap: isCanvasText || isAiResponseBubble ? "anywhere" : undefined,
            }}
            onPointerDown={(e) => {
              e.stopPropagation();
              bringToFront(id);
            }}
            onInput={(e) => {
              // Debounce store writes while typing to reduce re-render churn.
              const next = e.currentTarget.textContent ?? "";
              pendingContentRef.current = next;
              if (contentTimerRef.current != null) window.clearTimeout(contentTimerRef.current);
              contentTimerRef.current = window.setTimeout(() => {
                contentTimerRef.current = null;
                const v = pendingContentRef.current;
                pendingContentRef.current = null;
                if (v != null) updateBlock(id, { content: v });
              }, 180);

              scheduleAutoGrow();
            }}
            onBlur={(e) => {
              // Ensure store stays in sync even if browser changed DOM.
              if (contentTimerRef.current != null) window.clearTimeout(contentTimerRef.current);
              contentTimerRef.current = null;
              pendingContentRef.current = null;
              const text = e.currentTarget.textContent ?? "";
              updateBlock(id, { content: text });
              scheduleAutoGrow();

              // Match BrickEditor behavior: delete empty blocks after blur.
              // CanvasText should never auto-delete on blur.
              if (!isCanvasText && String(text).trim().length === 0) {
                deleteBlock(id);
              }
            }}
          />
        )}
      </div>

      {isCanvasText && (
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
      )}
    </div>
  );
});

