import React, { useEffect, useMemo, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";
import { isInViewport } from "@/canvas/utils/isInViewport";
import { snapToGrid } from "@/canvas/utils/snap";
import { extractYouTubeVideoId } from "@/canvas/utils/youtube";
import { YouTubeBlock } from "@/canvas/blocks/YouTubeBlock";
import type { AiAnswerEntry } from "@/canvas/types";
import { canUseActiveBrickLogic, renderBrickShell } from "./brick";

type CanvasProps = {
  liveAIMode?: boolean;
  isAiThinking?: boolean;
};

const ENABLE_CANVAS_HOTKEYS = false;
const ENABLE_BRICK_LOGIC = canUseActiveBrickLogic();

function getCaretOffsetInElement(el: HTMLElement) {
  try {
    const sel = window.getSelection?.();
    if (!sel || sel.rangeCount === 0) return 0;
    const range = sel.getRangeAt(0);
    if (!el.contains(range.startContainer)) return 0;
    const pre = range.cloneRange();
    pre.selectNodeContents(el);
    pre.setEnd(range.startContainer, range.startOffset);
    return pre.toString().length;
  } catch {
    return 0;
  }
}

function getLineAt(text: string, caret: number) {
  const s = String(text ?? "");
  const c = Math.max(0, Math.min(s.length, Math.floor(caret || 0)));
  const start = s.lastIndexOf("\n", Math.max(0, c - 1));
  const end = s.indexOf("\n", c);
  const a = start === -1 ? 0 : start + 1;
  const b = end === -1 ? s.length : end;
  return s.slice(a, b);
}

function getLineAtWithRange(text: string, caret: number) {
  const s = String(text ?? "");
  const c = Math.max(0, Math.min(s.length, Math.floor(caret || 0)));
  const start = s.lastIndexOf("\n", Math.max(0, c - 1));
  const end = s.indexOf("\n", c);
  const a = start === -1 ? 0 : start + 1;
  const b = end === -1 ? s.length : end;
  return { line: s.slice(a, b), start: a, end: b, caret: c };
}

function normalizeNewlines(s: string) {
  return String(s ?? "").replace(/\r\n?/g, "\n");
}

function normalizeAiPromptLine(line: string) {
  // Mirror BrickEditor behavior: normalize whitespace but keep the user's wording.
  return normalizeNewlines(String(line ?? "")).replace(/[ \t]+/g, " ").trim();
}

function dedupeAiAssistantText(text: string) {
  const norm = (s: string) =>
    normalizeNewlines(String(s ?? ""))
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

  let s = normalizeNewlines(String(text ?? "")).trim();
  if (!s) return "";

  // Remove consecutive duplicate paragraphs.
  const paras = s.split(/\n{2,}/g);
  const outParas: string[] = [];
  for (const p0 of paras) {
    const p = String(p0 ?? "").trim();
    if (!p) continue;
    const last = outParas.length ? outParas[outParas.length - 1] : null;
    if (last && norm(last) === norm(p)) continue;
    outParas.push(p);
  }
  s = outParas.join("\n\n");

  // Also remove consecutive duplicate lines.
  const lines = s.split("\n");
  const outLines: string[] = [];
  let lastNonEmptyNorm = "";
  for (const l0 of lines) {
    const l = String(l0 ?? "");
    const ln = norm(l);
    if (ln) {
      if (lastNonEmptyNorm && lastNonEmptyNorm === ln) continue;
      lastNonEmptyNorm = ln;
    }
    outLines.push(l);
  }
  return outLines.join("\n").trimEnd();
}

function extractFocusFromUserLine(line: string) {
  const s = String(line ?? "").trim();
  if (!s) return "";
  // If the user typed multiple clauses/questions on one line, focus the LAST clause.
  const parts = s
    .split(/[?!\.]+/g)
    .map((x) => String(x ?? "").trim())
    .filter(Boolean);
  if (parts.length >= 2) {
    const last = parts[parts.length - 1];
    if (last.length >= 2) return last;
  }
  return s.trim();
}

function stripQuestionRestatement(answerText: string) {
  let a = String(answerText ?? "");
  if (!a) return "";
  let s = normalizeNewlines(a).trimStart();

  const lead = s.slice(0, 260);
  const isRestate =
    /^\s*(it\s+(seems|sounds)\s+like|sounds\s+like|looks\s+like)\b/i.test(lead) && /\b(you|you're)\s+(are\s+)?asking\b/i.test(lead);
  if (isRestate) {
    const paraIdx = s.search(/\n{2,}/);
    if (paraIdx >= 0) {
      s = s.slice(paraIdx).replace(/^\n+/, "");
    } else {
      const lineIdx = s.indexOf("\n");
      if (lineIdx >= 0) {
        s = s.slice(lineIdx + 1);
      } else {
        s = s.slice(220);
      }
    }
  }

  return String(s).trimStart();
}

function stripEchoedQuestionPrefix(answerText: string, questionText: string) {
  let a = String(answerText ?? "");
  const q = String(questionText ?? "").trim();
  if (!a || !q) return a;

  const norm = (s: string) =>
    normalizeNewlines(String(s ?? ""))
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

  const aNorm = norm(a);
  const qNorm = norm(q);
  const prefixes = [qNorm, `you asked: ${qNorm}`, `question: ${qNorm}`, `q: ${qNorm}`];

  for (const p of prefixes) {
    if (!p) continue;
    if (aNorm.startsWith(p)) {
      const idx = a.toLowerCase().indexOf(q.toLowerCase());
      if (idx === 0) {
        a = a.slice(q.length);
      } else {
        const lines = normalizeNewlines(a).split("\n");
        if (lines.length && norm(lines[0]) === qNorm) {
          a = lines.slice(1).join("\n");
        } else if (lines.length >= 2 && norm(`${lines[0]} ${lines[1]}`) === qNorm) {
          a = lines.slice(2).join("\n");
        }
      }
      break;
    }
  }

  a = a.replace(/^\s*(you asked|question|q)\s*:\s*/i, "");
  a = a.replace(/^\s*[-–—:]+\s*/g, "").trimStart();
  return a;
}

function safeJsonParse(text: string) {
  try {
    return JSON.parse(String(text ?? ""));
  } catch {
    return null;
  }
}

function extractFirstJsonObject(raw: string) {
  const s = String(raw ?? "");
  if (!s) return null;
  const first = s.indexOf("{");
  if (first < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = first; i < s.length; i += 1) {
    const ch = s[i];
    if (inStr) {
      if (esc) {
        esc = false;
      } else if (ch === "\\") {
        esc = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}") depth -= 1;
    if (depth === 0) {
      const chunk = s.slice(first, i + 1);
      return safeJsonParse(chunk);
    }
  }
  return null;
}

function wrapAfterCharsFinishWord(text: string, limit = 40) {
  const s = String(text ?? "").replace(/\r/g, "");
  const lim = Math.max(1, Math.floor(limit || 40));
  let out = "";
  let lineLen = 0;

  const isWs = (ch: string) => ch === " " || ch === "\t";

  for (let i = 0; i < s.length; i += 1) {
    const ch0 = s[i];

    if (ch0 === "\n") {
      out += "\n";
      lineLen = 0;
      continue;
    }

    // Normalize tabs to spaces.
    const ch = ch0 === "\t" ? " " : ch0;

    // Skip leading spaces on a fresh line (prevents weird indentation after forced wrap).
    if (ch === " " && lineLen === 0) continue;

    // If we've hit/exceeded the limit, wait until we reach whitespace (end of the current word),
    // then start a new line. This prevents splitting mid-word.
    if (lineLen >= lim && ch === " ") {
      out += "\n";
      lineLen = 0;
      continue;
    }

    // Collapse multiple spaces when we're past the limit (avoid huge gaps before wrapping).
    if (lineLen >= lim && isWs(ch) && out.endsWith(" ")) continue;

    out += ch;
    lineLen += 1;
  }

  return out;
}

function makeMoveGroupId() {
  return `move-group-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeDuplicateId(prefix = "b") {
  return `${prefix}-dup-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function Canvas({ liveAIMode = false, isAiThinking = false }: CanvasProps) {
  type PressTarget = { kind: "cell" | "brick"; key: string };
  type GridRange = { minX: number; maxX: number; minY: number; maxY: number };
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [hoverCell, setHoverCell] = useState<{ x: number; y: number } | null>(null);
  const [activatedGridCellKeys, setActivatedGridCellKeys] = useState<string[]>([]);
  const [raisedGridCellKeys, setRaisedGridCellKeys] = useState<string[]>([]);
  const [activatedGridRanges, setActivatedGridRanges] = useState<GridRange[]>([]);
  const [groupedGridCellKeys, setGroupedGridCellKeys] = useState<string[]>([]);
  const [shiftLinkedGridSelection, setShiftLinkedGridSelection] = useState(false);
  const [typingBlockId, setTypingBlockId] = useState<string | null>(null);
  const [typingShapeCellKey, setTypingShapeCellKey] = useState<string | null>(null);
  const [shapeCellTextByKey, setShapeCellTextByKey] = useState<Record<string, string>>({});
  const [activatedBrickIds, setActivatedBrickIds] = useState<string[]>([]);
  const [raisedBrickIds, setRaisedBrickIds] = useState<string[]>([]);
  const [shiftAnchor, setShiftAnchor] = useState<PressTarget | null>(null);
  const [scrollPos, setScrollPos] = useState({ left: 0, top: 0 });
  const lastPointerClientRef = useRef<{ x: number; y: number } | null>(null);
  const [deleteZoneOpen, setDeleteZoneOpen] = useState(false);
  const [dropContainerId, setDropContainerId] = useState<string | null>(null);
  const [shapePickerOpen, setShapePickerOpen] = useState(false);
  const [shapePickerAnchor, setShapePickerAnchor] = useState<{ clientX: number; clientY: number; worldX: number; worldY: number }>({
    clientX: 0,
    clientY: 0,
    worldX: 0,
    worldY: 0,
  });

  const deleteZoneOpenRef = useRef(false);
  useEffect(() => {
    deleteZoneOpenRef.current = deleteZoneOpen;
  }, [deleteZoneOpen]);

  const dragDeleteRef = useRef<{
    active: boolean;
    pointerId: number | null;
    primaryId: string | null;
    ids: string[];
    touchStartAt: number | null;
  }>({ active: false, pointerId: null, primaryId: null, ids: [], touchStartAt: null });
  const gridShapeDragRef = useRef<{
    active: boolean;
    moved: boolean;
    pointerId: number | null;
    startWorldX: number;
    startWorldY: number;
    pressCellKey: string | null;
    startCells: string[];
    startRaised: string[];
    startRanges: GridRange[];
    moveCells: string[];
    moveRaised: string[];
    moveRangeIndexes: number[];
    startGrouped: string[];
    moveGrouped: string[];
  }>({
    active: false,
    moved: false,
    pointerId: null,
    startWorldX: 0,
    startWorldY: 0,
    pressCellKey: null,
    startCells: [],
    startRaised: [],
    startRanges: [],
    moveCells: [],
    moveRaised: [],
    moveRangeIndexes: [],
    startGrouped: [],
    moveGrouped: [],
  });
  const groupDragRef = useRef<{
    active: boolean;
    moved: boolean;
    pointerId: number | null;
    startWorldX: number;
    startWorldY: number;
    snapshot: Array<{ id: string; x: number; y: number }>;
  }>({ active: false, moved: false, pointerId: null, startWorldX: 0, startWorldY: 0, snapshot: [] });
  const heldShapeDeleteRef = useRef<{ active: boolean; pointerId: number | null; keys: string[] }>({
    active: false,
    pointerId: null,
    keys: [],
  });
  const suppressBrickClickRef = useRef(false);

  const [aiPanel, setAiPanel] = useState<{
    open: boolean;
    left: number;
    top: number;
    question: string;
    answer: string;
    fullAnswer: string;
    loading: boolean;
    isTyping: boolean;
    blockId: string | null;
    widthBricks: number;
    heightBricks: number;
    maxWidthPx: number;
  }>({
    open: false,
    left: 24,
    top: 120,
    question: "",
    answer: "",
    fullAnswer: "",
    loading: false,
    isTyping: false,
    blockId: null,
    widthBricks: 3,
    heightBricks: 1,
    maxWidthPx: 520,
  });
  const aiAbortRef = useRef<AbortController | null>(null);
  const aiThreadByBlockRef = useRef<Map<string, { key: string; messages: Array<{ role: "user" | "assistant"; content: string }> }>>(new Map());
  const aiLastUserLineRef = useRef<Map<string, string>>(new Map()); // blockId -> last processed promptText
  const aiAnswerTimersRef = useRef<Map<string, number>>(new Map()); // blockId -> debounce timeout id
  const aiInFlightRef = useRef<Set<string>>(new Set()); // blockId currently requesting
  const aiQueuedPromptRef = useRef<Map<string, string>>(new Map()); // blockId -> pending prompt while in-flight
  const aiBackoffUntilRef = useRef<number>(0);
  const lastAiSpreadsheetIdRef = useRef<string | null>(null);
  const aiLastCreatedByBlockRef = useRef<Map<string, { spreadsheetId?: string }>>(new Map());
  const aiLastActionKeyByBlockRef = useRef<Map<string, string>>(new Map());
  const aiAnswerPanelRef = useRef<HTMLDivElement | null>(null);
  const aiAnswerContentRef = useRef<HTMLDivElement | null>(null);
  const aiAnswerMeasureRef = useRef<HTMLDivElement | null>(null);
  const aiPanelSizeRef = useRef<{ w: number; h: number }>({ w: 360, h: 140 });
  const aiPanelDragRef = useRef<{ startX: number; startY: number; originLeft: number; originTop: number } | null>(null);

  const blocks = useCanvasStore((s) => s.blocks);
  const blockOrder = useCanvasStore((s) => s.blockOrder);
  const selectedIds = useCanvasStore((s) => s.selectedIds);
  const camera = useCanvasStore((s) => s.camera);
  const gridSize = useCanvasStore((s) => s.gridSize);
  const canvasWidth = useCanvasStore((s) => s.canvasWidth);
  const setCanvasWidth = useCanvasStore((s) => s.setCanvasWidth);
  const addTextBlockAt = useCanvasStore((s) => s.addTextBlockAt);
  const addListBlockAt = useCanvasStore((s) => s.addListBlockAt);
  const addSpreadsheetBlockAt = useCanvasStore((s) => s.addSpreadsheetBlockAt);
  const addSheetBlockAt = useCanvasStore((s) => s.addSheetBlockAt);
  const addFileBlockAt = useCanvasStore((s: any) => s.addFileBlockAt);
  const addLinkBlockAt = useCanvasStore((s: any) => s.addLinkBlockAt);
  const addYouTubeBlockAt = useCanvasStore((s: any) => s.addYouTubeBlockAt);
  const addCodeBlockAt = useCanvasStore((s) => s.addCodeBlockAt);
  const addDesignBlockAt = useCanvasStore((s: any) => s.addDesignBlockAt);
  const createCreateBlock = useCanvasStore((s: any) => s.createCreateBlock);
  const addBlock = useCanvasStore((s) => s.addBlock);
  const updateBlock = useCanvasStore((s) => s.updateBlock);
  const selectBlocks = useCanvasStore((s) => s.selectBlocks);
  const clearSelection = useCanvasStore((s) => s.clearSelection);
  const deleteBlocks = useCanvasStore((s) => s.deleteBlocks);
  const undo = useCanvasStore((s) => s.undo);
  const redo = useCanvasStore((s) => s.redo);
  const setCamera = useCanvasStore((s) => s.setCamera);
  const moveBlocksFromSnapshot = useCanvasStore((s) => s.moveBlocksFromSnapshot);
  const pushHistory = useCanvasStore((s) => s.pushHistory);
  const deleteBlock = useCanvasStore((s) => s.deleteBlock);

  // Match TextBlock typography so AI bubble feels like a normal text brick.
  const defaultFontFamily =
    'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"';
  const defaultLetterSpacing = "-0.01em";
  const aiPaddingY = 2;
  const aiFontSizePx = 12;
  const aiLineHeightPx = Math.max(1, Math.floor(gridSize || 24) - aiPaddingY * 2);

  // Track viewport size for culling.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (!r) return;
      const w = Math.floor(r.width);
      const h = Math.floor(r.height);
      setViewport({ width: w, height: h });
      // Keep canvas horizontally bounded to the visible area (split-screen friendly).
      if (w > 0) setCanvasWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [setCanvasWidth]);

  // Scrolling-as-camera (BrickEditor feel): keep store camera in sync with scroll.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      // Horizontal scrolling is intentionally disabled; keep left pinned.
      const left = 0;
      const top = el.scrollTop || 0;
      if (el.scrollLeft !== 0) el.scrollLeft = 0;
      setScrollPos((p) => (p.left === left && p.top === top ? p : { left, top }));
      // Keep zoom at 1 for the "old scrolling" feel.
      setCamera({ x: 0, y: top, zoom: 1 });
    };
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll as any);
  }, [setCamera]);

  // Drag-to-delete: hold a dragged block against the RIGHT wall for 2s to reveal a drop-to-delete zone.
  useEffect(() => {
    const HOLD_MS = 2000;
    const EDGE_PRESS_PX = 12;
    const RIGHT_TOUCH_EPS = 2;

    const isPressedToRightWall = (ev: PointerEvent) => {
      const el = containerRef.current;
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const localX = ev.clientX - rect.left;
      return localX >= rect.width - EDGE_PRESS_PX;
    };

    const anyDraggedTouchesRightWall = () => {
      const st = useCanvasStore.getState();
      const cw = Number(st.canvasWidth);
      if (!Number.isFinite(cw) || cw <= 0) return false;
      const ids = dragDeleteRef.current.ids || [];
      for (const id of ids) {
        const b: any = (st.blocks as any)[id];
        if (!b) continue;
        const right = (Number(b.x) || 0) + (Number(b.width) || 0);
        if (right >= cw - RIGHT_TOUCH_EPS) return true;
      }
      return false;
    };

    const onMove = (ev: PointerEvent) => {
      const d = dragDeleteRef.current;
      if (!d.active) return;
      if (d.pointerId != null && ev.pointerId !== d.pointerId) return;
      lastPointerClientRef.current = { x: ev.clientX, y: ev.clientY };

      const pressedToEdge = isPressedToRightWall(ev);
      const touchingWall = pressedToEdge && anyDraggedTouchesRightWall();
      const now = performance.now();

      if (!touchingWall) {
        d.touchStartAt = null;
        if (deleteZoneOpenRef.current) setDeleteZoneOpen(false);
        return;
      }

      if (d.touchStartAt == null) d.touchStartAt = now;
      const held = now - d.touchStartAt;
      if (held >= HOLD_MS) {
        if (!deleteZoneOpenRef.current) setDeleteZoneOpen(true);
      }

      // Show a muted drop frame when hovering over a canvas block.
      const world = clientToWorld(ev.clientX, ev.clientY);
      const containerId = findCreateContainerAtWorld(world.x, world.y, d.ids || []);
      setDropContainerId(containerId);
    };

    const shouldDeleteOnDrop = (ev: PointerEvent) => {
      if (!deleteZoneOpenRef.current) return false;
      const el = containerRef.current;
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const panelW = Math.min(160, Math.max(96, Math.floor(rect.width * 0.2)));
      return ev.clientX >= rect.right - panelW;
    };


    const endDrag = (ev: PointerEvent) => {
      const d = dragDeleteRef.current;
      if (!d.active) return;
      if (d.pointerId != null && ev.pointerId !== d.pointerId) return;

      const ids = (d.ids || []).slice();
      const doDelete = shouldDeleteOnDrop(ev);

      dragDeleteRef.current = { active: false, pointerId: null, primaryId: null, ids: [], touchStartAt: null };
      if (deleteZoneOpenRef.current) setDeleteZoneOpen(false);
      if (dropContainerId) setDropContainerId(null);

      if (doDelete && ids.length) {
        deleteBlocks(ids as any);
        return;
      }

      if (ids.length) {
        const world = clientToWorld(ev.clientX, ev.clientY);
        const containerId = findCreateContainerAtWorld(world.x, world.y, ids);
        if (containerId) {
          const st = useCanvasStore.getState();
          for (const id of ids) {
            const b: any = st.blocks[id];
            if (!b) continue;
            if (b.type === "text") {
              // When text enters a canvas block, mark it as CanvasText and keep content intact.
              st.updateBlock(id as any, {
                containerId,
                data: { ...(b as any).data, canvasText: true },
              } as any);
              continue;
            }
            st.updateBlock(id as any, { containerId } as any);
          }
        }
      }
    };

    const onUp = (ev: PointerEvent) => endDrag(ev);
    const onCancel = (ev: PointerEvent) => endDrag(ev);
    const onBlur = () => {
      dragDeleteRef.current = { active: false, pointerId: null, primaryId: null, ids: [], touchStartAt: null };
      if (deleteZoneOpenRef.current) setDeleteZoneOpen(false);
      if (dropContainerId) setDropContainerId(null);
    };

    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onCancel, true);
    window.addEventListener("blur", onBlur, true);
    return () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onCancel, true);
      window.removeEventListener("blur", onBlur, true);
    };
  }, [deleteBlocks]);

  // Undo/redo hotkeys + Create block hotkeys.
  useEffect(() => {
    if (!ENABLE_CANVAS_HOTKEYS) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const key = String(e.key || "").toLowerCase();
      const isMod = Boolean(e.ctrlKey || e.metaKey);
      const t = e.target as Element | null;
      if (t?.closest?.("[contenteditable='true']")) return;
      if (!isMod) return;
      if (key === "z" && e.shiftKey) {
        e.preventDefault();
        redo();
        return;
      }
      if (key === "z") {
        e.preventDefault();
        undo();
        return;
      }
      if (key === "y") {
        e.preventDefault();
        redo();
        return;
      }

      if (e.shiftKey && (key === "c" || key === "d" || key === "g" || key === "i")) {
        e.preventDefault();
        const el = containerRef.current;
        const rect = el?.getBoundingClientRect();
        const last = lastPointerClientRef.current;
        const world =
          last && rect
            ? clientToWorld(last.x, last.y)
            : rect
              ? clientToWorld(rect.left + rect.width / 2, rect.top + rect.height / 3)
              : { x: scrollPos.left || 0, y: scrollPos.top || 0 };
        const x = snapToGrid(world.x, gridSize);
        const y = snapToGrid(world.y, gridSize);
        const mode = key === "d" ? "drawing" : key === "g" ? "generated" : key === "i" ? "image" : "empty";
        const b = createCreateBlock(x, y, mode, {});
        addBlock(b);
        selectBlocks([b.id]);
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true } as any);
  }, [addBlock, createCreateBlock, gridSize, redo, scrollPos.left, scrollPos.top, selectBlocks, undo]);

  // Ctrl/Cmd+G groups currently activated shapes so they move together.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const key = String(e.key || "").toLowerCase();
      if (key !== "g") return;
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
      const brickIds = Array.from(new Set(activatedBrickIds)).filter((id) => blocks[id]);
      const gridIds = Array.from(new Set(raisedGridCellKeys));
      if (brickIds.length < 2 && gridIds.length < 2) return;
      e.preventDefault();

      if (brickIds.length >= 2) {
        const groupId = makeMoveGroupId();
        for (const id of brickIds) {
          const b: any = blocks[id];
          const data = b?.data && typeof b.data === "object" ? b.data : {};
          updateBlock(id as any, { data: { ...data, moveGroupId: groupId } } as any);
        }
        setActivatedBrickIds(brickIds);
        setRaisedBrickIds(brickIds);
      }

      if (gridIds.length >= 2) {
        setGroupedGridCellKeys(gridIds);
      }
      setShiftAnchor(null);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true } as any);
  }, [activatedBrickIds, raisedGridCellKeys, blocks, updateBlock]);

  // Ctrl/Cmd+D duplicates the currently pressed target (brick(s) or grid shape selection).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const key = String(e.key || "").toLowerCase();
      if (key !== "d") return;
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
      const heldBrick = groupDragRef.current;
      const heldShape = heldShapeDeleteRef.current;
      const hasHeldTarget = (heldBrick.active && heldBrick.snapshot.length > 0) || (heldShape.active && heldShape.keys.length > 0);
      const t = e.target as Element | null;
      if (!hasHeldTarget && t?.closest?.("[contenteditable='true']")) return;
      e.preventDefault();

      const offset = gridSize;

      const sourceBrickIds = (
        heldBrick.active && heldBrick.snapshot.length
          ? heldBrick.snapshot.map((s) => s.id)
          : Array.from(new Set(activatedBrickIds))
      ).filter((id) => !!blocks[id]);
      if (sourceBrickIds.length) {
        const groupIdMap = new Map<string, string>();
        const duplicatedIds: string[] = [];
        for (const id of sourceBrickIds) {
          const src: any = blocks[id];
          if (!src) continue;
          const clone: any = JSON.parse(JSON.stringify(src));
          clone.id = makeDuplicateId(String(src.type || "b"));
          clone.x = Number(src.x || 0) + offset;
          clone.y = Number(src.y || 0) + offset;
          clone.updatedAt = new Date().toISOString();
          clone.createdAt = clone.createdAt || clone.updatedAt;
          const gid = clone?.data?.moveGroupId;
          if (typeof gid === "string" && gid) {
            if (!groupIdMap.has(gid)) groupIdMap.set(gid, makeMoveGroupId());
            clone.data = { ...(clone.data || {}), moveGroupId: groupIdMap.get(gid) };
          }
          addBlock(clone as any);
          duplicatedIds.push(clone.id);
        }
        if (duplicatedIds.length) {
          selectBlocks(duplicatedIds as any);
          setActivatedBrickIds(duplicatedIds);
          setRaisedBrickIds(duplicatedIds);
          setShiftAnchor({ kind: "brick", key: duplicatedIds[duplicatedIds.length - 1] });
        }
        return;
      }

      const sourceGridKeys = Array.from(
        new Set(
          heldShape.active && heldShape.keys.length
            ? heldShape.keys
            : raisedGridCellKeys.length
              ? raisedGridCellKeys
              : activatedGridCellKeys
        )
      );
      if (!sourceGridKeys.length) return;
      const sourceSet = new Set(sourceGridKeys);
      let sourceRanges = activatedGridRanges.filter((r) => sourceGridKeys.some((k) => keyInRanges(k, [r])));
      if (!sourceRanges.length) {
        sourceRanges = sourceGridKeys.map((k) => {
          const p = parseCellKey(k);
          return { minX: p.x, maxX: p.x, minY: p.y, maxY: p.y };
        });
      }

      const duplicatedRanges = sourceRanges.map((r) => ({
        minX: r.minX + offset,
        maxX: r.maxX + offset,
        minY: r.minY + offset,
        maxY: r.maxY + offset,
      }));
      const duplicatedKeys = sourceGridKeys.map((k) => shiftCellKey(k, offset, offset));
      const preservedRanges = activatedGridRanges.filter((r) => !sourceGridKeys.some((k) => keyInRanges(k, [r])));
      const preservedKeys = activatedGridCellKeys.filter((k) => !sourceSet.has(k));

      setActivatedGridRanges([...preservedRanges, ...sourceRanges, ...duplicatedRanges]);
      // Keep full grid-shape key state consistent for both original and duplicate shapes.
      setActivatedGridCellKeys(toUnique([...preservedKeys, ...sourceGridKeys, ...duplicatedKeys]));
      // Duplicated shapes should behave like regular shapes: not pre-raised;
      // they raise only on hold-click and drop on release.
      setRaisedGridCellKeys([]);
      setGroupedGridCellKeys([]);
      setShiftLinkedGridSelection(false);
      if (duplicatedKeys.length) setShiftAnchor({ kind: "cell", key: duplicatedKeys[duplicatedKeys.length - 1] });
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true } as any);
  }, [
    activatedBrickIds,
    activatedGridCellKeys,
    activatedGridRanges,
    addBlock,
    blocks,
    gridSize,
    raisedGridCellKeys,
    selectBlocks,
  ]);

  // Delete key while holding/pressing any target on canvas.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const key = String(e.key || "").toLowerCase();
      if (key !== "delete" && key !== "backspace") return;
      const heldBrick = groupDragRef.current;
      if (heldBrick.active && heldBrick.snapshot.length) {
        const ids = Array.from(new Set(heldBrick.snapshot.map((s) => s.id).filter((id) => Boolean(blocks[id]))));
        if (!ids.length) return;
        e.preventDefault();
        deleteBlocks(ids as any);
        if (typingBlockId && ids.includes(typingBlockId)) setTypingBlockId(null);
        setActivatedBrickIds([]);
        setRaisedBrickIds([]);
        heldBrick.active = false;
        heldBrick.moved = false;
        heldBrick.pointerId = null;
        heldBrick.startWorldX = 0;
        heldBrick.startWorldY = 0;
        heldBrick.snapshot = [];
        return;
      }

      const heldShape = gridShapeDragRef.current;
      const heldDelete = heldShapeDeleteRef.current;
      if (!heldDelete.active || !heldDelete.keys.length) return;
      e.preventDefault();
      // Delete full connected footprint around currently held shape keys.
      const rangeKeys: string[] = [];
      for (const r of activatedGridRanges) rangeKeys.push(...cellKeysForRange(r));
      const allKeys = toUnique([...activatedGridCellKeys, ...rangeKeys, ...raisedGridCellKeys]);
      const seed = heldDelete.keys[0];
      const connected = seed ? getConnectedComponent(seed, allKeys) : [];
      const removeCellSet = new Set(connected.length ? connected : heldDelete.keys);

      setActivatedGridCellKeys((prev) => prev.filter((k) => !removeCellSet.has(k)));
      setRaisedGridCellKeys((prev) => prev.filter((k) => !removeCellSet.has(k)));
      setActivatedGridRanges((prev) =>
        prev.filter((r) => {
          for (const k of cellKeysForRange(r)) {
            if (removeCellSet.has(k)) return false;
          }
          return true;
        })
      );
      setGroupedGridCellKeys((prev) => prev.filter((k) => !removeCellSet.has(k)));
      setShapeCellTextByKey((prev) => {
        const next: Record<string, string> = {};
        let changed = false;
        for (const [k, v] of Object.entries(prev)) {
          if (removeCellSet.has(k)) {
            changed = true;
            continue;
          }
          next[k] = v;
        }
        return changed ? next : prev;
      });
      setTypingShapeCellKey((prev) => (prev && removeCellSet.has(prev) ? null : prev));
      setShiftLinkedGridSelection(false);
      setShiftAnchor(null);
      heldShapeDeleteRef.current = { active: false, pointerId: null, keys: [] };
      heldShape.active = false;
      heldShape.moved = false;
      heldShape.pointerId = null;
      gridShapeDragRef.current = {
        active: false,
        moved: false,
        pointerId: null,
        startWorldX: 0,
        startWorldY: 0,
        pressCellKey: null,
        startCells: [],
        startRaised: [],
        startRanges: [],
        moveCells: [],
        moveRaised: [],
        moveRangeIndexes: [],
        startGrouped: [],
        moveGrouped: [],
      };
      return;
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true } as any);
  }, [activatedGridCellKeys, activatedGridRanges, blocks, deleteBlocks, raisedGridCellKeys, typingBlockId]);

  // Shape hotkeys.
  useEffect(() => {
    if (!ENABLE_CANVAS_HOTKEYS) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as Element | null;
      if (t?.closest?.("[contenteditable='true']")) return;
      const key = String(e.key || "").toLowerCase();
      if (key !== "r" && key !== "l" && key !== "o") return;
      e.preventDefault();
      const el = containerRef.current;
      const rect = el?.getBoundingClientRect();
      const last = lastPointerClientRef.current;
      const world =
        last && rect
          ? clientToWorld(last.x, last.y)
          : rect
            ? clientToWorld(rect.left + rect.width / 2, rect.top + rect.height / 3)
            : { x: scrollPos.left || 0, y: scrollPos.top || 0 };
      if (key === "r") createShapeBlockAt(world.x, world.y, "rectangle");
      if (key === "o") createShapeBlockAt(world.x, world.y, "ellipse");
      if (key === "l") createShapeBlockAt(world.x, world.y, e.shiftKey ? "arrow" : "line");
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true } as any);
  }, [createShapeBlockAt, scrollPos.left, scrollPos.top]);

  // Expand the inner scroll surface to fit placed blocks (BrickEditor-like infinite down scroll).
  const surface = useMemo(() => {
    const baseH = Math.max(viewport.height || 0, 900);
    let maxBottom = 0;
    for (const id of blockOrder) {
      const b = blocks[id];
      if (!b) continue;
      maxBottom = Math.max(maxBottom, (b.y || 0) + (b.height || gridSize));
    }
    // Add breathing room below so the user can keep scrolling downward.
    const padBottom = gridSize * 12;
    return {
      // Horizontal walls: as wide as the visible viewport (no infinite horizontal growth).
      width: Math.max(gridSize, Math.floor((canvasWidth || viewport.width || 0) as number) || gridSize),
      height: Math.max(baseH, maxBottom + padBottom),
    };
  }, [blockOrder, blocks, canvasWidth, gridSize, viewport.height, viewport.width]);

  const visibleIds = useMemo(() => {
    const ids: string[] = [];
    const vp = viewport.width && viewport.height ? viewport : { width: window.innerWidth, height: window.innerHeight };
    for (const id of blockOrder) {
      const b = blocks[id];
      if (!b) continue;
      // With scroll-as-camera, treat camera.x/y as scrollLeft/scrollTop, zoom always 1.
      if (isInViewport(b, camera, vp, 400)) ids.push(id);
    }
    return ids;
  }, [blockOrder, blocks, camera, viewport]);

  function clientToWorld(clientX: number, clientY: number) {
    const el = containerRef.current;
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    return {
      x: (scrollPos.left || 0) + localX,
      y: (scrollPos.top || 0) + localY,
    };
  }

  const cellKey = (x: number, y: number) => `${x},${y}`;
  const parseCellKey = (key: string) => {
    const [sx, sy] = String(key || "0,0").split(",");
    return { x: Number(sx) || 0, y: Number(sy) || 0 };
  };
  const withUnique = (list: string[], key: string) => (list.includes(key) ? list : [...list, key]);
  const withoutKeys = (list: string[], keys: string[]) => list.filter((k) => !keys.includes(k));
  const getMoveGroupId = (id: string) => {
    const b: any = blocks[id as keyof typeof blocks];
    const data = b?.data && typeof b.data === "object" ? b.data : null;
    const gid = data?.moveGroupId;
    return typeof gid === "string" && gid.trim() ? gid.trim() : null;
  };
  const getMoveGroupMembers = (groupId: string) =>
    blockOrder.filter((id) => {
      const b: any = blocks[id as keyof typeof blocks];
      const data = b?.data && typeof b.data === "object" ? b.data : null;
      return data?.moveGroupId === groupId;
    });
  const keyInRanges = (key: string, ranges: GridRange[]) => {
    if (!ranges.length) return false;
    const p = parseCellKey(key);
    return ranges.some((range) => p.x >= range.minX && p.x <= range.maxX && p.y >= range.minY && p.y <= range.maxY);
  };
  const rangeCellCount = (range: GridRange) => {
    const w = Math.max(1, Math.floor((range.maxX - range.minX) / gridSize) + 1);
    const h = Math.max(1, Math.floor((range.maxY - range.minY) / gridSize) + 1);
    return w * h;
  };
  const hasPersistedGridShape = () => activatedGridCellKeys.length > 1;
  const shiftCellKey = (key: string, dx: number, dy: number) => {
    const p = parseCellKey(key);
    return cellKey(p.x + dx, p.y + dy);
  };
  const cellKeysForRange = (range: GridRange) => {
    const keys: string[] = [];
    for (let y = range.minY; y <= range.maxY; y += gridSize) {
      for (let x = range.minX; x <= range.maxX; x += gridSize) {
        keys.push(cellKey(x, y));
      }
    }
    return keys;
  };
  const getConnectedComponent = (startKey: string, allKeys: string[]) => {
    const set = new Set(allKeys);
    if (!set.has(startKey)) return [startKey];
    const seen = new Set<string>([startKey]);
    const queue = [startKey];
    while (queue.length) {
      const cur = queue.shift() as string;
      const p = parseCellKey(cur);
      const neighbors = [cellKey(p.x - gridSize, p.y), cellKey(p.x + gridSize, p.y), cellKey(p.x, p.y - gridSize), cellKey(p.x, p.y + gridSize)];
      for (const n of neighbors) {
        if (!set.has(n) || seen.has(n)) continue;
        seen.add(n);
        queue.push(n);
      }
    }
    return Array.from(seen);
  };
  const toUnique = (list: string[]) => {
    const out: string[] = [];
    for (const k of list) if (!out.includes(k)) out.push(k);
    return out;
  };
  const focusBrickInputById = (id: string) => {
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-canvas-brick-editor-id="${id}"]`) as HTMLDivElement | null;
      if (!el) return;
      el.focus();
      const sel = window.getSelection();
      if (!sel) return;
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    });
  };
  const focusShapeCellEditorByKey = (key: string, seedText?: string, placeCaretAtEnd = true) => {
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-shape-cell-editor-key="${key}"]`) as HTMLDivElement | null;
      if (!el) return;
      const isActive = document.activeElement === el;
      if (!isActive && typeof seedText === "string" && (el.textContent ?? "") !== seedText) {
        el.textContent = seedText;
      }
      el.focus();
      if (!placeCaretAtEnd) return;
      const sel = window.getSelection();
      if (!sel) return;
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    });
  };
  const commitShapeCellEditorByKey = (key?: string | null) => {
    const targetKey = key || typingShapeCellKey;
    if (!targetKey) return;
    const el = document.querySelector(`[data-shape-cell-editor-key="${targetKey}"]`) as HTMLDivElement | null;
    const nextText = String(el?.innerText ?? shapeCellTextByKey[targetKey] ?? "").replace(/\r\n/g, "\n");
    setShapeCellTextByKey((prev) => ({
      ...prev,
      [targetKey]: nextText,
    }));
  };
  useEffect(() => {
    if (!typingShapeCellKey) return;
    // Ensure first entry into shape-cell typing places caret at end reliably.
    const seed = String(shapeCellTextByKey[typingShapeCellKey] || "");
    const placeAtEnd = seed.length === 0;
    focusShapeCellEditorByKey(typingShapeCellKey, seed, placeAtEnd);
    const t = window.setTimeout(() => focusShapeCellEditorByKey(typingShapeCellKey, seed, placeAtEnd), 0);
    return () => window.clearTimeout(t);
  }, [typingShapeCellKey]);
  const lineRowsForVariant = (variant: "body" | "h2" | "h1") => (variant === "h1" ? 3 : variant === "h2" ? 2 : 1);
  const fontSizeForVariant = (variant: "body" | "h2" | "h1") => (variant === "h1" ? 42 : variant === "h2" ? 28 : 14);
  const fontWeightForVariant = (variant: "body" | "h2" | "h1") => (variant === "body" ? 400 : 500);
  const getRequiredHorizontalCells = (text: string, variant: "body" | "h2" | "h1") => {
    const s = String(text || "");
    const lines = s.split("\n");
    const longest = lines.reduce((m, line) => (line.length > m.length ? line : m), "");
    // Measure actual text width so growth occurs only when current brick is truly filled.
    let textPx = longest.length * 7.2;
    if (typeof document !== "undefined") {
      const measureCanvas = document.createElement("canvas");
      const ctx = measureCanvas.getContext("2d");
      if (ctx) {
        const fontWeight = fontWeightForVariant(variant);
        const fontSize = fontSizeForVariant(variant);
        ctx.font = `${fontWeight} ${fontSize}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"`;
        textPx = ctx.measureText(longest).width;
      }
    }
    const horizontalPaddingPx = 16; // 8px left + 8px right, matching editor styles.
    // Small guard avoids one-frame wrap flicker at boundary while typing.
    const wrapGuardPx = variant === "body" ? 4 : 8;
    return Math.max(1, Math.ceil((textPx + horizontalPaddingPx + wrapGuardPx) / gridSize));
  };
  const getRequiredVerticalCells = (text: string) => {
    const s = String(text || "");
    // Grow vertically only on explicit Enter/newline.
    return Math.max(1, s.split("\n").length);
  };
  const parseTextSlashVariant = (
    raw: string,
    currentVariant: "body" | "h2" | "h1",
    currentListType: "none" | "bullet" | "numbered" | "todo"
  ) => {
    const TODO_EMPTY = "◻\uFE0E";
    const TODO_FILLED = "◼\uFE0E";
    const normalizeTodoMarkers = (text: string) =>
      String(text || "")
        .split("\n")
        .map((line) => {
          if (/^\s*(?:◼(?:\uFE0E|\uFE0F)?|■|⬛|▣|☑|✅|\[x\])\s*/i.test(line))
            return line.replace(/^(\s*)(?:◼(?:\uFE0E|\uFE0F)?|■|⬛|▣|☑|✅|\[x\])\s*/i, `$1${TODO_FILLED} `);
          if (/^\s*(?:◻(?:\uFE0E|\uFE0F)?|□|⬜|▢|☐|\[\s?\])\s*/i.test(line))
            return line.replace(/^(\s*)(?:◻(?:\uFE0E|\uFE0F)?|□|⬜|▢|☐|\[\s?\])\s*/i, `$1${TODO_EMPTY} `);
          return line;
        })
        .join("\n");
    const ensureListSeed = (content: string, listType: "bullet" | "numbered" | "todo") => {
      const s = String(content || "");
      const marker = listType === "bullet" ? "• " : listType === "todo" ? `${TODO_EMPTY} ` : "1. ";
      if (!s.trim()) return marker;
      const firstLine = s.split("\n")[0] || "";
      if (listType === "bullet" && /^\s*(?:•|-)\s/.test(firstLine)) return s;
      if (listType === "todo" && /^\s*(?:◻(?:\uFE0E|\uFE0F)?|◼(?:\uFE0E|\uFE0F)?|□|■|⬜|⬛|▢|▣|☐|☑|✅|\[\s?\]|\[x\])\s*/i.test(firstLine))
        return normalizeTodoMarkers(s);
      if (listType === "numbered" && /^\s*\d+\.\s/.test(firstLine)) return s;
      return `${marker}${s}`;
    };
    const s = String(raw || "");
    const trimmed = s.replace(/^\s+/, "");
    if (/^\/h1(?:\s+|$)/i.test(trimmed)) {
      const content = trimmed.replace(/^\/h1(?:\s+)?/i, "");
      return { content, variant: "h1" as const, listType: "none" as const, consumed: true };
    }
    if (/^\/h2(?:\s+|$)/i.test(trimmed)) {
      const content = trimmed.replace(/^\/h2(?:\s+)?/i, "");
      return { content, variant: "h2" as const, listType: "none" as const, consumed: true };
    }
    if (/^\/(?:text|p|body)(?:\s+|$)/i.test(trimmed)) {
      const content = trimmed.replace(/^\/(?:text|p|body)(?:\s+)?/i, "");
      return { content, variant: "body" as const, listType: "none" as const, consumed: true };
    }
    if (/^\/(?:bulleted\s*list|bullet(?:ed)?(?:\s*list)?|ul)(?:\s+|$)/i.test(trimmed)) {
      const content = trimmed.replace(/^\/(?:bulleted\s*list|bullet(?:ed)?(?:\s*list)?|ul)(?:\s+)?/i, "");
      return {
        content: ensureListSeed(content, "bullet"),
        variant: "body" as const,
        listType: "bullet" as const,
        consumed: true,
      };
    }
    if (/^\/(?:numbered\s*list|number(?:ed)?(?:\s*list)?|ol)(?:\s+|$)/i.test(trimmed)) {
      const content = trimmed.replace(/^\/(?:numbered\s*list|number(?:ed)?(?:\s*list)?|ol)(?:\s+)?/i, "");
      return {
        content: ensureListSeed(content, "numbered"),
        variant: "body" as const,
        listType: "numbered" as const,
        consumed: true,
      };
    }
    if (/^\/(?:to\s*do\s*list|todo(?:\s*list)?|task(?:\s*list)?)(?:\s+|$)/i.test(trimmed)) {
      const content = trimmed.replace(/^\/(?:to\s*do\s*list|todo(?:\s*list)?|task(?:\s*list)?)(?:\s+)?/i, "");
      return {
        content: ensureListSeed(content, "todo"),
        variant: "body" as const,
        listType: "todo" as const,
        consumed: true,
      };
    }
    return {
      content: currentListType === "todo" ? normalizeTodoMarkers(s) : s,
      variant: currentVariant,
      listType: currentListType,
      consumed: false,
    };
  };
  const minRowsForVariant = (variant: "body" | "h2" | "h1") => (variant === "h1" ? 3 : variant === "h2" ? 2 : 1);
  const syncBrickEditorText = (id: string, text: string) => {
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-canvas-brick-editor-id="${id}"]`) as HTMLDivElement | null;
      if (!el) return;
      if ((el.innerText || "") === text) return;
      el.innerText = text;
      const sel = window.getSelection();
      if (!sel) return;
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    });
  };
  const findBlockAtCell = (x: number, y: number) => {
    for (const id of blockOrder) {
      const b: any = blocks[id];
      if (!b) continue;
      if (Math.floor(Number(b.x || 0)) === x && Math.floor(Number(b.y || 0)) === y) return id;
    }
    return null as string | null;
  };
  const ensureNextLinkedCellBlock = (id: string) => {
    const cur: any = blocks[id];
    if (!cur) return null as string | null;
    const data = cur?.data && typeof cur.data === "object" ? { ...cur.data } : {};
    const existing = typeof data.linkedNextId === "string" ? data.linkedNextId : "";
    if (existing && blocks[existing]) return existing;
    const nextX = Math.floor(Number(cur.x || 0)) + gridSize;
    const nextY = Math.floor(Number(cur.y || 0));
    const existingAtPos = findBlockAtCell(nextX, nextY);
    const nextId =
      existingAtPos ||
      addTextBlockAt(
        { x: nextX, y: nextY },
        { width: Math.max(1, Math.floor(Number(cur.width || gridSize))), height: Math.max(1, Math.floor(Number(cur.height || gridSize))), content: "", format: "plain" }
      );
    updateBlock(id as any, { data: { ...data, linkedNextId: nextId } } as any);
    const nb: any = blocks[nextId];
    const ndata = nb?.data && typeof nb.data === "object" ? { ...nb.data } : {};
    updateBlock(nextId as any, { data: { ...ndata, linkedPrevId: id } } as any);
    return nextId;
  };
  const dropEmptyTypingBlockIfNeeded = (nextTypingId?: string | null) => {
    const prevId = typingBlockId;
    if (!prevId || prevId === nextTypingId) return;
    const prev: any = blocks[prevId];
    if (!prev) return;
    const txt = String(prev?.content || "").trim();
    if (txt.length > 0) return;
    const x = Math.floor(Number(prev.x || 0));
    const y = Math.floor(Number(prev.y || 0));
    const key = cellKey(x, y);
    deleteBlock(prevId as any);
    setActivatedGridCellKeys((s) => withoutKeys(s, [key]));
    setRaisedGridCellKeys((s) => withoutKeys(s, [key]));
    setActivatedGridRanges((s) => s.filter((r) => !(r.minX === x && r.maxX === x && r.minY === y && r.maxY === y)));
  };

  useEffect(() => {
    const active = new Set([...activatedGridCellKeys, ...raisedGridCellKeys]);
    setGroupedGridCellKeys((prev) => prev.filter((k) => active.has(k)));
  }, [activatedGridCellKeys, raisedGridCellKeys]);

  useEffect(() => {
    const activeShapeKeys = new Set(toUnique([...activatedGridCellKeys, ...activatedGridRanges.flatMap((r) => cellKeysForRange(r))]));
    setShapeCellTextByKey((prev) => {
      const next: Record<string, string> = {};
      let changed = false;
      for (const [k, v] of Object.entries(prev)) {
        if (!activeShapeKeys.has(k)) {
          changed = true;
          continue;
        }
        next[k] = v;
      }
      return changed ? next : prev;
    });
    setTypingShapeCellKey((prev) => (prev && activeShapeKeys.has(prev) ? prev : null));
  }, [activatedGridCellKeys, activatedGridRanges]);

  const beginGridShapeDrag = (
    e: React.PointerEvent,
    source?: { cellKey?: string; raisedKey?: string; rangeIndex?: number }
  ) => {
    if (e.button !== 0) return;
    if (!activatedGridCellKeys.length && !activatedGridRanges.length) return;
    e.preventDefault();
    e.stopPropagation();
    const rangeBackedKeys = activatedGridRanges.flatMap((r) => cellKeysForRange(r));
    const startCells = toUnique([...activatedGridCellKeys, ...rangeBackedKeys]);
    const startRaised = raisedGridCellKeys.slice();
    const startRanges = activatedGridRanges.map((r) => ({ ...r }));
    const allActiveKeys = Array.from(new Set([...startCells, ...startRaised]));

    let moveCells = startCells.slice();
    let moveRaised = startRaised.slice();
    let moveRangeIndexes = startRanges.map((_, idx) => idx);

    if (typeof source?.rangeIndex === "number" && startRanges[source.rangeIndex]) {
      const idx = source.rangeIndex;
      const rangeKeys = new Set(cellKeysForRange(startRanges[idx]));
      moveCells = startCells.filter((k) => rangeKeys.has(k));
      moveRaised = startRaised.filter((k) => rangeKeys.has(k));
      moveRangeIndexes = [idx];
    } else if (source?.cellKey || source?.raisedKey) {
      const seed = source.cellKey || source.raisedKey || "";
      const component = new Set(getConnectedComponent(seed, allActiveKeys));
      moveCells = startCells.filter((k) => component.has(k));
      moveRaised = startRaised.filter((k) => component.has(k));
      moveRangeIndexes = startRanges
        .map((range, idx) => ({ range, idx }))
        .filter(({ range }) => cellKeysForRange(range).some((k) => component.has(k)))
        .map(({ idx }) => idx);
    }

    if (e.shiftKey) {
      setRaisedGridCellKeys((prev) => toUnique([...prev, ...moveCells, ...moveRaised]));
      // Shift-press on shape overlays should enable temporary multi-shape linked move.
      setShiftLinkedGridSelection(true);
    } else {
      setRaisedGridCellKeys(toUnique([...moveCells, ...moveRaised]));
    }

    const groupedSet = new Set(groupedGridCellKeys);
    const moveSeed = new Set([...moveCells, ...moveRaised]);
    const shouldUseGroupedMove = Array.from(moveSeed).some((k) => groupedSet.has(k));
    let moveGrouped: string[] = [];
    if (shouldUseGroupedMove && groupedGridCellKeys.length) {
      const grouped = groupedGridCellKeys.slice();
      moveCells = startCells.filter((k) => grouped.includes(k));
      moveRaised = startRaised.filter((k) => grouped.includes(k));
      moveRangeIndexes = startRanges
        .map((range, idx) => ({ range, idx }))
        .filter(({ range }) => cellKeysForRange(range).some((k) => grouped.includes(k)))
        .map(({ idx }) => idx);
      moveGrouped = grouped.slice();
    }
    // Temporary shift multi-select should drag all selected raised shapes together.
    if (!shouldUseGroupedMove && shiftLinkedGridSelection && startRaised.length > 1) {
      const raised = startRaised.slice();
      moveCells = startCells.filter((k) => raised.includes(k));
      moveRaised = raised;
      moveRangeIndexes = startRanges
        .map((range, idx) => ({ range, idx }))
        .filter(({ range }) => cellKeysForRange(range).some((k) => raised.includes(k)))
        .map(({ idx }) => idx);
    }

    const world = clientToWorld(e.clientX, e.clientY);
    const pressX = snapToGrid(world.x, gridSize);
    const pressY = snapToGrid(world.y, gridSize);
    const pressCellKey = source?.cellKey || source?.raisedKey || cellKey(pressX, pressY);
    const expandedActiveKeys = toUnique([
      ...startCells,
      ...startRaised,
      ...startRanges.flatMap((r) => cellKeysForRange(r)),
    ]);
    const deleteSeed =
      (typeof source?.rangeIndex === "number" && startRanges[source.rangeIndex]
        ? cellKeysForRange(startRanges[source.rangeIndex])[0]
        : source?.cellKey || source?.raisedKey) || moveCells[0] || moveRaised[0] || expandedActiveKeys[0] || "";
    const heldDeleteKeys = deleteSeed ? getConnectedComponent(deleteSeed, expandedActiveKeys) : expandedActiveKeys;
    heldShapeDeleteRef.current = {
      active: true,
      pointerId: e.pointerId,
      keys: toUnique(heldDeleteKeys),
    };
    gridShapeDragRef.current = {
      active: true,
      moved: false,
      pointerId: e.pointerId,
      startWorldX: world.x,
      startWorldY: world.y,
      pressCellKey,
      startCells,
      startRaised,
      startRanges,
      moveCells,
      moveRaised,
      moveRangeIndexes,
      startGrouped: groupedGridCellKeys.slice(),
      moveGrouped,
    };
    setShiftAnchor(null);
  };

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = gridShapeDragRef.current;
      if (!d.active) return;
      if (d.pointerId != null && e.pointerId !== d.pointerId) return;
      const world = clientToWorld(e.clientX, e.clientY);
      const rawDx = world.x - d.startWorldX;
      const rawDy = world.y - d.startWorldY;
      if (!d.moved) {
        const manhattan = Math.abs(rawDx) + Math.abs(rawDy);
        // Match brick drag intent threshold to avoid accidental shape moves.
        if (manhattan < Math.max(2, Math.floor(gridSize / 5))) return;
        d.moved = true;
      }
      const stepX = Math.round((world.x - d.startWorldX) / gridSize) * gridSize;
      const stepY = Math.round((world.y - d.startWorldY) / gridSize) * gridSize;
      const moveCellSet = new Set(d.moveCells);
      const moveRaisedSet = new Set(d.moveRaised);
      const movedCellKeys = d.moveCells.map((k) => shiftCellKey(k, stepX, stepY));
      const movedRaisedKeys = d.moveRaised.map((k) => shiftCellKey(k, stepX, stepY));
      const keptCellKeys = d.startCells.filter((k) => !moveCellSet.has(k));
      const nextCellKeys = toUnique([...keptCellKeys, ...movedCellKeys]);
      // Keep pressed/hold visual state pinned to the actively dragged selection.
      // Using the pre-press raised snapshot here can clear hold state mid-drag.
      const nextRaisedKeys = toUnique([...movedCellKeys, ...movedRaisedKeys]);
      if (heldShapeDeleteRef.current.active) heldShapeDeleteRef.current.keys = nextRaisedKeys.slice();
      setShapeCellTextByKey((prev) => {
        const moveMap = new Map<string, string>();
        d.moveCells.forEach((from, idx) => moveMap.set(from, movedCellKeys[idx]));
        d.moveRaised.forEach((from, idx) => moveMap.set(from, movedRaisedKeys[idx]));
        const next: Record<string, string> = {};
        let changed = false;
        for (const [k, v] of Object.entries(prev)) {
          const nk = moveMap.get(k) || k;
          if (nk !== k) changed = true;
          if (typeof next[nk] === "undefined") next[nk] = v;
        }
        if (typingShapeCellKey && moveMap.has(typingShapeCellKey)) {
          const nk = moveMap.get(typingShapeCellKey) as string;
          if (nk !== typingShapeCellKey) {
            changed = true;
            setTypingShapeCellKey(nk);
          }
        }
        return changed ? next : prev;
      });
      setActivatedGridCellKeys(nextCellKeys);
      setRaisedGridCellKeys(nextRaisedKeys);
      setActivatedGridRanges(
        d.startRanges.map((r, idx) =>
          d.moveRangeIndexes.includes(idx)
            ? { minX: r.minX + stepX, maxX: r.maxX + stepX, minY: r.minY + stepY, maxY: r.maxY + stepY }
            : r
        )
      );
      if (d.moveGrouped.length) {
        const moveGroupedSet = new Set(d.moveGrouped);
        const movedGroupedKeys = d.moveGrouped.map((k) => shiftCellKey(k, stepX, stepY));
        const keptGroupedKeys = d.startGrouped.filter((k) => !moveGroupedSet.has(k));
        setGroupedGridCellKeys(toUnique([...keptGroupedKeys, ...movedGroupedKeys]));
      }
    };
    const onUp = (e: PointerEvent) => {
      const d = gridShapeDragRef.current;
      if (!d.active) return;
      if (d.pointerId != null && e.pointerId !== d.pointerId) return;
      gridShapeDragRef.current = {
        active: false,
        moved: false,
        pointerId: null,
        startWorldX: 0,
        startWorldY: 0,
        pressCellKey: null,
        startCells: [],
        startRaised: [],
        startRanges: [],
        moveCells: [],
        moveRaised: [],
        moveRangeIndexes: [],
        startGrouped: [],
        moveGrouped: [],
      };
      // Press/hold behavior: release always drops raised/blue state.
      setRaisedGridCellKeys([]);
      setShiftLinkedGridSelection(false);
      heldShapeDeleteRef.current = { active: false, pointerId: null, keys: [] };
      if (!d.moved && d.pressCellKey) {
        commitShapeCellEditorByKey();
        setTypingBlockId(null);
        setActivatedBrickIds([]);
        setRaisedBrickIds([]);
        setTypingShapeCellKey(d.pressCellKey);
        const existing = String(shapeCellTextByKey[d.pressCellKey] || "");
        focusShapeCellEditorByKey(d.pressCellKey, existing, existing.length === 0);
      }
    };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    return () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
    };
  }, [clientToWorld, gridSize, groupedGridCellKeys, shapeCellTextByKey, typingShapeCellKey]);

  // Group-aware dragging for pressed shape shells.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = groupDragRef.current;
      if (!d.active) return;
      if (d.pointerId != null && e.pointerId !== d.pointerId) return;
      const world = clientToWorld(e.clientX, e.clientY);
      const dx = world.x - d.startWorldX;
      const dy = world.y - d.startWorldY;
      if (!d.moved) {
        const manhattan = Math.abs(dx) + Math.abs(dy);
        if (manhattan < Math.max(2, Math.floor(gridSize / 5))) return;
        d.moved = true;
        const draggedIds = d.snapshot.map((s) => s.id).filter(Boolean);
        if (draggedIds.length) {
          setActivatedBrickIds(draggedIds);
          setRaisedBrickIds(draggedIds);
          setTypingBlockId(null);
        }
      }
      moveBlocksFromSnapshot(d.snapshot as any, dx, dy, { snap: true, snapSize: gridSize } as any);
    };
    const onUp = (e: PointerEvent) => {
      const d = groupDragRef.current;
      if (!d.active) return;
      if (d.pointerId != null && e.pointerId !== d.pointerId) return;
      const moved = d.moved;
      groupDragRef.current = { active: false, moved: false, pointerId: null, startWorldX: 0, startWorldY: 0, snapshot: [] };
      if (moved) {
        suppressBrickClickRef.current = true;
        window.setTimeout(() => {
          suppressBrickClickRef.current = false;
        }, 0);
        // On release after drag, drop visual raised/selected state.
        setActivatedBrickIds([]);
        setRaisedBrickIds([]);
        pushHistory();
      }
    };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    return () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
    };
  }, [clientToWorld, gridSize, moveBlocksFromSnapshot, pushHistory]);

  const pairShiftTargets = (anchor: PressTarget, target: PressTarget) => {
    const ak = String(anchor.key || "");
    const tk = String(target.key || "");
    if (!ak || !tk || (anchor.kind === target.kind && ak === tk)) {
      setShiftAnchor(target);
      return;
    }
    const isBrickActivated = (k: string) => activatedBrickIds.includes(k);

    if (anchor.kind === "cell" && target.kind === "cell") {
      const a = parseCellKey(ak);
      const t = parseCellKey(tk);
      const minX = Math.min(a.x, t.x);
      const maxX = Math.max(a.x, t.x);
      const minY = Math.min(a.y, t.y);
      const maxY = Math.max(a.y, t.y);
      const keys: string[] = [];
      for (let y = minY; y <= maxY; y += gridSize) {
        for (let x = minX; x <= maxX; x += gridSize) {
          keys.push(cellKey(x, y));
        }
      }
      setActivatedGridCellKeys((prev) => {
        let next = [...prev];
        for (const k of keys) next = withUnique(next, k);
        return next;
      });
      setRaisedGridCellKeys((prev) => toUnique([...withoutKeys(prev, keys), ...keys]));
      setActivatedGridRanges((prev) => [...prev, { minX, maxX, minY, maxY }]);
      setShiftLinkedGridSelection(true);
      setShiftAnchor(target);
      return;
    }

    if (anchor.kind === "brick" && target.kind === "brick") {
      const bothActivated = isBrickActivated(ak) && isBrickActivated(tk);
      setActivatedBrickIds((prev) => withUnique(withUnique(prev, ak), tk));
      if (bothActivated) {
        setRaisedBrickIds((prev) => withUnique(withUnique(prev, ak), tk));
      } else {
        setRaisedBrickIds((prev) => withoutKeys(prev, [ak, tk]));
      }
      setShiftAnchor(target);
      return;
    }

    // Mixed pair (activated brick + empty shell): show as two activated, no raise.
    const cellK = anchor.kind === "cell" ? ak : tk;
    const brickK = anchor.kind === "brick" ? ak : tk;
    setActivatedGridCellKeys((prev) => withUnique(prev, cellK));
    setActivatedBrickIds((prev) => withUnique(prev, brickK));
    setRaisedGridCellKeys((prev) => withUnique(prev, cellK));
    setRaisedBrickIds((prev) => withoutKeys(prev, [brickK]));
    setShiftLinkedGridSelection(true);
    setShiftAnchor(target);
  };

  function createShapeBlockAt(worldX: number, worldY: number, shape: string) {
    const b = createCreateBlock(worldX, worldY, "shape", { shape });
    b.width = gridSize * 8;
    b.height = gridSize * 6;
    addBlock(b);
    return b.id;
  }


  // Track hover-into-canvas-block while dragging any block (not just drag-handle).
  useEffect(() => {
    const onMove = (ev: PointerEvent) => {
      if (ev.buttons === 0) return;
      const t = ev.target as Element | null;
      if (!t?.closest?.("[data-canvas-block]")) return;
      const st = useCanvasStore.getState();
      if (!st.selectedIds?.length) return;
      const world = clientToWorld(ev.clientX, ev.clientY);
      const containerId = findCreateContainerAtWorld(world.x, world.y, st.selectedIds);
      setDropContainerId(containerId);
    };
    const onUp = () => setDropContainerId(null);
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    return () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
    };
  }, []);

  // Shape picker (opened from /shape)
  useEffect(() => {
    const onOpen = (e: Event) => {
      const ce = e as CustomEvent<{ clientX: number; clientY: number; worldX: number; worldY: number }>;
      const clientX = Number(ce.detail?.clientX) || 0;
      const clientY = Number(ce.detail?.clientY) || 0;
      const worldX = Number(ce.detail?.worldX) || 0;
      const worldY = Number(ce.detail?.worldY) || 0;
      setShapePickerAnchor({ clientX, clientY, worldX, worldY });
      setShapePickerOpen(true);
    };
    window.addEventListener("omnia_shape_picker_open", onOpen as any);
    return () => window.removeEventListener("omnia_shape_picker_open", onOpen as any);
  }, []);

  // Fit a canvas block into the current viewport (no scroll needed).
  useEffect(() => {
    const onFit = (e: Event) => {
      const ce = e as CustomEvent<{ id: string }>;
      const id = String(ce.detail?.id || "");
      if (!id) return;
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const st = useCanvasStore.getState();
      const b: any = st.blocks[id];
      if (!b) return;
      const pad = 24;
      const maxW = Math.max(1, Math.floor(rect.width - pad * 2));
      const maxH = Math.max(1, Math.floor(rect.height - pad * 2));
      const scale = Math.min(1, maxW / Math.max(1, b.width || 1), maxH / Math.max(1, b.height || 1));
      if (scale < 1) {
        const w = Math.max(1, Math.floor((b.width || 1) * scale));
        const h = Math.max(1, Math.floor((b.height || 1) * scale));
        st.updateBlock(id as any, { width: w, height: h } as any);
      }
      requestAnimationFrame(() => {
        const top = Math.max(0, Math.floor((b.y || 0) - (rect.height - (b.height || 0)) / 2));
        el.scrollTop = top;
      });
    };
    window.addEventListener("omnia_fit_block", onFit as any);
    return () => window.removeEventListener("omnia_fit_block", onFit as any);
  }, []);

  const findCreateContainerAtWorld = (x: number, y: number, ignoreIds: string[] = []) => {
    const st = useCanvasStore.getState();
    let hitId: string | null = null;
    let topZ = -Infinity;
    for (const id of st.blockOrder) {
      if (ignoreIds.includes(id)) continue;
      const b = st.blocks[id];
      if (!b || b.type !== "create") continue;
      const bx = Number((b as any).x || 0);
      const by = Number((b as any).y || 0);
      const bw = Number((b as any).width || 0);
      const bh = Number((b as any).height || 0);
      if (x < bx || x > bx + bw || y < by || y > by + bh) continue;
      const z = Number((b as any).zIndex ?? st.blockOrder.indexOf(id));
      if (z >= topZ) {
        topZ = z;
        hitId = id;
      }
    }
    return hitId;
  };

  const focusTextBlockById = (id: string) => {
    requestAnimationFrame(() => {
      const sel = document.querySelector(`[data-canvas-text-editor-id="${id}"]`) as HTMLElement | null;
      sel?.focus?.();
    });
  };

  const focusListItemByKey = (key: string) => {
    requestAnimationFrame(() => {
      const sel = document.querySelector(`[data-canvas-list-item-editor-id="${key}"]`) as HTMLElement | null;
      sel?.focus?.();
    });
  };


  const pickImageDataUrl = async (): Promise<string | null> => {
    return await new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.onchange = () => {
        const f = input.files?.[0];
        if (!f) return resolve(null);
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(f);
      };
      input.click();
    });
  };

  // Attachments button (page UI) -> canvas insertion via custom events.
  useEffect(() => {
    const readFileAsDataUrl = (file: File) =>
      new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("Failed to read file"));
        reader.readAsDataURL(file);
      });

    const getInsertWorld = (clientX?: number, clientY?: number) => {
      const el = containerRef.current;
      const rect = el?.getBoundingClientRect();
      if (rect && Number.isFinite(clientX) && Number.isFinite(clientY)) return clientToWorld(Number(clientX), Number(clientY));
      const last = lastPointerClientRef.current;
      if (last && rect) return clientToWorld(last.x, last.y);
      if (rect) return clientToWorld(rect.left + rect.width / 2, rect.top + rect.height / 3);
      return { x: scrollPos.left || 0, y: scrollPos.top || 0 };
    };

    const onFiles = async (e: Event) => {
      const ce = e as CustomEvent<{ files: File[]; clientX?: number; clientY?: number }>;
      const files = Array.isArray(ce.detail?.files) ? ce.detail.files : [];
      if (!files.length) return;

      const base = getInsertWorld(ce.detail?.clientX, ce.detail?.clientY);
      const baseX = snapToGrid(base.x, gridSize);
      const baseY = snapToGrid(base.y, gridSize);

      for (let i = 0; i < files.length; i += 1) {
        const f = files[i];
        const x = baseX;
        const y = baseY + i * gridSize * 7;
        const containerId = findCreateContainerAtWorld(x, y);
        let dataUrl = "";
        try {
          dataUrl = await readFileAsDataUrl(f);
        } catch {
          continue;
        }
        if (String(f.type || "").startsWith("image/") && dataUrl.startsWith("data:image/")) {
          const b = createCreateBlock(x, y, "image", { src: dataUrl });
          b.width = gridSize * 10;
          b.height = gridSize * 6;
          if (containerId) (b as any).containerId = containerId;
          addBlock(b);
          continue;
        }
        const id = addFileBlockAt(
          { x, y },
          { name: f.name || "file", mime: f.type || "", dataUrl, width: gridSize * 12, height: gridSize * 3 }
        );
        if (containerId) updateBlock(id, { containerId } as any);
      }
    };

    const addUrlAsBlock = (url: string, clientX?: number, clientY?: number) => {
      const u = String(url || "").trim();
      if (!u) return;
      const base = getInsertWorld(clientX, clientY);
      const wx = snapToGrid(base.x, gridSize);
      const wy = snapToGrid(base.y, gridSize);
      const containerId = findCreateContainerAtWorld(wx, wy);
      const vid = extractYouTubeVideoId(u);
      if (vid) {
        const id = addYouTubeBlockAt({ x: wx, y: wy }, { url: u, videoId: vid });
        if (containerId) updateBlock(id, { containerId } as any);
        return;
      }
      const id = addLinkBlockAt({ x: wx, y: wy }, { url: u });
      if (containerId) updateBlock(id, { containerId } as any);
    };

    const onLink = (e: Event) => {
      const ce = e as CustomEvent<{ url: string; clientX?: number; clientY?: number }>;
      addUrlAsBlock(String(ce.detail?.url || ""), ce.detail?.clientX, ce.detail?.clientY);
    };

    window.addEventListener("omnia_attach_files", onFiles as any);
    window.addEventListener("omnia_attach_link", onLink as any);
    return () => {
      window.removeEventListener("omnia_attach_files", onFiles as any);
      window.removeEventListener("omnia_attach_link", onLink as any);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addBlock, addFileBlockAt, addLinkBlockAt, addTextBlockAt, addYouTubeBlockAt, gridSize, scrollPos.left, scrollPos.top]);

  // Live AI (BrickEditor parity): debounce per-block input, keep a per-block thread,
  // ask the model for JSON { shouldRespond, assistant, actions }, then apply allowlisted actions.
  useEffect(() => {
    if (!liveAIMode) return;

    const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

    const callAI = async (prompt: string): Promise<string> => {
      let aiModel = "gemini-flash-latest";
      try {
        const settings = JSON.parse(localStorage.getItem("lykinsai_settings") || "{}");
        aiModel = settings.aiModel || "gemini-flash-latest";
      } catch {
        // ignore
      }
      const { API_BASE_URL } = await import("@/lib/api-config");
      const res = await fetch(`${API_BASE_URL}/api/ai/invoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: aiModel, prompt: String(prompt || "") }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const msg = String(err.error || res.statusText || "AI request failed");
        throw new Error(`${res.status} ${msg}`.trim());
      }
      const data = await res.json();
      return String(data.response || "").trim();
    };

    const summarizeBlocksForAI = (limit = 36) => {
      const st = useCanvasStore.getState();
      const out: string[] = [];
      const ids = Array.isArray(st.blockOrder) ? st.blockOrder : [];
      const max = Math.max(0, Math.min(ids.length, Math.floor(limit)));
      const g = Math.max(1, Math.floor(st.gridSize || 24));
      const pos = (b: any) => {
        const xb = Math.round((Number(b?.x) || 0) / g);
        const yb = Math.round((Number(b?.y) || 0) / g);
        const w = Math.max(1, Math.round((Number(b?.width) || g) / g));
        const h = Math.max(1, Math.round((Number(b?.height) || g) / g));
        return `@(${xb},${yb}) ${w}x${h}`;
      };
      for (let i = 0; i < max; i += 1) {
        const id = String(ids[i] || "");
        const b: any = (st.blocks as any)[id];
        if (!b) continue;
        const kind = String(b?.type || "text");
        if (kind === "text") {
          const fmt = String(b?.format || "p");
          const t = String(b?.content ?? "")
            .trim()
            .replace(/\s+/g, " ")
            .slice(0, 240);
          out.push(`[${id}] text(${fmt}) ${pos(b)}: ${t || "(empty)"}`);
          continue;
        }
        if (kind === "list") {
          const listType = String(b?.listType || "bulleted");
          const items = Array.isArray(b?.items) ? b.items : [];
          const preview = items
            .slice(0, 5)
            .map((it: any, idx: number) => {
              const body = String(it?.text ?? "").trim().slice(0, 60);
              if (listType === "todo") return `${idx + 1}. [${it?.checked ? "x" : " "}] ${body}`;
              return `${idx + 1}. ${body}`;
            })
            .join(" | ");
          out.push(`[${id}] list(${listType}) ${pos(b)}: items=${items.length}${preview ? `, ${preview}` : ""}`);
          continue;
        }
        if (kind === "sheet") {
          const t = String(b?.content ?? "")
            .trim()
            .replace(/\s+/g, " ")
            .slice(0, 220);
          out.push(`[${id}] sheet ${pos(b)}: ${t || "(empty)"}`);
          continue;
        }
        if (kind === "spreadsheet") {
          const sheet = b?.sheet || {};
          const rows = Number(sheet?.rows) || 0;
          const cols = Number(sheet?.cols) || 0;
          const cells = sheet?.cells && typeof sheet.cells === "object" ? sheet.cells : {};
          const nonEmpty = Object.keys(cells).filter((k) => String(cells[k] ?? "").trim().length > 0);
          const preview = nonEmpty
            .slice(0, 6)
            .map((k) => `${k}="${String(cells[k]).slice(0, 40)}"`)
            .join(", ");
          out.push(`[${id}] spreadsheet ${pos(b)}: ${rows}x${cols}, filled=${nonEmpty.length}${preview ? `, ${preview}` : ""}`);
          continue;
        }
        if (kind === "design") {
          const board = b?.board;
          const nodes = Array.isArray(board?.elements) ? board.elements.length : null;
          out.push(`[${id}] design ${pos(b)}: ${nodes != null ? `${nodes} items` : "(board)"}`);
          continue;
        }
        if (kind === "image") {
          out.push(`[${id}] image ${pos(b)}: ${String(b?.src || "").slice(0, 80)}`);
          continue;
        }
        if (kind === "youtube") {
          out.push(`[${id}] youtube ${pos(b)}: ${String(b?.url || "").slice(0, 80)}`);
          continue;
        }
        if (kind === "code") {
          const lang = String(b?.language || "plaintext");
          const t = String(b?.content ?? "")
            .trim()
            .replace(/\s+/g, " ")
            .slice(0, 200);
          out.push(`[${id}] code(${lang}) ${pos(b)}: ${t || "(empty)"}`);
          continue;
        }
        out.push(`[${id}] ${kind} ${pos(b)}`);
      }
      return out.join("\n");
    };

    const getSavedAnswer = (blockId: string, key: string): AiAnswerEntry | null => {
      const b: any = (useCanvasStore.getState().blocks as any)[blockId];
      const list: AiAnswerEntry[] = Array.isArray(b?.aiAnswers) ? b.aiAnswers : [];
      const k = String(key || "").trim();
      if (!k) return null;
      return list.find((x) => String(x?.q || "").trim() === k) || null;
    };

    const saveAnswer = (blockId: string, key: string, answer: string, panel?: { left: number; top: number }) => {
      const q = String(key || "").trim();
      const a = String(answer || "").trim();
      if (!blockId || !q || !a) return;
      const cur: any = (useCanvasStore.getState().blocks as any)[blockId];
      const prev: AiAnswerEntry[] = Array.isArray(cur?.aiAnswers) ? cur.aiAnswers : [];
      const nextPanel =
        panel && Number.isFinite(panel.left) && Number.isFinite(panel.top)
          ? { left: Math.max(0, Math.floor(panel.left)), top: Math.max(0, Math.floor(panel.top)) }
          : undefined;
      const entry: AiAnswerEntry = { q, a, ts: Date.now(), ...(nextPanel ? { panel: nextPanel } : null) };
      const next = prev.filter((x) => String(x?.q || "").trim() !== q).concat([entry]).slice(-50);
      updateBlock(blockId as any, { aiAnswers: next } as any);
    };

    const openPanel = (args: { blockId: string; key: string; answer: string; panel?: { left: number; top: number }; anchorRect: DOMRect | null }) => {
      const vw = window.innerWidth || 0;
      const vh = window.innerHeight || 0;
      const APPROX_H = 140;
      const minW = 220;
      const gap = 12;

      const w = aiPanelSizeRef.current?.w ?? 360;
      const h = aiPanelSizeRef.current?.h ?? APPROX_H;
      const rect = args.anchorRect;

      const clampLeft = (x: number) => Math.max(18, Math.min(vw - w - 18, Math.floor(x)));
      const clampTop = (y: number) => Math.max(40, Math.min(vh - h - 18, Math.floor(y)));
      const overlapsAnchor = (left: number, top: number) => {
        if (!rect) return false;
        const right = left + w;
        const bottom = top + h;
        return !(right <= rect.left || left >= rect.right || bottom <= rect.top || top >= rect.bottom);
      };

      const pickNonOverlapping = (left0: number, top0: number) => {
        let left = clampLeft(left0);
        let top = clampTop(top0);
        if (!overlapsAnchor(left, top)) return { left, top };

        const candidates = [
          { left: rect ? rect.right + gap : left, top: rect ? rect.top : top }, // right
          { left: rect ? rect.left - w - gap : left, top: rect ? rect.top : top }, // left
          { left: rect ? rect.left : left, top: rect ? rect.bottom + gap : top }, // below
          { left: rect ? rect.left : left, top: rect ? rect.top - h - gap : top }, // above
        ];
        for (const c of candidates) {
          const cl = clampLeft(c.left);
          const ct = clampTop(c.top);
          if (!overlapsAnchor(cl, ct)) return { left: cl, top: ct };
        }
        return { left, top };
      };

      const saved = args.panel;
      if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
        const picked = pickNonOverlapping(saved.left, saved.top);
        const maxWidthPx = Math.max(minW, (vw ? vw - picked.left - 18 : 520));
        setAiPanel({
          open: true,
          left: picked.left,
          top: picked.top,
          question: args.key,
          answer: String(args.answer || "").trim(),
          fullAnswer: String(args.answer || "").trim(),
          loading: false,
          isTyping: false,
          blockId: args.blockId,
          widthBricks: 3,
          heightBricks: 1,
          maxWidthPx,
        });
        return;
      }

      const leftGuess = Math.max(12, Math.floor((rect?.right || 24) + gap));
      const topGuess = Math.max(12, Math.floor(rect?.top || 120));
      const picked = pickNonOverlapping(leftGuess, topGuess);
      const maxWidthPx = Math.max(minW, (vw ? vw - picked.left - 18 : 520));
      setAiPanel({
        open: true,
        left: picked.left,
        top: picked.top,
        question: args.key,
        answer: String(args.answer || "").trim(),
        fullAnswer: String(args.answer || "").trim(),
        loading: false,
        isTyping: false,
        blockId: args.blockId,
        widthBricks: 3,
        heightBricks: 1,
        maxWidthPx,
      });
    };

    const applyActions = (actions: any[], sourceBlockId: string, ctx?: { userLine?: string }) => {
      const list = Array.isArray(actions) ? actions : [];
      if (!list.length) return;
      const st = useCanvasStore.getState();
      const g = Math.max(1, Math.floor(st.gridSize || 24));
      const src: any = (st.blocks as any)[sourceBlockId];
      let x = snapToGrid(Number(src?.x) || 0, g);
      let y = snapToGrid((Number(src?.y) || 0) + (Number(src?.height) || g) + g, g);
      const userLine = String(ctx?.userLine || "").toLowerCase();
      const explicitCreateSpreadsheet =
        /\b(new|another)\b/.test(userLine) ||
        (/\b(create|make|add|build|generate)\b/.test(userLine) && /\b(spreadsheet|table)\b/.test(userLine));

      const makeListItem = (text: any, listType: string, checked?: any) => {
        const id = `li-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        const base: any = { id, text: String(text ?? "") };
        if (listType === "todo") base.checked = Boolean(checked);
        return base;
      };

      const resolveSpreadsheetTargetId = (raw: any) => {
        const explicit = raw?.blockId != null ? String(raw.blockId) : "";
        if (explicit) return explicit;
        const target = String(raw?.target || "").toLowerCase();
        const lastForBlock = aiLastCreatedByBlockRef.current.get(sourceBlockId)?.spreadsheetId;
        if ((target === "last" || target === "latest") && lastForBlock) return lastForBlock;
        if ((target === "last" || target === "latest") && lastAiSpreadsheetIdRef.current) return lastAiSpreadsheetIdRef.current;
        if (lastForBlock) return lastForBlock;
        if (lastAiSpreadsheetIdRef.current) return lastAiSpreadsheetIdRef.current;
        const any = (Array.isArray(st.blockOrder) ? st.blockOrder : []).find((id: any) => String((st.blocks as any)[id]?.type || "") === "spreadsheet");
        return any ? String(any) : null;
      };

      const applySpreadsheetUpdate = (targetId: string, raw: any) => {
        const curB: any = (st.blocks as any)[targetId];
        if (!curB || String(curB?.type || "") !== "spreadsheet") return;
        const curSheet = curB?.sheet || { version: 1, rows: 30, cols: 20, colWidths: Array.from({ length: 20 }, () => 96), cells: {} };
        const curRows = clamp(Number(curSheet?.rows) || 30, 1, 60);
        const curCols = clamp(Number(curSheet?.cols) || 20, 1, 30);
        const nextRows = clamp(Number(raw?.rows) || curRows, 1, 60);
        const nextCols = clamp(Number(raw?.cols) || curCols, 1, 30);
        const startRow = clamp(Number(raw?.startRow) || 0, 0, 59);
        const startCol = clamp(Number(raw?.startCol) || 0, 0, 29);

        const nextCells: Record<string, string> = { ...(curSheet?.cells || {}) };
        if (Array.isArray(raw?.cells2d)) {
          for (let r = 0; r < Math.min(nextRows - startRow, raw.cells2d.length); r += 1) {
            const rowArr = Array.isArray(raw.cells2d[r]) ? raw.cells2d[r] : [];
            for (let c = 0; c < Math.min(nextCols - startCol, rowArr.length); c += 1) {
              const v = rowArr[c];
              if (v == null) continue;
              const s = String(v);
              if (!s.trim().length) continue;
              nextCells[`${startRow + r},${startCol + c}`] = s;
            }
          }
        }
        if (raw?.cells && typeof raw.cells === "object") {
          for (const k of Object.keys(raw.cells)) {
            const v = raw.cells[k];
            if (v == null) continue;
            const s = String(v);
            if (!s.trim().length) continue;
            nextCells[String(k)] = s;
          }
        }
        const defaultColW = 96;
        const colWidths = Array.isArray(curSheet?.colWidths)
          ? curSheet.colWidths.slice(0, nextCols).concat(Array.from({ length: Math.max(0, nextCols - curSheet.colWidths.length) }, () => defaultColW))
          : Array.from({ length: nextCols }, () => defaultColW);

        st.updateBlock(targetId as any, { sheet: { version: 1, rows: nextRows, cols: nextCols, colWidths, cells: nextCells } } as any);
        lastAiSpreadsheetIdRef.current = String(targetId);
        aiLastCreatedByBlockRef.current.set(sourceBlockId, { spreadsheetId: String(targetId) });
      };

      for (const raw of list) {
        const type = String(raw?.type || "").trim().toLowerCase();
        if (!type) continue;

        if (type === "create_design_board") {
          const idNew = (st as any).addDesignBlockAt({ x, y }, {});
          y = snapToGrid(y + (Number((st.blocks as any)[idNew]?.height) || g) + g, g);
          continue;
        }

        if (type === "create_spreadsheet") {
          const lastForBlock = aiLastCreatedByBlockRef.current.get(sourceBlockId)?.spreadsheetId;
          if (lastForBlock && !explicitCreateSpreadsheet) {
            applySpreadsheetUpdate(String(lastForBlock), raw);
            continue;
          }
          const rows = clamp(Number(raw?.rows) || 30, 1, 60);
          const cols = clamp(Number(raw?.cols) || 20, 1, 30);
          const idNew = st.addSpreadsheetBlockAt({ x, y }, { rows, cols });

          const curB: any = (st.blocks as any)[idNew];
          const curSheet = curB?.sheet || { version: 1, rows, cols, colWidths: Array.from({ length: cols }, () => 96), cells: {} };
          const nextCells: Record<string, string> = { ...(curSheet.cells || {}) };

          const startRow = clamp(Number(raw?.startRow) || 0, 0, 59);
          const startCol = clamp(Number(raw?.startCol) || 0, 0, 29);

          if (raw?.cells && typeof raw.cells === "object") {
            for (const k of Object.keys(raw.cells)) nextCells[String(k)] = String(raw.cells[k] ?? "");
          }
          if (Array.isArray(raw?.cells2d)) {
            for (let r = 0; r < raw.cells2d.length; r += 1) {
              const rowArr = Array.isArray(raw.cells2d[r]) ? raw.cells2d[r] : [];
              for (let c = 0; c < rowArr.length; c += 1) {
                nextCells[`${startRow + r},${startCol + c}`] = String(rowArr[c] ?? "");
              }
            }
          }

          st.updateBlock(idNew as any, { sheet: { ...curSheet, rows, cols, cells: nextCells } } as any);
          lastAiSpreadsheetIdRef.current = String(idNew);
          aiLastCreatedByBlockRef.current.set(sourceBlockId, { spreadsheetId: String(idNew) });
          y = snapToGrid(y + (Number((st.blocks as any)[idNew]?.height) || g) + g, g);
          continue;
        }

        if (type === "update_spreadsheet") {
          const targetId = resolveSpreadsheetTargetId(raw);
          if (!targetId) continue;
          applySpreadsheetUpdate(String(targetId), raw);
          continue;
        }

        if (type === "create_list") {
          const listType = String(raw?.listType || "bulleted").toLowerCase();
          const lt = listType === "todo" ? "todo" : listType === "numbered" ? "numbered" : "bulleted";
          const idNew = st.addListBlockAt({ x, y }, { listType: lt, width: g });
          const itemsIn = Array.isArray(raw?.items) ? raw.items : [];
          const items = itemsIn.length
            ? itemsIn.map((it: any) => (typeof it === "string" ? makeListItem(it, lt, false) : makeListItem(it?.text, lt, it?.checked)))
            : [makeListItem("", lt, false)];
          st.updateBlock(idNew as any, { listType: lt, items } as any);
          const firstId = items[0]?.id;
          y = snapToGrid(y + (Number((st.blocks as any)[idNew]?.height) || g) + g, g);
          continue;
        }
      }
    };

    const runPrompt = async (args: { blockId: string; promptText: string; promptKey: string; anchorRect: DOMRect | null; editableText: string }) => {
      const blockId = String(args.blockId || "");
      const promptText = String(args.promptText || "").trim();
      if (!blockId || !promptText) return;
      if (Date.now() < (aiBackoffUntilRef.current || 0)) return;

      const st0 = useCanvasStore.getState();
      const existingThread = aiThreadByBlockRef.current.get(blockId) || null;
      const existingThreadKey = existingThread?.key != null ? String(existingThread.key) : null;

      const threadKey = existingThreadKey || `thread:${blockId}`;
      const thread = aiThreadByBlockRef.current.get(blockId) || { key: threadKey, messages: [] as Array<{ role: "user" | "assistant"; content: string }> };
      if (!thread.key) thread.key = threadKey;
      if (!Array.isArray(thread.messages)) thread.messages = [];
      if (existingThreadKey) thread.key = existingThreadKey;

      const lastMsg = thread.messages.length ? thread.messages[thread.messages.length - 1] : null;
      if (lastMsg && lastMsg.role === "user") lastMsg.content = promptText;
      else thread.messages.push({ role: "user", content: promptText });
      if (thread.messages.length > 20) thread.messages = thread.messages.slice(-20);
      aiThreadByBlockRef.current.set(blockId, thread);

      const canvas = summarizeBlocksForAI(36);
      const curBlock: any = (st0.blocks as any)[blockId];
      const blockBody = String(curBlock?.content ?? args.editableText ?? "")
        .trim()
        .slice(0, 1600);
      const convo = thread.messages
        .slice(-10)
        .map((m) => `${String(m?.role || "user").toUpperCase()}: ${String(m?.content || "").trim()}`)
        .join("\n");

      const prompt = [
        "You are an assistant embedded in a block-based note canvas.",
        "You can read ALL blocks on screen and you may create/update blocks using the allowed actions below.",
        "",
        "Return ONLY a JSON object (no markdown, no extra text) shaped like:",
        '{ "shouldRespond": true|false, "assistant": "string", "actions": [ ... ] }',
        "",
        "Rules:",
        '- Default to helping: if the user is asking anything, requesting anything, or writing something that could benefit from an explanation/next step, set "shouldRespond": true.',
        '- If the user is explicit and direct (e.g., "create/make/add/open/build/generate …"), DO IT: set "shouldRespond": true and include the appropriate action(s). You may include 1-3 short follow-up questions AFTER executing the action to clarify next steps.',
        '- After you execute any action, ALWAYS ask exactly one short follow-up question. Order matters: execute the action first, then ask the question.',
        '- Only set "shouldRespond": false when it is clearly just personal note-taking or an incomplete fragment and a response would be annoying.',
        '- If you are unsure, set "shouldRespond": true with a short helpful clarification question.',
        '- IMPORTANT: respond ONLY to the LATEST user message (the last USER line in the conversation). Do NOT re-answer older questions unless the latest user message explicitly asks you to.',
        '- IMPORTANT: do NOT repeat or restate the user question/prompt. Answer directly (no "You asked...", no quoting the question).',
        "",
        "Supported actions (allowlist):",
        '- { "type": "create_spreadsheet", "rows": 30, "cols": 20, "cells2d": [["Header A","Header B"],["A2","B2"]] }',
        '- { "type": "create_spreadsheet", "rows": 30, "cols": 20, "cells": { "0,0": "Header" } }',
        '- { "type": "update_spreadsheet", "target": "active", "cells2d": [["Name","Amount"],["Rent","1200"]], "startRow": 0, "startCol": 0 }',
        '- { "type": "update_spreadsheet", "target": "last", "cells": { "0,0": "Header" } }',
        '- { "type": "create_design_board" }',
        '- { "type": "create_list", "listType": "todo", "items": [{ "text": "Task", "checked": false }] }',
        '- { "type": "create_list", "listType": "bulleted", "items": ["One","Two"] }',
        '- { "type": "create_list", "listType": "numbered", "items": ["First","Second"] }',
        "",
        'Important: If the user is giving follow-up details after creating a spreadsheet (e.g., dimensions or values), update the last spreadsheet using "update_spreadsheet" instead of creating a new one. Only create a new spreadsheet when the user explicitly asks for a new/another spreadsheet.',
        "",
        "Canvas blocks:",
        canvas || "(none)",
        "",
        "User's current text block:",
        blockBody || "(empty)",
        "",
        "Conversation so far (most relevant, newest last):",
        convo || "(none)",
        "",
        "Latest user message to answer (highest priority):",
        promptText || "(empty)",
      ].join("\n");

      try {
        const raw = await callAI(prompt);
        if (!raw) return;

        const parsedObj = extractFirstJsonObject(raw);
        const parsed: any = parsedObj || {};
        const actions = Array.isArray(parsed?.actions) ? parsed.actions : [];
        const assistant = parsedObj ? String(parsed?.assistant ?? parsed?.answer ?? "").trim() : String(raw ?? "").trim();
        const shouldRespond = Boolean(parsed?.shouldRespond) || actions.length > 0 || assistant.length > 0;
        if (!shouldRespond || (actions.length === 0 && assistant.length === 0)) return;

        let assistantText = dedupeAiAssistantText(stripQuestionRestatement(stripEchoedQuestionPrefix(assistant || "Done.", promptText)));
        if (actions.length && !assistantText.trim()) {
          assistantText = "What should I do next?";
        }
        if (assistantText.trim().length) {
          const lastA = thread.messages.length ? thread.messages[thread.messages.length - 1] : null;
          if (lastA && lastA.role === "assistant") lastA.content = assistantText;
          else thread.messages.push({ role: "assistant", content: assistantText });
          if (thread.messages.length > 20) thread.messages = thread.messages.slice(-20);
          aiThreadByBlockRef.current.set(blockId, thread);
        }

        const qKey = String(args.promptKey || promptText).trim();
        const saved = getSavedAnswer(blockId, qKey);
        openPanel({ blockId, key: qKey, answer: "", panel: saved?.panel, anchorRect: args.anchorRect });
        setAiPanel((p) => {
          if (!p.open || p.blockId !== blockId) return p;
          const nextFull = String(assistantText || (actions.length ? "Done." : "")).trim();
          return { ...p, question: qKey, answer: "", fullAnswer: nextFull, loading: false, isTyping: true };
        });
        if (assistantText.trim().length) saveAnswer(blockId, qKey, assistantText);
        if (actions.length) {
          const actionKey = `${blockId}::${String(promptText || "").trim().toLowerCase()}`;
          const lastActionKey = aiLastActionKeyByBlockRef.current.get(blockId) || "";
          if (lastActionKey !== actionKey) {
            aiLastActionKeyByBlockRef.current.set(blockId, actionKey);
            applyActions(actions, blockId, { userLine: promptText });
          }
        }
      } catch (err: any) {
        const msg = String(err?.message || err || "");
        if (/429|quota|rate/i.test(msg)) aiBackoffUntilRef.current = Date.now() + 60_000;
        const qKey = String(args.promptKey || promptText).trim();
        openPanel({ blockId, key: qKey, answer: "", anchorRect: args.anchorRect });
        setAiPanel((p) => {
          if (!p.open || p.blockId !== blockId) return p;
          return { ...p, question: qKey, answer: "", fullAnswer: "Sorry — I couldn't reach the AI right now.", loading: false, isTyping: true };
        });
      } finally {
        aiInFlightRef.current.delete(blockId);
        const queued = aiQueuedPromptRef.current.get(blockId);
        aiQueuedPromptRef.current.delete(blockId);
        const queuedPromptText = String(queued ?? "").trim();
        if (queuedPromptText && queuedPromptText !== String(aiLastUserLineRef.current.get(blockId) || "")) {
          const follow = window.setTimeout(() => {
            if (aiInFlightRef.current.has(blockId)) return;
            aiInFlightRef.current.add(blockId);
            aiLastUserLineRef.current.set(blockId, queuedPromptText);
            runPrompt({ blockId, promptText: queuedPromptText, promptKey: queuedPromptText, anchorRect: null, editableText: args.editableText });
          }, 650);
          aiAnswerTimersRef.current.set(blockId, follow);
        }
      }
    };

    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setAiPanel((p) => (p.open ? { ...p, open: false } : p));
    };

    const onInputCapture = (e: Event) => {
      const t = e.target as Element | null;
      if (!t) return;
      const canvasRoot = t.closest?.("[data-omnia-canvas]");
      if (!canvasRoot) return;
      const editable = t.closest?.("[contenteditable='true']") as HTMLElement | null;
      if (!editable) return;
      if (Date.now() < (aiBackoffUntilRef.current || 0)) return;

      const rawListKey = editable.getAttribute("data-canvas-list-item-editor-id");
      const blockId =
        editable.getAttribute("data-canvas-text-editor-id") ||
        editable.getAttribute("data-canvas-code-editor-id") ||
        editable.getAttribute("data-canvas-sheet-root-id") ||
        (rawListKey ? String(rawListKey).split(":")[0] : null) ||
        null;
      if (!blockId) return;

      const text = normalizeNewlines(String(editable.textContent ?? ""));
      const caret = getCaretOffsetInElement(editable);

      const caretLine = (() => {
        const { line } = getLineAtWithRange(text, caret);
        return String(line || "").trim();
      })();

      const latestNonEmptyLine = (() => {
        const lines = normalizeNewlines(text ?? "").split("\n");
        for (let i = lines.length - 1; i >= 0; i -= 1) {
          const tt = String(lines[i] ?? "").trim();
          if (tt) return tt;
        }
        return "";
      })();

      const canonicalMsg = (line: string) => normalizeAiPromptLine(extractFocusFromUserLine(line)).trim();
      const caretMsg = canonicalMsg(caretLine);
      const latestMsg = canonicalMsg(latestNonEmptyLine);

      const prevTimer = aiAnswerTimersRef.current.get(String(blockId));
      if (prevTimer) window.clearTimeout(prevTimer);
      aiAnswerTimersRef.current.delete(String(blockId));

      const lastSent = String(aiLastUserLineRef.current.get(String(blockId)) || "");
      let promptText = caretMsg;
      if (!promptText) promptText = latestMsg;
      if (promptText === lastSent && latestMsg && latestMsg !== lastSent) promptText = latestMsg;
      if (promptText === lastSent && caretMsg && caretMsg !== lastSent) promptText = caretMsg;

      const baseLineRaw = promptText ? (promptText === caretMsg ? caretLine : latestNonEmptyLine) : latestNonEmptyLine || caretLine;
      const baseLine = extractFocusFromUserLine(baseLineRaw);
      const userLine = normalizeAiPromptLine(baseLine);
      promptText = String(promptText || userLine || "").trim();
      const promptKey = String(promptText || baseLine || baseLineRaw || caretLine || userLine || "").trim();
      if (!promptText) return;

      if (aiInFlightRef.current.has(String(blockId))) {
        aiQueuedPromptRef.current.set(String(blockId), promptText);
        return;
      }
      if (String(aiLastUserLineRef.current.get(String(blockId)) || "") === promptText) return;

      const tId = window.setTimeout(() => {
        aiInFlightRef.current.add(String(blockId));
        aiLastUserLineRef.current.set(String(blockId), promptText);
        const rect = (editable.closest?.("[data-canvas-block]") as HTMLElement | null)?.getBoundingClientRect?.() || editable.getBoundingClientRect?.();
        runPrompt({ blockId: String(blockId), promptText, promptKey, anchorRect: rect || null, editableText: text });
      }, 700);
      aiAnswerTimersRef.current.set(String(blockId), tId);
    };

    window.addEventListener("keydown", onEsc, { capture: true });
    window.addEventListener("input", onInputCapture, { capture: true });
    const onClickReplay = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!t) return;
      const canvasRoot = t.closest?.("[data-omnia-canvas]");
      if (!canvasRoot) return;
      const editable = t.closest?.("[contenteditable='true']") as HTMLElement | null;
      if (!editable) return;

      const rawListKey = editable.getAttribute("data-canvas-list-item-editor-id");
      const blockId =
        editable.getAttribute("data-canvas-text-editor-id") ||
        editable.getAttribute("data-canvas-code-editor-id") ||
        editable.getAttribute("data-canvas-sheet-root-id") ||
        (rawListKey ? String(rawListKey).split(":")[0] : null) ||
        null;
      if (!blockId) return;

      const text = String(editable.textContent ?? "");
      const caret = getCaretOffsetInElement(editable);
      const lineRaw = getLineAt(text, caret);
      const line = String(lineRaw || "").trim();
      if (!line) return;

      const saved = getSavedAnswer(String(blockId), line);
      if (!saved || !String(saved.a || "").trim()) return;

      const blockEl = editable.closest?.("[data-canvas-block]") as HTMLElement | null;
      const rect = blockEl?.getBoundingClientRect?.() || editable.getBoundingClientRect?.();
      openPanel({ blockId: String(blockId), key: line, answer: saved.a, panel: saved.panel, anchorRect: rect || null });
    };
    window.addEventListener("pointerup", onClickReplay, true);
    return () => {
      window.removeEventListener("keydown", onEsc, { capture: true } as any);
      window.removeEventListener("input", onInputCapture, { capture: true } as any);
      window.removeEventListener("pointerup", onClickReplay, true);
      for (const [, timer] of aiAnswerTimersRef.current.entries()) {
        try {
          window.clearTimeout(timer);
        } catch {
          // ignore
        }
      }
      aiAnswerTimersRef.current.clear();
      try {
        aiAbortRef.current?.abort();
      } catch {
        // ignore
      }
      aiAbortRef.current = null;
    };
  }, [liveAIMode, updateBlock]);

  const closeAiPanel = useMemo(() => {
    return () => {
      try {
        aiAbortRef.current?.abort();
      } catch {
        // ignore
      }
      aiAbortRef.current = null;
      setAiPanel((p) => {
        if (p.open && p.blockId && !p.loading) {
          const q = String(p.question || "").trim();
          const a = String(p.fullAnswer || p.answer || "").trim();
          if (q && a) {
            const cur: any = (useCanvasStore.getState().blocks as any)[p.blockId];
            const prev: AiAnswerEntry[] = Array.isArray(cur?.aiAnswers) ? cur.aiAnswers : [];
            const existing = prev.find((x) => String(x?.q || "").trim() === q) || null;
            const panel = { left: Math.max(0, Math.floor(p.left)), top: Math.max(0, Math.floor(p.top)) };
            const entry: AiAnswerEntry = { q, a, ts: existing?.ts || Date.now(), panel };
            const next = prev.filter((x) => String(x?.q || "").trim() !== q).concat([entry]).slice(-50);
            updateBlock(p.blockId as any, { aiAnswers: next } as any);
          }
        }
        return p.open
          ? {
              open: false,
              left: 24,
              top: 120,
              question: "",
              answer: "",
              fullAnswer: "",
              loading: false,
              isTyping: false,
              blockId: null,
              widthBricks: 3,
              heightBricks: 1,
              maxWidthPx: 520,
            }
          : p;
      });
    };
  }, [updateBlock]);

  // Click outside closes the bubble (old BrickEditor behavior).
  useEffect(() => {
    if (!aiPanel.open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      if (t?.closest?.("[data-ai-answer-panel]")) return;
      closeAiPanel();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [aiPanel.open, closeAiPanel]);

  // Measure bubble size + keep it within viewport while it grows/shrinks.
  useEffect(() => {
    if (!aiPanel.open) return;
    const measureAndClamp = () => {
      const el = aiAnswerPanelRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const w = Math.max(1, Math.floor(r.width));
      const h = Math.max(1, Math.floor(r.height));
      aiPanelSizeRef.current = { w, h };
      const vw = window.innerWidth || 0;
      const vh = window.innerHeight || 0;
      const clampedLeft = Math.max(18, Math.min(vw - w - 18, aiPanel.left));
      const clampedTop = Math.max(40, Math.min(vh - h - 18, aiPanel.top));
      if (clampedLeft !== aiPanel.left || clampedTop !== aiPanel.top) {
        setAiPanel((s) => (s.open ? { ...s, left: clampedLeft, top: clampedTop } : s));
      }
    };
    const raf = window.requestAnimationFrame(measureAndClamp);
    window.addEventListener("resize", measureAndClamp);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", measureAndClamp);
    };
  }, [aiPanel.open, aiPanel.answer, aiPanel.fullAnswer, aiPanel.loading, aiPanel.left, aiPanel.top]);

  // Auto-width: keep bubble tight to rendered text (grow + shrink).
  useEffect(() => {
    if (!aiPanel.open) return;
    const el = aiAnswerMeasureRef.current;
    if (!el) return;
    const extraPx = 2;
    const paddingPx = 36; // left 8 + right 28 (close button clearance)
    const toShow = String(aiPanel.loading ? "Thinking…" : aiPanel.answer || "");
    el.textContent = toShow;
    const measuredW = Math.max(0, Math.ceil(el.getBoundingClientRect().width || 0));
    const desiredPx = measuredW + paddingPx + extraPx;
    let desiredBricks = Math.max(2, Math.ceil(desiredPx / Math.max(1, gridSize)));
    const maxWidthPx = Number.isFinite(aiPanel.maxWidthPx) ? Math.max(220, Math.floor(aiPanel.maxWidthPx)) : Math.floor((window.innerWidth || 0) * 0.85);
    const maxBricks = Math.max(3, Math.floor(maxWidthPx / Math.max(1, gridSize)));
    desiredBricks = Math.min(desiredBricks, maxBricks);

    setAiPanel((s) => {
      if (!s.open) return s;
      const cur = Number.isFinite(s.widthBricks) ? Math.max(1, Math.floor(s.widthBricks)) : 1;
      if (desiredBricks !== cur) return { ...s, widthBricks: desiredBricks };
      return s;
    });
  }, [aiPanel.open, aiPanel.loading, aiPanel.answer, aiPanel.maxWidthPx, gridSize]);

  // Auto-height: snap AI response panel to brick rows on wrapped/new lines.
  useEffect(() => {
    if (!aiPanel.open) return;
    const contentEl = aiAnswerContentRef.current;
    if (!contentEl) return;
    const rawH = Math.max(1, Math.ceil(contentEl.scrollHeight || 0));
    const desiredBricks = Math.max(1, Math.ceil(rawH / Math.max(1, gridSize)));
    setAiPanel((s) => {
      if (!s.open) return s;
      const cur = Number.isFinite(s.heightBricks) ? Math.max(1, Math.floor(s.heightBricks)) : 1;
      if (cur !== desiredBricks) return { ...s, heightBricks: desiredBricks };
      return s;
    });
  }, [aiPanel.open, aiPanel.answer, aiPanel.loading, aiPanel.widthBricks, gridSize]);

  // Typewriter effect (old BrickEditor feel).
  useEffect(() => {
    if (!aiPanel.open) return;
    if (aiPanel.loading) return;
    if (!aiPanel.isTyping) return;

    const full = String(aiPanel.fullAnswer || "");
    const cur = String(aiPanel.answer || "");
    if (!full) {
      setAiPanel((s) => (s.open ? { ...s, isTyping: false } : s));
      return;
    }
    if (cur.length >= full.length) {
      setAiPanel((s) => (s.open ? { ...s, answer: s.fullAnswer || s.answer, isTyping: false } : s));
      return;
    }

    const nextChar = full.charAt(cur.length);
    const step = nextChar === "\n" ? 4 : 2;
    const delay = nextChar === "\n" ? 24 : /[.,!?]/.test(nextChar) ? 28 : 16;

    const t = window.setTimeout(() => {
      setAiPanel((s) => {
        if (!s.open || s.loading || !s.isTyping) return s;
        const full2 = String(s.fullAnswer || "");
        const cur2 = String(s.answer || "");
        const nextLen = Math.min(full2.length, cur2.length + step);
        const next = full2.slice(0, nextLen);
        const done = nextLen >= full2.length;
        return done ? { ...s, answer: full2, isTyping: false } : { ...s, answer: next };
      });
    }, delay);

    return () => window.clearTimeout(t);
  }, [aiPanel.open, aiPanel.loading, aiPanel.isTyping, aiPanel.answer, aiPanel.fullAnswer]);

  // Bubble drag (top strip).
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = aiPanelDragRef.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      const nextLeft = d.originLeft + dx;
      const nextTop = d.originTop + dy;
      const w = aiPanelSizeRef.current?.w ?? 360;
      const h = aiPanelSizeRef.current?.h ?? 140;
      const clampedLeft = Math.max(18, Math.min((window.innerWidth || 0) - w - 18, nextLeft));
      const clampedTop = Math.max(40, Math.min((window.innerHeight || 0) - h - 18, nextTop));
      setAiPanel((s) => (s.open ? { ...s, left: clampedLeft, top: clampedTop } : s));
    };
    const onUp = () => {
      aiPanelDragRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  return (
    <div
      ref={containerRef}
      data-omnia-canvas
      className="relative w-full h-full overflow-x-hidden overflow-y-auto bg-transparent"
      style={{ touchAction: "none" }}
      tabIndex={0}
      onPointerDownCapture={(e) => {
        if (e.button === 0) {
          const t = e.target as Element | null;
          const blockEl = t?.closest?.("[data-canvas-block]") as HTMLElement | null;
          const blockId = blockEl?.getAttribute?.("data-block-id");
          if (blockId) {
            const gid = getMoveGroupId(blockId);
            const ids = gid ? getMoveGroupMembers(gid) : [blockId];
            const snapshot = ids
              .map((id) => {
                const b: any = blocks[id];
                if (!b) return null;
                return { id, x: Number(b.x || 0), y: Number(b.y || 0) };
              })
              .filter(Boolean) as Array<{ id: string; x: number; y: number }>;
            const world = clientToWorld(e.clientX, e.clientY);
            groupDragRef.current = {
              active: snapshot.length > 0,
              moved: false,
              pointerId: e.pointerId,
              startWorldX: world.x,
              startWorldY: world.y,
              snapshot,
            };
          }
        }
        // Detect drag start from any block drag handle (without modifying block drag code).
        if (e.button !== 0) return;
        const t = e.target as Element | null;
        if (!t?.closest?.("[data-drag-handle]")) return;
        const blockEl = t.closest?.("[data-canvas-block]") as HTMLElement | null;
        const primaryId = blockEl?.getAttribute?.("data-block-id");
        if (!primaryId) return;

        dragDeleteRef.current = { active: true, pointerId: e.pointerId, primaryId, ids: [primaryId], touchStartAt: null };
        if (deleteZoneOpenRef.current) setDeleteZoneOpen(false);

        // After selection logic in the block runs, pick up the dragged group (multi-select).
        window.setTimeout(() => {
          const cur = dragDeleteRef.current;
          if (!cur.active || cur.primaryId !== primaryId) return;
          const st = useCanvasStore.getState();
          const sel = st.selectedIds || [];
          const ids = sel.includes(primaryId) && sel.length > 1 ? sel.slice() : [primaryId];
          cur.ids = ids;
        }, 0);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (shapePickerOpen) setShapePickerOpen(false);
        const shapeId = String(e.dataTransfer?.getData("omnia_shape") || "");
        if (shapeId) {
          const world = clientToWorld(e.clientX, e.clientY);
          createShapeBlockAt(world.x, world.y, shapeId);
          return;
        }
        const files = Array.from(e.dataTransfer?.files || []);
        if (files.length) {
          window.dispatchEvent(new CustomEvent("omnia_attach_files", { detail: { files, clientX: e.clientX, clientY: e.clientY } }));
          return;
        }
        const uri = String(e.dataTransfer?.getData("text/uri-list") || "");
        const plain = String(e.dataTransfer?.getData("text/plain") || "");
        const html = String(e.dataTransfer?.getData("text/html") || "");
        const candidates: string[] = [];
        for (const l of uri.split("\n")) {
          const v = String(l || "").trim();
          if (v && !v.startsWith("#")) candidates.push(v);
        }
        for (const m of plain.match(/https?:\/\/[^\s<>"')]+/gi) || []) candidates.push(String(m || "").trim());
        for (const m of html.match(/href=["']([^"']+)["']/gi) || []) {
          const v = String(m || "").replace(/^href=["']|["']$/gi, "").trim();
          if (v) candidates.push(v);
        }
        const unique = Array.from(new Set(candidates.filter(Boolean)));
        const chosen = unique.find((u) => !!extractYouTubeVideoId(u)) || unique[0];
        if (chosen) {
          window.dispatchEvent(new CustomEvent("omnia_attach_link", { detail: { url: chosen, clientX: e.clientX, clientY: e.clientY } }));
        }
      }}
      onPointerMove={(e) => {
        const el = containerRef.current;
        if (!el) return;
        lastPointerClientRef.current = { x: e.clientX, y: e.clientY };
        const t = e.target as Element | null;
        const overBlock = Boolean(t?.closest?.("[data-canvas-block]"));
        if (overBlock) {
          if (hoverCell) setHoverCell(null);
          return;
        }
        const rect = el.getBoundingClientRect();
        const localX = e.clientX - rect.left;
        const localY = e.clientY - rect.top;
        const worldX = (scrollPos.left || 0) + localX;
        const worldY = (scrollPos.top || 0) + localY;
        const sx = snapToGrid(worldX, gridSize);
        const sy = snapToGrid(worldY, gridSize);
        setHoverCell((prev) => (prev && prev.x === sx && prev.y === sy ? prev : { x: sx, y: sy }));
      }}
      onPointerLeave={() => setHoverCell(null)}
      onPointerDown={(e) => {
        const el = containerRef.current;
        if (!el) return;
        const t = e.target as Element | null;
        if (shapePickerOpen && !t?.closest?.("[data-shape-picker]")) setShapePickerOpen(false);
        if (t?.closest?.("[data-canvas-block]")) return;
        commitShapeCellEditorByKey();
        setTypingShapeCellKey(null);
        // Keep canvas focused so '/' works after clicking.
        el.focus();
        clearSelection();
        const rect = el.getBoundingClientRect();
        const localX = e.clientX - rect.left;
        const localY = e.clientY - rect.top;
        const worldX = (scrollPos.left || 0) + localX;
        const worldY = (scrollPos.top || 0) + localY;
        const sx = snapToGrid(worldX, gridSize);
        const sy = snapToGrid(worldY, gridSize);
        const key = cellKey(sx, sy);
        const target: PressTarget = { kind: "cell", key };
        if (e.shiftKey) {
          if (!shiftAnchor) {
            setActivatedGridCellKeys((prev) => withUnique(prev, key));
            setRaisedGridCellKeys((prev) => withUnique(prev, key));
            setShiftLinkedGridSelection(false);
            setShiftAnchor(target);
          } else {
            pairShiftTargets(shiftAnchor, target);
          }
        } else {
          // Preserve previously built multi-cell shapes; remove transient single-cell press
          // because typing should be represented by the brick itself (not a second grid layer).
          const persistedRanges = activatedGridRanges.filter((r) => rangeCellCount(r) > 1);
          const persistedKeys = activatedGridCellKeys.filter((k) => keyInRanges(k, persistedRanges));
          setActivatedGridCellKeys(persistedKeys);
          setRaisedGridCellKeys([]);
          setActivatedGridRanges(persistedRanges);
          setActivatedBrickIds([]);
          setRaisedBrickIds([]);
          setShiftLinkedGridSelection(false);
          setShiftAnchor(target);
        }
        if (!e.shiftKey) {
          const existingId = findBlockAtCell(sx, sy);
          const id = existingId || addTextBlockAt({ x: sx, y: sy }, { width: gridSize, height: gridSize, content: "", format: "plain" } as any);
          dropEmptyTypingBlockIfNeeded(id);
          // Typing should be visually neutral (no blue selection ring while editing).
          setActivatedBrickIds([]);
          setRaisedBrickIds([]);
          setTypingBlockId(id);
          focusBrickInputById(id);
        }
        if (!ENABLE_BRICK_LOGIC) return;
      }}
    >
      {isAiThinking && <div className="canvas-ai-thinking-overlay" aria-hidden="true" />}

      {aiPanel.open && (
        <div
          data-ai-answer-panel
          ref={aiAnswerPanelRef}
          className="fixed z-[10000]"
          style={{
            top: `${aiPanel.top}px`,
            left: `${aiPanel.left}px`,
            width: `${Math.max(3, Math.floor(aiPanel.widthBricks || 6)) * Math.max(1, gridSize)}px`,
            minHeight: `${Math.max(1, String(aiPanel.loading ? "Thinking…" : aiPanel.answer || "").split("\n").length) * Math.max(1, gridSize)}px`,
            maxWidth: `${Math.max(220, Math.floor(aiPanel.maxWidthPx || 520))}px`,
          }}
        >
          <div className="glass-text-card relative overflow-hidden group" onPointerDown={(e) => e.stopPropagation()}>
            {/* slight darkening so it's a touch darker than normal bricks */}
            <div className="pointer-events-none absolute inset-0" style={{ background: "rgba(0,0,0,0.035)" }} />

            {/* Drag strip (brick-style) */}
            <div
              className="absolute inset-x-0 top-0 h-3 z-30 cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity"
              onPointerDown={(e) => {
                e.stopPropagation();
                e.preventDefault();
                aiPanelDragRef.current = {
                  startX: e.clientX,
                  startY: e.clientY,
                  originLeft: aiPanel.left,
                  originTop: aiPanel.top,
                };
              }}
              title="Drag to move"
            />

            <button
              type="button"
              className="absolute right-1 top-1/2 -translate-y-1/2 z-40 h-6 w-6 rounded-full hover:bg-black/5 dark:hover:bg-white/10 text-black/70 dark:text-white/70 leading-none"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={closeAiPanel}
              title="Close"
            >
              ×
            </button>

            <div
              ref={aiAnswerContentRef}
              className="whitespace-pre-wrap text-foreground break-words"
              style={{
                fontFamily: defaultFontFamily,
                fontSize: `${aiFontSizePx}px`,
                lineHeight: `${aiLineHeightPx}px`,
                letterSpacing: defaultLetterSpacing,
                paddingLeft: "8px",
                paddingRight: "28px",
                paddingTop: `${aiPaddingY}px`,
                paddingBottom: `${aiPaddingY}px`,
                minHeight: `${Math.max(1, gridSize)}px`,
                wordBreak: "break-word",
                overflowWrap: "anywhere",
              }}
            >
              {String(aiPanel.loading ? "Thinking…" : aiPanel.answer || "")}
            </div>

            {/* offscreen measure node: keeps bubble width tight to text */}
            <div
              ref={aiAnswerMeasureRef}
              style={{
                position: "fixed",
                left: "-99999px",
                top: "-99999px",
                visibility: "hidden",
                pointerEvents: "none",
                whiteSpace: "pre-wrap",
                padding: "0px",
                fontFamily: defaultFontFamily,
                fontSize: `${aiFontSizePx}px`,
                lineHeight: `${aiLineHeightPx}px`,
                letterSpacing: defaultLetterSpacing,
                wordBreak: "break-word",
                overflowWrap: "anywhere",
              }}
            />
          </div>
        </div>
      )}
      {shapePickerOpen && (
        <div
          data-shape-picker
          className="fixed z-[120] rounded-2xl glass-control px-2 py-2 flex items-center gap-2"
          style={{
            left: `${shapePickerAnchor.clientX}px`,
            top: `${shapePickerAnchor.clientY + 12}px`,
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {[
            { id: "rectangle", label: "Rectangle" },
            { id: "line", label: "Line" },
            { id: "arrow", label: "Arrow" },
            { id: "ellipse", label: "Ellipse" },
            { id: "triangle", label: "Triangle" },
            { id: "diamond", label: "Diamond" },
            { id: "hexagon", label: "Hexagon" },
            { id: "star", label: "Star" },
          ].map((shape) => (
            <div
              key={shape.id}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData("omnia_shape", shape.id);
              }}
              onClick={() => {
                createShapeBlockAt(shapePickerAnchor.worldX, shapePickerAnchor.worldY, shape.id);
                setShapePickerOpen(false);
              }}
              className="h-7 w-7 rounded-md border border-white/40 bg-white/60 backdrop-blur-sm flex items-center justify-center text-black/70"
              title={shape.label}
            >
              {shape.id === "rectangle" && <div className="h-3 w-4 border border-black/70" />}
              {shape.id === "line" && <div className="h-px w-4 bg-black/70" />}
              {shape.id === "arrow" && (
                <div className="flex items-center gap-[2px]">
                  <div className="h-px w-3 bg-black/70" />
                  <div className="h-0 w-0 border-y-[3px] border-y-transparent border-l-[5px] border-l-black/70" />
                </div>
              )}
              {shape.id === "ellipse" && <div className="h-3 w-4 rounded-full border border-black/70" />}
              {shape.id === "triangle" && (
                <div
                  className="h-0 w-0"
                  style={{
                    borderLeft: "6px solid transparent",
                    borderRight: "6px solid transparent",
                    borderBottom: "10px solid rgba(0,0,0,0.7)",
                  }}
                />
              )}
              {shape.id === "diamond" && <div className="h-3 w-3 rotate-45 border border-black/70" />}
              {shape.id === "hexagon" && (
                <div
                  className="h-0 w-0"
                  style={{
                    borderLeft: "6px solid transparent",
                    borderRight: "6px solid transparent",
                    borderBottom: "4px solid rgba(0,0,0,0.7)",
                  }}
                />
              )}
              {shape.id === "star" && <div className="text-[10px] leading-none text-black/70">★</div>}
            </div>
          ))}
        </div>
      )}
      <div
        className="absolute left-0 top-0"
        style={{
          width: `${surface.width}px`,
          height: `${surface.height}px`,
        }}
      >
        {/* Canvas "walls" (left/right) */}
        <div
          className="absolute top-0 bottom-0 left-0 pointer-events-none"
          style={{
            width: "1px",
            background: "rgba(255,255,255,0.14)",
            boxShadow: "0 0 14px rgba(255,255,255,0.08)",
          }}
        />
        <div
          className="absolute top-0 bottom-0 pointer-events-none"
          style={{
            left: `${Math.max(0, surface.width - 1)}px`,
            width: "1px",
            background: "rgba(255,255,255,0.14)",
            boxShadow: "0 0 14px rgba(255,255,255,0.08)",
          }}
        />

        {deleteZoneOpen && (
          <div
            className="absolute z-50"
            style={{
              left: `${Math.max(0, surface.width - Math.min(160, Math.max(96, Math.floor((viewport.width || surface.width) * 0.2))))}px`,
              top: `${scrollPos.top}px`,
              width: `${Math.min(160, Math.max(96, Math.floor((viewport.width || surface.width) * 0.2)))}px`,
              height: `${viewport.height || 0}px`,
              pointerEvents: "none",
            }}
          >
            <div
              className="h-full w-full rounded-l-2xl border border-red-400/25 bg-red-500/12 backdrop-blur-2xl shadow-[0_0_30px_rgba(248,113,113,0.22)] flex items-center justify-center"
              style={{
                boxShadow:
                  "inset 0 0 0 1px rgba(248,113,113,0.18), inset 0 0 26px rgba(248,113,113,0.14), 0 0 30px rgba(248,113,113,0.18)",
              }}
            >
              <div className="flex flex-col items-center gap-2 text-center">
                <div className="w-12 h-12 rounded-full bg-red-500/18 border border-red-400/25 flex items-center justify-center">
                  <Trash2 className="w-5 h-5 text-red-200" />
                </div>
                <div className="text-xs font-semibold text-red-100/95">Drop to delete</div>
              </div>
            </div>
          </div>
        )}

        {/* Hover highlight: single brick under cursor (matches BrickEditor feel) */}
        {hoverCell && (
          <div
            className="absolute pointer-events-none"
            style={{
              left: `${hoverCell.x}px`,
              top: `${hoverCell.y}px`,
              width: `${gridSize}px`,
              height: `${gridSize}px`,
              background: "rgba(59, 130, 246, 0.10)",
              outline: "1px solid rgba(59, 130, 246, 0.22)",
              borderRadius: "4px",
            }}
          />
        )}
        {(() => {
          const activeKeys = activatedGridCellKeys
            .filter((k) => !raisedGridCellKeys.includes(k))
            .filter((k) => !keyInRanges(k, activatedGridRanges));
          const activeSet = new Set(activeKeys);
          const edgeStyle = (key: string, borderColor: string, shadow: string) => {
            const p = parseCellKey(key);
            const hasL = activeSet.has(cellKey(p.x - gridSize, p.y));
            const hasR = activeSet.has(cellKey(p.x + gridSize, p.y));
            const hasU = activeSet.has(cellKey(p.x, p.y - gridSize));
            const hasD = activeSet.has(cellKey(p.x, p.y + gridSize));
            const isEdge = !(hasL && hasR && hasU && hasD);
            return {
              borderLeft: hasL ? "none" : `1px solid ${borderColor}`,
              borderRight: hasR ? "none" : `1px solid ${borderColor}`,
              borderTop: hasU ? "none" : `1px solid ${borderColor}`,
              borderBottom: hasD ? "none" : `1px solid ${borderColor}`,
              boxShadow: isEdge ? shadow : "none",
            } as const;
          };
          return activeKeys.map((k) => {
            const p = parseCellKey(k);
            const edge = edgeStyle(k, "rgba(255,255,255,0.55)", "inset 0 1px 0 rgba(255,255,255,0.55), 0 6px 18px rgba(0,0,0,0.14)");
            return (
              <div
                key={`act-${k}`}
                className="absolute pointer-events-auto cursor-grab active:cursor-grabbing"
                onPointerDown={(e) => beginGridShapeDrag(e, { cellKey: k })}
                style={{
                  left: `${p.x}px`,
                  top: `${p.y}px`,
                  width: `${gridSize}px`,
                  height: `${gridSize}px`,
                  borderRadius: "0px",
                  background: "linear-gradient(145deg, rgba(255,255,255,0.62), rgba(255,255,255,0.34))",
                  backdropFilter: "blur(8px)",
                  zIndex: 5,
                  ...edge,
                }}
              />
            );
          });
        })()}
        {activatedGridRanges.map((range, idx) => {
          const rangeHasRaised = raisedGridCellKeys.some((k) => {
            const p = parseCellKey(k);
            return p.x >= range.minX && p.x <= range.maxX && p.y >= range.minY && p.y <= range.maxY;
          });
          return (
            <div
              key={`act-range-${idx}`}
              className="absolute pointer-events-auto cursor-grab active:cursor-grabbing"
              onPointerDown={(e) => beginGridShapeDrag(e, { rangeIndex: idx })}
              style={{
                left: `${range.minX}px`,
                top: `${range.minY}px`,
                width: `${range.maxX - range.minX + gridSize}px`,
                height: `${range.maxY - range.minY + gridSize}px`,
                borderRadius: "6px",
                border: rangeHasRaised ? "1px solid rgba(59,130,246,0.78)" : "none",
                background: "linear-gradient(145deg, rgba(255,255,255,0.62), rgba(255,255,255,0.34))",
                backdropFilter: "blur(8px)",
                transform: rangeHasRaised ? "translateY(-6px) scale(1.01)" : "translateY(0px) scale(1)",
                boxShadow: rangeHasRaised
                  ? "0 20px 36px rgba(0,0,0,0.30)"
                  : "inset 0 1px 0 rgba(255,255,255,0.55), 0 6px 18px rgba(0,0,0,0.14)",
                zIndex: rangeHasRaised ? 6 : 5,
              }}
            />
          );
        })}
        {raisedGridCellKeys.filter((k) => !keyInRanges(k, activatedGridRanges)).map((k) => {
          const raisedSet = new Set(raisedGridCellKeys);
          const isSingleRaisedCell = raisedGridCellKeys.length === 1 && activatedGridCellKeys.length <= 1;
          const p = parseCellKey(k);
          const hasL = raisedSet.has(cellKey(p.x - gridSize, p.y));
          const hasR = raisedSet.has(cellKey(p.x + gridSize, p.y));
          const hasU = raisedSet.has(cellKey(p.x, p.y - gridSize));
          const hasD = raisedSet.has(cellKey(p.x, p.y + gridSize));
          const isEdge = !(hasL && hasR && hasU && hasD);
          return (
            <div
              key={`raised-${k}`}
              className="absolute pointer-events-auto cursor-grab active:cursor-grabbing"
              onPointerDown={(e) => beginGridShapeDrag(e, { raisedKey: k })}
              style={{
                left: `${p.x}px`,
                top: `${p.y}px`,
                width: `${gridSize}px`,
                height: `${gridSize}px`,
                borderRadius: isSingleRaisedCell ? "4px" : "0px",
                background: isSingleRaisedCell
                  ? "linear-gradient(145deg, rgba(255,255,255,0.62), rgba(255,255,255,0.34))"
                  : "linear-gradient(145deg, rgba(255,255,255,0.50), rgba(255,255,255,0.28))",
                backdropFilter: "blur(8px)",
                transform: isSingleRaisedCell ? "translateY(-2px) scale(1)" : "translateY(-8px) scale(1.02)",
                borderLeft: isSingleRaisedCell ? "none" : hasL ? "none" : "1px solid rgba(59,130,246,0.78)",
                borderRight: isSingleRaisedCell ? "none" : hasR ? "none" : "1px solid rgba(59,130,246,0.78)",
                borderTop: isSingleRaisedCell ? "none" : hasU ? "none" : "1px solid rgba(59,130,246,0.78)",
                borderBottom: isSingleRaisedCell ? "none" : hasD ? "none" : "1px solid rgba(59,130,246,0.78)",
                boxShadow: isEdge
                  ? isSingleRaisedCell
                    ? "inset 0 1px 0 rgba(255,255,255,0.55), 0 10px 20px rgba(0,0,0,0.18)"
                    : "0 20px 36px rgba(0,0,0,0.30)"
                  : "none",
                zIndex: 6,
              }}
            />
          );
        })}
        {(() => {
          const keys = toUnique([...activatedGridCellKeys, ...activatedGridRanges.flatMap((r) => cellKeysForRange(r))]);
          return keys.map((k) => {
            const p = parseCellKey(k);
            const txt = String(shapeCellTextByKey[k] || "");
            const isTyping = typingShapeCellKey === k;
            return (
              <div
                key={`shape-text-${k}`}
                className="absolute"
                style={{
                  left: `${p.x}px`,
                  top: `${p.y}px`,
                  width: `${gridSize}px`,
                  height: `${gridSize}px`,
                  zIndex: 12,
                  pointerEvents: isTyping || txt ? "auto" : "none",
                }}
              >
                {isTyping ? (
                  <div
                    data-shape-cell-editor-key={k}
                    contentEditable
                    suppressContentEditableWarning
                    spellCheck={false}
                    className="h-full w-full outline-none text-foreground whitespace-pre"
                    style={{
                      fontFamily:
                        'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"',
                      fontSize: "12px",
                      fontWeight: 400,
                      lineHeight: "20px",
                      letterSpacing: "-0.01em",
                      color: "inherit",
                      paddingLeft: "2px",
                      paddingRight: "2px",
                      paddingTop: "2px",
                      paddingBottom: "2px",
                      margin: "0px",
                      minHeight: `${gridSize}px`,
                      overflow: "visible",
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                    onInput={(e) =>
                      setShapeCellTextByKey((prev) => {
                        const el = e.currentTarget as HTMLDivElement | null;
                        const nextText = String(el?.innerText || "").replace(/\r\n/g, "\n");
                        return {
                          ...prev,
                          [k]: nextText,
                        };
                      })
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.preventDefault();
                        setTypingShapeCellKey(null);
                      }
                    }}
                    onBlur={(e) => {
                      const el = e.currentTarget as HTMLDivElement | null;
                      const nextText = String(el?.innerText || "").replace(/\r\n/g, "\n");
                      setShapeCellTextByKey((prev) => ({
                        ...prev,
                        [k]: nextText,
                      }));
                      setTypingShapeCellKey(null);
                    }}
                  />
                ) : txt ? (
                  <div
                    className="h-full w-full text-foreground whitespace-pre"
                    style={{
                      fontFamily:
                        'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"',
                      fontSize: "12px",
                      fontWeight: 400,
                      lineHeight: "20px",
                      letterSpacing: "-0.01em",
                      paddingLeft: "2px",
                      paddingRight: "2px",
                      paddingTop: "2px",
                      paddingBottom: "2px",
                      overflow: "visible",
                    }}
                  >
                    {txt}
                  </div>
                ) : null}
              </div>
            );
          });
        })()}

        {/* Drop frame: mute canvas inside a canvas block while dragging */}
        {dropContainerId && blocks[dropContainerId] && (
          <div
            className="absolute pointer-events-none flex items-center justify-center text-[11px] text-black/60"
            style={{
              left: `${(blocks as any)[dropContainerId].x}px`,
              top: `${(blocks as any)[dropContainerId].y}px`,
              width: `${(blocks as any)[dropContainerId].width}px`,
              height: `${(blocks as any)[dropContainerId].height}px`,
              background: "rgba(0,0,0,0.08)",
              border: "1px solid rgba(255,255,255,0.35)",
              boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.12)",
              backdropFilter: "blur(6px)",
            }}
          >
            Drop item here
          </div>
        )}

        {visibleIds.map((id) => {
          const b = blocks[id];
          if (!b) return null;
          if ((b as any).type === "youtube" || ((b as any).type === "create" && (b as any).mode === "video")) {
            return <YouTubeBlock key={id} id={id} />;
          }
          return renderBrickShell(b as any, id, {
            isActivated: typingBlockId === id ? false : activatedBrickIds.includes(id),
            isRaised: typingBlockId === id ? false : raisedBrickIds.includes(id),
            isTyping: typingBlockId === id,
            onTypingChange: (bid, raw, meta) => {
              if (!(blocks as any)[bid]) return;
              const cur: any = (blocks as any)[bid];
              if (!cur) return;
              const data = cur?.data && typeof cur.data === "object" ? { ...cur.data } : {};
              const currentVariant = (String(data.textVariant || "body").toLowerCase() as "body" | "h2" | "h1") || "body";
              const currentListType =
                (String(data.listType || "none").toLowerCase() as "none" | "bullet" | "numbered" | "todo") || "none";
              const parsed = parseTextSlashVariant(raw, currentVariant, currentListType);
              const textValue = parsed.content;
              const nextVariant = parsed.variant;
              const nextListType = parsed.listType;
              const currentHeightRows = Math.max(1, Math.round(Number(cur.height || gridSize) / gridSize));
              const currentWidthCells = Math.max(1, Math.round(Number(cur.width || gridSize) / gridSize));
              // Bubble behavior: width follows longest typed line, even after Enter.
              const targetCells = getRequiredHorizontalCells(textValue, nextVariant);
              const neededCells = targetCells;
              const newWidth = Math.max(gridSize, neededCells * gridSize);
              const targetRows = Math.max(
                minRowsForVariant(nextVariant),
                getRequiredVerticalCells(textValue) * lineRowsForVariant(nextVariant)
              );
              const neededRows =
                meta?.isPaste
                  ? targetRows
                  : targetRows > currentHeightRows
                    ? Math.min(targetRows, currentHeightRows + 1)
                    : targetRows;
              const newHeight = Math.max(gridSize, neededRows * gridSize);
              updateBlock(
                bid as any,
                {
                  content: textValue,
                  width: newWidth,
                  height: newHeight,
                  data: { ...data, textVariant: nextVariant, listType: nextListType },
                } as any
              );
              if (parsed.consumed) syncBrickEditorText(bid, textValue);
            },
            onTypingKeyDown: (bid, e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setTypingBlockId(null);
                return;
              }
              if (e.key === "Enter") {
                // TextBlock-like behavior: plain Enter creates a new line in-place.
                // Keep vertical-jump available via Ctrl/Cmd+Enter.
                if (!(e.metaKey || e.ctrlKey)) return;
                e.preventDefault();
                const cur: any = blocks[bid];
                if (!cur) return;
                const nx = Math.floor(Number(cur.x || 0));
                const ny = Math.floor(Number(cur.y || 0)) + gridSize;
                const existing = findBlockAtCell(nx, ny);
                const nextId = existing || addTextBlockAt({ x: nx, y: ny }, { width: gridSize, height: gridSize, content: "", format: "plain" } as any);
                dropEmptyTypingBlockIfNeeded(nextId);
                setTypingBlockId(nextId);
                setActivatedBrickIds([]);
                setRaisedBrickIds([]);
                focusBrickInputById(nextId);
              }
              if (e.key === "Tab") {
                e.preventDefault();
                const nextId = ensureNextLinkedCellBlock(bid);
                if (!nextId) return;
                dropEmptyTypingBlockIfNeeded(nextId);
                setTypingBlockId(nextId);
                focusBrickInputById(nextId);
              }
            },
            onTypingBlur: (bid) => {
              const cur: any = blocks[bid];
              if (!cur) return;
              const txt = String(cur.content || "").trim();
              if (!txt) {
                dropEmptyTypingBlockIfNeeded(null);
                setTypingBlockId(null);
                setActivatedBrickIds([]);
                setRaisedBrickIds([]);
                return;
              }
              if (typingBlockId === bid) {
                setTypingBlockId(null);
                setActivatedBrickIds([]);
                setRaisedBrickIds([]);
              }
            },
            onPress: (bid, shiftKey, source) => {
              const target: PressTarget = { kind: "brick", key: bid };
              if (source !== "click") return;
              if (suppressBrickClickRef.current) return;
              commitShapeCellEditorByKey();
              setTypingShapeCellKey(null);
              if (shiftKey) {
                if (!shiftAnchor) {
                  setActivatedBrickIds((prev) => withUnique(prev, bid));
                  setShiftAnchor(target);
                } else {
                  pairShiftTargets(shiftAnchor, target);
                }
                return;
              }
              if (!hasPersistedGridShape()) {
                setActivatedGridCellKeys([]);
                setRaisedGridCellKeys([]);
                setActivatedGridRanges([]);
              }
              setShiftLinkedGridSelection(false);
              // Click = edit mode, no blue ring.
              setActivatedBrickIds([]);
              setRaisedBrickIds([]);
              dropEmptyTypingBlockIfNeeded(bid);
              setTypingBlockId(bid);
              focusBrickInputById(bid);
              setShiftAnchor(target);
            },
          });
        })}
      </div>
    </div>
  );
}

