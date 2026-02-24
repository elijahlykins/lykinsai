import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Block } from "@/canvas/types";

export const BRICK_BEHAVIOR = {
  // Single source of truth for main-canvas brick behavior.
  enableLogic: false,
  gridSize: 24,
  showHoverLabel: true,
} as const;

export type BrickShellModel = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  content: string;
  textVariant: "body" | "h2" | "h1";
  listType: "none" | "bullet" | "numbered" | "todo";
};

export type BrickShellRenderOptions = {
  isRaised?: boolean;
  isActivated?: boolean;
  onPress?: (id: string, shiftKey: boolean, source: "pointerdown" | "click") => void;
  isTyping?: boolean;
  onTypingChange?: (id: string, value: string, meta?: { isPaste?: boolean }) => void;
  onTypingKeyDown?: (id: string, e: React.KeyboardEvent<HTMLDivElement>) => void;
  onTypingBlur?: (id: string) => void;
};

export function toBrickShellModel(block: Block | any): BrickShellModel {
  const b = (block || {}) as any;
  const data = b?.data && typeof b.data === "object" ? b.data : {};
  const label = String(data.name || data.title || b?.name || b?.id || "brick");
  const content = String(data.content ?? b?.content ?? "");
  const rawVariant = String(data.textVariant || "body").toLowerCase();
  const textVariant: "body" | "h2" | "h1" = rawVariant === "h1" ? "h1" : rawVariant === "h2" ? "h2" : "body";
  const rawListType = String(data.listType || "none").toLowerCase();
  const listType: "none" | "bullet" | "numbered" | "todo" =
    rawListType === "bullet" ? "bullet" : rawListType === "numbered" ? "numbered" : rawListType === "todo" ? "todo" : "none";
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
  const editorRef = useRef<HTMLDivElement | null>(null);
  const applyingSlashRef = useRef(false);
  const TODO_EMPTY = "◻\uFE0E";
  const TODO_FILLED = "◼\uFE0E";
  const [slashQuery, setSlashQuery] = useState("");
  const [showSlashMenu, setShowSlashMenu] = useState(false);
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
      { id: "h1", command: "/h1", label: "Heading 1", hint: "3 bricks tall" },
      { id: "h2", command: "/h2", label: "Heading 2", hint: "2 bricks tall" },
      { id: "text", command: "/text", label: "Text", hint: "1 brick tall" },
      { id: "bulleted-list", command: "/bulleted list", label: "Bulleted List", hint: "auto • on Enter" },
      { id: "numbered-list", command: "/numbered list", label: "Numbered List", hint: "auto 1. 2. on Enter" },
      { id: "todo-list", command: "/to do list", label: "To-do List", hint: "auto ◻ on Enter" },
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

  const getEditorText = (el: HTMLDivElement | null) => {
    if (!el) return "";
    // innerText preserves line breaks; normalize contentEditable's doubled Enter newlines.
    const raw = String(el.innerText ?? el.textContent ?? "").replace(/\r\n/g, "\n");
    if (!/<(?:div|p|br)\b/i.test(el.innerHTML)) return raw;
    return raw.replace(/\n{2,}/g, (m) => "\n".repeat(Math.ceil(m.length / 2)));
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
    if (shell.listType !== "todo") return false;
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
    const m = line.match(/^(\s*)((?:◻(?:\uFE0E|\uFE0F)?|◼(?:\uFE0E|\uFE0F)?|□|■|⬜|⬛|▢|▣|☐|☑))\s/);
    if (!m) return false;
    const markerStartAbs = lineStart + (m[1]?.length || 0);
    const markerEndAbs = markerStartAbs + (m[2]?.length || 1);
    // Toggle only when click resolves to the marker glyph (not rest of line text).
    if (absClick < markerStartAbs || absClick > markerEndAbs) return false;
    const isFilled = /^\s*(?:◼(?:\uFE0E|\uFE0F)?|■|⬛|▣|☑)\s/.test(line);
    const nextMarker = isFilled ? TODO_EMPTY : TODO_FILLED;
    e.preventDefault();
    replaceTextByAbsoluteRange(el, markerStartAbs, markerEndAbs, nextMarker);
    const nextText = getEditorText(el);
    onTypingChange?.(shell.id, nextText);
    if (restoreAbs != null) {
      setCaretAtAbsolute(el, Math.min(nextText.length, Math.max(0, restoreAbs)));
    }
    return true;
  };

  // Match TextBlock behavior: only sync DOM from state when editor is not focused.
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    if (document.activeElement === el) return;
    const next = String(shell.content ?? "");
    if ((el.textContent ?? "") !== next) el.textContent = next;
    const state = readSlashState(next);
    setShowSlashMenu(state.open);
    setSlashQuery(state.query);
  }, [shell.content, isTyping]);
  if (!isTyping) {
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
        tryToggleTodoAtPointer(editorRef.current, e);
      },
      onInput: (e: React.FormEvent<HTMLDivElement>) => {
        const next = getEditorText(e.currentTarget);
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
        const next = getEditorText(editorRef.current);
        onTypingChange?.(shell.id, next, { isPaste: true });
        const state = readSlashState(next);
        setShowSlashMenu(state.open);
        setSlashQuery(state.query);
      },
      onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === "Enter" && !(e.metaKey || e.ctrlKey) && shell.listType !== "none") {
          e.preventDefault();
          const current = getEditorText(editorRef.current);
          const lines = String(current || "").split("\n");
          const nextMarker =
            shell.listType === "bullet"
              ? "• "
              : shell.listType === "todo"
                ? `${TODO_EMPTY} `
                : (() => {
                    const currentLine = String(lines[lines.length - 1] || "");
                    const m = currentLine.match(/^\s*(\d+)\.\s/);
                    const nextNum = m ? Number(m[1]) + 1 : lines.filter((l) => /^\s*\d+\.\s/.test(l)).length + 1;
                    return `${Math.max(1, nextNum)}. `;
                  })();
          insertTextAtCursor(`\n${nextMarker}`);
          const next = getEditorText(editorRef.current);
          onTypingChange?.(shell.id, next);
          return;
        }
        onTypingKeyDown?.(shell.id, e);
      },
      onBlur: (e: React.FocusEvent<HTMLDivElement>) => {
        if (applyingSlashRef.current) return;
        const text = getEditorText(e.currentTarget);
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
          filteredSlashOptions.map((opt) =>
            React.createElement(
              "button",
              {
                key: opt.id,
                type: "button",
                className:
                  "w-full text-left px-2 py-1 rounded text-[12px] text-black/85 hover:bg-black/10 transition-colors flex items-center justify-between",
                onPointerDown: (e: any) => {
                  e.preventDefault();
                  e.stopPropagation();
                  applySlashCommand(opt.command);
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
              React.createElement("span", null, `${opt.command} ${opt.label}`),
              React.createElement("span", { className: "text-[10px] text-black/55 ml-2" }, opt.hint)
            )
          )
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
      className: "absolute group cursor-pointer select-none",
      onPointerDown: handlePointerDown,
      onClick: handleClick,
      style: {
        left: `${shell.x}px`,
        top: `${shell.y}px`,
        width: `${shell.width}px`,
        height: `${shell.height}px`,
        zIndex: isRaised ? 40 : 10,
      },
    },
    React.createElement(
      "div",
      {
        className:
          "h-full w-full rounded border border-white/45 bg-[linear-gradient(145deg,rgba(255,255,255,0.34),rgba(255,255,255,0.18))] backdrop-blur-[2px] transition-all duration-150",
        style: {
          transform: isRaised ? "translateY(-8px) scale(1.02)" : "translateY(0px) scale(1)",
          boxShadow: isRaised
            ? "0 20px 36px rgba(0,0,0,0.30)"
            : isActivated
              ? "inset 0 1px 0 rgba(255,255,255,0.55), 0 6px 18px rgba(0,0,0,0.14)"
              : "0 2px 8px rgba(0,0,0,0.10)",
          borderColor: isRaised ? "rgba(59,130,246,0.78)" : isActivated ? "rgba(59,130,246,0.45)" : "rgba(255,255,255,0.45)",
        },
      },
      React.createElement(BrickTextSurface, {
        shell,
        isTyping,
        onTypingChange: opts?.onTypingChange,
        onTypingKeyDown: opts?.onTypingKeyDown,
        onTypingBlur: opts?.onTypingBlur,
      }),
      labelEl
    )
  );
}
