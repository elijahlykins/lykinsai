import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bold, Italic, Underline, Strikethrough,
  AlignLeft, AlignCenter, AlignRight, AlignJustify,
  List, ListOrdered,
  Undo2, Redo2, Minus, FileText,
} from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";
import { snapToGrid } from "@/canvas/utils/snap";
import { BlockHoverToolbar } from "./BlockHoverToolbar";

type PageData = {
  html: string;
  title: string;
};

const DEFAULT_PAGE_DATA: PageData = {
  html: "<p><br></p>",
  title: "Untitled",
};

function parsePage(content: string): PageData {
  try {
    const d = JSON.parse(content);
    return { html: d.html ?? DEFAULT_PAGE_DATA.html, title: d.title ?? DEFAULT_PAGE_DATA.title };
  } catch {
    return { ...DEFAULT_PAGE_DATA };
  }
}

const FONT_SIZES = [10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48];

const FONT_SIZE_MAP: Record<string, number> = {
  "1": 10, "2": 13, "3": 16, "4": 18, "5": 24, "6": 32, "7": 48,
};

function getComputedFontSize(): number {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return 14;
  let node: Node | null = sel.focusNode;
  while (node && !(node instanceof HTMLElement)) node = node.parentNode;
  if (!node) return 14;
  const px = parseFloat(window.getComputedStyle(node as HTMLElement).fontSize);
  return isNaN(px) ? 14 : Math.round(px);
}

const ToolbarButton = memo(function ToolbarButton({
  icon: Icon, title, active, onClick, disabled, children,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  title: string;
  active?: boolean;
  onClick: () => void;
  disabled?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onMouseDown={(e) => { e.preventDefault(); onClick(); }}
      disabled={disabled}
      className={`flex items-center justify-center rounded transition-colors ${
        active ? "bg-blue-500/15 text-blue-600" : "hover:bg-black/8 text-black/70"
      } ${disabled ? "opacity-30 pointer-events-none" : ""}`}
      style={{ width: 26, height: 26, flexShrink: 0 }}
    >
      {Icon ? <Icon className="w-3.5 h-3.5" /> : children}
    </button>
  );
});

const ToolbarSep = () => <div className="w-px h-4 bg-black/10 mx-0.5 shrink-0" />;

export const PageBlock = memo(function PageBlock({ id, onMinimize, onMenu }: { id: string; onMinimize?: (id: string) => void; onMenu?: (id: string, rect: DOMRect) => void }) {
  const block = useCanvasStore((s) => s.blocks[id]) as any;
  const updateBlock = useCanvasStore((s) => s.updateBlock);
  const pushHistory = useCanvasStore((s) => s.pushHistory);
  const gridSize = 24;

  const editorRef = useRef<HTMLDivElement | null>(null);
  const resizeRef = useRef<any>(null);
  const endResizeCleanupRef = useRef<(() => void) | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);
  const initializedRef = useRef(false);
  const savedSelectionRef = useRef<Range | null>(null);
  const titleValueRef = useRef<string>("");

  const [fontSize, setFontSize] = useState(14);
  const [fontSizeOpen, setFontSizeOpen] = useState(false);
  const [activeFormats, setActiveFormats] = useState<Record<string, boolean>>({});
  const [activeAlign, setActiveAlign] = useState("left");
  const [activeBlock, setActiveBlock] = useState("p");

  const pageData = useMemo(() => parsePage(String(block?.content ?? "")), [block?.content]);

  useEffect(() => {
    if (!editorRef.current || initializedRef.current) return;
    editorRef.current.innerHTML = pageData.html;
    titleValueRef.current = pageData.title;
    initializedRef.current = true;
  }, [pageData.html, pageData.title]);

  const saveSelection = () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && editorRef.current?.contains(sel.anchorNode)) {
      savedSelectionRef.current = sel.getRangeAt(0).cloneRange();
    }
  };

  const restoreSelection = () => {
    const range = savedSelectionRef.current;
    if (!range) return;
    try {
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } catch {}
  };

  const style = useMemo(() => {
    if (!block || block.type !== "text" || block.format !== "page") return null;
    return {
      position: "absolute" as const,
      left: `${block.x}px`,
      top: `${block.y}px`,
      width: `${block.width}px`,
      height: `${block.height}px`,
      overflow: "visible",
    };
  }, [block]);

  if (!block || block.type !== "text" || block.format !== "page" || !style) return null;

  const save = (html?: string) => {
    const finalHtml = html ?? editorRef.current?.innerHTML ?? pageData.html;
    const title = titleValueRef.current || pageData.title;
    const data: PageData = { html: finalHtml, title };
    pushHistory();
    updateBlock(id, { content: JSON.stringify(data) } as any);
  };

  const debouncedSave = (html?: string) => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => save(html), 400) as unknown as number;
  };

  const saveTitle = (title: string) => {
    titleValueRef.current = title || "Untitled";
    const data: PageData = { html: editorRef.current?.innerHTML ?? pageData.html, title: titleValueRef.current };
    pushHistory();
    updateBlock(id, { content: JSON.stringify(data) } as any);
  };

  const exec = (cmd: string, value?: string) => {
    restoreSelection();
    editorRef.current?.focus();
    document.execCommand(cmd, false, value);
    updateFormats();
    debouncedSave();
  };

  const updateFormats = () => {
    setActiveFormats({
      bold: document.queryCommandState("bold"),
      italic: document.queryCommandState("italic"),
      underline: document.queryCommandState("underline"),
      strikeThrough: document.queryCommandState("strikeThrough"),
    });

    const jl = document.queryCommandState("justifyLeft");
    const jc = document.queryCommandState("justifyCenter");
    const jr = document.queryCommandState("justifyRight");
    const jf = document.queryCommandState("justifyFull");
    setActiveAlign(jc ? "center" : jr ? "right" : jf ? "justify" : "left");

    const fb = document.queryCommandValue("formatBlock").toLowerCase().replace(/[<>]/g, "");
    setActiveBlock(fb || "p");

    setFontSize(getComputedFontSize());
  };

  const snapSize = (n: number) => Math.max(gridSize, snapToGrid(n, gridSize));

  const endResize = (pointerId: number) => {
    const r = resizeRef.current;
    if (!r || r.pointerId !== pointerId) return;
    if (r.raf != null) window.cancelAnimationFrame(r.raf);
    if (endResizeCleanupRef.current) {
      try { endResizeCleanupRef.current(); } catch {}
      endResizeCleanupRef.current = null;
    }
    if (r.capturer) {
      try { r.capturer.releasePointerCapture(pointerId); } catch {}
    }
    resizeRef.current = null;
  };

  const installGlobalResizeEndHandlers = (pointerId: number) => {
    const onUp = (ev: PointerEvent) => { if (ev.pointerId === pointerId) endResize(pointerId); };
    const onCancel = (ev: PointerEvent) => { if (ev.pointerId === pointerId) endResize(pointerId); };
    const onBlur = () => endResize(pointerId);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onCancel, true);
    window.addEventListener("blur", onBlur, true);
    endResizeCleanupRef.current = () => {
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onCancel, true);
      window.removeEventListener("blur", onBlur, true);
    };
  };

  const beginResize = (e: React.PointerEvent, mode: "right" | "bottom" | "corner") => {
    e.stopPropagation(); e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    resizeRef.current = {
      mode, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY,
      origW: block.width, origH: block.height, raf: null as number | null, capturer: el,
    };
    installGlobalResizeEndHandlers(e.pointerId);
  };

  const onResizeMove = (e: React.PointerEvent) => {
    const r = resizeRef.current;
    if (!r || r.pointerId !== e.pointerId) return;
    if (r.raf != null) window.cancelAnimationFrame(r.raf);
    const dx = e.clientX - r.startX;
    const dy = e.clientY - r.startY;
    r.raf = window.requestAnimationFrame(() => {
      const newW = r.mode !== "bottom" ? snapSize(r.origW + dx) : r.origW;
      const newH = r.mode !== "right" ? snapSize(r.origH + dy) : r.origH;
      updateBlock(id, { width: newW, height: newH } as any);
    });
  };

  const toolbarH = 36;

  const applyFontSize = (sizePx: number) => {
    restoreSelection();
    editorRef.current?.focus();
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      setFontSize(sizePx);
      setFontSizeOpen(false);
      return;
    }
    document.execCommand("fontSize", false, "7");
    const editor = editorRef.current;
    if (editor) {
      const fontEls = editor.querySelectorAll('font[size="7"]');
      fontEls.forEach((el) => {
        const span = document.createElement("span");
        span.style.fontSize = `${sizePx}px`;
        span.innerHTML = (el as HTMLElement).innerHTML;
        el.parentNode?.replaceChild(span, el);
      });
    }
    setFontSize(sizePx);
    setFontSizeOpen(false);
    debouncedSave();
  };

  return (
    <div
      data-canvas-block
      data-block-id={id}
      style={style}
      onPointerDown={(e) => {
        if ((e.target as Element)?.closest?.("[data-resize-handle]")) return;
      }}
      className="group"
    >
      <BlockHoverToolbar blockId={id} onMinimize={onMinimize} onMenu={onMenu} />
      <div
        className="w-full h-full rounded-lg border border-black/12 bg-white shadow-lg flex flex-col overflow-hidden"
        style={{ boxShadow: "0 4px 24px rgba(0,0,0,0.10), 0 1px 3px rgba(0,0,0,0.06)" }}
      >
        {/* Toolbar */}
        <div
          className="flex items-center gap-0.5 px-2 border-b border-black/8 bg-gray-50/80 shrink-0 overflow-x-auto scrollbar-hide"
          style={{ height: toolbarH }}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => {
            if ((e.target as Element)?.tagName !== "SELECT") {
              saveSelection();
            }
          }}
        >
          <ToolbarButton icon={Undo2} title="Undo" onClick={() => exec("undo")} />
          <ToolbarButton icon={Redo2} title="Redo" onClick={() => exec("redo")} />
          <ToolbarSep />

          {/* Block type */}
          <select
            className="text-xs bg-transparent border border-black/10 rounded px-1 py-0.5 outline-none cursor-pointer hover:bg-black/5"
            style={{ height: 24, minWidth: 70 }}
            value={activeBlock}
            onMouseDown={() => saveSelection()}
            onChange={(e) => {
              const tag = e.target.value;
              exec("formatBlock", `<${tag}>`);
            }}
          >
            <option value="p">Normal</option>
            <option value="h1">Heading 1</option>
            <option value="h2">Heading 2</option>
            <option value="h3">Heading 3</option>
          </select>

          <ToolbarSep />

          {/* Font size */}
          <div className="relative">
            <button
              type="button"
              className="flex items-center gap-0.5 text-xs border border-black/10 rounded px-1.5 py-0.5 hover:bg-black/5"
              style={{ height: 24, minWidth: 36 }}
              onMouseDown={(e) => { e.preventDefault(); saveSelection(); setFontSizeOpen(!fontSizeOpen); }}
            >
              {fontSize}
            </button>
            {fontSizeOpen && (
              <div className="absolute top-full left-0 mt-1 bg-white border border-black/12 rounded-md shadow-lg z-50 py-1 max-h-40 overflow-y-auto" style={{ minWidth: 48 }}>
                {FONT_SIZES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={`block w-full text-left text-xs px-2 py-1 hover:bg-blue-50 ${s === fontSize ? "text-blue-600 font-medium" : ""}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      applyFontSize(s);
                    }}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>

          <ToolbarSep />
          <ToolbarButton icon={Bold} title="Bold (⌘B)" active={activeFormats.bold} onClick={() => exec("bold")} />
          <ToolbarButton icon={Italic} title="Italic (⌘I)" active={activeFormats.italic} onClick={() => exec("italic")} />
          <ToolbarButton icon={Underline} title="Underline (⌘U)" active={activeFormats.underline} onClick={() => exec("underline")} />
          <ToolbarButton icon={Strikethrough} title="Strikethrough" active={activeFormats.strikeThrough} onClick={() => exec("strikeThrough")} />
          <ToolbarSep />
          <ToolbarButton icon={AlignLeft} title="Align Left" active={activeAlign === "left"} onClick={() => exec("justifyLeft")} />
          <ToolbarButton icon={AlignCenter} title="Align Center" active={activeAlign === "center"} onClick={() => exec("justifyCenter")} />
          <ToolbarButton icon={AlignRight} title="Align Right" active={activeAlign === "right"} onClick={() => exec("justifyRight")} />
          <ToolbarButton icon={AlignJustify} title="Justify" active={activeAlign === "justify"} onClick={() => exec("justifyFull")} />
          <ToolbarSep />
          <ToolbarButton icon={List} title="Bullet List" onClick={() => exec("insertUnorderedList")} />
          <ToolbarButton icon={ListOrdered} title="Numbered List" onClick={() => exec("insertOrderedList")} />
          <ToolbarButton icon={Minus} title="Horizontal Rule" onClick={() => exec("insertHorizontalRule")} />
        </div>

        {/* Title */}
        <div className="px-6 pt-3 pb-1 shrink-0" onPointerDown={(e) => e.stopPropagation()}>
          <input
            ref={titleRef}
            className="w-full text-lg font-semibold text-black/85 bg-transparent outline-none border-none placeholder:text-black/30"
            placeholder="Untitled"
            defaultValue={pageData.title === "Untitled" ? "" : pageData.title}
            onBlur={(e) => saveTitle(e.target.value || "Untitled")}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); editorRef.current?.focus(); } }}
          />
          <div className="h-px bg-black/8 mt-2" />
        </div>

        {/* Editor */}
        <div
          className="flex-1 overflow-y-auto overflow-x-hidden px-6 py-3"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div
            ref={editorRef}
            contentEditable
            suppressContentEditableWarning
            className="outline-none min-h-full text-black/80 page-editor-content"
            style={{
              fontFamily: '"Times New Roman", Georgia, serif',
              fontSize: "14px",
              lineHeight: "1.8",
              wordBreak: "break-word",
            }}
            onInput={() => debouncedSave(editorRef.current?.innerHTML)}
            onSelect={() => { saveSelection(); updateFormats(); }}
            onKeyUp={() => { saveSelection(); updateFormats(); }}
            onMouseUp={() => { saveSelection(); updateFormats(); }}
            onFocus={() => { if (savedSelectionRef.current) restoreSelection(); }}
          />
        </div>
      </div>

      {/* Resize handles */}
      <div
        data-resize-handle
        className="absolute top-0 right-0 h-full w-2 cursor-ew-resize opacity-0 group-hover:opacity-100 hover:bg-blue-400/20 transition-opacity rounded-r"
        onPointerDown={(e) => beginResize(e, "right")}
        onPointerMove={onResizeMove}
      />
      <div
        data-resize-handle
        className="absolute bottom-0 left-0 w-full h-2 cursor-ns-resize opacity-0 group-hover:opacity-100 hover:bg-blue-400/20 transition-opacity rounded-b"
        onPointerDown={(e) => beginResize(e, "bottom")}
        onPointerMove={onResizeMove}
      />
      <div
        data-resize-handle
        className="absolute bottom-0 right-0 w-4 h-4 cursor-nwse-resize opacity-0 group-hover:opacity-100 transition-opacity z-10"
        onPointerDown={(e) => beginResize(e, "corner")}
        onPointerMove={onResizeMove}
      >
        <svg viewBox="0 0 16 16" className="w-full h-full text-black/25">
          <path d="M14 14L6 14M14 14L14 6M14 14L8 8" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
        </svg>
      </div>
    </div>
  );
});
