import React, { memo, useMemo, useRef } from "react";
import { useCanvasStore } from "@/store/canvasStore";
import { snapToGrid } from "@/canvas/utils/snap";
import { getBlockDefinition } from "@/canvas/blockSystem/definitions";

type DragState = {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  raf: number | null;
  snapshot: Array<{ id: string; x: number; y: number }>;
  capturer: HTMLElement | null;
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
  raf: number | null;
  capturer: HTMLElement | null;
};

function normalizeCards(raw: any): string[] {
  return Array.isArray(raw) ? raw.map((v) => String(v || "")).filter(Boolean) : [];
}

function normalizeStrings(raw: any, fallback: string[] = []): string[] {
  if (!Array.isArray(raw)) return [...fallback];
  const next = raw.map((v) => String(v ?? ""));
  return next.length ? next : [...fallback];
}

export const UniversalBlock = memo(function UniversalBlock({ id }: { id: string }) {
  const block = useCanvasStore((s) => s.blocks[id]) as any;
  const allBlocks = useCanvasStore((s) => s.blocks) as any;
  const gridSize = useCanvasStore((s) => s.gridSize);
  const setCamera = useCanvasStore((s) => s.setCamera);
  const moveBlocksFromSnapshot = useCanvasStore((s) => s.moveBlocksFromSnapshot);
  const updateBlock = useCanvasStore((s) => s.updateBlock);
  const pushHistory = useCanvasStore((s) => s.pushHistory);
  const bringToFront = useCanvasStore((s) => s.bringToFront);
  const selectBlocks = useCanvasStore((s) => s.selectBlocks);
  const selectedIds = useCanvasStore((s) => s.selectedIds);
  const isSelected = useCanvasStore((s) => s.selectedIds.includes(id));

  const dragRef = useRef<DragState | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);

  if (!block) return null;
  const universalType = String(block?.universalType || block?.universal?.blockType || "").trim();
  const definition = getBlockDefinition("text");
  if (!definition) return null;

  const style = useMemo(
    () => ({
      position: "absolute" as const,
      left: `${block.x}px`,
      top: `${block.y}px`,
      width: `${block.width}px`,
      height: `${block.height}px`,
      overflow: "visible",
    }),
    [block.x, block.y, block.width, block.height]
  );

  const data = (block.data || {}) as Record<string, any>;
  const body = String(data.body || "");
  const items = Array.isArray(data.items) ? data.items : [];
  const columns = Array.isArray(data.columns) ? data.columns : [];
  const type = universalType as string;
  const brickContent = String(data.content ?? ((block as any)?.content ?? body ?? ""));
  const linkedGroup = data.linkedBrickGroup && typeof data.linkedBrickGroup === "object" ? (data.linkedBrickGroup as Record<string, any>) : null;
  const linkedGroupId = String(linkedGroup?.id || "");
  const brickFontPx = Math.max(11, Math.min(32, Number(data.fontSize || 11)));

  const patchBrickContent = (next: string) => {
    if (linkedGroupId) {
      const st = useCanvasStore.getState();
      for (const bid of st.blockOrder || []) {
        const b = (st.blocks as any)?.[bid];
        if (!b) continue;
        const bData = b?.data && typeof b.data === "object" ? b.data : {};
        const bGroup = bData?.linkedBrickGroup && typeof bData.linkedBrickGroup === "object" ? bData.linkedBrickGroup : {};
        if (String(bGroup?.id || "") !== linkedGroupId) continue;
        updateBlock(bid as any, {
          data: { ...bData, content: next, body: next },
          ...(b?.type === "text" ? { content: next } : {}),
        } as any);
      }
      return;
    }
    onDataPatch({ content: next, body: next });
    if ((block as any)?.type === "text") {
      updateBlock(id as any, { content: next } as any);
    }
  };
  const snapSize = (n: number) => {
    const g = Math.max(1, Math.floor(gridSize || 24));
    return Math.max(g, snapToGrid(n, g));
  };

  const onDataPatch = (patch: Record<string, any>) => {
    updateBlock(id as any, { data: { ...(block.data || {}), ...patch } } as any);
  };

  const focusTextEditor = (targetId: string) => {
    window.requestAnimationFrame(() => {
      const el = document.querySelector(`[data-universal-textarea-id="${targetId}"]`) as HTMLTextAreaElement | null;
      if (!el) return;
      el.focus();
      const len = String(el.value || "").length;
      try {
        el.setSelectionRange(len, len);
      } catch {
        // ignore
      }
    });
  };

  const makeLinkedGroupId = () => `link-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

  const tryShiftLinkNeighbor = () => {
    const st = useCanvasStore.getState();
    const anchorId = Array.isArray(selectedIds) && selectedIds.length ? String(selectedIds[selectedIds.length - 1]) : "";
    if (!anchorId || anchorId === id) {
      selectBlocks([id]);
      return false;
    }
    const anchor = (st.blocks as any)?.[anchorId];
    const current = (st.blocks as any)?.[id];
    if (!anchor || !current) {
      selectBlocks([id]);
      return false;
    }

    const g = Math.max(1, Math.floor(st.gridSize || 24));
    const ax = Math.round(Number(anchor.x || 0) / g);
    const ay = Math.round(Number(anchor.y || 0) / g);
    const cx = Math.round(Number(current.x || 0) / g);
    const cy = Math.round(Number(current.y || 0) / g);
    const isNeighbor = (ax === cx && Math.abs(ay - cy) === 1) || (ay === cy && Math.abs(ax - cx) === 1);
    if (!isNeighbor) {
      selectBlocks([id]);
      return false;
    }

    const anchorData = anchor?.data && typeof anchor.data === "object" ? anchor.data : {};
    const currentData = current?.data && typeof current.data === "object" ? current.data : {};
    const existingGroupId = String(anchorData?.linkedBrickGroup?.id || currentData?.linkedBrickGroup?.id || "");
    const groupId = existingGroupId || makeLinkedGroupId();
    const aText = String(anchorData?.content ?? anchor?.content ?? anchorData?.body ?? "").trim();
    const cText = String(currentData?.content ?? current?.content ?? currentData?.body ?? "").trim();
    const shared = aText || cText || "";
    const aFont = Number(anchorData?.fontSize || 11);
    const cFont = Number(currentData?.fontSize || 11);
    const nextFont = Math.max(14, Math.min(36, Math.max(aFont, cFont) + 2));

    pushHistory();
    updateBlock(anchorId as any, {
      ...(String(anchor?.type || "") === "text" ? { content: shared } : {}),
      data: {
        ...anchorData,
        content: shared,
        body: shared,
        fontSize: nextFont,
        linkedBrickGroup: { id: groupId },
      },
    } as any);
    updateBlock(id as any, {
      ...(String(current?.type || "") === "text" ? { content: shared } : {}),
      data: {
        ...currentData,
        content: shared,
        body: shared,
        fontSize: nextFont,
        linkedBrickGroup: { id: groupId },
      },
    } as any);
    selectBlocks([anchorId, id]);
    focusTextEditor(id);
    return true;
  };

  const startDrag = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (resizeRef.current) return;
    bringToFront(id);
    if (!isSelected) selectBlocks([id]);
    pushHistory();
    const state = useCanvasStore.getState();
    const sel = state.selectedIds;
    const idsForDrag = sel.includes(id) && sel.length > 1 ? sel : [id];
    const snapshot = idsForDrag.map((bid) => {
      const b = (state.blocks as any)[bid];
      return { id: bid, x: Number(b?.x) || 0, y: Number(b?.y) || 0 };
    });
    dragRef.current = {
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      raf: null,
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
    const dx = e.clientX - d.startClientX;
    const dy = e.clientY - d.startClientY;
    if (d.raf != null) return;
    d.raf = window.requestAnimationFrame(() => {
      d.raf = null;
      moveBlocksFromSnapshot(d.snapshot as any, dx, dy, { snap: true, snapSize: Math.max(1, Math.floor(gridSize || 24)) });
    });
  };

  const endDrag = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    if (d.raf != null) window.cancelAnimationFrame(d.raf);
    try {
      d.capturer?.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    dragRef.current = null;
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
      raf: null,
      capturer: e.currentTarget as HTMLElement,
    };
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  const onResizeMove = (e: React.PointerEvent) => {
    const rr = resizeRef.current;
    if (!rr || rr.pointerId !== e.pointerId) return;
    const dx = e.clientX - rr.startClientX;
    const dy = e.clientY - rr.startClientY;
    if (rr.raf != null) return;
    rr.raf = window.requestAnimationFrame(() => {
      rr.raf = null;
      let x = rr.startX;
      let y = rr.startY;
      let width = rr.startW;
      let height = rr.startH;
      if (rr.mode === "right") width = snapSize(rr.startW + dx);
      if (rr.mode === "bottom") height = snapSize(rr.startH + dy);
      if (rr.mode === "top") {
        y = snapToGrid(rr.startY + dy, Math.max(1, Math.floor(gridSize || 24)));
        height = snapSize(rr.startH - (y - rr.startY));
      }
      if (rr.mode === "corner") {
        width = snapSize(rr.startW + dx);
        height = snapSize(rr.startH + dy);
      }
      updateBlock(id as any, { x, y, width, height } as any);
    });
  };

  const endResize = (e: React.PointerEvent) => {
    const rr = resizeRef.current;
    if (!rr || rr.pointerId !== e.pointerId) return;
    if (rr.raf != null) window.cancelAnimationFrame(rr.raf);
    try {
      rr.capturer?.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    resizeRef.current = null;
  };

  const renderByVariant = () => {
    return (
      <textarea
        data-universal-textarea-id={id}
        value={brickContent}
        onChange={(e) => patchBrickContent(e.target.value)}
        onFocus={() => selectBlocks([id])}
        className="w-full h-full resize-none bg-transparent outline-none"
        style={{ fontSize: `${brickFontPx}px`, lineHeight: "1.25" }}
        placeholder="Type text..."
      />
    );

    if (type === "container") {
      const layoutDirection = String(data.layoutDirection || "vertical");
      const containerLabel = String(data.label || "");
      const align = String(data.align || "start");
      return (
        <div className="h-full rounded border border-black/15 bg-white/45 p-2 relative overflow-hidden">
          <div className="absolute top-2 right-2 z-10">
            <select
              value={layoutDirection}
              onChange={(e) => onDataPatch({ layoutDirection: e.target.value })}
              className="text-[10px] rounded border border-black/15 bg-white/80 px-1 py-0.5 outline-none"
            >
              <option value="vertical">vertical</option>
              <option value="horizontal">horizontal</option>
            </select>
          </div>
          <div className="absolute top-2 left-2 z-10">
            <select
              value={align}
              onChange={(e) => onDataPatch({ align: e.target.value })}
              className="text-[10px] rounded border border-black/15 bg-white/80 px-1 py-0.5 outline-none"
            >
              <option value="start">start</option>
              <option value="center">center</option>
              <option value="end">end</option>
            </select>
          </div>
          <div className="h-full w-full flex items-center justify-center">
            <div className="w-[82%] h-[68%] rounded-lg border border-black/20 bg-white/40 backdrop-blur-[2px] p-2 flex flex-col gap-2">
              <div className={`flex ${layoutDirection === "horizontal" ? "flex-row" : "flex-col"} gap-2 h-full`}>
                <div className="flex-1 rounded border border-dashed border-black/20 bg-white/45" />
                <div className="flex-1 rounded border border-dashed border-black/20 bg-white/35" />
              </div>
            </div>
          </div>
          <input
            value={containerLabel}
            onChange={(e) => onDataPatch({ label: e.target.value })}
            className="absolute bottom-2 left-2 right-2 text-[10px] bg-white/70 rounded border border-black/10 px-1 py-0.5 outline-none"
            placeholder="Container label"
          />
        </div>
      );
    }

    if (type === "text") {
      return (
        <textarea
          value={body}
          onChange={(e) => onDataPatch({ body: e.target.value })}
          className="w-full h-full resize-none bg-transparent outline-none text-[11px]"
          placeholder="Type text..."
        />
      );
    }

    if (type === "button") {
      const label = String(data.label || "Action");
      const actionType = String(data.actionType || "custom");
      const targetBlockId = String(data.targetBlockId || "");
      const handleButtonClick = () => {
        if (actionType === "toggle_visibility" && targetBlockId) {
          const target = allBlocks?.[targetBlockId] as any;
          if (!target) return;
          const current = String(target?.universal?.visibility || "visible");
          const next = current === "hidden" ? "visible" : "hidden";
          updateBlock(targetBlockId as any, {
            universal: { ...(target.universal || {}), visibility: next },
          } as any);
          return;
        }
        if (actionType === "navigate" && targetBlockId) {
          const target = allBlocks?.[targetBlockId] as any;
          if (!target) return;
          setCamera({ x: Math.max(0, Number(target.x || 0) - 120), y: Math.max(0, Number(target.y || 0) - 80), zoom: 1 });
          return;
        }
        if (actionType === "emit_event") {
          try {
            window.dispatchEvent(new CustomEvent("universal_button_action", { detail: { sourceId: id, targetBlockId, actionType } }));
          } catch {
            // ignore
          }
        }
      };
      return (
        <div className="h-full flex flex-col gap-2">
          <button
            type="button"
            onClick={handleButtonClick}
            className="h-8 rounded bg-black text-white text-[11px] px-2"
          >
            {label}
          </button>
          <input
            value={label}
            onChange={(e) => onDataPatch({ label: e.target.value })}
            className="w-full h-6 rounded border border-black/10 bg-white/90 text-[10px] px-1 outline-none"
            placeholder="Label"
          />
          <input
            value={actionType}
            onChange={(e) => onDataPatch({ actionType: e.target.value })}
            className="w-full h-6 rounded border border-black/10 bg-white/90 text-[10px] px-1 outline-none"
            placeholder="Action type"
          />
          <input
            value={targetBlockId}
            onChange={(e) => onDataPatch({ targetBlockId: e.target.value })}
            className="w-full h-6 rounded border border-black/10 bg-white/90 text-[10px] px-1 outline-none"
            placeholder="Target block id"
          />
        </div>
      );
    }

    if (definition.renderVariant === "taskboard") {
      const normalizedColumns =
        columns.length > 0
          ? columns
          : [
              { id: "todo", title: "To Do", cards: [] },
              { id: "inprogress", title: "In Progress", cards: [] },
              { id: "done", title: "Done", cards: [] },
            ];
      return (
        <div className="h-full grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.max(1, normalizedColumns.length)}, minmax(150px, 1fr))` }}>
          {normalizedColumns.map((col: any, i: number) => (
            <div key={String(col?.id || i)} className="rounded-md border border-black/10 bg-white/55 p-2 overflow-auto">
              <input
                value={String(col?.title || `Column ${i + 1}`)}
                onChange={(e) => {
                  const next = normalizedColumns.map((c: any, idx: number) => (idx === i ? { ...c, title: e.target.value } : c));
                  onDataPatch({ columns: next });
                }}
                className="w-full bg-transparent text-[11px] font-semibold outline-none"
              />
              <div className="space-y-1 mt-2">
                {normalizeCards(col?.cards).map((card, idx) => (
                  <input
                    key={`${i}-${idx}`}
                    value={card}
                    onChange={(e) => {
                      const next = normalizedColumns.map((c: any, ci: number) => {
                        if (ci !== i) return c;
                        const cards = normalizeCards(c.cards);
                        cards[idx] = e.target.value;
                        return { ...c, cards };
                      });
                      onDataPatch({ columns: next });
                    }}
                    className="w-full rounded border border-black/10 bg-white/85 px-2 py-1 text-[11px] outline-none"
                  />
                ))}
                <button
                  type="button"
                  onClick={() => {
                    const next = normalizedColumns.map((c: any, ci: number) =>
                      ci === i ? { ...c, cards: [...normalizeCards(c.cards), ""] } : c
                    );
                    onDataPatch({ columns: next });
                  }}
                  className="w-full rounded border border-dashed border-black/20 px-2 py-1 text-[10px] text-black/60"
                >
                  Add card
                </button>
              </div>
            </div>
          ))}
        </div>
      );
    }

    if (definition.renderVariant === "spreadsheet") {
      return (
        <div className="h-full overflow-auto rounded border border-black/10 bg-white/70 p-1">
          <div className="grid grid-cols-4 gap-1">
            {Array.from({ length: 16 }).map((_, idx) => (
              <div key={idx} className="h-7 rounded border border-black/10 bg-white/80 text-[10px] px-1 flex items-center">
                {String((data.cellsText || "").split(",")[idx] || "")}
              </div>
            ))}
          </div>
        </div>
      );
    }

    if (definition.renderVariant === "code") {
      return (
        <div className="h-full overflow-auto">
          <textarea
            value={String(data.code || "")}
            onChange={(e) => onDataPatch({ code: e.target.value })}
            className="w-full h-full resize-none bg-black/90 text-emerald-200 outline-none text-[11px] font-mono p-2 rounded"
            placeholder="Write code..."
          />
        </div>
      );
    }

    if (definition.renderVariant === "list") {
      return (
        <div className="space-y-1 overflow-auto h-full">
          {items.map((it: any, i: number) => (
            <input
              key={i}
              value={String(it || "")}
              onChange={(e) => {
                const next = [...items];
                next[i] = e.target.value;
                onDataPatch({ items: next });
              }}
              className="w-full rounded border border-black/10 bg-white/75 px-2 py-1 text-[11px] outline-none"
            />
          ))}
          <button
            type="button"
            onClick={() => onDataPatch({ items: [...items, ""] })}
            className="w-full rounded border border-dashed border-black/20 px-2 py-1 text-[10px] text-black/60"
          >
            Add item
          </button>
        </div>
      );
    }

    if (definition.renderVariant === "sheet" || definition.renderVariant === "text") {
      if (type === "heading") {
        return (
          <input
            value={body}
            onChange={(e) => onDataPatch({ body: e.target.value })}
            className="w-full h-full bg-transparent outline-none text-[18px] font-semibold"
            placeholder="Heading..."
          />
        );
      }
      if (type === "document" || type === "notes") {
        return (
          <textarea
            value={body}
            onChange={(e) => onDataPatch({ body: e.target.value })}
            className="w-full h-full resize-none bg-white/60 rounded border border-black/10 p-2 outline-none text-[11px]"
            placeholder={`Write ${definition.name.toLowerCase()}...`}
          />
        );
      }
      return (
        <textarea
          value={body}
          onChange={(e) => onDataPatch({ body: e.target.value })}
          className="w-full h-full resize-none bg-transparent outline-none text-[11px]"
          placeholder={`Write ${definition.name.toLowerCase()}...`}
        />
      );
    }

    // DATA BLOCKS
    if (type === "database") {
      const db = data.database || {};
      const schema = Array.isArray(db.propertiesSchema)
        ? db.propertiesSchema
        : [
            { name: "Name", type: "text" },
            { name: "Status", type: "status" },
          ];
      const entries = Array.isArray(db.entries) ? db.entries : [{ properties: { Name: "Entry 1", Status: "Not Started" } }];
      const views = Array.isArray(db.views)
        ? db.views
        : [
            { viewType: "table", visibleProperties: ["Name", "Status"], filters: [], sorting: [], grouping: [] },
            { viewType: "board", visibleProperties: ["Name", "Status"], filters: [], sorting: [], grouping: [] },
          ];
      const relations = Array.isArray(db.relations) ? db.relations : [];
      const rollups = Array.isArray(db.rollups) ? db.rollups : [];
      return (
        <div className="h-full rounded border border-black/10 bg-white/70 p-2 overflow-auto space-y-2">
          <div className="text-[10px] font-semibold">Properties</div>
          <div className="grid grid-cols-2 gap-1">
            {schema.map((p: any, i: number) => (
              <div key={i} className="flex gap-1">
                <input
                  value={String(p?.name || "")}
                  onChange={(e) => {
                    const next = schema.map((x: any) => ({ ...x }));
                    next[i].name = e.target.value;
                    onDataPatch({ database: { ...db, propertiesSchema: next } });
                  }}
                  className="w-1/2 h-6 rounded border border-black/10 bg-white/90 text-[10px] px-1 outline-none"
                />
                <input
                  value={String(p?.type || "text")}
                  onChange={(e) => {
                    const next = schema.map((x: any) => ({ ...x }));
                    next[i].type = e.target.value;
                    onDataPatch({ database: { ...db, propertiesSchema: next } });
                  }}
                  className="w-1/2 h-6 rounded border border-black/10 bg-white/90 text-[10px] px-1 outline-none"
                />
              </div>
            ))}
          </div>
          <div className="text-[10px] font-semibold">Entries</div>
          <div className="space-y-1">
            {entries.map((entry: any, i: number) => (
              <input
                key={i}
                value={String(entry?.properties?.Name || "")}
                onChange={(e) => {
                  const next = entries.map((x: any) => ({ ...x, properties: { ...(x.properties || {}) } }));
                  next[i].properties.Name = e.target.value;
                  onDataPatch({ database: { ...db, entries: next } });
                }}
                className="w-full h-6 rounded border border-black/10 bg-white/90 text-[10px] px-1 outline-none"
              />
            ))}
          </div>
          <div className="text-[10px] font-semibold">Views</div>
          <div className="flex flex-wrap gap-1">
            {views.map((v: any, i: number) => (
              <input
                key={i}
                value={String(v?.viewType || "")}
                onChange={(e) => {
                  const next = views.map((x: any) => ({ ...x }));
                  next[i].viewType = e.target.value;
                  onDataPatch({ database: { ...db, views: next } });
                }}
                className="w-20 h-6 rounded border border-black/10 bg-white/90 text-[10px] px-1 outline-none"
              />
            ))}
          </div>
          <div className="text-[10px] font-semibold">Relations / Rollups</div>
          <div className="space-y-1">
            {relations.map((r: any, i: number) => (
              <input
                key={`rel-${i}`}
                value={`${String(r?.targetDatabaseId || "")}:${String(r?.relationType || "")}`}
                onChange={(e) => {
                  const [targetDatabaseId, relationType] = String(e.target.value || "").split(":");
                  const next = relations.map((x: any) => ({ ...x }));
                  next[i] = { targetDatabaseId: targetDatabaseId || "", relationType: relationType || "one-to-many" };
                  onDataPatch({ database: { ...db, relations: next } });
                }}
                className="w-full h-6 rounded border border-black/10 bg-white/90 text-[10px] px-1 outline-none"
              />
            ))}
            {rollups.map((r: any, i: number) => (
              <input
                key={`roll-${i}`}
                value={`${String(r?.sourceRelation || "")}:${String(r?.property || "")}:${String(r?.aggregation || "")}`}
                onChange={(e) => {
                  const [sourceRelation, property, aggregation] = String(e.target.value || "").split(":");
                  const next = rollups.map((x: any) => ({ ...x }));
                  next[i] = { sourceRelation: sourceRelation || "", property: property || "", aggregation: aggregation || "count" };
                  onDataPatch({ database: { ...db, rollups: next } });
                }}
                className="w-full h-6 rounded border border-black/10 bg-white/90 text-[10px] px-1 outline-none"
              />
            ))}
          </div>
        </div>
      );
    }

    if (type === "table") {
      const headers = normalizeStrings(data.headers, ["Col 1", "Col 2", "Col 3", "Col 4", "Col 5"]);
      const rows = Array.isArray(data.rows) && data.rows.length ? data.rows : Array.from({ length: 4 }, () => Array.from({ length: headers.length }, () => ""));
      const tableCells = rows.flatMap((row: any[], r: number) =>
        headers.map((_, c: number) => (
          <input
            key={`${r}-${c}`}
            value={String(row?.[c] ?? "")}
            onChange={(e) => {
              const nextRows = rows.map((rr: any[]) => [...rr]);
              if (!nextRows[r]) nextRows[r] = [];
              nextRows[r][c] = e.target.value;
              onDataPatch({ rows: nextRows });
            }}
            className="h-6 rounded border border-black/10 text-[10px] px-1 bg-white/80 outline-none"
          />
        ))
      );
      return (
        <div className="h-full rounded border border-black/10 bg-white/70 p-1 overflow-auto">
          <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${headers.length}, minmax(80px, 1fr))` }}>
            {headers.map((h, i) => (
              <input
                key={`h-${i}`}
                value={h}
                onChange={(e) => {
                  const next = [...headers];
                  next[i] = e.target.value;
                  onDataPatch({ headers: next });
                }}
                className="h-6 rounded border border-black/10 text-[10px] px-1 bg-black/10 font-semibold outline-none"
              />
            ))}
            {tableCells}
          </div>
        </div>
      );
    }
    if (["kanban", "calendar", "timeline", "card_grid", "list"].includes(type) && data.sourceDatabaseId) {
      return (
        <div className="h-full rounded border border-black/10 bg-white/75 p-2 space-y-2">
          <div className="text-[10px] font-semibold">{definition.name} View</div>
          <input
            value={String(data.sourceDatabaseId || "")}
            onChange={(e) => onDataPatch({ sourceDatabaseId: e.target.value })}
            className="w-full h-6 rounded border border-black/10 bg-white/90 text-[10px] px-1 outline-none"
            placeholder="source database id"
          />
          <textarea
            value={JSON.stringify(data.view || {}, null, 2)}
            onChange={(e) => {
              try {
                const parsed = JSON.parse(e.target.value || "{}");
                onDataPatch({ view: parsed });
              } catch {
                onDataPatch({ viewRaw: e.target.value });
              }
            }}
            className="w-full h-[calc(100%-54px)] rounded border border-black/10 bg-white/90 p-2 text-[10px] resize-none outline-none"
          />
        </div>
      );
    }
    if (type === "card_grid") {
      const cards = normalizeStrings(data.cards, ["Card 1", "Card 2", "Card 3", "Card 4"]);
      return (
        <div className="h-full grid grid-cols-2 gap-2 overflow-auto">
          {cards.map((card, i) => (
            <textarea
              key={i}
              value={card}
              onChange={(e) => {
                const next = [...cards];
                next[i] = e.target.value;
                onDataPatch({ cards: next });
              }}
              className="rounded border border-black/10 bg-white/80 p-2 text-[10px] resize-none outline-none h-16"
            />
          ))}
        </div>
      );
    }
    if (type === "calendar" || type === "date_picker") {
      const events = { ...(data.events || {}) } as Record<string, string>;
      return (
        <div className="h-full rounded border border-black/10 bg-white/75 p-2 overflow-auto">
          <div className="grid grid-cols-7 gap-1">
            {Array.from({ length: 35 }).map((_, i) => (
              <input
                key={i}
                value={i < 31 ? String(events[String(i + 1)] || i + 1) : ""}
                onChange={(e) => {
                  if (i >= 31) return;
                  const next = { ...events, [String(i + 1)]: e.target.value };
                  onDataPatch({ events: next });
                }}
                className="h-6 rounded border border-black/10 bg-white/90 text-[9px] px-1 outline-none"
              />
            ))}
          </div>
        </div>
      );
    }
    if (type === "timeline") {
      const milestones = normalizeStrings(data.milestones, ["Kickoff", "Build", "QA", "Launch"]);
      return (
        <div className="h-full overflow-auto space-y-2">
          {milestones.map((m, i) => (
            <div key={m} className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-orange-400" />
              <div className="h-0.5 flex-1 bg-black/15" />
              <input
                value={m}
                onChange={(e) => {
                  const next = [...milestones];
                  next[i] = e.target.value;
                  onDataPatch({ milestones: next });
                }}
                className="text-[10px] bg-transparent outline-none w-24"
              />
            </div>
          ))}
        </div>
      );
    }
    if (type === "hierarchy") {
      const hierarchyText = String(data.hierarchyText || "Root\n  Child A\n    Grandchild A1\n  Child B");
      return (
        <textarea
          value={hierarchyText}
          onChange={(e) => onDataPatch({ hierarchyText: e.target.value })}
          className="w-full h-full rounded border border-black/10 bg-white/70 p-2 text-[10px] leading-5 overflow-auto resize-none outline-none"
        />
      );
    }
    if (type === "relationship_link" || type === "graph_map") {
      const nodeA = String(data.nodeA || "Node A");
      const nodeB = String(data.nodeB || "Node B");
      const relationship = String(data.relationship || "related_to");
      return (
        <div className="h-full rounded border border-black/10 bg-white/70 p-2 relative">
          <input
            value={nodeA}
            onChange={(e) => onDataPatch({ nodeA: e.target.value })}
            className="absolute left-3 top-6 w-20 h-8 rounded bg-blue-100 border border-blue-300 text-[9px] px-1 outline-none"
          />
          <input
            value={nodeB}
            onChange={(e) => onDataPatch({ nodeB: e.target.value })}
            className="absolute right-3 bottom-6 w-20 h-8 rounded bg-purple-100 border border-purple-300 text-[9px] px-1 outline-none"
          />
          <div className="absolute left-14 top-10 right-14 bottom-10 border-t-2 border-dashed border-black/30" />
          <input
            value={relationship}
            onChange={(e) => onDataPatch({ relationship: e.target.value })}
            className="absolute left-1/2 -translate-x-1/2 top-1/2 -translate-y-1/2 w-24 h-6 rounded border border-black/10 bg-white/90 text-[9px] px-1 outline-none"
          />
        </div>
      );
    }
    if (type === "file_repository" || type === "file_upload") {
      const files = normalizeStrings(data.files, ["requirements.pdf", "brief.docx", "design.png"]);
      return (
        <div className="h-full rounded border border-black/10 bg-white/75 p-2 space-y-1 overflow-auto">
          {files.map((f, i) => (
            <input
              key={i}
              value={f}
              onChange={(e) => {
                const next = [...files];
                next[i] = e.target.value;
                onDataPatch({ files: next });
              }}
              className="w-full rounded border border-black/10 bg-white/85 px-2 py-1 text-[10px] outline-none"
            />
          ))}
        </div>
      );
    }

    // INPUT / CONTENT UTILS
    if (type === "form") {
      const fields = normalizeStrings(data.formFields, ["Name", "Email", "Details"]);
      const buttonLabel = String(data.buttonLabel || "Submit");
      return (
        <div className="h-full space-y-2 overflow-auto">
          {fields.map((field, i) => (
            <input
              key={i}
              className="w-full rounded border border-black/15 bg-white/85 px-2 py-1 text-[11px] outline-none"
              value={field}
              onChange={(e) => {
                const next = [...fields];
                next[i] = e.target.value;
                onDataPatch({ formFields: next });
              }}
            />
          ))}
          <input
            className="w-full rounded bg-black text-white text-[11px] py-1 px-2 outline-none"
            value={buttonLabel}
            onChange={(e) => onDataPatch({ buttonLabel: e.target.value })}
          />
        </div>
      );
    }
    if (type === "input") {
      const inputKind = String(data.inputKind || "text");
      const label = String(data.label || "Input");
      const value = String(data.value || "");
      if (inputKind === "checkbox") {
        return (
          <label className="h-full flex items-center gap-2 text-[11px]">
            <input
              type="checkbox"
              checked={Boolean(data.checked)}
              onChange={(e) => onDataPatch({ checked: e.target.checked })}
            />
            <input
              value={label}
              onChange={(e) => onDataPatch({ label: e.target.value })}
              className="bg-transparent outline-none flex-1"
            />
          </label>
        );
      }
      if (inputKind === "toggle") {
        const enabled = Boolean(data.enabled);
        return (
          <div className="h-full flex items-center justify-between rounded border border-black/15 bg-white/80 px-3">
            <input
              value={label}
              onChange={(e) => onDataPatch({ label: e.target.value })}
              className="text-[11px] bg-transparent outline-none w-20"
            />
            <button
              type="button"
              onClick={() => onDataPatch({ enabled: !enabled })}
              className={`w-10 h-5 rounded-full p-0.5 ${enabled ? "bg-emerald-500/70" : "bg-black/20"}`}
            >
              <span className={`block w-4 h-4 rounded-full bg-white transition-transform ${enabled ? "translate-x-5" : ""}`} />
            </button>
          </div>
        );
      }
      return (
        <div className="h-full rounded border border-black/10 bg-white/75 p-2 space-y-2">
          <input
            value={label}
            onChange={(e) => onDataPatch({ label: e.target.value })}
            className="w-full h-6 rounded border border-black/10 bg-white/90 text-[10px] px-1 outline-none"
            placeholder="Label"
          />
          <input
            type={inputKind === "number" ? "number" : "text"}
            value={value}
            onChange={(e) => onDataPatch({ value: e.target.value })}
            className="w-full h-7 rounded border border-black/10 bg-white/90 text-[11px] px-2 outline-none"
            placeholder={inputKind === "date" ? "YYYY-MM-DD" : "Value"}
          />
          <input
            value={inputKind}
            onChange={(e) => onDataPatch({ inputKind: e.target.value })}
            className="w-full h-6 rounded border border-black/10 bg-white/90 text-[10px] px-1 outline-none"
            placeholder="text | number | checkbox | toggle | dropdown | date | file"
          />
        </div>
      );
    }
    if (type === "text_input" || type === "number_input" || type === "dropdown" || type === "multi_select" || type === "search") {
      return <input className="w-full rounded border border-black/15 bg-white/85 px-2 py-1 text-[11px]" placeholder={definition.name} />;
    }
    if (type === "toggle") {
      const enabled = Boolean(data.enabled);
      return (
        <div className="h-full flex items-center justify-between rounded border border-black/15 bg-white/80 px-3">
          <input
            value={String(data.label || "Enabled")}
            onChange={(e) => onDataPatch({ label: e.target.value })}
            className="text-[11px] bg-transparent outline-none w-20"
          />
          <button
            type="button"
            onClick={() => onDataPatch({ enabled: !enabled })}
            className={`w-10 h-5 rounded-full p-0.5 ${enabled ? "bg-emerald-500/70" : "bg-black/20"}`}
          >
            <span className={`block w-4 h-4 rounded-full bg-white transition-transform ${enabled ? "translate-x-5" : ""}`} />
          </button>
        </div>
      );
    }
    if (type === "button")
      return (
        <input
          className="w-full h-full rounded bg-black text-white text-[12px] text-center outline-none"
          value={String(data.label || "Action")}
          onChange={(e) => onDataPatch({ label: e.target.value })}
        />
      );
    if (type === "rating_input") {
      const rating = Math.max(0, Math.min(5, Number(data.rating || 3)));
      return (
        <div className="h-full flex items-center gap-1 text-yellow-500 text-lg">
          {Array.from({ length: 5 }).map((_, i) => (
            <button key={i} type="button" onClick={() => onDataPatch({ rating: i + 1 })}>
              {i < rating ? "★" : "☆"}
            </button>
          ))}
        </div>
      );
    }
    if (type === "checklist") {
      const checklistItems = normalizeStrings(data.checklistItems, ["Item 1", "Item 2", "Item 3"]);
      return (
        <div className="space-y-1">
          {checklistItems.map((it, i) => (
            <label key={`${it}-${i}`} className="flex items-center gap-2 text-[11px]">
              <input type="checkbox" checked={Boolean((data.checked || {})[i])} onChange={(e) => onDataPatch({ checked: { ...(data.checked || {}), [i]: e.target.checked } })} />
              <input
                value={it}
                onChange={(e) => {
                  const next = [...checklistItems];
                  next[i] = e.target.value;
                  onDataPatch({ checklistItems: next });
                }}
                className="bg-transparent outline-none flex-1"
              />
            </label>
          ))}
        </div>
      );
    }
    if (type === "callout")
      return (
        <textarea
          value={String(data.callout || "Important callout")}
          onChange={(e) => onDataPatch({ callout: e.target.value })}
          className="w-full h-full rounded border border-amber-300 bg-amber-100/60 p-2 text-[11px] resize-none outline-none"
        />
      );
    if (type === "media" || type === "embed")
      return (
        <div className="h-full rounded border border-black/15 bg-black/10 p-2 space-y-2">
          <input
            value={String(data.url || "")}
            onChange={(e) => onDataPatch({ url: e.target.value })}
            className="w-full rounded border border-black/15 bg-white/90 px-2 py-1 text-[10px] outline-none"
            placeholder="Media URL"
          />
          <textarea
            value={String(data.caption || "")}
            onChange={(e) => onDataPatch({ caption: e.target.value })}
            className="w-full h-[calc(100%-30px)] rounded border border-black/15 bg-white/90 p-2 text-[10px] resize-none outline-none"
            placeholder="Caption / description"
          />
        </div>
      );
    if (type === "divider")
      return (
        <div className="h-full flex items-center gap-2">
          <div className="w-full h-px bg-black/25" />
          <input
            value={String(data.label || "")}
            onChange={(e) => onDataPatch({ label: e.target.value })}
            className="w-20 text-[10px] bg-transparent outline-none text-center"
            placeholder="Label"
          />
          <div className="w-full h-px bg-black/25" />
        </div>
      );

    // LOGIC BLOCKS
    if (["filter", "sort", "grouping", "formula", "conditional", "dependency", "workflow", "trigger", "schedule", "validation"].includes(type)) {
      const rules = normalizeStrings(data.rules, ["Rule 1", "Rule 2"]);
      return (
        <div className="h-full rounded border border-black/10 bg-white/75 p-2 space-y-1">
          <div className="text-[10px] font-semibold">{definition.name} Rules</div>
          {rules.map((rule, i) => (
            <input
              key={i}
              value={rule}
              onChange={(e) => {
                const next = [...rules];
                next[i] = e.target.value;
                onDataPatch({ rules: next });
              }}
              className="w-full rounded border border-black/10 bg-white/85 px-2 py-1 text-[10px] outline-none"
            />
          ))}
        </div>
      );
    }

    // VISUALIZATION BLOCKS
    if (type === "kpi") {
      return (
        <div className="h-full rounded border border-black/10 bg-white/80 p-2">
          <input
            value={String(data.metricName || "Metric")}
            onChange={(e) => onDataPatch({ metricName: e.target.value })}
            className="w-full text-[10px] text-black/50 bg-transparent outline-none"
          />
          <input
            value={String(data.metricValue || "42%")}
            onChange={(e) => onDataPatch({ metricValue: e.target.value })}
            className="w-full text-xl font-bold bg-transparent outline-none"
          />
        </div>
      );
    }
    if (type === "progress") {
      const pct = Math.max(0, Math.min(100, Number(data.progress || 67)));
      return (
        <div className="h-full flex flex-col justify-center gap-2">
          <div className="h-3 rounded bg-black/10 overflow-hidden"><div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} /></div>
          <input
            type="number"
            min={0}
            max={100}
            value={pct}
            onChange={(e) => onDataPatch({ progress: Number(e.target.value || 0) })}
            className="text-[10px] bg-transparent outline-none"
          />
        </div>
      );
    }
    if (["bar_chart", "line_chart", "pie_chart", "heatmap", "gauge"].includes(type)) {
      const values = normalizeStrings(String(data.values || "20,35,40,25,55,45,60,30,50,70").split(",")).map((v) => Number(v) || 0);
      return (
        <div className="h-full rounded border border-black/10 bg-white/75 p-2">
          <input
            value={values.join(",")}
            onChange={(e) => onDataPatch({ values: e.target.value })}
            className="w-full mb-2 rounded border border-black/10 bg-white/85 px-2 py-1 text-[9px] outline-none"
          />
          <div className="h-full flex items-end gap-1">
            {values.map((n, i) => (
              <div key={i} className="flex-1 rounded-t bg-blue-400/70" style={{ height: `${Math.max(8, Math.min(100, n))}%` }} />
            ))}
          </div>
        </div>
      );
    }
    if (type === "activity_feed") {
      const events = normalizeStrings(data.eventsList, ["Updated record", "Added note", "Assigned task", "Closed issue"]);
      return (
        <div className="h-full space-y-1 overflow-auto">
          {events.map((a, i) => (
            <input
              key={i}
              value={a}
              onChange={(e) => {
                const next = [...events];
                next[i] = e.target.value;
                onDataPatch({ eventsList: next });
              }}
              className="w-full rounded border border-black/10 bg-white/80 px-2 py-1 text-[10px] outline-none"
            />
          ))}
        </div>
      );
    }
    if (type === "dashboard" || type === "summary") {
      const widgets = normalizeStrings(data.widgets, ["KPI", "Chart", "Feed", "Summary"]);
      return (
        <div className="h-full grid grid-cols-2 gap-2">
          {widgets.slice(0, 4).map((w, i) => (
            <textarea
              key={i}
              value={w}
              onChange={(e) => {
                const next = [...widgets];
                next[i] = e.target.value;
                onDataPatch({ widgets: next });
              }}
              className="rounded border border-black/10 bg-white/80 p-2 text-[10px] resize-none outline-none"
            />
          ))}
        </div>
      );
    }

    // AI BLOCKS
    if (type.startsWith("ai_")) {
      return (
        <div className="h-full rounded border border-violet-200 bg-violet-50/70 p-2 space-y-2">
          <div className="text-[10px] font-semibold text-violet-700">{definition.name}</div>
          <textarea
            className="w-full h-[calc(100%-66px)] resize-none rounded border border-violet-200 bg-white/85 p-2 text-[10px] outline-none"
            placeholder="AI prompt or context..."
            value={String(data.prompt || "")}
            onChange={(e) => onDataPatch({ prompt: e.target.value })}
          />
          <input
            value={String(data.output || "")}
            onChange={(e) => onDataPatch({ output: e.target.value })}
            className="w-full rounded border border-violet-200 bg-white/85 px-2 py-1 text-[10px] outline-none"
            placeholder="AI output"
          />
        </div>
      );
    }

    // SYSTEM / CONTAINER BLOCKS
    if (type === "permissions") {
      return (
        <div className="h-full space-y-1 text-[10px]">
          {["View", "Edit", "Admin"].map((p) => (
            <label key={p} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={Boolean((data.permissions || {})[p.toLowerCase()] ?? true)}
                onChange={(e) => onDataPatch({ permissions: { ...(data.permissions || {}), [p.toLowerCase()]: e.target.checked } })}
              />
              <span>{p}</span>
            </label>
          ))}
        </div>
      );
    }
    if (["workspace", "page"].includes(type)) {
      return (
        <div className="h-full rounded border border-black/10 bg-white/65 p-2 text-[10px]">
          <input
            value={String(data.title || definition.name)}
            onChange={(e) => onDataPatch({ title: e.target.value })}
            className="mb-1 font-semibold bg-transparent outline-none w-full"
          />
          <textarea
            value={String(data.notes || "")}
            onChange={(e) => onDataPatch({ notes: e.target.value })}
            className="rounded border border-dashed border-black/20 bg-white/60 h-[calc(100%-18px)] w-full p-2 resize-none outline-none text-black/55"
            placeholder={definition.isContainer ? "Container content notes..." : "System panel notes..."}
          />
          <div className="mt-1 text-[9px] text-black/45">
            {type === "page" ? "Page container (top-level navigation unit)" : definition.isContainer ? "Container block" : "System block"}
          </div>
        </div>
      );
    }

    return (
      <div className="h-full overflow-auto space-y-2">
        <div className="text-[11px] text-black/70">
          {definition.name} ({definition.category})
        </div>
        <textarea
          value={String(data.configText || "")}
          onChange={(e) => onDataPatch({ configText: e.target.value })}
          className="w-full h-[calc(100%-22px)] resize-none rounded border border-black/10 bg-white/70 p-2 text-[11px] outline-none"
          placeholder="Configure this block behavior..."
        />
      </div>
    );
  };

  return (
    <div
      data-canvas-block
      data-block-id={id}
      className="absolute group"
      style={style}
      onPointerDownCapture={(e) => {
        if (!e.shiftKey) return;
        const t = e.target as Element | null;
        if (t?.closest?.("[data-resize-handle]")) return;
        e.preventDefault();
        e.stopPropagation();
        void tryShiftLinkNeighbor();
      }}
    >
      <div
        data-drag-handle
        className="absolute inset-x-0 top-0 h-3 z-30 cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity"
        onPointerDown={startDrag}
        onPointerMove={onDragMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
      />
      <div className="h-full w-full rounded-lg border border-white/45 bg-[linear-gradient(145deg,rgba(255,255,255,0.76),rgba(255,255,255,0.46))] backdrop-blur-md shadow-[0_14px_32px_rgba(0,0,0,0.08)] overflow-hidden">
        <div className="h-7 px-2 border-b border-black/10 bg-white/45 flex items-center justify-between">
          <div className="text-[10px] font-semibold text-black/75 truncate">Brick</div>
          <div className="text-[9px] text-black/45 uppercase">text</div>
        </div>
        <div className="h-[calc(100%-28px)] p-2">{renderByVariant()}</div>
      </div>

      <div className="absolute inset-0 pointer-events-none">
        <div
          data-resize-handle
          className="absolute top-0 bottom-0 right-0 w-2 pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ cursor: "ew-resize" }}
          onPointerDown={(e) => beginResize(e, "right")}
          onPointerMove={onResizeMove}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          onLostPointerCapture={endResize}
        />
        <div
          data-resize-handle
          className="absolute left-0 right-0 top-0 h-2 pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ cursor: "ns-resize" }}
          onPointerDown={(e) => beginResize(e, "top")}
          onPointerMove={onResizeMove}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          onLostPointerCapture={endResize}
        />
        <div
          data-resize-handle
          className="absolute left-0 right-0 bottom-0 h-2 pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ cursor: "ns-resize" }}
          onPointerDown={(e) => beginResize(e, "bottom")}
          onPointerMove={onResizeMove}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          onLostPointerCapture={endResize}
        />
        <div
          data-resize-handle
          className="absolute right-0 bottom-0 w-4 h-4 pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ cursor: "nwse-resize" }}
          onPointerDown={(e) => beginResize(e, "corner")}
          onPointerMove={onResizeMove}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          onLostPointerCapture={endResize}
        />
      </div>
    </div>
  );
});

