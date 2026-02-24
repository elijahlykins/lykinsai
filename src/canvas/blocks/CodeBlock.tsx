import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, X } from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";
import type { CodeLanguage } from "@/canvas/types";

function normalizeNewlines(s: string) {
  return String(s ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function escapeHtmlForCode(text: string) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function insertTextAtOffset(text: string, offset: number, insert: string) {
  const s = String(text ?? "");
  const o = Math.max(0, Math.min(s.length, Math.floor(offset || 0)));
  return s.slice(0, o) + insert + s.slice(o);
}

function scrollCaretIntoView(el: HTMLElement, caretOffset: number) {
  // We render code with `whitespace-pre` (no wrapping) and fixed line-height,
  // so caret Y can be derived from newline count even when the next line is empty.
  const LINE_HEIGHT = 24;
  const PAD_TOP = 44;
  const PAD_BOTTOM = 12;
  const text = String(el.textContent ?? "");
  const o = Math.max(0, Math.min(text.length, Math.floor(caretOffset || 0)));
  const row = text.slice(0, o).split("\n").length - 1;
  const caretY = PAD_TOP + row * LINE_HEIGHT;
  const caretBottom = caretY + LINE_HEIGHT + PAD_BOTTOM;

  const viewTop = el.scrollTop;
  const viewBottom = viewTop + el.clientHeight;

  if (caretBottom > viewBottom) {
    el.scrollTop = Math.max(0, caretBottom - el.clientHeight);
  } else if (caretY < viewTop) {
    el.scrollTop = Math.max(0, caretY);
  }
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

// Preserve Enter-created line breaks: map raw text offsets into "\n"-inclusive space.
function getEditableTextWithNewlinesAndMapOffsets(rootEl: HTMLElement, rawOffsets: number[], opts?: { stripTrailingNewline?: boolean }) {
  const options = opts || {};
  const stripTrailingNewline = options.stripTrailingNewline !== false;
  const offsets = Array.isArray(rawOffsets) ? rawOffsets.slice() : [];
  const sorted = offsets
    .map((n) => (Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0))
    .sort((a, b) => a - b);

  const mapped = new Map<number, number>();
  let rawPos = 0; // concatenated text nodes
  let outPos = 0; // including inserted "\n"
  const parts: string[] = [];

  const mapAtBoundary = () => {
    while (sorted.length && sorted[0] === rawPos) {
      const k = sorted.shift()!;
      mapped.set(k, outPos);
    }
  };

  const appendText = (t: string) => {
    const text = t ?? "";
    while (sorted.length && sorted[0] >= rawPos && sorted[0] <= rawPos + text.length) {
      const k = sorted.shift()!;
      mapped.set(k, outPos + (k - rawPos));
    }
    parts.push(text);
    rawPos += text.length;
    outPos += text.length;
  };

  const appendBreak = () => {
    mapAtBoundary();
    parts.push("\n");
    outPos += 1;
  };

  const isBlockTag = (tag: string) => tag === "DIV" || tag === "P" || tag === "LI";

  const walk = (node: Node | null) => {
    if (!node) return;
    if (node.nodeType === Node.TEXT_NODE) {
      appendText((node as Text).textContent ?? "");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = (node as Element).tagName;
    if (tag === "BR") {
      appendBreak();
      return;
    }
    mapAtBoundary();
    const children = Array.from(node.childNodes || []);
    for (const child of children) walk(child);
    if (isBlockTag(tag)) appendBreak();
  };

  walk(rootEl);
  mapAtBoundary();

  let text = normalizeNewlines(parts.join(""));
  // Code blocks should preserve trailing newlines by default (Enter-at-end creates a new line).
  if (stripTrailingNewline && text.endsWith("\n")) text = text.slice(0, -1);

  const max = text.length;
  for (const [k, v] of mapped.entries()) {
    if (v > max) mapped.set(k, max);
  }
  for (const k of offsets) {
    if (!mapped.has(k)) mapped.set(k, Math.min(max, k));
  }

  return {
    text,
    mapOffset: (rawOffset: number) => mapped.get(rawOffset) ?? Math.min(text.length, Math.max(0, Math.floor(rawOffset || 0))),
  };
}

function applySyntaxHighlighting(node: HTMLElement, language: CodeLanguage) {
  if (!node || language === "plaintext") {
    node.style.color = "";
    return;
  }
  const text = node.textContent || "";
  if (!text.trim()) {
    node.style.color = "";
    return;
  }

  // Save cursor position
  const selection = window.getSelection?.();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  const offset = range && node.contains(range.startContainer) ? getCaretOffsetInElement(node) : null;

  const patterns: Record<string, any> = {
    javascript: {
      keywords:
        /\b(const|let|var|function|if|else|for|while|return|class|extends|import|export|from|default|async|await|try|catch|finally|throw|new|this|super|typeof|instanceof|in|of|true|false|null|undefined|break|continue|switch|case|do|with|yield|static|public|private|protected|abstract|interface|enum|namespace|module|require|console|log|debugger)\b/g,
      strings: /(["'`])(?:(?=(\\?))\2.)*?\1/g,
      numbers: /\b\d+\.?\d*\b/g,
      comments: /\/\/.*$|\/\*[\s\S]*?\*\//gm,
      functions: /\b\w+(?=\s*\()/g,
    },
    typescript: {
      keywords:
        /\b(const|let|var|function|if|else|for|while|return|class|extends|import|export|from|default|async|await|try|catch|finally|throw|new|this|super|typeof|instanceof|in|of|true|false|null|undefined|break|continue|switch|case|do|with|yield|static|public|private|protected|abstract|interface|enum|namespace|module|type|interface|implements|readonly|declare|namespace|module|require|console|log|debugger)\b/g,
      strings: /(["'`])(?:(?=(\\?))\2.)*?\1/g,
      numbers: /\b\d+\.?\d*\b/g,
      comments: /\/\/.*$|\/\*[\s\S]*?\*\//gm,
      functions: /\b\w+(?=\s*\()/g,
      types: /\b(string|number|boolean|any|void|object|Array|Promise|Date|RegExp)\b/g,
    },
    python: {
      keywords: /\b(def|class|if|elif|else|for|while|return|import|from|as|try|except|finally|raise|with|lambda|yield|pass|break|continue|and|or|not|in|is|True|False|None|print)\b/g,
      strings: /(["'`])(?:(?=(\\?))\2.)*?\1/g,
      numbers: /\b\d+\.?\d*\b/g,
      comments: /#.*$/gm,
      functions: /\b\w+(?=\s*\()/g,
    },
    java: {
      keywords:
        /\b(public|private|protected|static|final|abstract|class|interface|extends|implements|if|else|for|while|do|switch|case|break|continue|return|try|catch|finally|throw|new|this|super|import|package|void|int|long|float|double|boolean|char|String|true|false|null)\b/g,
      strings: /(["'])(?:(?=(\\?))\2.)*?\1/g,
      numbers: /\b\d+\.?\d*\b/g,
      comments: /\/\/.*$|\/\*[\s\S]*?\*\//gm,
      functions: /\b\w+(?=\s*\()/g,
    },
    html: {
      tags: /<\/?[\w\s="/.':;#-\/]+>/g,
      attributes: /\s+[\w-]+(?=\s*=\s*["'])/g,
      strings: /(["'])(?:(?=(\\?))\2.)*?\1/g,
      comments: /<!--[\s\S]*?-->/g,
    },
    css: {
      properties: /[\w-]+(?=\s*:)/g,
      values: /:\s*[^;]+/g,
      selectors: /[.#]?[\w-]+(?=\s*\{)/g,
      comments: /\/\*[\s\S]*?\*\//g,
    },
  };

  const langPatterns = patterns[language] || patterns.javascript;
  let html = escapeHtmlForCode(text);

  if (langPatterns.comments) html = html.replace(langPatterns.comments, (m: string) => `<span style="color:#6a9955;">${m}</span>`);
  if (langPatterns.strings) html = html.replace(langPatterns.strings, (m: string) => `<span style="color:#ce9178;">${m}</span>`);
  if (langPatterns.numbers) html = html.replace(langPatterns.numbers, (m: string) => `<span style="color:#b5cea8;">${m}</span>`);
  if (langPatterns.keywords) html = html.replace(langPatterns.keywords, (m: string) => `<span style="color:#569cd6;">${m}</span>`);
  if (langPatterns.functions) html = html.replace(langPatterns.functions, (m: string) => `<span style="color:#dcdcaa;">${m}</span>`);
  if (langPatterns.types) html = html.replace(langPatterns.types, (m: string) => `<span style="color:#4ec9b0;">${m}</span>`);
  if (langPatterns.tags) html = html.replace(langPatterns.tags, (m: string) => `<span style="color:#569cd6;">${m}</span>`);
  if (langPatterns.attributes) html = html.replace(langPatterns.attributes, (m: string) => `<span style="color:#92c5f7;">${m}</span>`);

  if (node.innerHTML !== html) {
    node.innerHTML = html;
    if (offset != null) setCaretOffsetInElement(node, offset);
  }
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

export const CodeBlock = memo(function CodeBlock({ id }: { id: string }) {
  const block = useCanvasStore((s) => s.blocks[id]);
  const bringToFront = useCanvasStore((s) => s.bringToFront);
  const selectBlocks = useCanvasStore((s) => s.selectBlocks);
  const toggleSelect = useCanvasStore((s) => s.toggleSelect);
  const isSelected = useCanvasStore((s) => s.selectedIds.includes(id));
  const updateBlock = useCanvasStore((s) => s.updateBlock);
  const pushHistory = useCanvasStore((s) => s.pushHistory);
  const deleteBlock = useCanvasStore((s) => s.deleteBlock);
  const moveBlocksFromSnapshot = useCanvasStore((s) => s.moveBlocksFromSnapshot);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [copied, setCopied] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  const langButtonRef = useRef<HTMLButtonElement | null>(null);
  const langMenuRef = useRef<HTMLDivElement | null>(null);
  const suppressBlurDeleteRef = useRef(false);

  const style = useMemo(() => {
    if (!block || block.type !== "text" || block.format !== "code") return null;
    return {
      position: "absolute" as const,
      left: `${block.x}px`,
      top: `${block.y}px`,
      width: `${block.width}px`,
      height: `${block.height}px`,
      overflow: "visible",
    };
  }, [block]);

  if (!block || block.type !== "text" || block.format !== "code" || !style) return null;

  const language = (block.language || "plaintext") as CodeLanguage;
  const languageLabel = useMemo(() => {
    const map: Record<string, string> = {
      plaintext: "Plain Text",
      javascript: "JavaScript",
      typescript: "TypeScript",
      python: "Python",
      java: "Java",
      html: "HTML",
      css: "CSS",
      json: "JSON",
      sql: "SQL",
      bash: "Bash",
      markdown: "Markdown",
    };
    return map[language] || "Language";
  }, [language]);

  const LANGUAGE_OPTIONS = useMemo(
    () =>
      [
        { value: "plaintext", label: "Plain Text" },
        { value: "javascript", label: "JavaScript" },
        { value: "typescript", label: "TypeScript" },
        { value: "python", label: "Python" },
        { value: "java", label: "Java" },
        { value: "html", label: "HTML" },
        { value: "css", label: "CSS" },
        { value: "json", label: "JSON" },
        { value: "sql", label: "SQL" },
        { value: "bash", label: "Bash" },
        { value: "markdown", label: "Markdown" },
      ] as Array<{ value: CodeLanguage; label: string }>,
    []
  );

  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    if (document.activeElement === el) return;
    const next = String(block.content ?? "");
    if ((el.textContent ?? "") !== next) el.textContent = next;
  }, [block.content]);

  useEffect(() => {
    if (!langOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (langButtonRef.current && t && langButtonRef.current.contains(t)) return;
      if (langMenuRef.current && t && langMenuRef.current.contains(t)) return;
      setLangOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [langOpen]);

  const handleCopy = useCallback(async () => {
    const text = editorRef.current?.textContent ?? "";
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  }, []);

  const setLanguage = (value: CodeLanguage) => {
    updateBlock(id, { language: value });
    const node = editorRef.current;
    if (node) requestAnimationFrame(() => applySyntaxHighlighting(node, value));
  };

  const startDragStrip = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    bringToFront(id);
    if (e.shiftKey) toggleSelect(id);
    else if (!isSelected) selectBlocks([id]);

    const state = useCanvasStore.getState();
    const sel = state.selectedIds;
    const idsForDrag = sel.includes(id) && sel.length > 1 ? sel : [id];
    const snapshot = idsForDrag.map((bid) => {
      const b = state.blocks[bid];
      return { id: bid, x: Number((b as any)?.x) || 0, y: Number((b as any)?.y) || 0 };
    });

    dragRef.current = {
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      originX: block.x,
      originY: block.y,
      raf: null,
      lastX: block.x,
      lastY: block.y,
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
    if (e.pointerType === "mouse" && e.buttons === 0) {
      dragRef.current = null;
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
      moveBlocksFromSnapshot(d2.snapshot, d2.lastX - d2.originX, d2.lastY - d2.originY, { snap: true });
    });
  };

  const onDragEnd = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    dragRef.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  return (
    <div
      data-canvas-block
      data-block-id={id}
      className="absolute group"
      style={style}
      ref={rootRef}
      onPointerDownCapture={(e) => {
        if (e.button !== 0) return;
        const t = e.target as Element | null;
        if (t?.closest?.("[data-delete-button]")) return;
        if (t?.closest?.("[data-drag-handle]")) return;
        if (e.shiftKey) toggleSelect(id);
        else if (!isSelected) selectBlocks([id]);
      }}
      onPointerDown={(e) => {
        e.stopPropagation();
        bringToFront(id);
      }}
    >
      <div
        className={`glass-block relative overflow-hidden w-full h-full ${isSelected ? "omnia-selected-glass" : ""}`}
        style={{ height: "100%" }}
      >
        <div
          data-drag-handle
          className="w-full cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ height: "8px" }}
          onPointerDown={startDragStrip}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
          onLostPointerCapture={onDragEnd}
          title="Drag to move"
        />

        {/* controls */}
        <div className="absolute top-2 right-2 z-10 flex items-center gap-2">
          <div className="relative">
            <button
              ref={langButtonRef}
              type="button"
              className="h-7 px-2 text-xs glass-control hover:opacity-90 rounded flex items-center gap-1.5 text-foreground"
              onPointerDown={(e) => {
                // Keep editor from blurring (prevents "empty blur delete" when opening menu).
                suppressBlurDeleteRef.current = true;
                e.preventDefault();
                e.stopPropagation();
                window.setTimeout(() => {
                  suppressBlurDeleteRef.current = false;
                }, 0);
              }}
              onClick={(e) => {
                e.stopPropagation();
                setLangOpen((v) => !v);
              }}
              title="Select language"
            >
              <span className="max-w-[110px] truncate">{languageLabel}</span>
              <span className="opacity-70">▾</span>
            </button>

            {langOpen && (
              <div
                ref={langMenuRef}
                className="absolute right-0 mt-1 w-44 max-h-56 overflow-auto scrollbar-hide rounded-xl border border-white/15 bg-[#1b1f2a]/95 text-white shadow-2xl backdrop-blur-xl p-1 z-50"
                onPointerDown={(e) => {
                  suppressBlurDeleteRef.current = true;
                  e.preventDefault();
                  e.stopPropagation();
                  window.setTimeout(() => {
                    suppressBlurDeleteRef.current = false;
                  }, 0);
                }}
                onClick={(e) => e.stopPropagation()}
              >
                {LANGUAGE_OPTIONS.map((opt) => {
                  const active = opt.value === language;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      className={`w-full text-left px-2 py-1.5 text-sm rounded-md transition-colors ${
                        active ? "bg-white/20" : "hover:bg-white/15"
                      }`}
                      onClick={() => {
                        setLanguage(opt.value);
                        setLangOpen(false);
                      }}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <button
            type="button"
            className="h-7 px-2 text-xs glass-control hover:opacity-90 rounded flex items-center gap-1.5 transition-colors text-foreground"
            title={copied ? "Copied!" : "Copy code"}
            onPointerDown={(e) => {
              // Keep editor from blurring (prevents "empty blur delete" when clicking Copy).
              suppressBlurDeleteRef.current = true;
              e.preventDefault();
              e.stopPropagation();
              window.setTimeout(() => {
                suppressBlurDeleteRef.current = false;
              }, 0);
            }}
            onClick={(e) => {
              e.stopPropagation();
              handleCopy();
            }}
          >
            {copied ? (
              <>
                <Check className="w-3.5 h-3.5" />
                <span>Copied</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                <span>Copy</span>
              </>
            )}
          </button>

          <button
            data-delete-button
            type="button"
            className="h-7 w-7 text-xs glass-control hover:opacity-90 rounded-full flex items-center justify-center transition-colors opacity-0 group-hover:opacity-100 transition-opacity text-black/70 dark:text-white/70 hover:text-red-500 hover:ring-2 hover:ring-red-400/35 hover:shadow-[0_0_16px_rgba(248,113,113,0.35)]"
            title="Delete"
            onPointerDown={(e) => {
              // Keep editor from blurring (prevents "empty blur delete" when clicking X).
              suppressBlurDeleteRef.current = true;
              e.preventDefault();
              e.stopPropagation();
              window.setTimeout(() => {
                suppressBlurDeleteRef.current = false;
              }, 0);
            }}
            onClick={(e) => {
              e.stopPropagation();
              pushHistory();
              deleteBlock(id);
            }}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div
          ref={editorRef}
          data-canvas-code-editor-id={id}
          contentEditable
          suppressContentEditableWarning
          spellCheck={false}
          className="outline-none whitespace-pre text-foreground scrollbar-hide"
          style={{
            fontFamily:
              'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
            fontSize: 12,
            backgroundColor: "transparent",
            padding: "44px 100px 12px 12px", // room for controls
            height: "100%",
            width: "100%",
            outline: "none",
            lineHeight: "24px",
            letterSpacing: "-0.01em",
            margin: "0px",
            minHeight: "24px",
            overflow: "auto",
          }}
          onFocus={() => {
            // Always revert highlighted HTML back to plain text while typing.
            const node = editorRef.current;
            if (!node) return;
            const mapped = getEditableTextWithNewlinesAndMapOffsets(node, [], { stripTrailingNewline: false });
            const text = mapped.text;
            if ((node.textContent ?? "") !== text || (node.innerHTML ?? "").includes("<span")) node.textContent = text;
          }}
          onBlur={(e) => {
            const node = editorRef.current;
            if (!node) return;
            const text = getEditableTextWithNewlinesAndMapOffsets(node, [], { stripTrailingNewline: false }).text;
            updateBlock(id, { content: text });
            if (language !== "plaintext" && text.trim()) requestAnimationFrame(() => applySyntaxHighlighting(node, language));
            requestAnimationFrame(() => {
              // If we're interacting with the CodeBlock controls (language menu/copy), don't auto-delete.
              if (suppressBlurDeleteRef.current) return;
              const rt = (e as any)?.relatedTarget as Node | null;
              if (rt && rootRef.current?.contains(rt)) return;
              const cur = (editorRef.current?.textContent ?? "").trim();
              if (!cur.length) deleteBlock(id);
            });
          }}
          onInput={() => {
            const node = editorRef.current;
            if (!node) return;
            const caretRaw = getCaretOffsetInElement(node);
            const mapped = getEditableTextWithNewlinesAndMapOffsets(node, [caretRaw], { stripTrailingNewline: false });
            const text = mapped.text;
            const caret = mapped.mapOffset(caretRaw);
            const html = node.innerHTML ?? "";
            if (
              (node.textContent ?? "") !== text ||
              html.includes("<span") ||
              html.includes("<div") ||
              html.includes("<br") ||
              html.includes("<p")
            ) {
              node.textContent = text;
              setCaretOffsetInElement(node, caret);
            }
            updateBlock(id, { content: text });
          }}
          onKeyDown={(e) => {
            const node = editorRef.current;
            if (!node) return;

            // Tab key: insert indentation (2 spaces)
            if (e.key === "Tab") {
              e.preventDefault();
              const caret = getCaretOffsetInElement(node);
              const next = insertTextAtOffset(node.textContent ?? "", caret, "  ");
              node.textContent = next;
              updateBlock(id, { content: next });
              requestAnimationFrame(() => setCaretOffsetInElement(node, caret + 2));
              return;
            }

            // Enter: always insert a real newline (consistent across browsers)
            if (e.key === "Enter") {
              e.preventDefault();
              const caret = getCaretOffsetInElement(node);
              const next = insertTextAtOffset(node.textContent ?? "", caret, "\n");
              node.textContent = next;
              updateBlock(id, { content: next });
              requestAnimationFrame(() => {
                setCaretOffsetInElement(node, caret + 1);
                scrollCaretIntoView(node, caret + 1);
              });
              return;
            }
          }}
        />
      </div>
    </div>
  );
});

