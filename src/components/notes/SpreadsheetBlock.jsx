import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

function colToLetters(colIdx) {
  let n = colIdx + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function lettersToCol(letters) {
  const s = (letters || "").toUpperCase();
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 65 || c > 90) return null;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

function parseCellRef(token) {
  const m = String(token || "").toUpperCase().match(/^([A-Z]+)(\d+)$/);
  if (!m) return null;
  const col = lettersToCol(m[1]);
  const row = Number(m[2]) - 1;
  if (!Number.isFinite(col) || !Number.isFinite(row) || col < 0 || row < 0) return null;
  return { row, col };
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function isNumberToken(t) {
  return t && t.type === "number";
}

function tokenize(expr) {
  const s = String(expr || "");
  const tokens = [];
  let i = 0;
  const push = (type, value) => tokens.push({ type, value });
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j])) j += 1;
      push("number", s.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j += 1;
      push("ident", s.slice(i, j));
      i = j;
      continue;
    }
    if ("+-*/():,=".includes(ch)) {
      push("op", ch);
      i += 1;
      continue;
    }
    // Unknown char: skip
    i += 1;
  }
  return tokens;
}

function makeParser(tokens, getCellNumeric) {
  let idx = 0;
  const peek = () => tokens[idx];
  const next = () => tokens[idx++];
  const matchOp = (op) => peek()?.type === "op" && peek()?.value === op;

  const parsePrimary = () => {
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
      // Function call (only SUM supported)
      if (matchOp("(")) {
        next(); // (
        const args = [];
        if (!matchOp(")")) {
          while (true) {
            // Range A1:A10 or expression
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
        if (ident.toUpperCase() === "SUM") {
          let sum = 0;
          for (const a of args) {
            // a.value may be number or array
            if (Array.isArray(a.value)) {
              for (const v of a.value) sum += Number(v) || 0;
            } else {
              sum += Number(a.value) || 0;
            }
          }
          return { ok: true, value: sum };
        }
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
      return { ok: true, value: op === "-" ? -(Number(v.value) || 0) : Number(v.value) || 0 };
    }
    return { ok: false, value: NaN };
  };

  // Handle ranges like A1:A10 (only valid as an argument; represented as array)
  const parseRangeOrPrimary = () => {
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
          const out = [];
          for (let r = r1; r <= r2; r += 1) {
            for (let c = c1; c <= c2; c += 1) out.push(getCellNumeric(r, c));
          }
          return { ok: true, value: out };
        }
        // Not a range; it's a single cell numeric
        return { ok: true, value: getCellNumeric(maybeRef.row, maybeRef.col) };
      }
    }
    return parsePrimary();
  };

  const parseMulDiv = () => {
    let left = parseRangeOrPrimary();
    if (!left.ok) return left;
    while (matchOp("*") || matchOp("/")) {
      const op = next().value;
      const right = parseRangeOrPrimary();
      if (!right.ok) return right;
      const a = Number(left.value) || 0;
      const b = Number(right.value) || 0;
      left = { ok: true, value: op === "*" ? a * b : a / b };
    }
    return left;
  };

  const parseExpression = () => {
    let left = parseMulDiv();
    if (!left.ok) return left;
    while (matchOp("+") || matchOp("-")) {
      const op = next().value;
      const right = parseMulDiv();
      if (!right.ok) return right;
      const a = Number(left.value) || 0;
      const b = Number(right.value) || 0;
      left = { ok: true, value: op === "+" ? a + b : a - b };
    }
    return left;
  };

  return { parseExpression };
}

function computeGrid({ rows, cols, cells }) {
  const raw = cells || {};
  const memo = new Map();
  const visiting = new Set();

  const keyOf = (r, c) => `${r},${c}`;

  const getRaw = (r, c) => {
    const v = raw[keyOf(r, c)];
    return v == null ? "" : String(v);
  };

  const getNumeric = (r, c) => {
    const k = keyOf(r, c);
    if (memo.has(k)) return memo.get(k);
    if (visiting.has(k)) {
      const out = { kind: "err", value: "#CYCLE" };
      memo.set(k, out);
      return out;
    }
    visiting.add(k);
    const v = getRaw(r, c);
    let out = { kind: "value", value: v };
    if (v.startsWith("=")) {
      const expr = v.slice(1);
      try {
        const tokens = tokenize(expr);
        const parser = makeParser(tokens, (rr, cc) => Number(getNumeric(rr, cc)?.value) || 0);
        const res = parser.parseExpression();
        if (!res.ok || !Number.isFinite(Number(res.value))) out = { kind: "err", value: "#ERR" };
        else out = { kind: "value", value: String(Number(res.value)) };
      } catch {
        out = { kind: "err", value: "#ERR" };
      }
    } else {
      const n = Number(v);
      if (v.trim().length && Number.isFinite(n)) out = { kind: "value", value: String(n) };
      else out = { kind: "value", value: v };
    }
    visiting.delete(k);
    if (out.kind === "cycle") out = { kind: "err", value: "#CYCLE" };
    memo.set(k, out);
    return out;
  };

  const display = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ""));
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const res = getNumeric(r, c);
      display[r][c] = res.kind === "err" ? String(res.value) : String(res.value ?? "");
    }
  }
  return display;
}

export default function SpreadsheetBlock({
  sheet,
  rows = 30,
  cols = 20,
  rowHeight = 24,
  isSelected = false,
  onSheetChange,
  onRequestFocus,
  autoFocus = false,
  onDidAutoFocus,
}) {
  const initial = sheet || { version: 1, rows, cols, colWidths: Array.from({ length: cols }, () => 96), cells: {} };
  const [colWidths, setColWidths] = useState(() => initial.colWidths || Array.from({ length: cols }, () => 96));
  const [cells, setCells] = useState(() => initial.cells || {});
  const [selected, setSelected] = useState({ r: 0, c: 0 });
  const [editing, setEditing] = useState(null); // { r, c }
  const [draft, setDraft] = useState("");
  const rootRef = useRef(null);
  const editInputRef = useRef(null);
  const colResizeRef = useRef(null); // { col, startX, startW }
  const emitTimerRef = useRef(null);

  useEffect(() => {
    // Sync from parent if sheet object changes (best-effort).
    if (!sheet) return;
    if (Array.isArray(sheet.colWidths)) setColWidths(sheet.colWidths);
    if (sheet.cells) setCells(sheet.cells);
  }, [sheet]);

  const display = useMemo(() => computeGrid({ rows, cols, cells }), [rows, cols, cells]);

  const scheduleEmit = useCallback((next) => {
    if (!onSheetChange) return;
    if (emitTimerRef.current) clearTimeout(emitTimerRef.current);
    emitTimerRef.current = setTimeout(() => {
      onSheetChange(next);
    }, 120);
  }, [onSheetChange]);

  useEffect(() => {
    return () => {
      if (emitTimerRef.current) clearTimeout(emitTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!autoFocus) return;
    requestAnimationFrame(() => {
      rootRef.current?.focus?.({ preventScroll: true });
      onDidAutoFocus?.();
    });
  }, [autoFocus, onDidAutoFocus]);

  const updateCellRaw = useCallback((r, c, value) => {
    setCells((prev) => {
      const next = { ...(prev || {}) };
      next[`${r},${c}`] = value;
      scheduleEmit({ version: 1, rows, cols, colWidths, cells: next });
      return next;
    });
  }, [colWidths, cols, rows, scheduleEmit]);

  const commitEdit = useCallback(() => {
    if (!editing) return;
    updateCellRaw(editing.r, editing.c, draft);
    setEditing(null);
    setDraft("");
  }, [draft, editing, updateCellRaw]);

  const startEdit = useCallback((r, c, seed) => {
    const raw = String(cells?.[`${r},${c}`] ?? "");
    setSelected({ r, c });
    setEditing({ r, c });
    setDraft(seed != null ? String(seed) : raw);
    requestAnimationFrame(() => {
      editInputRef.current?.focus?.({ preventScroll: true });
      editInputRef.current?.select?.();
    });
  }, [cells]);

  const moveSel = useCallback((dr, dc) => {
    setSelected((s) => ({
      r: clamp(s.r + dr, 0, rows - 1),
      c: clamp(s.c + dc, 0, cols - 1),
    }));
  }, [cols, rows]);

  const copyText = useCallback(async (text) => {
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
      const t = await navigator.clipboard.readText();
      return t;
    } catch {
      return null;
    }
  }, []);

  const handleKeyDown = useCallback(async (e) => {
    if (!isSelected) return;

    if (editing) {
      if (e.key === "Enter") {
        e.preventDefault();
        commitEdit();
        moveSel(1, 0);
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
      // Clear selected cell when not editing.
      // If the user wants to delete the whole spreadsheet block, they can click outside the grid first.
      e.preventDefault();
      updateCellRaw(selected.r, selected.c, "");
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
      e.preventDefault();
      const raw = cells?.[`${selected.r},${selected.c}`] ?? "";
      await copyText(raw);
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
        scheduleEmit({ version: 1, rows, cols, colWidths, cells: next });
        return next;
      });
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      moveSel(1, 0);
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
      moveSel(1, 0);
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
      // Start editing on type
      e.preventDefault();
      startEdit(selected.r, selected.c, e.key);
    }
  }, [cells, colWidths, cols, commitEdit, copyText, editing, isSelected, moveSel, pasteText, rows, scheduleEmit, selected.c, selected.r, startEdit]);

  const gridTemplateColumns = useMemo(() => {
    const widths = colWidths.slice(0, cols).map((w) => `${Math.max(40, Math.floor(w))}px`);
    return `44px ${widths.join(" ")}`;
  }, [colWidths, cols]);

  const onColResizeMove = useCallback((e) => {
    if (!colResizeRef.current) return;
    const { col, startX, startW } = colResizeRef.current;
    const dx = e.clientX - startX;
    const nextW = Math.max(40, startW + dx);
    setColWidths((prev) => {
      const next = prev.slice();
      next[col] = nextW;
      scheduleEmit({ version: 1, rows, cols, colWidths: next, cells });
      return next;
    });
  }, [cells, cols, rows, scheduleEmit]);

  const stopColResize = useCallback(() => {
    colResizeRef.current = null;
    window.removeEventListener("pointermove", onColResizeMove);
    window.removeEventListener("pointerup", stopColResize);
  }, [onColResizeMove]);

  const startColResize = useCallback((e, col) => {
    e.preventDefault();
    e.stopPropagation();
    colResizeRef.current = { col, startX: e.clientX, startW: colWidths[col] || 96 };
    window.addEventListener("pointermove", onColResizeMove);
    window.addEventListener("pointerup", stopColResize);
  }, [colWidths, onColResizeMove, stopColResize]);

  useEffect(() => {
    return () => stopColResize();
  }, [stopColResize]);

  return (
    <div
      ref={rootRef}
      data-spreadsheet-root
      tabIndex={0}
      className="w-full h-full outline-none"
      onKeyDown={handleKeyDown}
      onPointerDown={(e) => {
        e.stopPropagation();
        onRequestFocus?.();
        // Don't steal focus from the active cell editor input.
        if (editing) return;
        requestAnimationFrame(() => {
          rootRef.current?.focus?.({ preventScroll: true });
        });
      }}
    >
      <div
        className="w-full h-full overflow-auto"
        style={{
          fontSize: 12,
          lineHeight: `${rowHeight}px`,
          userSelect: editing ? "text" : "none",
        }}
      >
        <div
          className="grid"
          style={{
            gridTemplateColumns,
            gridAutoRows: `${rowHeight}px`,
          }}
        >
          {/* top-left corner */}
          <div className="sticky top-0 left-0 z-20 bg-white/30 dark:bg-white/8 backdrop-blur-xl border-b border-r border-black/15 dark:border-white/18" />

          {/* column headers */}
          {Array.from({ length: cols }).map((_, c) => (
            <div
              key={`h-${c}`}
              className="sticky top-0 z-10 bg-white/30 dark:bg-white/8 backdrop-blur-xl border-b border-black/15 dark:border-white/18 flex items-center justify-center text-xs text-gray-800 dark:text-gray-100 relative"
            >
              {colToLetters(c)}
              {/* resize handle */}
              <div
                className="absolute right-0 top-0 h-full w-1 cursor-col-resize"
                onPointerDown={(e) => startColResize(e, c)}
              />
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
                return (
                  <div
                    key={`c-${r}-${c}`}
                    className={`border-b border-black/15 dark:border-white/18 ${
                      c !== cols - 1 ? "border-r border-black/15 dark:border-white/18" : ""
                    } ${isSel ? "outline outline-2 outline-blue-500/60 -outline-offset-2" : ""} bg-white/22 dark:bg-white/6 backdrop-blur-xl px-1 overflow-hidden`}
                    style={{
                      cursor: "default",
                      // Extra separation so rows are readable on bright glass backgrounds
                      boxShadow: "inset 0 -1px 0 rgba(0,0,0,0.12)",
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelected({ r, c });
                      setEditing(null);
                      setDraft("");
                      onRequestFocus?.();
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
                        onBlur={() => {
                          commitEdit();
                        }}
                        onKeyDown={(e) => {
                          // let parent handler manage Enter/Tab/Escape
                          e.stopPropagation();
                        }}
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
  );
}

