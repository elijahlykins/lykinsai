import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";

/* ── GFM table parser / serializer ────────────────────────────────── */

function parseGfmTable(md: string): { headers: string[]; rows: string[][] } | null {
  const lines = md.trim().split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 2) return null;

  const isPipeRow = (l: string) => {
    const t = l.trim();
    return t.startsWith("|") && t.endsWith("|");
  };
  if (!lines.every(isPipeRow)) return null;

  const splitRow = (line: string) =>
    line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());

  const headers = splitRow(lines[0]);
  if (!/^\|[\s\-:|]+\|$/.test(lines[1].trim())) return null;

  const rows = lines.slice(2).map((line) => {
    const cells = splitRow(line);
    while (cells.length < headers.length) cells.push("");
    return cells.slice(0, headers.length);
  });

  return { headers, rows };
}

function serializeGfmTable(headers: string[], rows: string[][]): string {
  const colCount = headers.length;
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));

  const widths = headers.map((h, i) => {
    let max = h.length;
    for (const row of rows) max = Math.max(max, (row[i] || "").length);
    return Math.max(max, 3);
  });

  const headerLine = "| " + headers.map((h, i) => pad(h, widths[i])).join(" | ") + " |";
  const sepLine = "| " + widths.map((w) => "-".repeat(w)).join(" | ") + " |";
  const dataLines = rows.map(
    (row) =>
      "| " +
      Array.from({ length: colCount }, (_, i) => pad(row[i] || "", widths[i])).join(" | ") +
      " |"
  );

  return [headerLine, sepLine, ...dataLines].join("\n");
}

/* ── Component ────────────────────────────────────────────────────── */

const GRID = 24;
const snap = (n: number) => Math.ceil(n / GRID) * GRID;
const COL_MIN_WIDTH = 120;
const ROW_HEIGHT_EST = 36;
const TABLE_PADDING = 48;

export const EditableMarkdownTable = memo(function EditableMarkdownTable({
  blockId,
  content,
}: {
  blockId: string;
  content: string;
}) {
  const updateBlock = useCanvasStore((s) => s.updateBlock);
  const block = useCanvasStore((s) => s.blocks[blockId]);

  const parsed = useMemo(() => parseGfmTable(content), [content]);
  const [headers, setHeaders] = useState<string[]>(parsed?.headers || ["Column 1", "Column 2", "Column 3"]);
  const [rows, setRows] = useState<string[][]>(parsed?.rows || [["", "", ""]]);

  const [editCell, setEditCell] = useState<{ r: number; c: number } | null>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const p = parseGfmTable(content);
    if (p) {
      setHeaders(p.headers);
      setRows(p.rows);
    }
  }, [content]);

  const autoGrow = useCallback(
    (colCount: number, rowCount: number) => {
      if (!block) return;
      const neededW = snap(colCount * COL_MIN_WIDTH + TABLE_PADDING);
      const neededH = snap((rowCount + 2) * ROW_HEIGHT_EST + TABLE_PADDING);
      const patch: Record<string, any> = {};
      if (neededW > (block.width || 0)) patch.width = neededW;
      if (neededH > (block.height || 0)) patch.height = neededH;
      if (Object.keys(patch).length) updateBlock(blockId, patch as any);
    },
    [block, blockId, updateBlock]
  );

  useLayoutEffect(() => {
    autoGrow(headers.length, rows.length);
  }, [headers.length, rows.length, autoGrow]);

  const commit = useCallback(() => {
    if (!editCell) return;
    const { r, c } = editCell;

    let nextHeaders = headers;
    let nextRows = rows;

    if (r === -1) {
      nextHeaders = [...headers];
      nextHeaders[c] = draft;
      setHeaders(nextHeaders);
    } else {
      nextRows = rows.map((row) => [...row]);
      nextRows[r][c] = draft;
      setRows(nextRows);
    }

    setEditCell(null);
    setDraft("");

    const md = serializeGfmTable(r === -1 ? nextHeaders : headers, r === -1 ? rows : nextRows);
    updateBlock(blockId, { content: md } as any);
  }, [blockId, draft, editCell, headers, rows, updateBlock]);

  const startEdit = useCallback(
    (r: number, c: number) => {
      const value = r === -1 ? headers[c] || "" : rows[r]?.[c] || "";
      setEditCell({ r, c });
      setDraft(value);
      requestAnimationFrame(() => {
        inputRef.current?.focus({ preventScroll: true });
        inputRef.current?.select();
      });
    },
    [headers, rows]
  );

  const addRow = useCallback(() => {
    const newRow = Array.from({ length: headers.length }, () => "");
    const nextRows = [...rows, newRow];
    setRows(nextRows);
    updateBlock(blockId, { content: serializeGfmTable(headers, nextRows) } as any);
  }, [blockId, headers, rows, updateBlock]);

  const addColumn = useCallback(() => {
    const nextHeaders = [...headers, `Column ${headers.length + 1}`];
    const nextRows = rows.map((row) => [...row, ""]);
    setHeaders(nextHeaders);
    setRows(nextRows);
    updateBlock(blockId, { content: serializeGfmTable(nextHeaders, nextRows) } as any);
  }, [blockId, headers, rows, updateBlock]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        setEditCell(null);
        setDraft("");
      } else if (e.key === "Tab") {
        e.preventDefault();
        commit();
        if (!editCell) return;
        const { r, c } = editCell;
        const nextC = e.shiftKey ? c - 1 : c + 1;
        if (nextC >= 0 && nextC < headers.length) {
          requestAnimationFrame(() => startEdit(r, nextC));
        } else if (!e.shiftKey && r < rows.length - 1) {
          requestAnimationFrame(() => startEdit(r + 1, 0));
        } else if (e.shiftKey && r > -1) {
          requestAnimationFrame(() => startEdit(r - 1, headers.length - 1));
        }
      }
    },
    [commit, editCell, headers.length, rows.length, startEdit]
  );

  if (!parsed && !headers.length) return null;

  const renderCell = (r: number, c: number, value: string, isHeader: boolean) => {
    const isEditing = editCell?.r === r && editCell?.c === c;

    if (isEditing) {
      return (
        <input
          ref={inputRef}
          autoFocus
          className={`w-full bg-transparent outline-none ${isHeader ? "font-semibold" : ""}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={handleKeyDown}
          onClick={(e) => e.stopPropagation()}
        />
      );
    }

    return (
      <span className={`truncate block ${!value ? "opacity-30" : ""}`}>
        {value || (isHeader ? "Header" : "\u00A0")}
      </span>
    );
  };

  return (
    <div ref={wrapperRef} className="group/table my-3 relative">
      <table className="w-full border-collapse text-sm" style={{ minWidth: headers.length * COL_MIN_WIDTH }}>
        <thead className="border-b border-black/20 dark:border-white/20">
          <tr>
            {headers.map((h, c) => (
              <th
                key={`th-${c}`}
                className={`text-left px-3 py-2 font-semibold cursor-default ${
                  editCell?.r === -1 && editCell?.c === c ? "bg-blue-500/10" : ""
                }`}
                onClick={(e) => { e.stopPropagation(); startEdit(-1, c); }}
              >
                {renderCell(-1, c, h, true)}
              </th>
            ))}
            <th
              className="w-6 px-0 opacity-0 group-hover/table:opacity-100 transition-opacity cursor-pointer hover:bg-blue-500/10"
              onClick={(e) => { e.stopPropagation(); addColumn(); }}
              title="Add column"
            >
              <Plus className="w-3 h-3 mx-auto text-gray-400" />
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={`tr-${r}`} className="border-b border-black/10 dark:border-white/10">
              {row.map((cell, c) => (
                <td
                  key={`td-${r}-${c}`}
                  className={`px-3 py-2 cursor-default ${
                    editCell?.r === r && editCell?.c === c ? "bg-blue-500/10" : ""
                  }`}
                  onClick={(e) => { e.stopPropagation(); startEdit(r, c); }}
                >
                  {renderCell(r, c, cell, false)}
                </td>
              ))}
              <td className="w-6" />
            </tr>
          ))}
        </tbody>
      </table>
      {/* Add row button */}
      <div
        className="flex items-center justify-center cursor-pointer opacity-0 group-hover/table:opacity-100 transition-opacity hover:bg-blue-500/10 border-t border-black/10 dark:border-white/10"
        style={{ height: 24 }}
        onClick={(e) => { e.stopPropagation(); addRow(); }}
        title="Add row"
      >
        <Plus className="w-3 h-3 text-gray-400" />
      </div>
    </div>
  );
});

/* ── Utility: extract table data from HAST node ──────────────────── */

function hastText(node: any): string {
  if (!node) return "";
  if (node.type === "text") return node.value || "";
  if (Array.isArray(node.children)) return node.children.map(hastText).join("");
  return "";
}

function hastTableData(node: any): { headers: string[]; rows: string[][] } | null {
  if (!node?.children) return null;
  let headers: string[] = [];
  const rows: string[][] = [];

  for (const child of node.children) {
    if (child.tagName === "thead") {
      for (const tr of child.children || []) {
        if (tr.tagName !== "tr") continue;
        headers = (tr.children || [])
          .filter((c: any) => c.tagName === "th")
          .map((th: any) => hastText(th).trim());
      }
    }
    if (child.tagName === "tbody") {
      for (const tr of child.children || []) {
        if (tr.tagName !== "tr") continue;
        rows.push(
          (tr.children || [])
            .filter((c: any) => c.tagName === "td")
            .map((td: any) => hastText(td).trim())
        );
      }
    }
  }
  if (!headers.length) return null;
  return { headers, rows };
}

/* ── Utility: replace the nth pipe-table block in markdown ───────── */

function replaceNthTable(markdown: string, tableIndex: number, newTable: string): string {
  const lines = markdown.split("\n");
  let idx = -1;
  let start = -1;
  let end = -1;
  let inTable = false;

  for (let i = 0; i <= lines.length; i++) {
    const isTable = i < lines.length && /^\s*\|/.test(lines[i]) && /\|\s*$/.test(lines[i]);
    if (isTable && !inTable) {
      inTable = true;
      idx++;
      start = i;
    }
    if (!isTable && inTable) {
      end = i;
      inTable = false;
      if (idx === tableIndex) break;
      start = -1;
    }
  }
  if (start === -1 || idx !== tableIndex) return markdown;
  return [...lines.slice(0, start), newTable, ...lines.slice(end)].join("\n");
}

/* ── Inline table for mixed-content markdown ─────────────────────── */

export const InlineEditableTable = memo(function InlineEditableTable({
  blockId,
  node,
  children,
  tableIndex,
}: {
  blockId: string;
  node: any;
  children: any;
  tableIndex: number;
}) {
  const updateBlock = useCanvasStore((s) => s.updateBlock);
  const block = useCanvasStore((s) => s.blocks[blockId]);

  const data = useMemo(() => hastTableData(node), [node]);

  const addRow = useCallback(() => {
    if (!data || !block) return;
    const nextRows = [...data.rows, Array.from({ length: data.headers.length }, () => "")];
    const newMd = serializeGfmTable(data.headers, nextRows);
    const fullContent = String((block as any).content || "");
    const updated = replaceNthTable(fullContent, tableIndex, newMd);
    updateBlock(blockId, { content: updated } as any);
  }, [block, blockId, data, tableIndex, updateBlock]);

  const addCol = useCallback(() => {
    if (!data || !block) return;
    const nextHeaders = [...data.headers, `Column ${data.headers.length + 1}`];
    const nextRows = data.rows.map((r) => [...r, ""]);
    const newMd = serializeGfmTable(nextHeaders, nextRows);
    const fullContent = String((block as any).content || "");
    const updated = replaceNthTable(fullContent, tableIndex, newMd);
    updateBlock(blockId, { content: updated } as any);
  }, [block, blockId, data, tableIndex, updateBlock]);

  if (!data) {
    return React.createElement("div", { className: "my-3 overflow-x-auto" },
      React.createElement("table", { className: "w-full border-collapse text-sm" }, children)
    );
  }

  return React.createElement("div", { className: "group/table my-3 relative" },
    React.createElement("table", { className: "w-full border-collapse text-sm" },
      children,
      React.createElement("thead", null,
        React.createElement("tr", null,
          React.createElement("th", {
            colSpan: data.headers.length,
            className: "p-0 border-0",
          },
            React.createElement("div", {
              className: "flex justify-end gap-1 opacity-0 group-hover/table:opacity-100 transition-opacity py-1",
            },
              React.createElement("button", {
                className: "text-xs text-gray-400 hover:text-gray-600 px-2 py-0.5 rounded hover:bg-blue-500/10",
                onClick: (e: any) => { e.stopPropagation(); addRow(); },
              }, "+ Row"),
              React.createElement("button", {
                className: "text-xs text-gray-400 hover:text-gray-600 px-2 py-0.5 rounded hover:bg-blue-500/10",
                onClick: (e: any) => { e.stopPropagation(); addCol(); },
              }, "+ Column"),
            )
          )
        )
      )
    )
  );
});

export { parseGfmTable };
