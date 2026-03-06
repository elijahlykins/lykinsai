import React, { memo, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";
import { snapToGrid } from "@/canvas/utils/snap";
import { useAuth } from "@/lib/SupabaseAuth";
import { supabase } from "@/lib/supabase";

/* ── Shared constants (mirror CalendarPage) ────────────────────────── */

const EVENTS_STORAGE_KEY = "lykinsai_calendar_events";
const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const SLOT_HEIGHT = 28;
const SLOT_COUNT = 48;
const TOTAL_GRID_HEIGHT = SLOT_COUNT * SLOT_HEIGHT;
const TIME_OPTIONS: number[] = Array.from({ length: 48 }, (_, i) => i * 0.5);

const EVENT_COLORS = [
  "rgba(59,130,246,0.55)", "rgba(22,163,74,0.55)", "rgba(217,119,6,0.55)",
  "rgba(220,38,38,0.55)", "rgba(124,58,237,0.55)", "rgba(219,39,119,0.55)",
  "rgba(15,118,110,0.55)",
];
const EVENT_BG_COLORS = [
  "rgba(59,130,246,0.14)", "rgba(22,163,74,0.14)", "rgba(217,119,6,0.14)",
  "rgba(220,38,38,0.14)", "rgba(124,58,237,0.14)", "rgba(219,39,119,0.14)",
  "rgba(15,118,110,0.14)",
];

/* ── Types ─────────────────────────────────────────────────────────── */

type CalendarEvent = {
  id: string;
  date_key: string;
  title?: string;
  description?: string;
  start_hour?: number;
  end_hour?: number;
  preset_id?: string;
  custom_color?: string;
  user_id?: string;
  [key: string]: any;
};

/* ── Helpers ───────────────────────────────────────────────────────── */

function dateKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function isSameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function getDaysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate();
}

function getMonthGrid(year: number, month: number) {
  const firstDay = new Date(year, month, 1).getDay();
  const dim = getDaysInMonth(year, month);
  const prevDays = getDaysInMonth(year, month - 1);
  const cells: { day: number; current: boolean }[] = [];
  for (let i = firstDay - 1; i >= 0; i--) cells.push({ day: prevDays - i, current: false });
  for (let d = 1; d <= dim; d++) cells.push({ day: d, current: true });
  const remaining = 42 - cells.length;
  for (let d = 1; d <= remaining; d++) cells.push({ day: d, current: false });
  return cells;
}

function formatTime(t: number) {
  const h = Math.floor(t);
  const m = String(Math.round((t - h) * 60)).padStart(2, "0");
  if (h === 0) return `12:${m} AM`;
  if (h < 12) return `${h}:${m} AM`;
  if (h === 12) return `12:${m} PM`;
  return `${h - 12}:${m} PM`;
}

function formatTimeShort(t: number) {
  const h = Math.floor(t);
  if (t % 1 !== 0) return "";
  if (h === 0) return "12a";
  if (h < 12) return `${h}a`;
  if (h === 12) return "12p";
  return `${h - 12}p`;
}

function loadLocalEvents(): CalendarEvent[] {
  try { const raw = localStorage.getItem(EVENTS_STORAGE_KEY); return raw ? JSON.parse(raw) : []; }
  catch { return []; }
}

function saveLocalEvents(events: CalendarEvent[]) {
  try { localStorage.setItem(EVENTS_STORAGE_KEY, JSON.stringify(events)); } catch {}
}

function eventColor(evt: CalendarEvent, idx: number) {
  const ci = (evt.id?.charCodeAt?.(0) ?? idx) % EVENT_COLORS.length;
  return { border: evt.custom_color || EVENT_COLORS[ci], bg: EVENT_BG_COLORS[ci] };
}

function makeEventId() {
  return `ev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/* ── Component ─────────────────────────────────────────────────────── */

export const CalendarBlock = memo(function CalendarBlock({ id }: { id: string }) {
  const block = useCanvasStore((s) => s.blocks[id]);
  const bringToFront = useCanvasStore((s) => s.bringToFront);
  const selectBlocks = useCanvasStore((s) => s.selectBlocks);
  const toggleSelect = useCanvasStore((s) => s.toggleSelect);
  const isSelected = useCanvasStore((s) => s.selectedIds.includes(id));
  const updateBlock = useCanvasStore((s) => s.updateBlock);
  const pushHistory = useCanvasStore((s) => s.pushHistory);
  const gridSize = useCanvasStore((s) => s.gridSize);
  const moveBlocksFromSnapshot = useCanvasStore((s) => s.moveBlocksFromSnapshot);

  const { user } = useAuth();
  const dragRef = useRef<any>(null);
  const resizeRef = useRef<any>(null);
  const endResizeCleanupRef = useRef<(() => void) | null>(null);
  const dayGridRef = useRef<HTMLDivElement | null>(null);

  const now = new Date();
  const [viewMode, setViewMode] = useState<"month" | "day">("month");
  const [viewYear, setViewYear] = useState(now.getFullYear());
  const [viewMonth, setViewMonth] = useState(now.getMonth());
  const [selectedDate, setSelectedDate] = useState<Date>(now);
  const [events, setEvents] = useState<CalendarEvent[]>(() => loadLocalEvents());

  // Quick-add event form state
  const [addingEvent, setAddingEvent] = useState<{ startHour: number } | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [newEndHour, setNewEndHour] = useState(0);
  const addInputRef = useRef<HTMLInputElement | null>(null);

  // Fetch from Supabase
  useEffect(() => {
    if (!user?.id) return;
    let active = true;
    (async () => {
      try {
        const { data } = await supabase
          .from("calendar_events").select("*").eq("user_id", user.id)
          .order("created_at", { ascending: false });
        if (active && data) setEvents(data);
      } catch {}
    })();
    return () => { active = false; };
  }, [user?.id]);

  // Stay in sync
  useEffect(() => {
    const handler = () => setEvents(loadLocalEvents());
    window.addEventListener("calendar_events_changed", handler);
    const onStorage = (e: StorageEvent) => { if (e.key === EVENTS_STORAGE_KEY) setEvents(loadLocalEvents()); };
    window.addEventListener("storage", onStorage);
    return () => { window.removeEventListener("calendar_events_changed", handler); window.removeEventListener("storage", onStorage); };
  }, []);

  // Scroll to ~8 AM when day view opens
  useEffect(() => {
    if (viewMode === "day" && dayGridRef.current) {
      dayGridRef.current.scrollTop = 8 * 2 * SLOT_HEIGHT - 40;
    }
  }, [viewMode, selectedDate]);

  const style = useMemo(() => {
    if (!block || block.type !== "text" || (block as any).format !== "calendar") return null;
    return { position: "absolute" as const, left: `${block.x}px`, top: `${block.y}px`, width: `${block.width}px`, height: `${block.height}px`, overflow: "visible" };
  }, [block]);

  if (!block || block.type !== "text" || (block as any).format !== "calendar" || !style) return null;

  const todayStr = dateKey(now);
  const grid = getMonthGrid(viewYear, viewMonth);

  const eventsByKey = useMemo(() => {
    const map: Record<string, CalendarEvent[]> = {};
    for (const evt of events) { if (!evt.date_key) continue; if (!map[evt.date_key]) map[evt.date_key] = []; map[evt.date_key].push(evt); }
    return map;
  }, [events]);

  const dayEvents = useMemo(
    () => events.filter((e) => e.date_key === dateKey(selectedDate)).sort((a, b) => (a.start_hour ?? 0) - (b.start_hour ?? 0)),
    [events, selectedDate]
  );

  /* ── Month navigation ────────────────────────────────────────────── */
  const prevMonth = () => { if (viewMonth === 0) { setViewMonth(11); setViewYear((y) => y - 1); } else setViewMonth((m) => m - 1); };
  const nextMonth = () => { if (viewMonth === 11) { setViewMonth(0); setViewYear((y) => y + 1); } else setViewMonth((m) => m + 1); };

  const selectDay = (day: number) => {
    const d = new Date(viewYear, viewMonth, day);
    setSelectedDate(d);
    setViewMode("day");
    setAddingEvent(null);
  };

  const goBackToMonth = () => {
    setViewMode("month");
    setAddingEvent(null);
    setNewTitle("");
  };

  /* ── Day navigation ──────────────────────────────────────────────── */
  const prevDay = () => { const d = new Date(selectedDate); d.setDate(d.getDate() - 1); setSelectedDate(d); setViewYear(d.getFullYear()); setViewMonth(d.getMonth()); setAddingEvent(null); };
  const nextDay = () => { const d = new Date(selectedDate); d.setDate(d.getDate() + 1); setSelectedDate(d); setViewYear(d.getFullYear()); setViewMonth(d.getMonth()); setAddingEvent(null); };

  /* ── Event CRUD ──────────────────────────────────────────────────── */
  const handleSlotClick = (t: number) => {
    setAddingEvent({ startHour: t });
    setNewTitle("");
    setNewEndHour(Math.min(t + 1, 24));
    setTimeout(() => addInputRef.current?.focus(), 60);
  };

  const saveNewEvent = async () => {
    if (!addingEvent) return;
    const title = newTitle.trim() || "New Event";
    const evt: CalendarEvent = {
      id: makeEventId(),
      date_key: dateKey(selectedDate),
      title,
      start_hour: addingEvent.startHour,
      end_hour: newEndHour,
      preset_id: "custom",
    };
    const next = [evt, ...events];
    setEvents(next);
    saveLocalEvents(next);
    setAddingEvent(null);
    setNewTitle("");
    window.dispatchEvent(new CustomEvent("calendar_events_changed"));

    if (user?.id) {
      try {
        await supabase.from("calendar_events").insert({
          id: evt.id, user_id: user.id, title: evt.title,
          date_key: evt.date_key, start_hour: evt.start_hour, end_hour: evt.end_hour,
          preset_id: evt.preset_id,
        });
      } catch {}
    }
  };

  const deleteEvent = async (eventId: string) => {
    const next = events.filter((e) => e.id !== eventId);
    setEvents(next);
    saveLocalEvents(next);
    window.dispatchEvent(new CustomEvent("calendar_events_changed"));
    if (user?.id) { try { await supabase.from("calendar_events").delete().eq("id", eventId).eq("user_id", user.id); } catch {} }
  };

  /* ── Drag / Resize (canvas block) ───────────────────────────────── */
  const snapSize = (n: number) => { const g = Math.max(1, Math.floor(gridSize || 24)); return Math.max(g, snapToGrid(n, g)); };

  const endResize = (pointerId: number) => {
    const r = resizeRef.current;
    if (!r || r.pointerId !== pointerId) return;
    if (r.raf != null) window.cancelAnimationFrame(r.raf);
    if (endResizeCleanupRef.current) { try { endResizeCleanupRef.current(); } catch {} endResizeCleanupRef.current = null; }
    if (r.capturer) { try { r.capturer.releasePointerCapture(pointerId); } catch {} }
    resizeRef.current = null;
  };
  const installGlobalResizeEndHandlers = (pointerId: number) => {
    const onUp = (ev: PointerEvent) => { if (ev.pointerId === pointerId) endResize(pointerId); };
    const onCancel = (ev: PointerEvent) => { if (ev.pointerId === pointerId) endResize(pointerId); };
    const onBlur = () => endResize(pointerId);
    window.addEventListener("pointerup", onUp, true); window.addEventListener("pointercancel", onCancel, true); window.addEventListener("blur", onBlur, true);
    endResizeCleanupRef.current = () => { window.removeEventListener("pointerup", onUp, true); window.removeEventListener("pointercancel", onCancel, true); window.removeEventListener("blur", onBlur, true); };
  };
  const beginResize = (e: React.PointerEvent, mode: "right" | "bottom" | "corner") => {
    e.stopPropagation(); e.preventDefault(); bringToFront(id);
    if (!isSelected) selectBlocks([id]); pushHistory();
    const capturer = e.currentTarget as HTMLElement;
    resizeRef.current = { pointerId: e.pointerId, mode, startClientX: e.clientX, startClientY: e.clientY, startW: block.width, startH: block.height, raf: null, capturer };
    installGlobalResizeEndHandlers(e.pointerId);
    try { capturer.setPointerCapture(e.pointerId); } catch {}
  };
  const startDrag = (e: React.PointerEvent) => {
    e.stopPropagation(); e.preventDefault(); bringToFront(id);
    if (e.shiftKey) toggleSelect(id); else if (!isSelected) selectBlocks([id]); pushHistory();
    const state = useCanvasStore.getState(); const sel = state.selectedIds;
    const idsForDrag = sel.includes(id) && sel.length > 1 ? sel : [id];
    const snapshot = idsForDrag.map((bid) => { const b = state.blocks[bid]; return { id: bid, x: Number((b as any)?.x) || 0, y: Number((b as any)?.y) || 0 }; });
    dragRef.current = { pointerId: e.pointerId, startClientX: e.clientX, startClientY: e.clientY, originX: block.x, originY: block.y, raf: null, lastX: block.x, lastY: block.y, snapshot, capturer: e.currentTarget as HTMLElement };
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch {}
  };
  const onDragMove = (e: React.PointerEvent) => {
    const d = dragRef.current; if (!d || d.pointerId !== e.pointerId) return;
    if (e.pointerType === "mouse" && e.buttons === 0) { dragRef.current = null; return; }
    d.lastX = d.originX + (e.clientX - d.startClientX); d.lastY = d.originY + (e.clientY - d.startClientY);
    if (d.raf != null) return;
    d.raf = window.requestAnimationFrame(() => { const d2 = dragRef.current; if (!d2) return; d2.raf = null; moveBlocksFromSnapshot(d2.snapshot, d2.lastX - d2.originX, d2.lastY - d2.originY, { snap: true }); });
  };
  const onDragEnd = (e: React.PointerEvent) => {
    const d = dragRef.current; if (!d || d.pointerId !== e.pointerId) return;
    dragRef.current = null; try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
  };

  /* ── Render ──────────────────────────────────────────────────────── */

  const renderMonthView = () => (
    <div className="px-2 pb-1 flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between mb-1.5">
        <button type="button" className="p-0.5 rounded hover:bg-black/10 transition-colors" onClick={prevMonth}>
          <ChevronLeft className="w-3.5 h-3.5 text-black/70 dark:text-white/70" />
        </button>
        <span className="text-[0.6875rem] font-semibold text-black/80 dark:text-white/80 select-none">
          {MONTHS[viewMonth]} {viewYear}
        </span>
        <button type="button" className="p-0.5 rounded hover:bg-black/10 transition-colors" onClick={nextMonth}>
          <ChevronRight className="w-3.5 h-3.5 text-black/70 dark:text-white/70" />
        </button>
      </div>
      {/* Weekday headers */}
      <div className="grid grid-cols-7 gap-px mb-0.5">
        {WEEKDAYS_SHORT.map((d) => (
          <div key={d} className="text-[8px] font-semibold text-black/40 dark:text-white/40 text-center select-none uppercase tracking-wider">{d}</div>
        ))}
      </div>
      {/* Grid */}
      <div className="grid grid-cols-7 gap-px flex-1 overflow-y-auto scrollbar-hide">
        {grid.map((cell, i) => {
          const cellDate = cell.current ? new Date(viewYear, viewMonth, cell.day) : null;
          const dk = cellDate ? dateKey(cellDate) : null;
          const isToday = dk === todayStr;
          const cellEvents = dk ? (eventsByKey[dk] || []) : [];
          return (
            <div
              key={i}
              className={`relative flex flex-col p-0.5 rounded transition-all min-h-[22px] ${
                !cell.current ? "text-black/15 dark:text-white/15"
                  : isToday ? "bg-blue-500/12 cursor-pointer hover:bg-blue-500/18"
                  : "cursor-pointer hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
              }`}
              onClick={() => { if (cell.current) selectDay(cell.day); }}
            >
              <span className={`text-[9px] font-medium text-center leading-tight ${
                isToday ? "text-blue-600 dark:text-blue-400 font-bold" : cell.current ? "text-black/70 dark:text-white/70" : ""
              }`}>{cell.day}</span>
              {isToday && <div className="w-1 h-1 rounded-full bg-blue-500 mx-auto -mt-0.5" />}
              {cell.current && cellEvents.length > 0 && (
                <div className="mt-0.5 flex flex-col gap-px overflow-hidden">
                  {cellEvents.slice(0, 2).map((evt, ei) => (
                    <div key={evt.id || ei} className="flex items-center gap-0.5 rounded px-0.5">
                      <div className="w-1 h-1 rounded-full shrink-0" style={{ background: eventColor(evt, ei).border }} />
                      <span className="text-[7px] text-black/60 dark:text-white/60 truncate leading-tight">{evt.title || "Event"}</span>
                    </div>
                  ))}
                  {cellEvents.length > 2 && <span className="text-[7px] text-black/35 dark:text-white/35 px-0.5">+{cellEvents.length - 2}</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );

  const renderDayView = () => {
    const isToday = isSameDay(selectedDate, now);
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const nowPx = (nowMinutes / 30) * SLOT_HEIGHT;

    return (
      <div className="flex flex-col h-full">
        {/* Day header */}
        <div className="flex items-center justify-between px-2 py-1 border-b border-black/8 dark:border-white/8">
          <button type="button" className="p-0.5 rounded hover:bg-black/10 transition-colors" onClick={prevDay}>
            <ChevronLeft className="w-3 h-3 text-black/60 dark:text-white/60" />
          </button>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              className="text-[0.625rem] text-black/50 dark:text-white/50 hover:text-blue-500 transition-colors"
              onClick={goBackToMonth}
            >
              {MONTHS[selectedDate.getMonth()].slice(0, 3)}
            </button>
            <span className={`text-[0.75rem] font-semibold select-none ${isToday ? "text-blue-600 dark:text-blue-400" : "text-black/80 dark:text-white/80"}`}>
              {selectedDate.getDate()}
            </span>
            <span className="text-[0.625rem] text-black/50 dark:text-white/50 select-none">
              {WEEKDAYS_SHORT[selectedDate.getDay()]}
            </span>
          </div>
          <button type="button" className="p-0.5 rounded hover:bg-black/10 transition-colors" onClick={nextDay}>
            <ChevronRight className="w-3 h-3 text-black/60 dark:text-white/60" />
          </button>
        </div>

        {/* Time grid */}
        <div ref={dayGridRef} className="flex-1 overflow-y-auto scrollbar-hide relative">
          <div className="relative" style={{ height: `${TOTAL_GRID_HEIGHT}px` }}>
            {/* Now indicator */}
            {isToday && (
              <div className="absolute left-0 right-0 z-10 pointer-events-none" style={{ top: `${nowPx}px` }}>
                <div className="flex items-center">
                  <div className="w-1.5 h-1.5 rounded-full bg-red-500 -ml-0.5" />
                  <div className="flex-1 h-px bg-red-500/60" />
                </div>
              </div>
            )}

            {/* Events */}
            {dayEvents.map((evt, i) => {
              const start = evt.start_hour ?? 0;
              const end = evt.end_hour ?? start + 1;
              const topPx = start * 2 * SLOT_HEIGHT + 1;
              const heightPx = Math.max((end - start) * 2 * SLOT_HEIGHT - 2, SLOT_HEIGHT - 2);
              const ec = eventColor(evt, i);
              return (
                <div
                  key={evt.id || i}
                  className="absolute rounded px-1.5 py-0.5 overflow-hidden z-[5] group/evt"
                  style={{ top: `${topPx}px`, height: `${heightPx}px`, left: "36px", right: "4px", background: ec.bg, borderLeft: `2px solid ${ec.border}` }}
                >
                  <div className="text-[0.625rem] font-semibold text-black/80 dark:text-white/80 truncate">{evt.title || "Event"}</div>
                  <div className="text-[8px] text-black/45 dark:text-white/45">{formatTime(start)} – {formatTime(end)}</div>
                  {/* Delete button on hover */}
                  <button
                    type="button"
                    className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-red-400/80 text-white text-[8px] items-center justify-center hidden group-hover/evt:flex"
                    onClick={(e) => { e.stopPropagation(); deleteEvent(evt.id); }}
                  >×</button>
                </div>
              );
            })}

            {/* Quick-add event overlay */}
            {addingEvent && (() => {
              const topPx = addingEvent.startHour * 2 * SLOT_HEIGHT + 1;
              const heightPx = Math.max((newEndHour - addingEvent.startHour) * 2 * SLOT_HEIGHT - 2, SLOT_HEIGHT - 2);
              return (
                <div
                  className="absolute rounded px-1.5 py-0.5 z-20 border border-blue-400/50"
                  style={{ top: `${topPx}px`, height: `${heightPx}px`, left: "36px", right: "4px", background: "rgba(59,130,246,0.12)" }}
                >
                  <input
                    ref={addInputRef}
                    autoFocus
                    className="w-full bg-transparent text-[0.625rem] font-medium text-black/80 dark:text-white/80 outline-none placeholder:text-black/30"
                    placeholder="Event title..."
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") saveNewEvent();
                      if (e.key === "Escape") { setAddingEvent(null); setNewTitle(""); }
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                  />
                  <div className="flex items-center gap-1 mt-0.5">
                    <span className="text-[8px] text-black/40">{formatTime(addingEvent.startHour)} – {formatTime(newEndHour)}</span>
                    <button type="button" className="text-[8px] text-blue-600 font-semibold hover:underline" onClick={saveNewEvent}>Save</button>
                    <button type="button" className="text-[8px] text-black/40 hover:underline" onClick={() => { setAddingEvent(null); setNewTitle(""); }}>Cancel</button>
                  </div>
                </div>
              );
            })()}

            {/* Time slots */}
            {TIME_OPTIONS.map((t) => {
              const isHour = t % 1 === 0;
              const label = formatTimeShort(t);
              return (
                <div
                  key={t}
                  className={`absolute left-0 right-0 flex ${isHour ? "border-b border-black/[0.06] dark:border-white/[0.06]" : "border-b border-black/[0.02] dark:border-white/[0.02]"}`}
                  style={{ top: `${t * 2 * SLOT_HEIGHT}px`, height: `${SLOT_HEIGHT}px` }}
                >
                  <div className="w-9 shrink-0 pr-1 pt-0.5 text-right">
                    {label && <span className="text-[8px] text-black/30 dark:text-white/30 font-medium">{label}</span>}
                  </div>
                  <div
                    className="flex-1 border-l border-black/[0.04] dark:border-white/[0.04] hover:bg-blue-500/[0.04] transition-colors cursor-pointer group/slot relative"
                    onClick={() => handleSlotClick(t)}
                  >
                    <span className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover/slot:opacity-100 transition-opacity">
                      <Plus className="w-2.5 h-2.5 text-black/20 dark:text-white/20" />
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div
      data-canvas-block data-block-id={id}
      className="absolute group" style={style}
      onPointerDownCapture={(e) => {
        if (e.button !== 0) return;
        const t = e.target as Element | null;
        if (t?.closest?.("[data-resize-handle]") || t?.closest?.("[data-drag-handle]")) return;
        if (e.shiftKey) toggleSelect(id); else if (!isSelected) selectBlocks([id]);
      }}
      onPointerMove={(e) => {
        const r = resizeRef.current; if (!r || r.pointerId !== e.pointerId) return;
        if (e.pointerType === "mouse" && e.buttons === 0) { endResize(e.pointerId); return; }
        const dx = e.clientX - r.startClientX; const dy = e.clientY - r.startClientY;
        if (r.raf != null) return;
        r.raf = window.requestAnimationFrame(() => {
          const rr = resizeRef.current; if (!rr) return; rr.raf = null;
          const g = Math.max(1, Math.floor(gridSize || 24)); const minW = g * 8; const minH = g * 8;
          if (rr.mode === "right") { updateBlock(id, { width: Math.max(minW, snapSize(rr.startW + dx)) } as any); return; }
          if (rr.mode === "bottom") { updateBlock(id, { height: Math.max(minH, snapSize(rr.startH + dy)) } as any); return; }
          updateBlock(id, { width: Math.max(minW, snapSize(rr.startW + dx)), height: Math.max(minH, snapSize(rr.startH + dy)) } as any);
        });
      }}
      onPointerUp={(e) => endResize(e.pointerId)}
      onPointerCancel={(e) => endResize(e.pointerId)}
      onLostPointerCapture={(e) => endResize(e.pointerId)}
    >
      <div className={`glass-block overflow-hidden relative ${isSelected ? "omnia-selected-glass" : ""}`} style={{ width: "100%", height: "100%" }}>
        {/* Drag */}
        <div data-drag-handle
          className="relative z-20 w-full cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity" style={{ height: "8px" }}
          onPointerDown={startDrag} onPointerMove={onDragMove} onPointerUp={onDragEnd} onPointerCancel={onDragEnd} onLostPointerCapture={onDragEnd}
          title="Drag to move"
        />

        {/* Content */}
        <div className="h-[calc(100%-8px)]" onPointerDown={(e) => e.stopPropagation()}>
          {viewMode === "month" ? renderMonthView() : renderDayView()}
        </div>
      </div>

      {/* Resize handles */}
      <div className="absolute inset-0 pointer-events-none z-10">
        <div data-resize-handle className="absolute top-0 bottom-0 right-0 w-2 pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity" style={{ cursor: "ew-resize" }} onPointerDown={(e) => beginResize(e, "right")} />
        <div data-resize-handle className="absolute left-0 right-0 bottom-0 h-2 pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity" style={{ cursor: "ns-resize" }} onPointerDown={(e) => beginResize(e, "bottom")} />
        <div data-resize-handle className="absolute right-0 bottom-0 w-4 h-4 pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity" style={{ cursor: "nwse-resize" }} onPointerDown={(e) => beginResize(e, "corner")}>
          <div className="w-full h-full rounded-sm" style={{ background: "rgba(255,255,255,0.14)", border: "1px solid rgba(255,255,255,0.22)", boxShadow: "inset 0 0 18px rgba(110, 200, 255, 0.14)" }} />
        </div>
      </div>
    </div>
  );
});
