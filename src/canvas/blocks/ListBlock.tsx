import React, { memo, useEffect, useMemo, useRef } from "react";
import { useCanvasStore } from "@/store/canvasStore";

function normalizeNewlines(s: string) {
  return String(s ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
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

function parseListItems(content: string, listType: "todo" | "bulleted" | "numbered") {
  const lines = normalizeNewlines(content).split("\n");
  return lines.map((line, idx) => {
    if (listType === "todo") {
      const match = line.match(/^\s*-\s*\[([ xX])\]\s*(.*)$/);
      if (match) {
        return { id: `li-${idx}`, text: match[2] || "", checked: match[1].toLowerCase() === "x" };
      }
      return { id: `li-${idx}`, text: line.replace(/^\s*-\s*/, ""), checked: false };
    }
    if (listType === "numbered") {
      return { id: `li-${idx}`, text: line.replace(/^\s*\d+\.\s*/, "") };
    }
    return { id: `li-${idx}`, text: line.replace(/^\s*-\s*/, "") };
  });
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

export const ListBlock = memo(function ListBlock({ id }: { id: string }) {
  const block = useCanvasStore((s) => s.blocks[id]);
  const bringToFront = useCanvasStore((s) => s.bringToFront);
  const selectBlocks = useCanvasStore((s) => s.selectBlocks);
  const toggleSelect = useCanvasStore((s) => s.toggleSelect);
  const isSelected = useCanvasStore((s) => s.selectedIds.includes(id));
  const gridSize = useCanvasStore((s) => s.gridSize);

  const moveBlocksFromSnapshot = useCanvasStore((s) => s.moveBlocksFromSnapshot);
  const setListItems = useCanvasStore((s) => s.setListItems);
  const toggleTodoItem = useCanvasStore((s) => s.toggleTodoItem);
  const addTextBlockAt = useCanvasStore((s) => s.addTextBlockAt);
  const deleteBlock = useCanvasStore((s) => s.deleteBlock);
  const updateBlock = useCanvasStore((s) => s.updateBlock);
  const pushHistory = useCanvasStore((s) => s.pushHistory);

  const dragRef = useRef<DragState | null>(null);
  const endDragCleanupRef = useRef<(() => void) | null>(null);
  const activeDragPointerIdRef = useRef<number | null>(null);
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const resizeRafRef = useRef<number | null>(null);

  const style = useMemo(() => {
    if (!block || block.type !== "text") return null;
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

  const format = String(block.format || "");
  const listType =
    format === "todo" ? "todo" : format === "list-ordered" ? "numbered" : format === "list-unordered" ? "bulleted" : null;
  if (!listType) return null;
  const items = parseListItems(String(block.content || ""), listType);

  const g = Math.max(1, Math.floor(gridSize || 24));
  const brickPx = 24;
  const paddingY = 2;
  const lineHeightPx = brickPx - paddingY * 2;

  const scheduleAutoGrowWidth = () => {
    if (resizeRafRef.current != null) return;
    resizeRafRef.current = window.requestAnimationFrame(() => {
      resizeRafRef.current = null;
      // Ensure the list bubble is wide enough for marker + caret even before typing.
      const markerPx = 22 + 8; // marker column + gap-2
      const basePx = markerPx + 16 + 2; // padding left/right + tiny border buffer
      let maxScrollW = 0;
      for (const el of itemRefs.current.values()) {
        maxScrollW = Math.max(maxScrollW, el.scrollWidth || 0);
      }
      const desiredPx = basePx + maxScrollW;
      const desiredW = Math.max(g, Math.ceil(desiredPx / g) * g);
      if (desiredW > (block.width || g)) updateBlock(id, { width: desiredW });
    });
  };

  useEffect(() => {
    // Run once on mount + whenever list structure changes so the bubble "auto spaces"
    // without requiring the user to type first.
    scheduleAutoGrowWidth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listType, items.length]);

  const focusItem = (itemId: string, opts?: { caretToStart?: boolean; caretToEnd?: boolean; caretOffset?: number }) => {
    requestAnimationFrame(() => {
      const key = `${id}:${itemId}`;
      const el = itemRefs.current.get(key);
      el?.focus?.();
      if (!el) return;
      scheduleAutoGrowWidth();
      if (typeof opts?.caretOffset === "number") {
        setCaretOffsetInElement(el, opts.caretOffset);
      } else if (opts?.caretToStart) {
        setCaretOffsetInElement(el, 0);
      } else if (opts?.caretToEnd) {
        const t = el.textContent ?? "";
        setCaretOffsetInElement(el, t.length);
      }
    });
  };

  const installGlobalDragEndHandlers = (pointerId: number) => {
    const end = () => endDrag(pointerId);
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      end();
    };
    const onCancel = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      end();
    };
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onCancel, true);
    window.addEventListener("blur", end, true);
    endDragCleanupRef.current = () => {
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onCancel, true);
      window.removeEventListener("blur", end, true);
    };
  };

  const endDrag = (pointerId: number) => {
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

  const makeItem = (text: string) => {
    const liId = `li-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    return listType === "todo" ? { id: liId, text, checked: false } : { id: liId, text };
  };

  return (
    <div
      data-canvas-block
      data-block-id={id}
      className="absolute group"
      style={style}
      onPointerDownCapture={(e) => {
        if (e.button !== 0) return;
        if (e.shiftKey) toggleSelect(id);
        else if (!isSelected) selectBlocks([id]);
      }}
      onPointerDown={(e) => {
        e.stopPropagation();
        bringToFront(id);
        // If click is on chrome (not a row), focus first item.
        const t = e.target as Element | null;
        const isRowEditor = Boolean(t?.closest?.("[data-list-item-editor]"));
        const isCheckbox = Boolean((t as any)?.tagName === "INPUT" && (t as any)?.getAttribute?.("type") === "checkbox");
        if (!isRowEditor && !isCheckbox) {
          const first = items?.[0];
          if (first?.id) focusItem(first.id, { caretToStart: true });
        }
      }}
      onPointerMove={(e) => {
        const d = dragRef.current;
        if (!d || d.pointerId !== e.pointerId) return;
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
      onPointerUp={(e) => endDrag(e.pointerId)}
      onPointerCancel={(e) => endDrag(e.pointerId)}
      onLostPointerCapture={(e) => endDrag(e.pointerId)}
    >
      {/* Drag handle strip */}
      <div
        data-drag-handle
        className="absolute inset-x-0 top-0 h-3 z-30 cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity"
        onPointerDown={(e) => {
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
            return { id: bid, x: Number(b?.x) || 0, y: Number(b?.y) || 0 };
          });

          const capturer = e.currentTarget as HTMLElement;
          activeDragPointerIdRef.current = e.pointerId;
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
        title="Drag to move"
      />

      <div className={`glass-text-card w-full h-full ${isSelected ? "omnia-selected-glass" : ""}`} style={{ minHeight: `${brickPx}px` }}>
        <div style={{ paddingLeft: "8px", paddingRight: "8px", paddingTop: "0px", paddingBottom: "0px" }}>
          {(items || []).map((it, idx) => {
            const key = `${id}:${it.id}`;
            const checked = Boolean(it.checked);
            return (
              <div key={it.id} className="brick-list-row flex items-start gap-2" style={{ minHeight: brickPx }}>
                <div className="brick-list-marker shrink-0" aria-hidden style={{ minHeight: brickPx }}>
                  {listType === "todo" ? (
                    <input
                      type="checkbox"
                      className="brick-todo-checkbox"
                      checked={checked}
                      onChange={() => toggleTodoItem(id, it.id)}
                      onPointerDown={(e) => e.stopPropagation()}
                    />
                  ) : listType === "numbered" ? (
                    <span className="brick-number-label select-none">{idx + 1}.</span>
                  ) : (
                    <span className="brick-bullet-label select-none">•</span>
                  )}
                </div>

                <div
                  data-list-item-editor
                  data-canvas-list-item-editor-id={`${id}:${it.id}`}
                  ref={(node) => {
                    if (node) {
                      itemRefs.current.set(key, node);
                      if (document.activeElement !== node) {
                        const next = it.text ?? "";
                        if ((node.textContent ?? "") !== next) node.textContent = next;
                      }
                    } else {
                      itemRefs.current.delete(key);
                    }
                  }}
                  contentEditable
                  suppressContentEditableWarning
                  spellCheck={false}
                  className={`outline-none whitespace-pre text-foreground flex-1 min-w-0 ${
                    listType === "todo" && checked ? "brick-todo-done" : ""
                  }`}
                  style={{
                    fontFamily:
                      'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"',
                    fontSize: `${block.fontSize ?? 12}px`,
                    lineHeight: `${lineHeightPx}px`,
                    letterSpacing: "-0.01em",
                    minHeight: `${brickPx}px`,
                    paddingTop: `${paddingY}px`,
                    paddingBottom: `${paddingY}px`,
                  }}
                  onFocus={() => {
                    bringToFront(id);
                  }}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    bringToFront(id);
                  }}
                  onInput={(e) => {
                    const el = e.currentTarget;
                    const nextText = normalizeNewlines(el.textContent ?? "").replace(/\n$/, "");
                    const nextItems = (items || []).map((p) => (p.id === it.id ? { ...p, text: nextText } : p));
                    setListItems(id, nextItems, listType);

                    // Auto-grow width like BrickEditor (only grow, never shrink).
                    const markerPx = 22 + 8;
                    const desiredPx = (el.scrollWidth || 0) + markerPx + 16;
                    const desiredW = Math.ceil(desiredPx / g) * g;
                    if (desiredW > (block.width || g)) updateBlock(id, { width: desiredW });
                  }}
                  onKeyDown={(e) => {
                    const el = e.currentTarget;
                    const caret = getCaretOffsetInElement(el);
                    const currentText = normalizeNewlines(el.textContent ?? "").replace(/\n$/, "");

                    // Enter: split item or exit list if empty.
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      const isEmpty = currentText.length === 0;

                      if (isEmpty) {
                        pushHistory();
                        const remaining = (items || []).filter((p) => p.id !== it.id);

                        // If last item: replace list with a TextBlock (new id).
                        if ((items || []).length <= 1) {
                          deleteBlock(id);
                          const idNew = addTextBlockAt({ x: block.x, y: block.y }, { width: block.width, height: g, content: "" });
                          requestAnimationFrame(() => {
                            const sel = document.querySelector(`[data-canvas-text-editor-id="${idNew}"]`) as HTMLElement | null;
                            sel?.focus?.();
                          });
                          return;
                        }

                        // Keep list (minus empty row) and create a new TextBlock below it.
                        setListItems(id, remaining, listType);
                        const newHeight = Math.max(g, remaining.length * g);
                        const belowY = (block.y || 0) + newHeight;
                        const idNew = addTextBlockAt({ x: block.x, y: belowY }, { width: block.width, height: g, content: "" });
                        requestAnimationFrame(() => {
                          const sel = document.querySelector(`[data-canvas-text-editor-id="${idNew}"]`) as HTMLElement | null;
                          sel?.focus?.();
                        });
                        return;
                      }

                      const left = currentText.slice(0, caret);
                      const right = currentText.slice(caret);
                      el.textContent = left;
                      const nextId = `li-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
                      const nextItem = listType === "todo" ? { id: nextId, text: right, checked: false } : { id: nextId, text: right };
                      const nextItems: any[] = [];
                      for (const p of items || []) {
                        if (p.id === it.id) {
                          nextItems.push({ ...p, text: left });
                          nextItems.push(nextItem);
                        } else nextItems.push(p);
                      }
                      setListItems(id, nextItems as any, listType);
                      focusItem(nextId, { caretToStart: true });
                      return;
                    }

                    // Shift+Enter: line break inside item.
                    if (e.key === "Enter" && e.shiftKey) {
                      e.preventDefault();
                      const nextText = currentText.slice(0, caret) + "\n" + currentText.slice(caret);
                      const nextItems = (items || []).map((p) => (p.id === it.id ? { ...p, text: nextText } : p));
                      setListItems(id, nextItems, listType);
                      requestAnimationFrame(() => setCaretOffsetInElement(el, caret + 1));
                      return;
                    }

                    // Backspace at start: merge into previous or exit if only empty item.
                    if (e.key === "Backspace") {
                      const sel = window.getSelection();
                      const isCollapsed = !sel || sel.isCollapsed;
                      if (isCollapsed && caret === 0) {
                        e.preventDefault();
                        const itemsList = items || [];
                        const prevItem = itemsList[idx - 1] || null;

                        if (!prevItem && items.length === 1 && currentText.length === 0) {
                          pushHistory();
                          deleteBlock(id);
                          const idNew = addTextBlockAt({ x: block.x, y: block.y }, { width: block.width, height: g, content: "" });
                          requestAnimationFrame(() => {
                            const sel2 = document.querySelector(`[data-canvas-text-editor-id="${idNew}"]`) as HTMLElement | null;
                            sel2?.focus?.();
                          });
                          return;
                        }

                        if (prevItem?.id) {
                          const mergePoint = String(prevItem.text ?? "").length;
                          const merged = `${String(prevItem.text ?? "")}${currentText}`;
                          const prevEl = itemRefs.current.get(`${id}:${prevItem.id}`);
                          if (prevEl && document.activeElement !== prevEl) prevEl.textContent = merged;
                          const next = itemsList
                            .map((p) => (p.id === prevItem.id ? { ...p, text: merged } : p))
                            .filter((p) => p.id !== it.id);
                          setListItems(id, next, listType);
                          focusItem(prevItem.id, { caretOffset: mergePoint });
                        }
                        return;
                      }
                    }

                    // Arrow navigation between items.
                    if (e.key === "ArrowUp" && caret === 0 && idx > 0) {
                      e.preventDefault();
                      const prev = items?.[idx - 1];
                      if (prev?.id) focusItem(prev.id, { caretToEnd: true });
                      return;
                    }
                    if (e.key === "ArrowDown" && caret === currentText.length && idx < (items?.length || 0) - 1) {
                      e.preventDefault();
                      const next = items?.[idx + 1];
                      if (next?.id) focusItem(next.id, { caretToStart: true });
                      return;
                    }
                  }}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});

