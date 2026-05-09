import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom";
import { renderToString } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Heading1, Heading2, Type, List, ListOrdered, ListChecks, ChevronRight, TextQuote, Image, Mic, MoreHorizontal, Minimize2, Maximize2, Table } from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";
import { getStructuredPasteFromEvent } from "@/lib/pasteFromClipboard";
import { EditableMarkdownTable, InlineEditableTable, parseGfmTable } from "@/canvas/blocks/EditableMarkdownTable";
import type { Block } from "@/canvas/types";

export const BRICK_BEHAVIOR = {
  // Single source of truth for main-canvas brick behavior.
  enableLogic: false,
  gridSize: 24,
  showHoverLabel: false,
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
  format: string;
  textVariant: "body" | "h2" | "h1";
  listType: "none" | "bullet" | "numbered" | "todo" | "toggle" | "quote";
  brickColor?: string;
  textColor?: string;
  isAiResponseBubble?: boolean;
  userResized?: boolean;
  brickScale?: number;
};

// Unified markdown detection used by every text-bearing brick (typed text,
// slash-command bricks, AI tool-call bricks, pasted bricks, dragged AI
// bubbles). Catches headers, bold (** / __), single-asterisk and
// single-underscore italics, fenced code blocks, inline code (`foo`),
// links and images (`[text](url)`, `![alt](src)`), bulleted and numbered
// lists, GFM tables, blockquotes, and strikethrough (~~foo~~).
//
// The regex covers the full set of inline + block features we actually
// render, so `shouldRenderAsMarkdown` can require a real match before
// flipping a brick from the plain `<textarea>` path to the markdown
// `contenteditable` path. That alignment is what stops display and edit
// from disagreeing on whether a brick is "rich" (which used to produce a
// visible layout shift on click-in).
const MARKDOWN_DETECT_RE =
  /(?:^|\n)\s*#{1,6}\s|(?:\*\*|__)[^\s][\s\S]*?(?:\*\*|__)|(?:^|[^\w*])\*[^\s*][^*\n]*\*(?=$|[^\w*])|(?:^|[^\w_])_[^\s_][^_\n]*_(?=$|[^\w_])|```|`[^`\n]+`|(?:^|\n)\s*[-*+]\s|(?:^|\n)\s*\d+\.\s|(?:^|\n)\|.+\||(?:^|\n)\s*>\s|!?\[[^\]]*?\]\([^)\s]+\)|~~[^~\n]+~~/m;

function shouldRenderAsMarkdown(content: string, format: string, isAiBubble: boolean): boolean {
  if (isAiBubble) return true;
  if (!content) return false;
  // `rich` and `markdown` bricks render as markdown only when actual
  // markdown syntax is present. This way the edit surface (textarea for
  // plain text, contenteditable for markdown) and the display surface
  // always agree on what gets rendered, eliminating the visible "format
  // jump" on click-in for both formats. MARKDOWN_DETECT_RE covers the
  // full set of inline + block markdown we render, so a `[link](url)` or
  // `~~strike~~` in an otherwise-plain brick still renders correctly.
  if (format === "markdown" || format === "rich") {
    return MARKDOWN_DETECT_RE.test(content);
  }
  return MARKDOWN_DETECT_RE.test(content);
}

// Component overrides used when rendering markdown to HTML for the edit
// surface and for the persisted `formattedHtml`. These mirror the
// `aiMarkdownComponents` map exactly so the seeded edit HTML and the
// display HTML are byte-for-byte identical — every block element carries
// `first:mt-0 last:mb-0` so the first/last child doesn't push text away
// from the brick edges, and `<p>` keeps `whitespace-pre-wrap` so single
// `\n` line breaks inside a paragraph survive the round-trip. Without the
// `first:mt-0 last:mb-0` parity, clicking into a markdown-bearing brick
// used to introduce a few-pixel layout shift because the seeded HTML
// silently picked up `mt-2`/`my-1` margins the display version didn't
// have. We deliberately omit any component that carries React state
// (e.g. `InlineEditableTable`) because `renderToString` can't safely
// round-trip those — the default `<table>` tag is fine for the edit
// window since content with GFM tables is routed through
// `EditableMarkdownTable` in display mode anyway.
const editorMarkdownComponents = {
  h1: ({ children }: any) => React.createElement("h1", { className: "font-semibold mt-2 mb-1 first:mt-0 last:mb-0", style: { fontSize: "1.5em" } }, children),
  h2: ({ children }: any) => React.createElement("h2", { className: "font-semibold mt-2 mb-1 first:mt-0 last:mb-0", style: { fontSize: "1.3em" } }, children),
  h3: ({ children }: any) => React.createElement("h3", { className: "font-semibold mt-1.5 mb-1 first:mt-0 last:mb-0", style: { fontSize: "1.15em" } }, children),
  p: ({ children }: any) => React.createElement("p", { className: "my-1 first:mt-0 last:mb-0 whitespace-pre-wrap" }, children),
  ul: ({ children }: any) => React.createElement("ul", { className: "my-1 first:mt-0 last:mb-0 list-disc pl-5 space-y-0.5" }, children),
  ol: ({ children }: any) => React.createElement("ol", { className: "my-1 first:mt-0 last:mb-0 list-decimal pl-5 space-y-0.5" }, children),
  li: ({ children }: any) => React.createElement("li", { className: "leading-relaxed" }, children),
  strong: ({ children }: any) => React.createElement("strong", { className: "font-semibold" }, children),
  blockquote: ({ children }: any) => React.createElement("blockquote", { className: "border-l-2 border-black/20 dark:border-white/20 pl-3 my-1 first:mt-0 last:mb-0 text-black/70 dark:text-white/70 italic" }, children),
  code: ({ children, className }: any) => {
    const isBlock = String(className || "").startsWith("language-");
    if (isBlock) return React.createElement("pre", { className: "rounded-lg bg-black/5 p-2 my-1 first:mt-0 last:mb-0 overflow-x-auto", style: { fontSize: "0.85em" } }, React.createElement("code", null, children));
    return React.createElement("code", { className: "rounded bg-black/10 px-1 py-0.5", style: { fontSize: "0.85em" } }, children);
  },
  pre: ({ children }: any) => React.createElement(React.Fragment, null, children),
  thead: ({ children }: any) => React.createElement("thead", { className: "border-b border-black/20" }, children),
  tbody: ({ children }: any) => React.createElement("tbody", null, children),
  tr: ({ children }: any) => React.createElement("tr", { className: "border-b border-black/10" }, children),
  th: ({ children }: any) => React.createElement("th", { className: "text-left px-3 py-2 font-semibold" }, children),
  td: ({ children }: any) => React.createElement("td", { className: "px-3 py-2" }, children),
};

// Synchronous markdown -> HTML, used to seed the contenteditable surface on
// edit-entry so the visible formatting matches the display rendering, and to
// produce the HTML we persist as `formattedHtml` on blur. We use a component
// map that mirrors display styling (notably `whitespace-pre-wrap` on `<p>`),
// so the rendered HTML round-trips into `dangerouslySetInnerHTML` cleanly
// without losing soft line breaks.
function renderMarkdownToHtmlString(content: string): string {
  try {
    return renderToString(
      React.createElement(
        ReactMarkdown as any,
        { remarkPlugins: [remarkGfm], components: editorMarkdownComponents },
        String(content || "")
      )
    );
  } catch {
    return String(content || "");
  }
}

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
  onTypingChange?: (
    id: string,
    value: string,
    meta?: { isPaste?: boolean; isLineBreak?: boolean; exitList?: boolean; formattedHtml?: string; preserveSize?: boolean }
  ) => void;
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
    format: String(b?.format || "rich").toLowerCase(),
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

const BrickTextSurface = React.memo(function BrickTextSurface(props: {
  shell: BrickShellModel;
  isTyping: boolean;
  onTypingChange?: (
    id: string,
    value: string,
    meta?: { isPaste?: boolean; isLineBreak?: boolean; exitList?: boolean; formattedHtml?: string; preserveSize?: boolean }
  ) => void;
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
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const pendingCaretRef = useRef<number | null>(null);
  const todoInputRefs = useRef<Record<number, HTMLInputElement | null>>({});
  const pendingTodoFocusIndexRef = useRef<number | null>(null);
  const wasTypingRef = useRef(false);
  const hadTodoLinesRef = useRef(false);
  const applyingSlashRef = useRef(false);
  // Tracks whether the contenteditable was seeded with rich rendered HTML on
  // edit-entry — either restored from saved `formattedHtml` (highlights /
  // marks) or freshly rendered from markdown content (AI bubbles and any
  // brick whose content has markdown structure). The blur handler uses this
  // to decide whether the resulting innerHTML should be persisted as
  // `formattedHtml` even when no inline mark/highlight tags are present, so
  // the next edit reuses the rendered visual instead of falling back to raw
  // markdown source. The `useLayoutEffect` reseed-protection below also
  // reads this to avoid overwriting rich markup with raw textContent on
  // intermediate re-renders.
  const loadedRichHtmlRef = useRef(false);
  // Editor-surface lock for the contenteditable-vs-textarea choice. Defined
  // at the top of the component (before any conditional `return`) so the
  // hook is always called regardless of which render path runs below — the
  // todo-lines early-return path used to skip a useRef declared further
  // down, which produced "Rendered more hooks than during the previous
  // render" the moment a brick toggled in or out of having todo lines. The
  // actual "lock" semantics (initialize once, then only update between
  // typing sessions) live near the surface-selection logic further down.
  const surfaceLockRef = useRef<boolean | null>(null);
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
    if (!showSlashMenu || !filteredSlashOptions.length) {
      setSlashMenuRect(null);
      return;
    }
    const el = textareaRef.current ?? editorRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setSlashMenuRect({ left: rect.left + 8, top: rect.bottom + 4 });
  }, [showSlashMenu, filteredSlashOptions.length]);

  // After a controlled-textarea value change (Enter-marker insertion, paste,
  // slash command), put the caret back where the user expects it. Without
  // this, inserting `\n• ` would leave the caret jumping to the end of the
  // text — which is exactly the kind of glitch the contenteditable path used
  // to suffer from. Mirrors the cursor-restoration that the per-row todo
  // inputs already get for free from React's controlled-input behavior.
  useLayoutEffect(() => {
    if (pendingCaretRef.current == null) return;
    const el = textareaRef.current;
    if (!el) {
      pendingCaretRef.current = null;
      return;
    }
    const pos = Math.max(0, Math.min(pendingCaretRef.current, el.value.length));
    try {
      el.setSelectionRange(pos, pos);
    } catch {
      // ignore selection failures
    }
    pendingCaretRef.current = null;
  }, [shell.content]);

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
    const match = line.match(/^(\s*)([▶▼▸▾▷▽])(?:\uFE0E|\uFE0F)?\s/);
    if (!match) return false;
    const markerStart = lineStart + (match[1]?.length || 0);
    const markerEnd = markerStart + 1;
    if (absClick < markerStart || absClick > markerEnd) return false;
    e.preventDefault();
    const isExpanded = match[2] === "▼" || match[2] === "▾" || match[2] === "▽";
    const headerText = line.replace(/^(\s*)[▶▼▸▾▷▽](?:\uFE0E|\uFE0F)?\s/, "").trim();
    const tc: Record<string, string> = { ...(blockData._tc || {}) };

    if (isExpanded) {
      // Collapsing: find indented child lines below and store them
      const childLines: string[] = [];
      for (let i = actualLineIdx + 1; i < allLines.length; i++) {
        if (/^\s+/.test(allLines[i]) && !/^[▶▼▸▾▷▽](?:\uFE0E|\uFE0F)?\s/.test(allLines[i].trim())) {
          childLines.push(allLines[i]);
        } else {
          break;
        }
      }
      if (childLines.length > 0) {
        tc[headerText] = childLines.join("\n");
        const newLines = [...allLines];
        newLines.splice(actualLineIdx + 1, childLines.length);
        newLines[actualLineIdx] = newLines[actualLineIdx].replace(/^(\s*)[▼▾▽](?:\uFE0E|\uFE0F)?/, "$1▷\uFE0E");
        el.textContent = newLines.join("\n");
        pushHistory();
        const cur = useCanvasStore.getState().blocks[shell.id] as any;
        const curData = cur?.data && typeof cur.data === "object" ? { ...cur.data } : {};
        updateBlock(shell.id as any, { content: newLines.join("\n"), data: { ...curData, _tc: tc } } as any);
        // Toggle collapse/expand bypasses onTypingChange's autogrow path
        // (the contenteditable's onInput never fires here) so the brick
        // would otherwise stay at its previous size and either show dead
        // whitespace below the collapsed header or clip newly-restored
        // children. Defer to next frame so the store update lands first.
        window.requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("omnia_autogrow_block", { detail: { id: shell.id } })));
        setTimeout(() => window.dispatchEvent(new Event("omnia_flush_save")), 200);
      } else {
        replaceTextByAbsoluteRange(el, markerStart, markerEnd, "▷\uFE0E");
        onTypingChange?.(shell.id, getEditorText(el));
      }
    } else {
      // Expanding: restore stored child lines
      const stored = tc[headerText];
      const newLines = [...allLines];
      newLines[actualLineIdx] = newLines[actualLineIdx].replace(/^(\s*)[▶▸▷](?:\uFE0E|\uFE0F)?/, "$1▽\uFE0E");
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
      window.requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("omnia_autogrow_block", { detail: { id: shell.id } })));
      setTimeout(() => window.dispatchEvent(new Event("omnia_flush_save")), 200);
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
    const fHtml = blockData.formattedHtml;
    // Bricks that already carry inline highlights/marks: restore the saved
    // HTML so the highlights stay visible during the edit session. Todo
    // bricks render their own per-row inputs (early-returned above) so they
    // never reach this surface; bullet/numbered/quote bricks can carry
    // highlights too, so we accept any non-todo listType here.
    if (justEnteredTyping && fHtml && shell.listType !== "todo") {
      el.innerHTML = fHtml;
      loadedRichHtmlRef.current = true;
      return;
    }
    // Markdown-rendering bricks (AI response bubbles, anything with markdown
    // structure in its content): render the markdown to HTML and seed it
    // into the contenteditable so the editor surface visually matches what
    // display mode shows. Without this, clicking into an AI bubble would
    // drop the formatting back to raw `**bold**` text. The
    // `loadedRichHtmlRef` tells the blur handler to persist the resulting
    // innerHTML as `formattedHtml` so the visual round-trips on the next
    // edit-entry.
    if (
      justEnteredTyping &&
      shell.listType === "none" &&
      (Boolean(shell.isAiResponseBubble) || MARKDOWN_DETECT_RE.test(next))
    ) {
      const renderedHtml = renderMarkdownToHtmlString(next);
      el.innerHTML = renderedHtml;
      loadedRichHtmlRef.current = true;
      return;
    }
    // Don't blow away rich HTML that's already in the surface. If we seeded
    // formattedHtml or markdown-rendered HTML on entry, the user's blur is
    // the source of truth for promoting that HTML back into the store; an
    // intermediate re-render here (e.g. after onInput updated `shell.content`
    // to the new textContent) would otherwise overwrite the rich markup
    // with raw text, causing a brief visual flash of unformatted content.
    if (loadedRichHtmlRef.current || fHtml) {
      return;
    }
    loadedRichHtmlRef.current = false;
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
  const tableCounterRef = useRef(0);
  tableCounterRef.current = 0;
  // NOTE: every block-level element below uses `first:mt-0 last:mb-0` so the
  // first/last child of a brick's rendered markdown doesn't push the visible
  // text away from the brick's edges. Without this, blurring out of a typed
  // brick (textarea has 0 top/bottom padding) causes the text to "shift" by
  // ~4px because the rendered <ol>/<ul>/<p> introduces a leading margin that
  // wasn't there in edit mode.
  const aiMarkdownComponents = useMemo(() => ({
    h1: ({ children }: any) => React.createElement("h1", { className: "font-semibold mt-2 mb-1 first:mt-0 last:mb-0", style: { fontSize: "1.5em" } }, children),
    h2: ({ children }: any) => React.createElement("h2", { className: "font-semibold mt-2 mb-1 first:mt-0 last:mb-0", style: { fontSize: "1.3em" } }, children),
    h3: ({ children }: any) => React.createElement("h3", { className: "font-semibold mt-1.5 mb-1 first:mt-0 last:mb-0", style: { fontSize: "1.15em" } }, children),
    p: ({ children }: any) => React.createElement("p", { className: "my-1 first:mt-0 last:mb-0 whitespace-pre-wrap" }, children),
    ul: ({ children }: any) => React.createElement("ul", { className: "my-1 first:mt-0 last:mb-0 list-disc pl-5 space-y-0.5" }, children),
    ol: ({ children }: any) => React.createElement("ol", { className: "my-1 first:mt-0 last:mb-0 list-decimal pl-5 space-y-0.5" }, children),
    li: ({ children }: any) => React.createElement("li", { className: "leading-relaxed" }, children),
    strong: ({ children }: any) => React.createElement("strong", { className: "font-semibold" }, children),
    blockquote: ({ children }: any) => React.createElement("blockquote", { className: "border-l-2 border-black/20 dark:border-white/20 pl-3 my-1 first:mt-0 last:mb-0 text-black/70 dark:text-white/70 italic" }, children),
    code: ({ children, className }: any) => {
      const isBlock = className?.startsWith("language-");
      if (isBlock) return React.createElement("pre", { className: "rounded-lg bg-black/5 p-2 my-1 first:mt-0 last:mb-0 overflow-x-auto", style: { fontSize: "0.85em" } }, React.createElement("code", null, children));
      return React.createElement("code", { className: "rounded bg-black/10 px-1 py-0.5", style: { fontSize: "0.85em" } }, children);
    },
    pre: ({ children }: any) => React.createElement(React.Fragment, null, children),
    table: ({ children, node }: any) => {
      const idx = tableCounterRef.current++;
      return React.createElement(InlineEditableTable, {
        blockId: shell.id,
        node,
        children,
        tableIndex: idx,
      });
    },
    thead: ({ children }: any) => React.createElement("thead", { className: "border-b border-black/20" }, children),
    tbody: ({ children }: any) => React.createElement("tbody", null, children),
    tr: ({ children }: any) => React.createElement("tr", { className: "border-b border-black/10" }, children),
    th: ({ children }: any) => React.createElement("th", { className: "text-left px-3 py-2 font-semibold" }, children),
    td: ({ children }: any) => React.createElement("td", { className: "px-3 py-2" }, children),
  }), [shell.id]);

  if (hasTodoLines) {
    return React.createElement(
      "div",
      {
        className: "px-2 py-0 tracking-[-0.01em] text-black/80 dark:text-white/80 whitespace-pre-wrap break-words select-text",
        style: {
          overflowWrap: "anywhere",
          fontSize: `${fontSizePx}px`,
          lineHeight: `${lineHeightPx}px`,
          fontWeight,
          userSelect: "text",
          WebkitUserSelect: "text",
        },
        onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => { e.stopPropagation(); },
        onClick: (e: React.MouseEvent<HTMLDivElement>) => { e.stopPropagation(); },
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
            // Todo bricks render real <input> elements per row, so the
            // outer contenteditable's onBlur never fires for them. Without
            // this handler clicking out of a todo would never trigger a
            // save flush, and edits would only land on the next 30s
            // autosave tick. Re-assert the latest text into the store and
            // dispatch the same flush event the contenteditable path uses.
            onBlur: (e: any) => {
              const nextText = applyTodoTextAtLine(String(shell.content || ""), index, String(e.currentTarget.value || ""));
              const storeBlock: any = useCanvasStore.getState().blocks[shell.id];
              if (storeBlock && storeBlock.content !== nextText) {
                updateBlock(shell.id as any, { content: nextText } as any);
              }
              const root = e.currentTarget.closest?.("[data-canvas-block]") as HTMLElement | null;
              window.requestAnimationFrame(() => {
                const next = document.activeElement as HTMLElement | null;
                if (root && next && root.contains(next)) return;
                onTypingBlur?.(shell.id);
                setTimeout(() => window.dispatchEvent(new Event("omnia_flush_save")), 500);
              });
            },
          })
        );
      })
    );
  }
  if (!isTyping) {
    const contentStr = String(shell.content || "");

    if (shell.listType === "toggle") {
      const toggleLines = contentStr.split("\n");
      const toggleCollapse = (lineIdx: number) => {
        const allLines = [...toggleLines];
        const line = allLines[lineIdx] || "";
        const m = line.match(/^(\s*)([▶▼▸▾▷▽])(?:\uFE0E|\uFE0F)?\s/);
        if (!m) return;
        const isExp = m[2] === "▼" || m[2] === "▾" || m[2] === "▽";
        const headerText = line.replace(/^(\s*)[▶▼▸▾▷▽](?:\uFE0E|\uFE0F)?\s/, "").trim();
        const tc: Record<string, string> = { ...(blockData._tc || {}) };
        if (isExp) {
          const childLines: string[] = [];
          for (let i = lineIdx + 1; i < allLines.length; i++) {
            if (/^\s+/.test(allLines[i]) && !/^[▶▼▸▾▷▽](?:\uFE0E|\uFE0F)?\s/.test(allLines[i].trim())) {
              childLines.push(allLines[i]);
            } else break;
          }
          if (childLines.length > 0) {
            tc[headerText] = childLines.join("\n");
            allLines.splice(lineIdx + 1, childLines.length);
          }
          allLines[lineIdx] = allLines[lineIdx].replace(/^(\s*)[▼▾▽](?:\uFE0E|\uFE0F)?/, "$1▷\uFE0E");
        } else {
          const stored = tc[headerText];
          allLines[lineIdx] = allLines[lineIdx].replace(/^(\s*)[▶▸▷](?:\uFE0E|\uFE0F)?/, "$1▽\uFE0E");
          if (stored) {
            allLines.splice(lineIdx + 1, 0, ...stored.split("\n"));
            delete tc[headerText];
          }
        }
        pushHistory();
        const cur = useCanvasStore.getState().blocks[shell.id] as any;
        const curData = cur?.data && typeof cur.data === "object" ? { ...cur.data } : {};
        updateBlock(shell.id as any, { content: allLines.join("\n"), data: { ...curData, _tc: tc } } as any);
        window.requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("omnia_autogrow_block", { detail: { id: shell.id } })));
        setTimeout(() => window.dispatchEvent(new Event("omnia_flush_save")), 200);
      };
      return React.createElement(
        "div",
        {
          className: "px-2 py-0 tracking-[-0.01em] whitespace-pre-wrap break-words select-text",
          style: {
            overflowWrap: "anywhere",
            fontSize: `${fontSizePx}px`,
            lineHeight: `${lineHeightPx}px`,
            fontWeight,
            color: shell.textColor || "inherit",
            userSelect: "text",
            WebkitUserSelect: "text",
          },
          onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => { e.stopPropagation(); },
        },
        toggleLines.map((line, idx) => {
          const hm = line.match(/^(\s*)([▶▼▸▾▷▽])(?:\uFE0E|\uFE0F)?\s(.*)/);
          if (hm) {
            const isExp = hm[2] === "▼" || hm[2] === "▾" || hm[2] === "▽";
            return React.createElement(
              "div",
              { key: `tl-${idx}`, className: "flex items-start gap-0" },
              React.createElement(
                "span",
                {
                  className: "cursor-pointer select-none opacity-45 hover:opacity-70 transition-opacity",
                  style: { display: "inline-block", width: "1.1em", textAlign: "center", flexShrink: 0 },
                  onPointerDown: (ev: any) => { ev.stopPropagation(); },
                  onClick: (ev: any) => { ev.stopPropagation(); toggleCollapse(idx); },
                },
                isExp ? "▽\uFE0E" : "▷\uFE0E"
              ),
              React.createElement("span", null, hm[3] || "")
            );
          }
          return React.createElement("div", { key: `tl-${idx}`, style: { paddingLeft: "1.1em" } }, line.replace(/^\s+/, "") || "\u00A0");
        })
      );
    }

    const isGfmTable = parseGfmTable(contentStr) !== null;
    if (isGfmTable) {
      return React.createElement(
        "div",
        {
          className: "px-2 py-0 tracking-[-0.01em] break-words select-text",
          style: {
            overflowWrap: "anywhere",
            fontSize: `${fontSizePx}px`,
            lineHeight: "1.5",
            fontWeight,
            color: shell.textColor || "inherit",
            userSelect: "text",
            WebkitUserSelect: "text",
          },
          onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => { e.stopPropagation(); },
        },
        React.createElement(EditableMarkdownTable, { blockId: shell.id, content: contentStr })
      );
    }

    if (blockData.formattedHtml) {
      // Pick the same line-height the live markdown render would have
      // chosen for this content, so toggling between "live ReactMarkdown
      // render" (pre-edit) and "saved formattedHtml render" (post-edit)
      // doesn't shift the text vertically. Block-level markdown HTML
      // matches the display markdown path's `1.5`; inline-only HTML
      // (e.g. plain text with a `<mark>` highlight) stays on the brick
      // grid's `lineHeightPx`.
      const fHtml = String(blockData.formattedHtml || "");
      const hasBlocks = /<(?:p|h[1-6]|ul|ol|blockquote|pre|table)[\s>]/i.test(fHtml);
      return React.createElement("div", {
        className: "px-2 py-0 tracking-[-0.01em] whitespace-pre-wrap break-words select-text",
        style: {
          overflowWrap: "anywhere",
          fontSize: `${fontSizePx}px`,
          lineHeight: hasBlocks ? "1.5" : `${lineHeightPx}px`,
          fontWeight,
          color: shell.textColor || "inherit",
          userSelect: "text",
          WebkitUserSelect: "text",
        },
        onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => { e.stopPropagation(); },
        dangerouslySetInnerHTML: { __html: fHtml },
      });
    }

    // Single source of truth for "should this brick render markdown?". Every
    // creator (typed text, slash commands, AI tool calls, paste, drag from AI
    // rail) sets `format: "rich"`, so this answers "yes" by default and AI
    // markdown like `*italic*` or `1. step` no longer leaks as raw text.
    //
    // Exception: bricks with an explicit listType (e.g. "numbered", "bullet",
    // "quote") edit through the plain <textarea> path above — markdown-rendering
    // them on blur would silently re-flow the text (e.g. `1. step` becomes a
    // proper <ol> with `pl-5`, shifting the visible text ~20px to the right
    // every time focus leaves). The list semantics are already carried by
    // shell.listType + the marker characters in the source, so we render the
    // content verbatim to keep the typing/display layout pixel-identical.
    const hasExplicitListType = shell.listType !== "none";
    const hasMarkdown = !hasExplicitListType && shouldRenderAsMarkdown(contentStr, shell.format, Boolean(shell.isAiResponseBubble));
    const isThinkingPlaceholder = Boolean(shell.isAiResponseBubble) && /^AI is thinking/i.test(contentStr.trim());
    return React.createElement(
      "div",
      {
        className: `px-2 py-0 tracking-[-0.01em] ${hasMarkdown ? "" : "whitespace-pre-wrap "}break-words select-text`,
        style: {
          overflowWrap: "anywhere",
          fontSize: `${fontSizePx}px`,
          lineHeight: hasMarkdown ? "1.5" : `${lineHeightPx}px`,
          fontWeight,
          color: isThinkingPlaceholder ? "transparent" : (shell.textColor || "inherit"),
          userSelect: "text",
          WebkitUserSelect: "text",
        },
        onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => { e.stopPropagation(); },
      },
      hasMarkdown
        ? React.createElement(ReactMarkdown as any, { remarkPlugins: [remarkGfm], components: aiMarkdownComponents }, contentStr)
        : shell.content
    );
  }

  const applySlashCommand = (command: string) => {
    applyingSlashRef.current = true;
    const current = textareaRef.current
      ? textareaRef.current.value
      : getEditorText(editorRef.current);
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
      const ta = textareaRef.current;
      const div = editorRef.current;

      if (ta) {
        // React has re-rendered with the transformed value; just place
        // the caret at the end so typing continues after any inserted
        // list marker (e.g. "• ", "1. ").
        ta.focus();
        const len = ta.value.length;
        try { ta.setSelectionRange(len, len); } catch { /* ignore */ }
        return;
      }

      if (div) {
        // The contentEditable's reseed-effect bails out while the
        // surface is focused, so when the slash command was applied
        // via mouse the DOM may still hold the pre-transform text
        // (e.g. "/toggle list") while the store carries the seeded
        // marker (e.g. "▷ "). Force-resynchronise from the canonical
        // store content and collapse the caret to the end so the user
        // types *after* the marker — fixing the "marker appears after
        // the text" glitch on toggle lists.
        const cur = useCanvasStore.getState().blocks[shell.id] as any;
        const canonical = String(cur?.content || "");
        if ((div.textContent ?? "") !== canonical) {
          div.textContent = canonical;
        }
        div.focus();
        const sel = window.getSelection();
        if (sel) {
          const range = document.createRange();
          range.selectNodeContents(div);
          range.collapse(false);
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }
    });
  };

  // The slash-command popover is rendered into document.body so it can
  // overlap any neighboring brick. Both editor surfaces (textarea for
  // regular text, contenteditable for toggle lists) share it.
  const slashMenuPortal = (() => {
    if (!isTyping || !showSlashMenu || !filteredSlashOptions.length || !slashMenuRect || typeof document === "undefined") {
      return null;
    }
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
    const menuEl = React.createElement(
      "div",
      {
        className:
          "min-w-[180px] rounded-md border border-white/25 bg-[linear-gradient(145deg,rgba(255,255,255,0.78),rgba(245,247,255,0.72))] shadow-md backdrop-blur-sm z-[9999] p-1",
        onPointerDown: (e: any) => {
          e.preventDefault();
          e.stopPropagation();
        },
        style: { position: "fixed" as const, left: slashMenuRect.left, top: slashMenuRect.top },
      },
      items
    );
    return ReactDOM.createPortal(menuEl, document.body);
  })();

  // Regular text bricks (everything except toggle lists) edit through a
  // React-controlled <textarea>. This is the same model the per-row todo
  // <input> elements use — the DOM never holds state independently of
  // shell.content, so there is no "syncBrickEditorText rolled my keystroke
  // back" race. Toggle lists keep contenteditable below because they need
  // in-place collapse-marker click handling that a textarea can't express.
  // We also route the following through the contenteditable path so the
  // visible formatting doesn't disappear the moment the user clicks in:
  //   • bricks with `formattedHtml` (inline highlights/marks)
  //   • AI response bubbles (always render markdown in display)
  //   • any non-list brick whose content actually contains markdown syntax
  // For pure plain-text bricks the textarea path is still used — there is
  // no formatting to drop, so the simpler/safer textarea is preferred.
  const hasInlineFormat = Boolean(blockData.formattedHtml);
  const contentStr = String(shell.content || "");
  const hasMarkdownStructure =
    shell.listType === "none" &&
    (Boolean(shell.isAiResponseBubble) || MARKDOWN_DETECT_RE.test(contentStr));
  const computedUseContentEditable = hasInlineFormat || hasMarkdownStructure;
  // Pin the editor surface (textarea vs. contenteditable) for the duration
  // of an active typing session. Without this lock, typing a number + period
  // and then pressing Enter (e.g. "1.\n") flips MARKDOWN_DETECT_RE to true
  // mid-keystroke because `\d+\.\s` matches the trailing newline. That in
  // turn swaps the <textarea> out for a <div contenteditable>, which React
  // mounts unfocused — leaving the visible caret in place but routing
  // keystrokes nowhere until the user clicks out and back in. Recomputing
  // the choice only between typing sessions still lets the next focus-in
  // open the correct surface for markdown-bearing bricks.
  // (`surfaceLockRef` is declared at the top of the component to keep the
  // hook order stable across the todo-lines early-return path.)
  if (surfaceLockRef.current === null || !isTyping) {
    surfaceLockRef.current = computedUseContentEditable;
  }
  const useContentEditable = isTyping
    ? Boolean(surfaceLockRef.current)
    : computedUseContentEditable;
  if (shell.listType !== "toggle" && !useContentEditable) {
    const value = String(shell.content || "");
    const updateSlashFromCaret = (text: string, caret: number, anchor: HTMLElement | null) => {
      const upToCaret = text.slice(0, Math.max(0, Math.min(caret, text.length)));
      const lastLine = upToCaret.split("\n").pop() ?? "";
      const m = lastLine.match(/(^|(?<=\s))\/([^\n]*)$/);
      if (m) {
        setShowSlashMenu(true);
        setSlashQuery((m[2] || "").toLowerCase());
        if (anchor) {
          const rect = anchor.getBoundingClientRect();
          setSlashMenuRect({ left: rect.left + 8, top: rect.bottom + 4 });
        }
      } else {
        setShowSlashMenu(false);
        setSlashMenuRect(null);
      }
    };
    return React.createElement(
      "div",
      { className: "relative h-full w-full" },
      React.createElement("textarea", {
        ref: textareaRef,
        "data-canvas-brick-editor-id": shell.id,
        value,
        spellCheck: false,
        autoComplete: "off",
        autoCorrect: "off",
        autoCapitalize: "off",
        className: "block h-full w-full outline-none bg-transparent border-0 resize-none text-foreground",
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
          whiteSpace: "pre-wrap",
          boxSizing: "border-box",
          overflow: "hidden",
          userSelect: "text",
          WebkitUserSelect: "text",
        },
        onPointerDown: (e: any) => { e.stopPropagation(); },
        onClick: (e: any) => { e.stopPropagation(); },
        onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => {
          const nextRaw = String(e.currentTarget.value || "");
          const next = shell.listType === "todo" ? toStorageTodoMarkers(nextRaw) : nextRaw;
          const native = e.nativeEvent as InputEvent | undefined;
          const inputType = native?.inputType || "";
          const isPaste = inputType === "insertFromPaste";
          const isLineBreak = inputType === "insertLineBreak" || inputType === "insertParagraph";
          onTypingChange?.(shell.id, next, { isPaste, isLineBreak });
          const caret = e.currentTarget.selectionStart ?? nextRaw.length;
          updateSlashFromCaret(nextRaw, caret, e.currentTarget);
        },
        onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
          e.preventDefault();
          const txt = getStructuredPasteFromEvent(e);
          const el = textareaRef.current;
          if (!el) return;
          const start = el.selectionStart ?? 0;
          const end = el.selectionEnd ?? start;
          const cur = el.value;
          const nextRaw = cur.slice(0, start) + txt + cur.slice(end);
          pendingCaretRef.current = start + txt.length;
          const next = shell.listType === "todo" ? toStorageTodoMarkers(nextRaw) : nextRaw;
          onTypingChange?.(shell.id, next, { isPaste: true });
          updateSlashFromCaret(nextRaw, start + txt.length, el);
        },
        onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
            const el = e.currentTarget;
            const cur = el.value;
            const caret = el.selectionStart ?? cur.length;
            const before = cur.slice(0, caret);
            const after = cur.slice(caret);
            const lines = cur.split("\n");
            const curLineIdx = before.split("\n").length - 1;
            const curLine = lines[curLineIdx] || "";

            // Double-Enter on empty marker exits list mode
            if (shell.listType === "bullet" || shell.listType === "numbered" || shell.listType === "todo") {
              const isEmptyMarker =
                (shell.listType === "bullet" && /^•\s*$/.test(curLine)) ||
                (shell.listType === "numbered" && /^\d+\.\s*$/.test(curLine)) ||
                (shell.listType === "todo" && /^(?:◻(?:\uFE0E|\uFE0F)?|◼(?:\uFE0E|\uFE0F)?|\[[ xX]\])\s*$/.test(curLine));
              if (isEmptyMarker) {
                const newLines = [...lines];
                newLines.splice(curLineIdx, 1);
                const cleaned = newLines.join("\n");
                const text = shell.listType === "todo" ? toStorageTodoMarkers(cleaned) : cleaned;
                const caretPos = newLines.slice(0, curLineIdx).join("\n").length + (curLineIdx > 0 ? 1 : 0);
                pendingCaretRef.current = Math.max(0, Math.min(caretPos, cleaned.length));
                onTypingChange?.(shell.id, text, { exitList: true });
                return;
              }
            }

            const nextMarker =
              shell.listType === "bullet"
                ? "• "
                : shell.listType === "todo"
                  ? `${TODO_DISPLAY_EMPTY} `
                  : (() => {
                      const m = curLine.match(/^\s*(\d+)\.\s/);
                      const nextNum = m ? Number(m[1]) + 1 : lines.filter((l) => /^\s*\d+\.\s/.test(l)).length + 1;
                      return `${Math.max(1, nextNum)}. `;
                    })();
            const insertion = "\n" + nextMarker;
            const newValue = before + insertion + after;
            pendingCaretRef.current = caret + insertion.length;
            const text = shell.listType === "todo" ? toStorageTodoMarkers(newValue) : newValue;
            onTypingChange?.(shell.id, text, { isLineBreak: true });
            return;
          }
          onTypingKeyDown?.(shell.id, e as any);
        },
        onBlur: (e: React.FocusEvent<HTMLTextAreaElement>) => {
          if (applyingSlashRef.current) return;
          // The textarea's own value is the source of truth on blur. Re-assert
          // it into the store unconditionally so a save can never be skipped
          // because a prior onChange already happened to land at the same
          // value the store thought it had — the same reconcile-on-blur
          // pattern the per-row todo inputs use.
          const nextRaw = String(e.currentTarget.value || "");
          const text = shell.listType === "todo" ? toStorageTodoMarkers(nextRaw) : nextRaw;
          const storeBlock: any = useCanvasStore.getState().blocks[shell.id];
          if (storeBlock) {
            const data = storeBlock.data && typeof storeBlock.data === "object" ? { ...storeBlock.data } : {};
            // The textarea is plain text — any stale `formattedHtml` from a
            // prior contenteditable session would override the new content
            // on next render, so drop it.
            const hadFormatted = Boolean(storeBlock.data?.formattedHtml);
            if (hadFormatted) delete data.formattedHtml;
            const contentChanged = storeBlock.content !== text;
            if (contentChanged || hadFormatted) {
              updateBlock(shell.id as any, { content: text, data } as any);
            }
          }
          onTypingChange?.(shell.id, text);
          setShowSlashMenu(false);
          onTypingBlur?.(shell.id);
          setTimeout(() => window.dispatchEvent(new Event("omnia_flush_save")), 500);
        },
      }),
      slashMenuPortal
    );
  }

  // Pick the contenteditable's line-height the same way the display
  // formattedHtml path picks it: `1.5` when the surface holds block-level
  // markdown HTML (matches the live ReactMarkdown render's `1.5`),
  // `lineHeightPx` when it only holds inline highlights on plain text
  // (matches the brick grid). Without this, clicking into a markdown
  // brick used to shift line-height from `1.5` to `lineHeightPx`, and
  // then back again on blur — visible as a vertical text "jump".
  const editorFormattedHtml = String(blockData.formattedHtml || "");
  const editorHasBlocks = /<(?:p|h[1-6]|ul|ol|blockquote|pre|table)[\s>]/i.test(editorFormattedHtml);
  const editorLineHeight =
    hasMarkdownStructure || editorHasBlocks ? "1.5" : `${lineHeightPx}px`;
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
        lineHeight: editorLineHeight,
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
        const isLineBreak =
          nativeInput?.inputType === "insertParagraph" ||
          nativeInput?.inputType === "insertLineBreak";
        onTypingChange?.(shell.id, next, { isPaste, isLineBreak, preserveSize: loadedRichHtmlRef.current });
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
        onTypingChange?.(shell.id, next, { isPaste: true, preserveSize: loadedRichHtmlRef.current });
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

          // Find which line the cursor is on
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
          const curLineIdx = textBefore.split("\n").length - 1;
          const curLine = lines[curLineIdx] || "";

          // Double-Enter to exit: if cursor is on an empty marker line, remove it and exit list mode
          if (shell.listType === "bullet" || shell.listType === "numbered" || shell.listType === "todo") {
            const isEmptyMarker =
              (shell.listType === "bullet" && /^•\s*$/.test(curLine)) ||
              (shell.listType === "numbered" && /^\d+\.\s*$/.test(curLine)) ||
              (shell.listType === "todo" && /^(?:◻(?:\uFE0E|\uFE0F)?|◼(?:\uFE0E|\uFE0F)?)\s*$/.test(curLine));
            if (isEmptyMarker) {
              lines.splice(curLineIdx, 1);
              const cleaned = lines.join("\n");
              onTypingChange?.(shell.id, shell.listType === "todo" ? toStorageTodoMarkers(cleaned) : cleaned, { exitList: true });
              return;
            }
          }

          if (shell.listType === "toggle") {
            const currentLine = lines[curLineIdx] || "";
            const isOnHeader = /^[▶▼▸▾▷▽](?:\uFE0E|\uFE0F)?\s/.test(currentLine);
            const isOnChild = /^\s+/.test(currentLine);
            const isExpandedHeader = /^[▼▾▽](?:\uFE0E|\uFE0F)?\s/.test(currentLine);

            const isEmptyToggleHeader = isOnHeader && /^[▶▼▸▾▷▽](?:\uFE0E|\uFE0F)?\s*$/.test(currentLine);
            const isEmptyChild = isOnChild && /^\s*$/.test(currentLine.trim());
            if (isEmptyToggleHeader || isEmptyChild) {
              lines.splice(curLineIdx, 1);
              const cleaned = lines.join("\n");
              onTypingChange?.(shell.id, cleaned, { exitList: true });
              return;
            }

            if (isOnHeader && isExpandedHeader) {
              insertTextAtCursor("\n  ");
            } else if (isOnChild) {
              insertTextAtCursor("\n  ");
            } else {
              insertTextAtCursor("\n▷\uFE0E ");
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
        // The contenteditable is the source of truth on blur — every other
        // path (onInput, slash sync, paste) feeds the store from this same
        // surface, so re-asserting from `e.currentTarget` here means a save
        // can't be silently skipped just because a prior onInput happened to
        // already update the store to the same value (or, in race cases, to
        // a stale value the syncBrickEditorText RAF rolled it to).
        const raw = getEditorText(e.currentTarget);
        const text = shell.listType === "todo" ? toStorageTodoMarkers(raw) : raw;
        const html = e.currentTarget.innerHTML;
        const hasMarkOrColor = /<mark[\s>]|<span[^>]*data-sel-color/.test(html);
        // If the surface was seeded with rich rendered HTML on entry — either
        // restored from saved `formattedHtml` or freshly rendered from
        // markdown content — persist the resulting HTML as `formattedHtml`
        // on the way out, even when no inline mark/highlight tags are
        // present. This lets the brick reuse the rendered visual on the
        // next edit-entry instead of falling back to raw markdown source,
        // which is exactly the "format drops on click-in" behavior we're
        // fixing for AI response bubbles and other markdown-bearing bricks.
        const persistAsFormatted = hasMarkOrColor || loadedRichHtmlRef.current;
        const storeBlock: any = useCanvasStore.getState().blocks[shell.id];
        if (storeBlock) {
          const data = storeBlock.data && typeof storeBlock.data === "object" ? { ...storeBlock.data } : {};
          if (persistAsFormatted) data.formattedHtml = html;
          else delete data.formattedHtml;
          const contentChanged = storeBlock.content !== text;
          const formattedChanged = persistAsFormatted
            ? storeBlock.data?.formattedHtml !== html
            : Boolean(storeBlock.data?.formattedHtml);
          if (contentChanged || formattedChanged) {
            updateBlock(shell.id as any, { content: text, data } as any);
          }
        }
        onTypingChange?.(shell.id, text, { formattedHtml: persistAsFormatted ? html : undefined, preserveSize: persistAsFormatted });
        loadedRichHtmlRef.current = false;
        setShowSlashMenu(false);
        onTypingBlur?.(shell.id);
        setTimeout(() => window.dispatchEvent(new Event("omnia_flush_save")), 500);
      },
    }),
    slashMenuPortal
  );
}, (prev, next) => {
  if (prev.isTyping !== next.isTyping) return false;
  const ps = prev.shell, ns = next.shell;
  return ps.id === ns.id
    && ps.content === ns.content
    && ps.width === ns.width
    && ps.height === ns.height
    && ps.textVariant === ns.textVariant
    && ps.brickScale === ns.brickScale
    && ps.listType === ns.listType
    && ps.brickColor === ns.brickColor
    && ps.textColor === ns.textColor
    && ps.format === ns.format
    && ps.isAiResponseBubble === ns.isAiResponseBubble;
});

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
    let resizeRaf = 0;
    let lastWidth = startWidth;
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const deltaX = (Number(ev.clientX || 0) - startX) / z;
      const rawWidth = startWidth + deltaX;
      const snapped = Math.round(rawWidth / grid) * grid;
      lastWidth = Math.max(minWidth, Math.min(maxWidth, snapped));
      if (!resizeRaf) {
        resizeRaf = requestAnimationFrame(() => {
          resizeRaf = 0;
          opts?.onResizeWidth?.(shell.id, lastWidth);
        });
      }
    };
    const onEnd = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if (resizeRaf) { cancelAnimationFrame(resizeRaf); resizeRaf = 0; }
      opts?.onResizeWidth?.(shell.id, lastWidth);
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
    let resizeRaf = 0;
    let lastHeight = startHeight;
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const deltaY = (Number(ev.clientY || 0) - startY) / z;
      const rawHeight = startHeight + deltaY;
      const snapped = Math.round(rawHeight / grid) * grid;
      lastHeight = Math.max(minHeight, snapped);
      if (!resizeRaf) {
        resizeRaf = requestAnimationFrame(() => {
          resizeRaf = 0;
          opts?.onResizeHeight?.(shell.id, lastHeight);
        });
      }
    };
    const onEnd = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if (resizeRaf) { cancelAnimationFrame(resizeRaf); resizeRaf = 0; }
      opts?.onResizeHeight?.(shell.id, lastHeight);
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
    let scaleRaf = 0;
    let lastScale = currentScale, lastW = startWidth, lastH = startHeight;
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const deltaX = (Number(ev.clientX || 0) - startX) / z;
      const deltaY = (Number(ev.clientY || 0) - startY) / z;
      lastW = Math.max(grid * 4, Math.round((startWidth + deltaX) / grid) * grid);
      lastH = Math.max(grid, Math.round((startHeight + deltaY) / grid) * grid);
      const widthRatio = lastW / startWidth;
      lastScale = Math.max(0.5, Math.min(4, currentScale * widthRatio));
      if (!scaleRaf) {
        scaleRaf = requestAnimationFrame(() => {
          scaleRaf = 0;
          opts?.onCornerScale?.(shell.id, lastScale, lastW, lastH);
        });
      }
    };
    const onEnd = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if (scaleRaf) { cancelAnimationFrame(scaleRaf); scaleRaf = 0; }
      opts?.onCornerScale?.(shell.id, lastScale, lastW, lastH);
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

  const hasGfmTable = parseGfmTable(String(shell.content || "")) !== null;
  const hasExtraContent = Boolean(opts?.extraContent);
  const useFlexHeight = hasExtraContent || Boolean(shell.isAiResponseBubble) || hasGfmTable;
  // Bricks with `extraContent` (audio, PDF, link card, etc.) don't carry text
  // content, but still need a drag handle, hover toolbar, and connection
  // nodes — otherwise the user can't move or configure them at all.
  const hasContent = Boolean(shell.content.trim()) || hasExtraContent;

  return React.createElement(
    "div",
    {
      key,
      "data-canvas-block": true,
      "data-block-id": shell.id,
      "data-brick-shell": true,
      className: "absolute group cursor-default",
      onPointerDown: (e: any) => {
        const t = e.target as Element | null;
        if (t?.closest?.("[data-drag-handle]") || t?.closest?.("[data-resize-handle]") || t?.closest?.("[data-connection-node]")) {
          handlePointerDown(e);
        }
      },
      onClick: handleClick,
      onDoubleClick: handleDoubleClick,
      style: {
        left: `${shell.x}px`,
        top: `${shell.y}px`,
        width: `${shell.width}px`,
        ...(useFlexHeight
          ? { minHeight: `${shell.height}px`, height: "auto", display: "flex", flexDirection: "column" as const }
          : { height: `${shell.height}px` }),
        ...(isRaised ? { zIndex: 40 } : {}),
        // Only promote to a GPU layer during an active interaction (drag/raise).
        // Always-on `will-change: transform` caches each brick as a bitmap, which
        // the compositor stretches at higher canvas zoom levels — making content
        // look blurry until a repaint (e.g. clicking the brick) forces re-raster.
        ...(isRaised || isActivated ? { willChange: "transform" as const } : {}),
      },
    },
    React.createElement(
      "div",
      {
        className:
          `w-full rounded border border-white/22 ${shell.brickColor ? "" : "bg-[linear-gradient(145deg,rgba(255,255,255,0.16),rgba(255,255,255,0.06))]"} backdrop-blur-[1px]${useFlexHeight ? " flex-1" : " h-full"} relative overflow-hidden`,
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
    null,
    hasContent
      ? React.createElement("div", {
          key: "brick-drag-handle",
          "data-drag-handle": true,
          className: "absolute z-30 cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity",
          style: {
            left: "8px",
            top: "-20px",
            width: "72px",
            height: "20px",
            background: "linear-gradient(180deg, rgba(255,255,255,0.72), rgba(255,255,255,0.48))",
            backdropFilter: "blur(8px)",
            borderRadius: "8px 8px 0 0",
            border: "1px solid rgba(255,255,255,0.55)",
            borderBottom: "none",
            boxShadow: "0 -2px 8px rgba(0,0,0,0.08)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          },
          title: "Drag to move",
          onClick: (e: any) => e.stopPropagation(),
          onPointerDown: (e: any) => e.stopPropagation(),
        },
          React.createElement("span", {
            style: { width: 16, height: 2, borderRadius: 1, background: "rgba(0,0,0,0.25)" },
          })
        )
      : null,
    hasContent
      ? React.createElement(
          "div",
          {
            key: "brick-toolbar",
            className: "absolute opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-0.5",
            style: {
              top: "2px",
              right: `calc(100% + 22px)`,
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
    hasContent && typeof opts?.onConnectionDragStart === "function"
      ? renderConnectionNodes(shell.id, opts.onConnectionDragStart, 1)
      : null
  );
}

export const CONNECTION_NODE_SIZE = 10;
export const CONNECTION_NODE_GAP = 8;

export function renderConnectionNodes(
  id: string,
  onDragStart: (id: string, side: ConnectionNodeSide, e: React.PointerEvent<HTMLDivElement>) => void,
  brickScale: number = 1
) {
  const s = Math.max(0.5, brickScale);
  const nodeSize = Math.round(CONNECTION_NODE_SIZE * s);
  const nodeGap = Math.round(CONNECTION_NODE_GAP * s);
  const hitPad = nodeGap + Math.round(4 * s);
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
