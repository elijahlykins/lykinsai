import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type { Block, BlockId, Camera, LegacyListItem, LegacyListType, TextBlock, TextFormat } from "@/canvas/types";
import { snapToGrid } from "@/canvas/utils/snap";
import { migrateLegacyBlocks } from "@/canvas/utils/migrateBlocks";
import { extractYouTubeVideoId } from "@/canvas/utils/youtube";
import type { UniversalBlockConnection, UniversalBlockRuntime } from "@/canvas/blockSystem/types";
import type { BrickTrait } from "@/canvas/blockSystem/types";

type CanvasState = {
  blocks: Record<BlockId, Block>;
  blockOrder: BlockId[];
  selectedIds: BlockId[];
  camera: Camera;
  gridSize: number;
  // Visible canvas width (used to enforce left/right "walls").
  canvasWidth: number | null;
  history: string[];
  future: string[];

  setCanvasWidth: (width: number | null) => void;
  addBlock: (block: Block) => void;
  createTextBlock: (
    x: number,
    y: number,
    initialContent?: string,
    format?: TextBlock["format"]
  ) => TextBlock;
  addTextBlockAt: (
    pos: { x: number; y: number },
    opts?: { width?: number; height?: number; content?: string; format?: TextFormat }
  ) => BlockId;
  addListBlockAt: (pos: { x: number; y: number }, opts: { listType: LegacyListType; width?: number }) => BlockId;
  addSpreadsheetBlockAt: (pos: { x: number; y: number }, opts?: { rows?: number; cols?: number }) => BlockId;
  addSheetBlockAt: (pos: { x: number; y: number }, opts?: { width?: number; height?: number; content?: string; groupId?: string }) => BlockId;
  addCodeBlockAt: (
    pos: { x: number; y: number },
    opts?: { width?: number; height?: number; content?: string; language?: string }
  ) => BlockId;
  addYouTubeBlockAt: (pos: { x: number; y: number }, opts: { url: string; videoId?: string; width?: number; height?: number }) => BlockId;
  updateBlock: (id: BlockId, patch: Partial<Block>) => void;
  deleteBlock: (id: BlockId) => void;
  deleteBlocks: (ids: BlockId[]) => void;
  bringToFront: (id: BlockId) => void;
  loadBlocks: (blocks: Block[], opts?: { camera?: Camera; gridSize?: number }) => void;
  reset: () => void;

  setCamera: (patch: Partial<Camera>) => void;
  panBy: (dx: number, dy: number) => void;
  zoomAt: (args: { clientX: number; clientY: number; rect: DOMRect; delta: number }) => void;

  selectBlocks: (ids: BlockId[]) => void;
  toggleSelect: (id: BlockId) => void;
  clearSelection: () => void;

  moveBlock: (id: BlockId, nextX: number, nextY: number, opts?: { snap?: boolean; snapSize?: number }) => void;
  moveBlocksFromSnapshot: (
    snapshot: Array<{ id: BlockId; x: number; y: number }>,
    dx: number,
    dy: number,
    opts?: { snap?: boolean; snapSize?: number }
  ) => void;

  setListItems: (id: BlockId, items: LegacyListItem[], listType?: LegacyListType) => void;
  toggleTodoItem: (id: BlockId, itemId: string) => void;
  setUniversalRuntime: (id: BlockId, runtime: UniversalBlockRuntime) => void;
  patchUniversalRuntime: (id: BlockId, patch: Partial<UniversalBlockRuntime>) => void;
  upsertUniversalConnection: (id: BlockId, connection: UniversalBlockConnection) => void;
  removeUniversalConnection: (id: BlockId, connectionId: string) => void;
  transformBrickTrait: (id: BlockId, trait: BrickTrait) => void;
  transformSelectedBrickTraits: (trait: BrickTrait) => void;

  pushHistory: () => void;
  undo: () => void;
  redo: () => void;
};

function makeId(prefix = "b") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeListItem(listType: LegacyListType, text: string): LegacyListItem {
  const base: LegacyListItem = { id: makeId("li"), text: String(text ?? "") };
  if (listType === "todo") return { ...base, checked: false };
  return base;
}

function listItemsToText(listType: LegacyListType, items: LegacyListItem[]) {
  const list = Array.isArray(items) ? items : [];
  if (listType === "todo") {
    return list.map((it) => `- [${it.checked ? "x" : " "}] ${it.text || ""}`).join("\n");
  }
  if (listType === "numbered") {
    return list.map((it, idx) => `${idx + 1}. ${it.text || ""}`).join("\n");
  }
  return list.map((it) => `- ${it.text || ""}`).join("\n");
}

function toggleTodoLine(line: string) {
  const match = line.match(/^(\s*)-\s*\[([ xX])\](.*)$/);
  if (!match) return line;
  const [, leading, state, rest] = match;
  const next = state.toLowerCase() === "x" ? " " : "x";
  return `${leading}- [${next}]${rest}`;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function clampXWithinCanvas(args: { x: number; width: number; canvasWidth: number | null }) {
  const { x, width, canvasWidth } = args;
  if (!Number.isFinite(canvasWidth) || (canvasWidth as number) <= 0) return x;
  const cw = Math.floor(canvasWidth as number);
  const w = Math.max(1, Math.floor(width || 0));
  const maxX = Math.max(0, cw - w);
  return clamp(Math.floor(x || 0), 0, maxX);
}

function clampWidthWithinCanvas(args: { x: number; width: number; canvasWidth: number | null }) {
  const { x, width, canvasWidth } = args;
  if (!Number.isFinite(canvasWidth) || (canvasWidth as number) <= 0) return width;
  const cw = Math.floor(canvasWidth as number);
  const maxW = Math.max(1, cw - Math.max(0, Math.floor(x || 0)));
  return Math.max(1, Math.min(Math.floor(width || 0), maxW));
}

function clampWithinContainer(args: { state: CanvasState; block: Block; x: number; y: number }) {
  const { state, block, x, y } = args;
  const nextX = Math.floor(x || 0);
  const nextY = Math.floor(y || 0);
  const containerId = (block as any)?.containerId;
  if (!containerId) return { x: nextX, y: nextY };

  const container: any = (state.blocks as any)?.[containerId];
  if (!container || container.type !== "create") return { x: nextX, y: nextY };

  const cX = Math.floor(container.x || 0);
  const cY = Math.floor(container.y || 0);
  const cW = Math.max(1, Math.floor(container.width || state.gridSize || 24));
  const cH = Math.max(1, Math.floor(container.height || state.gridSize || 24));
  const bW = Math.max(1, Math.floor((block as any).width || state.gridSize || 24));
  const bH = Math.max(1, Math.floor((block as any).height || state.gridSize || 24));

  const minX = cX;
  const maxX = Math.max(minX, cX + cW - bW);
  const minY = cY;
  const maxY = Math.max(minY, cY + cH - bH);

  return {
    x: clamp(nextX, minX, maxX),
    y: clamp(nextY, minY, maxY),
  };
}

function mapTraitState(prevState: any, trait: BrickTrait, content: string) {
  const state = prevState && typeof prevState === "object" ? { ...prevState } : {};
  if (trait === "checkbox") {
    return { checked: Boolean(state.checked) };
  }
  if (trait === "input") {
    return { inputType: String(state.inputType || "text"), value: String(state.value || "") };
  }
  if (trait === "dropdown") {
    const options = Array.isArray(state.options) && state.options.length ? state.options : [content || "Option 1", "Option 2"];
    const value = String(state.value || options[0] || "");
    return { options, value };
  }
  return state;
}

function applyBrickTraitToBlock(block: any, trait: BrickTrait) {
  if (!block) return;
  const currentData = block.data && typeof block.data === "object" ? { ...block.data } : {};
  const content = String(currentData.content ?? block.content ?? currentData.body ?? "");
  block.universalType = "brick";
  block.data = {
    ...currentData,
    trait,
    content,
    body: content,
    kind: "brick",
    state: mapTraitState(currentData.state, trait, content),
  };
  if (block.type === "text") block.content = content;
  block.updatedAt = new Date().toISOString();
}

function upsertBrickConnections(state: CanvasState, seedIds: BlockId[]) {
  const sourceIds = Array.from(new Set((seedIds || []).filter((id) => !!state.blocks[id])));
  if (!sourceIds.length) return;
  const distanceLimit = Math.max(120, Math.floor((state.gridSize || 24) * 12));
  const allIds = state.blockOrder.filter((id) => !!state.blocks[id]);
  const center = (b: any) => ({
    x: Number(b?.x || 0) + Number(b?.width || state.gridSize || 24) / 2,
    y: Number(b?.y || 0) + Number(b?.height || state.gridSize || 24) / 2,
  });

  for (const id of sourceIds) {
    const b = state.blocks[id] as any;
    if (!b) continue;
    const bc = center(b);
    const neighbors = allIds
      .filter((otherId) => otherId !== id)
      .map((otherId) => {
        const ob = state.blocks[otherId] as any;
        const oc = center(ob);
        const dx = oc.x - bc.x;
        const dy = oc.y - bc.y;
        const distance = Math.round(Math.hypot(dx, dy));
        return { otherId, distance };
      })
      .filter((x) => Number.isFinite(x.distance) && x.distance <= distanceLimit)
      .sort((a, b2) => a.distance - b2.distance)
      .slice(0, 3);

    const connections = neighbors.map((n) => ({
      id: `auto-${id}-${n.otherId}`,
      fromId: id,
      toId: n.otherId,
      distance: n.distance,
      kind: "neighbor" as const,
    }));
    const data = b.data && typeof b.data === "object" ? { ...b.data } : {};
    b.data = { ...data, connections };
    if (b.universal && typeof b.universal === "object") {
      b.universal = {
        ...b.universal,
        connections: connections.map((c) => ({
          id: c.id,
          type: "semantic" as const,
          fromBlockId: c.fromId,
          toBlockId: c.toId,
          relationship: "neighbor",
          metadata: { distance: c.distance },
        })),
      };
    }
  }
}

function isAutoPlaceholderTextBrick(blockLike: any) {
  const b = blockLike && typeof blockLike === "object" ? blockLike : {};
  const data = b.data && typeof b.data === "object" ? b.data : {};
  const text = String(data.content ?? data.body ?? b.content ?? "").trim().toLowerCase();
  const title = String(data.title ?? b.name ?? "").trim().toLowerCase();
  const universalType = String(b.universalType || b.universal?.blockType || "").trim().toLowerCase();
  const kind = String(data.kind || "").trim().toLowerCase();
  const trait = String(data.trait || "").trim().toLowerCase();
  const isBrickish = universalType === "brick" || kind === "brick" || trait === "text";
  if (!isBrickish) return false;
  return text === "text brick" || title === "text brick";
}

export const useCanvasStore = create<CanvasState>()(
  immer((set, get) => ({
    blocks: {},
    blockOrder: [],
    selectedIds: [],
    camera: { x: 0, y: 0, zoom: 1 },
    // Match BrickEditor brick size (default 24px).
    gridSize: 24,
    canvasWidth: null,
    history: [],
    future: [],

    setCanvasWidth: (width) => {
      set((state) => {
        const g = Math.max(1, Math.floor(state.gridSize || 24));
        const raw = Number.isFinite(width as any) ? Math.max(g, Math.floor(width as number)) : null;
        // Use the real visible pixel width so the walls go as far as possible.
        const next = raw != null ? raw : null;
        state.canvasWidth = next;

        // Clamp existing blocks so split-screen / resizing can't strand blocks off-screen.
        // Strategy: relocate blocks left first to preserve their width, then only
        // shrink width if the block is wider than the entire canvas.
        if (next != null) {
          const minBlockWidth = g * 4;
          for (const id of state.blockOrder) {
            const b = state.blocks[id];
            if (!b) continue;
            if ((b as any).type === "create") continue;
            const bw = Math.max(1, Math.floor((b as any).width || g));
            let bx = Math.floor((b as any).x || 0);

            // 1. If block overflows right, slide it left to fit at its current width.
            if (bx + bw > next) {
              bx = Math.max(0, next - bw);
            }
            // 2. Only shrink width if wider than the full canvas; enforce minimum.
            let finalW = bw;
            if (bw > next) {
              finalW = Math.max(minBlockWidth, next);
              bx = 0;
            }
            (b as any).x = bx;
            (b as any).width = finalW;
          }
        }
      });
    },

    addBlock: (block) => {
      set((state) => {
        // Keep blocks within the horizontal "walls" if canvasWidth is known.
        const g = Math.max(1, Math.floor(state.gridSize || 24));
        const canvasWidth = state.canvasWidth;
        const bw = Math.max(1, Math.floor((block as any).width || g));
        let bx = Math.floor((block as any).x || 0);
        if (canvasWidth != null && (block as any).type !== "create") {
          const cw = Math.floor(canvasWidth as number);
          const minW = Math.max(1, g * 4);
          if (bx + bw > cw) bx = Math.max(0, cw - bw);
          let finalW = bw;
          if (bw > cw) { finalW = Math.max(minW, cw); bx = 0; }
          (block as any).width = finalW;
          (block as any).x = bx;
        }
        state.blocks[block.id] = block;
        if (!state.blockOrder.includes(block.id)) {
          if ((block as any).type === "create") state.blockOrder.unshift(block.id);
          else state.blockOrder.push(block.id);
        }
        upsertBrickConnections(state, [block.id]);
      });
    },

    createTextBlock: (x, y, initialContent, format) => {
      const grid = get().gridSize;
      return {
        id: makeId("text"),
        type: "text",
        x: clampXWithinCanvas({ x: snapToGrid(x, grid), width: grid, canvasWidth: get().canvasWidth }),
        y: snapToGrid(y, grid),
        width: grid,
        height: grid,
        content: String(initialContent ?? ""),
        format: format || "rich",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    },

    addTextBlockAt: (pos, opts) => {
      const grid = get().gridSize;
      // Default creation: 1 brick x 1 brick (grows as you type).
      const w = opts?.width ?? grid;
      const format: TextFormat = opts?.format || "rich";
      const h = opts?.height ?? grid;
      const content = opts?.content ?? "";
      const b = get().createTextBlock(pos.x, pos.y, content, format);
      b.width = w;
      b.height = h;
      get().addBlock(b);
      return b.id;
    },

    addListBlockAt: (pos, opts) => {
      const grid = get().gridSize;
      const w = opts?.width ?? grid;
      const listType: LegacyListType = opts?.listType || "bulleted";
      const first = makeListItem(listType, "");
      const format: TextFormat =
        listType === "todo"
          ? "todo"
          : listType === "numbered"
          ? "list-ordered"
          : "list-unordered";
      const b = get().createTextBlock(pos.x, pos.y, listItemsToText(listType, [first]), format);
      b.width = w;
      b.height = grid;
      get().addBlock(b);
      return b.id;
    },

    addSpreadsheetBlockAt: (pos, opts) => {
      const grid = get().gridSize;
      const MAX_ROWS = 1000;
      const rows = Number.isFinite(opts?.rows) ? clamp(Math.floor(opts?.rows as number), 1, MAX_ROWS) : 30;
      const cols = Number.isFinite(opts?.cols) ? Math.max(1, Math.floor(opts?.cols as number)) : 20;
      const defaultColW = 96;
      const sheet = {
        version: 1,
        rows,
        cols,
        colWidths: Array.from({ length: cols }, () => defaultColW),
        cells: {},
      };
      const b = get().createTextBlock(pos.x, pos.y, JSON.stringify(sheet), "table");
      b.width = Math.max(grid * 12, grid * 18);
      b.height = Math.max(grid * 10, (rows + 1) * grid);
      get().addBlock(b);
      return b.id;
    },

    addSheetBlockAt: (pos, opts) => {
      const grid = get().gridSize;
      // Aim for Google-Docs-like page size (~816x1056 at 96dpi), snapped to brick grid.
      const defaultW = snapToGrid(816, grid);
      const defaultH = snapToGrid(1056, grid);
      const w = Number.isFinite(opts?.width) ? snapToGrid(Math.max(grid * 6, Math.floor(opts?.width as number)), grid) : defaultW;
      const h = Number.isFinite(opts?.height) ? snapToGrid(Math.max(grid * 6, Math.floor(opts?.height as number)), grid) : defaultH;
      const content = String(opts?.content ?? "");
      const b = get().createTextBlock(pos.x, pos.y, content, "rich");
      b.width = w;
      b.height = h;
      get().addBlock(b);
      return b.id;
    },

    addCodeBlockAt: (pos, opts) => {
      const grid = get().gridSize;
      const w = Number.isFinite(opts?.width) ? snapToGrid(Math.max(grid * 6, Math.floor(opts.width as number)), grid) : grid * 14;
      const h = Number.isFinite(opts?.height) ? snapToGrid(Math.max(grid * 4, Math.floor(opts.height as number)), grid) : grid * 6;
      const b = get().createTextBlock(pos.x, pos.y, String(opts?.content ?? ""), "code");
      b.language = opts?.language || "plaintext";
      b.width = w;
      b.height = h;
      get().addBlock(b);
      return b.id;
    },

    addYouTubeBlockAt: (pos, opts) => {
      const grid = get().gridSize;
      const url = String(opts?.url || "").trim();
      const videoId = String(opts?.videoId || extractYouTubeVideoId(url) || "").trim();
      const watchUrl = url || (videoId ? `https://www.youtube.com/watch?v=${videoId}` : "");
      const w = Number.isFinite(opts?.width) ? snapToGrid(Math.max(grid * 8, Math.floor(opts.width as number)), grid) : grid * 12;
      const h = Number.isFinite(opts?.height)
        ? snapToGrid(Math.max(grid * 6, Math.floor(opts.height as number)), grid)
        : snapToGrid(Math.round((w * 9) / 16), grid);
      const b: Block = {
        id: makeId("youtube"),
        type: "youtube",
        x: clampXWithinCanvas({ x: snapToGrid(pos.x, grid), width: w, canvasWidth: get().canvasWidth }),
        y: snapToGrid(pos.y, grid),
        width: w,
        height: h,
        url: watchUrl,
        videoId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as any;
      get().addBlock(b);
      return b.id;
    },

    updateBlock: (id, patch) => {
      set((state) => {
        const b = state.blocks[id];
        if (!b) return;
        const canvasWidth = state.canvasWidth;
        const prevX = Math.floor((b as any).x || 0);
        const prevY = Math.floor((b as any).y || 0);
        const prevW = Math.max(1, Math.floor((b as any).width || state.gridSize || 24));
        const prevH = Math.max(1, Math.floor((b as any).height || state.gridSize || 24));

        const nextXRaw = patch.x != null ? Math.floor(patch.x as any) : prevX;
        const nextWRaw = patch.width != null ? Math.max(1, Math.floor(patch.width as any)) : prevW;

        let nextX = nextXRaw;
        let nextW = nextWRaw;
        if (canvasWidth != null && (b as any).type !== "create") {
          const cw = Math.floor(canvasWidth as number);
          const minW = Math.max(1, state.gridSize * 4);
          if (nextX + nextW > cw) {
            nextX = Math.max(0, cw - nextW);
          }
          if (nextW > cw) {
            nextW = Math.max(minW, cw);
            nextX = 0;
          }
          nextX = Math.max(0, nextX);
        }

        Object.assign(b, patch);
        if (canvasWidth != null && (b as any).type !== "create") {
          (b as any).x = nextX;
          (b as any).width = nextW;
        }
        const bounded = clampWithinContainer({ state, block: b, x: (b as any).x, y: (b as any).y });
        (b as any).x = bounded.x;
        (b as any).y = bounded.y;

        const geometryChanged =
          (b as any).x !== prevX ||
          (b as any).y !== prevY ||
          (b as any).width !== prevW ||
          (b as any).height !== prevH;

        if (b.type === "create" && geometryChanged) {
          for (const bid of state.blockOrder) {
            const child = state.blocks[bid];
            if (!child || (child as any).containerId !== b.id) continue;
            const childBound = clampWithinContainer({
              state,
              block: child,
              x: Math.floor((child as any).x || 0),
              y: Math.floor((child as any).y || 0),
            });
            (child as any).x = childBound.x;
            (child as any).y = childBound.y;
          }
        }
        if (geometryChanged) {
          upsertBrickConnections(state, [id]);
        }
      });
    },

    deleteBlock: (id) => {
      set((state) => {
        if (!state.blocks[id]) return;
        // keep undo history for deletes too
        state.history.push(JSON.stringify({ blocks: state.blocks, blockOrder: state.blockOrder, camera: state.camera, gridSize: state.gridSize }));
        state.future = [];
        delete state.blocks[id];
        state.blockOrder = state.blockOrder.filter((x) => x !== id);
        state.selectedIds = state.selectedIds.filter((x) => x !== id);
      });
    },

    deleteBlocks: (ids) => {
      const list = Array.isArray(ids) ? (ids as BlockId[]) : [];
      if (!list.length) return;
      set((state) => {
        const toDelete = list.filter((id) => state.blocks[id]);
        if (!toDelete.length) return;
        // single undo step for multi-delete
        state.history.push(JSON.stringify({ blocks: state.blocks, blockOrder: state.blockOrder, camera: state.camera, gridSize: state.gridSize }));
        state.future = [];
        for (const id of toDelete) delete state.blocks[id];
        const delSet = new Set(toDelete);
        state.blockOrder = state.blockOrder.filter((x) => !delSet.has(x));
        state.selectedIds = state.selectedIds.filter((x) => !delSet.has(x));
      });
    },

    bringToFront: (id) => {
      set((state) => {
        if (!state.blockOrder.includes(id)) return;
        const b = state.blocks[id];
        if (b && (b as any).type === "create") return;
        state.blockOrder = state.blockOrder.filter((x) => x !== id);
        state.blockOrder.push(id);
      });
    },

    loadBlocks: (blocksList, opts) => {
      const raw = Array.isArray(blocksList) ? blocksList : [];
      const hasLegacy = raw.some(
        (b: any) => b && b.type && b.type !== "text" && b.type !== "create"
      );
      const list = hasLegacy ? migrateLegacyBlocks(raw as any) : (raw as Block[]);
      set((state) => {
        state.blocks = {};
        state.blockOrder = [];
        for (const b of list) {
          if (isAutoPlaceholderTextBrick(b)) continue;
          const next: any = { ...(b as any) };
          // Additive migration guard for universal metadata.
          if (next.universal) {
            next.universal = {
              ...next.universal,
              dataSource: {
                kind: next.universal?.dataSource?.kind || "none",
                inputs: Array.isArray(next.universal?.dataSource?.inputs) ? next.universal.dataSource.inputs : [],
                outputs: Array.isArray(next.universal?.dataSource?.outputs) ? next.universal.dataSource.outputs : [],
              },
              events: {
                emits: Array.isArray(next.universal?.events?.emits) ? next.universal.events.emits : [],
                listensTo: Array.isArray(next.universal?.events?.listensTo) ? next.universal.events.listensTo : [],
              },
              logic: {
                conditions: Array.isArray(next.universal?.logic?.conditions) ? next.universal.logic.conditions : [],
                filters: Array.isArray(next.universal?.logic?.filters) ? next.universal.logic.filters : [],
                dependencies: Array.isArray(next.universal?.logic?.dependencies) ? next.universal.logic.dependencies : [],
                triggers: Array.isArray(next.universal?.logic?.triggers) ? next.universal.logic.triggers : [],
              },
              aiContext: {
                purpose: String(next.universal?.aiContext?.purpose || ""),
                tags: Array.isArray(next.universal?.aiContext?.tags) ? next.universal.aiContext.tags : [],
                semanticType: String(next.universal?.aiContext?.semanticType || ""),
              },
              permissions: Array.isArray(next.universal?.permissions) ? next.universal.permissions : ["view", "edit", "admin"],
              visibility: next.universal?.visibility || "visible",
              connections: Array.isArray(next.universal?.connections) ? next.universal.connections : [],
            };
          }
          if (next.type === "text" || next.type === "create") {
            const nextData = next.data && typeof next.data === "object" ? { ...next.data } : {};
            const content = String(nextData.content ?? next.content ?? nextData.body ?? "");
            const isBrickish =
              String(next.universalType || next.universal?.blockType || "").toLowerCase() === "brick" ||
              String(nextData.kind || "").toLowerCase() === "brick" ||
              String(nextData.trait || "").toLowerCase() === "text";
            // Strip old brick metadata during hydration and keep plain text behavior only.
            const normalizedData: Record<string, any> = { ...nextData, content, body: content };
            delete (normalizedData as any).kind;
            delete (normalizedData as any).trait;
            delete (normalizedData as any).state;
            delete (normalizedData as any).connections;
            if (next.type === "create" && isBrickish) {
              // Convert old "brick" create shells into normal text blocks.
              next.type = "text";
              if (!next.format) next.format = "plain";
            }
            if (String(next.universalType || "").toLowerCase() === "brick") {
              delete next.universalType;
              delete next.universal;
            }
            next.data = normalizedData;
          }
          if (isAutoPlaceholderTextBrick(next)) continue;
          state.blocks[next.id] = next;
          state.blockOrder.push(next.id);
        }
        if (state.blockOrder.length) {
          const createIds = state.blockOrder.filter((id) => (state.blocks[id] as any)?.type === "create");
          const otherIds = state.blockOrder.filter((id) => (state.blocks[id] as any)?.type !== "create");
          state.blockOrder = [...createIds, ...otherIds];
        }
        state.selectedIds = [];
        if (opts?.camera) state.camera = { ...state.camera, ...opts.camera };
        if (Number.isFinite(opts?.gridSize)) state.gridSize = Math.max(1, Math.floor(opts.gridSize as number));
      });
    },

    reset: () => {
      set((state) => {
        state.blocks = {};
        state.blockOrder = [];
        state.selectedIds = [];
        state.camera = { x: 0, y: 0, zoom: 1 };
        state.gridSize = 24;
        state.history = [];
        state.future = [];
      });
    },

    setCamera: (patch) => {
      set((state) => {
        state.camera = { ...state.camera, ...patch };
        state.camera.zoom = clamp(state.camera.zoom, 0.1, 5);
      });
    },

    panBy: (dx, dy) => {
      set((state) => {
        state.camera.x += dx;
        state.camera.y += dy;
      });
    },

    zoomAt: ({ clientX, clientY, rect, delta }) => {
      set((state) => {
        const zoomDelta = delta * -0.001;
        const prevZoom = state.camera.zoom;
        const nextZoom = clamp(prevZoom + zoomDelta, 0.1, 5);
        if (nextZoom === prevZoom) return;

        // Zoom toward pointer (client -> local -> world)
        const mx = clientX - rect.left;
        const my = clientY - rect.top;
        state.camera.x = state.camera.x + (mx / prevZoom - mx / nextZoom);
        state.camera.y = state.camera.y + (my / prevZoom - my / nextZoom);
        state.camera.zoom = nextZoom;
      });
    },

    selectBlocks: (ids) => {
      set((state) => {
        state.selectedIds = ids.slice();
      });
    },

    toggleSelect: (id) => {
      set((state) => {
        const idx = state.selectedIds.indexOf(id);
        if (idx >= 0) state.selectedIds.splice(idx, 1);
        else state.selectedIds.push(id);
      });
    },

    clearSelection: () => {
      set((state) => {
        state.selectedIds = [];
      });
    },

    moveBlock: (id, nextX, nextY, opts) => {
      const snap = opts?.snap ?? true;
      const grid = Number.isFinite(opts?.snapSize) ? Math.max(1, Math.floor(opts?.snapSize as number)) : get().gridSize;
      set((state) => {
        const b = state.blocks[id];
        if (!b) return;
        const rawX = snap ? snapToGrid(nextX, grid) : nextX;
        const nextX2 =
          (b as any).type === "create"
            ? rawX
            : clampXWithinCanvas({
                x: rawX,
                width: Math.max(1, Math.floor((b as any).width || grid)),
                canvasWidth: state.canvasWidth,
              });
        const nextY2 = snap ? snapToGrid(nextY, grid) : nextY;
        const bounded = clampWithinContainer({ state, block: b, x: nextX2, y: nextY2 });
        b.x = bounded.x;
        b.y = bounded.y;
        upsertBrickConnections(state, [id]);
      });
    },

    moveBlocksFromSnapshot: (snapshot, dx, dy, opts) => {
      const list = Array.isArray(snapshot) ? snapshot : [];
      if (!list.length) return;
      const snap = opts?.snap ?? true;
      const grid = Number.isFinite(opts?.snapSize) ? Math.max(1, Math.floor(opts?.snapSize as number)) : get().gridSize;
      set((state) => {
        const movedContainers: Array<{ id: BlockId; deltaX: number; deltaY: number }> = [];
        const movedIds: BlockId[] = [];
        for (const s of list) {
          const b = state.blocks[s.id];
          if (!b) continue;
          const nx = s.x + dx;
          const ny = s.y + dy;
          const rawX = snap ? snapToGrid(nx, grid) : nx;
          const nextX =
            (b as any).type === "create"
              ? rawX
              : clampXWithinCanvas({
                  x: rawX,
                  width: Math.max(1, Math.floor((b as any).width || grid)),
                  canvasWidth: state.canvasWidth,
                });
          const nextY = snap ? snapToGrid(ny, grid) : ny;
          const bounded = clampWithinContainer({ state, block: b, x: nextX, y: nextY });
          const prevX = Math.floor((b as any).x || 0);
          const prevY = Math.floor((b as any).y || 0);
          b.x = bounded.x;
          b.y = bounded.y;
          movedIds.push(b.id);
          if (b.type === "create") {
            const deltaX = b.x - prevX;
            const deltaY = b.y - prevY;
            if (deltaX || deltaY) movedContainers.push({ id: b.id, deltaX, deltaY });
          }
        }
        if (movedContainers.length) {
          for (const c of movedContainers) {
            for (const bid of state.blockOrder) {
              const child = state.blocks[bid];
              if (!child || (child as any).containerId !== c.id) continue;
              const cx = Math.floor((child as any).x || 0) + c.deltaX;
              const cy = Math.floor((child as any).y || 0) + c.deltaY;
              const bounded = clampWithinContainer({ state, block: child, x: cx, y: cy });
              (child as any).x = bounded.x;
              (child as any).y = bounded.y;
            }
          }
        }
        upsertBrickConnections(state, movedIds);
      });
    },

    setListItems: (id, items, listType = "bulleted") => {
      const grid = get().gridSize;
      const list = Array.isArray(items) ? items : [];
      const rows = list.reduce((sum, it) => {
        const t = String(it?.text ?? "");
        const lines = t.split("\n").length || 1;
        return sum + Math.max(1, lines);
      }, 0);
      const format: TextFormat =
        listType === "todo"
          ? "todo"
          : listType === "numbered"
          ? "list-ordered"
          : "list-unordered";
      const content = listItemsToText(listType, list);
      set((state) => {
        const b = state.blocks[id];
        if (!b || b.type !== "text") return;
        b.content = content;
        b.format = format;
        // Grow height based on row count (including multi-line items).
        b.height = Math.max(grid, Math.max(1, rows) * grid);
        b.updatedAt = new Date().toISOString();
      });
    },

    toggleTodoItem: (id, itemId) => {
      set((state) => {
        const b = state.blocks[id];
        if (!b || b.type !== "text") return;
        if (b.format !== "todo") return;
        const lines = String(b.content || "").split("\n");
        const index = Number.isFinite(Number(itemId)) ? Number(itemId) : -1;
        const targetIndex = index >= 0 && index < lines.length ? index : -1;
        if (targetIndex >= 0) {
          lines[targetIndex] = toggleTodoLine(lines[targetIndex]);
        } else {
          const idx = lines.findIndex((line) => line.includes(String(itemId)));
          if (idx >= 0) lines[idx] = toggleTodoLine(lines[idx]);
        }
        b.content = lines.join("\n");
        b.updatedAt = new Date().toISOString();
      });
    },

    setUniversalRuntime: (id, runtime) => {
      set((state) => {
        const b = state.blocks[id] as any;
        if (!b) return;
        b.universal = { ...runtime };
        if (!b.universalType && runtime?.blockType) b.universalType = runtime.blockType;
        b.updatedAt = new Date().toISOString();
      });
    },

    patchUniversalRuntime: (id, patch) => {
      set((state) => {
        const b = state.blocks[id] as any;
        if (!b) return;
        const current: UniversalBlockRuntime = b.universal || ({} as any);
        b.universal = {
          ...current,
          ...patch,
          dataSource: { ...(current.dataSource || {}), ...((patch as any)?.dataSource || {}) },
          events: { ...(current.events || {}), ...((patch as any)?.events || {}) },
          logic: { ...(current.logic || {}), ...((patch as any)?.logic || {}) },
          aiContext: { ...(current.aiContext || {}), ...((patch as any)?.aiContext || {}) },
          connections: Array.isArray((patch as any)?.connections) ? (patch as any).connections : current.connections || [],
        };
        if (!b.universalType && b.universal?.blockType) b.universalType = b.universal.blockType;
        b.updatedAt = new Date().toISOString();
      });
    },

    upsertUniversalConnection: (id, connection) => {
      set((state) => {
        const b = state.blocks[id] as any;
        if (!b) return;
        const uni = b.universal || {};
        const list: UniversalBlockConnection[] = Array.isArray(uni.connections) ? [...uni.connections] : [];
        const idx = list.findIndex((c) => String((c as any)?.id) === String(connection.id));
        if (idx >= 0) list[idx] = connection;
        else list.push(connection);
        b.universal = { ...uni, connections: list };
        b.updatedAt = new Date().toISOString();
      });
    },

    removeUniversalConnection: (id, connectionId) => {
      set((state) => {
        const b = state.blocks[id] as any;
        if (!b?.universal) return;
        const list = Array.isArray(b.universal.connections) ? b.universal.connections : [];
        b.universal = { ...b.universal, connections: list.filter((c: any) => String(c?.id) !== String(connectionId)) };
        b.updatedAt = new Date().toISOString();
      });
    },

    transformBrickTrait: (id, trait) => {
      set((state) => {
        const b = state.blocks[id] as any;
        if (!b) return;
        state.history.push(JSON.stringify({ blocks: state.blocks, blockOrder: state.blockOrder, camera: state.camera, gridSize: state.gridSize }));
        state.future = [];
        applyBrickTraitToBlock(b, trait);
        upsertBrickConnections(state, [id]);
      });
    },

    transformSelectedBrickTraits: (trait) => {
      set((state) => {
        const ids = (state.selectedIds || []).filter((id) => state.blocks[id]);
        if (!ids.length) return;
        state.history.push(JSON.stringify({ blocks: state.blocks, blockOrder: state.blockOrder, camera: state.camera, gridSize: state.gridSize }));
        state.future = [];
        for (const id of ids) {
          const b = state.blocks[id] as any;
          if (!b) continue;
          applyBrickTraitToBlock(b, trait);
        }
        upsertBrickConnections(state, ids);
      });
    },

    pushHistory: () => {
      set((state) => {
        state.history.push(JSON.stringify({ blocks: state.blocks, blockOrder: state.blockOrder, camera: state.camera, gridSize: state.gridSize }));
        // clear redo stack on new action
        state.future = [];
      });
    },

    undo: () => {
      set((state) => {
        if (!state.history.length) return;
        const prev = state.history.pop();
        if (!prev) return;
        state.future.push(JSON.stringify({ blocks: state.blocks, blockOrder: state.blockOrder, camera: state.camera, gridSize: state.gridSize }));
        const parsed = JSON.parse(prev) as { blocks: Record<BlockId, Block>; blockOrder: BlockId[]; camera: Camera; gridSize: number };
        state.blocks = parsed.blocks || {};
        state.blockOrder = Array.isArray(parsed.blockOrder) ? parsed.blockOrder : [];
        state.camera = parsed.camera || { x: 0, y: 0, zoom: 1 };
        state.gridSize = Number.isFinite(parsed.gridSize) ? Math.max(1, Math.floor(parsed.gridSize)) : state.gridSize;
        state.selectedIds = [];
      });
    },

    redo: () => {
      set((state) => {
        if (!state.future.length) return;
        const next = state.future.pop();
        if (!next) return;
        state.history.push(JSON.stringify({ blocks: state.blocks, blockOrder: state.blockOrder, camera: state.camera, gridSize: state.gridSize }));
        const parsed = JSON.parse(next) as { blocks: Record<BlockId, Block>; blockOrder: BlockId[]; camera: Camera; gridSize: number };
        state.blocks = parsed.blocks || {};
        state.blockOrder = Array.isArray(parsed.blockOrder) ? parsed.blockOrder : [];
        state.camera = parsed.camera || { x: 0, y: 0, zoom: 1 };
        state.gridSize = Number.isFinite(parsed.gridSize) ? Math.max(1, Math.floor(parsed.gridSize)) : state.gridSize;
        state.selectedIds = [];
      });
    },
  }))
);

