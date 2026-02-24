import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function pointsToPath(points) {
  if (!points || points.length === 0) return "";
  const [p0, ...rest] = points;
  let d = `M ${p0.x} ${p0.y}`;
  for (const p of rest) d += ` L ${p.x} ${p.y}`;
  return d;
}

function getBoundsFromPoints(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function normalizeBoard(board, width, height) {
  const b = board || {};
  return {
    version: 1,
    color: b.color || "#111827",
    tool: b.tool || "pen", // pen|shape|text|select
    shape: b.shape || "rect", // rect|circle|line
    fill: b.fill ?? false,
    strokeWidth: b.strokeWidth ?? 2,
    opacity: b.opacity ?? 1,
    elements: Array.isArray(b.elements) ? b.elements : [],
    fineGrid: b.fineGrid ?? false,
    width: b.width ?? width,
    height: b.height ?? height,
  };
}

function elementTransform(el) {
  const cx = (el.x || 0) + (el.w || 0) / 2;
  const cy = (el.y || 0) + (el.h || 0) / 2;
  const r = el.r || 0;
  return `rotate(${r} ${cx} ${cy})`;
}

export default function DesignBoardBlock({
  board,
  width,
  height,
  isSelected,
  onBoardChange,
  onRequestFocus,
  onExitFocus,
}) {
  const PANEL_W = 0; // No permanent panel - tools appear via palette
  const canvasW = Math.max(240, Math.floor(width || 0));
  const canvasH = Math.max(160, Math.floor(height || 0));
  const rootRef = useRef(null);
  const svgRef = useRef(null);
  const [state, setState] = useState(() => normalizeBoard(board, canvasW, canvasH));
  const [selectedId, setSelectedId] = useState(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [draftPoints, setDraftPoints] = useState([]);
  const [draftShape, setDraftShape] = useState(null); // { kind, x,y,w,h,x2,y2 }
  const [editingText, setEditingText] = useState(null); // { id }
  const [textDraft, setTextDraft] = useState("");
  const [showToolPalette, setShowToolPalette] = useState(false);
  const [toolPalettePos, setToolPalettePos] = useState({ x: 0, y: 0 });
  const textInputRef = useRef(null);
  const fileInputRef = useRef(null);
  const dragElRef = useRef(null); // { id, startX, startY, originX, originY }
  const resizeElRef = useRef(null); // { id, startX, startY, origin, handle }
  const rotateElRef = useRef(null); // { id, cx, cy, startAngle, originR }

  useEffect(() => {
    setState((prev) => normalizeBoard(board, canvasW, canvasH));
  }, [board, canvasH, canvasW]);

  // Migrate legacy path/line elements (absolute points) to normalized coordinates so resize/scale works.
  useEffect(() => {
    setState((s) => {
      let changed = false;
      const nextEls = s.elements.map((el) => {
        if (el.kind === "path" && Array.isArray(el.points) && !el.pointsNorm) {
          const pts = el.points;
          const max = pts.reduce((m, p) => Math.max(m, p.x || 0, p.y || 0), 0);
          if (max <= 1.5) return el; // already normalized-ish
          const bounds = getBoundsFromPoints(pts);
          const w0 = Math.max(1, bounds.w);
          const h0 = Math.max(1, bounds.h);
          const norm = pts.map((p) => ({ x: (p.x - bounds.x) / w0, y: (p.y - bounds.y) / h0 }));
          changed = true;
          return { ...el, x: bounds.x, y: bounds.y, w: w0, h: h0, points: norm, pointsNorm: true };
        }
        if (el.kind === "line" && el.p1 && el.p2 && !el.pointsNorm) {
          return { ...el, pointsNorm: true };
        }
        if (el.kind === "line" && el.x1 != null && el.y1 != null && el.x2 != null && el.y2 != null && !el.pointsNorm) {
          const x = Math.min(el.x1, el.x2);
          const y = Math.min(el.y1, el.y2);
          const w0 = Math.max(1, Math.abs(el.x2 - el.x1));
          const h0 = Math.max(1, Math.abs(el.y2 - el.y1));
          const p1 = { x: (el.x1 - x) / w0, y: (el.y1 - y) / h0 };
          const p2 = { x: (el.x2 - x) / w0, y: (el.y2 - y) / h0 };
          changed = true;
          return { ...el, x, y, w: w0, h: h0, p1, p2, pointsNorm: true, x1: undefined, y1: undefined, x2: undefined, y2: undefined };
        }
        return el;
      });
      if (!changed) return s;
      const next = { ...s, elements: nextEls };
      emit(next);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto pen tool when focused
  useEffect(() => {
    if (!isSelected) {
      setShowToolPalette(false);
      return;
    }
    // Auto-switch to pen tool when block is focused
    if (state.tool !== "pen" && !editingText && !showToolPalette) {
      setState((s) => ({ ...s, tool: "pen" }));
    }
  }, [isSelected, editingText, showToolPalette, state.tool]);

  const emit = useCallback((next) => {
    onBoardChange?.(next);
  }, [onBoardChange]);

  const setTool = useCallback((tool) => {
    setState((s) => {
      const next = { ...s, tool };
      emit(next);
      return next;
    });
  }, [emit]);

  const setShape = useCallback((shape) => {
    setState((s) => {
      const next = { ...s, shape, tool: "shape" };
      emit(next);
      return next;
    });
  }, [emit]);

  const setColor = useCallback((color) => {
    setState((s) => {
      const next = { ...s, color };
      emit(next);
      return next;
    });
  }, [emit]);

  const setFill = useCallback((fill) => {
    setState((s) => {
      const next = { ...s, fill };
      emit(next);
      return next;
    });
  }, [emit]);

  const setStrokeWidth = useCallback((strokeWidth) => {
    setState((s) => {
      const next = { ...s, strokeWidth };
      emit(next);
      return next;
    });
  }, [emit]);

  const setOpacity = useCallback((opacity) => {
    setState((s) => {
      const next = { ...s, opacity: clamp(opacity, 0.05, 1) };
      emit(next);
      return next;
    });
  }, [emit]);

  const updateElements = useCallback((updater) => {
    setState((s) => {
      const nextEls = updater(s.elements);
      const next = { ...s, elements: nextEls };
      emit(next);
      return next;
    });
  }, [emit]);

  const localPoint = useCallback((clientX, clientY) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    return {
      x: clamp(clientX - rect.left, 0, canvasW),
      y: clamp(clientY - rect.top, 0, canvasH),
    };
  }, [canvasH, canvasW]);

  const selectedEl = useMemo(() => state.elements.find((e) => e.id === selectedId) || null, [selectedId, state.elements]);

  const startTextEdit = useCallback((id) => {
    const el = state.elements.find((e) => e.id === id);
    if (!el || el.kind !== "text") return;
    setEditingText({ id });
    setTextDraft(el.text || "");
    requestAnimationFrame(() => {
      textInputRef.current?.focus?.({ preventScroll: true });
      textInputRef.current?.select?.();
    });
  }, [state.elements]);

  const commitTextEdit = useCallback(() => {
    if (!editingText) return;
    const id = editingText.id;
    updateElements((els) => els.map((e) => (e.id === id ? { ...e, text: textDraft } : e)));
    setEditingText(null);
    setTextDraft("");
  }, [editingText, textDraft, updateElements]);

  const pointerDown = useCallback((e) => {
    e.stopPropagation();
    onRequestFocus?.();
    if (!isSelected) return;

    const p = localPoint(e.clientX, e.clientY);
    const tool = state.tool;
    if (tool === "pen") {
      setIsDrawing(true);
      setDraftPoints([p]);
      return;
    }
    if (tool === "shape") {
      setIsDrawing(true);
      if (state.shape === "line") setDraftShape({ kind: "line", x: p.x, y: p.y, x2: p.x, y2: p.y });
      else setDraftShape({ kind: state.shape, x: p.x, y: p.y, w: 0, h: 0 });
      return;
    }
    if (tool === "text") {
      const id = makeId();
      const el = { id, kind: "text", x: p.x, y: p.y, w: 140, h: 32, r: 0, color: state.color, opacity: state.opacity, text: "Text", fontSize: 18 };
      updateElements((els) => [...els, el]);
      setSelectedId(id);
      setTool("select");
      startTextEdit(id);
      return;
    }
    // select
    // hit-test: simple bbox check in reverse order
    const hit = [...state.elements].reverse().find((el) => {
      const x = el.x || 0, y = el.y || 0, w = el.w || 0, h = el.h || 0;
      return p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h;
    });
    if (hit) {
      setSelectedId(hit.id);
      // start dragging
      dragElRef.current = { id: hit.id, startX: p.x, startY: p.y, originX: hit.x || 0, originY: hit.y || 0 };
    } else {
      setSelectedId(null);
    }
  }, [isSelected, localPoint, onRequestFocus, setTool, startTextEdit, state.color, state.elements, state.shape, state.tool, updateElements]);

  const pointerMove = useCallback((e) => {
    if (!isSelected) return;
    const p = localPoint(e.clientX, e.clientY);
    if (isDrawing && state.tool === "pen") {
      setDraftPoints((prev) => [...prev, p]);
      return;
    }
    if (isDrawing && state.tool === "shape") {
      setDraftShape((prev) => {
        if (!prev) return prev;
        if (prev.kind === "line") return { ...prev, x2: p.x, y2: p.y };
        return { ...prev, w: p.x - prev.x, h: p.y - prev.y };
      });
      return;
    }
    if (dragElRef.current) {
      const d = dragElRef.current;
      const dx = p.x - d.startX;
      const dy = p.y - d.startY;
      updateElements((els) => els.map((el) => (el.id === d.id ? { ...el, x: clamp(d.originX + dx, 0, canvasW - (el.w || 0)), y: clamp(d.originY + dy, 0, canvasH - (el.h || 0)) } : el)));
    }
    if (resizeElRef.current) {
      const r = resizeElRef.current;
      const dx = p.x - r.startX;
      const dy = p.y - r.startY;
      updateElements((els) => els.map((el) => {
        if (el.id !== r.id) return el;
        let x = r.origin.x, y = r.origin.y, w = r.origin.w, h = r.origin.h;
        if (r.handle === "br") { w = r.origin.w + dx; h = r.origin.h + dy; }
        if (r.handle === "tr") { w = r.origin.w + dx; h = r.origin.h - dy; y = r.origin.y + dy; }
        if (r.handle === "bl") { w = r.origin.w - dx; h = r.origin.h + dy; x = r.origin.x + dx; }
        if (r.handle === "tl") { w = r.origin.w - dx; h = r.origin.h - dy; x = r.origin.x + dx; y = r.origin.y + dy; }
        w = Math.max(8, w); h = Math.max(8, h);
        return { ...el, x: clamp(x, 0, canvasW - w), y: clamp(y, 0, canvasH - h), w, h };
      }));
    }
    if (rotateElRef.current) {
      const r = rotateElRef.current;
      const ang = Math.atan2(p.y - r.cy, p.x - r.cx);
      const deg = (ang * 180) / Math.PI;
      updateElements((els) => els.map((el) => (el.id === r.id ? { ...el, r: r.originR + (deg - r.startAngle) } : el)));
    }
  }, [height, isDrawing, isSelected, localPoint, state.tool, updateElements, width]);

  const pointerUp = useCallback(() => {
    if (isDrawing && state.tool === "pen") {
      const pts = draftPoints;
      setIsDrawing(false);
      setDraftPoints([]);
      if (pts.length > 1) {
        const bounds = getBoundsFromPoints(pts);
        const id = makeId();
        const w0 = Math.max(1, bounds.w);
        const h0 = Math.max(1, bounds.h);
        const norm = pts.map((p) => ({ x: (p.x - bounds.x) / w0, y: (p.y - bounds.y) / h0 }));
        const el = { id, kind: "path", x: bounds.x, y: bounds.y, w: w0, h: h0, r: 0, color: state.color, opacity: state.opacity, strokeWidth: state.strokeWidth, points: norm, pointsNorm: true };
        updateElements((els) => [...els, el]);
      }
      return;
    }
    if (isDrawing && state.tool === "shape") {
      const s = draftShape;
      setIsDrawing(false);
      setDraftShape(null);
      if (!s) return;
      const id = makeId();
      if (s.kind === "line") {
        const x = Math.min(s.x, s.x2);
        const y = Math.min(s.y, s.y2);
        const w = Math.abs(s.x2 - s.x);
        const h = Math.abs(s.y2 - s.y);
        const w0 = Math.max(1, w);
        const h0 = Math.max(1, h);
        const p1 = { x: (s.x - x) / w0, y: (s.y - y) / h0 };
        const p2 = { x: (s.x2 - x) / w0, y: (s.y2 - y) / h0 };
        updateElements((els) => [...els, { id, kind: "line", x, y, w: w0, h: h0, r: 0, color: state.color, opacity: state.opacity, strokeWidth: state.strokeWidth, p1, p2, pointsNorm: true }]);
      } else {
        const x = Math.min(s.x, s.x + s.w);
        const y = Math.min(s.y, s.y + s.h);
        const w = Math.abs(s.w);
        const h = Math.abs(s.h);
        updateElements((els) => [...els, { id, kind: s.kind, x, y, w, h, r: 0, color: state.color, opacity: state.opacity, strokeWidth: state.strokeWidth, fill: state.fill ? state.color : "none" }]);
      }
      setTool("select");
      return;
    }
    dragElRef.current = null;
    resizeElRef.current = null;
    rotateElRef.current = null;
  }, [draftPoints, draftShape, isDrawing, setTool, state.color, state.tool, updateElements]);

  useEffect(() => {
    window.addEventListener("pointermove", pointerMove);
    window.addEventListener("pointerup", pointerUp);
    return () => {
      window.removeEventListener("pointermove", pointerMove);
      window.removeEventListener("pointerup", pointerUp);
    };
  }, [pointerMove, pointerUp]);

  const onKeyDown = useCallback((e) => {
    if (!isSelected) return;
    if (editingText) {
      if (e.key === "Escape") {
        e.preventDefault();
        commitTextEdit();
        return;
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setShowToolPalette(false);
      setSelectedId(null);
      onExitFocus?.();
      return;
    }
    // '/' opens tool palette when pressed inside design block
    if (e.key === "/") {
      e.preventDefault();
      e.stopPropagation();
      const svg = svgRef.current;
      if (svg) {
        const rect = svg.getBoundingClientRect();
        const mouseX = rect.left + canvasW / 2; // Center of canvas
        const mouseY = rect.top + canvasH / 2;
        setToolPalettePos({ x: mouseX, y: mouseY });
        setShowToolPalette(true);
      }
      return;
    }
    if (e.key === "Backspace" || e.key === "Delete") {
      if (!selectedId) return;
      e.preventDefault();
      updateElements((els) => els.filter((x) => x.id !== selectedId));
      setSelectedId(null);
    }
  }, [canvasH, canvasW, commitTextEdit, editingText, isSelected, onExitFocus, selectedId, updateElements]);

  const readFilesAsDataUrls = useCallback(async (files) => {
    const list = Array.from(files || []).filter(Boolean);
    const out = [];
    for (const f of list) {
      // eslint-disable-next-line no-await-in-loop
      const dataUrl = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onerror = () => reject(new Error("Failed to read file"));
        r.onload = () => resolve(r.result);
        r.readAsDataURL(f);
      });
      out.push({ file: f, dataUrl });
    }
    return out;
  }, []);

  const importFiles = useCallback(async (files, dropPoint) => {
    const items = await readFilesAsDataUrls(files);
    if (items.length === 0) return;
    const base = dropPoint || { x: canvasW * 0.2, y: canvasH * 0.2 };
    let yCursor = base.y;
    for (const it of items) {
      const mime = it.file.type || "";
      if (!mime.startsWith("image/")) continue;
      const id = makeId();
      const w0 = Math.min(320, Math.max(80, canvasW * 0.5));
      const h0 = Math.min(220, Math.max(60, canvasH * 0.25));
      updateElements((els) => [...els, { id, kind: "image", x: base.x, y: yCursor, w: w0, h: h0, r: 0, opacity: 1, href: it.dataUrl }]);
      yCursor += h0 + 16;
    }
  }, [canvasH, canvasW, readFilesAsDataUrls, updateElements]);

  // Tool palette that appears when '/' is pressed
  const toolPalette = useMemo(() => {
    if (!showToolPalette) return null;
    
    const btn = (label, active, onClick, icon) => (
      <button
        type="button"
        key={label}
        className={`w-full px-3 py-2 text-left text-sm rounded-md border ${
          active ? "bg-gray-100 dark:bg-[#222] border-gray-300 dark:border-gray-600" : "bg-white dark:bg-[#1b1919] border-gray-200 dark:border-gray-700"
        } hover:bg-gray-50 dark:hover:bg-[#222] text-gray-800 dark:text-gray-100 flex items-center gap-2`}
        onPointerDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onClick();
          setShowToolPalette(false);
        }}
      >
        {icon && <span className="text-xs">{icon}</span>}
        {label}
      </button>
    );
    
    const swatch = (c) => (
      <button
        key={c}
        type="button"
        className="w-6 h-6 rounded border border-black/10 dark:border-white/10"
        style={{ background: c }}
        onPointerDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setColor(c);
        }}
        title={c}
      />
    );

    return (
      <div
        className="fixed z-50 w-48 bg-white dark:bg-[#1b1919] rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 p-2 flex flex-col gap-2"
        style={{
          left: `${toolPalettePos.x}px`,
          top: `${toolPalettePos.y}px`,
          transform: 'translate(-50%, -50%)'
        }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="text-xs font-semibold text-gray-600 dark:text-gray-300 px-1">Tools</div>
        <div className="flex flex-col gap-1">
          {btn("Pen", state.tool === "pen", () => setTool("pen"), "✏️")}
          {btn("Select", state.tool === "select", () => setTool("select"), "↖️")}
          {btn("Text", state.tool === "text", () => setTool("text"), "T")}
        </div>

        <div className="text-xs font-semibold text-gray-600 dark:text-gray-300 pt-1 px-1">Shapes</div>
        <div className="flex flex-col gap-1">
          {btn("Rectangle", state.tool === "shape" && state.shape === "rect", () => setShape("rect"), "▭")}
          {btn("Circle", state.tool === "shape" && state.shape === "circle", () => setShape("circle"), "○")}
          {btn("Line", state.tool === "shape" && state.shape === "line", () => setShape("line"), "─")}
        </div>

        <div className="text-xs font-semibold text-gray-600 dark:text-gray-300 pt-1 px-1">Color</div>
        <div className="flex items-center gap-2 px-1">
          <input
            type="color"
            value={state.color}
            onChange={(e) => setColor(e.target.value)}
            title="Pick any color"
            style={{ width: 30, height: 24, padding: 0, background: "transparent", border: "none" }}
            onClick={(e) => e.stopPropagation()}
          />
          <div className="grid grid-cols-4 gap-1">{["#111827", "#ef4444", "#3b82f6", "#22c55e", "#f59e0b", "#a855f7"].map(swatch)}</div>
        </div>

        <div className="text-[10px] text-gray-500 dark:text-gray-400 pt-1 px-1 border-t border-gray-200 dark:border-gray-700 mt-1">
          Press Esc to close
        </div>
      </div>
    );
  }, [setColor, setShape, setTool, showToolPalette, state.color, state.shape, state.tool, toolPalettePos.x, toolPalettePos.y]);

  const selectionOverlay = useMemo(() => {
    if (!selectedEl || !isSelected) return null;
    const x = selectedEl.x || 0;
    const y = selectedEl.y || 0;
    const w = selectedEl.w || 0;
    const h = selectedEl.h || 0;
    const cx = x + w / 2;
    const cy = y + h / 2;
    const handle = (hx, hy, name) => (
      <circle
        key={name}
        cx={hx}
        cy={hy}
        r={4}
        fill="white"
        stroke="rgba(59,130,246,0.8)"
        onPointerDown={(e) => {
          e.stopPropagation();
          e.preventDefault();
          resizeElRef.current = { id: selectedEl.id, startX: localPoint(e.clientX, e.clientY).x, startY: localPoint(e.clientX, e.clientY).y, origin: { x, y, w, h }, handle: name };
        }}
      />
    );
    return (
      <g>
        <rect x={x} y={y} width={w} height={h} fill="none" stroke="rgba(59,130,246,0.8)" strokeWidth="1" />
        {handle(x, y, "tl")}
        {handle(x + w, y, "tr")}
        {handle(x, y + h, "bl")}
        {handle(x + w, y + h, "br")}
        {/* rotate handle */}
        <circle
          cx={cx}
          cy={y - 16}
          r={4}
          fill="white"
          stroke="rgba(59,130,246,0.8)"
          onPointerDown={(e) => {
            e.stopPropagation();
            e.preventDefault();
            const p = localPoint(e.clientX, e.clientY);
            const ang = Math.atan2(p.y - cy, p.x - cx);
            rotateElRef.current = { id: selectedEl.id, cx, cy, startAngle: (ang * 180) / Math.PI, originR: selectedEl.r || 0 };
          }}
        />
        <line x1={cx} y1={y} x2={cx} y2={y - 16} stroke="rgba(59,130,246,0.6)" />
      </g>
    );
  }, [isSelected, localPoint, selectedEl]);

  return (
    <div
      ref={rootRef}
      data-design-root
      tabIndex={0}
      className="w-full h-full outline-none"
      onKeyDown={onKeyDown}
      onPointerDown={(e) => {
        e.stopPropagation();
        onRequestFocus?.();
        if (editingText) return;
        rootRef.current?.focus?.({ preventScroll: true });
        pointerDown(e);
      }}
      style={{ cursor: isSelected ? (state.tool === "pen" ? "crosshair" : "default") : "default" }}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const p = localPoint(e.clientX, e.clientY);
        importFiles(e.dataTransfer?.files, p);
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = e.target.files;
          if (files && files.length) importFiles(files);
          e.target.value = "";
        }}
      />
      {/* Click outside to close tool palette */}
      {showToolPalette && (
        <div
          className="fixed inset-0 z-40"
          onPointerDown={(e) => {
            e.preventDefault();
            setShowToolPalette(false);
          }}
        />
      )}
      {toolPalette}
      
      <div className="w-full h-full flex glass-block overflow-hidden">
        <div className="flex-1 relative">
          <svg
            ref={svgRef}
            width={canvasW}
            height={canvasH}
            style={{ display: "block", background: "transparent" }}
          >
        {/* elements */}
        {state.elements.map((el) => {
          const t = elementTransform(el);
          const color = el.color || state.color;
          const opacity = el.opacity ?? 1;
          if (el.kind === "path") {
            const pts = (el.points || []).map((p) => (el.pointsNorm ? { x: (el.x || 0) + p.x * (el.w || 0), y: (el.y || 0) + p.y * (el.h || 0) } : p));
            const d = pointsToPath(pts);
            return (
              <path
                key={el.id}
                d={d}
                fill="none"
                stroke={color}
                opacity={opacity}
                strokeWidth={el.strokeWidth || state.strokeWidth || 2}
                transform={t}
              />
            );
          }
          if (el.kind === "rect") {
            return (
              <rect key={el.id} x={el.x} y={el.y} width={el.w} height={el.h} fill={el.fill || "none"} stroke={color} opacity={opacity} strokeWidth={el.strokeWidth || state.strokeWidth || 2} transform={t} />
            );
          }
          if (el.kind === "circle") {
            const cx = (el.x || 0) + (el.w || 0) / 2;
            const cy = (el.y || 0) + (el.h || 0) / 2;
            const r = Math.min((el.w || 0) / 2, (el.h || 0) / 2);
            return <circle key={el.id} cx={cx} cy={cy} r={r} fill={el.fill || "none"} stroke={color} opacity={opacity} strokeWidth={el.strokeWidth || state.strokeWidth || 2} transform={t} />;
          }
          if (el.kind === "line") {
            const p1 = el.p1 && el.pointsNorm ? { x: (el.x || 0) + el.p1.x * (el.w || 0), y: (el.y || 0) + el.p1.y * (el.h || 0) } : { x: el.x1, y: el.y1 };
            const p2 = el.p2 && el.pointsNorm ? { x: (el.x || 0) + el.p2.x * (el.w || 0), y: (el.y || 0) + el.p2.y * (el.h || 0) } : { x: el.x2, y: el.y2 };
            return (
              <line
                key={el.id}
                x1={p1.x}
                y1={p1.y}
                x2={p2.x}
                y2={p2.y}
                stroke={color}
                opacity={opacity}
                strokeWidth={el.strokeWidth || state.strokeWidth || 2}
                transform={t}
              />
            );
          }
          if (el.kind === "image") {
            return (
              <image
                key={el.id}
                href={el.href}
                x={el.x}
                y={el.y}
                width={el.w}
                height={el.h}
                opacity={opacity}
                preserveAspectRatio="xMidYMid meet"
                transform={t}
              />
            );
          }
          if (el.kind === "text") {
            return (
              <text
                key={el.id}
                x={el.x}
                y={(el.y || 0) + (el.fontSize || 18)}
                fill={color}
                fontSize={el.fontSize || 18}
                transform={t}
                style={{ userSelect: "none" }}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  startTextEdit(el.id);
                }}
              >
                {el.text || "Text"}
              </text>
            );
          }
          return null;
        })}

        {/* draft pen */}
        {isDrawing && state.tool === "pen" && draftPoints.length > 1 && (
          <path d={pointsToPath(draftPoints)} fill="none" stroke={state.color} strokeWidth={2} />
        )}
        {/* draft shape */}
        {isDrawing && state.tool === "shape" && draftShape && draftShape.kind !== "line" && (
          <rect
            x={Math.min(draftShape.x, draftShape.x + draftShape.w)}
            y={Math.min(draftShape.y, draftShape.y + draftShape.h)}
            width={Math.abs(draftShape.w)}
            height={Math.abs(draftShape.h)}
            fill="none"
            stroke={state.color}
            strokeWidth={2}
          />
        )}
        {isDrawing && state.tool === "shape" && draftShape && draftShape.kind === "line" && (
          <line x1={draftShape.x} y1={draftShape.y} x2={draftShape.x2} y2={draftShape.y2} stroke={state.color} strokeWidth={2} />
        )}

        {selectionOverlay}
          </svg>
        </div>
      </div>

      {/* text editor overlay */}
      {editingText && selectedEl && selectedEl.kind === "text" && (
        <input
          ref={textInputRef}
          className="absolute z-40 bg-white/95 dark:bg-[#1b1919]/95 border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-sm outline-none"
          style={{
            left: `${(selectedEl.x || 0)}px`,
            top: `${selectedEl.y || 0}px`,
            width: `${Math.max(120, selectedEl.w || 140)}px`,
          }}
          value={textDraft}
          onChange={(e) => setTextDraft(e.target.value)}
          onBlur={commitTextEdit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitTextEdit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              commitTextEdit();
            }
            e.stopPropagation();
          }}
        />
      )}
    </div>
  );
}

