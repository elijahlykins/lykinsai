import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Brain, Briefcase, Calendar as CalendarIcon, Car, Check, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Circle, Clock, Coffee, Edit2, FileText, Globe, GraduationCap, Lightbulb, Loader2, Map as MapIcon, MessageSquare, Pen, Plus, RefreshCw, StickyNote, Sun, Trash2, UserPlus, Users, Utensils, X } from "lucide-react";
import { useAuth } from "@/lib/SupabaseAuth";
import { supabase } from "@/lib/supabase";
import DraggableQuickNote from "@/components/notes/DraggableQuickNote";

const SLOT_COUNT = 48;
const SLOT_HEIGHT = 40;
const TOTAL_GRID_HEIGHT = SLOT_COUNT * SLOT_HEIGHT;
const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const EVENT_COLORS = [
  "rgba(59,130,246,0.18)",
  "rgba(16,185,129,0.18)",
  "rgba(245,158,11,0.18)",
  "rgba(239,68,68,0.18)",
  "rgba(139,92,246,0.18)",
  "rgba(236,72,153,0.18)",
];
const EVENT_BORDER_COLORS = [
  "rgba(59,130,246,0.55)",
  "rgba(16,185,129,0.55)",
  "rgba(245,158,11,0.55)",
  "rgba(239,68,68,0.55)",
  "rgba(139,92,246,0.55)",
  "rgba(236,72,153,0.55)",
];

const EVENT_PRESETS = [
  { id: "custom",        label: "Custom",         icon: Pen,            color: "rgba(107,114,128,0.70)", bg: "rgba(107,114,128,0.12)", border: "rgba(107,114,128,0.50)" },
  { id: "1on1",          label: "1:1 Meeting",    icon: MessageSquare,  color: "rgba(59,130,246,0.85)",  bg: "rgba(59,130,246,0.14)",  border: "rgba(59,130,246,0.55)" },
  { id: "team_meeting",  label: "Team Meeting",   icon: Users,          color: "rgba(99,102,241,0.85)",  bg: "rgba(99,102,241,0.14)",  border: "rgba(99,102,241,0.55)" },
  { id: "interview",     label: "Interview",      icon: Briefcase,      color: "rgba(16,185,129,0.85)",  bg: "rgba(16,185,129,0.14)",  border: "rgba(16,185,129,0.55)" },
  { id: "training",      label: "Training",       icon: GraduationCap,  color: "rgba(245,158,11,0.85)",  bg: "rgba(245,158,11,0.14)",  border: "rgba(245,158,11,0.55)" },
  { id: "deep_work",     label: "Deep Work",      icon: Brain,          color: "rgba(139,92,246,0.85)",  bg: "rgba(139,92,246,0.14)",  border: "rgba(139,92,246,0.55)" },
  { id: "planning",      label: "Planning",       icon: MapIcon,        color: "rgba(14,165,233,0.85)",  bg: "rgba(14,165,233,0.14)",  border: "rgba(14,165,233,0.55)" },
  { id: "contact",       label: "Contact",        icon: MessageSquare,  color: "rgba(236,72,153,0.85)",  bg: "rgba(236,72,153,0.14)",  border: "rgba(236,72,153,0.55)" },
  { id: "brainstorm",    label: "Brainstorming",  icon: Lightbulb,      color: "rgba(234,179,8,0.85)",   bg: "rgba(234,179,8,0.14)",   border: "rgba(234,179,8,0.55)" },
  { id: "commute",       label: "Commute",        icon: Car,            color: "rgba(100,116,139,0.85)", bg: "rgba(100,116,139,0.14)", border: "rgba(100,116,139,0.55)" },
  { id: "appointment",   label: "Appointment",    icon: Clock,          color: "rgba(239,68,68,0.85)",   bg: "rgba(239,68,68,0.14)",   border: "rgba(239,68,68,0.55)" },
  { id: "break",         label: "Break",          icon: Coffee,         color: "rgba(34,197,94,0.85)",   bg: "rgba(34,197,94,0.14)",   border: "rgba(34,197,94,0.55)" },
  { id: "meal",          label: "Meal",           icon: Utensils,       color: "rgba(249,115,22,0.85)",  bg: "rgba(249,115,22,0.14)",  border: "rgba(249,115,22,0.55)" },
  { id: "wakeup",        label: "Wake Up",        icon: Sun,            color: "rgba(251,191,36,0.85)",  bg: "rgba(251,191,36,0.14)",  border: "rgba(251,191,36,0.55)" },
];

function getPreset(id) {
  let preset = EVENT_PRESETS.find((p) => p.id === id);
  if (!preset) {
    const custom = loadCustomPresets().find((p) => p.id === id);
    preset = custom || EVENT_PRESETS[0];
  }
  const overrides = loadPresetColorOverrides();
  if (overrides[id]) {
    const cs = hexToColorSet(overrides[id]);
    return { ...preset, color: cs.color, bg: cs.bg, border: cs.border };
  }
  return preset;
}

function displayTitle(event) {
  if (!event.preset_id || event.preset_id === "custom") return event.title;
  const preset = getPreset(event.preset_id);
  const presetLabel = preset.label;
  if (!event.title || event.title === presetLabel) return presetLabel;
  return `${presetLabel}: ${event.title}`;
}

const REPORT_STATUSES = [
  { id: "complete", label: "Complete", icon: CheckCircle2, color: "rgba(16,185,129,0.85)", bg: "rgba(16,185,129,0.12)", border: "rgba(16,185,129,0.4)" },
  { id: "in_process", label: "In Process", icon: Loader2, color: "rgba(245,158,11,0.85)", bg: "rgba(245,158,11,0.12)", border: "rgba(245,158,11,0.4)" },
  { id: "not_started", label: "Not Started", icon: Circle, color: "rgba(239,68,68,0.85)", bg: "rgba(239,68,68,0.12)", border: "rgba(239,68,68,0.4)" },
];

function isEventPast(event) {
  const today = new Date();
  const todayKey = dateKey(today);
  if (event.date_key < todayKey) return true;
  if (event.date_key === todayKey) {
    const nowHour = today.getHours() + today.getMinutes() / 60;
    return (event.end_hour ?? (event.start_hour ?? 0) + 1) <= nowHour;
  }
  return false;
}

const COMMON_TIMEZONES = [
  { value: "America/New_York", label: "Eastern (ET)" },
  { value: "America/Chicago", label: "Central (CT)" },
  { value: "America/Denver", label: "Mountain (MT)" },
  { value: "America/Los_Angeles", label: "Pacific (PT)" },
  { value: "America/Anchorage", label: "Alaska (AKT)" },
  { value: "Pacific/Honolulu", label: "Hawaii (HT)" },
  { value: "UTC", label: "UTC" },
  { value: "Europe/London", label: "London (GMT/BST)" },
  { value: "Europe/Paris", label: "Paris (CET)" },
  { value: "Europe/Berlin", label: "Berlin (CET)" },
  { value: "Asia/Tokyo", label: "Tokyo (JST)" },
  { value: "Asia/Shanghai", label: "Shanghai (CST)" },
  { value: "Asia/Kolkata", label: "India (IST)" },
  { value: "Asia/Dubai", label: "Dubai (GST)" },
  { value: "Australia/Sydney", label: "Sydney (AEST)" },
];

// All 30-min time options for the grid: 0, 0.5, 1, 1.5 ... 23.5
const TIME_OPTIONS = Array.from({ length: 48 }, (_, i) => i * 0.5);
// 15-min time options for the event editor dropdowns: 0, 0.25, 0.5, 0.75 ... 23.75
const TIME_OPTIONS_15 = Array.from({ length: 96 }, (_, i) => i * 0.25);

const VIEW_MODES = [
  { value: "day", label: "Day" },
  { value: "3day", label: "3 Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
];

const BUSYNESS_LEVELS = [
  { max: 0, label: "Free", color: "rgba(34,197,94,0.85)", bg: "rgba(34,197,94,0.12)" },
  { max: 2, label: "Light", color: "rgba(132,204,22,0.85)", bg: "rgba(132,204,22,0.12)" },
  { max: 4, label: "Busy", color: "rgba(245,158,11,0.85)", bg: "rgba(245,158,11,0.12)" },
  { max: 7.99, label: "Very Busy", color: "rgba(239,115,54,0.85)", bg: "rgba(239,115,54,0.12)" },
  { max: Infinity, label: "Fully Booked", color: "rgba(239,68,68,0.85)", bg: "rgba(239,68,68,0.12)" },
];

const DAY_STATUSES = [
  { id: "normal",      label: "Normal",        hue: null },
  { id: "ooo",         label: "Out of Office", hue: "rgba(100,116,139,0.08)" },
  { id: "sick",        label: "Sick",          hue: "rgba(239,68,68,0.07)" },
  { id: "vacation",    label: "Vacation",      hue: "rgba(14,165,233,0.08)" },
  { id: "personal",    label: "Personal",      hue: "rgba(168,85,247,0.07)" },
  { id: "holiday",     label: "Holiday",       hue: "rgba(234,179,8,0.08)" },
  { id: "leave",       label: "Leave",         hue: "rgba(107,114,128,0.08)" },
  { id: "deadline",    label: "Deadline",       hue: "rgba(239,68,68,0.08)" },
  { id: "travel",      label: "Travel",        hue: "rgba(59,130,246,0.07)" },
  { id: "training",    label: "Training",      hue: "rgba(16,185,129,0.07)" },
  { id: "conference",  label: "Conference",    hue: "rgba(139,92,246,0.08)" },
  { id: "launch",      label: "Launch",        hue: "rgba(249,115,22,0.08)" },
  { id: "review",      label: "Review",        hue: "rgba(245,158,11,0.07)" },
  { id: "planning",    label: "Planning",      hue: "rgba(34,197,94,0.07)" },
  { id: "maintenance", label: "Maintenance",   hue: "rgba(75,85,99,0.08)" },
];

const DAY_STATUS_KEY = "lykinsai_day_statuses";
const CUSTOM_DAY_TYPES_KEY = "lykinsai_custom_day_types";
const DAY_TYPE_COLOR_OVERRIDES_KEY = "lykinsai_day_type_color_overrides";

const DAY_TYPE_HUE_PALETTE = [
  "rgba(59,130,246,0.07)",
  "rgba(16,185,129,0.07)",
  "rgba(245,158,11,0.07)",
  "rgba(239,68,68,0.07)",
  "rgba(139,92,246,0.07)",
  "rgba(236,72,153,0.07)",
  "rgba(14,165,233,0.08)",
  "rgba(234,179,8,0.08)",
  "rgba(249,115,22,0.08)",
  "rgba(34,197,94,0.07)",
  "rgba(75,85,99,0.08)",
  "rgba(168,85,247,0.07)",
];

function hexToHue(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},0.08)`;
}

function loadDayTypeColorOverrides() {
  try {
    const raw = localStorage.getItem(DAY_TYPE_COLOR_OVERRIDES_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveDayTypeColorOverrides(overrides) {
  try { localStorage.setItem(DAY_TYPE_COLOR_OVERRIDES_KEY, JSON.stringify(overrides)); } catch {}
}

function loadCustomDayTypes() {
  try {
    const raw = localStorage.getItem(CUSTOM_DAY_TYPES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveCustomDayTypes(types) {
  try { localStorage.setItem(CUSTOM_DAY_TYPES_KEY, JSON.stringify(types)); } catch {}
}

function loadDayStatuses() {
  try {
    const raw = localStorage.getItem(DAY_STATUS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveDayStatuses(statuses) {
  try { localStorage.setItem(DAY_STATUS_KEY, JSON.stringify(statuses)); } catch {}
}

function getDayStatus(dayStatuses, dk, customDayTypes, dayTypeColorOverrides) {
  const id = dayStatuses[dk];
  if (!id || id === "normal") return DAY_STATUSES[0];
  let status = DAY_STATUSES.find((s) => s.id === id);
  if (!status && customDayTypes) {
    status = customDayTypes.find((s) => s.id === id);
  }
  if (!status) return DAY_STATUSES[0];
  if (dayTypeColorOverrides && dayTypeColorOverrides[id]) {
    return { ...status, hue: hexToHue(dayTypeColorOverrides[id]) };
  }
  return status;
}

function getBusyness(dayEvents) {
  const totalHours = dayEvents.reduce((sum, evt) => {
    const start = evt.start_hour ?? 0;
    const end = evt.end_hour ?? start + 1;
    return sum + (end - start);
  }, 0);
  for (const level of BUSYNESS_LEVELS) {
    if (totalHours <= level.max) return level;
  }
  return BUSYNESS_LEVELS[BUSYNESS_LEVELS.length - 1];
}

function getLocalTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function isSameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function formatTime(t) {
  const h = Math.floor(t);
  const m = String(Math.round((t - h) * 60)).padStart(2, "0");
  if (h === 0) return `12:${m} AM`;
  if (h < 12) return `${h}:${m} AM`;
  if (h === 12) return `12:${m} PM`;
  return `${h - 12}:${m} PM`;
}

function formatTimeShort(t) {
  const h = Math.floor(t);
  const isHalf = t % 1 !== 0;
  if (isHalf) return "";
  if (h === 0) return "12 AM";
  if (h < 12) return `${h} AM`;
  if (h === 12) return "12 PM";
  return `${h - 12} PM`;
}

function getDaysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

function getMonthGrid(year, month) {
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = getDaysInMonth(year, month);
  const prevDays = getDaysInMonth(year, month - 1);

  const cells = [];
  for (let i = firstDay - 1; i >= 0; i--) {
    cells.push({ day: prevDays - i, current: false });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ day: d, current: true });
  }
  const remaining = 42 - cells.length;
  for (let d = 1; d <= remaining; d++) {
    cells.push({ day: d, current: false });
  }
  return cells;
}

function buildMonthStrip(selectedDate) {
  const selMonth = selectedDate.getMonth();
  const selYear = selectedDate.getFullYear();
  const months = [];
  for (let m = 0; m < 12; m++) {
    const daysInMonth = new Date(selYear, m + 1, 0).getDate();
    const days = [];
    for (let day = 1; day <= daysInMonth; day++) {
      days.push(new Date(selYear, m, day));
    }
    months.push({ month: m, year: selYear, days, expanded: m === selMonth });
  }
  return months;
}

function getTzMinutes(timezone) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(now);
  let h = 0, m = 0;
  for (const p of parts) {
    if (p.type === "hour") h = parseInt(p.value, 10);
    if (p.type === "minute") m = parseInt(p.value, 10);
  }
  return h * 60 + m;
}

function formatTzTime(timezone) {
  try {
    return new Date().toLocaleTimeString("en-US", {
      timeZone: timezone,
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    });
  } catch {
    return "";
  }
}

function LiveClock({ timezone }) {
  const [time, setTime] = useState(() => formatTzTime(timezone));

  useEffect(() => {
    setTime(formatTzTime(timezone));
    const id = setInterval(() => setTime(formatTzTime(timezone)), 1000);
    return () => clearInterval(id);
  }, [timezone]);

  return (
    <span className="text-[0.8125rem] font-medium text-black/55 dark:text-white/55 tabular-nums">
      {time}
    </span>
  );
}

function NextEventCountdown({ events, timezone }) {
  const [label, setLabel] = useState("");

  useEffect(() => {
    const compute = () => {
      const now = new Date();
      const nowParts = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "numeric", minute: "numeric", hour12: false,
      }).formatToParts(now);
      let tzH = 0, tzM = 0, tzY = 0, tzMo = 0, tzD = 0;
      for (const p of nowParts) {
        if (p.type === "hour") tzH = parseInt(p.value, 10);
        if (p.type === "minute") tzM = parseInt(p.value, 10);
        if (p.type === "year") tzY = parseInt(p.value, 10);
        if (p.type === "month") tzMo = parseInt(p.value, 10);
        if (p.type === "day") tzD = parseInt(p.value, 10);
      }
      const nowKey = `${tzY}-${String(tzMo).padStart(2, "0")}-${String(tzD).padStart(2, "0")}`;
      const nowMinutes = tzH * 60 + tzM;

      let closest = null;
      let closestMin = Infinity;

      for (const evt of events) {
        const evtMinutes = (evt.start_hour ?? 0) * 60;
        let diffMin;
        if (evt.date_key === nowKey) {
          diffMin = evtMinutes - nowMinutes;
        } else if (evt.date_key > nowKey) {
          const [ey, em, ed] = evt.date_key.split("-").map(Number);
          const evtDate = new Date(ey, em - 1, ed);
          const todayDate = new Date(tzY, tzMo - 1, tzD);
          const dayDiff = Math.round((evtDate.getTime() - todayDate.getTime()) / 86400000);
          diffMin = dayDiff * 1440 + evtMinutes - nowMinutes;
        } else {
          continue;
        }
        if (diffMin > 0 && diffMin < closestMin) {
          closestMin = diffMin;
          closest = evt;
        }
      }

      if (!closest) {
        setLabel("");
        return;
      }

      const hours = Math.floor(closestMin / 60);
      const mins = closestMin % 60;
      let text = "";
      if (hours >= 24) {
        const d = Math.floor(hours / 24);
        const h = hours % 24;
        text = h > 0 ? `${d}d ${h}h` : `${d}d`;
      } else if (hours > 0) {
        text = mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
      } else {
        text = `${mins}m`;
      }
      setLabel(`${text} until ${closest.title}`);
    };

    compute();
    const id = setInterval(compute, 30_000);
    return () => clearInterval(id);
  }, [events, timezone]);

  if (!label) return null;

  return (
    <span className="inline-flex items-center gap-1.5 text-[0.625rem] font-medium px-2.5 py-0.5 rounded-full glass-control text-blue-600 dark:text-blue-400">
      <Clock className="w-3 h-3" />
      {label}
    </span>
  );
}

function getDaysForRange(center, mode) {
  if (mode === "3day") {
    return [-1, 0, 1].map((offset) => {
      const d = new Date(center);
      d.setDate(d.getDate() + offset);
      return d;
    });
  }
  // week: Sun-Sat of the week containing center
  const dayOfWeek = center.getDay();
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(center);
    d.setDate(d.getDate() - dayOfWeek + i);
    return d;
  });
}

function NowIndicator({ timezone }) {
  const [minutes, setMinutes] = useState(() => getTzMinutes(timezone));

  useEffect(() => {
    setMinutes(getTzMinutes(timezone));
    const id = setInterval(() => setMinutes(getTzMinutes(timezone)), 30000);
    return () => clearInterval(id);
  }, [timezone]);

  const pct = (minutes / 1440) * 100;
  return (
    <div
      className="absolute left-0 right-0 z-10 pointer-events-none"
      style={{ top: `${pct}%` }}
    >
      <div className="flex items-center">
        <div className="w-2 h-2 rounded-full bg-red-500 -ml-1 shrink-0" />
        <div className="h-px flex-1 bg-red-500" />
      </div>
    </div>
  );
}

function eventColors(event, fallbackIndex) {
  if (event.custom_color) {
    const cs = hexToColorSet(event.custom_color);
    return { bg: cs.bg, border: cs.border };
  }
  if (event.preset_id) {
    const p = getPreset(event.preset_id);
    return { bg: p.bg, border: p.border };
  }
  const idx = (event.id?.charCodeAt?.(0) ?? fallbackIndex) % EVENT_COLORS.length;
  return { bg: EVENT_COLORS[idx], border: EVENT_BORDER_COLORS[idx] };
}

function layoutOverlappingEvents(events) {
  const sorted = [...events].sort((a, b) => (a.start_hour ?? 0) - (b.start_hour ?? 0));
  const result = new Map();
  const groups = [];

  for (const evt of sorted) {
    const s = evt.start_hour ?? 0;
    const e = evt.end_hour ?? s + 1;
    let placed = false;
    for (const group of groups) {
      const overlaps = group.some((g) => {
        const gs = g.start_hour ?? 0;
        const ge = g.end_hour ?? gs + 1;
        return s < ge && e > gs;
      });
      if (overlaps) {
        group.push(evt);
        placed = true;
        break;
      }
    }
    if (!placed) groups.push([evt]);
  }

  for (const group of groups) {
    const columns = [];
    const groupSorted = [...group].sort((a, b) => (a.start_hour ?? 0) - (b.start_hour ?? 0));
    for (const evt of groupSorted) {
      const s = evt.start_hour ?? 0;
      let col = 0;
      while (col < columns.length) {
        const lastInCol = columns[col];
        if ((lastInCol.end_hour ?? (lastInCol.start_hour ?? 0) + 1) <= s) break;
        col++;
      }
      if (col >= columns.length) columns.push(evt);
      else columns[col] = evt;
      result.set(evt.id, { colIndex: col, colTotal: 0 });
    }
    const total = columns.length;
    for (const evt of group) {
      const info = result.get(evt.id);
      if (info) info.colTotal = total;
    }
  }
  return result;
}

function EventBlock({ event, index, onClick, onMove, onResize, colIndex = 0, colTotal = 1 }) {
  const { bg, border } = eventColors(event, index);
  const start = event.start_hour ?? 0;
  const end = event.end_hour ?? start + 1;
  const duration = end - start;
  const topPx = start * 2 * SLOT_HEIGHT + 1;
  const heightPx = Math.max(duration * 2 * SLOT_HEIGHT - 2, SLOT_HEIGHT - 2);
  const didDrag = useRef(false);

  const handleMouseDown = (e) => {
    if (!onMove) return;
    e.stopPropagation();
    const startY = e.clientY;
    const origStart = start;
    didDrag.current = false;
    const el = e.currentTarget;
    el.style.opacity = "0.7";
    el.style.zIndex = "20";
    el.style.cursor = "grabbing";

    const onMouseMove = (ev) => {
      const dy = ev.clientY - startY;
      if (Math.abs(dy) > 4) didDrag.current = true;
      const dSlots = Math.round(dy / (SLOT_HEIGHT / 2));
      const newStart = Math.max(0, Math.min(origStart + dSlots * 0.25, 24 - duration));
      const newTop = newStart * 2 * SLOT_HEIGHT + 1;
      el.style.top = `${newTop}px`;
    };

    const onMouseUp = (ev) => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      el.style.opacity = "";
      el.style.zIndex = "";
      el.style.cursor = "";

      if (didDrag.current) {
        const dy = ev.clientY - startY;
        const dSlots = Math.round(dy / (SLOT_HEIGHT / 2));
        const newStart = Math.max(0, Math.min(origStart + dSlots * 0.25, 24 - duration));
        if (newStart !== origStart) {
          onMove(event.id, newStart, event.date_key);
        } else {
          el.style.top = `${topPx}px`;
        }
      }
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  };

  const handleResizeDown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const origEnd = end;
    didDrag.current = true;
    const parentEl = e.target.closest("[data-event-block]");

    const onMouseMove = (ev) => {
      const dy = ev.clientY - startY;
      const dSlots = Math.round(dy / (SLOT_HEIGHT / 2));
      const newEnd = Math.min(Math.max(origEnd + dSlots * 0.25, start + 0.25), 24);
      if (parentEl) {
        const newHeight = Math.max((newEnd - start) * 2 * SLOT_HEIGHT - 2, SLOT_HEIGHT - 2);
        parentEl.style.height = `${newHeight}px`;
      }
    };

    const onMouseUp = (ev) => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      const dy = ev.clientY - startY;
      const dSlots = Math.round(dy / (SLOT_HEIGHT / 2));
      const newEnd = Math.min(Math.max(origEnd + dSlots * 0.25, start + 0.25), 24);
      if (newEnd !== origEnd && onResize) {
        onResize(event.id, newEnd);
      } else if (parentEl) {
        parentEl.style.height = `${heightPx}px`;
      }
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  };

  const handleClick = (e) => {
    e.stopPropagation();
    if (!didDrag.current) onClick?.(event);
  };

  const leftOffset = colTotal > 1
    ? `calc(64px + ${(colIndex / colTotal) * 100}% - ${(colIndex / colTotal) * 64}px)`
    : "64px";
  const widthVal = colTotal > 1
    ? `calc(${100 / colTotal}% - ${64 / colTotal}px - 2px)`
    : "calc(100% - 64px - 8px)";

  return (
    <div
      data-event-block
      className="absolute rounded-lg px-2 py-1 overflow-visible cursor-grab hover:opacity-80 transition-shadow z-[5]"
      style={{
        top: `${topPx}px`,
        height: `${heightPx}px`,
        left: leftOffset,
        width: widthVal,
        background: bg,
        borderLeft: `3px solid ${border}`,
      }}
      onMouseDown={handleMouseDown}
      onClick={handleClick}
    >
      <div className="flex items-center gap-1">
        <div className="text-[0.6875rem] font-semibold text-black/80 dark:text-white/80 truncate flex-1 min-w-0">
          {displayTitle(event)}
        </div>
        {event.recurrence && event.recurrence !== "none" && (
          <span title="Repeating event"><RefreshCw className="w-2.5 h-2.5 shrink-0 text-blue-500/60" /></span>
        )}
        {event.report_status && (() => {
          const rs = REPORT_STATUSES.find((s) => s.id === event.report_status);
          if (!rs) return null;
          const Icon = rs.icon;
          return <span title={rs.label}><Icon className="w-3 h-3 shrink-0" style={{ color: rs.color }} /></span>;
        })()}
      </div>
      <div className="text-[9px] text-black/45 dark:text-white/45 truncate">
        {formatTime(start)} – {formatTime(end)}
      </div>
      {heightPx > 30 && event.description && (
        <div className="text-[0.625rem] text-black/50 dark:text-white/50 truncate mt-0.5">
          {event.description}
        </div>
      )}
      {heightPx > 50 && event.members?.length > 0 && (
        <div className="flex items-center gap-1 mt-1">
          {event.members.slice(0, 3).map((m, i) => (
            <div
              key={i}
              className="w-4 h-4 rounded-full bg-black/10 dark:bg-white/10 text-[8px] font-bold flex items-center justify-center text-black/60 dark:text-white/60"
              title={m}
            >
              {m.charAt(0).toUpperCase()}
            </div>
          ))}
          {event.members.length > 3 && (
            <span className="text-[9px] text-black/40 dark:text-white/40">
              +{event.members.length - 3}
            </span>
          )}
        </div>
      )}
      {onResize && (
        <div
          onMouseDown={handleResizeDown}
          className="absolute left-0 right-0 bottom-0 h-3 cursor-s-resize flex items-center justify-center"
        >
          <div className="w-8 h-1 rounded-full" style={{ background: border, opacity: 0.6 }} />
        </div>
      )}
    </div>
  );
}

function DraftEventBlock({ draft, onDragEnd, leftClass = "left-16", rightClass = "right-2" }) {
  const cc = draft.custom_color ? hexToColorSet(draft.custom_color) : null;
  const border = cc ? cc.border : (draft.preset?.border || "rgba(59,130,246,0.55)");
  const bg = cc ? cc.bg : (draft.preset?.bg || "rgba(59,130,246,0.08)");
  const start = draft.start_hour ?? 0;
  const end = draft.end_hour ?? start + 0.5;
  const duration = end - start;
  const topPx = start * 2 * SLOT_HEIGHT + 1;
  const heightPx = Math.max(duration * 2 * SLOT_HEIGHT - 2, SLOT_HEIGHT - 2);
  const dragRef = useRef(null);

  const handleMouseDown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const startEnd = end;
    const gridEl = e.target.closest("[data-grid]");
    const onMove = (ev) => {
      const dy = ev.clientY - startY;
      const dSlots = Math.round(dy / (SLOT_HEIGHT / 2));
      const newEnd = Math.min(Math.max(startEnd + dSlots * 0.25, start + 0.25), 24);
      onDragEnd?.({ end_hour: newEnd });
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  return (
    <div
      className={`absolute ${leftClass} ${rightClass} rounded-lg overflow-visible z-[4] pointer-events-none`}
      style={{
        top: `${topPx}px`,
        height: `${heightPx}px`,
        background: bg,
        border: `2px dashed ${border}`,
        borderRadius: "8px",
      }}
    >
      <div className="px-2 py-1">
        <div className="text-[0.625rem] font-medium text-black/40 dark:text-white/40 truncate">
          {draft.preset?.label || "New Event"}
        </div>
      </div>
      <div
        ref={dragRef}
        onMouseDown={handleMouseDown}
        className="absolute left-0 right-0 bottom-0 h-3 cursor-s-resize pointer-events-auto flex items-center justify-center"
      >
        <div className="w-8 h-1 rounded-full" style={{ background: border }} />
      </div>
    </div>
  );
}

const CUSTOM_PRESETS_KEY = "lykinsai_custom_presets";
const PRESET_COLOR_OPTIONS = [
  { color: "rgba(59,130,246,0.85)",  border: "rgba(59,130,246,0.55)",  bg: "rgba(59,130,246,0.14)" },
  { color: "rgba(16,185,129,0.85)",  border: "rgba(16,185,129,0.55)",  bg: "rgba(16,185,129,0.14)" },
  { color: "rgba(245,158,11,0.85)",  border: "rgba(245,158,11,0.55)",  bg: "rgba(245,158,11,0.14)" },
  { color: "rgba(239,68,68,0.85)",   border: "rgba(239,68,68,0.55)",   bg: "rgba(239,68,68,0.14)" },
  { color: "rgba(139,92,246,0.85)",  border: "rgba(139,92,246,0.55)",  bg: "rgba(139,92,246,0.14)" },
  { color: "rgba(236,72,153,0.85)",  border: "rgba(236,72,153,0.55)",  bg: "rgba(236,72,153,0.14)" },
  { color: "rgba(14,165,233,0.85)",  border: "rgba(14,165,233,0.55)",  bg: "rgba(14,165,233,0.14)" },
  { color: "rgba(234,179,8,0.85)",   border: "rgba(234,179,8,0.55)",   bg: "rgba(234,179,8,0.14)" },
  { color: "rgba(249,115,22,0.85)",  border: "rgba(249,115,22,0.55)",  bg: "rgba(249,115,22,0.14)" },
  { color: "rgba(34,197,94,0.85)",   border: "rgba(34,197,94,0.55)",   bg: "rgba(34,197,94,0.14)" },
  { color: "rgba(100,116,139,0.85)", border: "rgba(100,116,139,0.55)", bg: "rgba(100,116,139,0.14)" },
  { color: "rgba(99,102,241,0.85)",  border: "rgba(99,102,241,0.55)",  bg: "rgba(99,102,241,0.14)" },
];

const CUSTOM_COLORS_KEY = "lykinsai_custom_colors";

function hexToColorSet(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return {
    color: `rgba(${r},${g},${b},0.85)`,
    border: `rgba(${r},${g},${b},0.55)`,
    bg: `rgba(${r},${g},${b},0.14)`,
    hex,
  };
}

function loadCustomColors() {
  try {
    const raw = localStorage.getItem(CUSTOM_COLORS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveCustomColors(colors) {
  try {
    localStorage.setItem(CUSTOM_COLORS_KEY, JSON.stringify(colors));
  } catch {}
}

const USER_PRESET_COLORS_KEY = "lykinsai_user_preset_colors";

function loadUserPresetColors() {
  try {
    const raw = localStorage.getItem(USER_PRESET_COLORS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveUserPresetColors(colors) {
  try {
    localStorage.setItem(USER_PRESET_COLORS_KEY, JSON.stringify(colors));
  } catch {}
}

const PRESET_COLOR_OVERRIDES_KEY = "lykinsai_preset_color_overrides";

function loadPresetColorOverrides() {
  try {
    const raw = localStorage.getItem(PRESET_COLOR_OVERRIDES_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function savePresetColorOverrides(overrides) {
  try {
    localStorage.setItem(PRESET_COLOR_OVERRIDES_KEY, JSON.stringify(overrides));
  } catch {}
}

function loadCustomPresets() {
  try {
    const raw = localStorage.getItem(CUSTOM_PRESETS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveCustomPresets(presets) {
  try {
    localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(presets));
  } catch {}
}

function PresetPicker({ onSelect, onClose }) {
  const [customPresets, setCustomPresets] = useState(() => loadCustomPresets());
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [selectedColorIdx, setSelectedColorIdx] = useState(0);
  const [pickerCustomHex, setPickerCustomHex] = useState(null);
  const [pickerSavedColors] = useState(() => loadCustomColors());
  const [pickerUserPresetColors] = useState(() => loadUserPresetColors());
  const nameRef = useRef(null);

  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === "Escape") {
        if (creating) setCreating(false);
        else onClose();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose, creating]);

  useEffect(() => {
    if (creating) nameRef.current?.focus();
  }, [creating]);

  const handleCreate = () => {
    const name = newName.trim();
    if (!name) return;
    const colors = pickerCustomHex
      ? hexToColorSet(pickerCustomHex)
      : PRESET_COLOR_OPTIONS[selectedColorIdx];
    const newPreset = {
      id: `user_${Date.now()}`,
      label: name,
      icon: "Pen",
      color: colors.color,
      bg: colors.bg,
      border: colors.border,
    };
    const updated = [...customPresets, newPreset];
    setCustomPresets(updated);
    saveCustomPresets(updated);
    setCreating(false);
    setNewName("");
    setSelectedColorIdx(0);
    setPickerCustomHex(null);
  };

  const allPresets = useMemo(() => {
    const overrides = loadPresetColorOverrides();
    const applyOverride = (p) => {
      if (overrides[p.id]) {
        const cs = hexToColorSet(overrides[p.id]);
        return { ...p, color: cs.color, bg: cs.bg, border: cs.border };
      }
      return p;
    };
    return [
      ...EVENT_PRESETS.map(applyOverride),
      ...customPresets.map((p) => applyOverride({ ...p, icon: Pen })),
    ];
  }, [customPresets]);

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/20 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-[260px] max-w-[90vw] rounded-2xl glass-control border border-white/25 dark:border-white/10 shadow-2xl p-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-[0.75rem] font-semibold text-black/70 dark:text-white/70">
            Event type
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full w-6 h-6 hover:bg-black/10 dark:hover:bg-white/10 flex items-center justify-center transition-colors"
          >
            <X className="w-3.5 h-3.5 text-black/50 dark:text-white/50" />
          </button>
        </div>
        <div className="flex flex-col max-h-[60vh] overflow-y-auto scrollbar-hide">
          {allPresets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => onSelect(preset)}
              className="flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-black/[0.05] dark:hover:bg-white/[0.06] transition-colors text-left"
            >
              <div
                className="w-2.5 h-2.5 rounded-full shrink-0"
                style={{ background: preset.border }}
              />
              <span className="text-[0.75rem] font-medium text-black/75 dark:text-white/75">
                {preset.label}
              </span>
            </button>
          ))}
        </div>

        <div className="mt-2 pt-2 border-t border-black/[0.06] dark:border-white/[0.06]">
          {creating ? (
            <div className="flex flex-col gap-2 px-1">
              <input
                ref={nameRef}
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleCreate();
                  }
                }}
                placeholder="Preset name"
                className="w-full rounded-lg border border-black/10 dark:border-white/10 bg-white/20 dark:bg-white/5 px-2.5 py-1.5 text-[0.6875rem] text-black/80 dark:text-white/80 placeholder:text-black/35 dark:placeholder:text-white/35 outline-none"
              />
              <p className="text-[9px] text-black/35 dark:text-white/35 uppercase tracking-wider">Preset colors</p>
              <div className="flex flex-wrap gap-1.5">
                {PRESET_COLOR_OPTIONS.map((c, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => { setSelectedColorIdx(i); setPickerCustomHex(null); }}
                    className={`w-5 h-5 rounded-full transition-all ${
                      pickerCustomHex === null && selectedColorIdx === i ? "ring-2 ring-offset-1 ring-black/20 dark:ring-white/20 scale-110" : "hover:scale-110"
                    }`}
                    style={{ background: c.border }}
                  />
                ))}
                {pickerUserPresetColors.map((hex, i) => (
                  <button
                    key={"upc-" + i}
                    type="button"
                    onClick={() => setPickerCustomHex(hex)}
                    className={`w-5 h-5 rounded-full transition-all ${
                      pickerCustomHex === hex ? "ring-2 ring-offset-1 ring-black/20 dark:ring-white/20 scale-110" : "hover:scale-110"
                    }`}
                    style={{ background: hex }}
                  />
                ))}
              </div>
              {pickerSavedColors.length > 0 && (
                <>
                  <p className="text-[9px] text-black/35 dark:text-white/35 uppercase tracking-wider">My colors</p>
                  <div className="flex flex-wrap gap-1.5">
                    {pickerSavedColors.map((hex, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => setPickerCustomHex(hex)}
                        className={`w-5 h-5 rounded-full transition-all ${
                          pickerCustomHex === hex ? "ring-2 ring-offset-1 ring-black/20 dark:ring-white/20 scale-110" : "hover:scale-110"
                        }`}
                        style={{ background: hex }}
                      />
                    ))}
                  </div>
                </>
              )}
              <div className="flex items-center gap-1.5">
                <input
                  type="color"
                  value={pickerCustomHex || "#3b82f6"}
                  onChange={(e) => setPickerCustomHex(e.target.value)}
                  className="w-6 h-6 rounded-full cursor-pointer border-0 p-0 bg-transparent color-circle"
                />
                <span className="text-[9px] text-black/30 dark:text-white/30">Custom</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => { setCreating(false); setNewName(""); setPickerCustomHex(null); }}
                  className="text-[0.625rem] font-medium px-2.5 py-1 rounded-full hover:bg-black/[0.06] dark:hover:bg-white/[0.08] text-black/50 dark:text-white/50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleCreate}
                  disabled={!newName.trim()}
                  className="text-[0.625rem] font-medium px-3 py-1 rounded-full glass-control hover:opacity-90 transition-all disabled:opacity-40"
                >
                  Create
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-black/[0.05] dark:hover:bg-white/[0.06] transition-colors text-left w-full"
            >
              <Plus className="w-3 h-3 text-black/40 dark:text-white/40" />
              <span className="text-[0.75rem] font-medium text-black/50 dark:text-white/50">
                Create preset
              </span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function EventModal({ event, startTime, date, preset, onClose, onSave, onDelete, onDraftChange, draftEndHour, onLiveColorChange, onPresetColorChange }) {
  const isEdit = !!event;
  const initialPreset = isEdit ? getPreset(event.preset_id) : preset || EVENT_PRESETS[0];
  const [activePreset, setActivePreset] = useState(initialPreset);
  const defaultTitle = isEdit ? event.title : activePreset.label;
  const [editing, setEditing] = useState(true);
  const [title, setTitle] = useState(event?.title ?? defaultTitle);
  const [allPresets, setAllPresets] = useState(() => {
    const overrides = loadPresetColorOverrides();
    const applyOverride = (p) => {
      if (overrides[p.id]) {
        const cs = hexToColorSet(overrides[p.id]);
        return { ...p, color: cs.color, bg: cs.bg, border: cs.border };
      }
      return p;
    };
    return [
      ...EVENT_PRESETS.map(applyOverride),
      ...loadCustomPresets().map((p) => applyOverride({ ...p, icon: Pen })),
    ];
  });
  const [creatingPreset, setCreatingPreset] = useState(false);
  const [newPresetName, setNewPresetName] = useState("");
  const [newPresetColorIdx, setNewPresetColorIdx] = useState(0);
  const [newPresetCustomHex, setNewPresetCustomHex] = useState(null);
  const newPresetNameRef = useRef(null);
  const [customColor, setCustomColor] = useState(event?.custom_color ?? null);
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const [savedColors, setSavedColors] = useState(() => loadCustomColors());
  const [userPresetColors, setUserPresetColors] = useState(() => loadUserPresetColors());
  const colorPickerRef = useRef(null);
  const colorInputRef = useRef(null);
  const [reminder, setReminder] = useState(event?.reminder ?? "none");
  const [description, setDescription] = useState(event?.description ?? "");
  const [members, setMembers] = useState(event?.members ?? []);
  const [memberInput, setMemberInput] = useState("");
  const [showMemberInput, setShowMemberInput] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMode, setSaveMode] = useState("single");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteMode, setDeleteMode] = useState("single");
  const [deleting, setDeleting] = useState(false);
  const isSeries = !!event?.series_id;
  const [reportOpen, setReportOpen] = useState(false);
  const [reportStatus, setReportStatus] = useState(event?.report_status ?? null);
  const [reportNote, setReportNote] = useState(event?.report_note ?? "");
  const [reportSaving, setReportSaving] = useState(false);
  const eventIsPast = isEdit && isEventPast(event);
  const [linkedTeamSpaces, setLinkedTeamSpaces] = useState(event?.team_space_ids ?? []);
  const [availableTeamSpaces, setAvailableTeamSpaces] = useState([]);
  const [teamSpaceDropdownOpen, setTeamSpaceDropdownOpen] = useState(false);
  const teamSpaceDropRef = useRef(null);
  const [recurrence, setRecurrence] = useState(event?.recurrence ?? "none");
  const [recurrenceOpen, setRecurrenceOpen] = useState(false);
  const recurrenceDropRef = useRef(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("lykinsai_teamspaces");
      const teams = raw ? JSON.parse(raw) : [];
      setAvailableTeamSpaces(teams.map((t) => ({ id: t.id, name: t.name })));
    } catch {}
  }, []);

  const defaultStart = event?.start_hour ?? startTime ?? 9;
  const defaultEnd = event?.end_hour ?? Math.min(defaultStart + 0.5, 24);
  const [startHour, setStartHour] = useState(defaultStart);
  const [endHour, setEndHour] = useState(defaultEnd);
  const [startOpen, setStartOpen] = useState(false);
  const [endOpen, setEndOpen] = useState(false);
  const [reminderOpen, setReminderOpen] = useState(false);
  const startDropRef = useRef(null);
  const endDropRef = useRef(null);
  const reminderDropRef = useRef(null);

  useEffect(() => {
    const handler = (e) => {
      if (startOpen && startDropRef.current && !startDropRef.current.contains(e.target)) setStartOpen(false);
      if (endOpen && endDropRef.current && !endDropRef.current.contains(e.target)) setEndOpen(false);
      if (reminderOpen && reminderDropRef.current && !reminderDropRef.current.contains(e.target)) setReminderOpen(false);
      if (colorPickerOpen && colorPickerRef.current && !colorPickerRef.current.contains(e.target)) setColorPickerOpen(false);
      if (teamSpaceDropdownOpen && teamSpaceDropRef.current && !teamSpaceDropRef.current.contains(e.target)) setTeamSpaceDropdownOpen(false);
      if (recurrenceOpen && recurrenceDropRef.current && !recurrenceDropRef.current.contains(e.target)) setRecurrenceOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [startOpen, endOpen, reminderOpen, colorPickerOpen, teamSpaceDropdownOpen, recurrenceOpen]);

  const titleRef = useRef(null);

  useEffect(() => {
    if (editing) titleRef.current?.focus();
  }, [editing]);

  useEffect(() => {
    if (!isEdit && onDraftChange) {
      onDraftChange({ start_hour: startHour, end_hour: endHour, preset: activePreset, custom_color: customColor });
    }
  }, [startHour, endHour, activePreset, customColor, isEdit, onDraftChange]);

  const initialColor = useRef(event?.custom_color ?? null);
  useEffect(() => {
    if (isEdit && event?.id && onLiveColorChange && customColor !== initialColor.current) {
      onLiveColorChange(event.id, customColor);
      initialColor.current = customColor;
    }
  }, [customColor, isEdit, event?.id, onLiveColorChange]);

  useEffect(() => {
    if (draftEndHour != null && draftEndHour !== endHour && !isEdit) {
      setEndHour(draftEndHour);
    }
  }, [draftEndHour]);

  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === "Escape") {
        if (creatingPreset) setCreatingPreset(false);
        else onClose();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose, creatingPreset]);

  useEffect(() => {
    if (creatingPreset) newPresetNameRef.current?.focus();
  }, [creatingPreset]);

  const handleCreatePreset = () => {
    const name = newPresetName.trim();
    if (!name) return;
    const colors = newPresetCustomHex
      ? hexToColorSet(newPresetCustomHex)
      : PRESET_COLOR_OPTIONS[newPresetColorIdx];
    const created = {
      id: `user_${Date.now()}`,
      label: name,
      icon: Pen,
      color: colors.color,
      bg: colors.bg,
      border: colors.border,
    };
    const customs = loadCustomPresets();
    saveCustomPresets([...customs, { ...created, icon: "Pen" }]);
    setAllPresets((prev) => [...prev, created]);
    setActivePreset(created);
    if (!title || title === activePreset.label) setTitle(name);
    setCreatingPreset(false);
    setNewPresetName("");
    setNewPresetColorIdx(0);
    setNewPresetCustomHex(null);
  };

  const addMember = () => {
    const email = memberInput.trim();
    if (email && !members.includes(email)) {
      setMembers((prev) => [...prev, email]);
    }
    setMemberInput("");
  };

  const removeMember = (email) => {
    setMembers((prev) => prev.filter((m) => m !== email));
  };

  const handleSubmit = async (e, overrideSaveMode) => {
    e?.preventDefault?.();
    if (!title.trim() || saving) return;
    setSaving(true);
    await onSave({
      id: event?.id,
      title: title.trim(),
      description: description.trim(),
      start_hour: startHour,
      end_hour: endHour,
      members,
      date_key: event?.date_key ?? dateKey(date),
      preset_id: activePreset.id,
      reminder,
      custom_color: customColor,
      report_status: reportStatus,
      report_note: reportNote.trim(),
      team_space_ids: linkedTeamSpaces,
      recurrence,
      series_id: event?.series_id ?? null,
      save_mode: overrideSaveMode || saveMode,
    });
    setSaving(false);
  };

  const handleDelete = async (mode) => {
    const resolvedMode = mode || deleteMode;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setDeleting(true);
    await onDelete(event.id, resolvedMode);
  };

  return (
    <div className="fixed top-0 right-0 bottom-0 z-[90] pointer-events-none">
      <div className="pointer-events-auto w-[340px] max-w-[90vw] h-full border-l border-white/15 dark:border-white/10 bg-white/80 dark:bg-black/70 backdrop-blur-xl shadow-2xl flex flex-col animate-slide-in-right">
        <div className="flex-1 overflow-y-auto scrollbar-hide p-5">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2.5">
            <div className="relative" ref={colorPickerRef}>
              <button
                type="button"
                onClick={() => setColorPickerOpen((v) => !v)}
                className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 cursor-pointer hover:scale-110 transition-transform"
                style={{
                  background: customColor ? hexToColorSet(customColor).bg : activePreset.bg,
                  border: `1.5px solid ${customColor ? hexToColorSet(customColor).border : activePreset.border}`,
                }}
                title="Change event color"
              >
                {(() => {
                  const Icon = activePreset.icon;
                  const c = customColor ? hexToColorSet(customColor).color : activePreset.color;
                  return <Icon className="w-3.5 h-3.5" style={{ color: c }} />;
                })()}
              </button>
              {colorPickerOpen && (
                <div className="absolute left-0 top-full mt-2 w-56 rounded-xl glass-control border border-white/25 dark:border-white/10 bg-white/90 dark:bg-black/70 backdrop-blur-xl shadow-lg p-3 z-50">

                  {/* Preset colors — clicking changes ALL events of this preset */}
                  {activePreset.id !== "custom" && (
                    <>
                      <p className="text-[0.625rem] font-semibold text-black/40 dark:text-white/40 uppercase tracking-wider mb-1.5">
                        Preset colors
                      </p>
                      <p className="text-[8px] text-black/30 dark:text-white/25 mb-2">Changes all {activePreset.label} events</p>
                      <div className="flex flex-wrap gap-2 mb-3">
                        {PRESET_COLOR_OPTIONS.map((c, i) => {
                          const hex = c.border.replace(/rgba\((\d+),(\d+),(\d+).*/, (_, r, g, b) =>
                            `#${[r,g,b].map(v => Number(v).toString(16).padStart(2,"0")).join("")}`
                          );
                          return (
                            <button
                              key={"base-" + i}
                              type="button"
                              onClick={() => {
                                const overrides = loadPresetColorOverrides();
                                overrides[activePreset.id] = hex;
                                savePresetColorOverrides(overrides);
                                const cs = hexToColorSet(hex);
                                setActivePreset((prev) => ({ ...prev, color: cs.color, bg: cs.bg, border: cs.border }));
                                setAllPresets((prev) => prev.map((p) => p.id === activePreset.id ? { ...p, color: cs.color, bg: cs.bg, border: cs.border } : p));
                                setCustomColor(null);
                                if (onPresetColorChange) onPresetColorChange(activePreset.id, hex);
                              }}
                              className={`w-6 h-6 rounded-full transition-all ${
                                !customColor && activePreset.border === c.border
                                  ? "ring-2 ring-offset-1 ring-black/20 dark:ring-white/20 scale-110"
                                  : "hover:scale-110"
                              }`}
                              style={{ background: c.border }}
                            />
                          );
                        })}
                        {userPresetColors.map((hex, i) => (
                          <button
                            key={"upc-" + i}
                            type="button"
                            onClick={() => {
                              const overrides = loadPresetColorOverrides();
                              overrides[activePreset.id] = hex;
                              savePresetColorOverrides(overrides);
                              const cs = hexToColorSet(hex);
                              setActivePreset((prev) => ({ ...prev, color: cs.color, bg: cs.bg, border: cs.border }));
                              setAllPresets((prev) => prev.map((p) => p.id === activePreset.id ? { ...p, color: cs.color, bg: cs.bg, border: cs.border } : p));
                              setCustomColor(null);
                              if (onPresetColorChange) onPresetColorChange(activePreset.id, hex);
                            }}
                            className={`w-6 h-6 rounded-full transition-all ${
                              !customColor && activePreset.border === `rgba(${parseInt(hex.slice(1,3),16)},${parseInt(hex.slice(3,5),16)},${parseInt(hex.slice(5,7),16)},0.55)`
                                ? "ring-2 ring-offset-1 ring-black/20 dark:ring-white/20 scale-110"
                                : "hover:scale-110"
                            }`}
                            style={{ background: hex }}
                          />
                        ))}
                      </div>
                    </>
                  )}

                  {/* My colors — clicking changes only THIS event */}
                  <div className={activePreset.id !== "custom" ? "border-t border-black/[0.06] dark:border-white/[0.06] pt-2.5" : ""}>
                    <p className="text-[0.625rem] font-semibold text-black/40 dark:text-white/40 uppercase tracking-wider mb-1.5">
                      My colors
                    </p>
                    <p className="text-[8px] text-black/30 dark:text-white/25 mb-2">Changes only this event</p>
                    {savedColors.length > 0 ? (
                      <div className="flex flex-wrap gap-2 mb-3">
                        {savedColors.map((hex, i) => (
                          <button
                            key={i}
                            type="button"
                            onClick={() => {
                              setCustomColor(hex);
                            }}
                            className={`w-6 h-6 rounded-full transition-all ${
                              customColor === hex
                                ? "ring-2 ring-offset-1 ring-black/20 dark:ring-white/20 scale-110"
                                : "hover:scale-110"
                            }`}
                            style={{ background: hex }}
                          />
                        ))}
                      </div>
                    ) : (
                      <p className="text-[9px] text-black/25 dark:text-white/20 italic mb-3">No saved colors yet</p>
                    )}
                  </div>

                  {/* Custom color — pick then apply */}
                  <div className="border-t border-black/[0.06] dark:border-white/[0.06] pt-2.5">
                    <p className="text-[0.625rem] font-semibold text-black/40 dark:text-white/40 uppercase tracking-wider mb-2">
                      Custom color
                    </p>
                    <div className="flex items-center gap-2">
                      <input
                        ref={colorInputRef}
                        type="color"
                        defaultValue={customColor || "#3b82f6"}
                        className="w-8 h-8 rounded-full cursor-pointer border-0 p-0 bg-transparent color-circle"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          const hex = colorInputRef.current?.value;
                          if (!hex) return;
                          setCustomColor(hex);
                          if (!savedColors.includes(hex)) {
                            const updated = [...savedColors, hex];
                            setSavedColors(updated);
                            saveCustomColors(updated);
                          }
                          if (!userPresetColors.includes(hex)) {
                            const updated = [...userPresetColors, hex];
                            setUserPresetColors(updated);
                            saveUserPresetColors(updated);
                          }
                        }}
                        className="text-[0.625rem] font-medium px-3 py-1 rounded-full glass-control hover:opacity-90 transition-all"
                      >
                        Apply
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
            <h3 className="text-sm font-semibold text-black/80 dark:text-white/80">
              {!isEdit
                ? `New ${activePreset.id !== "custom" ? activePreset.label : "Event"}`
                : editing
                  ? "Edit Event"
                  : displayTitle(event)}
            </h3>
          </div>
          <div className="flex items-center gap-1">
            {isEdit && !editing && (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="rounded-full w-7 h-7 hover:bg-black/10 dark:hover:bg-white/10 flex items-center justify-center transition-colors"
                title="Edit event"
              >
                <Edit2 className="w-3.5 h-3.5 text-black/50 dark:text-white/50" />
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-full w-7 h-7 hover:bg-black/10 dark:hover:bg-white/10 flex items-center justify-center transition-colors"
            >
              <X className="w-3.5 h-3.5 text-black/50 dark:text-white/50" />
            </button>
          </div>
        </div>

        {editing ? (
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <input
              ref={titleRef}
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Event title"
              className="w-full rounded-xl border border-black/10 dark:border-white/10 bg-white/20 dark:bg-white/5 px-3 py-2 text-[0.8125rem] text-black/80 dark:text-white/80 placeholder:text-black/35 dark:placeholder:text-white/35 outline-none focus:border-black/20 dark:focus:border-white/20 transition-colors"
            />

            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Brief description (optional)"
              rows={2}
              className="w-full rounded-xl border border-black/10 dark:border-white/10 bg-white/20 dark:bg-white/5 px-3 py-2 text-[0.8125rem] text-black/80 dark:text-white/80 placeholder:text-black/35 dark:placeholder:text-white/35 outline-none focus:border-black/20 dark:focus:border-white/20 transition-colors resize-none"
            />

            {/* Time range with 30-min increments */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[0.6875rem] text-black/50 dark:text-white/50">From</span>
              <div className="relative" ref={startDropRef}>
                <button
                  type="button"
                  onClick={() => { setStartOpen((v) => !v); setEndOpen(false); }}
                  className="flex items-center gap-1 text-[0.75rem] font-medium text-black/70 dark:text-white/70 glass-control rounded-lg px-2.5 py-1 cursor-pointer"
                >
                  {formatTime(startHour)}
                  <ChevronDown className="w-3 h-3 text-black/40 dark:text-white/40" />
                </button>
                {startOpen && (
                  <div className="absolute left-0 top-full mt-1 w-32 max-h-48 overflow-y-auto scrollbar-hide rounded-xl glass-control border border-white/25 dark:border-white/10 bg-white/80 dark:bg-black/60 backdrop-blur-xl shadow-lg py-1 z-50">
                    {TIME_OPTIONS_15.map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => {
                          setStartHour(t);
                          if (endHour <= t) setEndHour(Math.min(t + 0.25, 24));
                          setStartOpen(false);
                        }}
                        className={`w-full text-left text-[0.6875rem] px-3 py-1.5 hover:bg-black/[0.06] dark:hover:bg-white/[0.08] transition-colors ${
                          startHour === t ? "font-semibold text-black dark:text-white" : "text-black/65 dark:text-white/65"
                        }`}
                      >
                        {formatTime(t)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <span className="text-[0.6875rem] text-black/50 dark:text-white/50">to</span>
              <div className="relative" ref={endDropRef}>
                <button
                  type="button"
                  onClick={() => { setEndOpen((v) => !v); setStartOpen(false); }}
                  className="flex items-center gap-1 text-[0.75rem] font-medium text-black/70 dark:text-white/70 glass-control rounded-lg px-2.5 py-1 cursor-pointer"
                >
                  {formatTime(endHour)}
                  <ChevronDown className="w-3 h-3 text-black/40 dark:text-white/40" />
                </button>
                {endOpen && (
                  <div className="absolute left-0 top-full mt-1 w-32 max-h-48 overflow-y-auto scrollbar-hide rounded-xl glass-control border border-white/25 dark:border-white/10 bg-white/80 dark:bg-black/60 backdrop-blur-xl shadow-lg py-1 z-50">
                    {TIME_OPTIONS_15.filter((t) => t > startHour).map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => { setEndHour(t); setEndOpen(false); }}
                        className={`w-full text-left text-[0.6875rem] px-3 py-1.5 hover:bg-black/[0.06] dark:hover:bg-white/[0.08] transition-colors ${
                          endHour === t ? "font-semibold text-black dark:text-white" : "text-black/65 dark:text-white/65"
                        }`}
                      >
                        {formatTime(t)}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => { setEndHour(24); setEndOpen(false); }}
                      className={`w-full text-left text-[0.6875rem] px-3 py-1.5 hover:bg-black/[0.06] dark:hover:bg-white/[0.08] transition-colors ${
                        endHour === 24 ? "font-semibold text-black dark:text-white" : "text-black/65 dark:text-white/65"
                      }`}
                    >
                      12:00 AM (end)
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Reminder */}
            <div className="flex items-center gap-2">
              <Clock className="w-3.5 h-3.5 text-black/40 dark:text-white/40 shrink-0" />
              <span className="text-[0.6875rem] text-black/50 dark:text-white/50">Reminder</span>
              <div className="relative flex-1" ref={reminderDropRef}>
                <button
                  type="button"
                  onClick={() => { setReminderOpen((v) => !v); setStartOpen(false); setEndOpen(false); }}
                  className="flex items-center justify-between w-full text-[0.75rem] font-medium text-black/70 dark:text-white/70 glass-control rounded-lg px-2.5 py-1 cursor-pointer"
                >
                  <span>{{ none: "None", "0": "At time of event", "5": "5 min before", "15": "15 min before", "30": "30 min before", "60": "1 hour before", "1440": "1 day before" }[reminder] || "None"}</span>
                  <ChevronDown className="w-3 h-3 text-black/40 dark:text-white/40" />
                </button>
                {reminderOpen && (
                  <div className="absolute left-0 top-full mt-1 w-full max-h-48 overflow-y-auto scrollbar-hide rounded-xl glass-control border border-white/25 dark:border-white/10 bg-white/80 dark:bg-black/60 backdrop-blur-xl shadow-lg py-1 z-50">
                    {[
                      { value: "none", label: "None" },
                      { value: "0", label: "At time of event" },
                      { value: "5", label: "5 minutes before" },
                      { value: "15", label: "15 minutes before" },
                      { value: "30", label: "30 minutes before" },
                      { value: "60", label: "1 hour before" },
                      { value: "1440", label: "1 day before" },
                    ].map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => { setReminder(opt.value); setReminderOpen(false); }}
                        className={`w-full text-left text-[0.6875rem] px-3 py-1.5 hover:bg-black/[0.06] dark:hover:bg-white/[0.08] transition-colors ${
                          reminder === opt.value ? "font-semibold text-black dark:text-white" : "text-black/65 dark:text-white/65"
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Repeat */}
            <div className="flex items-center gap-2">
              <RefreshCw className="w-3.5 h-3.5 text-black/40 dark:text-white/40 shrink-0" />
              <span className="text-[0.6875rem] text-black/50 dark:text-white/50">Repeat</span>
              <div className="relative flex-1" ref={recurrenceDropRef}>
                <button
                  type="button"
                  onClick={() => { setRecurrenceOpen((v) => !v); setStartOpen(false); setEndOpen(false); setReminderOpen(false); }}
                  className="flex items-center justify-between w-full text-[0.75rem] font-medium text-black/70 dark:text-white/70 glass-control rounded-lg px-2.5 py-1 cursor-pointer"
                >
                  <span>{{ none: "Does not repeat", daily: "Daily", weekdays: "Every weekday (Mon–Fri)", weekly: "Weekly", biweekly: "Every 2 weeks", monthly: "Monthly", custom_weekly: `Every ${(() => { const dayNames = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"]; const d = new Date(event?.date_key ? event.date_key + "T00:00:00" : date); return dayNames[d.getDay()]; })()}` }[recurrence] || "Does not repeat"}</span>
                  <ChevronDown className="w-3 h-3 text-black/40 dark:text-white/40" />
                </button>
                {recurrenceOpen && (
                  <div className="absolute left-0 top-full mt-1 w-full max-h-56 overflow-y-auto scrollbar-hide rounded-xl glass-control border border-white/25 dark:border-white/10 bg-white/80 dark:bg-black/60 backdrop-blur-xl shadow-lg py-1 z-50">
                    {[
                      { value: "none", label: "Does not repeat" },
                      { value: "daily", label: "Daily" },
                      { value: "weekdays", label: "Every weekday (Mon–Fri)" },
                      { value: "weekly", label: "Weekly" },
                      { value: "biweekly", label: "Every 2 weeks" },
                      { value: "monthly", label: "Monthly" },
                    ].map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => { setRecurrence(opt.value); setRecurrenceOpen(false); }}
                        className={`w-full text-left text-[0.6875rem] px-3 py-1.5 hover:bg-black/[0.06] dark:hover:bg-white/[0.08] transition-colors ${
                          recurrence === opt.value ? "font-semibold text-black dark:text-white" : "text-black/65 dark:text-white/65"
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Preset switcher */}
            <div className="pt-1">
              <p className="text-[0.625rem] font-semibold text-black/40 dark:text-white/40 uppercase tracking-wider mb-1.5 px-1">
                Event type
              </p>
              <div className="flex flex-col rounded-xl border border-black/[0.06] dark:border-white/[0.06] overflow-hidden">
                {allPresets.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      const oldLabel = activePreset.label;
                      setActivePreset(p);
                      if (!title || title === oldLabel) {
                        setTitle(p.label);
                      }
                    }}
                    className={`flex items-center gap-2.5 px-3 py-1.5 text-left transition-colors ${
                      activePreset.id === p.id
                        ? "bg-black/[0.06] dark:bg-white/[0.08]"
                        : "hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                    }`}
                  >
                    <div
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ background: p.border }}
                    />
                    <span className={`text-[0.6875rem] ${
                      activePreset.id === p.id
                        ? "font-semibold text-black/80 dark:text-white/80"
                        : "font-medium text-black/55 dark:text-white/55"
                    }`}>
                      {p.label}
                    </span>
                    {activePreset.id === p.id && (
                      <Check className="w-3 h-3 ml-auto text-black/40 dark:text-white/40" />
                    )}
                  </button>
                ))}
              </div>
              {creatingPreset ? (
                <div className="flex flex-col gap-2 p-3 border-t border-black/[0.06] dark:border-white/[0.06]">
                  <input
                    ref={newPresetNameRef}
                    type="text"
                    value={newPresetName}
                    onChange={(e) => setNewPresetName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleCreatePreset(); } }}
                    placeholder="Preset name"
                    className="w-full rounded-lg border border-black/10 dark:border-white/10 bg-white/20 dark:bg-white/5 px-2.5 py-1.5 text-[0.6875rem] text-black/80 dark:text-white/80 placeholder:text-black/35 dark:placeholder:text-white/35 outline-none"
                  />
                  <p className="text-[9px] text-black/35 dark:text-white/35 uppercase tracking-wider">Preset colors</p>
                  <div className="flex flex-wrap gap-1.5">
                    {PRESET_COLOR_OPTIONS.map((c, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => { setNewPresetColorIdx(i); setNewPresetCustomHex(null); }}
                        className={`w-5 h-5 rounded-full transition-all ${
                          newPresetCustomHex === null && newPresetColorIdx === i ? "ring-2 ring-offset-1 ring-black/20 dark:ring-white/20 scale-110" : "hover:scale-110"
                        }`}
                        style={{ background: c.border }}
                      />
                    ))}
                    {userPresetColors.map((hex, i) => (
                      <button
                        key={"upc-" + i}
                        type="button"
                        onClick={() => setNewPresetCustomHex(hex)}
                        className={`w-5 h-5 rounded-full transition-all ${
                          newPresetCustomHex === hex ? "ring-2 ring-offset-1 ring-black/20 dark:ring-white/20 scale-110" : "hover:scale-110"
                        }`}
                        style={{ background: hex }}
                      />
                    ))}
                  </div>
                  {savedColors.length > 0 && (
                    <>
                      <p className="text-[9px] text-black/35 dark:text-white/35 uppercase tracking-wider">My colors</p>
                      <div className="flex flex-wrap gap-1.5">
                        {savedColors.map((hex, i) => (
                          <button
                            key={i}
                            type="button"
                            onClick={() => setNewPresetCustomHex(hex)}
                            className={`w-5 h-5 rounded-full transition-all ${
                              newPresetCustomHex === hex ? "ring-2 ring-offset-1 ring-black/20 dark:ring-white/20 scale-110" : "hover:scale-110"
                            }`}
                            style={{ background: hex }}
                          />
                        ))}
                      </div>
                    </>
                  )}
                  <div className="flex items-center gap-1.5">
                    <input
                      type="color"
                      value={newPresetCustomHex || PRESET_COLOR_OPTIONS[newPresetColorIdx]?.border?.replace(/rgba\((\d+),(\d+),(\d+).*/, (_, r, g, b) => `#${[r,g,b].map(v => Number(v).toString(16).padStart(2,"0")).join("")}`) || "#3b82f6"}
                      onChange={(e) => setNewPresetCustomHex(e.target.value)}
                      className="w-6 h-6 rounded-full cursor-pointer border-0 p-0 bg-transparent color-circle"
                    />
                    <span className="text-[9px] text-black/30 dark:text-white/30">Custom</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => { setCreatingPreset(false); setNewPresetName(""); setNewPresetCustomHex(null); }}
                      className="text-[0.625rem] font-medium px-2.5 py-1 rounded-full hover:bg-black/[0.06] dark:hover:bg-white/[0.08] text-black/50 dark:text-white/50 transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleCreatePreset}
                      disabled={!newPresetName.trim()}
                      className="text-[0.625rem] font-medium px-3 py-1 rounded-full glass-control hover:opacity-90 transition-all disabled:opacity-40"
                    >
                      Create
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setCreatingPreset(true)}
                  className="flex items-center gap-2.5 px-3 py-2 border-t border-black/[0.06] dark:border-white/[0.06] hover:bg-black/[0.03] dark:hover:bg-white/[0.04] transition-colors text-left w-full"
                >
                  <Plus className="w-3 h-3 text-black/40 dark:text-white/40" />
                  <span className="text-[0.6875rem] font-medium text-black/50 dark:text-white/50">
                    Create preset
                  </span>
                </button>
              )}
            </div>

            {/* Team members */}
            <div>
              {members.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {members.map((m) => (
                    <span
                      key={m}
                      className="inline-flex items-center gap-1 rounded-full bg-black/[0.06] dark:bg-white/[0.08] px-2 py-0.5 text-[0.625rem] text-black/65 dark:text-white/65"
                    >
                      {m}
                      <button
                        type="button"
                        onClick={() => removeMember(m)}
                        className="hover:text-red-500 transition-colors"
                      >
                        <X className="w-2.5 h-2.5" />
                      </button>
                    </span>
                  ))}
                </div>
              )}

              {showMemberInput ? (
                <div className="flex items-center gap-2">
                  <input
                    type="email"
                    value={memberInput}
                    onChange={(e) => setMemberInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addMember();
                      }
                    }}
                    placeholder="Enter email address"
                    className="flex-1 rounded-lg border border-black/10 dark:border-white/10 bg-white/20 dark:bg-white/5 px-2.5 py-1.5 text-[0.6875rem] text-black/70 dark:text-white/70 placeholder:text-black/35 dark:placeholder:text-white/35 outline-none"
                    autoFocus
                  />
                  <button
                    type="button"
                    onClick={addMember}
                    className="rounded-lg glass-control px-2.5 py-1.5 text-[0.6875rem] font-medium hover:opacity-90"
                  >
                    Add
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowMemberInput(true)}
                  className="flex items-center gap-1.5 text-[0.6875rem] text-black/50 dark:text-white/50 hover:text-black/70 dark:hover:text-white/70 transition-colors"
                >
                  <UserPlus className="w-3.5 h-3.5" />
                  Add team members
                </button>
              )}
            </div>

            {/* Link Team Spaces */}
            {availableTeamSpaces.length > 0 && (
              <div>
                {linkedTeamSpaces.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {linkedTeamSpaces.map((tsId) => {
                      const ts = availableTeamSpaces.find((t) => t.id === tsId);
                      if (!ts) return null;
                      return (
                        <span
                          key={tsId}
                          className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 px-2 py-0.5 text-[0.625rem] text-blue-700 dark:text-blue-300 font-medium"
                        >
                          <Users className="w-2.5 h-2.5" />
                          {ts.name}
                          <button
                            type="button"
                            onClick={() => setLinkedTeamSpaces((prev) => prev.filter((id) => id !== tsId))}
                            className="hover:text-red-500 transition-colors"
                          >
                            <X className="w-2.5 h-2.5" />
                          </button>
                        </span>
                      );
                    })}
                  </div>
                )}
                <div className="relative" ref={teamSpaceDropRef}>
                  <button
                    type="button"
                    onClick={() => setTeamSpaceDropdownOpen((v) => !v)}
                    className="flex items-center gap-1.5 text-[0.6875rem] text-black/50 dark:text-white/50 hover:text-black/70 dark:hover:text-white/70 transition-colors"
                  >
                    <Users className="w-3.5 h-3.5" />
                    Link Team Space
                    <ChevronDown className="w-3 h-3" />
                  </button>
                  {teamSpaceDropdownOpen && (
                    <div className="absolute left-0 top-full mt-1 z-50 w-56 rounded-xl border border-black/10 dark:border-white/10 bg-white/90 dark:bg-black/80 backdrop-blur-xl shadow-xl py-1 max-h-48 overflow-y-auto">
                      {availableTeamSpaces.filter((ts) => !linkedTeamSpaces.includes(ts.id)).length === 0 ? (
                        <div className="px-3 py-2 text-[0.6875rem] text-black/40 dark:text-white/40">All team spaces linked</div>
                      ) : (
                        availableTeamSpaces
                          .filter((ts) => !linkedTeamSpaces.includes(ts.id))
                          .map((ts) => (
                            <button
                              key={ts.id}
                              type="button"
                              onClick={() => {
                                setLinkedTeamSpaces((prev) => [...prev, ts.id]);
                                setTeamSpaceDropdownOpen(false);
                              }}
                              className="w-full text-left px-3 py-1.5 text-[0.6875rem] text-black/70 dark:text-white/70 hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors flex items-center gap-2"
                            >
                              <Users className="w-3 h-3 text-blue-500" />
                              {ts.name}
                            </button>
                          ))
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Report Section — past events only */}
            {eventIsPast && (
              <div className="mt-1 pt-3 border-t border-black/[0.06] dark:border-white/[0.06]">
                {!reportOpen ? (
                  <button
                    type="button"
                    onClick={() => setReportOpen(true)}
                    className="flex items-center gap-2 w-full text-left text-[0.6875rem] font-medium px-3 py-2 rounded-lg transition-all hover:bg-black/[0.04] dark:hover:bg-white/[0.04] text-black/60 dark:text-white/60"
                  >
                    <FileText className="w-3.5 h-3.5" />
                    {reportStatus ? (
                      <span className="flex items-center gap-1.5">
                        Report:
                        <span
                          className="inline-flex items-center gap-1 text-[0.625rem] font-semibold px-2 py-0.5 rounded-full"
                          style={{
                            color: REPORT_STATUSES.find((s) => s.id === reportStatus)?.color,
                            background: REPORT_STATUSES.find((s) => s.id === reportStatus)?.bg,
                          }}
                        >
                          {REPORT_STATUSES.find((s) => s.id === reportStatus)?.label}
                        </span>
                      </span>
                    ) : "Add Report"}
                  </button>
                ) : (
                  <div className="space-y-2.5">
                    <div className="flex items-center gap-1.5 mb-1">
                      <FileText className="w-3 h-3 text-black/40 dark:text-white/40" />
                      <span className="text-[0.625rem] font-semibold text-black/45 dark:text-white/45 uppercase tracking-wider">
                        Event Report
                      </span>
                    </div>
                    <div className="flex gap-1.5">
                      {REPORT_STATUSES.map((s) => {
                        const Icon = s.icon;
                        const active = reportStatus === s.id;
                        return (
                          <button
                            key={s.id}
                            type="button"
                            onClick={() => setReportStatus(active ? null : s.id)}
                            className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-[0.625rem] font-semibold transition-all border"
                            style={active ? {
                              color: s.color,
                              background: s.bg,
                              borderColor: s.border,
                            } : {
                              color: "rgba(0,0,0,0.4)",
                              background: "transparent",
                              borderColor: "rgba(0,0,0,0.06)",
                            }}
                          >
                            <Icon className="w-3.5 h-3.5" />
                            {s.label}
                          </button>
                        );
                      })}
                    </div>
                    <textarea
                      value={reportNote}
                      onChange={(e) => setReportNote(e.target.value)}
                      placeholder="Brief notes on this event..."
                      rows={2}
                      className="w-full text-[0.6875rem] px-3 py-2 rounded-lg bg-black/[0.03] dark:bg-white/[0.05] border border-black/[0.06] dark:border-white/[0.08] text-black/80 dark:text-white/80 placeholder:text-black/30 dark:placeholder:text-white/30 resize-none focus:outline-none focus:ring-1 focus:ring-black/10 dark:focus:ring-white/10"
                    />
                    <button
                      type="button"
                      onClick={() => setReportOpen(false)}
                      className="text-[0.625rem] text-black/40 dark:text-white/40 hover:text-black/60 dark:hover:text-white/60 transition-colors"
                    >
                      Collapse
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Actions */}
            <div className="flex items-center justify-between pt-1">
              <div className="flex items-center gap-1">
                {isEdit && !confirmDelete && (
                  <button
                    type="button"
                    onClick={handleDelete}
                    disabled={deleting}
                    className="flex items-center gap-1.5 text-[0.6875rem] font-medium px-3 py-1.5 rounded-full text-red-500/70 hover:text-red-600 hover:bg-red-500/10 transition-all"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Delete
                  </button>
                )}
                {isEdit && confirmDelete && !isSeries && (
                  <button
                    type="button"
                    onClick={() => handleDelete("single")}
                    disabled={deleting}
                    className="flex items-center gap-1.5 text-[0.6875rem] font-medium px-3 py-1.5 rounded-full bg-red-500/15 text-red-600 dark:text-red-400 hover:bg-red-500/25 transition-all"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    {deleting ? "Deleting..." : "Confirm Delete"}
                  </button>
                )}
                {isEdit && confirmDelete && isSeries && (
                  <div className="flex flex-col gap-1">
                    <span className="text-[0.625rem] text-red-500/70 font-medium px-1">Delete recurring event:</span>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => handleDelete("single")}
                        disabled={deleting}
                        className="text-[0.625rem] font-medium px-2.5 py-1 rounded-full bg-red-500/15 text-red-600 dark:text-red-400 hover:bg-red-500/25 transition-all"
                      >
                        This event
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete("future")}
                        disabled={deleting}
                        className="text-[0.625rem] font-medium px-2.5 py-1 rounded-full bg-red-500/15 text-red-600 dark:text-red-400 hover:bg-red-500/25 transition-all"
                      >
                        This &amp; future
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete("series")}
                        disabled={deleting}
                        className="text-[0.625rem] font-medium px-2.5 py-1 rounded-full bg-red-500/15 text-red-600 dark:text-red-400 hover:bg-red-500/25 transition-all"
                      >
                        All events
                      </button>
                    </div>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={isEdit && editing ? () => setEditing(false) : onClose}
                  className="text-[0.6875rem] font-medium px-3 py-1.5 rounded-full hover:bg-black/[0.06] dark:hover:bg-white/[0.08] text-black/50 dark:text-white/50 transition-colors"
                >
                  Cancel
                </button>
                {isEdit && isSeries ? (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      disabled={!title.trim() || saving}
                      onClick={(e) => handleSubmit(e, "single")}
                      className="text-[0.625rem] font-medium px-3 py-1.5 rounded-full glass-control hover:opacity-90 transition-all disabled:opacity-40"
                    >
                      {saving ? "Saving..." : "This event"}
                    </button>
                    <button
                      type="button"
                      disabled={!title.trim() || saving}
                      onClick={(e) => handleSubmit(e, "series")}
                      className="text-[0.625rem] font-medium px-3 py-1.5 rounded-full glass-control hover:opacity-90 transition-all disabled:opacity-40"
                    >
                      All in series
                    </button>
                  </div>
                ) : (
                  <button
                    type="submit"
                    disabled={!title.trim() || saving}
                    className="text-[0.6875rem] font-medium px-4 py-1.5 rounded-full glass-control hover:opacity-90 transition-all disabled:opacity-40"
                  >
                    {saving ? "Saving..." : isEdit ? "Save Changes" : "Create Event"}
                  </button>
                )}
              </div>
            </div>
          </form>
        ) : (
          /* Read-only detail view */
          <div>
            <div className="flex items-center gap-3 mb-3">
              <div className="flex items-center gap-1.5">
                <Clock className="w-3 h-3 text-black/40 dark:text-white/40" />
                <span className="text-[0.6875rem] text-black/50 dark:text-white/50">
                  {formatTime(event.start_hour)} — {formatTime(event.end_hour ?? event.start_hour + 1)}
                </span>
              </div>
              {event.preset_id && event.preset_id !== "custom" && (
                <span
                  className="text-[9px] font-semibold px-2 py-0.5 rounded-full"
                  style={{ color: activePreset.color, background: activePreset.bg }}
                >
                  {activePreset.label}
                </span>
              )}
            </div>

            {event.recurrence && event.recurrence !== "none" && (
              <div className="flex items-center gap-1.5 mb-3">
                <RefreshCw className="w-3 h-3 text-blue-500/60" />
                <span className="text-[0.6875rem] text-blue-600/70 dark:text-blue-400/70 font-medium">
                  {{ daily: "Repeats daily", weekdays: "Repeats every weekday", weekly: "Repeats weekly", biweekly: "Repeats every 2 weeks", monthly: "Repeats monthly" }[event.recurrence] || "Repeating"}
                </span>
              </div>
            )}

            {event.description && (
              <div className="mb-3">
                <p className="text-[0.75rem] text-black/60 dark:text-white/60 leading-relaxed">
                  {event.description}
                </p>
              </div>
            )}

            {event.members?.length > 0 && (
              <div className="mb-3">
                <div className="flex items-center gap-1.5 mb-2">
                  <Users className="w-3 h-3 text-black/40 dark:text-white/40" />
                  <span className="text-[0.625rem] font-semibold text-black/45 dark:text-white/45 uppercase tracking-wider">
                    Team Members
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {event.members.map((m, i) => (
                    <span
                      key={i}
                      className="inline-flex items-center gap-1.5 rounded-full bg-black/[0.06] dark:bg-white/[0.08] px-2.5 py-1 text-[0.625rem] text-black/65 dark:text-white/65"
                    >
                      <div className="w-4 h-4 rounded-full bg-black/10 dark:bg-white/10 text-[8px] font-bold flex items-center justify-center">
                        {m.charAt(0).toUpperCase()}
                      </div>
                      {m}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {event.team_space_ids?.length > 0 && (
              <div className="mb-3">
                <div className="flex items-center gap-1.5 mb-2">
                  <Users className="w-3 h-3 text-blue-500/60" />
                  <span className="text-[0.625rem] font-semibold text-black/45 dark:text-white/45 uppercase tracking-wider">
                    Team Spaces
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {event.team_space_ids.map((tsId) => {
                    const ts = availableTeamSpaces.find((t) => t.id === tsId);
                    return (
                      <span
                        key={tsId}
                        className="inline-flex items-center gap-1.5 rounded-full bg-blue-500/10 px-2.5 py-1 text-[0.625rem] text-blue-700 dark:text-blue-300 font-medium"
                      >
                        <Users className="w-3 h-3" />
                        {ts?.name || "Unknown"}
                      </span>
                    );
                  })}
                </div>
              </div>
            )}

            {event.report_status && (() => {
              const rs = REPORT_STATUSES.find((s) => s.id === event.report_status);
              if (!rs) return null;
              const Icon = rs.icon;
              return (
                <div className="mb-3 p-2.5 rounded-lg" style={{ background: rs.bg, border: `1px solid ${rs.border}` }}>
                  <div className="flex items-center gap-1.5 mb-1">
                    <Icon className="w-3.5 h-3.5" style={{ color: rs.color }} />
                    <span className="text-[0.6875rem] font-semibold" style={{ color: rs.color }}>{rs.label}</span>
                  </div>
                  {event.report_note && (
                    <p className="text-[0.6875rem] text-black/60 dark:text-white/60 leading-relaxed">{event.report_note}</p>
                  )}
                </div>
              );
            })()}

            <div className="flex items-center justify-between pt-2 border-t border-black/[0.06] dark:border-white/[0.06]">
              <div>
                {!confirmDelete && (
                  <button
                    type="button"
                    onClick={handleDelete}
                    disabled={deleting}
                    className="flex items-center gap-1.5 text-[0.6875rem] font-medium px-3 py-1.5 rounded-full text-red-500/70 hover:text-red-600 hover:bg-red-500/10 transition-all"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Delete
                  </button>
                )}
                {confirmDelete && !isSeries && (
                  <button
                    type="button"
                    onClick={() => handleDelete("single")}
                    disabled={deleting}
                    className="flex items-center gap-1.5 text-[0.6875rem] font-medium px-3 py-1.5 rounded-full bg-red-500/15 text-red-600 dark:text-red-400 hover:bg-red-500/25 transition-all"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    {deleting ? "Deleting..." : "Confirm Delete"}
                  </button>
                )}
                {confirmDelete && isSeries && (
                  <div className="flex flex-col gap-1">
                    <span className="text-[0.625rem] text-red-500/70 font-medium px-1">Delete recurring event:</span>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => handleDelete("single")}
                        disabled={deleting}
                        className="text-[0.625rem] font-medium px-2.5 py-1 rounded-full bg-red-500/15 text-red-600 dark:text-red-400 hover:bg-red-500/25 transition-all"
                      >
                        This event
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete("future")}
                        disabled={deleting}
                        className="text-[0.625rem] font-medium px-2.5 py-1 rounded-full bg-red-500/15 text-red-600 dark:text-red-400 hover:bg-red-500/25 transition-all"
                      >
                        This &amp; future
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete("series")}
                        disabled={deleting}
                        className="text-[0.625rem] font-medium px-2.5 py-1 rounded-full bg-red-500/15 text-red-600 dark:text-red-400 hover:bg-red-500/25 transition-all"
                      >
                        All events
                      </button>
                    </div>
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={onClose}
                className="text-[0.6875rem] font-medium px-3 py-1.5 rounded-full glass-control hover:opacity-90"
              >
                Close
              </button>
            </div>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}

function DayView({ selectedDate, onSelectDate, timezone, events, onSlotClick, onEventClick, draftEvent, onDraftChange, dayStatuses, customDayTypes, dayTypeColorOverrides, onMoveEvent, onResizeEvent }) {
  const today = useMemo(() => new Date(), []);
  const monthStrip = useMemo(() => buildMonthStrip(selectedDate), [selectedDate]);
  const scrollContainerRef = useRef(null);
  const activeRef = useRef(null);
  const didInitialScroll = useRef(false);
  const hourGridRef = useRef(null);
  const isToday = isSameDay(selectedDate, today);
  const dayEvents = useMemo(
    () => events.filter((e) => e.date_key === dateKey(selectedDate)),
    [events, selectedDate]
  );

  useEffect(() => {
    if (activeRef.current && scrollContainerRef.current) {
      const container = scrollContainerRef.current;
      const el = activeRef.current;
      const scrollTarget =
        el.offsetTop - container.clientHeight / 2 + el.offsetHeight / 2;
      if (!didInitialScroll.current) {
        container.scrollTop = scrollTarget;
        didInitialScroll.current = true;
      } else {
        container.scrollTo({ top: scrollTarget, behavior: "smooth" });
      }
    }
  }, [selectedDate]);

  return (
    <div className="flex flex-1 overflow-hidden gap-0">
      {/* Day strip sidebar */}
      <div className="w-[72px] shrink-0 border-r border-black/[0.06] dark:border-white/[0.06] flex flex-col">
        <div
          ref={scrollContainerRef}
          className="flex-1 overflow-y-auto scrollbar-hide px-1 py-2"
        >
          {monthStrip.map((group) => {
            const key = `${group.year}-${group.month}`;
            if (!group.expanded) {
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => onSelectDate(new Date(group.year, group.month, 1))}
                  className="w-full flex flex-col items-center py-2.5 my-0.5 rounded-lg hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors"
                >
                  <span className="text-[0.625rem] font-bold text-black/50 dark:text-white/50 uppercase tracking-wider">
                    {MONTHS_SHORT[group.month]}
                  </span>
                  <span className="text-[9px] text-black/30 dark:text-white/30">
                    {group.year}
                  </span>
                </button>
              );
            }
            return (
              <div key={key}>
                <div className="flex flex-col items-center py-2 mb-1">
                  <span className="text-[0.625rem] font-bold text-black/70 dark:text-white/70 uppercase tracking-wider">
                    {MONTHS_SHORT[group.month]} {group.year}
                  </span>
                </div>
                {group.days.map((d) => {
                  const active = isSameDay(d, selectedDate);
                  const isStripToday = isSameDay(d, today);
                  return (
                    <button
                      key={d.toISOString()}
                      type="button"
                      ref={active ? activeRef : undefined}
                      onClick={() => onSelectDate(new Date(d))}
                      className={`w-full flex flex-col items-center py-2 rounded-lg text-center transition-all mb-0.5 ${
                        active && isStripToday
                          ? "bg-blue-500/15 shadow-sm ring-1 ring-blue-500/20"
                          : active
                            ? "glass-control shadow-sm"
                            : "hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                      }`}
                    >
                      <span
                        className={`text-[9px] uppercase tracking-wider ${
                          isStripToday
                            ? "font-bold text-blue-600 dark:text-blue-400"
                            : active
                              ? "font-bold text-black/80 dark:text-white/80"
                              : "text-black/40 dark:text-white/40"
                        }`}
                      >
                        {WEEKDAYS_SHORT[d.getDay()]}
                      </span>
                      <span
                        className={`text-sm font-semibold leading-tight mt-0.5 ${
                          isStripToday
                            ? "text-blue-600 dark:text-blue-400"
                            : active
                              ? "text-black dark:text-white"
                              : "text-black/70 dark:text-white/70"
                        }`}
                      >
                        {d.getDate()}
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      {/* 30-min slot grid */}
      <div ref={hourGridRef} className="flex-1 overflow-y-auto scrollbar-hide" data-grid>
        <div
          className="relative transition-colors duration-300"
          style={{
            height: `${TOTAL_GRID_HEIGHT}px`,
            background: getDayStatus(dayStatuses || {}, dateKey(selectedDate), customDayTypes, dayTypeColorOverrides).hue || undefined,
          }}
        >
          {isToday && <NowIndicator timezone={timezone} />}
          {(() => {
            const layout = layoutOverlappingEvents(dayEvents);
            return dayEvents.map((evt, i) => {
              const info = layout.get(evt.id) || { colIndex: 0, colTotal: 1 };
              return (
                <EventBlock
                  key={evt.id || i}
                  event={evt}
                  index={i}
                  onClick={onEventClick}
                  onMove={onMoveEvent}
                  onResize={onResizeEvent}
                  colIndex={info.colIndex}
                  colTotal={info.colTotal}
                />
              );
            });
          })()}
          {draftEvent && draftEvent.date_key === dateKey(selectedDate) && (
            <DraftEventBlock
              draft={draftEvent}
              onDragEnd={(u) => onDraftChange?.(u)}
            />
          )}
          {TIME_OPTIONS.map((t) => {
            const isHour = t % 1 === 0;
            const label = formatTimeShort(t);
            return (
              <div
                key={t}
                className={`absolute left-0 right-0 flex ${
                  isHour
                    ? "border-b border-black/[0.06] dark:border-white/[0.06]"
                    : "border-b border-black/[0.025] dark:border-white/[0.025]"
                }`}
                style={{ top: `${t * 2 * SLOT_HEIGHT}px`, height: `${SLOT_HEIGHT}px` }}
              >
                <div className="w-16 shrink-0 pr-3 pt-0.5 text-right">
                  {label && (
                    <span className="text-[0.625rem] text-black/35 dark:text-white/35 font-medium">
                      {label}
                    </span>
                  )}
                </div>
                <div
                  className="flex-1 border-l border-black/[0.04] dark:border-white/[0.04] hover:bg-black/[0.03] dark:hover:bg-white/[0.03] transition-colors cursor-pointer group relative"
                  onClick={() => onSlotClick(t)}
                >
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Plus className="w-3 h-3 text-black/20 dark:text-white/20" />
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function MultiDayView({ selectedDate, onSelectDate, timezone, events, onSlotClick, onEventClick, mode, draftEvent, onDraftChange, dayStatuses, customDayTypes, dayTypeColorOverrides, onMoveEvent, onResizeEvent }) {
  const today = useMemo(() => new Date(), []);
  const days = useMemo(() => getDaysForRange(selectedDate, mode), [selectedDate, mode]);
  const hourGridRef = useRef(null);

  const dayEventsByKey = useMemo(() => {
    const map = {};
    for (const evt of events) {
      if (!map[evt.date_key]) map[evt.date_key] = [];
      map[evt.date_key].push(evt);
    }
    return map;
  }, [events]);

  return (
    <div className="flex flex-1 overflow-hidden">
      <div ref={hourGridRef} className="flex-1 overflow-y-auto scrollbar-hide">
        {/* Column headers */}
        <div className="sticky top-0 z-[6] border-b border-black/[0.06] dark:border-white/[0.06] bg-white/60 dark:bg-black/30 backdrop-blur-md flex">
          <div className="w-14 shrink-0" />
          {days.map((d) => {
            const isToday = isSameDay(d, today);
            const isSelected = isSameDay(d, selectedDate);
            return (
              <button
                key={d.toISOString()}
                type="button"
                onClick={() => onSelectDate(new Date(d))}
                className={`flex-1 py-2 text-center transition-colors ${
                  isSelected ? "bg-black/[0.03] dark:bg-white/[0.03]" : ""
                }`}
              >
                <div className="text-[9px] uppercase tracking-wider text-black/40 dark:text-white/40">
                  {WEEKDAYS_SHORT[d.getDay()]}
                </div>
                <div
                  className={`text-sm font-semibold mt-0.5 ${
                    isToday
                      ? "text-blue-600 dark:text-blue-400"
                      : isSelected
                        ? "text-black dark:text-white"
                        : "text-black/65 dark:text-white/65"
                  }`}
                >
                  {d.getDate()}
                </div>
              </button>
            );
          })}
        </div>

        {/* Time grid */}
        <div className="flex" style={{ height: `${TOTAL_GRID_HEIGHT}px` }}>
          {/* Time labels column */}
          <div className="w-14 shrink-0 relative">
            {TIME_OPTIONS.map((t) => {
              const label = formatTimeShort(t);
              if (!label) return null;
              return (
                <div
                  key={t}
                  className="absolute right-0 pr-2 pt-0.5 text-right"
                  style={{ top: `${t * 2 * SLOT_HEIGHT}px` }}
                >
                  <span className="text-[9px] text-black/30 dark:text-white/30 font-medium">
                    {label}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Day columns area */}
          <div className="flex-1 relative">
            {/* Row lines spanning all columns */}
            {TIME_OPTIONS.map((t) => {
              const isHour = t % 1 === 0;
              return (
                <div
                  key={t}
                  className={`absolute left-0 right-0 ${
                    isHour
                      ? "border-b border-black/[0.06] dark:border-white/[0.06]"
                      : "border-b border-black/[0.025] dark:border-white/[0.025]"
                  }`}
                  style={{ top: `${t * 2 * SLOT_HEIGHT}px`, height: `${SLOT_HEIGHT}px` }}
                >
                  <div className="flex h-full">
                    {days.map((d) => {
                      const cellHue = getDayStatus(dayStatuses || {}, dateKey(d), customDayTypes, dayTypeColorOverrides).hue;
                      return (
                      <div
                        key={d.toISOString()}
                        className="flex-1 border-l border-black/[0.04] dark:border-white/[0.04] hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors cursor-pointer relative group"
                        style={cellHue ? { background: cellHue } : undefined}
                        onClick={() => {
                          onSelectDate(new Date(d));
                          onSlotClick(t, d);
                        }}
                      >
                        <span className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity">
                          <Plus className="w-2.5 h-2.5 text-black/15 dark:text-white/15" />
                        </span>
                      </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            {/* Now indicator */}
            {days.map((d) => {
              if (!isSameDay(d, today)) return null;
              const colIndex = days.findIndex((dd) => isSameDay(dd, d));
              const colCount = days.length;
              const leftPct = (colIndex / colCount) * 100;
              const widthPct = 100 / colCount;
              return (
                <div
                  key="now"
                  className="absolute z-10 pointer-events-none"
                  style={{
                    left: `${leftPct}%`,
                    width: `${widthPct}%`,
                    top: `${(getTzMinutes(timezone) / 1440) * 100}%`,
                  }}
                >
                  <div className="flex items-center">
                    <div className="w-2 h-2 rounded-full bg-red-500 -ml-1 shrink-0" />
                    <div className="h-px flex-1 bg-red-500" />
                  </div>
                </div>
              );
            })}

            {/* Event blocks per column */}
            {days.map((d, colIdx) => {
              const dk = dateKey(d);
              const colEvents = dayEventsByKey[dk] || [];
              const colCount = days.length;
              const dayLeftPct = (colIdx / colCount) * 100;
              const dayWidthPct = 100 / colCount;
              const layout = layoutOverlappingEvents(colEvents);
              return colEvents.map((evt, i) => {
                const start = evt.start_hour ?? 0;
                const end = evt.end_hour ?? start + 1;
                const duration = end - start;
                const topPx = start * 2 * SLOT_HEIGHT + 1;
                const heightPx = Math.max(duration * 2 * SLOT_HEIGHT - 2, SLOT_HEIGHT - 2);
                const ec = eventColors(evt, i);
                const info = layout.get(evt.id) || { colIndex: 0, colTotal: 1 };
                const subLeft = `calc(${dayLeftPct}% + ${(info.colIndex / info.colTotal) * dayWidthPct}% + 2px)`;
                const subWidth = `calc(${dayWidthPct / info.colTotal}% - 4px)`;
                let didDragRef = { current: false };
                const handleMouseDown = (e) => {
                  if (!onMoveEvent) return;
                  e.stopPropagation();
                  const el = e.currentTarget;
                  const startX = e.clientX;
                  const startY = e.clientY;
                  const origStart = start;
                  const origColIdx = colIdx;
                  const parentRect = el.parentElement.getBoundingClientRect();
                  const colWidth = parentRect.width / colCount;
                  didDragRef.current = false;

                  const onMove = (ev) => {
                    const dy = ev.clientY - startY;
                    const dx = ev.clientX - startX;
                    if (Math.abs(dy) > 4 || Math.abs(dx) > 4) {
                      if (!didDragRef.current) {
                        el.style.opacity = "0.7";
                        el.style.zIndex = "20";
                        el.style.cursor = "grabbing";
                        el.style.width = `calc(${dayWidthPct}% - 4px)`;
                      }
                      didDragRef.current = true;
                    }
                    const dSlots = Math.round(dy / (SLOT_HEIGHT / 2));
                    const dCols = Math.round(dx / colWidth);
                    const newStart = Math.max(0, Math.min(origStart + dSlots * 0.25, 24 - duration));
                    const newCol = Math.max(0, Math.min(origColIdx + dCols, colCount - 1));
                    const newTop = newStart * 2 * SLOT_HEIGHT + 1;
                    const newLeftPct = (newCol / colCount) * 100;
                    el.style.top = `${newTop}px`;
                    el.style.left = `calc(${newLeftPct}% + 2px)`;
                  };

                  const onUp = (ev) => {
                    document.removeEventListener("mousemove", onMove);
                    document.removeEventListener("mouseup", onUp);
                    el.style.opacity = "";
                    el.style.zIndex = "";
                    el.style.cursor = "";
                    el.style.width = subWidth;
                    el.style.top = `${topPx}px`;
                    el.style.left = subLeft;
                    if (didDragRef.current) {
                      const dy = ev.clientY - startY;
                      const dx = ev.clientX - startX;
                      const dSlots = Math.round(dy / (SLOT_HEIGHT / 2));
                      const dCols = Math.round(dx / colWidth);
                      const newStart = Math.max(0, Math.min(origStart + dSlots * 0.25, 24 - duration));
                      const newCol = Math.max(0, Math.min(origColIdx + dCols, colCount - 1));
                      const newDk = dateKey(days[newCol]);
                      if (newStart !== origStart || newDk !== dk) {
                        onMoveEvent(evt.id, newStart, newDk);
                      } else {
                        el.style.top = `${topPx}px`;
                        el.style.left = subLeft;
                      }
                    }
                  };
                  document.addEventListener("mousemove", onMove);
                  document.addEventListener("mouseup", onUp);
                };
                const handleResizeDown = (re) => {
                  re.preventDefault();
                  re.stopPropagation();
                  const rStartY = re.clientY;
                  const origEnd = end;
                  didDragRef.current = true;
                  const parentEl = re.target.closest("[data-multi-event]");

                  const onRM = (rv) => {
                    const rdy = rv.clientY - rStartY;
                    const rSlots = Math.round(rdy / (SLOT_HEIGHT / 2));
                    const newEnd = Math.min(Math.max(origEnd + rSlots * 0.25, start + 0.25), 24);
                    if (parentEl) {
                      const nh = Math.max((newEnd - start) * 2 * SLOT_HEIGHT - 2, SLOT_HEIGHT - 2);
                      parentEl.style.height = `${nh}px`;
                    }
                  };
                  const onRU = (rv) => {
                    document.removeEventListener("mousemove", onRM);
                    document.removeEventListener("mouseup", onRU);
                    const rdy = rv.clientY - rStartY;
                    const rSlots = Math.round(rdy / (SLOT_HEIGHT / 2));
                    const newEnd = Math.min(Math.max(origEnd + rSlots * 0.25, start + 0.25), 24);
                    if (newEnd !== origEnd && onResizeEvent) {
                      onResizeEvent(evt.id, newEnd);
                    } else if (parentEl) {
                      parentEl.style.height = `${heightPx}px`;
                    }
                  };
                  document.addEventListener("mousemove", onRM);
                  document.addEventListener("mouseup", onRU);
                };

                return (
                  <div
                    key={evt.id || `${colIdx}-${i}`}
                    data-multi-event
                    className="absolute rounded-md px-1.5 py-0.5 overflow-visible cursor-grab hover:opacity-80 transition-shadow z-[5]"
                    style={{
                      left: subLeft,
                      width: subWidth,
                      top: `${topPx}px`,
                      height: `${heightPx}px`,
                      background: ec.bg,
                      borderLeft: `2px solid ${ec.border}`,
                    }}
                    onMouseDown={handleMouseDown}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!didDragRef.current) onEventClick(evt);
                    }}
                  >
                    <div className="flex items-center gap-0.5">
                      <div className="text-[0.625rem] font-semibold text-black/80 dark:text-white/80 truncate flex-1 min-w-0">
                        {displayTitle(evt)}
                      </div>
                      {evt.report_status && (() => {
                        const rs = REPORT_STATUSES.find((s) => s.id === evt.report_status);
                        if (!rs) return null;
                        const Icon = rs.icon;
                        return <Icon className="w-2.5 h-2.5 shrink-0" style={{ color: rs.color }} />;
                      })()}
                    </div>
                    {heightPx > 28 && (
                      <div className="text-[9px] text-black/45 dark:text-white/45 truncate">
                        {formatTime(start)} – {formatTime(end)}
                      </div>
                    )}
                    <div
                      onMouseDown={handleResizeDown}
                      className="absolute left-0 right-0 bottom-0 h-3 cursor-s-resize flex items-center justify-center"
                    >
                      <div className="w-6 h-0.5 rounded-full" style={{ background: ec.border, opacity: 0.6 }} />
                    </div>
                  </div>
                );
              });
            })}

            {/* Draft event ghost in multi-day */}
            {draftEvent && (() => {
              const colIdx = days.findIndex((d) => dateKey(d) === draftEvent.date_key);
              if (colIdx < 0) return null;
              const colCount = days.length;
              const leftPct = (colIdx / colCount) * 100;
              const widthPct = 100 / colCount;
              const dStart = draftEvent.start_hour ?? 0;
              const dEnd = draftEvent.end_hour ?? dStart + 0.5;
              const dDuration = dEnd - dStart;
              const dTopPx = dStart * 2 * SLOT_HEIGHT + 1;
              const dHeightPx = Math.max(dDuration * 2 * SLOT_HEIGHT - 2, SLOT_HEIGHT - 2);
              const border = draftEvent.preset?.border || "rgba(59,130,246,0.55)";
              const bg = draftEvent.preset?.bg || "rgba(59,130,246,0.08)";
              return (
                <div
                  className="absolute rounded-md overflow-visible z-[4] pointer-events-none"
                  style={{
                    left: `calc(${leftPct}% + 2px)`,
                    width: `calc(${widthPct}% - 4px)`,
                    top: `${dTopPx}px`,
                    height: `${dHeightPx}px`,
                    background: bg,
                    border: `2px dashed ${border}`,
                  }}
                >
                  <div className="px-1.5 py-0.5">
                    <div className="text-[9px] font-medium text-black/40 dark:text-white/40 truncate">
                      {draftEvent.preset?.label || "New Event"}
                    </div>
                  </div>
                  <div
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const startY = e.clientY;
                      const startEnd = dEnd;
                      const onMove = (ev) => {
                        const dy = ev.clientY - startY;
                        const dSlots = Math.round(dy / (SLOT_HEIGHT / 2));
                        const newEnd = Math.min(Math.max(startEnd + dSlots * 0.25, dStart + 0.25), 24);
                        onDraftChange?.({ end_hour: newEnd });
                      };
                      const onUp = () => {
                        document.removeEventListener("mousemove", onMove);
                        document.removeEventListener("mouseup", onUp);
                      };
                      document.addEventListener("mousemove", onMove);
                      document.addEventListener("mouseup", onUp);
                    }}
                    className="absolute left-0 right-0 bottom-0 h-3 cursor-s-resize pointer-events-auto flex items-center justify-center"
                  >
                    <div className="w-6 h-0.5 rounded-full" style={{ background: border }} />
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      </div>
    </div>
  );
}

function MonthView({ selectedDate, onSelectDate, events, onEventClick, dayStatuses, customDayTypes, dayTypeColorOverrides }) {
  const today = useMemo(() => new Date(), []);
  const [viewYear, setViewYear] = useState(selectedDate.getFullYear());
  const [viewMonth, setViewMonth] = useState(selectedDate.getMonth());
  const grid = useMemo(() => getMonthGrid(viewYear, viewMonth), [viewYear, viewMonth]);

  const eventsByKey = useMemo(() => {
    const map = {};
    for (const evt of events) {
      if (!map[evt.date_key]) map[evt.date_key] = [];
      map[evt.date_key].push(evt);
    }
    return map;
  }, [events]);

  const prevMonth = () => {
    if (viewMonth === 0) {
      setViewYear((y) => y - 1);
      setViewMonth(11);
    } else {
      setViewMonth((m) => m - 1);
    }
  };

  const nextMonth = () => {
    if (viewMonth === 11) {
      setViewYear((y) => y + 1);
      setViewMonth(0);
    } else {
      setViewMonth((m) => m + 1);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto scrollbar-hide p-6">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <button
            type="button"
            onClick={prevMonth}
            className="rounded-full w-8 h-8 glass-control hover:opacity-90 flex items-center justify-center"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <h2 className="text-lg font-semibold text-black/80 dark:text-white/80">
            {MONTHS[viewMonth]} {viewYear}
          </h2>
          <button
            type="button"
            onClick={nextMonth}
            className="rounded-full w-8 h-8 glass-control hover:opacity-90 flex items-center justify-center"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        <div className="grid grid-cols-7 mb-1">
          {WEEKDAYS_SHORT.map((wd) => (
            <div
              key={wd}
              className="text-center text-[0.625rem] font-semibold text-black/40 dark:text-white/40 uppercase tracking-wider py-2"
            >
              {wd}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-7 gap-px">
          {grid.map((cell, i) => {
            const cellDate = cell.current
              ? new Date(viewYear, viewMonth, cell.day)
              : null;
            const isSelected =
              cellDate && isSameDay(cellDate, selectedDate);
            const isCellToday =
              cellDate && isSameDay(cellDate, today);
            const dk = cellDate ? dateKey(cellDate) : null;
            const cellEvents = dk ? (eventsByKey[dk] || []) : [];
            const cellStatusHue = dk ? getDayStatus(dayStatuses || {}, dk, customDayTypes, dayTypeColorOverrides).hue : null;

            return (
              <div
                key={i}
                onClick={() => {
                  if (cellDate) onSelectDate(cellDate);
                }}
                className={`relative min-h-[80px] flex flex-col items-stretch p-1.5 rounded-xl transition-all ${
                  !cell.current
                    ? "text-black/15 dark:text-white/15 cursor-default"
                    : isSelected
                      ? "glass-control shadow-sm"
                      : "hover:bg-black/[0.04] dark:hover:bg-white/[0.06] cursor-pointer"
                }`}
                style={cellStatusHue ? { background: cellStatusHue } : undefined}
              >
                <span
                  className={`text-[0.75rem] font-medium text-center ${
                    isSelected
                      ? "text-black dark:text-white font-bold"
                      : isCellToday
                        ? "text-blue-600 dark:text-blue-400 font-bold"
                        : cell.current
                          ? "text-black/70 dark:text-white/70"
                          : ""
                  }`}
                >
                  {cell.day}
                </span>
                {isCellToday && !isSelected && (
                  <div className="w-1 h-1 rounded-full bg-blue-500 mx-auto" />
                )}
                {cell.current && cellEvents.length > 0 && (
                  <div className="mt-1 flex flex-col gap-0.5 overflow-hidden">
                    {cellEvents.slice(0, 3).map((evt, ei) => {
                      const ec = eventColors(evt, ei);
                      return (
                        <button
                          key={evt.id || ei}
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onEventClick(evt);
                          }}
                          className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-black/[0.04] dark:hover:bg-white/[0.04] transition-colors text-left"
                        >
                          <div
                            className="w-1.5 h-1.5 rounded-full shrink-0"
                            style={{ background: ec.border }}
                          />
                          <span className="text-[9px] text-black/65 dark:text-white/65 truncate leading-tight">
                            {displayTitle(evt)}
                          </span>
                        </button>
                      );
                    })}
                    {cellEvents.length > 3 && (
                      <span className="text-[8px] text-black/40 dark:text-white/40 px-1">
                        +{cellEvents.length - 3} more
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const EVENTS_STORAGE_KEY = "lykinsai_calendar_events";
const GOOGLE_CALENDAR_CONNECTED_KEY = "lykinsai_google_calendar_connected";
const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

function loadGoogleConnectedFlag() {
  try {
    return localStorage.getItem(GOOGLE_CALENDAR_CONNECTED_KEY) === "1";
  } catch {
    return false;
  }
}

function saveGoogleConnectedFlag(value) {
  try {
    localStorage.setItem(GOOGLE_CALENDAR_CONNECTED_KEY, value ? "1" : "0");
  } catch {}
}

function loadLocalEvents() {
  try {
    const raw = localStorage.getItem(EVENTS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveLocalEvents(events) {
  try {
    localStorage.setItem(EVENTS_STORAGE_KEY, JSON.stringify(events));
  } catch {}
}

export default function CalendarPage() {
  const { user } = useAuth();
  const showGoogleCalendarConnect = false;
  const googleClientId = String(import.meta.env.VITE_GOOGLE_CALENDAR_CLIENT_ID || "").trim();
  const [topPanelOpen, setTopPanelOpen] = useState(false);
  const [showQuickNote, setShowQuickNote] = useState(false);
  const [quickNoteTitle, setQuickNoteTitle] = useState("");
  const [quickNoteContent, setQuickNoteContent] = useState("");
  const [isQuickNoteSaving, setIsQuickNoteSaving] = useState(false);
  const [tzDropdownOpen, setTzDropdownOpen] = useState(false);
  const [viewDropdownOpen, setViewDropdownOpen] = useState(false);
  const [dayStatusOpen, setDayStatusOpen] = useState(false);
  const [dayStatuses, setDayStatuses] = useState(() => loadDayStatuses());
  const [customDayTypes, setCustomDayTypes] = useState(() => loadCustomDayTypes());
  const [dayTypeColorOverrides, setDayTypeColorOverrides] = useState(() => loadDayTypeColorOverrides());
  const [dayTypeColorPickerFor, setDayTypeColorPickerFor] = useState(null);
  const [creatingDayType, setCreatingDayType] = useState(false);
  const [newDayTypeName, setNewDayTypeName] = useState("");
  const [newDayTypeColorIdx, setNewDayTypeColorIdx] = useState(0);
  const dayTypeColorInputRef = useRef(null);
  const [dayTypeSavedColors] = useState(() => loadCustomColors());
  const newDayTypeInputRef = useRef(null);
  const tzRef = useRef(null);
  const viewRef = useRef(null);
  const dayStatusRef = useRef(null);

  const [viewMode, setViewMode] = useState("day");
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const [timezone, setTimezone] = useState(() => {
    try {
      const saved = localStorage.getItem("lykinsai_calendar_tz");
      if (saved) return saved;
    } catch {}
    return getLocalTimezone();
  });

  const [events, setEvents] = useState(() => loadLocalEvents());
  const [modalState, setModalState] = useState(null);

  useEffect(() => {
    if (!user?.id) return;
    let active = true;
    (async () => {
      try {
        const { data } = await supabase
          .from("calendar_events")
          .select("*")
          .eq("user_id", user.id)
          .order("created_at", { ascending: false });
        if (active && data) {
          setEvents(data);
          saveLocalEvents(data);
        }
      } catch {
        // fall back to local storage
      }
    })();
    return () => { active = false; };
  }, [user?.id]);

  useEffect(() => {
    try {
      localStorage.setItem("lykinsai_calendar_tz", timezone);
    } catch {}
  }, [timezone]);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setSelectedDate((prev) => {
          const d = new Date(prev);
          d.setDate(d.getDate() - 1);
          return d;
        });
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setSelectedDate((prev) => {
          const d = new Date(prev);
          d.setDate(d.getDate() + 1);
          return d;
        });
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    if (!tzDropdownOpen) return;
    const handleClickOutside = (e) => {
      if (tzRef.current && !tzRef.current.contains(e.target)) {
        setTzDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [tzDropdownOpen]);

  useEffect(() => {
    if (!viewDropdownOpen) return;
    const handleClickOutside = (e) => {
      if (viewRef.current && !viewRef.current.contains(e.target)) {
        setViewDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [viewDropdownOpen]);

  useEffect(() => {
    if (!dayStatusOpen) {
      setCreatingDayType(false);
      setNewDayTypeName("");
      setDayTypeColorPickerFor(null);
      return;
    }
    const handleClickOutside = (e) => {
      if (dayStatusRef.current && !dayStatusRef.current.contains(e.target)) {
        setDayStatusOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [dayStatusOpen]);

  const currentDayStatus = useMemo(
    () => getDayStatus(dayStatuses, dateKey(selectedDate), customDayTypes, dayTypeColorOverrides),
    [dayStatuses, selectedDate, customDayTypes, dayTypeColorOverrides]
  );

  const handleSetDayStatus = (statusId) => {
    const dk = dateKey(selectedDate);
    setDayStatuses((prev) => {
      const next = { ...prev };
      if (statusId === "normal") delete next[dk];
      else next[dk] = statusId;
      saveDayStatuses(next);
      return next;
    });
    if (statusId === "normal") {
      setDayTypeColorPickerFor(null);
      setDayStatusOpen(false);
    } else {
      setDayTypeColorPickerFor(statusId);
    }
  };

  const handleSetDayTypeColor = (statusId, hex) => {
    setDayTypeColorOverrides((prev) => {
      const next = { ...prev, [statusId]: hex };
      saveDayTypeColorOverrides(next);
      return next;
    });
  };

  const handleClearDayTypeColor = (statusId) => {
    setDayTypeColorOverrides((prev) => {
      const next = { ...prev };
      delete next[statusId];
      saveDayTypeColorOverrides(next);
      return next;
    });
  };

  const tzLabel = useMemo(() => {
    const match = COMMON_TIMEZONES.find((t) => t.value === timezone);
    return match ? match.label : timezone.split("/").pop().replace(/_/g, " ");
  }, [timezone]);

  const handleSaveQuickNote = async () => {
    if (!user?.id || isQuickNoteSaving) return;
    const content = quickNoteContent.trim();
    if (!content) return;

    setIsQuickNoteSaving(true);
    try {
      await supabase.from("notes").insert({
        user_id: user.id,
        title: "Quick Note",
        content,
      });
      setQuickNoteContent("");
      setShowQuickNote(false);
    } catch {
      // keep card open on failure
    } finally {
      setIsQuickNoteSaving(false);
    }
  };

  const generateRecurringDates = (baseDateKey, recurrenceType, count = 26) => {
    const [y, m, d] = baseDateKey.split("-").map(Number);
    const base = new Date(y, m - 1, d);
    const dates = [];
    for (let i = 1; i <= count; i++) {
      const next = new Date(base);
      if (recurrenceType === "daily") {
        next.setDate(base.getDate() + i);
      } else if (recurrenceType === "weekdays") {
        let added = 0, offset = 0;
        while (added < i) {
          offset++;
          const candidate = new Date(base);
          candidate.setDate(base.getDate() + offset);
          const dow = candidate.getDay();
          if (dow >= 1 && dow <= 5) added++;
        }
        next.setDate(base.getDate() + offset);
      } else if (recurrenceType === "weekly") {
        next.setDate(base.getDate() + i * 7);
      } else if (recurrenceType === "biweekly") {
        next.setDate(base.getDate() + i * 14);
      } else if (recurrenceType === "monthly") {
        next.setMonth(base.getMonth() + i);
      } else {
        break;
      }
      dates.push(`${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`);
    }
    return dates;
  };

  const handleSaveEvent = async (eventData) => {
    const isEdit = !!eventData.id;
    setDraftEvent(null);

    if (isEdit) {
      const seriesFields = {
        title: eventData.title,
        description: eventData.description,
        start_hour: eventData.start_hour,
        end_hour: eventData.end_hour,
        members: eventData.members,
        preset_id: eventData.preset_id,
        reminder: eventData.reminder,
        custom_color: eventData.custom_color,
        report_status: eventData.report_status ?? null,
        report_note: eventData.report_note ?? null,
        team_space_ids: eventData.team_space_ids ?? [],
        recurrence: eventData.recurrence ?? "none",
      };

      const isSeriesUpdate = eventData.save_mode === "series" && eventData.series_id;
      const oldEvent = events.find((e) => e.id === eventData.id);
      const oldRecurrence = oldEvent?.recurrence ?? "none";
      const newRecurrence = eventData.recurrence ?? "none";
      const recurrenceChanged = oldRecurrence !== newRecurrence;

      if (recurrenceChanged) {
        const oldSeriesId = oldEvent?.series_id;
        const newSeriesId = newRecurrence !== "none" ? crypto.randomUUID() : null;

        const recurrenceCount = newRecurrence === "daily" ? 30
          : newRecurrence === "weekdays" ? 26
          : newRecurrence === "weekly" ? 12
          : newRecurrence === "biweekly" ? 12
          : newRecurrence === "monthly" ? 6
          : 0;
        const futureDates = recurrenceCount > 0
          ? generateRecurringDates(eventData.date_key, newRecurrence, recurrenceCount)
          : [];

        const updatedBase = {
          ...oldEvent,
          ...eventData,
          ...seriesFields,
          series_id: newSeriesId,
        };

        const newInstances = futureDates.map((dk) => ({
          ...updatedBase,
          id: crypto.randomUUID(),
          date_key: dk,
          created_at: new Date().toISOString(),
        }));

        setEvents((prev) => {
          let next = oldSeriesId
            ? prev.filter((e) => e.series_id !== oldSeriesId)
            : prev.filter((e) => e.id !== eventData.id);
          next = [updatedBase, ...newInstances, ...next];
          saveLocalEvents(next);
          return next;
        });
        setModalState(null);
        window.dispatchEvent(new CustomEvent("calendar_events_changed"));

        if (user?.id) {
          try {
            if (oldSeriesId) {
              const { data: oldSeries } = await supabase
                .from("calendar_events")
                .select("id")
                .eq("user_id", user.id)
                .eq("series_id", oldSeriesId);
              if (oldSeries) {
                for (const se of oldSeries) {
                  await supabase.from("calendar_events").delete().eq("id", se.id).eq("user_id", user.id);
                }
              }
            } else {
              await supabase.from("calendar_events").delete().eq("id", eventData.id).eq("user_id", user.id);
            }

            const toInsert = [updatedBase, ...newInstances];
            for (const evt of toInsert) {
              await supabase.from("calendar_events").insert({
                id: evt.id,
                user_id: user.id,
                title: evt.title,
                description: evt.description,
                date_key: evt.date_key,
                start_hour: evt.start_hour,
                end_hour: evt.end_hour,
                members: evt.members,
                preset_id: evt.preset_id,
                reminder: evt.reminder,
                report_status: evt.report_status ?? null,
                report_note: evt.report_note ?? null,
                team_space_ids: evt.team_space_ids ?? [],
                recurrence: evt.recurrence ?? "none",
                series_id: evt.series_id ?? null,
              });
            }
          } catch {}
        }
      } else {
        setEvents((prev) => {
          const next = prev.map((e) => {
            if (isSeriesUpdate && e.series_id === eventData.series_id) {
              return { ...e, ...seriesFields };
            }
            if (e.id === eventData.id) {
              return { ...e, ...eventData };
            }
            return e;
          });
          saveLocalEvents(next);
          return next;
        });
        setModalState(null);

        window.dispatchEvent(new CustomEvent("calendar_events_changed"));

        if (user?.id) {
          try {
            if (isSeriesUpdate) {
              const { data: seriesEvents } = await supabase
                .from("calendar_events")
                .select("id")
                .eq("user_id", user.id)
                .eq("series_id", eventData.series_id);
              if (seriesEvents) {
                for (const se of seriesEvents) {
                  await supabase.from("calendar_events").update(seriesFields).eq("id", se.id).eq("user_id", user.id);
                }
              }
            } else {
              await supabase
                .from("calendar_events")
                .update(seriesFields)
                .eq("id", eventData.id)
                .eq("user_id", user.id);
            }
          } catch {}
        }
      }
    } else {
      const seriesId = crypto.randomUUID();
      const baseEvent = {
        ...eventData,
        id: crypto.randomUUID(),
        user_id: user?.id || "local",
        created_at: new Date().toISOString(),
      };

      const allNewEvents = [baseEvent];

      if (eventData.recurrence && eventData.recurrence !== "none") {
        baseEvent.series_id = seriesId;
        const futureDates = generateRecurringDates(
          eventData.date_key,
          eventData.recurrence,
          eventData.recurrence === "daily" ? 30
            : eventData.recurrence === "weekdays" ? 26
            : eventData.recurrence === "weekly" ? 12
            : eventData.recurrence === "biweekly" ? 12
            : 6
        );
        for (const dk of futureDates) {
          allNewEvents.push({
            ...eventData,
            id: crypto.randomUUID(),
            user_id: user?.id || "local",
            created_at: new Date().toISOString(),
            date_key: dk,
            series_id: seriesId,
          });
        }
      }

      setEvents((prev) => {
        const next = [...allNewEvents, ...prev];
        saveLocalEvents(next);
        return next;
      });
      setModalState(null);
      window.dispatchEvent(new CustomEvent("calendar_events_changed"));

      if (user?.id) {
        try {
          for (const evt of allNewEvents) {
            await supabase.from("calendar_events").insert({
              id: evt.id,
              user_id: user.id,
              title: evt.title,
              description: evt.description,
              date_key: evt.date_key,
              start_hour: evt.start_hour,
              end_hour: evt.end_hour,
              members: evt.members,
              preset_id: evt.preset_id,
              reminder: evt.reminder,
              report_status: evt.report_status ?? null,
              report_note: evt.report_note ?? null,
              team_space_ids: evt.team_space_ids ?? [],
              recurrence: evt.recurrence ?? "none",
              series_id: evt.series_id ?? null,
            });
          }
        } catch {}
      }
    }
  };

  const handleDeleteEvent = async (eventId, deleteMode = "single") => {
    const targetEvent = events.find((e) => e.id === eventId);
    const seriesId = targetEvent?.series_id;

    if (deleteMode === "series" && seriesId) {
      setEvents((prev) => {
        const next = prev.filter((e) => e.series_id !== seriesId);
        saveLocalEvents(next);
        return next;
      });
      setModalState(null);
      window.dispatchEvent(new CustomEvent("calendar_events_changed"));

      if (user?.id) {
        try {
          const { data: seriesEvents } = await supabase
            .from("calendar_events")
            .select("id")
            .eq("user_id", user.id)
            .eq("series_id", seriesId);
          if (seriesEvents) {
            for (const se of seriesEvents) {
              await supabase.from("calendar_events").delete().eq("id", se.id).eq("user_id", user.id);
            }
          }
        } catch {}
      }
    } else if (deleteMode === "future" && seriesId && targetEvent) {
      setEvents((prev) => {
        const next = prev.filter((e) => !(e.series_id === seriesId && e.date_key >= targetEvent.date_key));
        saveLocalEvents(next);
        return next;
      });
      setModalState(null);
      window.dispatchEvent(new CustomEvent("calendar_events_changed"));

      if (user?.id) {
        try {
          const { data: seriesEvents } = await supabase
            .from("calendar_events")
            .select("id, date_key")
            .eq("user_id", user.id)
            .eq("series_id", seriesId);
          if (seriesEvents) {
            for (const se of seriesEvents) {
              if (se.date_key >= targetEvent.date_key) {
                await supabase.from("calendar_events").delete().eq("id", se.id).eq("user_id", user.id);
              }
            }
          }
        } catch {}
      }
    } else {
      setEvents((prev) => {
        const next = prev.filter((e) => e.id !== eventId);
        saveLocalEvents(next);
        return next;
      });
      setModalState(null);
      window.dispatchEvent(new CustomEvent("calendar_events_changed"));

      if (user?.id) {
        try {
          await supabase
            .from("calendar_events")
            .delete()
            .eq("id", eventId)
            .eq("user_id", user.id);
        } catch {}
      }
    }
  };

  const handleMoveEvent = useCallback((eventId, newStartHour, newDateKey) => {
    setEvents((prev) => {
      const next = prev.map((e) => {
        if (e.id !== eventId) return e;
        const duration = (e.end_hour ?? (e.start_hour ?? 0) + 1) - (e.start_hour ?? 0);
        const start = Math.max(0, Math.min(newStartHour, 24 - duration));
        return {
          ...e,
          start_hour: start,
          end_hour: Math.min(start + duration, 24),
          date_key: newDateKey || e.date_key,
        };
      });
      saveLocalEvents(next);
      return next;
    });
    if (user?.id) {
      const evt = events.find((e) => e.id === eventId);
      if (evt) {
        const duration = (evt.end_hour ?? (evt.start_hour ?? 0) + 1) - (evt.start_hour ?? 0);
        const start = Math.max(0, Math.min(newStartHour, 24 - duration));
        supabase
          .from("calendar_events")
          .update({
            start_hour: start,
            end_hour: Math.min(start + duration, 24),
            date_key: newDateKey || evt.date_key,
          })
          .eq("id", eventId)
          .eq("user_id", user.id)
          .then(() => {});
      }
    }
  }, [events, user]);

  const handleResizeEvent = useCallback((eventId, newEndHour) => {
    setEvents((prev) => {
      const next = prev.map((e) => {
        if (e.id !== eventId) return e;
        return { ...e, end_hour: newEndHour };
      });
      saveLocalEvents(next);
      return next;
    });
    if (user?.id) {
      supabase
        .from("calendar_events")
        .update({ end_hour: newEndHour })
        .eq("id", eventId)
        .eq("user_id", user.id)
        .then(() => {});
    }
  }, [user]);

  const [syncing, setSyncing] = useState(false);
  const [syncDone, setSyncDone] = useState(false);

  const handleSync = useCallback(async () => {
    if (!user?.id || syncing) return;
    setSyncing(true);
    setSyncDone(false);
    try {
      const localEvts = loadLocalEvents();
      const localIds = new Set(localEvts.map((e) => e.id));

      const { data: ownEvents } = await supabase
        .from("calendar_events")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });

      const { data: sharedEvents } = await supabase
        .from("calendar_events")
        .select("*")
        .contains("members", [user.email || ""])
        .neq("user_id", user.id)
        .order("created_at", { ascending: false });

      const remoteOwn = ownEvents || [];
      const remoteShared = (sharedEvents || []).map((e) => ({ ...e, shared: true }));
      const remoteById = new Map();
      [...remoteOwn, ...remoteShared].forEach((e) => remoteById.set(e.id, e));

      const localOnly = localEvts.filter(
        (e) => !remoteById.has(e.id) && e.user_id === user.id
      );
      for (const evt of localOnly) {
        try {
          await supabase.from("calendar_events").upsert({
            id: evt.id,
            user_id: user.id,
            title: evt.title,
            description: evt.description,
            date_key: evt.date_key,
            start_hour: evt.start_hour,
            end_hour: evt.end_hour,
            members: evt.members,
            preset_id: evt.preset_id,
          });
        } catch {}
      }

      const merged = new Map();
      localEvts.forEach((e) => merged.set(e.id, e));
      [...remoteOwn, ...remoteShared].forEach((e) => merged.set(e.id, e));

      const final = Array.from(merged.values());
      setEvents(final);
      saveLocalEvents(final);
      setSyncDone(true);
      setTimeout(() => setSyncDone(false), 2000);
    } catch {
      // silent fail
    } finally {
      setSyncing(false);
    }
  }, [user, syncing]);

  const [draftEvent, setDraftEvent] = useState(null);
  const [googleConnected, setGoogleConnected] = useState(() => loadGoogleConnectedFlag());
  const [googleSyncing, setGoogleSyncing] = useState(false);
  const [googleSyncDone, setGoogleSyncDone] = useState(false);
  const [googleError, setGoogleError] = useState("");
  const googleScriptReadyRef = useRef(false);

  const loadGoogleScript = useCallback(async () => {
    const googleSdk = window["google"];
    if (googleSdk?.accounts?.oauth2) {
      googleScriptReadyRef.current = true;
      return true;
    }
    if (googleScriptReadyRef.current) return true;

    await new Promise((resolve, reject) => {
      const existing = document.querySelector('script[data-google-identity="1"]');
      if (existing) {
        const waitForReady = () => {
          const sdk = window["google"];
          if (sdk?.accounts?.oauth2) {
            googleScriptReadyRef.current = true;
            resolve(true);
          } else {
            window.setTimeout(waitForReady, 50);
          }
        };
        waitForReady();
        return;
      }

      const script = document.createElement("script");
      script.src = "https://accounts.google.com/gsi/client";
      script.async = true;
      script.defer = true;
      script.dataset.googleIdentity = "1";
      script.onload = () => {
        googleScriptReadyRef.current = true;
        resolve(true);
      };
      script.onerror = () => reject(new Error("Failed to load Google Identity script"));
      document.head.appendChild(script);
    });

    return true;
  }, []);

  const syncGoogleCalendarEvents = useCallback(async (accessToken) => {
    const now = new Date();
    const start = new Date(now);
    start.setDate(start.getDate() - 30);
    const end = new Date(now);
    end.setDate(end.getDate() + 120);

    const params = new URLSearchParams({
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "2500",
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
    });
    const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    if (!res.ok) {
      throw new Error("Google Calendar sync failed.");
    }
    const payload = await res.json();
    const items = Array.isArray(payload?.items) ? payload.items : [];

    const importedEvents = items
      .filter((evt) => evt?.status !== "cancelled" && evt?.start && evt?.end)
      .map((evt) => {
        const allDay = !evt.start?.dateTime;
        const startDate = new Date(evt.start?.dateTime || `${evt.start?.date}T00:00:00`);
        const endDate = new Date(evt.end?.dateTime || `${evt.end?.date}T00:00:00`);
        const startHour = allDay ? 9 : startDate.getHours() + startDate.getMinutes() / 60;
        const endHour = allDay
          ? 10
          : Math.max(startHour + 0.25, endDate.getHours() + endDate.getMinutes() / 60);

        const normalizedDate = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, "0")}-${String(startDate.getDate()).padStart(2, "0")}`;
        const summary = String(evt.summary || "Google Calendar Event").trim();
        const description = allDay
          ? `${evt.description ? `${evt.description}\n\n` : ""}[Google Calendar - All day]`
          : `${evt.description || ""}`.trim();

        return {
          id: `gcal_${evt.id}`,
          user_id: user?.id || "local",
          title: summary,
          description,
          date_key: normalizedDate,
          start_hour: Math.max(0, Math.min(23.75, startHour)),
          end_hour: Math.max(0.25, Math.min(24, endHour)),
          members: [],
          preset_id: "custom",
          reminder: "none",
          recurrence: "none",
          series_id: null,
          created_at: new Date().toISOString(),
        };
      });

    setEvents((prev) => {
      const withoutPriorGoogle = prev.filter((evt) => !String(evt.id || "").startsWith("gcal_"));
      const merged = [...importedEvents, ...withoutPriorGoogle];
      saveLocalEvents(merged);
      return merged;
    });
    window.dispatchEvent(new CustomEvent("calendar_events_changed"));

    if (user?.id) {
      try {
        const { data: oldGoogleRows } = await supabase
          .from("calendar_events")
          .select("id")
          .eq("user_id", user.id)
          .like("id", "gcal_%");
        if (oldGoogleRows?.length) {
          for (const row of oldGoogleRows) {
            await supabase.from("calendar_events").delete().eq("id", row.id).eq("user_id", user.id);
          }
        }
        for (const evt of importedEvents) {
          await supabase.from("calendar_events").upsert({
            id: evt.id,
            user_id: user.id,
            title: evt.title,
            description: evt.description,
            date_key: evt.date_key,
            start_hour: evt.start_hour,
            end_hour: evt.end_hour,
            members: evt.members,
            preset_id: evt.preset_id,
            reminder: evt.reminder,
            recurrence: evt.recurrence,
            series_id: evt.series_id,
          });
        }
      } catch {
        // Keep local sync even if cloud save fails.
      }
    }
  }, [user?.id]);

  const handleGoogleConnect = useCallback(async () => {
    if (!googleClientId) {
      setGoogleError("Missing Google Calendar client ID. Add VITE_GOOGLE_CALENDAR_CLIENT_ID to .env.");
      return;
    }
    if (googleSyncing) return;
    setGoogleError("");
    setGoogleSyncDone(false);
    setGoogleSyncing(true);

    try {
      await loadGoogleScript();
      await new Promise((resolve, reject) => {
        const sdk = window["google"];
        if (!sdk?.accounts?.oauth2) {
          reject(new Error("Google Identity SDK is not available."));
          return;
        }
        const tokenClient = sdk.accounts.oauth2.initTokenClient({
          client_id: googleClientId,
          scope: GOOGLE_CALENDAR_SCOPE,
          callback: async (response) => {
            if (!response?.access_token) {
              reject(new Error("Google auth failed."));
              return;
            }
            try {
              await syncGoogleCalendarEvents(response.access_token);
              setGoogleConnected(true);
              saveGoogleConnectedFlag(true);
              setGoogleSyncDone(true);
              window.setTimeout(() => setGoogleSyncDone(false), 2500);
              resolve(true);
            } catch (err) {
              reject(err);
            }
          },
          error_callback: () => reject(new Error("Google sign-in was cancelled.")),
        });

        tokenClient.requestAccessToken({ prompt: googleConnected ? "" : "consent" });
      });
    } catch (err) {
      setGoogleError(err?.message || "Unable to connect Google Calendar.");
    } finally {
      setGoogleSyncing(false);
    }
  }, [googleClientId, googleConnected, googleSyncing, loadGoogleScript, syncGoogleCalendarEvents]);

  const handleSlotClick = (time, dateOverride) => {
    if (modalState?.mode === "edit") return;
    const d = dateOverride || selectedDate;
    const draft = {
      date_key: dateKey(d),
      start_hour: time,
      end_hour: Math.min(time + 0.5, 24),
      preset: EVENT_PRESETS[0],
    };
    setDraftEvent(draft);
    setModalState({ mode: "create", startTime: time, date: d, preset: EVENT_PRESETS[0] });
  };

  const handleDraftChange = useCallback((updates) => {
    setDraftEvent((prev) => prev ? { ...prev, ...updates } : prev);
  }, []);

  const handleEventClick = (event) => {
    setDraftEvent(null);
    setModalState({ mode: "edit", event });
  };

  const goToToday = () => setSelectedDate(new Date());

  return (
    <div className="min-h-screen bg-transparent text-black relative overflow-x-hidden">
      {/* Top panel bar */}
      <div className="fixed top-3 left-0 right-0 z-[70] px-3 flex items-center justify-end pointer-events-none">
        <div className="pointer-events-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setTopPanelOpen((v) => !v)}
            className="rounded-full w-8 h-8 glass-control hover:opacity-90 touch-manipulation flex items-center justify-center"
            title={topPanelOpen ? "Hide panel" : "Show panel"}
          >
            {topPanelOpen ? (
              <ChevronUp className="w-4 h-4" />
            ) : (
              <ChevronDown className="w-4 h-4" />
            )}
          </button>

          {topPanelOpen && (
            <div className="flex h-9 items-center gap-2 p-1 rounded-full glass-control">
              <button
                type="button"
                onClick={goToToday}
                className="text-[0.6875rem] font-medium px-3 py-1 rounded-full glass-control hover:opacity-90"
              >
                Today
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Main content */}
      <div className="relative z-20 flex flex-col pt-16 pb-4" style={{ height: "100vh" }}>
        <div className="px-6 pb-4 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-baseline gap-3">
              <h1 className="text-2xl font-semibold text-black/85 dark:text-white/85">
                {viewMode === "month"
                  ? "Calendar"
                  : selectedDate.toLocaleDateString("en-US", {
                      weekday: "long",
                      month: "long",
                      day: "numeric",
                      year: "numeric",
                    })}
              </h1>
              <LiveClock timezone={timezone} />
            </div>
            <div className="flex items-center gap-2 mt-0.5">
              <p className="text-[0.8125rem] text-black/45 dark:text-white/45">
                {viewMode === "month"
                  ? MONTHS[selectedDate.getMonth()] + " " + selectedDate.getFullYear()
                  : isSameDay(selectedDate, new Date())
                    ? "Today"
                    : (() => {
                      const sel = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate()).getTime();
                      const tod = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).getTime();
                      const diff = Math.round((sel - tod) / 86400000);
                      if (diff === 0) return "Today";
                      const abs = Math.abs(diff);
                      return `${abs} day${abs !== 1 ? "s" : ""} ${diff > 0 ? "from now" : "ago"}`;
                    })()}
              </p>
              {viewMode !== "month" && (() => {
                const dk = dateKey(selectedDate);
                const dayEvts = events.filter((e) => e.date_key === dk);
                const level = getBusyness(dayEvts);
                return (
                  <span
                    className="inline-flex items-center gap-1.5 text-[0.625rem] font-semibold px-2 py-0.5 rounded-full"
                    style={{ color: level.color, background: level.bg }}
                  >
                    <span
                      className="w-1.5 h-1.5 rounded-full"
                      style={{ background: level.color }}
                    />
                    {level.label}
                  </span>
                );
              })()}
              {viewMode !== "month" && (
                <div className="relative" ref={dayStatusRef}>
                  <button
                    type="button"
                    onClick={() => setDayStatusOpen((v) => !v)}
                    className="inline-flex items-center gap-1.5 text-[0.625rem] font-medium px-2.5 py-0.5 rounded-full glass-control hover:opacity-90 cursor-pointer"
                  >
                    {currentDayStatus.hue && (
                      <span className="w-1.5 h-1.5 rounded-full" style={{ background: currentDayStatus.hue.replace(/[\d.]+\)$/, "0.6)") }} />
                    )}
                    <span className="text-black/60 dark:text-white/60">{currentDayStatus.label}</span>
                    <ChevronDown className="w-2.5 h-2.5 text-black/35 dark:text-white/35" />
                  </button>
                  {dayStatusOpen && (() => {
                    const allTypes = [...DAY_STATUSES, ...customDayTypes];
                    const resolveHue = (s) => {
                      if (dayTypeColorOverrides[s.id]) return hexToHue(dayTypeColorOverrides[s.id]);
                      return s.hue;
                    };
                    const resolveSwatchColor = (s) => {
                      const hue = resolveHue(s);
                      return hue ? hue.replace(/[\d.]+\)$/, "0.55)") : "rgba(0,0,0,0.1)";
                    };
                    return (
                    <div className="absolute left-0 top-full mt-1 w-56 rounded-xl glass-control border border-white/25 dark:border-white/10 bg-white/80 dark:bg-black/60 backdrop-blur-xl shadow-lg overflow-hidden z-50">
                      <div className="max-h-72 overflow-y-auto scrollbar-hide py-1">
                        {DAY_STATUSES.map((s) => (
                          <button
                            key={s.id}
                            type="button"
                            onClick={() => handleSetDayStatus(s.id)}
                            className={`w-full text-left text-[0.6875rem] px-3 py-1.5 flex items-center gap-2 hover:bg-black/[0.06] dark:hover:bg-white/[0.08] transition-colors ${
                              currentDayStatus.id === s.id ? "font-semibold text-black dark:text-white" : "text-black/65 dark:text-white/65"
                            } ${dayTypeColorPickerFor === s.id ? "bg-black/[0.04] dark:bg-white/[0.04]" : ""}`}
                          >
                            <span
                              className="w-2 h-2 rounded-full shrink-0"
                              style={{ background: resolveSwatchColor(s) }}
                            />
                            {s.label}
                            {currentDayStatus.id === s.id && <Check className="w-3 h-3 ml-auto text-black/40 dark:text-white/40" />}
                          </button>
                        ))}
                        {customDayTypes.length > 0 && (
                          <>
                            <div className="mx-2.5 my-1 border-t border-black/[0.06] dark:border-white/[0.06]" />
                            {customDayTypes.map((s) => (
                              <div key={s.id} className="flex items-center group">
                                <button
                                  type="button"
                                  onClick={() => handleSetDayStatus(s.id)}
                                  className={`flex-1 text-left text-[0.6875rem] px-3 py-1.5 flex items-center gap-2 hover:bg-black/[0.06] dark:hover:bg-white/[0.08] transition-colors ${
                                    currentDayStatus.id === s.id ? "font-semibold text-black dark:text-white" : "text-black/65 dark:text-white/65"
                                  } ${dayTypeColorPickerFor === s.id ? "bg-black/[0.04] dark:bg-white/[0.04]" : ""}`}
                                >
                                  <span
                                    className="w-2 h-2 rounded-full shrink-0"
                                    style={{ background: resolveSwatchColor(s) }}
                                  />
                                  {s.label}
                                  {currentDayStatus.id === s.id && <Check className="w-3 h-3 ml-auto text-black/40 dark:text-white/40" />}
                                </button>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setCustomDayTypes((prev) => {
                                      const next = prev.filter((t) => t.id !== s.id);
                                      saveCustomDayTypes(next);
                                      return next;
                                    });
                                    if (dayTypeColorPickerFor === s.id) setDayTypeColorPickerFor(null);
                                  }}
                                  className="opacity-0 group-hover:opacity-100 px-1.5 text-black/30 dark:text-white/30 hover:text-red-500 transition-all"
                                >
                                  <X className="w-2.5 h-2.5" />
                                </button>
                              </div>
                            ))}
                          </>
                        )}
                      </div>

                      {dayTypeColorPickerFor && dayTypeColorPickerFor !== "normal" && (
                        <div className="border-t border-black/[0.06] dark:border-white/[0.06] p-2.5">
                          <p className="text-[9px] font-semibold text-black/40 dark:text-white/40 uppercase tracking-wider mb-2">
                            Pick color for {allTypes.find((t) => t.id === dayTypeColorPickerFor)?.label || "day type"}
                          </p>
                          <div className="flex flex-wrap gap-1.5 mb-2">
                            {DAY_TYPE_HUE_PALETTE.map((hue, i) => {
                              const hex = hue.replace(/rgba\((\d+),(\d+),(\d+).*/, (_, r, g, b) =>
                                `#${[r,g,b].map(v => Number(v).toString(16).padStart(2,"0")).join("")}`
                              );
                              const isActive = dayTypeColorOverrides[dayTypeColorPickerFor] === hex;
                              return (
                                <button
                                  key={i}
                                  type="button"
                                  onClick={() => handleSetDayTypeColor(dayTypeColorPickerFor, hex)}
                                  className={`w-5 h-5 rounded-full transition-all ${
                                    isActive ? "ring-2 ring-offset-1 ring-black/25 dark:ring-white/25 scale-110" : "hover:scale-110"
                                  }`}
                                  style={{ background: hue.replace(/[\d.]+\)$/, "0.55)") }}
                                />
                              );
                            })}
                          </div>
                          {dayTypeSavedColors.length > 0 && (
                            <div className="mb-2">
                              <p className="text-[9px] text-black/35 dark:text-white/35 uppercase tracking-wider mb-1">My colors</p>
                              <div className="flex flex-wrap gap-1.5">
                                {dayTypeSavedColors.map((hex, i) => {
                                  const isActive = dayTypeColorOverrides[dayTypeColorPickerFor] === hex;
                                  return (
                                    <button
                                      key={i}
                                      type="button"
                                      onClick={() => handleSetDayTypeColor(dayTypeColorPickerFor, hex)}
                                      className={`w-5 h-5 rounded-full transition-all ${
                                        isActive ? "ring-2 ring-offset-1 ring-black/25 dark:ring-white/25 scale-110" : "hover:scale-110"
                                      }`}
                                      style={{ background: hex }}
                                    />
                                  );
                                })}
                              </div>
                            </div>
                          )}
                          <div className="flex items-center gap-2">
                            <input
                              ref={dayTypeColorInputRef}
                              type="color"
                              defaultValue={dayTypeColorOverrides[dayTypeColorPickerFor] || "#3b82f6"}
                              className="w-6 h-6 rounded-full cursor-pointer border-0 p-0 bg-transparent color-circle"
                            />
                            <button
                              type="button"
                              onClick={() => {
                                const hex = dayTypeColorInputRef.current?.value;
                                if (hex) handleSetDayTypeColor(dayTypeColorPickerFor, hex);
                              }}
                              className="text-[0.625rem] font-medium px-2 py-0.5 rounded-lg glass-control hover:opacity-90"
                            >
                              Apply
                            </button>
                            {dayTypeColorOverrides[dayTypeColorPickerFor] && (
                              <button
                                type="button"
                                onClick={() => handleClearDayTypeColor(dayTypeColorPickerFor)}
                                className="text-[0.625rem] text-black/40 dark:text-white/40 hover:text-black/60 dark:hover:text-white/60"
                              >
                                Reset
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => { setDayTypeColorPickerFor(null); setDayStatusOpen(false); }}
                              className="ml-auto text-[0.625rem] font-medium px-2 py-0.5 rounded-lg glass-control hover:opacity-90"
                            >
                              Done
                            </button>
                          </div>
                        </div>
                      )}

                      <div className="border-t border-black/[0.06] dark:border-white/[0.06]">
                        {creatingDayType ? (
                          <div className="p-2 space-y-2">
                            <input
                              ref={newDayTypeInputRef}
                              type="text"
                              value={newDayTypeName}
                              onChange={(e) => setNewDayTypeName(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" && newDayTypeName.trim()) {
                                  const newType = {
                                    id: `custom_${Date.now()}`,
                                    label: newDayTypeName.trim(),
                                    hue: DAY_TYPE_HUE_PALETTE[newDayTypeColorIdx],
                                  };
                                  setCustomDayTypes((prev) => {
                                    const next = [...prev, newType];
                                    saveCustomDayTypes(next);
                                    return next;
                                  });
                                  setNewDayTypeName("");
                                  setNewDayTypeColorIdx(0);
                                  setCreatingDayType(false);
                                }
                                if (e.key === "Escape") {
                                  setCreatingDayType(false);
                                  setNewDayTypeName("");
                                }
                              }}
                              placeholder="Day type name"
                              className="w-full rounded-lg border border-black/10 dark:border-white/10 bg-white/30 dark:bg-white/5 px-2 py-1 text-[0.6875rem] text-black/70 dark:text-white/70 placeholder:text-black/35 dark:placeholder:text-white/35 outline-none"
                              autoFocus
                            />
                            <div className="flex flex-wrap gap-1">
                              {DAY_TYPE_HUE_PALETTE.map((hue, i) => (
                                <button
                                  key={i}
                                  type="button"
                                  onClick={() => setNewDayTypeColorIdx(i)}
                                  className={`w-4 h-4 rounded-full border-2 transition-all ${
                                    newDayTypeColorIdx === i ? "border-black/40 dark:border-white/40 scale-110" : "border-transparent"
                                  }`}
                                  style={{ background: hue.replace(/[\d.]+\)$/, "0.55)") }}
                                />
                              ))}
                            </div>
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => {
                                  if (!newDayTypeName.trim()) return;
                                  const newType = {
                                    id: `custom_${Date.now()}`,
                                    label: newDayTypeName.trim(),
                                    hue: DAY_TYPE_HUE_PALETTE[newDayTypeColorIdx],
                                  };
                                  setCustomDayTypes((prev) => {
                                    const next = [...prev, newType];
                                    saveCustomDayTypes(next);
                                    return next;
                                  });
                                  setNewDayTypeName("");
                                  setNewDayTypeColorIdx(0);
                                  setCreatingDayType(false);
                                }}
                                disabled={!newDayTypeName.trim()}
                                className="flex-1 text-[0.625rem] font-medium px-2 py-1 rounded-lg glass-control hover:opacity-90 transition-all disabled:opacity-40"
                              >
                                Add
                              </button>
                              <button
                                type="button"
                                onClick={() => { setCreatingDayType(false); setNewDayTypeName(""); }}
                                className="text-[0.625rem] font-medium px-2 py-1 rounded-lg text-black/40 dark:text-white/40 hover:text-black/60 dark:hover:text-white/60 transition-colors"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              setCreatingDayType(true);
                              setTimeout(() => newDayTypeInputRef.current?.focus(), 50);
                            }}
                            className="w-full text-left text-[0.6875rem] px-3 py-2 flex items-center gap-2 text-black/50 dark:text-white/50 hover:text-black/70 dark:hover:text-white/70 hover:bg-black/[0.04] dark:hover:bg-white/[0.04] transition-colors"
                          >
                            <Plus className="w-3 h-3" />
                            Create Day Type
                          </button>
                        )}
                      </div>
                    </div>
                    );
                  })()}
                </div>
              )}
              <NextEventCountdown events={events} timezone={timezone} />
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0 pt-1">
            {/* View mode dropdown */}
            <div className="relative" ref={viewRef}>
              <button
                type="button"
                onClick={() => setViewDropdownOpen((v) => !v)}
                className="flex items-center gap-1.5 text-[0.6875rem] font-medium px-3 py-1.5 rounded-full glass-control hover:opacity-90"
              >
                <CalendarIcon className="w-3 h-3 text-black/50 dark:text-white/50" />
                <span className="text-black/70 dark:text-white/70">
                  {VIEW_MODES.find((m) => m.value === viewMode)?.label}
                </span>
                <ChevronDown className="w-3 h-3 text-black/40 dark:text-white/40" />
              </button>
              {viewDropdownOpen && (
                <div className="absolute right-0 top-full mt-1 w-36 rounded-xl glass-control border border-white/25 dark:border-white/10 bg-white/60 dark:bg-black/40 backdrop-blur-xl shadow-lg overflow-hidden z-50">
                  <div className="py-1">
                    {VIEW_MODES.map((m) => (
                      <button
                        key={m.value}
                        type="button"
                        onClick={() => {
                          setViewMode(m.value);
                          setViewDropdownOpen(false);
                        }}
                        className={`w-full text-left text-[0.6875rem] px-3 py-2 hover:bg-black/[0.06] dark:hover:bg-white/[0.08] transition-colors ${
                          viewMode === m.value
                            ? "font-semibold text-black dark:text-white"
                            : "text-black/65 dark:text-white/65"
                        }`}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="relative" ref={tzRef}>
              <button
                type="button"
                onClick={() => setTzDropdownOpen((v) => !v)}
                className="flex items-center gap-1.5 text-[0.6875rem] font-medium px-3 py-1.5 rounded-full glass-control hover:opacity-90"
              >
                <Globe className="w-3 h-3 text-black/50 dark:text-white/50" />
                <span className="text-black/70 dark:text-white/70">{tzLabel}</span>
                <ChevronDown className="w-3 h-3 text-black/40 dark:text-white/40" />
              </button>
              {tzDropdownOpen && (
                <div className="absolute right-0 top-full mt-1 w-52 rounded-xl glass-control border border-white/25 dark:border-white/10 bg-white/60 dark:bg-black/40 backdrop-blur-xl shadow-lg overflow-hidden z-50">
                  <div className="max-h-64 overflow-y-auto py-1">
                    {COMMON_TIMEZONES.map((tz) => (
                      <button
                        key={tz.value}
                        type="button"
                        onClick={() => {
                          setTimezone(tz.value);
                          setTzDropdownOpen(false);
                        }}
                        className={`w-full text-left text-[0.6875rem] px-3 py-2 hover:bg-black/[0.06] dark:hover:bg-white/[0.08] transition-colors ${
                          timezone === tz.value
                            ? "font-semibold text-black dark:text-white"
                            : "text-black/65 dark:text-white/65"
                        }`}
                      >
                        {tz.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {showGoogleCalendarConnect && (
              <button
                type="button"
                onClick={handleGoogleConnect}
                disabled={googleSyncing || !user?.id}
                className="flex items-center gap-1.5 text-[0.6875rem] font-medium px-3 py-1.5 rounded-full glass-control hover:opacity-90 transition-all disabled:opacity-40"
                title={googleConnected ? "Sync Google Calendar" : "Connect Google Calendar"}
              >
                {googleSyncDone ? (
                  <Check className="w-3 h-3 text-emerald-500" />
                ) : (
                  <CalendarIcon className={`w-3 h-3 text-black/50 dark:text-white/50 ${googleSyncing ? "animate-pulse" : ""}`} />
                )}
                <span className="text-black/70 dark:text-white/70">
                  {googleSyncDone ? "Google Synced" : googleSyncing ? "Google Syncing…" : googleConnected ? "Sync Google" : "Connect Google"}
                </span>
              </button>
            )}

            <button
              type="button"
              onClick={handleSync}
              disabled={syncing || !user?.id}
              className="flex items-center gap-1.5 text-[0.6875rem] font-medium px-3 py-1.5 rounded-full glass-control hover:opacity-90 transition-all disabled:opacity-40"
              title="Sync calendar"
            >
              {syncDone ? (
                <Check className="w-3 h-3 text-emerald-500" />
              ) : (
                <RefreshCw className={`w-3 h-3 text-black/50 dark:text-white/50 ${syncing ? "animate-spin" : ""}`} />
              )}
              <span className="text-black/70 dark:text-white/70">
                {syncDone ? "Synced" : syncing ? "Syncing…" : "Sync"}
              </span>
            </button>
          </div>
        </div>
        {showGoogleCalendarConnect && googleError && (
          <div className="px-6 -mt-1 pb-2">
            <div className="text-xs text-red-600">{googleError}</div>
          </div>
        )}

        {viewMode === "day" ? (
          <DayView
            selectedDate={selectedDate}
            onSelectDate={setSelectedDate}
            timezone={timezone}
            events={events}
            onSlotClick={handleSlotClick}
            onEventClick={handleEventClick}
            draftEvent={draftEvent}
            onDraftChange={handleDraftChange}
            dayStatuses={dayStatuses}
            customDayTypes={customDayTypes}
            dayTypeColorOverrides={dayTypeColorOverrides}
            onMoveEvent={handleMoveEvent}
            onResizeEvent={handleResizeEvent}
          />
        ) : viewMode === "3day" || viewMode === "week" ? (
          <MultiDayView
            selectedDate={selectedDate}
            onSelectDate={setSelectedDate}
            timezone={timezone}
            events={events}
            onSlotClick={handleSlotClick}
            onEventClick={handleEventClick}
            mode={viewMode}
            draftEvent={draftEvent}
            onDraftChange={handleDraftChange}
            dayStatuses={dayStatuses}
            customDayTypes={customDayTypes}
            dayTypeColorOverrides={dayTypeColorOverrides}
            onMoveEvent={handleMoveEvent}
            onResizeEvent={handleResizeEvent}
          />
        ) : (
          <MonthView
            selectedDate={selectedDate}
            onSelectDate={(d) => {
              setSelectedDate(d);
              setViewMode("day");
            }}
            events={events}
            onEventClick={handleEventClick}
            dayStatuses={dayStatuses}
            customDayTypes={customDayTypes}
            dayTypeColorOverrides={dayTypeColorOverrides}
          />
        )}
      </div>

      {/* Event modal (create / view / edit) */}
      {modalState && (
        <EventModal
          key={modalState.event?.id || `new-${modalState.startTime}-${modalState.date}`}
          event={modalState.event ?? null}
          startTime={modalState.startTime}
          date={modalState.date}
          preset={modalState.preset ?? null}
          onClose={() => { setModalState(null); setDraftEvent(null); }}
          onSave={handleSaveEvent}
          onDelete={handleDeleteEvent}
          onDraftChange={handleDraftChange}
          draftEndHour={draftEvent?.end_hour}
          onLiveColorChange={(eventId, color) => {
            if (!eventId) return;
            setEvents((prev) => {
              const next = prev.map((e) => e.id === eventId ? { ...e, custom_color: color } : e);
              saveLocalEvents(next);
              return next;
            });
          }}
          onPresetColorChange={(presetId, hex) => {
            setEvents((prev) => {
              const next = prev.map((e) =>
                e.preset_id === presetId ? { ...e, custom_color: null } : e
              );
              saveLocalEvents(next);
              return next;
            });
          }}
        />
      )}

      {/* Quick note */}
      {showQuickNote && (
        <DraggableQuickNote
          title={quickNoteTitle}
          content={quickNoteContent}
          setTitle={setQuickNoteTitle}
          setContent={setQuickNoteContent}
          isSaving={isQuickNoteSaving}
          onSave={handleSaveQuickNote}
          onClose={() => setShowQuickNote(false)}
        />
      )}
      <button
        type="button"
        onClick={() => setShowQuickNote(true)}
        className="fixed bottom-8 right-8 w-14 h-14 rounded-full glass-control hover:opacity-90 shadow-lg hover:shadow-xl transition-all flex items-center justify-center hover:scale-110 z-[80]"
        title="Quick Notes"
      >
        <StickyNote className="w-6 h-6" />
      </button>
    </div>
  );
}
