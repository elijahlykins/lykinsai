import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useCanvasStore } from "@/store/canvasStore";
import { snapToGrid } from "@/canvas/utils/snap";

function colToLetters(colIdx: number) {
  let n = colIdx + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function parseCellRef(token: string) {
  const m = String(token || "").toUpperCase().match(/^([A-Z]+)(\d+)$/);
  if (!m) return null;
  const letters = m[1];
  const row = Number(m[2]) - 1;
  let col = 0;
  for (let i = 0; i < letters.length; i += 1) {
    const c = letters.charCodeAt(i);
    if (c < 65 || c > 90) return null;
    col = col * 26 + (c - 64);
  }
  col -= 1;
  if (!Number.isFinite(col) || !Number.isFinite(row) || col < 0 || row < 0) return null;
  return { row, col };
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

type Token = { type: "number" | "ident" | "op"; value: string };
function tokenize(expr: string): Token[] {
  const s = String(expr || "");
  const tokens: Token[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j])) j += 1;
      tokens.push({ type: "number", value: s.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j += 1;
      tokens.push({ type: "ident", value: s.slice(i, j) });
      i = j;
      continue;
    }
    if ("+-*/():,=".includes(ch)) {
      tokens.push({ type: "op", value: ch });
      i += 1;
      continue;
    }
    i += 1;
  }
  return tokens;
}

function isNumberToken(t: Token | undefined): t is Token & { type: "number" } {
  return !!t && t.type === "number";
}

function makeParser(tokens: Token[], getCellNumeric: (r: number, c: number) => number) {
  let idx = 0;
  const peek = () => tokens[idx];
  const next = () => tokens[idx++];
  const matchOp = (op: string) => peek()?.type === "op" && peek()?.value === op;

  type ParseResult = { ok: true; value: number | number[] } | { ok: false; value: number };

  const parsePrimary = (): ParseResult => {
    const t = peek();
    if (!t) return { ok: false, value: NaN };
    if (isNumberToken(t)) {
      next();
      const n = Number(t.value);
      return { ok: true, value: Number.isFinite(n) ? n : NaN };
    }
    if (t.type === "ident") {
      const ident = String(t.value);
      next();
      // Function call (SUM + common basics)
      if (matchOp("(")) {
        next(); // (
        const args: ParseResult[] = [];
        if (!matchOp(")")) {
          while (true) {
            const a = parseExpression();
            if (!a.ok) return a;
            args.push(a);
            if (matchOp(",")) {
              next();
              continue;
            }
            break;
          }
        }
        if (!matchOp(")")) return { ok: false, value: NaN };
        next(); // )
        const fn = ident.toUpperCase();
        const flat: number[] = [];
        for (const a of args) {
          if (Array.isArray(a.value)) {
            for (const v of a.value) flat.push(Number(v) || 0);
          } else {
            flat.push(Number(a.value) || 0);
          }
        }
        if (fn === "SUM") return { ok: true, value: flat.reduce((s, x) => s + x, 0) };
        if (fn === "AVG" || fn === "AVERAGE") return { ok: true, value: flat.length ? flat.reduce((s, x) => s + x, 0) / flat.length : 0 };
        if (fn === "MIN") return { ok: true, value: flat.length ? Math.min(...flat) : 0 };
        if (fn === "MAX") return { ok: true, value: flat.length ? Math.max(...flat) : 0 };
        if (fn === "COUNT") return { ok: true, value: flat.length };
        return { ok: false, value: NaN };
      }

      // Cell ref like A1
      const ref = parseCellRef(ident);
      if (ref) return { ok: true, value: getCellNumeric(ref.row, ref.col) };
      return { ok: false, value: NaN };
    }
    if (matchOp("(")) {
      next();
      const inner = parseExpression();
      if (!inner.ok) return inner;
      if (!matchOp(")")) return { ok: false, value: NaN };
      next();
      return inner;
    }
    // Unary +/-
    if (matchOp("+") || matchOp("-")) {
      const op = next().value;
      const v = parsePrimary();
      if (!v.ok) return v;
      const num = Array.isArray(v.value) ? Number(v.value[0]) || 0 : Number(v.value) || 0;
      return { ok: true, value: op === "-" ? -num : num };
    }
    return { ok: false, value: NaN };
  };

  // Handle ranges like A1:A10 (only valid as an argument; represented as array)
  const parseRangeOrPrimary = (): ParseResult => {
    const startTok = peek();
    if (startTok?.type === "ident") {
      const maybeRef = parseCellRef(startTok.value);
      if (maybeRef) {
        next();
        if (matchOp(":")) {
          next();
          const endTok = peek();
          if (endTok?.type !== "ident") return { ok: false, value: NaN };
          const endRef = parseCellRef(endTok.value);
          if (!endRef) return { ok: false, value: NaN };
          next();
          const r1 = Math.min(maybeRef.row, endRef.row);
          const r2 = Math.max(maybeRef.row, endRef.row);
          const c1 = Math.min(maybeRef.col, endRef.col);
          const c2 = Math.max(maybeRef.col, endRef.col);
          const out: number[] = [];
          for (let r = r1; r <= r2; r += 1) {
            for (let c = c1; c <= c2; c += 1) out.push(getCellNumeric(r, c));
          }
          return { ok: true, value: out };
        }
        return { ok: true, value: getCellNumeric(maybeRef.row, maybeRef.col) };
      }
    }
    return parsePrimary();
  };

  const parseMulDiv = (): ParseResult => {
    let left = parseRangeOrPrimary();
    if (!left.ok) return left;
    while (matchOp("*") || matchOp("/")) {
      const op = next().value;
      const right = parseRangeOrPrimary();
      if (!right.ok) return right;
      const a = Number(Array.isArray(left.value) ? left.value[0] : left.value) || 0;
      const b = Number(Array.isArray(right.value) ? right.value[0] : right.value) || 0;
      left = { ok: true, value: op === "*" ? a * b : a / b };
    }
    return left;
  };

  const parseExpression = (): ParseResult => {
    let left = parseMulDiv();
    if (!left.ok) return left;
    while (matchOp("+") || matchOp("-")) {
      const op = next().value;
      const right = parseMulDiv();
      if (!right.ok) return right;
      const a = Number(Array.isArray(left.value) ? left.value[0] : left.value) || 0;
      const b = Number(Array.isArray(right.value) ? right.value[0] : right.value) || 0;
      left = { ok: true, value: op === "+" ? a + b : a - b };
    }
    return left;
  };

  return { parseExpression };
}

function computeGrid(args: { rows: number; cols: number; cells: Record<string, string> }) {
  const { rows, cols, cells } = args;
  const raw = cells || {};
  const memo = new Map<string, { kind: "value" | "err"; value: string }>();
  const visiting = new Set<string>();
  const keyOf = (r: number, c: number) => `${r},${c}`;

  const getRaw = (r: number, c: number) => {
    const v = raw[keyOf(r, c)];
    return v == null ? "" : String(v);
  };

  const getNumeric = (r: number, c: number): { kind: "value" | "err"; value: string } => {
    const k = keyOf(r, c);
    if (memo.has(k)) return memo.get(k)!;
    if (visiting.has(k)) {
      const out = { kind: "err" as const, value: "#CYCLE" };
      memo.set(k, out);
      return out;
    }
    visiting.add(k);
    const v = getRaw(r, c);
    let out: { kind: "value" | "err"; value: string } = { kind: "value", value: v };

    if (v.startsWith("=")) {
      try {
        const tokens = tokenize(v.slice(1));
        const parser = makeParser(tokens, (rr, cc) => Number(getNumeric(rr, cc)?.value) || 0);
        const res = parser.parseExpression();
        const num = res.ok && !Array.isArray(res.value) ? Number(res.value) : NaN;
        out = res.ok && Number.isFinite(num) ? { kind: "value", value: String(num) } : { kind: "err", value: "#ERR" };
      } catch {
        out = { kind: "err", value: "#ERR" };
      }
    } else {
      const n = Number(v);
      out = v.trim().length && Number.isFinite(n) ? { kind: "value", value: String(n) } : { kind: "value", value: v };
    }

    visiting.delete(k);
    memo.set(k, out);
    return out;
  };

  const display = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ""));
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      display[r][c] = String(getNumeric(r, c).value ?? "");
    }
  }
  return display;
}

export const SpreadsheetBlock = memo(function SpreadsheetBlock({ id }: { id: string }) {
  const block = useCanvasStore((s) => s.blocks[id]);
  const bringToFront = useCanvasStore((s) => s.bringToFront);
  const selectBlocks = useCanvasStore((s) => s.selectBlocks);
  const toggleSelect = useCanvasStore((s) => s.toggleSelect);
  const isSelected = useCanvasStore((s) => s.selectedIds.includes(id));
  const updateBlock = useCanvasStore((s) => s.updateBlock);
  const pushHistory = useCanvasStore((s) => s.pushHistory);

  const gridSize = useCanvasStore((s) => s.gridSize);
  const moveBlocksFromSnapshot = useCanvasStore((s) => s.moveBlocksFromSnapshot);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const editInputRef = useRef<HTMLInputElement | null>(null);
  const colResizeRef = useRef<{ col: number; startX: number; startW: number } | null>(null);
  const emitTimerRef = useRef<number | null>(null);
  const dragRef = useRef<any>(null);
  const resizeRef = useRef<{
    pointerId: number;
    mode: "right" | "top" | "bottom" | "corner";
    startClientX: number;
    startClientY: number;
    startX: number;
    startY: number;
    startW: number;
    startH: number;
    raf: number | null;
    capturer: HTMLElement | null;
  } | null>(null);
  const endResizeCleanupRef = useRef<(() => void) | null>(null);

  const [selected, setSelected] = useState({ r: 0, c: 0 });
  const [editing, setEditing] = useState<{ r: number; c: number } | null>(null);
  const [draft, setDraft] = useState("");
  const [colWidths, setColWidths] = useState<number[]>([]);
  const [cells, setCells] = useState<Record<string, string>>({});
  const selectedRef = useRef(selected);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  const style = useMemo(() => {
    if (!block || block.type !== "text" || block.format !== "table") return null;
    return {
      position: "absolute" as const,
      left: `${block.x}px`,
      top: `${block.y}px`,
      width: `${block.width}px`,
      height: `${block.height}px`,
      overflow: "visible",
    };
  }, [block]);

  if (!block || block.type !== "text" || block.format !== "table" || !style) return null;

  const sheet = useMemo(() => {
    try {
      const parsed = JSON.parse(String(block.content || ""));
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // ignore
    }
    return { version: 1, rows: 30, cols: 20, colWidths: Array.from({ length: 20 }, () => 96), cells: {} };
  }, [block.content]);
  const MAX_ROWS = 1000;
  const rows = clamp(sheet.rows || 30, 1, MAX_ROWS);
  const cols = sheet.cols || 20;
  const rowHeight = Math.max(1, Math.floor(gridSize || 24));
  const snapSize = (n: number) => {
    const g = Math.max(1, Math.floor(gridSize || 24));
    return Math.max(g, snapToGrid(n, g));
  };

  const ensureRowExists = useCallback(
    (rowIndex: number) => {
      if (rowIndex <= rows - 1) return false;
      if (rows >= MAX_ROWS) return false;

      const nextRows = clamp(rowIndex + 1, 1, MAX_ROWS);
      if (nextRows <= rows) return false;

      const g = Math.max(1, Math.floor(gridSize || 24));
      const expected = (rows + 1) * g;
      const nextExpected = (nextRows + 1) * g;
      const shouldAutoGrowHeight = Math.abs((block.height || 0) - expected) < g * 0.5;

      const nextSheet = {
        ...sheet,
        rows: nextRows,
        cols,
        colWidths,
        cells,
      };
      updateBlock(
        id,
        {
          ...(shouldAutoGrowHeight ? { height: Math.max(block.height, nextExpected) } : null),
          content: JSON.stringify(nextSheet),
        } as any
      );
      return true;
    },
    [block.height, cells, colWidths, cols, gridSize, id, rows, sheet, updateBlock]
  );

  // Sync from store sheet.
  useEffect(() => {
    setColWidths(Array.isArray(sheet.colWidths) ? sheet.colWidths : Array.from({ length: cols }, () => 96));
    setCells(sheet.cells || {});
  }, [cols, sheet.cells, sheet.colWidths]);

  const display = useMemo(() => computeGrid({ rows, cols, cells }), [rows, cols, cells]);

  const scheduleEmit = useCallback(
    (nextSheet: any) => {
      if (emitTimerRef.current) window.clearTimeout(emitTimerRef.current);
      emitTimerRef.current = window.setTimeout(() => {
        // Merge against the latest sheet to avoid stale debounced writes
        // (e.g. when we auto-grow rows and a delayed cell commit is still pending).
        const cur = useCanvasStore.getState().blocks[id] as any;
        let base = null;
        if (cur && cur.type === "text" && cur.format === "table") {
          try {
            base = JSON.parse(String(cur.content || ""));
          } catch {
            base = null;
          }
        }
        const merged =
          base != null
            ? {
                ...base,
                ...nextSheet,
                // Never allow a stale emit to shrink row count.
                rows: Math.max(Number(base.rows) || 1, Number(nextSheet?.rows) || 1),
              }
            : nextSheet;
        const nextRows = clamp(Number(merged?.rows) || 1, 1, MAX_ROWS);
        updateBlock(id, { content: JSON.stringify({ ...merged, rows: nextRows }) } as any);
      }, 120);
    },
    [id, updateBlock]
  );

  useEffect(() => {
    return () => {
      if (emitTimerRef.current) window.clearTimeout(emitTimerRef.current);
    };
  }, []);

  const updateCellRaw = useCallback(
    (r: number, c: number, value: string) => {
      setCells((prev) => {
        const next = { ...(prev || {}) };
        next[`${r},${c}`] = value;
        scheduleEmit({ ...sheet, rows, cols, colWidths, cells: next });
        return next;
      });
    },
    [colWidths, cols, rows, scheduleEmit, sheet]
  );

  const commitEdit = useCallback(() => {
    if (!editing) return;
    updateCellRaw(editing.r, editing.c, draft);
    setEditing(null);
    setDraft("");
  }, [draft, editing, updateCellRaw]);

  const startEdit = useCallback(
    (r: number, c: number, seed?: string) => {
      const raw = String(cells?.[`${r},${c}`] ?? "");
      setSelected({ r, c });
      setEditing({ r, c });
      setDraft(seed != null ? String(seed) : raw);
      requestAnimationFrame(() => {
        editInputRef.current?.focus?.({ preventScroll: true });
        editInputRef.current?.select?.();
      });
    },
    [cells]
  );

  const moveSel = useCallback(
    (dr: number, dc: number) => {
      setSelected((s) => {
        const nextR = s.r + dr;
        const nextC = s.c + dc;
        return {
          r: clamp(nextR, 0, rows - 1),
          c: clamp(nextC, 0, cols - 1),
        };
      });
    },
    [cols, rows]
  );

  const moveDownOrGrow = useCallback(() => {
    const s = selectedRef.current;
    const targetR = s.r + 1;
    if (targetR >= rows) {
      const grew = ensureRowExists(targetR);
      if (grew) {
        setSelected({ r: Math.min(targetR, MAX_ROWS - 1), c: clamp(s.c, 0, cols - 1) });
      } else {
        setSelected({ r: rows - 1, c: clamp(s.c, 0, cols - 1) });
      }
      return;
    }
    setSelected({ r: targetR, c: clamp(s.c, 0, cols - 1) });
  }, [cols, ensureRowExists, rows]);

  const scrollSelectedIntoView = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const s = selectedRef.current;
    const key = `${s.r},${s.c}`;

    let tries = 0;
    const tick = () => {
      const vp2 = viewportRef.current;
      if (!vp2) return;
      const el = vp2.querySelector(`[data-sheet-cell="${key}"]`) as HTMLElement | null;
      if (el) {
        try {
          el.scrollIntoView({ block: "nearest", inline: "nearest" });
        } catch {
          // ignore
        }
        return;
      }
      tries += 1;
      if (tries >= 6) return;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, []);

  useEffect(() => {
    // Keep selection visible, especially when auto-growing rows.
    scrollSelectedIntoView();
  }, [rows, selected.r, selected.c, scrollSelectedIntoView]);

  const copyText = useCallback(async (text: string) => {
    const t = String(text ?? "");
    try {
      await navigator.clipboard.writeText(t);
      return;
    } catch {
      // fallback
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = t;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    } catch {
      // ignore
    }
  }, []);

  const pasteText = useCallback(async () => {
    try {
      return await navigator.clipboard.readText();
    } catch {
      return null;
    }
  }, []);

  const handleKeyDown = useCallback(
    async (e: React.KeyboardEvent) => {
      if (!isSelected) return;
      if (editing) {
        if (e.key === "Enter") {
          e.preventDefault();
          commitEdit();
          moveDownOrGrow();
          scrollSelectedIntoView();
        } else if (e.key === "Escape") {
          e.preventDefault();
          setEditing(null);
          setDraft("");
        } else if (e.key === "Tab") {
          e.preventDefault();
          commitEdit();
          moveSel(0, e.shiftKey ? -1 : 1);
        }
        return;
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        updateCellRaw(selected.r, selected.c, "");
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
        e.preventDefault();
        const raw = cells?.[`${selected.r},${selected.c}`] ?? "";
        await copyText(String(raw));
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") {
        e.preventDefault();
        const t = await pasteText();
        if (t == null) return;
        const lines = String(t).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
        const startR = selected.r;
        const startC = selected.c;
        setCells((prev) => {
          const next = { ...(prev || {}) };
          for (let r = 0; r < lines.length; r += 1) {
            const parts = lines[r].split("\t");
            for (let c = 0; c < parts.length; c += 1) {
              const rr = startR + r;
              const cc = startC + c;
              if (rr >= rows || cc >= cols) continue;
              next[`${rr},${cc}`] = parts[c];
            }
          }
          scheduleEmit({ ...sheet, rows, cols, colWidths, cells: next });
          return next;
        });
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        moveDownOrGrow();
        scrollSelectedIntoView();
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        moveSel(0, e.shiftKey ? -1 : 1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        moveSel(-1, 0);
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        moveDownOrGrow();
        scrollSelectedIntoView();
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        moveSel(0, -1);
        return;
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        moveSel(0, 1);
        return;
      }
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        startEdit(selected.r, selected.c, e.key);
      }
    },
    [cells, colWidths, commitEdit, copyText, editing, isSelected, moveDownOrGrow, moveSel, pasteText, rows, cols, scheduleEmit, selected, sheet, startEdit, updateCellRaw, scrollSelectedIntoView]
  );

  const gridTemplateColumns = useMemo(() => {
    const widths = (colWidths || []).slice(0, cols).map((w) => `${Math.max(40, Math.floor(w))}px`);
    return `44px ${widths.join(" ")}`;
  }, [colWidths, cols]);

  const onColResizeMove = useCallback(
    (e: PointerEvent) => {
      if (!colResizeRef.current) return;
      const { col, startX, startW } = colResizeRef.current;
      const dx = e.clientX - startX;
      const nextW = Math.max(40, startW + dx);
      setColWidths((prev) => {
        const next = prev.slice();
        next[col] = nextW;
        scheduleEmit({ ...sheet, rows, cols, colWidths: next, cells });
        return next;
      });
    },
    [cells, cols, rows, scheduleEmit, sheet]
  );

  const stopColResize = useCallback(() => {
    colResizeRef.current = null;
    window.removeEventListener("pointermove", onColResizeMove as any);
    window.removeEventListener("pointerup", stopColResize as any);
  }, [onColResizeMove]);

  const startColResize = useCallback(
    (e: React.PointerEvent, col: number) => {
      e.preventDefault();
      e.stopPropagation();
      colResizeRef.current = { col, startX: e.clientX, startW: colWidths[col] || 96 };
      window.addEventListener("pointermove", onColResizeMove as any);
      window.addEventListener("pointerup", stopColResize as any);
    },
    [colWidths, onColResizeMove, stopColResize]
  );

  useEffect(() => {
    return () => stopColResize();
  }, [stopColResize]);

  const endResize = (pointerId: number) => {
    const r = resizeRef.current;
    if (!r || r.pointerId !== pointerId) return;
    if (r.raf != null) window.cancelAnimationFrame(r.raf);
    if (endResizeCleanupRef.current) {
      try {
        endResizeCleanupRef.current();
      } catch {
        // ignore
      }
      endResizeCleanupRef.current = null;
    }
    if (r.capturer) {
      try {
        r.capturer.releasePointerCapture(pointerId);
      } catch {
        // ignore
      }
    }
    resizeRef.current = null;
  };

  const installGlobalResizeEndHandlers = (pointerId: number) => {
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      endResize(pointerId);
    };
    const onCancel = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      endResize(pointerId);
    };
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

  const beginResize = (e: React.PointerEvent, mode: "right" | "top" | "bottom" | "corner") => {
    e.stopPropagation();
    e.preventDefault();
    bringToFront(id);
    if (!isSelected) selectBlocks([id]);
    pushHistory();

    const capturer = e.currentTarget as HTMLElement;
    resizeRef.current = {
      pointerId: e.pointerId,
      mode,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startX: block.x,
      startY: block.y,
      startW: block.width,
      startH: block.height,
      raf: null,
      capturer,
    };
    installGlobalResizeEndHandlers(e.pointerId);
    try {
      capturer.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  const startDragStrip = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    bringToFront(id);
    if (e.shiftKey) toggleSelect(id);
    else if (!isSelected) selectBlocks([id]);
    pushHistory();

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
      const dx2 = d2.lastX - d2.originX;
      const dy2 = d2.lastY - d2.originY;
      moveBlocksFromSnapshot(d2.snapshot, dx2, dy2, { snap: true });
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
      onPointerDownCapture={(e) => {
        if (e.button !== 0) return;
        const t = e.target as Element | null;
        if (t?.closest?.("[data-resize-handle]")) return;
        if (t?.closest?.("[data-drag-handle]")) return;
        if (e.shiftKey) toggleSelect(id);
        else if (!isSelected) selectBlocks([id]);
      }}
      onPointerMove={(e) => {
        const r = resizeRef.current;
        if (!r || r.pointerId !== e.pointerId) return;

        // Fail-safe: if the browser misses pointerup, stop on mouse button release.
        if (e.pointerType === "mouse" && e.buttons === 0) {
          endResize(e.pointerId);
          return;
        }

        const dx = e.clientX - r.startClientX;
        const dy = e.clientY - r.startClientY;
        if (r.raf != null) return;
        r.raf = window.requestAnimationFrame(() => {
          const rr = resizeRef.current;
          if (!rr) return;
          rr.raf = null;

          const g = Math.max(1, Math.floor(gridSize || 24));
          const minW = g * 6;
          const minH = g * 6;
          const bottom = rr.startY + rr.startH;

          if (rr.mode === "right") {
            const nextW = Math.max(minW, snapSize(rr.startW + dx));
            updateBlock(id, { width: nextW } as any);
            return;
          }
          if (rr.mode === "bottom") {
            const nextH = Math.max(minH, snapSize(rr.startH + dy));
            updateBlock(id, { height: nextH } as any);
            return;
          }
          if (rr.mode === "top") {
            const nextH = Math.max(minH, snapSize(rr.startH - dy));
            const nextY = snapToGrid(bottom - nextH, g);
            updateBlock(id, { y: nextY, height: nextH } as any);
            return;
          }
          // corner: free scale (like image, but without aspect locking)
          const nextW = Math.max(minW, snapSize(rr.startW + dx));
          const nextH = Math.max(minH, snapSize(rr.startH + dy));
          updateBlock(id, { width: nextW, height: nextH } as any);
        });
      }}
      onPointerUp={(e) => endResize(e.pointerId)}
      onPointerCancel={(e) => endResize(e.pointerId)}
      onLostPointerCapture={(e) => endResize(e.pointerId)}
    >
      <div className={`glass-block overflow-hidden relative ${isSelected ? "omnia-selected-glass" : ""}`} style={{ width: "100%", height: "100%" }}>
        {/* tiny drag strip */}
        <div
          data-drag-handle
          className="relative z-20 w-full cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ height: "8px" }}
          onPointerDown={startDragStrip}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
          onLostPointerCapture={onDragEnd}
          title="Drag to move"
        />

        <div className="w-full" style={{ height: "calc(100% - 8px)" }}>
          <div
            ref={rootRef}
            data-canvas-spreadsheet-root-id={id}
            tabIndex={0}
            className="w-full h-full outline-none"
            onKeyDown={handleKeyDown as any}
            onPointerDown={(e) => {
              e.stopPropagation();
              bringToFront(id);
              // Don't steal focus from the cell editor input.
              if (editing) return;
              requestAnimationFrame(() => rootRef.current?.focus?.({ preventScroll: true }));
            }}
          >
            <div
              ref={viewportRef}
              className="w-full h-full overflow-auto"
              style={{
                fontSize: 12,
                lineHeight: `${rowHeight}px`,
                userSelect: editing ? "text" : "none",
              }}
            >
              <div className="grid" style={{ gridTemplateColumns, gridAutoRows: `${rowHeight}px` }}>
                {/* top-left corner */}
                <div className="sticky top-0 left-0 z-20 bg-white/30 dark:bg-white/8 backdrop-blur-xl border-b border-r border-black/15 dark:border-white/18" />

                {/* column headers */}
                {Array.from({ length: cols }).map((_, c) => (
                  <div
                    key={`h-${c}`}
                    className="sticky top-0 z-10 bg-white/30 dark:bg-white/8 backdrop-blur-xl border-b border-black/15 dark:border-white/18 flex items-center justify-center text-xs text-gray-800 dark:text-gray-100 relative"
                  >
                    {colToLetters(c)}
                    <div className="absolute right-0 top-0 h-full w-1 cursor-col-resize" onPointerDown={(e) => startColResize(e, c)} />
                  </div>
                ))}

                {/* rows */}
                {Array.from({ length: rows }).map((_, r) => (
                  <React.Fragment key={`r-${r}`}>
                    <div className="sticky left-0 z-10 bg-white/30 dark:bg-white/8 backdrop-blur-xl border-r border-black/15 dark:border-white/18 flex items-center justify-center text-xs text-gray-800 dark:text-gray-100">
                      {r + 1}
                    </div>
                    {Array.from({ length: cols }).map((__, c) => {
                      const isSel = selected.r === r && selected.c === c;
                      const isEdit = editing?.r === r && editing?.c === c;
                      const raw = String(cells?.[`${r},${c}`] ?? "");
                      const shown = display[r]?.[c] ?? "";
                      const cellSelStyle: React.CSSProperties | undefined = isSel
                        ? {
                            boxShadow:
                              "inset 0 0 0 1px rgba(170,215,255,0.55), inset 0 0 18px rgba(120,195,255,0.22), inset 0 1px 0 rgba(255,255,255,0.18)",
                          }
                        : undefined;
                      return (
                        <div
                          key={`c-${r}-${c}`}
                          data-sheet-cell={`${r},${c}`}
                          className={`border-b border-black/15 dark:border-white/18 ${
                            c !== cols - 1 ? "border-r border-black/15 dark:border-white/18" : ""
                          } bg-white/22 dark:bg-white/6 backdrop-blur-xl px-1 overflow-hidden`}
                          style={{ cursor: "default", boxShadow: "inset 0 -1px 0 rgba(0,0,0,0.12)", ...(cellSelStyle || {}) }}
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelected({ r, c });
                            setEditing(null);
                            setDraft("");
                            bringToFront(id);
                            scrollSelectedIntoView();
                          }}
                          onDoubleClick={(e) => {
                            e.stopPropagation();
                            startEdit(r, c);
                          }}
                        >
                          {isEdit ? (
                            <input
                              ref={editInputRef}
                              autoFocus
                              className="w-full h-full bg-transparent outline-none text-xs text-gray-900 dark:text-gray-100"
                              value={draft}
                              onChange={(e) => setDraft(e.target.value)}
                              onBlur={() => commitEdit()}
                              onKeyDown={(e) => e.stopPropagation()}
                            />
                          ) : (
                            <div className="w-full h-full flex items-center text-xs text-gray-900 dark:text-gray-100">
                              {raw.startsWith("=") ? shown : raw}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </React.Fragment>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Resize handles (match ImageBlock UX) */}
      <div className="absolute inset-0 pointer-events-none z-10">
        {/* Right edge stretch */}
        <div
          data-resize-handle
          className="absolute top-0 bottom-0 right-0 w-2 pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ cursor: "ew-resize" }}
          onPointerDown={(e) => beginResize(e, "right")}
          title="Resize width"
        />
        {/* Bottom edge stretch */}
        <div
          data-resize-handle
          className="absolute left-0 right-0 bottom-0 h-2 pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ cursor: "ns-resize" }}
          onPointerDown={(e) => beginResize(e, "bottom")}
          title="Resize height"
        />
        {/* Bottom-right corner scale */}
        <div
          data-resize-handle
          className="absolute right-0 bottom-0 w-4 h-4 pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ cursor: "nwse-resize" }}
          onPointerDown={(e) => beginResize(e, "corner")}
          title="Scale"
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

