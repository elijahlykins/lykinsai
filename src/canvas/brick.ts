import React, { useEffect, useMemo, useRef, useState } from "react";
import { Heading1, Heading2, Type, List, ListOrdered, ListChecks, ListCollapse, TextQuote, Table, Calendar, Image, MousePointerClick, Code, Mic, FileText, BarChart3, Kanban, ClipboardList, LayoutGrid, MoreHorizontal } from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";
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
};

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
  extraContent?: React.ReactNode;
  onBrickMenu?: (id: string, rect: DOMRect) => void;
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
  const lineRows = shell.textVariant === "h1" ? 3 : shell.textVariant === "h2" ? 2 : 1;
  const lineHeightPx = BRICK_BEHAVIOR.gridSize * lineRows;
  const fontSizePx = shell.textVariant === "h1" ? 42 : shell.textVariant === "h2" ? 28 : 14;
  const fontWeight = shell.textVariant === "body" ? 400 : 500;
  const readSlashState = (text: string) => {
    const trimmed = String(text || "").replace(/^\s+/, "");
    if (!/^\/[^\n]*$/.test(trimmed)) return { open: false, query: "" };
    return { open: true, query: trimmed.slice(1).toLowerCase() };
  };
  const slashOptions = useMemo(
    () => [
      { id: "h1", command: "/h1", label: "Heading 1", hint: "3 bricks tall", section: "text" as const, icon: Heading1 },
      { id: "h2", command: "/h2", label: "Heading 2", hint: "2 bricks tall", section: "text" as const, icon: Heading2 },
      { id: "text", command: "/text", label: "Text", hint: "1 brick tall", section: "text" as const, icon: Type },
      { id: "bulleted-list", command: "/bulleted list", label: "Bulleted List", hint: "auto • on Enter", section: "text" as const, icon: List },
      { id: "numbered-list", command: "/numbered list", label: "Numbered List", hint: "auto 1. 2. on Enter", section: "text" as const, icon: ListOrdered },
      { id: "checklist", command: "/checklist", label: "Checklist", hint: "auto [ ] on Enter", section: "text" as const, icon: ListChecks },
      { id: "toggle-list", command: "/toggle list", label: "Toggle List", hint: "collapsible ▶ items", section: "text" as const, icon: ListCollapse },
      { id: "quote", command: "/quote", label: "Callout Quote", hint: "| quote line", section: "text" as const, icon: TextQuote },
      { id: "code", command: "/code", label: "Code", hint: "code block", section: "block" as const, icon: Code },
      { id: "table", command: "/table", label: "Table", hint: "spreadsheet grid", section: "block" as const, icon: Table },
      { id: "calendar", command: "/calendar", label: "Calendar", hint: "mini calendar", section: "block" as const, icon: Calendar },
      { id: "media", command: "/media", label: "Media", hint: "image, video, embed", section: "block" as const, icon: Image },
      { id: "button", command: "/button", label: "Button", hint: "action button", section: "block" as const, icon: MousePointerClick },
      { id: "dictate", command: "/dictate", label: "Dictate", hint: "voice to text", section: "block" as const, icon: Mic },
      { id: "page", command: "/page", label: "Page", hint: "full document editor", section: "block" as const, icon: FileText },
      { id: "chart", command: "/chart", label: "Chart", hint: "bar, line, area, pie", section: "block" as const, icon: BarChart3 },
      { id: "board", command: "/board", label: "Board", hint: "kanban columns", section: "block" as const, icon: Kanban },
      { id: "form", command: "/form", label: "Form", hint: "form builder", section: "block" as const, icon: ClipboardList },
      { id: "gallery", command: "/gallery", label: "Gallery", hint: "card grid view", section: "block" as const, icon: LayoutGrid },
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
        if (/^\s*(?:[-*]\s+)?\[x\]\s+/i.test(line)) {
          return line.replace(/^(\s*)(?:[-*]\s+)?\[x\]\s+/i, `$1${TODO_DISPLAY_FILLED} `);
        }
        if (/^\s*(?:[-*]\s+)?\[\s?\]\s+/i.test(line)) {
          return line.replace(/^(\s*)(?:[-*]\s+)?\[\s?\]\s+/i, `$1${TODO_DISPLAY_EMPTY} `);
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
    const match = line.match(/^(\s*)([▶▼])\s/);
    if (!match) return false;
    const markerStart = lineStart + (match[1]?.length || 0);
    const markerEnd = markerStart + 1;
    if (absClick < markerStart || absClick > markerEnd) return false;
    e.preventDefault();
    const isExpanded = match[2] === "▼";
    const headerText = line.replace(/^(\s*)[▶▼]\s/, "").trim();
    const tc: Record<string, string> = { ...(blockData._tc || {}) };

    if (isExpanded) {
      // Collapsing: find indented child lines below and store them
      const childLines: string[] = [];
      for (let i = actualLineIdx + 1; i < allLines.length; i++) {
        if (/^\s+/.test(allLines[i]) && !/^[▶▼]\s/.test(allLines[i].trim())) {
          childLines.push(allLines[i]);
        } else {
          break;
        }
      }
      if (childLines.length > 0) {
        tc[headerText] = childLines.join("\n");
        const newLines = [...allLines];
        newLines.splice(actualLineIdx + 1, childLines.length);
        newLines[actualLineIdx] = newLines[actualLineIdx].replace(/^(\s*)▼/, "$1▶");
        el.textContent = newLines.join("\n");
        pushHistory();
        const cur = useCanvasStore.getState().blocks[shell.id] as any;
        const curData = cur?.data && typeof cur.data === "object" ? { ...cur.data } : {};
        updateBlock(shell.id as any, { content: newLines.join("\n"), data: { ...curData, _tc: tc } } as any);
      } else {
        replaceTextByAbsoluteRange(el, markerStart, markerEnd, "▶");
        onTypingChange?.(shell.id, getEditorText(el));
      }
    } else {
      // Expanding: restore stored child lines
      const stored = tc[headerText];
      const newLines = [...allLines];
      newLines[actualLineIdx] = newLines[actualLineIdx].replace(/^(\s*)▶/, "$1▼");
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

  // Match TextBlock behavior: only sync DOM from state when editor is not focused.
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    if (document.activeElement === el) return;
    const next = String(shell.content ?? "");
    const display = shell.listType === "todo" ? toDisplayTodoMarkers(next) : next;
    if ((el.textContent ?? "") !== display) el.textContent = display;
    const state = readSlashState(next);
    setShowSlashMenu(state.open);
    setSlashQuery(state.query);
  }, [shell.content, isTyping]);
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
  if (!isTyping) {
    return React.createElement(
      "div",
      {
        className: "px-2 py-0 tracking-[-0.01em] whitespace-pre-wrap break-words select-text",
        style: {
          overflowWrap: "anywhere",
          fontSize: `${fontSizePx}px`,
          lineHeight: `${lineHeightPx}px`,
          fontWeight,
          color: shell.textColor || "rgba(0,0,0,0.80)",
          userSelect: "text",
          WebkitUserSelect: "text",
        },
      },
      shell.content
    );
  }

  const applySlashCommand = (command: string) => {
    applyingSlashRef.current = true;
    const current = getEditorText(editorRef.current);
    const normalized = String(current || "").replace(/^\s+/, "");
    const rest = normalized.replace(/^\/[^\n]*(?:\n|$)/i, "");
    onTypingChange?.(shell.id, `${command} ${rest}`);
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
      },
      onPaste: (e: React.ClipboardEvent<HTMLDivElement>) => {
        // Keep paste behavior deterministic and style-safe.
        e.preventDefault();
        const txt = String(e.clipboardData.getData("text/plain") || "");
        insertTextAtCursor(txt);
        const nextRaw = getEditorText(editorRef.current);
        const next = shell.listType === "todo" ? toStorageTodoMarkers(nextRaw) : nextRaw;
        onTypingChange?.(shell.id, next, { isPaste: true });
        const state = readSlashState(next);
        setShowSlashMenu(state.open);
        setSlashQuery(state.query);
      },
      onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => {
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
            const isOnHeader = /^[▶▼]\s/.test(currentLine);
            const isOnChild = /^\s+/.test(currentLine);
            const isExpandedHeader = /^▼\s/.test(currentLine);

            if (isOnHeader && isExpandedHeader) {
              insertTextAtCursor("\n  ");
            } else if (isOnChild) {
              insertTextAtCursor("\n  ");
            } else {
              insertTextAtCursor("\n▶ ");
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
    isTyping && showSlashMenu && filteredSlashOptions.length
      ? React.createElement(
          "div",
          {
            className:
              "absolute left-2 top-full mt-1 min-w-[180px] rounded-md border border-white/45 bg-[linear-gradient(145deg,rgba(255,255,255,0.95),rgba(245,247,255,0.90))] shadow-[0_10px_28px_rgba(0,0,0,0.20)] backdrop-blur-md z-[70] p-1",
            onPointerDown: (e: any) => {
              e.preventDefault();
              e.stopPropagation();
            },
          },
          (() => {
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
          })()
        )
      : null
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

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const deltaX = Number(ev.clientX || 0) - startX;
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
  const labelEl = BRICK_BEHAVIOR.showHoverLabel
    ? React.createElement(
        "div",
        {
          className: "opacity-0 group-hover:opacity-100 transition-opacity text-[9px] text-black/65 px-1 py-0.5 truncate",
        },
        shell.label
      )
    : null;

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
        ...(opts?.extraContent
          ? { minHeight: `${shell.height}px`, height: "auto" }
          : { height: `${shell.height}px` }),
        zIndex: isRaised ? 40 : 10,
        willChange: "transform",
      },
    },
    React.createElement(
      "div",
      {
        className:
          `w-full rounded border border-white/45 ${shell.brickColor ? "" : "bg-[linear-gradient(145deg,rgba(255,255,255,0.34),rgba(255,255,255,0.18))]"} backdrop-blur-[2px]${opts?.extraContent ? " min-h-full" : " h-full"} relative`,
        style: {
          transform: isRaised ? "translateY(-8px) scale(1.02)" : "translateY(0px) scale(1)",
          boxShadow: isRaised
            ? "0 20px 36px rgba(0,0,0,0.30)"
            : isActivated
              ? "inset 0 1px 0 rgba(255,255,255,0.55), 0 6px 18px rgba(0,0,0,0.14)"
              : "0 2px 8px rgba(0,0,0,0.10)",
          borderColor: isRaised ? "rgba(59,130,246,0.78)" : isActivated ? "rgba(59,130,246,0.45)" : "rgba(255,255,255,0.45)",
          transition: "transform 150ms, box-shadow 150ms, border-color 150ms, background 150ms, color 150ms",
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
              "absolute top-0 right-0 h-full w-3 cursor-ew-resize rounded-r hover:bg-black/10 transition-colors",
            title: "Drag to resize width",
            onPointerDown: startWidthResize,
            onClick: (e: any) => e.stopPropagation(),
          })
        : null,
      labelEl
    ),
    shell.content.trim()
      ? React.createElement(
          "button",
          {
            key: "brick-menu-btn",
            className:
              "absolute opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center w-6 h-6 rounded-md hover:bg-black/8 dark:hover:bg-white/12",
            style: {
              top: "2px",
              right: `calc(100% + 4px)`,
            },
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
      : null
  );
}
