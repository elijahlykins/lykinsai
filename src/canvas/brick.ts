import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Heading1, Heading2, Type, List, ListOrdered, ListChecks, ChevronRight, TextQuote, Image, Mic, MoreHorizontal, Minimize2, Maximize2, Table } from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";
import { getStructuredPasteFromEvent } from "@/lib/pasteFromClipboard";
import type { Block } from "@/canvas/types";

export const BRICK_BEHAVIOR = {
  // Single source of truth for main-canvas brick behavior.
  enableLogic: false,
  gridSize: 24,
  showHoverLabel: true,
} as const;

const MARKDOWN_TODO_LINE_RE = /^(\s*)([-*]\s+)?\[([ xX])\]\s+(.*)$/;
const GLYPH_TODO_LINE_RE = /^(\s*)((?:◻(?:\uFE0E|\uFE0F)?|◼(?:\uFE0E|\uFE0F)?|□|■|⬜|⬛|▢|▣|☐|☑))\s(.*)$/;

export type BrickShellModel = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  content: string;
  textVariant: "body" | "h2" | "h1";
  listType: "none" | "bullet" | "numbered" | "todo" | "toggle" | "quote";
  brickColor?: string;
  textColor?: string;
  isAiResponseBubble?: boolean;
  userResized?: boolean;
  brickScale?: number;
};

const COLUMN_GAP_PX = 32;

export function computeColumnCount(_widthPx: number, _content?: string): number {
  return 1;
}

export function getColumnCount(_shell: BrickShellModel): number {
  return 1;
}

export { COLUMN_GAP_PX };

export type ConnectionNodeSide = "top" | "right" | "bottom" | "left";

export type BrickShellRenderOptions = {
  isRaised?: boolean;
  isActivated?: boolean;
  onPress?: (id: string, shiftKey: boolean, source: "pointerdown" | "click") => void;
  onDoubleClick?: (id: string) => void;
  isTyping?: boolean;
  onTypingChange?: (id: string, value: string, meta?: { isPaste?: boolean }) => void;
  onTypingKeyDown?: (id: string, e: React.KeyboardEvent<HTMLDivElement>) => void;
  onTypingBlur?: (id: string) => void;
  enableWidthResize?: boolean;
  resizeGridSize?: number;
  resizeMinWidth?: number;
  resizeMaxWidth?: number;
  onResizeWidth?: (id: string, width: number) => void;
  onResizeHeight?: (id: string, height: number) => void;
  onCornerScale?: (id: string, scale: number, width: number, height: number) => void;
  canvasZoom?: number;
  extraContent?: React.ReactNode;
  onBrickMenu?: (id: string, rect: DOMRect) => void;
  onMinimize?: (id: string) => void;
  onConnectionDragStart?: (id: string, side: ConnectionNodeSide, e: React.PointerEvent<HTMLDivElement>) => void;
};

export function toBrickShellModel(block: Block | any): BrickShellModel {
  const b = (block || {}) as any;
  const data = b?.data && typeof b.data === "object" ? b.data : {};
  const label = String(data.name || data.title || b?.name || b?.id || "brick");
  const content = String(data.content ?? b?.content ?? "");
  const rawVariant = String(data.textVariant || "body").toLowerCase();
  const textVariant: "body" | "h2" | "h1" = rawVariant === "h1" ? "h1" : rawVariant === "h2" ? "h2" : "body";
  const rawListType = String(data.listType || "none").toLowerCase();
  const listType: "none" | "bullet" | "numbered" | "todo" | "toggle" | "quote" =
    rawListType === "bullet" ? "bullet" : rawListType === "numbered" ? "numbered" : rawListType === "todo" ? "todo" : rawListType === "toggle" ? "toggle" : rawListType === "quote" ? "quote" : "none";
  return {
    id: String(b?.id || ""),
    x: Number(b?.x || 0),
    y: Number(b?.y || 0),
    width: Math.max(1, Number(b?.width || BRICK_BEHAVIOR.gridSize)),
    height: Math.max(1, Number(b?.height || BRICK_BEHAVIOR.gridSize)),
    label,
    content,
    textVariant,
    listType,
    brickColor: data.brickColor || undefined,
    textColor: data.textColor || undefined,
    isAiResponseBubble: Boolean(data.aiResponseBubble),
    userResized: Boolean(data.userResized),
    brickScale: Number(data.brickScale || 1) || 1,
  };
}

export function canUseActiveBrickLogic() {
  return Boolean(BRICK_BEHAVIOR.enableLogic);
}

function BrickTextSurface(props: {
  shell: BrickShellModel;
  isTyping: boolean;
  onTypingChange?: (id: string, value: string, meta?: { isPaste?: boolean }) => void;
  onTypingKeyDown?: (id: string, e: React.KeyboardEvent<HTMLDivElement>) => void;
  onTypingBlur?: (id: string) => void;
}) {
  const { shell, isTyping, onTypingChange, onTypingKeyDown, onTypingBlur } = props;
  const updateBlock = useCanvasStore((s) => s.updateBlock);
  const pushHistory = useCanvasStore((s) => s.pushHistory);
  const blockData = useCanvasStore((s) => {
    const b = s.blocks[shell.id] as any;
    return b?.data && typeof b.data === "object" ? b.data : {};
  });
  const editorRef = useRef<HTMLDivElement | null>(null);
  const todoInputRefs = useRef<Record<number, HTMLInputElement | null>>({});
  const pendingTodoFocusIndexRef = useRef<number | null>(null);
  const wasTypingRef = useRef(false);
  const hadTodoLinesRef = useRef(false);
  const applyingSlashRef = useRef(false);
  const TODO_EMPTY = "[ ]";
  const TODO_FILLED = "[x]";
  const TODO_DISPLAY_EMPTY = "◻\uFE0E";
  const TODO_DISPLAY_FILLED = "◼\uFE0E";
  const [slashQuery, setSlashQuery] = useState("");
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [activeSlashIndex, setActiveSlashIndex] = useState(0);
  const [slashMenuRect, setSlashMenuRect] = useState<{ left: number; top: number } | null>(null);
  const scale = Math.max(0.5, Number(shell.brickScale || 1));
  const lineRows = shell.textVariant === "h1" ? 3 : shell.textVariant === "h2" ? 2 : 1;
  const lineHeightPx = BRICK_BEHAVIOR.gridSize * lineRows * scale;
  const fontSizePx = (shell.textVariant === "h1" ? 42 : shell.textVariant === "h2" ? 28 : 14) * scale;
  const fontWeight = shell.textVariant === "body" ? 400 : 500;
  const readSlashState = (text: string) => {
    const full = String(text || "");
    const lines = full.split("\n");
    const lastLine = lines[lines.length - 1] ?? "";
    // Match `/` at the start of the line or after a space
    const m = lastLine.match(/(^|(?<=\s))\/([^\n]*)$/);
    if (!m) return { open: false, query: "" };
    return { open: true, query: (m[2] || "").toLowerCase() };
  };
  const slashOptions = useMemo(
    () => [
      { id: "h1", command: "/h1", label: "Heading 1", hint: "3 bricks tall", section: "text" as const, icon: Heading1 },
      { id: "h2", command: "/h2", label: "Heading 2", hint: "2 bricks tall", section: "text" as const, icon: Heading2 },
      { id: "text", command: "/text", label: "Text", hint: "1 brick tall", section: "text" as const, icon: Type },
      { id: "bulleted-list", command: "/bulleted list", label: "Bulleted List", hint: "auto • on Enter", section: "text" as const, icon: List },
      { id: "numbered-list", command: "/numbered list", label: "Numbered List", hint: "auto 1. 2. on Enter", section: "text" as const, icon: ListOrdered },
      { id: "checklist", command: "/checklist", label: "Checklist", hint: "auto [ ] on Enter", section: "text" as const, icon: ListChecks },
      { id: "toggle-list", command: "/toggle list", label: "Toggle List", hint: "collapsible sections", section: "text" as const, icon: ChevronRight },
      { id: "quote", command: "/quote", label: "Callout Quote", hint: "| quote line", section: "text" as const, icon: TextQuote },
      { id: "table", command: "/table", label: "Table", hint: "rows and columns", section: "block" as const, icon: Table },
      { id: "media", command: "/media", label: "Media", hint: "image, video, embed", section: "block" as const, icon: Image },
      { id: "dictate", command: "/dictate", label: "Dictate", hint: "voice to text", section: "block" as const, icon: Mic },
    ],
    []
  );
  const filteredSlashOptions = useMemo(
    () =>
      slashOptions.filter((opt) => {
        if (!slashQuery) return true;
        return opt.command.slice(1).startsWith(slashQuery) || opt.label.toLowerCase().includes(slashQuery);
      }),
    [slashOptions, slashQuery]
  );
  useEffect(() => {
    setActiveSlashIndex(0);
  }, [slashQuery, showSlashMenu]);
  useEffect(() => {
    if (activeSlashIndex < filteredSlashOptions.length) return;
    setActiveSlashIndex(Math.max(0, filteredSlashOptions.length - 1));
  }, [activeSlashIndex, filteredSlashOptions.length]);

  useLayoutEffect(() => {
    if (!showSlashMenu || !filteredSlashOptions.length || !editorRef.current) {
      setSlashMenuRect(null);
      return;
    }
    const el = editorRef.current;
    const rect = el.getBoundingClientRect();
    setSlashMenuRect({ left: rect.left + 8, top: rect.bottom + 4 });
  }, [showSlashMenu, filteredSlashOptions.length]);

  const getEditorText = (el: HTMLDivElement | null) => {
    if (!el) return "";
    // innerText preserves line breaks; normalize contentEditable's doubled Enter newlines.
    const raw = String(el.innerText ?? el.textContent ?? "").replace(/\r\n/g, "\n");
    if (!/<(?:div|p|br)\b/i.test(el.innerHTML)) return raw;
    return raw.replace(/\n{2,}/g, (m) => "\n".repeat(Math.ceil(m.length / 2)));
  };
  const toDisplayTodoMarkers = (text: string) =>
    String(text || "")
      .split("\n")
      .map((line) => {
        if (/^\s*(?:[-*]\s+)?\[x\]\s*/i.test(line)) {
          return line.replace(/^(\s*)(?:[-*]\s+)?\[x\]\s*/i, `$1${TODO_DISPLAY_FILLED} `);
        }
        if (/^\s*(?:[-*]\s+)?\[\s?\]\s*/i.test(line)) {
          return line.replace(/^(\s*)(?:[-*]\s+)?\[\s?\]\s*/i, `$1${TODO_DISPLAY_EMPTY} `);
        }
        return line;
      })
      .join("\n");
  const toStorageTodoMarkers = (text: string) =>
    String(text || "")
      .split("\n")
      .map((line) => {
        if (/^\s*(?:◼(?:\uFE0E|\uFE0F)?|■|⬛|▣|☑)\s/.test(line)) {
          return line.replace(/^(\s*)(?:◼(?:\uFE0E|\uFE0F)?|■|⬛|▣|☑)\s/, `$1${TODO_FILLED} `);
        }
        if (/^\s*(?:◻(?:\uFE0E|\uFE0F)?|□|⬜|▢|☐)\s/.test(line)) {
          return line.replace(/^(\s*)(?:◻(?:\uFE0E|\uFE0F)?|□|⬜|▢|☐)\s/, `$1${TODO_EMPTY} `);
        }
        return line;
      })
      .join("\n");
  const parseTodoLine = (line: string) => {
    const markdown = String(line || "").match(MARKDOWN_TODO_LINE_RE);
    if (markdown) {
      return {
        kind: "markdown" as const,
        checked: String(markdown[3] || "").toLowerCase() === "x",
        leading: String(markdown[1] || ""),
        bullet: String(markdown[2] || ""),
        text: String(markdown[4] || ""),
      };
    }
    const glyph = String(line || "").match(GLYPH_TODO_LINE_RE);
    if (glyph) {
      return {
        kind: "glyph" as const,
        checked: /^\s*(?:◼(?:\uFE0E|\uFE0F)?|■|⬛|▣|☑)\s/.test(String(line || "")),
        leading: String(glyph[1] || ""),
        marker: String(glyph[2] || ""),
        text: String(glyph[3] || ""),
      };
    }
    return null;
  };
  const applyTodoToggleAtLine = (sourceText: string, lineIndex: number, nextChecked: boolean) => {
    const lines = String(sourceText || "").split("\n");
    const target = String(lines[lineIndex] || "");
    const parsed = parseTodoLine(target);
    if (!parsed) return sourceText;
    if (parsed.kind === "markdown") {
      lines[lineIndex] = `${parsed.leading}${parsed.bullet}[${nextChecked ? "x" : " "}] ${parsed.text}`;
    } else {
      const nextMarker = nextChecked ? TODO_FILLED : TODO_EMPTY;
      lines[lineIndex] = `${parsed.leading}${nextMarker} ${parsed.text}`;
    }
    return lines.join("\n");
  };
  const applyTodoTextAtLine = (sourceText: string, lineIndex: number, nextText: string) => {
    const lines = String(sourceText || "").split("\n");
    const target = String(lines[lineIndex] || "");
    const parsed = parseTodoLine(target);
    if (!parsed) return sourceText;
    const safeText = String(nextText || "").replace(/\n/g, " ");
    if (parsed.kind === "markdown") {
      lines[lineIndex] = `${parsed.leading}${parsed.bullet}[${parsed.checked ? "x" : " "}] ${safeText}`;
    } else {
      lines[lineIndex] = `${parsed.leading}${parsed.checked ? TODO_FILLED : TODO_EMPTY} ${safeText}`;
    }
    return lines.join("\n");
  };
  const insertTodoLineAfter = (sourceText: string, lineIndex: number) => {
    const lines = String(sourceText || "").split("\n");
    const target = String(lines[lineIndex] || "");
    const parsed = parseTodoLine(target);
    if (!parsed) return sourceText;
    const nextLine = parsed.kind === "markdown" ? `${parsed.leading}${parsed.bullet}[ ] ` : `${parsed.leading}${TODO_EMPTY} `;
    lines.splice(lineIndex + 1, 0, nextLine);
    return lines.join("\n");
  };
  const insertTextAtCursor = (text: string) => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  };
  const getAbsoluteOffset = (root: HTMLElement, targetNode: Node, targetOffset: number) => {
    let acc = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n = walker.nextNode();
    while (n) {
      const len = n.textContent?.length ?? 0;
      if (n === targetNode) return acc + Math.max(0, Math.min(targetOffset, len));
      acc += len;
      n = walker.nextNode();
    }
    return acc;
  };
  const getNodeOffsetAtAbsolute = (root: HTMLElement, absolute: number) => {
    let remaining = Math.max(0, absolute);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n = walker.nextNode();
    while (n) {
      const len = n.textContent?.length ?? 0;
      if (remaining <= len) return { node: n, offset: remaining };
      remaining -= len;
      n = walker.nextNode();
    }
    return { node: root, offset: 0 };
  };
  const setCaretAtAbsolute = (root: HTMLElement, absolute: number) => {
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    const point = getNodeOffsetAtAbsolute(root, absolute);
    range.setStart(point.node, point.offset);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  };
  const replaceTextByAbsoluteRange = (root: HTMLElement, startAbs: number, endAbs: number, replacement: string) => {
    const range = document.createRange();
    const startPoint = getNodeOffsetAtAbsolute(root, startAbs);
    const endPoint = getNodeOffsetAtAbsolute(root, Math.max(startAbs, endAbs));
    range.setStart(startPoint.node, startPoint.offset);
    range.setEnd(endPoint.node, endPoint.offset);
    range.deleteContents();
    const node = document.createTextNode(replacement);
    range.insertNode(node);
  };
  const tryToggleTodoAtPointer = (el: HTMLDivElement, e: React.PointerEvent<HTMLDivElement>) => {
    const sel = window.getSelection();
    let restoreAbs: number | null = null;
    if (sel && sel.rangeCount > 0) {
      const r = sel.getRangeAt(0);
      if (el.contains(r.endContainer)) {
        const pre = document.createRange();
        pre.selectNodeContents(el);
        pre.setEnd(r.endContainer, r.endOffset);
        restoreAbs = pre.toString().length;
      }
    }
    const native = e.nativeEvent as PointerEvent;
    const d: any = document;
    let absClick = -1;
    if (typeof d.caretRangeFromPoint === "function") {
      const r = d.caretRangeFromPoint(native.clientX, native.clientY);
      if (r) {
        const pre = document.createRange();
        pre.selectNodeContents(el);
        pre.setEnd(r.startContainer, r.startOffset);
        absClick = pre.toString().length;
      }
    } else if (typeof d.caretPositionFromPoint === "function") {
      const pos = d.caretPositionFromPoint(native.clientX, native.clientY);
      if (pos) absClick = getAbsoluteOffset(el, pos.offsetNode, Number(pos.offset || 0));
    }
    if (absClick < 0) return false;
    const text = getEditorText(el);
    const lineStart = Math.max(0, text.lastIndexOf("\n", Math.max(0, absClick - 1)) + 1);
    const lineEndIdx = text.indexOf("\n", absClick);
    const lineEnd = lineEndIdx === -1 ? text.length : lineEndIdx;
    const line = text.slice(lineStart, lineEnd);
    const glyph = line.match(GLYPH_TODO_LINE_RE);
    const markdown = line.match(MARKDOWN_TODO_LINE_RE);
    if (!glyph && !markdown) return false;
    e.preventDefault();
    if (glyph) {
      const markerStartAbs = lineStart + (glyph[1]?.length || 0);
      const markerEndAbs = markerStartAbs + (glyph[2]?.length || 1);
      if (absClick < markerStartAbs || absClick > markerEndAbs) return false;
      const isFilled = /^\s*(?:◼(?:\uFE0E|\uFE0F)?|■|⬛|▣|☑)\s/.test(line);
      const nextMarker = isFilled ? TODO_DISPLAY_EMPTY : TODO_DISPLAY_FILLED;
      replaceTextByAbsoluteRange(el, markerStartAbs, markerEndAbs, nextMarker);
      const nextText = toStorageTodoMarkers(getEditorText(el));
      onTypingChange?.(shell.id, nextText);
    } else if (markdown) {
      const nextText = applyTodoToggleAtLine(getEditorText(el), String(getEditorText(el)).slice(0, lineStart).split("\n").length - 1, !/^\s*(?:[-*]\s+)?\[x\]\s+/i.test(line));
      onTypingChange?.(shell.id, nextText);
    }
    if (restoreAbs != null) {
      const textNow = getEditorText(el);
      setCaretAtAbsolute(el, Math.min(textNow.length, Math.max(0, restoreAbs)));
    }
    return true;
  };
  const tryToggleCollapseAtPointer = (el: HTMLDivElement, e: React.PointerEvent<HTMLDivElement>) => {
    if (shell.listType !== "toggle") return false;
    const native = e.nativeEvent as PointerEvent;
    const d: any = document;
    let absClick = -1;
    if (typeof d.caretRangeFromPoint === "function") {
      const r = d.caretRangeFromPoint(native.clientX, native.clientY);
      if (r) {
        const pre = document.createRange();
        pre.selectNodeContents(el);
        pre.setEnd(r.startContainer, r.startOffset);
        absClick = pre.toString().length;
      }
    } else if (typeof d.caretPositionFromPoint === "function") {
      const pos = d.caretPositionFromPoint(native.clientX, native.clientY);
      if (pos) absClick = getAbsoluteOffset(el, pos.offsetNode, Number(pos.offset || 0));
    }
    if (absClick < 0) return false;
    const text = getEditorText(el);
    const allLines = text.split("\n");
    const lineStart = Math.max(0, text.lastIndexOf("\n", Math.max(0, absClick - 1)) + 1);
    const actualLineIdx = lineStart === 0 ? 0 : text.slice(0, lineStart - 1).split("\n").length;
    const line = allLines[actualLineIdx] || "";
    const match = line.match(/^(\s*)([▶▼])(?:\uFE0E|\uFE0F)?\s/);
    if (!match) return false;
    const markerStart = lineStart + (match[1]?.length || 0);
    const markerEnd = markerStart + 1;
    if (absClick < markerStart || absClick > markerEnd) return false;
    e.preventDefault();
    const isExpanded = match[2] === "▼";
    const headerText = line.replace(/^(\s*)[▶▼](?:\uFE0E|\uFE0F)?\s/, "").trim();
    const tc: Record<string, string> = { ...(blockData._tc || {}) };

    if (isExpanded) {
      // Collapsing: find indented child lines below and store them
      const childLines: string[] = [];
      for (let i = actualLineIdx + 1; i < allLines.length; i++) {
        if (/^\s+/.test(allLines[i]) && !/^[▶▼](?:\uFE0E|\uFE0F)?\s/.test(allLines[i].trim())) {
          childLines.push(allLines[i]);
        } else {
          break;
        }
      }
      if (childLines.length > 0) {
        tc[headerText] = childLines.join("\n");
        const newLines = [...allLines];
        newLines.splice(actualLineIdx + 1, childLines.length);
        newLines[actualLineIdx] = newLines[actualLineIdx].replace(/^(\s*)▼(?:\uFE0E|\uFE0F)?/, "$1▶\uFE0E");
        el.textContent = newLines.join("\n");
        pushHistory();
        const cur = useCanvasStore.getState().blocks[shell.id] as any;
        const curData = cur?.data && typeof cur.data === "object" ? { ...cur.data } : {};
        updateBlock(shell.id as any, { content: newLines.join("\n"), data: { ...curData, _tc: tc } } as any);
      } else {
        replaceTextByAbsoluteRange(el, markerStart, markerEnd, "▶\uFE0E");
        onTypingChange?.(shell.id, getEditorText(el));
      }
    } else {
      // Expanding: restore stored child lines
      const stored = tc[headerText];
      const newLines = [...allLines];
      newLines[actualLineIdx] = newLines[actualLineIdx].replace(/^(\s*)▶(?:\uFE0E|\uFE0F)?/, "$1▼\uFE0E");
      if (stored) {
        const restoredLines = stored.split("\n");
        newLines.splice(actualLineIdx + 1, 0, ...restoredLines);
        delete tc[headerText];
      }
      el.textContent = newLines.join("\n");
      pushHistory();
      const cur = useCanvasStore.getState().blocks[shell.id] as any;
      const curData = cur?.data && typeof cur.data === "object" ? { ...cur.data } : {};
      updateBlock(shell.id as any, { content: newLines.join("\n"), data: { ...curData, _tc: tc } } as any);
    }
    return true;
  };

  const justEnteredTyping = isTyping && !wasTypingRef.current;
  useLayoutEffect(() => {
    const next = String(shell.content ?? "");
    if (!isTyping) return;
    const el = editorRef.current;
    if (!el) return;
    if (document.activeElement === el && !justEnteredTyping) return;
    const display = shell.listType === "todo" ? toDisplayTodoMarkers(next) : next;
    if ((el.textContent ?? "") !== display) el.textContent = display;
  }, [shell.content, isTyping]);
  useEffect(() => {
    const next = String(shell.content ?? "");
    const state = readSlashState(next);
    setShowSlashMenu(state.open);
    setSlashQuery(state.query);
  }, [shell.content]);
  const lines = String(shell.content || "").split("\n");
  const parsedTodoLines = lines.map((line) => parseTodoLine(line));
  const hasTodoLines = parsedTodoLines.some(Boolean);
  const firstTodoIndex = parsedTodoLines.findIndex(Boolean);
  const shouldAutoFocusFirstTodo =
    hasTodoLines &&
    (pendingTodoFocusIndexRef.current != null || !hadTodoLinesRef.current || (!wasTypingRef.current && isTyping));
  useEffect(() => {
    if (!hasTodoLines) return;
    const enteringTyping = !wasTypingRef.current && isTyping;
    const becameChecklist = !hadTodoLinesRef.current && hasTodoLines;
    const shouldForceFocus = pendingTodoFocusIndexRef.current != null || enteringTyping || becameChecklist;
    const targetIndex =
      pendingTodoFocusIndexRef.current != null
        ? pendingTodoFocusIndexRef.current
        : shouldForceFocus
          ? firstTodoIndex
          : null;
    if (targetIndex == null || targetIndex < 0) return;
    const target = todoInputRefs.current[targetIndex];
    if (!target) return;
    const root = editorRef.current?.closest?.("[data-canvas-block]") as HTMLElement | null;
    const active = document.activeElement as HTMLElement | null;
    const alreadyFocusedInside = Boolean(active && root?.contains(active));
    const alreadyFocusedTarget = active === target;
    if (alreadyFocusedTarget) {
      pendingTodoFocusIndexRef.current = null;
      return;
    }
    if (alreadyFocusedInside && !shouldForceFocus) return;
    const shouldMoveCaretToEnd = pendingTodoFocusIndexRef.current != null;
    const t = window.requestAnimationFrame(() => {
      target.focus({ preventScroll: true });
      try {
        if (shouldMoveCaretToEnd) {
          const len = target.value.length;
          target.setSelectionRange(len, len);
        }
      } catch {
        // ignore selection failures
      }
      pendingTodoFocusIndexRef.current = null;
    });
    return () => window.cancelAnimationFrame(t);
  }, [hasTodoLines, isTyping, parsedTodoLines, shell.id]);
  useEffect(() => {
    wasTypingRef.current = isTyping;
  }, [isTyping]);
  useEffect(() => {
    hadTodoLinesRef.current = hasTodoLines;
  }, [hasTodoLines]);

  const aiMarkdownComponents = useMemo(() => ({
    h1: ({ children }: any) => React.createElement("h1", { className: "text-xl font-semibold mt-2 mb-1" }, children),
    h2: ({ children }: any) => React.createElement("h2", { className: "text-lg font-semibold mt-2 mb-1" }, children),
    h3: ({ children }: any) => React.createElement("h3", { className: "text-base font-semibold mt-1.5 mb-1" }, children),
    p: ({ children }: any) => React.createElement("p", { className: "my-1 whitespace-pre-wrap" }, children),
    ul: ({ children }: any) => React.createElement("ul", { className: "my-1 list-disc pl-5 space-y-0.5" }, children),
    ol: ({ children }: any) => React.createElement("ol", { className: "my-1 list-decimal pl-5 space-y-0.5" }, children),
    li: ({ children }: any) => React.createElement("li", { className: "leading-relaxed" }, children),
    strong: ({ children }: any) => React.createElement("strong", { className: "font-semibold" }, children),
    blockquote: ({ children }: any) => React.createElement("blockquote", { className: "border-l-2 border-black/20 pl-3 my-1 text-black/70 italic" }, children),
    code: ({ children, className }: any) => {
      const isBlock = className?.startsWith("language-");
      if (isBlock) return React.createElement("pre", { className: "rounded-lg bg-black/5 p-2 my-1 overflow-x-auto text-[0.85em]" }, React.createElement("code", null, children));
      return React.createElement("code", { className: "rounded bg-black/10 px-1 py-0.5 text-[0.85em]" }, children);
    },
    pre: ({ children }: any) => React.createElement(React.Fragment, null, children),
    table: ({ children }: any) => React.createElement("div", { className: "my-2 overflow-x-auto" }, React.createElement("table", { className: "w-full border-collapse text-xs" }, children)),
    thead: ({ children }: any) => React.createElement("thead", { className: "border-b border-black/20" }, children),
    tbody: ({ children }: any) => React.createElement("tbody", null, children),
    tr: ({ children }: any) => React.createElement("tr", { className: "border-b border-black/10" }, children),
    th: ({ children }: any) => React.createElement("th", { className: "text-left px-2 py-1 font-semibold" }, children),
    td: ({ children }: any) => React.createElement("td", { className: "px-2 py-1" }, children),
  }), []);

  if (hasTodoLines) {
    return React.createElement(
      "div",
      {
        className: "px-2 py-0 tracking-[-0.01em] text-black/80 whitespace-pre-wrap break-words select-text",
        style: {
          overflowWrap: "anywhere",
          fontSize: `${fontSizePx}px`,
          lineHeight: `${lineHeightPx}px`,
          fontWeight,
          userSelect: "text",
          WebkitUserSelect: "text",
        },
      },
      lines.map((line, index) => {
        const todo = parsedTodoLines[index];
        if (!todo) {
          return React.createElement(
            "div",
            { key: `line-${index}`, className: "whitespace-pre-wrap break-words" },
            line
          );
        }
        return React.createElement(
          "div",
          {
            key: `todo-${index}`,
            className: `flex items-start gap-2 ${todo.checked ? "brick-todo-done" : ""}`,
            style: { position: "relative", zIndex: 0 },
          },
          React.createElement("input", {
            type: "checkbox",
            className: "brick-todo-checkbox mt-[0.28rem] shrink-0",
            checked: Boolean(todo.checked),
            onPointerDown: (e: any) => {
              e.stopPropagation();
            },
            onClick: (e: any) => {
              e.stopPropagation();
            },
            onChange: (e: any) => {
              const next = applyTodoToggleAtLine(String(shell.content || ""), index, Boolean(e.currentTarget.checked));
              onTypingChange?.(shell.id, next);
            },
          }),
          React.createElement("input", {
            type: "text",
            value: todo.text,
            autoFocus: shouldAutoFocusFirstTodo && index === firstTodoIndex,
            ref: (el: HTMLInputElement | null) => {
              todoInputRefs.current[index] = el;
            },
            className: `flex-1 min-w-0 bg-transparent border-0 rounded-none outline-none shadow-none p-0 m-0 focus:outline-none focus:ring-0 focus:border-0 ${todo.checked ? "line-through" : ""}`,
            style: {
              WebkitAppearance: "none",
              MozAppearance: "none",
              appearance: "none",
              lineHeight: "inherit",
              letterSpacing: "inherit",
              font: "inherit",
              position: "relative",
              zIndex: 2,
            },
            onPointerDown: (e: any) => {
              e.stopPropagation();
            },
            onClick: (e: any) => {
              e.stopPropagation();
            },
            onChange: (e: any) => {
              const next = applyTodoTextAtLine(String(shell.content || ""), index, String(e.currentTarget.value || ""));
              onTypingChange?.(shell.id, next);
            },
            onKeyDown: (e: any) => {
              if (e.key === "Enter" && !(e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                const next = insertTodoLineAfter(String(shell.content || ""), index);
                pendingTodoFocusIndexRef.current = index + 1;
                onTypingChange?.(shell.id, next);
              }
            },
          })
        );
      })
    );
  }
  if (shell.isAiResponseBubble) {
    const isThinkingPlaceholder = !isTyping && /^AI is thinking/i.test(String(shell.content || "").trim());
    const aiBaseFontSize = 13 * scale;
    const aiLineHeight = 1.5;
    const aiFontStyle = {
      fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"',
      fontSize: `${aiBaseFontSize}px`,
      lineHeight: `${aiLineHeight}`,
      color: isThinkingPlaceholder ? "transparent" : "inherit",
      paddingLeft: "8px",
      paddingRight: "8px",
      paddingTop: "4px",
      paddingBottom: "4px",
      wordBreak: "break-word" as const,
      overflowWrap: "anywhere" as const,
    };
    if (isTyping) {
      return React.createElement(
        "div",
        { key: "ai-editing", className: "relative w-full min-h-full" },
        React.createElement("div", {
          ref: editorRef,
          tabIndex: 0,
          contentEditable: true,
          suppressContentEditableWarning: true,
          spellCheck: false,
          "data-canvas-brick-editor-id": shell.id,
          className: "w-full min-h-full outline-none text-foreground overflow-auto scrollbar-hide whitespace-pre-wrap",
          style: {
            ...aiFontStyle,
            userSelect: "text",
            WebkitUserSelect: "text",
          },
          onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => { e.stopPropagation(); },
          onClick: (e: React.MouseEvent<HTMLDivElement>) => { e.stopPropagation(); },
          onDoubleClick: (e: React.MouseEvent<HTMLDivElement>) => { e.stopPropagation(); },
          onInput: (e: React.FormEvent<HTMLDivElement>) => {
            const nextRaw = getEditorText(e.currentTarget);
            const nativeInput = e.nativeEvent as InputEvent | undefined;
            const isPaste = nativeInput?.inputType === "insertFromPaste";
            onTypingChange?.(shell.id, nextRaw, { isPaste });
          },
          onPaste: (e: React.ClipboardEvent<HTMLDivElement>) => {
            e.preventDefault();
            const txt = getStructuredPasteFromEvent(e);
            insertTextAtCursor(txt);
            const nextRaw = getEditorText(editorRef.current);
            onTypingChange?.(shell.id, nextRaw, { isPaste: true });
          },
          onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => {
            onTypingKeyDown?.(shell.id, e);
          },
          onBlur: (e: React.FocusEvent<HTMLDivElement>) => {
            const raw = getEditorText(e.currentTarget);
            onTypingChange?.(shell.id, raw);
            onTypingBlur?.(shell.id);
          },
        })
      );
    }
    return React.createElement(
      "div",
      { key: "ai-display", className: "relative w-full", style: { pointerEvents: "none" as const } },
      React.createElement(
        "div",
        {
          ref: editorRef,
          "data-canvas-brick-editor-id": shell.id,
          className: `w-full outline-none text-foreground ${isThinkingPlaceholder ? "overflow-hidden" : "overflow-auto scrollbar-hide"}`,
          style: { ...aiFontStyle, pointerEvents: "auto" as const, userSelect: "none" as const, WebkitUserSelect: "none" as const },
        },
        React.createElement(ReactMarkdown as any, { remarkPlugins: [remarkGfm], components: aiMarkdownComponents }, String(shell.content || ""))
      )
    );
  }

  if (!isTyping) {
    const contentStr = String(shell.content || "");
    const hasMarkdown = /(?:^|\n)\s*#{1,6}\s|(?:\*\*|__).+(?:\*\*|__)|```|^\s*[-*]\s/m.test(contentStr);
    return React.createElement(
      "div",
      {
        className: `px-2 py-0 tracking-[-0.01em] ${hasMarkdown ? "" : "whitespace-pre-wrap "}break-words select-text`,
        style: {
          overflowWrap: "anywhere",
          fontSize: `${fontSizePx}px`,
          lineHeight: hasMarkdown ? "1.5" : `${lineHeightPx}px`,
          fontWeight,
          color: shell.textColor || "rgba(0,0,0,0.80)",
          userSelect: "text",
          WebkitUserSelect: "text",
        },
      },
      hasMarkdown
        ? React.createElement(ReactMarkdown as any, { remarkPlugins: [remarkGfm], components: aiMarkdownComponents }, contentStr)
        : shell.content
    );
  }

  const applySlashCommand = (command: string) => {
    applyingSlashRef.current = true;
    const current = getEditorText(editorRef.current);
    const lines = String(current || "").split("\n");
    const lastLine = lines[lines.length - 1] ?? "";
    // Find the slash token (at start of line or after a space)
    const slashIdx = (() => {
      const m = lastLine.match(/(^|\s)(\/[^\n]*)$/);
      if (!m) return -1;
      return lastLine.length - (m[2] || "").length;
    })();
    const beforeSlash = slashIdx > 0 ? lastLine.slice(0, slashIdx) : "";
    const slashPart = slashIdx >= 0 ? lastLine.slice(slashIdx) : lastLine;
    const afterSlash = /^\/\s*\S+/.test(slashPart) ? slashPart.replace(/^\/\s*\S+\s*/i, "") : slashPart.replace(/^\/\s*/, "");
    const prefix = lines.length > 1 ? lines.slice(0, -1).join("\n") + "\n" : "";
    const rebuiltLine = beforeSlash ? beforeSlash + command + " " + afterSlash : command + " " + afterSlash;
    const newContent = (prefix + rebuiltLine).trim();
    onTypingChange?.(shell.id, newContent);
    setShowSlashMenu(false);
    setSlashQuery("");
    setActiveSlashIndex(0);
    requestAnimationFrame(() => {
      applyingSlashRef.current = false;
      editorRef.current?.focus();
    });
  };

  return React.createElement(
    "div",
    { className: "relative h-full w-full" },
    React.createElement("div", {
      ref: editorRef,
      tabIndex: 0,
      contentEditable: true,
      suppressContentEditableWarning: true,
      spellCheck: false,
      "data-canvas-brick-editor-id": shell.id,
      className: "h-full w-full outline-none text-foreground whitespace-pre-wrap",
      style: {
        fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"',
        fontSize: `${fontSizePx}px`,
        fontWeight,
        lineHeight: `${lineHeightPx}px`,
        letterSpacing: "-0.01em",
        color: "inherit",
        paddingLeft: "8px",
        paddingRight: "8px",
        paddingTop: "0px",
        paddingBottom: "0px",
        margin: "0px",
        minHeight: `${lineHeightPx}px`,
        wordBreak: "break-word",
        overflowWrap: "anywhere",
        userSelect: "text",
        WebkitUserSelect: "text",
      },
      onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
        e.stopPropagation();
        if (!editorRef.current) return;
        if (tryToggleCollapseAtPointer(editorRef.current, e)) return;
        tryToggleTodoAtPointer(editorRef.current, e);
      },
      onInput: (e: React.FormEvent<HTMLDivElement>) => {
        const nextRaw = getEditorText(e.currentTarget);
        const next = shell.listType === "todo" ? toStorageTodoMarkers(nextRaw) : nextRaw;
        const nativeInput = e.nativeEvent as InputEvent | undefined;
        const isPaste = nativeInput?.inputType === "insertFromPaste";
        onTypingChange?.(shell.id, next, { isPaste });
        const state = readSlashState(next);
        setShowSlashMenu(state.open);
        setSlashQuery(state.query);
        if (state.open && editorRef.current) {
          const rect = editorRef.current.getBoundingClientRect();
          setSlashMenuRect({ left: rect.left + 8, top: rect.bottom + 4 });
        } else if (!state.open) setSlashMenuRect(null);
      },
      onPaste: (e: React.ClipboardEvent<HTMLDivElement>) => {
        e.preventDefault();
        const txt = getStructuredPasteFromEvent(e);
        insertTextAtCursor(txt);
        const nextRaw = getEditorText(editorRef.current);
        const next = shell.listType === "todo" ? toStorageTodoMarkers(nextRaw) : nextRaw;
        onTypingChange?.(shell.id, next, { isPaste: true });
        const state = readSlashState(next);
        setShowSlashMenu(state.open);
        setSlashQuery(state.query);
      },
      onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === "/" && !showSlashMenu) {
          const current = getEditorText(editorRef.current);
          const state = readSlashState(current + "/");
          if (state.open && editorRef.current) {
            setShowSlashMenu(true);
            setSlashQuery(state.query);
            const rect = editorRef.current.getBoundingClientRect();
            setSlashMenuRect({ left: rect.left + 8, top: rect.bottom + 4 });
          }
        }
        if (showSlashMenu && filteredSlashOptions.length) {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActiveSlashIndex((prev) => (prev + 1) % filteredSlashOptions.length);
            return;
          }
          if (e.key === "ArrowUp") {
            e.preventDefault();
            setActiveSlashIndex((prev) => (prev - 1 + filteredSlashOptions.length) % filteredSlashOptions.length);
            return;
          }
          if (e.key === "Enter" || e.key === "Tab") {
            e.preventDefault();
            const option = filteredSlashOptions[Math.max(0, Math.min(activeSlashIndex, filteredSlashOptions.length - 1))];
            if (option) applySlashCommand(option.command);
            return;
          }
          if (e.key === "Escape") {
            e.preventDefault();
            setShowSlashMenu(false);
            setSlashQuery("");
            setActiveSlashIndex(0);
            return;
          }
        }
        if (e.key === "Enter" && !(e.metaKey || e.ctrlKey) && shell.listType !== "none" && shell.listType !== "quote") {
          e.preventDefault();
          const current = getEditorText(editorRef.current);
          const lines = String(current || "").split("\n");

          if (shell.listType === "toggle") {
            // Determine if cursor is on a toggle header or indented child
            const sel = window.getSelection();
            let cursorAbs = 0;
            if (sel && sel.rangeCount > 0 && editorRef.current) {
              const r = sel.getRangeAt(0);
              const pre = document.createRange();
              pre.selectNodeContents(editorRef.current);
              pre.setEnd(r.endContainer, r.endOffset);
              cursorAbs = pre.toString().length;
            }
            const textBefore = current.slice(0, cursorAbs);
            const currentLineIdx = textBefore.split("\n").length - 1;
            const currentLine = lines[currentLineIdx] || "";
            const isOnHeader = /^[▶▼](?:\uFE0E|\uFE0F)?\s/.test(currentLine);
            const isOnChild = /^\s+/.test(currentLine);
            const isExpandedHeader = /^▼(?:\uFE0E|\uFE0F)?\s/.test(currentLine);

            if (isOnHeader && isExpandedHeader) {
              insertTextAtCursor("\n  ");
            } else if (isOnChild) {
              insertTextAtCursor("\n  ");
            } else {
              insertTextAtCursor("\n▶\uFE0E ");
            }
            onTypingChange?.(shell.id, getEditorText(editorRef.current));
            return;
          }

          const nextMarker =
            shell.listType === "bullet"
              ? "• "
              : shell.listType === "todo"
                ? `${TODO_DISPLAY_EMPTY} `
                : (() => {
                        const currentLine = String(lines[lines.length - 1] || "");
                        const m = currentLine.match(/^\s*(\d+)\.\s/);
                        const nextNum = m ? Number(m[1]) + 1 : lines.filter((l) => /^\s*\d+\.\s/.test(l)).length + 1;
                        return `${Math.max(1, nextNum)}. `;
                      })();
          insertTextAtCursor(`\n${nextMarker}`);
          const nextRaw = getEditorText(editorRef.current);
          const next = shell.listType === "todo" ? toStorageTodoMarkers(nextRaw) : nextRaw;
          onTypingChange?.(shell.id, next);
          return;
        }
        onTypingKeyDown?.(shell.id, e);
      },
      onBlur: (e: React.FocusEvent<HTMLDivElement>) => {
        if (applyingSlashRef.current) return;
        const raw = getEditorText(e.currentTarget);
        const text = shell.listType === "todo" ? toStorageTodoMarkers(raw) : raw;
        onTypingChange?.(shell.id, text);
        setShowSlashMenu(false);
        onTypingBlur?.(shell.id);
      },
    }),
    (() => {
      const menuContent = (() => {
        const items: React.ReactNode[] = [];
        let lastSection = "";
        filteredSlashOptions.forEach((opt) => {
          if ((opt as any).section && (opt as any).section !== lastSection && lastSection !== "") {
            items.push(
              React.createElement("div", {
                key: `sep-${(opt as any).section}`,
                className: "my-1 border-t border-black/10",
              })
            );
          }
          lastSection = (opt as any).section || lastSection;
          items.push(
            React.createElement(
              "button",
              {
                key: opt.id,
                type: "button",
                className: `w-full text-left px-2 py-1 rounded text-[0.75rem] text-black/85 transition-colors flex items-center justify-between ${
                  filteredSlashOptions[activeSlashIndex]?.id === opt.id ? "bg-black/10" : "hover:bg-black/10"
                }`,
                onPointerDown: (e: any) => {
                  e.preventDefault();
                  e.stopPropagation();
                  applySlashCommand(opt.command);
                },
                onMouseEnter: () => {
                  const idx = filteredSlashOptions.findIndex((x) => x.id === opt.id);
                  if (idx >= 0) setActiveSlashIndex(idx);
                },
                onMouseDown: (e: any) => {
                  e.preventDefault();
                  e.stopPropagation();
                  applySlashCommand(opt.command);
                },
                onClick: (e: any) => {
                  e.preventDefault();
                  e.stopPropagation();
                  applySlashCommand(opt.command);
                },
              },
              React.createElement(
                "span",
                { className: "flex items-center gap-2" },
                React.createElement(opt.icon, { size: 14, className: "text-black/50 shrink-0" }),
                React.createElement("span", null, opt.label)
              ),
              React.createElement("span", { className: "text-[0.625rem] text-black/55 ml-2" }, opt.hint)
            )
          );
        });
        return items;
      })();
      const menuEl = React.createElement(
        "div",
        {
          className:
            "min-w-[180px] rounded-md border border-white/45 bg-[linear-gradient(145deg,rgba(255,255,255,0.95),rgba(245,247,255,0.90))] shadow-[0_10px_28px_rgba(0,0,0,0.20)] backdrop-blur-md z-[9999] p-1",
          onPointerDown: (e: any) => {
            e.preventDefault();
            e.stopPropagation();
          },
          style: slashMenuRect
            ? { position: "fixed" as const, left: slashMenuRect.left, top: slashMenuRect.top }
            : undefined,
        },
        menuContent
      );
      if (isTyping && showSlashMenu && filteredSlashOptions.length && slashMenuRect && typeof document !== "undefined") {
        return ReactDOM.createPortal(menuEl, document.body);
      }
      return null;
    })()
  );
}

export function renderBrickShell(block: Block | any, key: string, opts?: BrickShellRenderOptions) {
  const shell = toBrickShellModel(block);
  const isRaised = Boolean(opts?.isRaised);
  const isActivated = Boolean(opts?.isActivated);
  const isTyping = Boolean(opts?.isTyping);
  const handlePointerDown = (e: any) => opts?.onPress?.(shell.id, Boolean(e?.shiftKey), "pointerdown");
  const handleClick = (e: any) => opts?.onPress?.(shell.id, Boolean(e?.shiftKey), "click");
  const handleDoubleClick = (e: any) => { e.stopPropagation(); opts?.onDoubleClick?.(shell.id); };
  const canResizeWidth = Boolean(opts?.enableWidthResize && typeof opts?.onResizeWidth === "function");
  const startWidthResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!canResizeWidth) return;
    e.preventDefault();
    e.stopPropagation();
    const pointerId = e.pointerId;
    const startX = Number(e.clientX || 0);
    const startWidth = Math.max(1, Number(shell.width || BRICK_BEHAVIOR.gridSize));
    const grid = Math.max(1, Math.floor(Number(opts?.resizeGridSize || BRICK_BEHAVIOR.gridSize)));
    const minWidth = Math.max(grid, Math.floor(Number(opts?.resizeMinWidth || grid * 8)));
    const maxWidth = Math.max(minWidth, Math.floor(Number(opts?.resizeMaxWidth || grid * 60)));

    const z = Math.max(0.1, Number(opts?.canvasZoom) || 1);
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const deltaX = (Number(ev.clientX || 0) - startX) / z;
      const rawWidth = startWidth + deltaX;
      const snapped = Math.round(rawWidth / grid) * grid;
      const nextWidth = Math.max(minWidth, Math.min(maxWidth, snapped));
      opts?.onResizeWidth?.(shell.id, nextWidth);
    };
    const onEnd = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  };
  const canResizeHeight = Boolean(opts?.enableWidthResize && typeof opts?.onResizeHeight === "function");
  const startHeightResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!canResizeHeight) return;
    e.preventDefault();
    e.stopPropagation();
    const pointerId = e.pointerId;
    const startY = Number(e.clientY || 0);
    const shellEl = document.querySelector(`[data-brick-shell][data-block-id="${shell.id}"]`) as HTMLElement | null;
    const renderedH = shellEl?.offsetHeight ?? 0;
    const startHeight = Math.max(1, renderedH || Number(shell.height || BRICK_BEHAVIOR.gridSize));
    const grid = Math.max(1, Math.floor(Number(opts?.resizeGridSize || BRICK_BEHAVIOR.gridSize)));
    const minHeight = grid;
    const z = Math.max(0.1, Number(opts?.canvasZoom) || 1);
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const deltaY = (Number(ev.clientY || 0) - startY) / z;
      const rawHeight = startHeight + deltaY;
      const snapped = Math.round(rawHeight / grid) * grid;
      const nextHeight = Math.max(minHeight, snapped);
      opts?.onResizeHeight?.(shell.id, nextHeight);
    };
    const onEnd = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  };
  const canCornerScale = typeof opts?.onCornerScale === "function";
  const startCornerScale = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!canCornerScale) return;
    e.preventDefault();
    e.stopPropagation();
    const pointerId = e.pointerId;
    const startX = Number(e.clientX || 0);
    const startY = Number(e.clientY || 0);
    const startWidth = Math.max(1, Number(shell.width || BRICK_BEHAVIOR.gridSize));
    const startHeight = Math.max(1, Number(shell.height || BRICK_BEHAVIOR.gridSize));
    const currentScale = Math.max(0.25, Number(shell.brickScale || 1));
    const grid = Math.max(1, Math.floor(Number(opts?.resizeGridSize || BRICK_BEHAVIOR.gridSize)));
    const z = Math.max(0.1, Number(opts?.canvasZoom) || 1);
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const deltaX = (Number(ev.clientX || 0) - startX) / z;
      const deltaY = (Number(ev.clientY || 0) - startY) / z;
      const nextWidth = Math.max(grid * 4, Math.round((startWidth + deltaX) / grid) * grid);
      const nextHeight = Math.max(grid, Math.round((startHeight + deltaY) / grid) * grid);
      const widthRatio = nextWidth / startWidth;
      const nextScale = Math.max(0.5, Math.min(4, currentScale * widthRatio));
      opts?.onCornerScale?.(shell.id, nextScale, nextWidth, nextHeight);
    };
    const onEnd = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  };
  const labelEl = BRICK_BEHAVIOR.showHoverLabel
    ? React.createElement(
        "div",
        {
          className: "opacity-0 group-hover:opacity-100 transition-opacity text-[9px] text-black/65 px-1 py-0.5 truncate",
        },
        shell.label
      )
    : null;

  const useFlexHeight = Boolean(opts?.extraContent) || Boolean(shell.isAiResponseBubble);

  return React.createElement(
    "div",
    {
      key,
      "data-canvas-block": true,
      "data-block-id": shell.id,
      "data-brick-shell": true,
      className: "absolute group cursor-pointer select-none",
      onPointerDown: handlePointerDown,
      onClick: handleClick,
      onDoubleClick: handleDoubleClick,
      style: {
        left: `${shell.x}px`,
        top: `${shell.y}px`,
        width: `${shell.width}px`,
        ...(useFlexHeight
          ? { minHeight: `${shell.height}px`, height: "auto" }
          : { height: `${shell.height}px` }),
        ...(isRaised ? { zIndex: 40 } : {}),
        willChange: "transform",
      },
    },
    React.createElement(
      "div",
      {
        className:
          `w-full rounded border border-white/45 ${shell.brickColor ? "" : "bg-[linear-gradient(145deg,rgba(255,255,255,0.34),rgba(255,255,255,0.18))]"} backdrop-blur-[2px]${useFlexHeight ? " min-h-full" : " h-full"} relative overflow-hidden`,
        style: {
          transform: isRaised
            ? (shell.isAiResponseBubble ? "translateY(-8px)" : "translateY(-8px) scale(1.02)")
            : "translateY(0px)",
          boxShadow: isRaised
            ? "0 20px 36px rgba(0,0,0,0.30)"
            : isActivated
              ? "inset 0 1px 0 rgba(255,255,255,0.55), 0 6px 18px rgba(0,0,0,0.14)"
              : "0 2px 8px rgba(0,0,0,0.10)",
          borderColor: isRaised ? "rgba(59,130,246,0.78)" : isActivated ? "rgba(59,130,246,0.45)" : "rgba(255,255,255,0.45)",
          transition: "transform 150ms, box-shadow 150ms, border-color 150ms, background 150ms",
          paddingLeft: shell.listType === "quote" ? "6px" : undefined,
          ...(shell.brickColor ? { background: shell.brickColor } : {}),
          ...(shell.textColor ? { color: shell.textColor } : {}),
        },
      },
      shell.listType === "quote"
        ? React.createElement("div", {
            key: "quote-bar",
            className: "absolute top-0 left-0 bottom-0 pointer-events-none",
            style: {
              width: "3px",
              borderRadius: "2px",
              background: "rgba(0,0,0,0.35)",
            },
          })
        : null,
      React.createElement(BrickTextSurface, {
        shell,
        isTyping,
        onTypingChange: opts?.onTypingChange,
        onTypingKeyDown: opts?.onTypingKeyDown,
        onTypingBlur: opts?.onTypingBlur,
      }),
      opts?.extraContent || null,
      canResizeWidth
        ? React.createElement("div", {
            "data-resize-handle": true,
            className:
              "absolute top-0 right-0 h-full w-3 cursor-ew-resize rounded-r hover:bg-black/10 transition-colors z-20",
            title: "Drag to resize width",
            onPointerDown: startWidthResize,
            onClick: (e: any) => e.stopPropagation(),
          })
        : null,
      canResizeHeight
        ? React.createElement("div", {
            "data-resize-handle": true,
            className:
              "absolute bottom-0 left-0 w-full h-3 cursor-ns-resize rounded-b hover:bg-black/10 transition-colors z-20",
            title: "Drag to resize height",
            onPointerDown: startHeightResize,
            onClick: (e: any) => e.stopPropagation(),
          })
        : null,
      canCornerScale
        ? React.createElement("div", {
            key: "corner-resize-grip",
            "data-resize-handle": true,
            className: "absolute bottom-0 right-0 cursor-nwse-resize z-30 group-hover:opacity-100 opacity-40 transition-opacity flex items-center justify-center",
            style: { width: "20px", height: "20px" },
            onPointerDown: startCornerScale,
            onClick: (e: any) => e.stopPropagation(),
          }, React.createElement("svg", { viewBox: "0 0 16 16", width: "14", height: "14", style: { filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.2))" } },
            React.createElement("path", { d: "M14 14L6 14M14 14L14 6M14 14L8 8", stroke: "rgba(0,0,0,0.45)", strokeWidth: "2", fill: "none", strokeLinecap: "round" })
          ))
        : null,
      labelEl
    ),
    !isTyping && !isActivated && !isRaised
      ? React.createElement("div", {
          key: "brick-hover-hint",
          className: "brick-hover-hint absolute pointer-events-none opacity-0 z-50",
          style: {
            bottom: "calc(100% + 6px)",
            left: "50%",
            transform: "translateX(-50%)",
            background: "rgba(0,0,0,0.7)",
            color: "#fff",
            fontSize: "10px",
            fontWeight: 500,
            padding: "3px 8px",
            borderRadius: "6px",
            whiteSpace: "nowrap",
          },
        }, "Double click to focus")
      : null,
    shell.content.trim()
      ? React.createElement(
          "div",
          {
            key: "brick-toolbar",
            className: "absolute opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-0.5",
            style: {
              top: "2px",
              right: `calc(100% + 4px)`,
              transform: (shell.brickScale ?? 1) > 1 ? `scale(${shell.brickScale})` : undefined,
              transformOrigin: "top right",
            },
          },
          typeof opts?.onMinimize === "function"
            ? React.createElement(
                "button",
                {
                  key: "brick-minimize-btn",
                  className:
                    "flex items-center justify-center w-6 h-6 rounded-md hover:bg-black/8 dark:hover:bg-white/12",
                  title: "Minimize",
                  onClick: (e: any) => {
                    e.stopPropagation();
                    opts!.onMinimize!(shell.id);
                  },
                  onPointerDown: (e: any) => e.stopPropagation(),
                },
                React.createElement(Minimize2, { className: "w-3.5 h-3.5 text-black/50 dark:text-white/50" })
              )
            : null,
          React.createElement(
            "button",
            {
              key: "brick-menu-btn",
              className:
                "flex items-center justify-center w-6 h-6 rounded-md hover:bg-black/8 dark:hover:bg-white/12",
              title: "Options",
              onClick: (e: any) => {
                e.stopPropagation();
                const btn = e.currentTarget as HTMLElement;
                if (btn && opts?.onBrickMenu) opts.onBrickMenu(shell.id, btn.getBoundingClientRect());
              },
              onPointerDown: (e: any) => e.stopPropagation(),
            },
            React.createElement(MoreHorizontal, { className: "w-3.5 h-3.5 text-black/50 dark:text-white/50" })
          )
        )
      : null,
    typeof opts?.onConnectionDragStart === "function"
      ? renderConnectionNodes(shell.id, opts.onConnectionDragStart)
      : null
  );
}

export const CONNECTION_NODE_SIZE = 10;
export const CONNECTION_NODE_GAP = 8;

export function renderConnectionNodes(
  id: string,
  onDragStart: (id: string, side: ConnectionNodeSide, e: React.PointerEvent<HTMLDivElement>) => void
) {
  const nodeSize = CONNECTION_NODE_SIZE;
  const nodeGap = CONNECTION_NODE_GAP;
  const hitPad = nodeGap + 4;
  const hitW = nodeSize + hitPad;

  const sides: Array<{
    side: ConnectionNodeSide;
    hitStyle: React.CSSProperties;
    dotStyle: React.CSSProperties;
  }> = [
    {
      side: "top",
      hitStyle: { top: `-${nodeSize + nodeGap}px`, left: "50%", transform: "translateX(-50%)", width: `${hitW}px`, height: `${hitW}px`, paddingBottom: `${hitPad}px` },
      dotStyle: { width: `${nodeSize}px`, height: `${nodeSize}px` },
    },
    {
      side: "right",
      hitStyle: { top: "50%", right: `-${nodeSize + nodeGap}px`, transform: "translateY(-50%)", width: `${hitW}px`, height: `${hitW}px`, paddingLeft: `${hitPad}px` },
      dotStyle: { width: `${nodeSize}px`, height: `${nodeSize}px` },
    },
    {
      side: "bottom",
      hitStyle: { bottom: `-${nodeSize + nodeGap}px`, left: "50%", transform: "translateX(-50%)", width: `${hitW}px`, height: `${hitW}px`, paddingTop: `${hitPad}px` },
      dotStyle: { width: `${nodeSize}px`, height: `${nodeSize}px` },
    },
    {
      side: "left",
      hitStyle: { top: "50%", left: `-${nodeSize + nodeGap}px`, transform: "translateY(-50%)", width: `${hitW}px`, height: `${hitW}px`, paddingRight: `${hitPad}px` },
      dotStyle: { width: `${nodeSize}px`, height: `${nodeSize}px` },
    },
  ];

  return sides.map(({ side, hitStyle, dotStyle }) =>
    React.createElement(
      "div",
      {
        key: `conn-node-${side}`,
        "data-connection-node": side,
        className: "absolute opacity-0 group-hover:opacity-100 cursor-crosshair z-[35]",
        style: {
          ...hitStyle,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          transition: "opacity 0.15s",
        },
        onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
          e.stopPropagation();
          e.preventDefault();
          onDragStart(id, side, e);
        },
        onClick: (e: any) => e.stopPropagation(),
      },
      React.createElement("div", {
        className: "hover:scale-150",
        style: {
          ...dotStyle,
          borderRadius: "50%",
          background: "rgba(59,130,246,0.55)",
          border: "2px solid rgba(255,255,255,0.9)",
          boxShadow: "0 1px 4px rgba(0,0,0,0.25)",
          transition: "transform 0.15s, background 0.15s",
          pointerEvents: "none",
        },
      })
    )
  );
}
