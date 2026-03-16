import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Copy, Check, Play, Square, ChevronUp, Trash2 } from "lucide-react";
import { Highlight, themes } from "prism-react-renderer";
import { useCanvasStore } from "@/store/canvasStore";
import { snapToGrid } from "@/canvas/utils/snap";
import { BlockHoverToolbar } from "./BlockHoverToolbar";

const LANGUAGES = [
  { id: "plaintext", label: "Plain Text" },
  { id: "javascript", label: "JavaScript" },
  { id: "typescript", label: "TypeScript" },
  { id: "jsx", label: "JSX" },
  { id: "tsx", label: "TSX" },
  { id: "python", label: "Python" },
  { id: "java", label: "Java" },
  { id: "html", label: "HTML" },
  { id: "css", label: "CSS" },
  { id: "json", label: "JSON" },
  { id: "sql", label: "SQL" },
  { id: "bash", label: "Bash" },
  { id: "markdown", label: "Markdown" },
  { id: "go", label: "Go" },
  { id: "rust", label: "Rust" },
  { id: "cpp", label: "C++" },
  { id: "c", label: "C" },
  { id: "csharp", label: "C#" },
  { id: "ruby", label: "Ruby" },
  { id: "php", label: "PHP" },
  { id: "swift", label: "Swift" },
  { id: "kotlin", label: "Kotlin" },
  { id: "yaml", label: "YAML" },
  { id: "xml", label: "XML" },
  { id: "graphql", label: "GraphQL" },
] as const;

type LanguageId = (typeof LANGUAGES)[number]["id"];

const RUNNABLE_LANGUAGES = new Set(["javascript", "typescript", "jsx", "tsx", "html"]);

type OutputLine = { type: "log" | "warn" | "error" | "result" | "info"; text: string; ts: number };

function runCodeInSandbox(
  code: string,
  language: string,
  onOutput: (line: OutputLine) => void,
  onDone: () => void,
): () => void {
  const iframe = document.createElement("iframe");
  iframe.sandbox.add("allow-scripts");
  iframe.style.display = "none";
  document.body.appendChild(iframe);

  let dead = false;
  const timeout = setTimeout(() => {
    if (!dead) {
      onOutput({ type: "error", text: "Execution timed out (10s)", ts: Date.now() });
      cleanup();
    }
  }, 10_000);

  const cleanup = () => {
    if (dead) return;
    dead = true;
    clearTimeout(timeout);
    window.removeEventListener("message", handler);
    try { document.body.removeChild(iframe); } catch {} // eslint-disable-line no-empty
    onDone();
  };

  const handler = (e: MessageEvent) => {
    if (e.source !== iframe.contentWindow) return;
    const d = e.data;
    if (d?.__sandbox === "output") {
      onOutput({ type: d.level || "log", text: String(d.text ?? ""), ts: Date.now() });
    } else if (d?.__sandbox === "done") {
      cleanup();
    }
  };
  window.addEventListener("message", handler);

  const isHtml = language === "html";
  const wrappedCode = isHtml
    ? code
    : `
<html><body><script>
(function(){
  var _post = window.parent.postMessage.bind(window.parent);
  var _fmt = function(a){ return Array.prototype.map.call(a, function(v){
    if(v === undefined) return "undefined";
    if(v === null) return "null";
    if(typeof v === "object") try{ return JSON.stringify(v,null,2); }catch(e){ return String(v); }
    return String(v);
  }).join(" "); };
  console.log = function(){ _post({__sandbox:"output",level:"log",text:_fmt(arguments)},"*"); };
  console.warn = function(){ _post({__sandbox:"output",level:"warn",text:_fmt(arguments)},"*"); };
  console.error = function(){ _post({__sandbox:"output",level:"error",text:_fmt(arguments)},"*"); };
  console.info = function(){ _post({__sandbox:"output",level:"info",text:_fmt(arguments)},"*"); };
  try {
    var __result = eval(${JSON.stringify(code)});
    if(__result !== undefined) _post({__sandbox:"output",level:"result",text:_fmt([__result])},"*");
  } catch(err) {
    _post({__sandbox:"output",level:"error",text: err.name + ": " + err.message},"*");
  }
  _post({__sandbox:"done"},"*");
})();
<\/script></body></html>`;

  iframe.srcdoc = wrappedCode;
  return cleanup;
}

export const CodeBlock = memo(function CodeBlock({ id, onMinimize, onMenu }: { id: string; onMinimize?: (id: string) => void; onMenu?: (id: string, rect: DOMRect) => void }) {
  const block = useCanvasStore((s) => s.blocks[id]);
  const selectBlocks = useCanvasStore((s) => s.selectBlocks);
  const toggleSelect = useCanvasStore((s) => s.toggleSelect);
  const isSelected = useCanvasStore((s) => s.selectedIds.includes(id));
  const updateBlock = useCanvasStore((s) => s.updateBlock);
  const pushHistory = useCanvasStore((s) => s.pushHistory);
  const gridSize = useCanvasStore((s) => s.gridSize);
  const moveBlocksFromSnapshot = useCanvasStore((s) => s.moveBlocksFromSnapshot);

  const dragRef = useRef<any>(null);
  const resizeRef = useRef<any>(null);
  const endResizeCleanupRef = useRef<(() => void) | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);

  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [langDropdownOpen, setLangDropdownOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [langSearch, setLangSearch] = useState("");
  const langSearchRef = useRef<HTMLInputElement | null>(null);

  const [outputLines, setOutputLines] = useState<OutputLine[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [showOutput, setShowOutput] = useState(false);
  const killRef = useRef<(() => void) | null>(null);

  const language = String((block as any)?.language || "plaintext") as LanguageId;
  const content = String((block as any)?.content ?? "");

  const langLabel = LANGUAGES.find((l) => l.id === language)?.label ?? language;

  const filteredLangs = useMemo(() => {
    if (!langSearch) return LANGUAGES;
    const q = langSearch.toLowerCase();
    return LANGUAGES.filter((l) => l.id.includes(q) || l.label.toLowerCase().includes(q));
  }, [langSearch]);

  useEffect(() => {
    if (langDropdownOpen) {
      setLangSearch("");
      setTimeout(() => langSearchRef.current?.focus(), 50);
      const close = (e: PointerEvent) => {
        const t = e.target as Element | null;
        if (!t?.closest?.(`[data-block-id="${id}"]`)) setLangDropdownOpen(false);
      };
      window.addEventListener("pointerdown", close, true);
      return () => window.removeEventListener("pointerdown", close, true);
    }
  }, [langDropdownOpen, id]);

  const setLanguage = useCallback(
    (lang: string) => {
      pushHistory();
      updateBlock(id, { language: lang } as any);
      setLangDropdownOpen(false);
    },
    [id, pushHistory, updateBlock]
  );

  const copyToClipboard = useCallback(() => {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [content]);

  const startEditing = useCallback(() => {
    setEditValue(content);
    setIsEditing(true);
    setTimeout(() => editorRef.current?.focus(), 30);
  }, [content]);

  const commitEdit = useCallback(() => {
    setIsEditing(false);
    if (editValue !== content) {
      pushHistory();
      updateBlock(id, { content: editValue } as any);
    }
  }, [editValue, content, id, pushHistory, updateBlock]);

  /* ── Run code ────────────────────────────────────────────────────────── */

  const canRun = RUNNABLE_LANGUAGES.has(language);

  const runCode = useCallback(() => {
    if (!content.trim() || isRunning) return;
    if (killRef.current) killRef.current();
    setOutputLines([]);
    setShowOutput(true);
    setIsRunning(true);
    const startTs = Date.now();
    killRef.current = runCodeInSandbox(
      content,
      language,
      (line) => setOutputLines((prev) => [...prev, line]),
      () => {
        const elapsed = Date.now() - startTs;
        setOutputLines((prev) => [
          ...prev,
          { type: "info", text: `Finished in ${elapsed}ms`, ts: Date.now() },
        ]);
        setIsRunning(false);
        killRef.current = null;
      },
    );
  }, [content, language, isRunning]);

  const stopCode = useCallback(() => {
    if (killRef.current) {
      killRef.current();
      killRef.current = null;
    }
    setIsRunning(false);
    setOutputLines((prev) => [
      ...prev,
      { type: "warn", text: "Execution stopped", ts: Date.now() },
    ]);
  }, []);

  useEffect(() => {
    return () => { if (killRef.current) killRef.current(); };
  }, []);

  /* ── Style ─────────────────────────────────────────────────────────── */

  const style = useMemo(() => {
    if (!block || block.type !== "text" || (block as any).format !== "code") return null;
    return {
      position: "absolute" as const,
      left: `${block.x}px`,
      top: `${block.y}px`,
      width: `${block.width}px`,
      height: `${block.height}px`,
      overflow: "visible",
    };
  }, [block]);

  if (!block || block.type !== "text" || (block as any).format !== "code" || !style) return null;

  /* ── Drag / Resize ─────────────────────────────────────────────────── */

  const snapSize = (n: number) => {
    const g = Math.max(1, Math.floor(gridSize || 24));
    return Math.max(g, snapToGrid(n, g));
  };

  const endResize = (pointerId: number) => {
    const r = resizeRef.current;
    if (!r || r.pointerId !== pointerId) return;
    if (r.raf != null) window.cancelAnimationFrame(r.raf);
    if (endResizeCleanupRef.current) {
      try { endResizeCleanupRef.current(); } catch {} // eslint-disable-line no-empty
      endResizeCleanupRef.current = null;
    }
    if (r.capturer) {
      try { r.capturer.releasePointerCapture(pointerId); } catch {} // eslint-disable-line no-empty
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
    if (!isSelected) selectBlocks([id]);
    pushHistory();
    const capturer = e.currentTarget as HTMLElement;
    resizeRef.current = {
      pointerId: e.pointerId, mode, startClientX: e.clientX, startClientY: e.clientY,
      startW: block.width, startH: block.height, raf: null, capturer,
    };
    installGlobalResizeEndHandlers(e.pointerId);
    try { capturer.setPointerCapture(e.pointerId); } catch {} // eslint-disable-line no-empty
  };

  const startDrag = (e: React.PointerEvent) => {
    e.stopPropagation(); e.preventDefault();
    if (e.shiftKey) toggleSelect(id); else if (!isSelected) selectBlocks([id]);
    pushHistory();
    const state = useCanvasStore.getState();
    const sel = state.selectedIds;
    const idsForDrag = sel.includes(id) && sel.length > 1 ? sel : [id];
    const snapshot = idsForDrag.map((bid) => {
      const b = state.blocks[bid];
      return { id: bid, x: Number((b as any)?.x) || 0, y: Number((b as any)?.y) || 0 };
    });
    dragRef.current = {
      pointerId: e.pointerId, startClientX: e.clientX, startClientY: e.clientY,
      originX: block.x, originY: block.y, raf: null, lastX: block.x, lastY: block.y,
      snapshot, capturer: e.currentTarget as HTMLElement,
    };
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch {} // eslint-disable-line no-empty
  };

  const onDragMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    if (e.pointerType === "mouse" && e.buttons === 0) { dragRef.current = null; return; }
    const z = (useCanvasStore.getState() as any).camera?.zoom || 1;
    d.lastX = d.originX + (e.clientX - d.startClientX) / z;
    d.lastY = d.originY + (e.clientY - d.startClientY) / z;
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
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch {} // eslint-disable-line no-empty
  };

  /* ── Prism language key mapping ────────────────────────────────────── */
  const prismLang = language === "plaintext" ? "markup" : language;

  /* ── Render ────────────────────────────────────────────────────────── */

  return (
    <div
      data-canvas-block data-self-drag data-block-id={id}
      className="absolute group" style={style}
      onPointerDownCapture={(e) => {
        if (e.button !== 0) return;
        const t = e.target as Element | null;
        if (t?.closest?.("[data-resize-handle]") || t?.closest?.("[data-drag-handle]")) return;
        if (e.shiftKey) toggleSelect(id); else if (!isSelected) selectBlocks([id]);
      }}
      onPointerMove={(e) => {
        const r = resizeRef.current;
        if (!r || r.pointerId !== e.pointerId) return;
        if (e.pointerType === "mouse" && e.buttons === 0) { endResize(e.pointerId); return; }
        const rz = (useCanvasStore.getState() as any).camera?.zoom || 1;
        const dx = (e.clientX - r.startClientX) / rz;
        const dy = (e.clientY - r.startClientY) / rz;
        if (r.raf != null) return;
        r.raf = window.requestAnimationFrame(() => {
          const rr = resizeRef.current;
          if (!rr) return;
          rr.raf = null;
          const g = Math.max(1, Math.floor(gridSize || 24));
          const minW = g * 8;
          const minH = g * 5;
          if (rr.mode === "right") { updateBlock(id, { width: Math.max(minW, snapSize(rr.startW + dx)) } as any); return; }
          if (rr.mode === "bottom") { updateBlock(id, { height: Math.max(minH, snapSize(rr.startH + dy)) } as any); return; }
          updateBlock(id, { width: Math.max(minW, snapSize(rr.startW + dx)), height: Math.max(minH, snapSize(rr.startH + dy)) } as any);
        });
      }}
      onPointerUp={(e) => endResize(e.pointerId)}
      onPointerCancel={(e) => endResize(e.pointerId)}
      onLostPointerCapture={(e) => endResize(e.pointerId)}
    >
      <BlockHoverToolbar blockId={id} onMinimize={onMinimize} onMenu={onMenu} />
      <div
        className={`overflow-hidden relative rounded-lg border ${
          isSelected
            ? "border-blue-400/60 shadow-[0_0_0_2px_rgba(59,130,246,0.25)]"
            : "border-white/20 shadow-[0_8px_24px_rgba(0,0,0,0.25)]"
        }`}
        style={{ width: "100%", height: "100%", background: "#1e1e2e" }}
      >
        {/* Header bar (also serves as drag handle) */}
        <div
          data-drag-handle
          className="flex items-center justify-between px-3 h-9 border-b border-white/10 select-none cursor-grab active:cursor-grabbing"
          style={{ background: "rgba(255,255,255,0.04)" }}
          onPointerDown={startDrag}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
          onLostPointerCapture={onDragEnd}
        >
          <div className="flex items-center gap-2">
            {/* Language selector */}
            <div className="relative">
              <button
                type="button"
                className="flex items-center gap-1 px-2 py-0.5 rounded text-[0.6875rem] font-medium text-white/70 hover:text-white hover:bg-white/10 transition-colors"
                onClick={(e) => { e.stopPropagation(); setLangDropdownOpen((v) => !v); }}
                onPointerDown={(e) => e.stopPropagation()}
              >
                {langLabel}
                <ChevronDown className="w-3 h-3 opacity-60" />
              </button>

              {langDropdownOpen && (
                <div
                  className="absolute left-0 top-full mt-1 w-48 max-h-64 rounded-lg border border-white/15 bg-[#1e1e2e] shadow-[0_12px_32px_rgba(0,0,0,0.5)] z-[100] flex flex-col overflow-hidden"
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  <div className="px-2 pt-2 pb-1">
                    <input
                      ref={langSearchRef}
                      type="text"
                      value={langSearch}
                      onChange={(e) => setLangSearch(e.target.value)}
                      placeholder="Search languages..."
                      className="w-full px-2 py-1 text-[0.6875rem] rounded bg-white/8 border border-white/10 text-white/80 placeholder:text-white/30 outline-none focus:border-white/25"
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setLangDropdownOpen(false);
                        if (e.key === "Enter" && filteredLangs.length > 0) {
                          setLanguage(filteredLangs[0].id);
                        }
                      }}
                    />
                  </div>
                  <div className="overflow-y-auto scrollbar-hide flex-1 p-1">
                    {filteredLangs.map((lang) => (
                      <button
                        key={lang.id}
                        type="button"
                        className={`w-full text-left px-2 py-1 rounded text-[0.6875rem] transition-colors ${
                          lang.id === language
                            ? "bg-blue-500/20 text-blue-300"
                            : "text-white/60 hover:text-white/90 hover:bg-white/8"
                        }`}
                        onClick={() => setLanguage(lang.id)}
                      >
                        {lang.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1">
            {/* Run / Stop button */}
            {canRun && (
              isRunning ? (
                <button
                  type="button"
                  className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[0.625rem] font-medium text-red-400 hover:bg-red-500/15 transition-colors"
                  onClick={(e) => { e.stopPropagation(); stopCode(); }}
                  onPointerDown={(e) => e.stopPropagation()}
                  title="Stop execution"
                >
                  <Square className="w-3 h-3 fill-current" />
                  Stop
                </button>
              ) : (
                <button
                  type="button"
                  className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[0.625rem] font-medium text-green-400 hover:bg-green-500/15 transition-colors"
                  onClick={(e) => { e.stopPropagation(); runCode(); }}
                  onPointerDown={(e) => e.stopPropagation()}
                  title="Run code"
                >
                  <Play className="w-3 h-3 fill-current" />
                  Run
                </button>
              )
            )}

            {/* Copy button */}
            <button
              type="button"
              className="p-1 rounded text-white/40 hover:text-white/80 hover:bg-white/10 transition-colors"
              onClick={(e) => { e.stopPropagation(); copyToClipboard(); }}
              onPointerDown={(e) => e.stopPropagation()}
              title="Copy code"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
            </button>

          </div>
        </div>

        {/* Code area */}
        <div
          className="flex-1 overflow-hidden relative"
          style={{ height: showOutput ? "calc(100% - 36px - 140px)" : "calc(100% - 36px)" }}
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => { e.stopPropagation(); if (!isEditing) startEditing(); }}
        >
          {isEditing ? (
            <div className="flex w-full h-full overflow-hidden">
              {/* Line number gutter */}
              <div
                className="shrink-0 pt-3 pb-3 pr-2 text-right select-none overflow-hidden"
                style={{
                  fontFamily: "'SF Mono', 'Fira Code', 'JetBrains Mono', Menlo, Monaco, 'Courier New', monospace",
                  fontSize: "0.6875rem",
                  lineHeight: "1.5rem",
                  color: "rgba(255,255,255,0.2)",
                  width: "3rem",
                  paddingTop: "12px",
                }}
              >
                {(editValue || " ").split("\n").map((_, i) => (
                  <div key={i}>{i + 1}</div>
                ))}
              </div>
              <textarea
                ref={editorRef}
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={commitEdit}
                onKeyDown={(e) => {
                  if (e.key === "Escape") { commitEdit(); e.preventDefault(); }
                  if (e.key === "Tab") {
                    e.preventDefault();
                    const ta = e.currentTarget;
                    const start = ta.selectionStart;
                    const end = ta.selectionEnd;
                    const next = editValue.substring(0, start) + "  " + editValue.substring(end);
                    setEditValue(next);
                    requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = start + 2; });
                  }
                }}
                spellCheck={false}
                className="flex-1 h-full resize-none outline-none py-3 pr-4 text-[0.8125rem] leading-6 scrollbar-hide"
                style={{
                  background: "transparent",
                  color: "#cdd6f4",
                  fontFamily: "'SF Mono', 'Fira Code', 'JetBrains Mono', Menlo, Monaco, 'Courier New', monospace",
                  tabSize: 2,
                  caretColor: "#89b4fa",
                  overflowY: "auto",
                }}
              />
            </div>
          ) : (
            <div
              className="w-full h-full overflow-hidden cursor-text"
              onClick={() => { if (!content) startEditing(); }}
            >
              {content ? (
                <Highlight theme={themes.vsDark} code={content} language={prismLang}>
                  {({ tokens, getLineProps, getTokenProps }) => (
                    <pre
                      className="py-3 m-0 text-[0.8125rem] leading-6"
                      style={{
                        background: "transparent",
                        fontFamily: "'SF Mono', 'Fira Code', 'JetBrains Mono', Menlo, Monaco, 'Courier New', monospace",
                        tabSize: 2,
                        minHeight: "100%",
                      }}
                    >
                      {tokens.map((line, i) => {
                        const lineProps = getLineProps({ line, key: i });
                        return (
                          <div key={i} {...lineProps} className="flex">
                            <span
                              className="shrink-0 pr-4 text-right text-white/20 select-none text-[0.6875rem]"
                              style={{ width: "3rem" }}
                            >
                              {i + 1}
                            </span>
                            <span className="flex-1">
                              {line.map((token, j) => (
                                <span key={j} {...getTokenProps({ token, key: j })} />
                              ))}
                            </span>
                          </div>
                        );
                      })}
                    </pre>
                  )}
                </Highlight>
              ) : (
                <div className="pl-[3rem] py-3 text-[0.8125rem] text-white/25 italic" style={{
                  fontFamily: "'SF Mono', 'Fira Code', 'JetBrains Mono', Menlo, Monaco, 'Courier New', monospace",
                }}>
                  Double-click to start typing code...
                </div>
              )}
            </div>
          )}
        </div>

        {/* Output panel */}
        {showOutput && (
          <div
            className="border-t border-white/10 flex flex-col"
            style={{ height: "140px", background: "rgba(0,0,0,0.25)" }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-3 h-7 shrink-0" style={{ background: "rgba(255,255,255,0.03)" }}>
              <span className="text-[0.625rem] font-medium text-white/40 uppercase tracking-wider">Output</span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className="p-0.5 rounded text-white/30 hover:text-white/60 hover:bg-white/8 transition-colors"
                  onClick={() => setOutputLines([])}
                  title="Clear output"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
                <button
                  type="button"
                  className="p-0.5 rounded text-white/30 hover:text-white/60 hover:bg-white/8 transition-colors"
                  onClick={() => setShowOutput(false)}
                  title="Hide output"
                >
                  <ChevronDown className="w-3 h-3" />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto scrollbar-hide px-3 py-1.5 space-y-0.5">
              {outputLines.length === 0 ? (
                <div className="text-[0.6875rem] text-white/20 italic pt-1">
                  {isRunning ? "Running..." : "No output yet"}
                </div>
              ) : (
                outputLines.map((line, i) => (
                  <div
                    key={i}
                    className={`text-[0.6875rem] font-mono whitespace-pre-wrap break-all leading-[1.125rem] ${
                      line.type === "error" ? "text-red-400"
                        : line.type === "warn" ? "text-yellow-400"
                        : line.type === "result" ? "text-blue-300"
                        : line.type === "info" ? "text-white/30 italic"
                        : "text-white/70"
                    }`}
                  >
                    {line.type === "error" && <span className="text-red-500/60 mr-1">✕</span>}
                    {line.type === "warn" && <span className="text-yellow-500/60 mr-1">⚠</span>}
                    {line.type === "result" && <span className="text-blue-400/60 mr-1">→</span>}
                    {line.text}
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* Toggle output (when hidden but has results) */}
        {!showOutput && outputLines.length > 0 && (
          <button
            type="button"
            className="absolute bottom-0 left-0 right-0 h-6 flex items-center justify-center gap-1 text-[0.625rem] text-white/30 hover:text-white/50 hover:bg-white/5 transition-colors border-t border-white/5"
            onClick={(e) => { e.stopPropagation(); setShowOutput(true); }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <ChevronUp className="w-3 h-3" />
            Show output ({outputLines.filter((l) => l.type !== "info").length} lines)
          </button>
        )}
      </div>

      {/* Resize handles */}
      <div className="absolute inset-0 pointer-events-none z-10">
        <div
          data-resize-handle
          className="absolute top-0 bottom-0 right-0 w-2 pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ cursor: "ew-resize" }}
          onPointerDown={(e) => beginResize(e, "right")}
        />
        <div
          data-resize-handle
          className="absolute left-0 right-0 bottom-0 h-2 pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ cursor: "ns-resize" }}
          onPointerDown={(e) => beginResize(e, "bottom")}
        />
        <div
          data-resize-handle
          className="absolute right-0 bottom-0 w-4 h-4 pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ cursor: "nwse-resize" }}
          onPointerDown={(e) => beginResize(e, "corner")}
        >
          <div
            className="w-full h-full rounded-sm"
            style={{
              background: "rgba(255,255,255,0.14)",
              border: "1px solid rgba(255,255,255,0.22)",
              boxShadow: "inset 0 0 18px rgba(110, 200, 255, 0.14)",
            }}
          />
        </div>
      </div>
    </div>
  );
});
