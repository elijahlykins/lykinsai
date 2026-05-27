import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type { Block, BlockId, Camera, LegacyListItem, LegacyListType, TextBlock, TextFormat } from "@/canvas/types";
import { snapToGrid } from "@/canvas/utils/snap";
import { migrateLegacyBlocks } from "@/canvas/utils/migrateBlocks";
import { extractYouTubeVideoId } from "@/canvas/utils/youtube";
import type { UniversalBlockConnection, UniversalBlockRuntime } from "@/canvas/blockSystem/types";
import type { BrickTrait } from "@/canvas/blockSystem/types";

export type WireSide = "top" | "right" | "bottom" | "left";

export type WireConnection = {
  id: string;
  fromId: BlockId;
  toId: BlockId;
  fromSide: WireSide;
  toSide: WireSide;
  controlPoints?: Array<{ x: number; y: number }>;
};

const MAX_UNDO_HISTORY = 30;

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
  // Plan-driven hard cap on non-"create" blocks per grid. `null` means no
  // cap (Pro). When `addBlock` is called beyond
  // this cap, it silently refuses and fires a window event so the usage gate
  // can surface an upgrade modal.
  blockLimit: number | null;

  setCanvasWidth: (width: number | null) => void;
  setBlockLimit: (limit: number | null) => void;
  /**
   * Adds a block to the store. Returns `true` when the block was actually
   * added, `false` when the per-board block cap rejected it. Callers that
   * report success to the user (PULL_MEDIA, vault drop, file drop, etc.)
   * MUST check the return value before announcing success — otherwise the
   * cap silently drops bricks while the UI claims they landed.
   */
  addBlock: (block: Block) => boolean;
  createTextBlock: (
    x: number,
    y: number,
    initialContent?: string,
    format?: TextBlock["format"]
  ) => TextBlock;
  addTextBlockAt: (
    pos: { x: number; y: number },
    opts?: { width?: number; height?: number; content?: string; format?: TextFormat; data?: Record<string, unknown> }
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
  bringForward: (id: BlockId) => void;
  sendBackward: (id: BlockId) => void;
  sendToBack: (id: BlockId) => void;
  loadBlocks: (blocks: Block[], opts?: { camera?: Camera; gridSize?: number; wireConnections?: WireConnection[] }) => void;
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

  focusedBrickIds: BlockId[];
  setFocusedBrickIds: (ids: BlockId[]) => void;

  wireConnections: WireConnection[];
  addWireConnection: (conn: Omit<WireConnection, "id">) => void;
  removeWireConnection: (id: string) => void;
  updateWireConnection: (id: string, patch: Partial<Omit<WireConnection, "id">>) => void;
  clearWireConnectionsForBlock: (blockId: BlockId) => void;

  recentlyDeleted: Array<{ id: string; type: string; preview: string; deletedAt: number }>;

  pushHistory: () => void;
  undo: () => void;
  redo: () => void;
};

const MAX_RECENTLY_DELETED = 10;

function makeId(prefix = "b") {
  // Prefer crypto.randomUUID() — collision-free even under burst creation
  // (vault drops + AI pulls + file drops in the same millisecond). Fall
  // back to the legacy timestamp+random scheme in environments without
  // a secure context (non-https local dev, very old browsers).
  try {
    if (typeof crypto !== "undefined" && typeof (crypto as any).randomUUID === "function") {
      return `${prefix}-${(crypto as any).randomUUID()}`;
    }
  } catch { /* ignore */ }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function snapshotForDeletion(b: any, id: string): { id: string; type: string; preview: string; deletedAt: number } {
  const t = String(b?.type || "unknown");
  const mode = String(b?.mode || "").toLowerCase();
  const type = t === "create" && mode ? mode : t;
  const raw = String(b?.content || b?.data?.content || b?.data?.title || b?.data?.name || "").replace(/\s+/g, " ").trim();
  return { id, type, preview: raw.slice(0, 60), deletedAt: Date.now() };
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

// NOTE: Currently unused — kept available for callers that need to enforce
// a hard left/right wall on the canvas (e.g. mobile compact mode). Wire it
// into `addBlock`/`updateBlock` if/when fixed-width canvases are revived;
// otherwise remove. eslint-disable-next-line @typescript-eslint/no-unused-vars
function clampXWithinCanvas(args: { x: number; width: number; canvasWidth: number | null }) {
  const { x, width, canvasWidth } = args;
  if (!Number.isFinite(canvasWidth) || (canvasWidth as number) <= 0) return x;
  const cw = Math.floor(canvasWidth as number);
  const w = Math.max(1, Math.floor(width || 0));
  const maxX = Math.max(0, cw - w);
  return clamp(Math.floor(x || 0), 0, maxX);
}
void clampXWithinCanvas;

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
  if (!container || container.type !== "create") {
    delete (block as any).containerId;
    return { x: nextX, y: nextY };
  }

  const cX = Math.floor(container.x || 0);
  const cY = Math.floor(container.y || 0);
  const cW = Math.max(1, Math.floor(container.width || state.gridSize || 24));
  const cH = Math.max(1, Math.floor(container.height || state.gridSize || 24));
  const bW = Math.max(1, Math.floor((block as any).width || state.gridSize || 24));
  const bH = Math.max(1, Math.floor((block as any).height || state.gridSize || 24));

  const blockCenterX = nextX + bW / 2;
  const blockCenterY = nextY + bH / 2;
  const outsideContainer =
    blockCenterX < cX || blockCenterX > cX + cW ||
    blockCenterY < cY || blockCenterY > cY + cH;

  if (outsideContainer) {
    delete (block as any).containerId;
    return { x: nextX, y: nextY };
  }

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
    blockLimit: null,
    focusedBrickIds: [],
    wireConnections: [],
    recentlyDeleted: [],

    setFocusedBrickIds: (ids) => set((state) => { state.focusedBrickIds = ids; }),

    setCanvasWidth: (width) => {
      set((state) => {
        state.canvasWidth = width;
      });
    },

    setBlockLimit: (limit) => {
      set((state) => {
        state.blockLimit = limit == null || !isFinite(limit) ? null : Math.max(1, Math.floor(limit));
      });
    },

    addBlock: (block) => {
      const st = get();
      // Enforce the blocks-per-grid cap. Only the empty "+" PLACEHOLDER
      // bricks (type:"create" with no mode and no data payload) are exempt;
      // real media/embed/video bricks are also `type:"create"` but carry
      // user content, so they MUST count against the cap. Without this,
      // mass image / vault drops silently bypass the limit.
      const isPlaceholder = (b: any) => {
        if (!b || b.type !== "create") return false;
        const mode = String(b.mode || "").toLowerCase();
        const data = b.data && typeof b.data === "object" ? b.data : {};
        const hasContent = String(b.content || data.content || "").trim().length > 0;
        const hasMedia = !!(data.url || data.src || data.videoId || data.storagePath || data.dataUrl || data.audioData || data.pdfData || data.oembedHtml);
        return !mode && !hasContent && !hasMedia;
      };
      if (st.blockLimit != null) {
        const isRealBlock = !isPlaceholder(block);
        const alreadyPresent = st.blockOrder.includes(block.id);
        if (isRealBlock && !alreadyPresent) {
          let realCount = 0;
          for (const id of st.blockOrder) {
            if (!isPlaceholder(st.blocks[id])) realCount += 1;
          }
          if (realCount >= st.blockLimit) {
            if (typeof window !== "undefined") {
              window.dispatchEvent(
                new CustomEvent("lykn:block-limit-reached", { detail: { limit: st.blockLimit } })
              );
            }
            return false;
          }
        }
      }
      // Snapshot history before adding so external sources (vault drop, AI
      // pull, file drop) become undoable as a unit. Skip for placeholder
      // re-inserts and for already-present blocks (re-adds would bloat).
      const alreadyPresent = st.blockOrder.includes(block.id);
      if (!alreadyPresent && !isPlaceholder(block)) {
        try { get().pushHistory(); } catch { /* defensive */ }
      }
      set((state) => {
        state.blocks[block.id] = block;
        if (!state.blockOrder.includes(block.id)) {
          if ((block as any).type === "create") state.blockOrder.unshift(block.id);
          else state.blockOrder.push(block.id);
        }
        upsertBrickConnections(state, [block.id]);
      });
      return true;
    },

    createTextBlock: (x, y, initialContent, format) => {
      const grid = get().gridSize;
      return {
        id: makeId("text"),
        type: "text",
        x: snapToGrid(x, grid),
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
      // Apply caller-provided data atomically on creation so flags like
      // `aiResponseBubble`, `textVariant`, and `listType` land on the block in
      // the same store update as the block itself. This prevents one-frame
      // flashes where the brick renders before its metadata is set.
      if (opts?.data && typeof opts.data === "object") {
        b.data = { ...(b.data || {}), ...opts.data };
      }
      const ok = get().addBlock(b);
      return ok ? b.id : "";
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
      const ok = get().addBlock(b);
      return ok ? b.id : "";
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
      const ok = get().addBlock(b);
      return ok ? b.id : "";
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
      const ok = get().addBlock(b);
      return ok ? b.id : "";
    },

    addCodeBlockAt: (pos, opts) => {
      const grid = get().gridSize;
      const w = Number.isFinite(opts?.width) ? snapToGrid(Math.max(grid * 6, Math.floor(opts.width as number)), grid) : grid * 14;
      const h = Number.isFinite(opts?.height) ? snapToGrid(Math.max(grid * 4, Math.floor(opts.height as number)), grid) : grid * 6;
      const b = get().createTextBlock(pos.x, pos.y, String(opts?.content ?? ""), "code");
      b.language = opts?.language || "plaintext";
      b.width = w;
      b.height = h;
      const ok = get().addBlock(b);
      return ok ? b.id : "";
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
        type: "create",
        mode: "video",
        x: snapToGrid(pos.x, grid),
        y: snapToGrid(pos.y, grid),
        width: w,
        height: h,
        url: watchUrl,
        videoId,
        data: { url: watchUrl, videoId },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as any;
      const ok = get().addBlock(b);
      return ok ? b.id : "";
    },

    updateBlock: (id, patch) => {
      set((state) => {
        const b = state.blocks[id];
        if (!b) return;
        const prevX = Math.floor((b as any).x || 0);
        const prevY = Math.floor((b as any).y || 0);
        const prevW = Math.max(1, Math.floor((b as any).width || state.gridSize || 24));
        const prevH = Math.max(1, Math.floor((b as any).height || state.gridSize || 24));

        Object.assign(b, patch);
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
        state.history.push(JSON.stringify({ blocks: state.blocks, blockOrder: state.blockOrder, camera: state.camera, gridSize: state.gridSize, wireConnections: state.wireConnections }));
        if (state.history.length > MAX_UNDO_HISTORY) state.history.splice(0, state.history.length - MAX_UNDO_HISTORY);
        state.future = [];
        state.recentlyDeleted.push(snapshotForDeletion(state.blocks[id], id));
        if (state.recentlyDeleted.length > MAX_RECENTLY_DELETED) state.recentlyDeleted.splice(0, state.recentlyDeleted.length - MAX_RECENTLY_DELETED);
        delete state.blocks[id];
        state.blockOrder = state.blockOrder.filter((x) => x !== id);
        state.selectedIds = state.selectedIds.filter((x) => x !== id);
        state.wireConnections = state.wireConnections.filter((w) => w.fromId !== id && w.toId !== id);
      });
    },

    deleteBlocks: (ids) => {
      const list = Array.isArray(ids) ? (ids as BlockId[]) : [];
      if (!list.length) return;
      set((state) => {
        const toDelete = list.filter((id) => state.blocks[id]);
        if (!toDelete.length) return;
        state.history.push(JSON.stringify({ blocks: state.blocks, blockOrder: state.blockOrder, camera: state.camera, gridSize: state.gridSize, wireConnections: state.wireConnections }));
        if (state.history.length > MAX_UNDO_HISTORY) state.history.splice(0, state.history.length - MAX_UNDO_HISTORY);
        state.future = [];
        for (const id of toDelete) state.recentlyDeleted.push(snapshotForDeletion(state.blocks[id], id));
        if (state.recentlyDeleted.length > MAX_RECENTLY_DELETED) state.recentlyDeleted.splice(0, state.recentlyDeleted.length - MAX_RECENTLY_DELETED);
        for (const id of toDelete) delete state.blocks[id];
        const delSet = new Set(toDelete);
        state.blockOrder = state.blockOrder.filter((x) => !delSet.has(x));
        state.selectedIds = state.selectedIds.filter((x) => !delSet.has(x));
        state.wireConnections = state.wireConnections.filter((w) => !delSet.has(w.fromId) && !delSet.has(w.toId));
      });
    },

    bringToFront: (id) => {
      set((state) => {
        if (!state.blockOrder.includes(id)) return;
        state.blockOrder = state.blockOrder.filter((x) => x !== id);
        state.blockOrder.push(id);
      });
    },

    bringForward: (id) => {
      set((state) => {
        const idx = state.blockOrder.indexOf(id);
        if (idx === -1 || idx >= state.blockOrder.length - 1) return;
        const order = [...state.blockOrder];
        [order[idx], order[idx + 1]] = [order[idx + 1], order[idx]];
        state.blockOrder = order;
      });
    },

    sendBackward: (id) => {
      set((state) => {
        const idx = state.blockOrder.indexOf(id);
        if (idx <= 0) return;
        const order = [...state.blockOrder];
        [order[idx - 1], order[idx]] = [order[idx], order[idx - 1]];
        state.blockOrder = order;
      });
    },

    sendToBack: (id) => {
      set((state) => {
        if (!state.blockOrder.includes(id)) return;
        state.blockOrder = state.blockOrder.filter((x) => x !== id);
        state.blockOrder.unshift(id);
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
        if (Array.isArray(opts?.wireConnections)) state.wireConnections = opts.wireConnections;
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
        state.wireConnections = [];
      });
    },

    setCamera: (patch) => {
      set((state) => {
        state.camera = { ...state.camera, ...patch };
        if (!Number.isFinite(state.camera.x)) state.camera.x = 0;
        if (!Number.isFinite(state.camera.y)) state.camera.y = 0;
        state.camera.zoom = Number.isFinite(state.camera.zoom) ? clamp(state.camera.zoom, 0.2, 3) : 1;
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
        const nextZoom = clamp(prevZoom + zoomDelta, 0.2, 3);
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
        const nextX2 = (b as any).type === "create" ? rawX : Math.floor(rawX);
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
          const nextX = (b as any).type === "create" ? rawX : Math.floor(rawX);
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
        if (state.history.length > MAX_UNDO_HISTORY) state.history.splice(0, state.history.length - MAX_UNDO_HISTORY);
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
        if (state.history.length > MAX_UNDO_HISTORY) state.history.splice(0, state.history.length - MAX_UNDO_HISTORY);
        state.future = [];
        for (const id of ids) {
          const b = state.blocks[id] as any;
          if (!b) continue;
          applyBrickTraitToBlock(b, trait);
        }
        upsertBrickConnections(state, ids);
      });
    },

    addWireConnection: (conn) => {
      set((state) => {
        const exists = state.wireConnections.some(
          (w) => w.fromId === conn.fromId && w.toId === conn.toId && w.fromSide === conn.fromSide && w.toSide === conn.toSide
        );
        if (exists) return;
        const id = `wire-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        state.wireConnections.push({ id, ...conn });
      });
    },

    removeWireConnection: (id) => {
      set((state) => {
        state.wireConnections = state.wireConnections.filter((w) => w.id !== id);
      });
    },

    updateWireConnection: (id, patch) => {
      set((state) => {
        const wire = state.wireConnections.find((w) => w.id === id);
        if (wire) Object.assign(wire, patch);
      });
    },

    clearWireConnectionsForBlock: (blockId) => {
      set((state) => {
        state.wireConnections = state.wireConnections.filter(
          (w) => w.fromId !== blockId && w.toId !== blockId
        );
      });
    },

    pushHistory: () => {
      set((state) => {
        state.history.push(JSON.stringify({ blocks: state.blocks, blockOrder: state.blockOrder, camera: state.camera, gridSize: state.gridSize, wireConnections: state.wireConnections }));
        if (state.history.length > MAX_UNDO_HISTORY) state.history.splice(0, state.history.length - MAX_UNDO_HISTORY);
        state.future = [];
      });
    },

    undo: () => {
      set((state) => {
        if (!state.history.length) return;
        const prev = state.history.pop();
        if (!prev) return;
        state.future.push(JSON.stringify({ blocks: state.blocks, blockOrder: state.blockOrder, camera: state.camera, gridSize: state.gridSize, wireConnections: state.wireConnections }));
        if (state.future.length > MAX_UNDO_HISTORY) state.future.splice(0, state.future.length - MAX_UNDO_HISTORY);
        const parsed = JSON.parse(prev) as any;
        state.blocks = parsed.blocks || {};
        state.blockOrder = Array.isArray(parsed.blockOrder) ? parsed.blockOrder : [];
        state.camera = parsed.camera || { x: 0, y: 0, zoom: 1 };
        state.gridSize = Number.isFinite(parsed.gridSize) ? Math.max(1, Math.floor(parsed.gridSize)) : state.gridSize;
        state.wireConnections = Array.isArray(parsed.wireConnections) ? parsed.wireConnections : [];
        state.selectedIds = [];
      });
    },

    redo: () => {
      set((state) => {
        if (!state.future.length) return;
        const next = state.future.pop();
        if (!next) return;
        state.history.push(JSON.stringify({ blocks: state.blocks, blockOrder: state.blockOrder, camera: state.camera, gridSize: state.gridSize, wireConnections: state.wireConnections }));
        if (state.history.length > MAX_UNDO_HISTORY) state.history.splice(0, state.history.length - MAX_UNDO_HISTORY);
        const parsed = JSON.parse(next) as any;
        state.blocks = parsed.blocks || {};
        state.blockOrder = Array.isArray(parsed.blockOrder) ? parsed.blockOrder : [];
        state.camera = parsed.camera || { x: 0, y: 0, zoom: 1 };
        state.gridSize = Number.isFinite(parsed.gridSize) ? Math.max(1, Math.floor(parsed.gridSize)) : state.gridSize;
        state.wireConnections = Array.isArray(parsed.wireConnections) ? parsed.wireConnections : [];
        state.selectedIds = [];
      });
    },
  }))
);

