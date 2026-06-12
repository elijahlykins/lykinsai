import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  ArrowLeft,
  ArrowUpRight,
  CalendarClock,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  ExternalLink,
  Eye,
  EyeOff,
  Link2,
  Loader2,
  ListTodo,
  MapPin,
  Plus,
  RefreshCw,
  Trash2,
  Unplug,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/SupabaseAuth";
import { API_BASE_URL } from "@/lib/api-config";
import { toast } from "@/components/ui/use-toast";
import LyknTodosPanel from "@/components/todos/LyknTodosPanel";

// ────────────────────────────────────────────────────────────────────────
// LyknCalendarDialog — the calendar pop-up.
//
// Reads/writes the user's own lykn_events rows directly through the
// RLS-protected Supabase client (same pattern AppSidebar uses for boards),
// and subscribes to realtime so events the AI adds in text/voice appear
// here live. Two views in one dialog: a month grid, and an add/edit form.
// ────────────────────────────────────────────────────────────────────────

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const LOCAL_TZ = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
})();

const PROVIDER_LABEL = { google: "Google Calendar", apple: "Apple Calendar" };
const PROVIDER_SHORT = { google: "Google", apple: "Apple" };

const GOOGLE_PROVIDER = "google-calendar";
const APPLE_PROVIDER = "apple-calendar";

async function authedFetch(path, init = {}) {
  const { data: sess } = await supabase.auth.getSession();
  const token = sess?.session?.access_token || "";
  return fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  });
}

function relTime(iso) {
  const t = new Date(iso).getTime();
  if (!t) return "never synced";
  const sec = Math.floor((Date.now() - t) / 1000);
  if (sec < 60) return "synced just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `synced ${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `synced ${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `synced ${day}d ago`;
}

const pad2 = (n) => String(n).padStart(2, "0");

// Date → "YYYY-MM-DD" in LOCAL wall-clock (for <input type=date>).
function toLocalDateInput(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function sameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
function fmtTime(d) {
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// The 42-cell (6-week) grid that covers a month, starting on Sunday.
function buildMonthGrid(year, month) {
  const first = new Date(year, month, 1);
  const start = new Date(year, month, 1 - first.getDay());
  const cells = [];
  for (let i = 0; i < 42; i++) {
    cells.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  }
  return cells;
}

const EMPTY_FORM = {
  id: null,
  title: "",
  allDay: false,
  date: "",
  startTime: "09:00",
  endTime: "10:00",
  location: "",
  description: "",
  readOnly: false,
  provider: null,
};

// Genuine Google Calendar product icon (gstatic), with a graceful fallback
// to a colored badge if the asset can't load.
function GoogleCalendarIcon() {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-white text-[0.625rem] font-semibold"
        style={{ backgroundColor: "#4285F4" }}
      >
        31
      </span>
    );
  }
  return (
    <img
      src="https://www.gstatic.com/images/branding/product/2x/calendar_2020q4_48dp.png"
      alt="Google Calendar"
      className="h-7 w-7 rounded-md object-contain"
      onError={() => setFailed(true)}
    />
  );
}

// Apple Calendar's icon is a live-date tile (red weekday header + today's
// number). We render it inline so it's always the real look with no fragile
// external URL.
function AppleCalendarIcon() {
  const now = new Date();
  const weekday = now.toLocaleDateString(undefined, { weekday: "short" }).toUpperCase();
  const day = now.getDate();
  return (
    <div className="h-7 w-7 rounded-md overflow-hidden bg-white shadow-sm ring-1 ring-black/10 flex flex-col flex-shrink-0">
      <div className="bg-[#FF3B30] text-white text-[0.4375rem] font-bold leading-none text-center pt-[3px] pb-px tracking-wide">
        {weekday}
      </div>
      <div className="flex-1 flex items-center justify-center text-black text-[0.8125rem] font-semibold leading-none -mt-px">
        {day}
      </div>
    </div>
  );
}

// Segmented Calendar / To-dos switch shown at the top of the pop-up.
function PanelToggle({ panel, onChange }) {
  const base =
    "inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-all duration-200 ease-out";
  const activeCls = "bg-white text-black dark:bg-white dark:text-black shadow-sm";
  const idleCls = "text-black/55 dark:text-white/55 hover:text-black dark:hover:text-white";
  return (
    <div className="inline-flex items-center gap-0.5 rounded-lg bg-black/5 dark:bg-white/10 p-0.5">
      <button
        type="button"
        onClick={() => onChange("calendar")}
        className={`${base} ${panel === "calendar" ? activeCls : idleCls}`}
      >
        <CalendarDays className="w-3.5 h-3.5" /> Calendar
      </button>
      <button
        type="button"
        onClick={() => onChange("todos")}
        className={`${base} ${panel === "todos" ? activeCls : idleCls}`}
      >
        <ListTodo className="w-3.5 h-3.5" /> To-dos
      </button>
    </div>
  );
}

export default function LyknCalendarDialog({ open, onOpenChange, initialPanel = "calendar" }) {
  const { user } = useAuth();
  const today = useMemo(() => new Date(), []);
  const [panel, setPanel] = useState("calendar"); // "calendar" | "todos"
  const [cursor, setCursor] = useState(() => ({ year: today.getFullYear(), month: today.getMonth() }));
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState("month"); // 'month' | 'day' | 'form'
  const [selectedDay, setSelectedDay] = useState(null);
  const [formReturnTo, setFormReturnTo] = useState("month");
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // External calendar sync (Google / Apple), managed from the 'sync' view.
  const [connections, setConnections] = useState([]);
  const [connLoading, setConnLoading] = useState(false);
  const [connectingGoogle, setConnectingGoogle] = useState(false);
  const [syncingId, setSyncingId] = useState(null);
  const [appleForm, setAppleForm] = useState({ email: "", password: "" });
  const [appleSaving, setAppleSaving] = useState(false);
  const [appleReveal, setAppleReveal] = useState(false);
  const [refreshingAll, setRefreshingAll] = useState(false);

  const grid = useMemo(() => buildMonthGrid(cursor.year, cursor.month), [cursor]);

  // Window the query to the visible grid (plus a day of slack on each end).
  const windowBounds = useMemo(() => {
    const from = new Date(grid[0].getFullYear(), grid[0].getMonth(), grid[0].getDate());
    const last = grid[grid.length - 1];
    const to = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1);
    return { fromIso: from.toISOString(), toIso: to.toISOString() };
  }, [grid]);

  const loadEvents = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);
    const { data, error: err } = await supabase
      .from("lykn_events")
      .select("id, title, description, starts_at, ends_at, all_day, location, color, status, external_provider, read_only")
      .eq("user_id", user.id)
      .neq("status", "cancelled")
      .gte("starts_at", windowBounds.fromIso)
      .lte("starts_at", windowBounds.toIso)
      .order("starts_at", { ascending: true });
    if (!err) setEvents(data || []);
    setLoading(false);
  }, [user?.id, windowBounds.fromIso, windowBounds.toIso]);

  useEffect(() => {
    if (open) void loadEvents();
  }, [open, loadEvents]);

  // Open directly to the requested panel (calendar vs to-dos).
  useEffect(() => {
    if (open) setPanel(initialPanel === "todos" ? "todos" : "calendar");
  }, [open, initialPanel]);

  // Realtime: reflect events the AI adds in text/voice without a refresh.
  useEffect(() => {
    if (!open || !user?.id) return undefined;
    const channel = supabase
      .channel(`lykn-events:${user.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "lykn_events", filter: `user_id=eq.${user.id}` },
        () => { void loadEvents(); },
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [open, user?.id, loadEvents]);

  // ── External calendar sync (Google / Apple) ──────────────────────────
  const googleConn = useMemo(
    () => connections.find((c) => c.provider === GOOGLE_PROVIDER) || null,
    [connections],
  );
  const appleConn = useMemo(
    () => connections.find((c) => c.provider === APPLE_PROVIDER) || null,
    [connections],
  );

  const refreshConnections = useCallback(async () => {
    setConnLoading(true);
    try {
      const res = await authedFetch("/api/connections");
      if (res.ok) {
        const data = await res.json();
        setConnections(data.connections || []);
      }
    } catch {
      /* non-fatal — the sync panel just shows "not connected" */
    } finally {
      setConnLoading(false);
    }
  }, []);

  const openSyncView = useCallback(() => {
    setView("sync");
    void refreshConnections();
  }, [refreshConnections]);

  const handleGoogleConnect = useCallback(async () => {
    setConnectingGoogle(true);
    try {
      const res = await authedFetch(`/api/connections/${GOOGLE_PROVIDER}/start`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const w = 620;
      const h = 760;
      const left = Math.max(0, (window.screen.width - w) / 2);
      const top = Math.max(0, (window.screen.height - h) / 2);
      const popup = window.open(
        data.url,
        "lyknOauth",
        `width=${w},height=${h},left=${left},top=${top},popup=1`,
      );
      if (!popup) window.location.href = data.url;
    } catch (err) {
      setConnectingGoogle(false);
      toast({
        title: "Couldn't start Google sign-in",
        description: err?.message || "Try again.",
        variant: "destructive",
      });
    }
  }, []);

  // OAuth popup → opener handshake (Google Calendar only here).
  useEffect(() => {
    if (!open) return undefined;
    let expectedOrigin = "";
    try { expectedOrigin = new URL(API_BASE_URL).origin; } catch { expectedOrigin = ""; }
    const onMessage = (event) => {
      if (expectedOrigin && event.origin !== expectedOrigin) return;
      const msg = event?.data;
      if (!msg || msg.type !== "lykn:oauth" || msg.provider !== GOOGLE_PROVIDER) return;
      setConnectingGoogle(false);
      if (msg.ok) {
        toast({ title: "Google Calendar connected", description: "Importing your events…" });
        void refreshConnections();
        void loadEvents();
      } else {
        toast({ title: "Google sign-in cancelled", variant: "destructive" });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [open, refreshConnections, loadEvents]);

  const handleAppleConnect = useCallback(
    async (e) => {
      e?.preventDefault?.();
      const email = appleForm.email.trim();
      const password = appleForm.password.trim();
      if (!email || !password) {
        toast({ title: "Enter your Apple ID and app-specific password", variant: "destructive" });
        return;
      }
      setAppleSaving(true);
      try {
        const res = await authedFetch(`/api/connections/${APPLE_PROVIDER}/connect-token`, {
          method: "POST",
          body: JSON.stringify({ email, password }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        toast({ title: "Apple Calendar connected", description: "Importing your events…" });
        setAppleForm({ email: "", password: "" });
        setAppleReveal(false);
        await refreshConnections();
        await loadEvents();
      } catch (err) {
        toast({
          title: "Couldn't connect Apple Calendar",
          description: err?.message || "Double-check the app-specific password.",
          variant: "destructive",
        });
      } finally {
        setAppleSaving(false);
      }
    },
    [appleForm, refreshConnections, loadEvents],
  );

  const handleSyncConn = useCallback(
    async (id) => {
      setSyncingId(id);
      try {
        const res = await authedFetch(`/api/connections/${id}/sync`, { method: "POST" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        if (data.status === "reauth") {
          toast({ title: "Reconnect needed", description: "The credential was rejected.", variant: "destructive" });
        } else {
          toast({
            title: (data.saved || 0) > 0
              ? `Synced ${data.saved} update${data.saved === 1 ? "" : "s"}`
              : "Already up to date",
          });
        }
        await refreshConnections();
        await loadEvents();
      } catch (err) {
        toast({ title: "Sync failed", description: err?.message || "Try again.", variant: "destructive" });
      } finally {
        setSyncingId(null);
      }
    },
    [refreshConnections, loadEvents],
  );

  const handleDisconnectConn = useCallback(
    async (conn) => {
      const label = conn.provider === APPLE_PROVIDER ? "Apple" : "Google";
      if (!window.confirm(`Disconnect ${label} Calendar? Events already imported stay on your LYKN calendar.`)) return;
      try {
        const res = await authedFetch(`/api/connections/${conn.id}`, { method: "DELETE" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        toast({ title: `${label} Calendar disconnected` });
        await refreshConnections();
      } catch (err) {
        toast({ title: "Couldn't disconnect", description: err?.message || "Try again.", variant: "destructive" });
      }
    },
    [refreshConnections],
  );

  // One-click "refresh": re-pull every connected external calendar (Google /
  // Apple), then reload the grid. Falls back to a plain grid reload when no
  // external calendars are connected.
  const handleRefreshAll = useCallback(async () => {
    setRefreshingAll(true);
    try {
      let conns = [];
      try {
        const res = await authedFetch("/api/connections");
        if (res.ok) conns = (await res.json()).connections || [];
      } catch {
        /* offline / not signed in — still reload the grid below */
      }
      setConnections(conns);
      const external = conns.filter(
        (c) => (c.provider === GOOGLE_PROVIDER || c.provider === APPLE_PROVIDER) && c.status === "active",
      );
      let totalSaved = 0;
      let anyReauth = false;
      for (const c of external) {
        try {
          const res = await authedFetch(`/api/connections/${c.id}/sync`, { method: "POST" });
          const data = await res.json();
          if (res.ok) {
            totalSaved += data.saved || 0;
            if (data.status === "reauth") anyReauth = true;
          }
        } catch {
          /* keep going — one provider failing shouldn't block the others */
        }
      }
      await loadEvents();
      await refreshConnections();
      if (anyReauth) {
        toast({ title: "Reconnect needed", description: "A calendar's credential was rejected.", variant: "destructive" });
      } else if (external.length === 0) {
        toast({ title: "Calendar refreshed" });
      } else {
        toast({
          title: totalSaved > 0 ? `Synced ${totalSaved} update${totalSaved === 1 ? "" : "s"}` : "Up to date",
        });
      }
    } finally {
      setRefreshingAll(false);
    }
  }, [loadEvents, refreshConnections]);

  // Group events by local day-key for fast cell lookup.
  const eventsByDay = useMemo(() => {
    const map = new Map();
    for (const ev of events) {
      const d = new Date(ev.starts_at);
      const key = toLocalDateInput(d);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(ev);
    }
    return map;
  }, [events]);

  const monthLabel = `${MONTHS[cursor.month]} ${cursor.year}`;

  const goPrevMonth = () =>
    setCursor((c) => {
      const m = c.month - 1;
      return m < 0 ? { year: c.year - 1, month: 11 } : { year: c.year, month: m };
    });
  const goNextMonth = () =>
    setCursor((c) => {
      const m = c.month + 1;
      return m > 11 ? { year: c.year + 1, month: 0 } : { year: c.year, month: m };
    });
  // Open the focused single-day view, keeping the month grid in sync so a
  // "back" lands on the right month.
  const openDayView = (day) => {
    setSelectedDay(day);
    setCursor({ year: day.getFullYear(), month: day.getMonth() });
    setView("day");
  };

  const shiftDay = (delta) => {
    setSelectedDay((d) => {
      const base = d || new Date();
      const next = new Date(base.getFullYear(), base.getMonth(), base.getDate() + delta);
      setCursor({ year: next.getFullYear(), month: next.getMonth() });
      return next;
    });
  };

  // Events for the focused day, all-day first then chronological.
  const selectedDayEvents = useMemo(() => {
    if (!selectedDay) return [];
    const list = eventsByDay.get(toLocalDateInput(selectedDay)) || [];
    return [...list].sort((a, b) => {
      if (a.all_day !== b.all_day) return a.all_day ? -1 : 1;
      return new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime();
    });
  }, [selectedDay, eventsByDay]);

  const openNewForm = (day, returnTo = "month") => {
    const base = day || new Date();
    setForm({
      ...EMPTY_FORM,
      date: toLocalDateInput(base),
      startTime: "09:00",
      endTime: "10:00",
    });
    setError("");
    setFormReturnTo(returnTo);
    setView("form");
  };

  const openEditForm = (ev, returnTo = "month") => {
    const start = new Date(ev.starts_at);
    const end = ev.ends_at ? new Date(ev.ends_at) : null;
    setForm({
      id: ev.id,
      title: ev.title || "",
      allDay: Boolean(ev.all_day),
      date: toLocalDateInput(start),
      startTime: `${pad2(start.getHours())}:${pad2(start.getMinutes())}`,
      endTime: end ? `${pad2(end.getHours())}:${pad2(end.getMinutes())}` : "",
      location: ev.location || "",
      description: ev.description || "",
      readOnly: Boolean(ev.read_only),
      provider: ev.external_provider || null,
    });
    setError("");
    setFormReturnTo(returnTo);
    setView("form");
  };

  const handleSave = async (e) => {
    e?.preventDefault?.();
    if (!user?.id) return;
    // Synced-in events are read-only — never write them back.
    if (form.readOnly) { setView(formReturnTo); return; }
    const title = form.title.trim();
    if (!title) { setError("Give the event a name."); return; }
    if (!form.date) { setError("Pick a date."); return; }

    let startsAt;
    let endsAt = null;
    if (form.allDay) {
      const [y, m, d] = form.date.split("-").map((n) => parseInt(n, 10));
      startsAt = new Date(y, m - 1, d, 0, 0, 0, 0);
    } else {
      startsAt = new Date(`${form.date}T${form.startTime || "09:00"}`);
      if (form.endTime) {
        endsAt = new Date(`${form.date}T${form.endTime}`);
        if (endsAt.getTime() < startsAt.getTime()) {
          setError("End time is before the start time.");
          return;
        }
      }
    }
    if (Number.isNaN(startsAt.getTime())) { setError("That date/time didn't parse."); return; }

    setSaving(true);
    setError("");
    const payload = {
      title: title.slice(0, 280),
      description: form.description.trim().slice(0, 4000) || null,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt ? endsAt.toISOString() : null,
      all_day: form.allDay,
      location: form.location.trim().slice(0, 300) || null,
      timezone: LOCAL_TZ,
      updated_at: new Date().toISOString(),
    };

    let err;
    if (form.id) {
      ({ error: err } = await supabase
        .from("lykn_events")
        .update(payload)
        .eq("id", form.id)
        .eq("user_id", user.id));
    } else {
      ({ error: err } = await supabase
        .from("lykn_events")
        .insert({ ...payload, user_id: user.id, source: "calendar-ui" }));
    }
    setSaving(false);
    if (err) { setError(err.message || "Could not save the event."); return; }
    await loadEvents();
    setView(formReturnTo);
  };

  const handleDelete = async () => {
    if (!form.id || !user?.id) return;
    if (!window.confirm("Delete this event? This cannot be undone.")) return;
    setSaving(true);
    const { error: err } = await supabase
      .from("lykn_events")
      .delete()
      .eq("id", form.id)
      .eq("user_id", user.id);
    setSaving(false);
    if (err) { setError(err.message || "Could not delete the event."); return; }
    await loadEvents();
    setView(formReturnTo);
  };

  const inputCls =
    "w-full px-3 py-2 text-sm bg-white dark:bg-[#1f1d1d] border border-gray-200 dark:border-gray-700 text-black dark:text-white placeholder:text-gray-400 dark:placeholder:text-gray-500 rounded-lg focus:outline-none focus:ring-1 focus:ring-black/20 dark:focus:ring-white/20";

  return (
    <Dialog open={open} onOpenChange={(next) => { onOpenChange(next); if (!next) setView("month"); }}>
      <DialogContent className="bg-white dark:bg-[#1e1e1e] border-white/15 dark:border-gray-700 text-black dark:text-white max-w-2xl backdrop-blur-md">
        {(panel === "todos" || view === "month") && (
          <div className="flex items-center justify-center pb-1">
            <PanelToggle panel={panel} onChange={setPanel} />
          </div>
        )}

        <div
          className={`flex flex-col gap-4 ${
            panel === "todos" || view === "month" ? "min-h-[30rem]" : ""
          }`}
        >
        {panel === "todos" && (
          <>
            <DialogHeader>
              <DialogTitle className="sr-only">To-dos</DialogTitle>
              <DialogDescription className="text-[0.625rem] text-black/40 dark:text-white/40">
                Tasks you and LYKN are tracking. Ask LYKN in chat or voice to add, complete, or clear items — they sync here live.
              </DialogDescription>
            </DialogHeader>
            <LyknTodosPanel active={open && panel === "todos"} />
          </>
        )}

        {panel === "calendar" && view === "month" && (
          <>
            <DialogHeader>
              <div className="flex items-center justify-between pr-6">
                <DialogTitle className="text-black dark:text-white">{monthLabel}</DialogTitle>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={handleRefreshAll}
                    disabled={refreshingAll}
                    className="w-7 h-7 rounded-md hover:bg-black/5 dark:hover:bg-white/10 flex items-center justify-center text-black/60 dark:text-white/60 transition-colors disabled:opacity-50"
                    title="Refresh — re-pull connected calendars"
                  >
                    <RefreshCw className={`w-4 h-4 ${refreshingAll ? "animate-spin" : ""}`} />
                  </button>
                  <button
                    type="button"
                    onClick={openSyncView}
                    className="w-7 h-7 rounded-md hover:bg-black/5 dark:hover:bg-white/10 flex items-center justify-center text-black/60 dark:text-white/60 transition-colors"
                    title="Connect Google / Apple calendars"
                  >
                    <Link2 className="w-4 h-4" />
                  </button>
                  <button type="button" onClick={goPrevMonth} className="w-7 h-7 rounded-md hover:bg-black/5 dark:hover:bg-white/10 flex items-center justify-center transition-colors" title="Previous month">
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <button type="button" onClick={goNextMonth} className="w-7 h-7 rounded-md hover:bg-black/5 dark:hover:bg-white/10 flex items-center justify-center transition-colors" title="Next month">
                    <ChevronRight className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => openNewForm()}
                    className="ml-1 inline-flex items-center gap-1 rounded-md bg-black text-white hover:bg-black/90 dark:bg-white dark:text-black dark:hover:bg-white/90 px-2.5 py-1 text-xs font-medium transition-colors"
                  >
                    <Plus className="w-3.5 h-3.5" /> Event
                  </button>
                </div>
              </div>
              <DialogDescription className="sr-only">Your LYKN calendar</DialogDescription>
            </DialogHeader>

            <div className="grid grid-cols-7 text-[0.625rem] font-semibold uppercase tracking-wider text-black/40 dark:text-white/40 mb-1">
              {WEEKDAYS.map((w) => (
                <div key={w} className="px-1 py-0.5 text-center">{w}</div>
              ))}
            </div>

            <div className="grid grid-cols-7 gap-px bg-black/5 dark:bg-white/5 rounded-lg overflow-hidden border border-black/5 dark:border-white/5">
              {grid.map((day) => {
                const inMonth = day.getMonth() === cursor.month;
                const isToday = sameDay(day, today);
                const dayEvents = eventsByDay.get(toLocalDateInput(day)) || [];
                return (
                  <button
                    type="button"
                    key={day.toISOString()}
                    onClick={() => openDayView(day)}
                    className={`relative min-h-[4.5rem] text-left p-1 bg-white dark:bg-[#1e1e1e] transition-colors hover:bg-blue-500/5 ${
                      inMonth ? "" : "opacity-40"
                    }`}
                  >
                    <span
                      className={`inline-flex items-center justify-center w-5 h-5 text-[0.6875rem] rounded-full ${
                        isToday ? "bg-blue-500 text-white font-semibold" : "text-black/60 dark:text-white/60"
                      }`}
                    >
                      {day.getDate()}
                    </span>
                    <div className="mt-0.5 space-y-0.5">
                      {dayEvents.slice(0, 3).map((ev) => (
                        <span
                          key={ev.id}
                          role="button"
                          tabIndex={0}
                          onClick={(e) => { e.stopPropagation(); openEditForm(ev); }}
                          onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); openEditForm(ev); } }}
                          className={`block w-full truncate rounded px-1 py-0.5 text-[0.625rem] leading-tight transition-colors cursor-pointer ${
                            ev.read_only
                              ? "bg-black/5 dark:bg-white/10 text-black/70 dark:text-white/70 hover:bg-black/10 dark:hover:bg-white/15"
                              : "bg-blue-500/15 text-blue-700 dark:text-blue-300 hover:bg-blue-500/25"
                          }`}
                          title={ev.read_only ? `${ev.title} · ${PROVIDER_LABEL[ev.external_provider] || "Synced"}` : ev.title}
                          style={ev.color ? { backgroundColor: `${ev.color}26`, color: ev.color } : undefined}
                        >
                          {ev.read_only && (
                            <span className="mr-0.5 opacity-60">●</span>
                          )}
                          {!ev.all_day && (
                            <span className="opacity-70 mr-0.5">{fmtTime(new Date(ev.starts_at))}</span>
                          )}
                          {ev.title}
                        </span>
                      ))}
                      {dayEvents.length > 3 && (
                        <span className="block px-1 text-[0.5625rem] text-black/40 dark:text-white/40">
                          +{dayEvents.length - 3} more
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="flex items-center justify-between text-[0.625rem] text-black/40 dark:text-white/40 pt-1">
              <span>Ask LYKN in chat or voice to add events. They appear here live.</span>
              {loading && <Loader2 className="w-3 h-3 animate-spin" />}
            </div>
          </>
        )}

        {panel === "calendar" && view === "day" && (
          <>
            <DialogHeader>
              <div className="flex items-center justify-between pr-6">
                <div className="flex items-center gap-2 min-w-0">
                  <button type="button" onClick={() => setView("month")} className="w-7 h-7 rounded-md hover:bg-black/5 dark:hover:bg-white/10 flex items-center justify-center transition-colors flex-shrink-0" title="Back to month">
                    <ArrowLeft className="w-4 h-4" />
                  </button>
                  <DialogTitle className="text-black dark:text-white truncate">
                    {selectedDay
                      ? selectedDay.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })
                      : ""}
                  </DialogTitle>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button type="button" onClick={() => shiftDay(-1)} className="w-7 h-7 rounded-md hover:bg-black/5 dark:hover:bg-white/10 flex items-center justify-center transition-colors" title="Previous day">
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <button type="button" onClick={() => shiftDay(1)} className="w-7 h-7 rounded-md hover:bg-black/5 dark:hover:bg-white/10 flex items-center justify-center transition-colors" title="Next day">
                    <ChevronRight className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => openNewForm(selectedDay, "day")}
                    className="ml-1 inline-flex items-center gap-1 rounded-md bg-black text-white hover:bg-black/90 dark:bg-white dark:text-black dark:hover:bg-white/90 px-2.5 py-1 text-xs font-medium transition-colors"
                  >
                    <Plus className="w-3.5 h-3.5" /> Event
                  </button>
                </div>
              </div>
              <DialogDescription className="sr-only">Events for the selected day</DialogDescription>
            </DialogHeader>

            <div className="max-h-[60vh] overflow-y-auto -mx-1 px-1">
              {selectedDayEvents.length === 0 ? (
                <button
                  type="button"
                  onClick={() => openNewForm(selectedDay, "day")}
                  className="w-full rounded-lg border border-dashed border-black/10 dark:border-white/10 py-10 text-center text-sm text-black/40 dark:text-white/40 hover:bg-blue-500/5 transition-colors"
                >
                  Nothing scheduled. Click to add an event.
                </button>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {selectedDayEvents.map((ev) => {
                    const start = new Date(ev.starts_at);
                    const end = ev.ends_at ? new Date(ev.ends_at) : null;
                    return (
                      <button
                        key={ev.id}
                        type="button"
                        onClick={() => openEditForm(ev, "day")}
                        className="w-full text-left flex items-start gap-3 rounded-lg border border-black/5 dark:border-white/5 bg-white dark:bg-[#1f1d1d] p-3 hover:bg-blue-500/5 transition-colors"
                      >
                        <div className="w-16 flex-shrink-0 text-xs text-black/60 dark:text-white/60 pt-0.5">
                          {ev.all_day ? (
                            "All day"
                          ) : (
                            <>
                              <div>{fmtTime(start)}</div>
                              {end && <div className="opacity-60">{fmtTime(end)}</div>}
                            </>
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span
                              className="text-sm font-medium text-black dark:text-white truncate"
                              style={ev.color ? { color: ev.color } : undefined}
                            >
                              {ev.title}
                            </span>
                            {ev.read_only && (
                              <span className="flex-shrink-0 rounded-full bg-black/5 dark:bg-white/10 px-1.5 py-px text-[0.5625rem] font-medium uppercase tracking-wide text-black/45 dark:text-white/45">
                                {PROVIDER_SHORT[ev.external_provider] || "Synced"}
                              </span>
                            )}
                          </div>
                          {ev.location && (
                            <div className="mt-0.5 flex items-center gap-1 text-xs text-black/50 dark:text-white/50">
                              <MapPin className="w-3 h-3 flex-shrink-0" />
                              <span className="truncate">{ev.location}</span>
                            </div>
                          )}
                          {ev.description && (
                            <div className="mt-0.5 text-xs text-black/45 dark:text-white/45 truncate">
                              {ev.description}
                            </div>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}

        {panel === "calendar" && view === "sync" && (
          <>
            <DialogHeader>
              <div className="flex items-center gap-2 pr-6">
                <button type="button" onClick={() => setView("month")} className="w-7 h-7 rounded-md hover:bg-black/5 dark:hover:bg-white/10 flex items-center justify-center transition-colors" title="Back to month">
                  <ArrowLeft className="w-4 h-4" />
                </button>
                <DialogTitle className="text-black dark:text-white">Synced calendars</DialogTitle>
              </div>
              <DialogDescription className="sr-only">Connect Google and Apple calendars</DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-3">
              {/* Google Calendar */}
              <div className="rounded-xl border border-black/5 dark:border-white/10 bg-white dark:bg-[#1f1d1d] p-3">
                <div className="flex items-center gap-2">
                  <GoogleCalendarIcon />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-black dark:text-white">Google Calendar</div>
                    <div className="text-[0.6875rem] text-black/50 dark:text-white/50 truncate">
                      {googleConn
                        ? `Connected${googleConn.account_handle ? ` · ${googleConn.account_handle}` : ""} · ${relTime(googleConn.last_synced_at)}`
                        : "Not connected"}
                    </div>
                  </div>
                  {googleConn ? (
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button type="button" onClick={() => handleSyncConn(googleConn.id)} disabled={syncingId === googleConn.id} className="w-7 h-7 rounded-md hover:bg-black/5 dark:hover:bg-white/10 flex items-center justify-center text-black/60 dark:text-white/60 disabled:opacity-40" title="Sync now">
                        {syncingId === googleConn.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                      </button>
                      <button type="button" onClick={() => handleDisconnectConn(googleConn)} className="w-7 h-7 rounded-md hover:bg-red-500/10 flex items-center justify-center text-black/45 dark:text-white/45 hover:text-red-500" title="Disconnect">
                        <Unplug className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ) : (
                    <button type="button" onClick={handleGoogleConnect} disabled={connectingGoogle} className="inline-flex items-center gap-1 rounded-md bg-black text-white hover:bg-black/90 dark:bg-white dark:text-black dark:hover:bg-white/90 px-2.5 py-1 text-xs font-medium disabled:opacity-40">
                      {connectingGoogle ? <Loader2 className="w-3 h-3 animate-spin" /> : <ArrowUpRight className="w-3 h-3" />} Connect
                    </button>
                  )}
                </div>
                {!googleConn && (
                  <p className="mt-2 text-[0.625rem] text-black/40 dark:text-white/40">
                    Pre-verification, Google may show an &quot;unverified app&quot; screen — only Google Cloud test users connect cleanly for now.
                  </p>
                )}
              </div>

              {/* Apple Calendar */}
              <div className="rounded-xl border border-black/5 dark:border-white/10 bg-white dark:bg-[#1f1d1d] p-3">
                <div className="flex items-center gap-2">
                  <AppleCalendarIcon />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-black dark:text-white">Apple Calendar</div>
                    <div className="text-[0.6875rem] text-black/50 dark:text-white/50 truncate">
                      {appleConn
                        ? `Connected${appleConn.account_handle ? ` · ${appleConn.account_handle}` : ""} · ${relTime(appleConn.last_synced_at)}`
                        : "Not connected"}
                    </div>
                  </div>
                  {appleConn && (
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button type="button" onClick={() => handleSyncConn(appleConn.id)} disabled={syncingId === appleConn.id} className="w-7 h-7 rounded-md hover:bg-black/5 dark:hover:bg-white/10 flex items-center justify-center text-black/60 dark:text-white/60 disabled:opacity-40" title="Sync now">
                        {syncingId === appleConn.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                      </button>
                      <button type="button" onClick={() => handleDisconnectConn(appleConn)} className="w-7 h-7 rounded-md hover:bg-red-500/10 flex items-center justify-center text-black/45 dark:text-white/45 hover:text-red-500" title="Disconnect">
                        <Unplug className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </div>

                {!appleConn && (
                  <form onSubmit={handleAppleConnect} className="mt-2 flex flex-col gap-2">
                    <input
                      type="email"
                      autoComplete="off"
                      placeholder="Apple ID email (you@icloud.com)"
                      value={appleForm.email}
                      onChange={(e) => setAppleForm((f) => ({ ...f, email: e.target.value }))}
                      className={inputCls}
                    />
                    <div className="relative">
                      <input
                        type={appleReveal ? "text" : "password"}
                        autoComplete="off"
                        placeholder="App-specific password (abcd-efgh-ijkl-mnop)"
                        value={appleForm.password}
                        onChange={(e) => setAppleForm((f) => ({ ...f, password: e.target.value }))}
                        className={`${inputCls} pr-9`}
                      />
                      <button type="button" tabIndex={-1} onClick={() => setAppleReveal((r) => !r)} className="absolute right-2 top-1/2 -translate-y-1/2 h-6 w-6 rounded-md flex items-center justify-center text-black/45 dark:text-white/45 hover:text-black/80 dark:hover:text-white/80" title={appleReveal ? "Hide" : "Show"}>
                        {appleReveal ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <a href="https://appleid.apple.com/account/manage" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[0.625rem] text-black/50 dark:text-white/50 hover:underline">
                        <ExternalLink className="w-3 h-3" /> Create an app-specific password
                      </a>
                      <button type="submit" disabled={appleSaving} className="inline-flex items-center gap-1 rounded-md bg-black text-white hover:bg-black/90 dark:bg-white dark:text-black dark:hover:bg-white/90 px-2.5 py-1 text-xs font-medium disabled:opacity-40">
                        {appleSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <ArrowUpRight className="w-3 h-3" />} Connect
                      </button>
                    </div>
                    <p className="text-[0.625rem] text-black/40 dark:text-white/40">
                      Uses an app-specific password, never your Apple ID password. It&apos;s encrypted at rest and grants calendar read-only access.
                    </p>
                  </form>
                )}
              </div>

              <div className="flex items-start gap-1.5 text-[0.625rem] text-black/40 dark:text-white/40">
                <CheckCircle2 className="w-3 h-3 mt-px flex-shrink-0" />
                <span>One-way import. Synced events are read-only here — edit or delete them in Google/Apple and they update on the next sync.</span>
                {connLoading && <Loader2 className="w-3 h-3 animate-spin ml-auto" />}
              </div>
            </div>
          </>
        )}

        {panel === "calendar" && view === "form" && (
          <>
            <DialogHeader>
              <div className="flex items-center gap-2 pr-6">
                <button type="button" onClick={() => setView(formReturnTo)} className="w-7 h-7 rounded-md hover:bg-black/5 dark:hover:bg-white/10 flex items-center justify-center transition-colors" title="Back">
                  <ArrowLeft className="w-4 h-4" />
                </button>
                <DialogTitle className="text-black dark:text-white">
                  {form.readOnly ? "Event" : form.id ? "Edit event" : "New event"}
                </DialogTitle>
              </div>
              <DialogDescription className="sr-only">Add or edit a calendar event</DialogDescription>
            </DialogHeader>

            {form.readOnly && (
              <div className="flex items-start gap-2 rounded-lg bg-black/5 dark:bg-white/5 px-3 py-2 text-xs text-black/60 dark:text-white/60">
                <CalendarClock className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                <span>
                  Synced from {PROVIDER_LABEL[form.provider] || "an external calendar"}.
                  It's read-only here — edit it in {PROVIDER_LABEL[form.provider] || "that app"} and it updates on the next sync.
                </span>
              </div>
            )}

            <form onSubmit={handleSave} className="flex flex-col gap-3">
              <input
                autoFocus={!form.readOnly}
                type="text"
                placeholder="Event name"
                value={form.title}
                disabled={form.readOnly}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                className={`${inputCls} disabled:opacity-70`}
              />

              <label className="flex items-center gap-2 text-sm text-black/70 dark:text-white/70 select-none">
                <input
                  type="checkbox"
                  checked={form.allDay}
                  disabled={form.readOnly}
                  onChange={(e) => setForm((f) => ({ ...f, allDay: e.target.checked }))}
                  className="rounded border-gray-300 dark:border-gray-600"
                />
                All day
              </label>

              <div className="flex flex-wrap gap-2">
                <div className="flex-1 min-w-[8rem]">
                  <label className="block text-[0.625rem] uppercase tracking-wider text-black/40 dark:text-white/40 mb-1">Date</label>
                  <input
                    type="date"
                    value={form.date}
                    disabled={form.readOnly}
                    onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
                    className={`${inputCls} [color-scheme:dark] disabled:opacity-70`}
                  />
                </div>
                {!form.allDay && (
                  <>
                    <div className="w-24">
                      <label className="block text-[0.625rem] uppercase tracking-wider text-black/40 dark:text-white/40 mb-1">Start</label>
                      <input
                        type="time"
                        value={form.startTime}
                        disabled={form.readOnly}
                        onChange={(e) => setForm((f) => ({ ...f, startTime: e.target.value }))}
                        className={`${inputCls} [color-scheme:dark] disabled:opacity-70`}
                      />
                    </div>
                    <div className="w-24">
                      <label className="block text-[0.625rem] uppercase tracking-wider text-black/40 dark:text-white/40 mb-1">End</label>
                      <input
                        type="time"
                        value={form.endTime}
                        disabled={form.readOnly}
                        onChange={(e) => setForm((f) => ({ ...f, endTime: e.target.value }))}
                        className={`${inputCls} [color-scheme:dark] disabled:opacity-70`}
                      />
                    </div>
                  </>
                )}
              </div>

              <div className="flex items-center gap-2">
                <MapPin className="w-4 h-4 text-black/40 dark:text-white/40 flex-shrink-0" />
                <input
                  type="text"
                  placeholder="Location or link (optional)"
                  value={form.location}
                  disabled={form.readOnly}
                  onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))}
                  className={`${inputCls} disabled:opacity-70`}
                />
              </div>

              <textarea
                placeholder="Notes (optional)"
                value={form.description}
                disabled={form.readOnly}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                rows={3}
                className={`${inputCls} resize-none disabled:opacity-70`}
              />

              {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}

              <div className="flex items-center justify-between pt-1">
                {form.readOnly ? (
                  <>
                    <span className="text-[0.625rem] text-black/40 dark:text-white/40">
                      {PROVIDER_LABEL[form.provider] || "Synced calendar"}
                    </span>
                    <button
                      type="button"
                      onClick={() => setView(formReturnTo)}
                      className="inline-flex items-center justify-center rounded-lg bg-black text-white hover:bg-black/90 dark:bg-white dark:text-black dark:hover:bg-white/90 px-4 py-2 text-sm font-medium transition-colors"
                    >
                      Close
                    </button>
                  </>
                ) : (
                  <>
                    {form.id ? (
                      <button
                        type="button"
                        onClick={handleDelete}
                        disabled={saving}
                        className="inline-flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400 hover:underline disabled:opacity-40"
                      >
                        <Trash2 className="w-3.5 h-3.5" /> Delete
                      </button>
                    ) : (
                      <span className="text-[0.625rem] text-black/40 dark:text-white/40 inline-flex items-center gap-1">
                        <Clock className="w-3 h-3" /> {LOCAL_TZ || "local time"}
                      </span>
                    )}
                    <button
                      type="submit"
                      disabled={saving || !form.title.trim()}
                      className="inline-flex items-center justify-center gap-2 rounded-lg bg-black text-white hover:bg-black/90 dark:bg-white dark:text-black dark:hover:bg-white/90 px-4 py-2 text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                      {form.id ? "Save changes" : "Add event"}
                    </button>
                  </>
                )}
              </div>
            </form>
          </>
        )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
