import React, { memo, useEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom";
import { Plus, Trash2, X, Pencil, BarChart3 } from "lucide-react";
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  AreaChart, Area,
} from "recharts";
import { useCanvasStore } from "@/store/canvasStore";
import { snapToGrid } from "@/canvas/utils/snap";

const CHART_COLORS = [
  "#3B82F6", "#16A34A", "#D97706", "#DC2626", "#7C3AED",
  "#DB2777", "#0F766E",
];

type ChartType = "bar" | "line" | "area" | "pie";

type DataRow = { label: string; [key: string]: string | number };
type ChartData = {
  type: ChartType;
  title: string;
  series: string[];
  rows: DataRow[];
};

const DEFAULT_CHART: ChartData = {
  type: "bar",
  title: "Chart",
  series: ["Series A", "Series B"],
  rows: [
    { label: "Jan", "Series A": 40, "Series B": 24 },
    { label: "Feb", "Series A": 30, "Series B": 38 },
    { label: "Mar", "Series A": 55, "Series B": 43 },
    { label: "Apr", "Series A": 47, "Series B": 52 },
    { label: "May", "Series A": 62, "Series B": 35 },
  ],
};

function parseChart(content: string): ChartData {
  try {
    const d = JSON.parse(content);
    return {
      type: d.type || "bar",
      title: d.title || "Chart",
      series: d.series || DEFAULT_CHART.series,
      rows: d.rows || DEFAULT_CHART.rows,
    };
  } catch {
    return { ...DEFAULT_CHART };
  }
}

export const ChartBlock = memo(function ChartBlock({ id }: { id: string }) {
  const block = useCanvasStore((s) => s.blocks[id]) as any;
  const updateBlock = useCanvasStore((s) => s.updateBlock);
  const pushHistory = useCanvasStore((s) => s.pushHistory);
  const bringToFront = useCanvasStore((s) => s.bringToFront);
  const gridSize = 24;

  const resizeRef = useRef<any>(null);
  const endResizeCleanupRef = useRef<(() => void) | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);

  const chart = useMemo(() => parseChart(String(block?.content ?? "")), [block?.content]);

  const style = useMemo(() => {
    if (!block || block.format !== "chart") return null;
    return {
      position: "absolute" as const,
      left: `${block.x}px`,
      top: `${block.y}px`,
      width: `${block.width}px`,
      height: `${block.height}px`,
    };
  }, [block]);

  if (!block || block.format !== "chart" || !style) return null;

  const save = (patch: Partial<ChartData>) => {
    const next = { ...chart, ...patch };
    pushHistory();
    updateBlock(id, { content: JSON.stringify(next) } as any);
  };

  const setType = (t: ChartType) => save({ type: t });

  const snapSize = (n: number) => Math.max(gridSize, snapToGrid(n, gridSize));

  const endResize = (pointerId: number) => {
    const r = resizeRef.current;
    if (!r || r.pointerId !== pointerId) return;
    if (r.raf != null) window.cancelAnimationFrame(r.raf);
    if (endResizeCleanupRef.current) { try { endResizeCleanupRef.current(); } catch {} endResizeCleanupRef.current = null; }
    if (r.capturer) { try { r.capturer.releasePointerCapture(pointerId); } catch {} }
    resizeRef.current = null;
  };

  const beginResize = (e: React.PointerEvent, mode: "right" | "bottom" | "corner") => {
    e.stopPropagation(); e.preventDefault(); bringToFront(id);
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const onUp = (ev: PointerEvent) => { if (ev.pointerId === e.pointerId) endResize(e.pointerId); };
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    endResizeCleanupRef.current = () => { window.removeEventListener("pointerup", onUp, true); window.removeEventListener("pointercancel", onUp, true); };
    resizeRef.current = { mode, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, origW: block.width, origH: block.height, raf: null, capturer: el };
  };

  const onResizeMove = (e: React.PointerEvent) => {
    const r = resizeRef.current;
    if (!r || r.pointerId !== e.pointerId) return;
    if (r.raf != null) window.cancelAnimationFrame(r.raf);
    const dx = e.clientX - r.startX;
    const dy = e.clientY - r.startY;
    r.raf = window.requestAnimationFrame(() => {
      updateBlock(id, { width: r.mode !== "bottom" ? snapSize(r.origW + dx) : r.origW, height: r.mode !== "right" ? snapSize(r.origH + dy) : r.origH } as any);
    });
  };

  const renderChart = () => {
    const { type, rows, series } = chart;
    if (type === "pie") {
      const pieData = rows.map((r) => ({ name: r.label, value: Number(r[series[0]] || 0) }));
      return (
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius="75%" label={{ fontSize: 11 }}>
              {pieData.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
            </Pie>
            <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid rgba(0,0,0,0.08)" }} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
          </PieChart>
        </ResponsiveContainer>
      );
    }
    if (type === "area") {
      return (
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={rows}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.05)" />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: "rgba(0,0,0,0.45)" }} axisLine={{ stroke: "rgba(0,0,0,0.08)" }} tickLine={false} />
            <YAxis tick={{ fontSize: 11, fill: "rgba(0,0,0,0.45)" }} axisLine={false} tickLine={false} />
            <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid rgba(0,0,0,0.08)" }} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {series.map((s, i) => (
              <Area key={s} type="monotone" dataKey={s} fill={CHART_COLORS[i % CHART_COLORS.length]} stroke={CHART_COLORS[i % CHART_COLORS.length]} fillOpacity={0.15} strokeWidth={2} />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      );
    }
    if (type === "line") {
      return (
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.05)" />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: "rgba(0,0,0,0.45)" }} axisLine={{ stroke: "rgba(0,0,0,0.08)" }} tickLine={false} />
            <YAxis tick={{ fontSize: 11, fill: "rgba(0,0,0,0.45)" }} axisLine={false} tickLine={false} />
            <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid rgba(0,0,0,0.08)" }} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {series.map((s, i) => (
              <Line key={s} type="monotone" dataKey={s} stroke={CHART_COLORS[i % CHART_COLORS.length]} strokeWidth={2} dot={{ r: 3, strokeWidth: 2 }} activeDot={{ r: 5 }} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      );
    }
    return (
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} barCategoryGap="20%">
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.05)" />
          <XAxis dataKey="label" tick={{ fontSize: 11, fill: "rgba(0,0,0,0.45)" }} axisLine={{ stroke: "rgba(0,0,0,0.08)" }} tickLine={false} />
          <YAxis tick={{ fontSize: 11, fill: "rgba(0,0,0,0.45)" }} axisLine={false} tickLine={false} />
          <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid rgba(0,0,0,0.08)" }} cursor={{ fill: "rgba(0,0,0,0.03)" }} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {series.map((s, i) => (
            <Bar key={s} dataKey={s} fill={CHART_COLORS[i % CHART_COLORS.length]} radius={[4, 4, 0, 0]} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    );
  };

  return (
    <div data-canvas-block data-block-id={id} style={style} className="group" onPointerDown={() => bringToFront(id)}>
      <div className="w-full h-full rounded-lg border border-black/10 bg-white shadow-md flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-black/5 shrink-0" style={{ background: "rgba(0,0,0,0.015)" }} onPointerDown={(e) => e.stopPropagation()}>
          <input
            className="flex-1 text-[13px] font-semibold bg-transparent outline-none text-black/80 placeholder:text-black/30"
            value={chart.title}
            onChange={(e) => save({ title: e.target.value })}
            placeholder="Chart title"
          />
          <div className="flex gap-0.5">
            {(["bar", "line", "area", "pie"] as ChartType[]).map((t) => (
              <button
                key={t}
                type="button"
                className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${chart.type === t ? "bg-blue-500/15 text-blue-600 font-medium" : "text-black/40 hover:bg-black/5"}`}
                onMouseDown={(e) => { e.preventDefault(); setType(t); }}
              >
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {/* Chart — click overlay to edit data */}
        <div className="flex-1 p-3 min-h-0 relative">
          {renderChart()}
          <div className="absolute inset-0 cursor-pointer z-[1]" onPointerUp={(e) => { if (e.button === 0) { e.stopPropagation(); setEditorOpen(true); } }} />
        </div>
      </div>

      {/* Data editor modal — portaled to body */}
      {editorOpen && ReactDOM.createPortal(
        <ChartEditorModal chart={chart} onSave={save} onClose={() => setEditorOpen(false)} />,
        document.body,
      )}

      {/* Resize handles */}
      <div data-resize-handle className="absolute top-0 right-0 h-full w-2 cursor-ew-resize opacity-0 group-hover:opacity-100 hover:bg-blue-400/20 transition-opacity rounded-r" onPointerDown={(e) => beginResize(e, "right")} onPointerMove={onResizeMove} />
      <div data-resize-handle className="absolute bottom-0 left-0 w-full h-2 cursor-ns-resize opacity-0 group-hover:opacity-100 hover:bg-blue-400/20 transition-opacity rounded-b" onPointerDown={(e) => beginResize(e, "bottom")} onPointerMove={onResizeMove} />
      <div data-resize-handle className="absolute bottom-0 right-0 w-4 h-4 cursor-nwse-resize opacity-0 group-hover:opacity-100 transition-opacity z-10" onPointerDown={(e) => beginResize(e, "corner")} onPointerMove={onResizeMove}>
        <svg viewBox="0 0 16 16" className="w-full h-full text-black/25"><path d="M14 14L6 14M14 14L14 6M14 14L8 8" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" /></svg>
      </div>
    </div>
  );
});

/* ─── Chart Data Editor Modal ────────────────────────────────────────────── */

function ChartEditorModal({ chart, onSave, onClose }: {
  chart: ChartData;
  onSave: (patch: Partial<ChartData>) => void;
  onClose: () => void;
}) {
  const [editingSeriesIdx, setEditingSeriesIdx] = useState<number | null>(null);
  const seriesInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (editingSeriesIdx !== null) { setEditingSeriesIdx(null); return; }
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, editingSeriesIdx]);

  useEffect(() => {
    if (editingSeriesIdx !== null && seriesInputRef.current) seriesInputRef.current.focus();
  }, [editingSeriesIdx]);

  const updateCell = (rowIdx: number, key: string, val: string) => {
    const rows = chart.rows.map((r, i) => {
      if (i !== rowIdx) return r;
      const num = Number(val);
      return { ...r, [key]: key === "label" ? val : isNaN(num) ? val : num };
    });
    onSave({ rows });
  };

  const addRow = () => {
    const row: DataRow = { label: `Item ${chart.rows.length + 1}` };
    chart.series.forEach((s) => { row[s] = 0; });
    onSave({ rows: [...chart.rows, row] });
  };

  const removeRow = (idx: number) => {
    onSave({ rows: chart.rows.filter((_, i) => i !== idx) });
  };

  const renameSeries = (oldName: string, newName: string) => {
    if (!newName.trim() || newName === oldName) return;
    const series = chart.series.map((s) => s === oldName ? newName : s);
    const rows = chart.rows.map((r) => {
      const next = { ...r };
      if (oldName in next) {
        next[newName] = next[oldName];
        delete next[oldName];
      }
      return next;
    });
    onSave({ series, rows });
  };

  const addSeries = () => {
    let name = "Series " + String.fromCharCode(65 + chart.series.length);
    let i = 1;
    while (chart.series.includes(name)) { name = `Series ${String.fromCharCode(65 + chart.series.length + i)}`; i++; }
    const rows = chart.rows.map((r) => ({ ...r, [name]: 0 }));
    onSave({ series: [...chart.series, name], rows });
  };

  const removeSeries = (name: string) => {
    if (chart.series.length <= 1) return;
    const series = chart.series.filter((s) => s !== name);
    const rows = chart.rows.map((r) => {
      const next = { ...r };
      delete next[name];
      return next;
    });
    onSave({ series, rows });
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-[1000] flex items-center justify-center" onClick={onClose} onPointerDown={(e) => e.stopPropagation()}>
        <div className="bg-white rounded-xl shadow-2xl w-[560px] max-h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()} style={{ animation: "chartModalIn 0.15s ease-out" }}>
          {/* Header */}
          <div className="flex items-center gap-3 px-5 pt-5 pb-3">
            <BarChart3 className="w-4.5 h-4.5 text-black/35 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-base font-semibold text-black/85">{chart.title || "Chart"}</div>
              <div className="text-[11px] text-black/35">Edit data &middot; {chart.rows.length} rows &middot; {chart.series.length} series</div>
            </div>
            <button type="button" className="w-7 h-7 rounded-md flex items-center justify-center hover:bg-black/5 text-black/35 hover:text-black/60 transition-colors shrink-0" onClick={onClose}>
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Series chips */}
          <div className="px-5 pb-3">
            <div className="flex items-center gap-1.5 mb-1.5">
              <span className="text-[11px] font-semibold text-black/45 uppercase tracking-wide">Series</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {chart.series.map((s, i) => {
                const color = CHART_COLORS[i % CHART_COLORS.length];
                const isEditing = editingSeriesIdx === i;
                return (
                  <div key={s} className="group/ser flex items-center gap-0">
                    {isEditing ? (
                      <input
                        ref={seriesInputRef}
                        className="text-[11px] font-medium px-2.5 py-1 rounded-full outline-none w-[100px]"
                        style={{ background: `${color}18`, color, boxShadow: `inset 0 0 0 1.5px ${color}55` }}
                        defaultValue={s}
                        onBlur={(e) => { renameSeries(s, e.target.value); setEditingSeriesIdx(null); }}
                        onKeyDown={(e) => { if (e.key === "Enter") { renameSeries(s, (e.target as HTMLInputElement).value); setEditingSeriesIdx(null); } }}
                      />
                    ) : (
                      <>
                        <span className="text-[11px] font-medium px-2.5 py-1 rounded-full flex items-center gap-1.5" style={{ background: `${color}18`, color }}>
                          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
                          {s}
                        </span>
                        <button type="button" className="w-4 h-4 flex items-center justify-center rounded-full opacity-0 group-hover/ser:opacity-100 hover:bg-black/8 transition-all -ml-1" style={{ color }} onClick={() => setEditingSeriesIdx(i)}>
                          <Pencil className="w-2.5 h-2.5" />
                        </button>
                        {chart.series.length > 1 && (
                          <button type="button" className="w-4 h-4 flex items-center justify-center rounded-full opacity-0 group-hover/ser:opacity-100 hover:bg-red-100 text-red-400 transition-all" onClick={() => removeSeries(s)}>
                            <X className="w-2.5 h-2.5" />
                          </button>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
              <button type="button" className="text-[11px] text-blue-500 hover:text-blue-600 font-medium flex items-center gap-0.5 px-2 py-1 rounded-full hover:bg-blue-50/50 transition-colors" onClick={addSeries}>
                <Plus className="w-3 h-3" /> Add
              </button>
            </div>
          </div>

          {/* Data table */}
          <div className="flex-1 overflow-auto px-5 pb-5">
            <div className="rounded-lg border border-black/8 overflow-hidden">
              <table className="w-full border-collapse text-[12px]">
                <thead>
                  <tr style={{ background: "rgba(0,0,0,0.02)" }}>
                    <th className="text-left px-3 py-2 text-[11px] text-black/45 font-semibold uppercase tracking-wide border-b border-black/5">Label</th>
                    {chart.series.map((s, i) => (
                      <th key={s} className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide border-b border-black/5" style={{ color: CHART_COLORS[i % CHART_COLORS.length] }}>{s}</th>
                    ))}
                    <th className="w-8 border-b border-black/5" />
                  </tr>
                </thead>
                <tbody>
                  {chart.rows.map((row, ri) => (
                    <tr key={ri} className="group/row border-t border-black/4 hover:bg-black/[0.015] transition-colors">
                      <td className="px-3 py-1.5">
                        <input className="w-full bg-transparent outline-none text-black/75 placeholder:text-black/25" value={String(row.label)} placeholder="Label..." onChange={(e) => updateCell(ri, "label", e.target.value)} />
                      </td>
                      {chart.series.map((s) => (
                        <td key={s} className="px-3 py-1.5">
                          <input className="w-full bg-transparent outline-none text-black/70 placeholder:text-black/20" value={String(row[s] ?? "")} placeholder="0" onChange={(e) => updateCell(ri, s, e.target.value)} />
                        </td>
                      ))}
                      <td className="px-1">
                        <button type="button" className="w-6 h-6 flex items-center justify-center rounded opacity-0 group-hover/row:opacity-100 hover:bg-red-50 text-black/20 hover:text-red-500 transition-all" onClick={() => removeRow(ri)}>
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button type="button" className="flex items-center gap-1 text-[11px] text-blue-500 hover:text-blue-600 font-medium mt-2" onClick={addRow}>
              <Plus className="w-3 h-3" /> Add row
            </button>
          </div>
        </div>
      </div>
      <style>{`@keyframes chartModalIn { from { opacity: 0; transform: scale(0.95) translateY(8px); } to { opacity: 1; transform: scale(1) translateY(0); } }`}</style>
    </>
  );
}
