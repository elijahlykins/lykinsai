import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Bell, Calendar, ChevronDown, ChevronUp, Clock, MessageSquare, Plus, Sparkles, StickyNote, Upload, Users, X, Zap } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/SupabaseAuth";
import ProjectGrid from "@/components/ProjectGrid";
import DraggableChat from "@/components/notes/DraggableChat";
import DraggableQuickNote from "@/components/notes/DraggableQuickNote";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import createButtonBackground from "@/assets/Colored.jpg";
import { getAiPrefs } from "@/lib/ai-prefs";

type Project = {
  id: string;
  name: string;
  created_at?: string | null;
  updated_at?: string | null;
  cover_image_url?: string | null;
  image_url?: string | null;
  thumbnail_url?: string | null;
  coverImage?: string | null;
  image?: string | null;
  thumbnail?: string | null;
};

const EVENTS_STORAGE_KEY = "lykinsai_calendar_events";
const DISMISSED_REMINDERS_KEY = "lykinsai_dismissed_reminders";
const PROJECTS_CHANGED_EVENT = "lykinsai_projects_changed";

type CalendarEvent = {
  id: string;
  title: string;
  description?: string;
  date_key: string;
  start_hour: number;
  end_hour: number;
  reminder?: string;
  preset_id?: string;
};

function loadCalendarEvents(): CalendarEvent[] {
  try {
    const raw = localStorage.getItem(EVENTS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function loadDismissedReminders(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_REMINDERS_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

function saveDismissedReminders(ids: Set<string>) {
  try {
    localStorage.setItem(DISMISSED_REMINDERS_KEY, JSON.stringify([...ids]));
  } catch {}
}

function formatHour(h: number): string {
  const hours = Math.floor(h);
  const mins = Math.round((h - hours) * 60);
  const suffix = hours >= 12 ? "PM" : "AM";
  const display = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
  return `${display}:${String(mins).padStart(2, "0")} ${suffix}`;
}

function CalendarReminders() {
  const [activeReminders, setActiveReminders] = useState<CalendarEvent[]>([]);
  const dismissed = useRef(loadDismissedReminders());
  const nav = useNavigate();

  const checkReminders = useCallback(() => {
    const events = loadCalendarEvents();
    const now = new Date();
    const due: CalendarEvent[] = [];

    for (const evt of events) {
      if (!evt.reminder || evt.reminder === "none") continue;
      if (dismissed.current.has(evt.id)) continue;

      const [y, m, d] = evt.date_key.split("-").map(Number);
      const eventStart = new Date(y, m - 1, d);
      const startMinutes = evt.start_hour * 60;
      eventStart.setHours(Math.floor(startMinutes / 60), startMinutes % 60, 0, 0);

      const reminderMinutes = parseInt(evt.reminder, 10);
      if (isNaN(reminderMinutes)) continue;

      const reminderTime = new Date(eventStart.getTime() - reminderMinutes * 60_000);
      const expiry = new Date(eventStart.getTime() + 15 * 60_000);

      if (now >= reminderTime && now <= expiry) {
        due.push(evt);
      }
    }

    setActiveReminders(due);
  }, []);

  useEffect(() => {
    checkReminders();
    const interval = setInterval(checkReminders, 30_000);
    const handleChange = () => checkReminders();
    window.addEventListener("calendar_events_changed", handleChange);
    window.addEventListener("storage", handleChange);
    return () => {
      clearInterval(interval);
      window.removeEventListener("calendar_events_changed", handleChange);
      window.removeEventListener("storage", handleChange);
    };
  }, [checkReminders]);

  const dismiss = (id: string) => {
    dismissed.current.add(id);
    saveDismissedReminders(dismissed.current);
    setActiveReminders((prev) => prev.filter((e) => e.id !== id));
  };

  if (activeReminders.length === 0) return null;

  return (
    <div className="fixed top-16 right-6 z-[90] flex flex-col gap-2 max-w-sm w-full">
      {activeReminders.map((evt) => (
        <div
          key={evt.id}
          className="flex items-start gap-3 glass-control rounded-xl border border-white/25 dark:border-white/10 bg-white/60 dark:bg-black/40 backdrop-blur-xl shadow-lg p-3 animate-slide-in-right cursor-pointer"
          onClick={() => nav("/calendar")}
        >
          <div className="shrink-0 w-8 h-8 rounded-full bg-blue-500/20 flex items-center justify-center">
            <Bell className="w-4 h-4 text-blue-600 dark:text-blue-400" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[0.75rem] font-semibold text-black/80 dark:text-white/80 truncate">
              {evt.title}
            </p>
            <p className="text-[0.6875rem] text-black/50 dark:text-white/50 mt-0.5">
              {evt.date_key} &middot; {formatHour(evt.start_hour)} – {formatHour(evt.end_hour)}
            </p>
            <p className="text-[0.625rem] text-blue-600 dark:text-blue-400 font-medium mt-1 flex items-center gap-1">
              <Clock className="w-3 h-3" /> Upcoming event reminder
            </p>
          </div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              dismiss(evt.id);
            }}
            className="shrink-0 p-1 rounded-full hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
          >
            <X className="w-3.5 h-3.5 text-black/40 dark:text-white/40" />
          </button>
        </div>
      ))}
    </div>
  );
}

const BUSYNESS_LEVELS = [
  { max: 0, label: "Free", color: "rgba(34,197,94,0.85)", bg: "rgba(34,197,94,0.12)" },
  { max: 2, label: "Light", color: "rgba(132,204,22,0.85)", bg: "rgba(132,204,22,0.12)" },
  { max: 4, label: "Busy", color: "rgba(245,158,11,0.85)", bg: "rgba(245,158,11,0.12)" },
  { max: 7.99, label: "Very Busy", color: "rgba(239,115,54,0.85)", bg: "rgba(239,115,54,0.12)" },
  { max: Infinity, label: "Fully Booked", color: "rgba(239,68,68,0.85)", bg: "rgba(239,68,68,0.12)" },
];

function getBusyness(dayEvents: CalendarEvent[]) {
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

function getTodayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function CalendarDayInfo() {
  const [events, setEvents] = useState<CalendarEvent[]>(() => loadCalendarEvents());
  const [countdown, setCountdown] = useState("");
  const [nextTitle, setNextTitle] = useState("");
  const [timeStr, setTimeStr] = useState(() =>
    new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })
  );
  const nav = useNavigate();

  const todayKey = useMemo(() => getTodayKey(), []);

  const todayEvents = useMemo(
    () => events.filter((e) => e.date_key === todayKey).sort((a, b) => a.start_hour - b.start_hour),
    [events, todayKey]
  );

  const busyness = useMemo(() => getBusyness(todayEvents), [todayEvents]);

  useEffect(() => {
    const refresh = () => setEvents(loadCalendarEvents());
    window.addEventListener("calendar_events_changed", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("calendar_events_changed", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  useEffect(() => {
    const tick = () =>
      setTimeStr(new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true }));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const compute = () => {
      const now = new Date();
      const nowMin = now.getHours() * 60 + now.getMinutes();
      let closest: CalendarEvent | null = null;
      let closestDiff = Infinity;

      for (const evt of events) {
        const evtMin = (evt.start_hour ?? 0) * 60;
        let diff: number;
        if (evt.date_key === todayKey) {
          diff = evtMin - nowMin;
        } else if (evt.date_key > todayKey) {
          const [ey, em, ed] = evt.date_key.split("-").map(Number);
          const evtDate = new Date(ey, em - 1, ed);
          const todayDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          const dayDiff = Math.round((evtDate.getTime() - todayDate.getTime()) / 86400000);
          diff = dayDiff * 1440 + evtMin - nowMin;
        } else {
          continue;
        }
        if (diff > 0 && diff < closestDiff) {
          closestDiff = diff;
          closest = evt;
        }
      }

      if (!closest) {
        setCountdown("");
        setNextTitle("");
        return;
      }

      const hours = Math.floor(closestDiff / 60);
      const mins = closestDiff % 60;
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
      setCountdown(text);
      setNextTitle(closest.title);
    };

    compute();
    const id = setInterval(compute, 30_000);
    return () => clearInterval(id);
  }, [events, todayKey]);

  const dateStr = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  return (
    <div
      className="rounded-2xl border border-white/25 dark:border-white/10 bg-white/30 dark:bg-white/5 backdrop-blur-xl shadow-md p-4 cursor-pointer hover:shadow-lg transition-shadow"
      onClick={() => nav("/calendar")}
    >
      <div className="flex items-center gap-2 mb-2">
        <Calendar className="w-4 h-4 text-black/50 dark:text-white/50" />
        <span className="text-sm font-semibold text-black/80 dark:text-white/80">{dateStr}</span>
        <span className="text-sm font-medium text-black/45 dark:text-white/45 tabular-nums">{timeStr}</span>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <span
          className="inline-flex items-center gap-1.5 text-[0.6875rem] font-semibold px-2.5 py-1 rounded-full"
          style={{ color: busyness.color, background: busyness.bg }}
        >
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: busyness.color }} />
          {busyness.label}
        </span>

        <span className="text-[0.6875rem] text-black/50 dark:text-white/50">
          {todayEvents.length} event{todayEvents.length !== 1 ? "s" : ""} today
        </span>

        {countdown && (
          <span className="inline-flex items-center gap-1.5 text-[0.6875rem] font-medium text-blue-600/80 dark:text-blue-400/80">
            <Clock className="w-3 h-3" />
            {countdown} until {nextTitle}
          </span>
        )}
      </div>
    </div>
  );
}

const DAY_STATUS_KEY = "lykinsai_day_statuses";


function AISuggestions({ projects, events, model }: { projects: Project[]; events: CalendarEvent[]; model: string }) {
  const [tips, setTips] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const didFetch = useRef(false);
  const todayKey = useMemo(() => getTodayKey(), []);

  useEffect(() => {
    if (didFetch.current) return;
    didFetch.current = true;

    const todayEvents = events
      .filter((e) => e.date_key === todayKey)
      .sort((a, b) => a.start_hour - b.start_hour);
    const upcomingEvents = events
      .filter((e) => e.date_key >= todayKey)
      .sort((a, b) => a.date_key.localeCompare(b.date_key) || a.start_hour - b.start_hour)
      .slice(0, 10);

    let dayStatusLabel = "Normal";
    try {
      const raw = localStorage.getItem(DAY_STATUS_KEY);
      const map = raw ? JSON.parse(raw) : {};
      const id = map[todayKey];
      if (id && id !== "normal") {
        const labels: Record<string, string> = { ooo: "Out of Office", sick: "Sick", vacation: "Vacation", personal: "Personal", holiday: "Holiday", leave: "Leave", deadline: "Deadline", travel: "Travel", training: "Training", conference: "Conference", launch: "Launch", review: "Review", planning: "Planning", maintenance: "Maintenance" };
        dayStatusLabel = labels[id] || "Normal";
      }
    } catch {}

    const projectNames = projects.slice(0, 8).map((p) => p.name);
    const recentProject = [...projects].sort((a, b) => (b.updated_at || b.created_at || "").localeCompare(a.updated_at || a.created_at || ""))[0];

    const eventSummary = todayEvents.length > 0
      ? todayEvents.map((e) => `${formatHour(e.start_hour)}-${formatHour(e.end_hour)}: ${e.title}`).join("; ")
      : "No events today";

    const upcomingSummary = upcomingEvents
      .filter((e) => e.date_key !== todayKey)
      .slice(0, 5)
      .map((e) => `${e.date_key} ${formatHour(e.start_hour)}: ${e.title}`)
      .join("; ");

    const prompt = `You are a productivity AI assistant inside a creative workspace app. Based on the user's current context, give exactly 5 short, actionable suggestions (1 sentence each). Be specific and personal — reference their actual projects and events by name.

Context:
- Date: ${todayKey} (${new Date().toLocaleDateString("en-US", { weekday: "long" })})
- Day status: ${dayStatusLabel}
- Today's events: ${eventSummary}
- Upcoming events: ${upcomingSummary || "None"}
- Projects (${projects.length} total): ${projectNames.join(", ") || "None"}
- Most recently worked on: ${recentProject?.name || "None"}

Return ONLY a JSON array of 5 strings. No markdown, no explanation.`;

    (async () => {
      try {
        const { API_BASE_URL } = await import("@/lib/api-config");
        const res = await fetch(`${API_BASE_URL}/api/ai/invoke`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model, prompt, ...getAiPrefs() }),
        });
        if (!res.ok) throw new Error("fail");
        const data = await res.json().catch(() => ({}));
        const text = String(data.response || "").trim();
        const match = text.match(/\[[\s\S]*\]/);
        if (match) {
          const parsed = JSON.parse(match[0]);
          if (Array.isArray(parsed)) {
            setTips(parsed.map(String).slice(0, 6));
            setLoading(false);
            return;
          }
        }
        const lines = text.split("\n").map((l: string) => l.replace(/^\d+[\.\)]\s*/, "").replace(/^[-•*]\s*/, "").trim()).filter(Boolean);
        if (lines.length > 0) {
          setTips(lines.slice(0, 6));
          setLoading(false);
          return;
        }
        throw new Error("parse fail");
      } catch {
        setTips([
          "Review your upcoming events and prepare materials",
          "Focus on your most recent project first",
          "Block out deep work time on your calendar",
          "Check in with team members on shared events",
          "Plan tomorrow's priorities before end of day",
        ]);
        setLoading(false);
      }
    })();
  }, [events, projects, model, todayKey]);

  return (
    <div className="rounded-2xl border border-white/25 dark:border-white/10 bg-white/30 dark:bg-white/5 backdrop-blur-xl shadow-md">
      <div className="flex items-center gap-2 px-4 pt-4 pb-3">
        <Sparkles className="w-4 h-4 text-amber-500/70" />
        <h3 className="text-sm font-semibold text-black/70 dark:text-white/70">AI Suggestions</h3>
      </div>
      <div className="px-4 pb-4">
        {loading ? (
          <div className="space-y-3 py-1">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="flex items-start gap-2">
                <span className="text-black/15 dark:text-white/15 mt-px shrink-0">•</span>
                <div className="h-3 rounded-full bg-black/[0.06] dark:bg-white/[0.06] animate-pulse" style={{ width: `${60 + Math.random() * 30}%` }} />
              </div>
            ))}
          </div>
        ) : (
          <ul className="space-y-3">
            {tips.map((tip, i) => (
              <li key={i} className="flex items-start gap-2 text-[0.6875rem] text-black/55 dark:text-white/55 leading-relaxed">
                <span className="text-black/30 dark:text-white/30 mt-px shrink-0">•</span>
                <span>{tip}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function AISuggestionsPanel({ projects, events, model }: { projects: Project[]; events: CalendarEvent[]; model: string }) {
  return (
    <div className="hidden lg:block w-[15.625rem] shrink-0 sticky top-24">
      <AISuggestions projects={projects} events={events} model={model} />
    </div>
  );
}

const PROJECT_CARD_IMAGES_KEY = "omnia_project_card_images";

function loadProjectCardImages(): Record<string, string> {
  try {
    const raw = localStorage.getItem(PROJECT_CARD_IMAGES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

export default function Dashboard() {
  const nav = useNavigate();
  const { user, loading } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [topPanelOpen, setTopPanelOpen] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [showQuickNote, setShowQuickNote] = useState(false);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [quickNoteTitle, setQuickNoteTitle] = useState("");
  const [quickNoteContent, setQuickNoteContent] = useState("");
  const [isQuickNoteSaving, setIsQuickNoteSaving] = useState(false);
  const [aiEvents, setAiEvents] = useState<CalendarEvent[]>(() => loadCalendarEvents());
  const [teamsByProject, setTeamsByProject] = useState<Record<string, { id: string; name: string; color: string }[]>>({});
  const assistantIndexRef = useRef<number | null>(null);
  const [selectedModel, setSelectedModel] = useState(() => {
    try {
      const saved = localStorage.getItem("lykinsai_settings");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.aiModel) {
          return parsed.aiModel;
        }
      }
    } catch {
      // ignore
    }
    return "gemini-flash-latest";
  });
  const [liveAIMode, setLiveAIMode] = useState(() => {
    try {
      const saved = localStorage.getItem("lykinsai_settings");
      if (saved) {
        const parsed = JSON.parse(saved);
        return Boolean(parsed.liveAIMode);
      }
    } catch {
      // ignore
    }
    return false;
  });

  const greetingName = useMemo(() => {
    const name = user?.user_metadata?.name || user?.email || "there";
    return String(name).split("@")[0];
  }, [user?.email, user?.user_metadata?.name]);

  const userInitials = useMemo(() => {
    const source = String(user?.user_metadata?.name || user?.email || "").trim();
    if (!source) return "?";
    const cleaned = source.split("@")[0];
    const parts = cleaned.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return `${parts[0][0] || ""}${parts[1][0] || ""}`.toUpperCase();
    return cleaned.slice(0, 2).toUpperCase();
  }, [user?.email, user?.user_metadata?.name]);

  useEffect(() => {
    const refreshEvents = () => setAiEvents(loadCalendarEvents());
    window.addEventListener("calendar_events_changed", refreshEvents);
    window.addEventListener("storage", refreshEvents);
    return () => {
      window.removeEventListener("calendar_events_changed", refreshEvents);
      window.removeEventListener("storage", refreshEvents);
    };
  }, []);

  useEffect(() => {
    const handleSettingsChange = () => {
      try {
        const saved = localStorage.getItem("lykinsai_settings");
        if (saved) {
          const parsed = JSON.parse(saved);
          if (parsed.aiModel) {
            setSelectedModel(parsed.aiModel);
          }
          if (typeof parsed.liveAIMode !== "undefined") {
            setLiveAIMode(Boolean(parsed.liveAIMode));
          }
        }
      } catch {
        // ignore
      }
    };
    window.addEventListener("lykinsai_settings_changed", handleSettingsChange);
    window.addEventListener("storage", handleSettingsChange);
    return () => {
      window.removeEventListener("lykinsai_settings_changed", handleSettingsChange);
      window.removeEventListener("storage", handleSettingsChange);
    };
  }, []);

  const handleChatSend = async () => {
    const text = chatInput.trim();
    if (!text || isChatLoading) return;

    setChatInput("");
    setIsChatLoading(true);

    setChatMessages((prev) => {
      const idx = prev.length + 1;
      assistantIndexRef.current = idx;
      return [...prev, { role: "user", content: text }, { role: "assistant", content: "" }];
    });

    try {
      const history = chatMessages
        .slice(-12)
        .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
        .join("\n");

      const prompt = `You are an AI assistant inside a creative workspace app.
Be concise, helpful, and practical.

Conversation so far:
${history || "(none)"}

User: ${text}
`;

      const { API_BASE_URL } = await import("@/lib/api-config");
      const res = await fetch(`${API_BASE_URL}/api/ai/invoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: selectedModel, prompt, ...getAiPrefs() }),
      });
      if (!res.ok) throw new Error("AI request failed");
      const data = await res.json().catch(() => ({}));
      const aiText = String(data.response || "").trim();

      const idx = assistantIndexRef.current;
      if (idx == null) return;

      const words = aiText.split(" ").filter(Boolean);
      if (words.length === 0) {
        setChatMessages((prev) => {
          const next = prev.slice();
          if (next[idx]) next[idx] = { ...next[idx], content: aiText };
          return next;
        });
      } else {
        let i = 0;
        let cur = "";
        const tick = () => {
          cur += (i === 0 ? "" : " ") + words[i];
          i += 1;
          setChatMessages((prev) => {
            const next = prev.slice();
            if (next[idx]) next[idx] = { ...next[idx], content: cur };
            return next;
          });
          if (i < words.length) window.setTimeout(tick, 18);
        };
        tick();
      }
    } catch {
      const idx = assistantIndexRef.current;
      if (idx != null) {
        setChatMessages((prev) => {
          const next = prev.slice();
          if (next[idx]) next[idx] = { ...next[idx], content: "Sorry - the AI request failed. Please try again." };
          return next;
        });
      }
    } finally {
      setIsChatLoading(false);
    }
  };

  const fetchProjects = async (currentUserId: string) => {
    const imageMap = loadProjectCardImages();
    const { data } = await supabase
      .from("omnia_projects")
      .select("id, name, created_at, updated_at")
      .eq("user_id", currentUserId)
      .order("updated_at", { ascending: false });
    const list = ((data as Project[]) || []).map((project) => ({
      ...project,
      image: imageMap[project.id] || project.image || null,
    }));
    setProjects(list);
  };

  const handleRenameProject = async (project: Project, name: string) => {
    if (!user?.id) return;
    await supabase
      .from("omnia_projects")
      .update({ name })
      .eq("id", project.id)
      .eq("user_id", user.id);
    await fetchProjects(user.id);
    window.dispatchEvent(new CustomEvent(PROJECTS_CHANGED_EVENT));
  };

  const handleDeleteProject = async (project: Project) => {
    if (!user?.id) return;
    await supabase
      .from("omnia_projects")
      .delete()
      .eq("id", project.id)
      .eq("user_id", user.id);
    await fetchProjects(user.id);
    window.dispatchEvent(new CustomEvent(PROJECTS_CHANGED_EVENT));
  };

  useEffect(() => {
    if (loading) return;
    if (!user) {
      setProjects([]);
      return;
    }
    let cancelled = false;
    const run = async () => {
      if (cancelled) return;
      await fetchProjects(user.id);
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [loading, nav, user]);

  const TEAM_ACCENT_COLORS = ["#3B82F6", "#16A34A", "#D97706", "#DC2626", "#7C3AED", "#DB2777", "#0F766E"];

  useEffect(() => {
    let active = true;

    const loadFromLocal = (): any[] => {
      try {
        const raw = localStorage.getItem("lykinsai_teamspaces");
        return raw ? JSON.parse(raw) : [];
      } catch {
        return [];
      }
    };

    const buildMap = (teams: any[]) => {
      const map: Record<string, { id: string; name: string; color: string }[]> = {};
      for (const t of teams) {
        const color = TEAM_ACCENT_COLORS[(t.id?.charCodeAt?.(0) ?? 0) % TEAM_ACCENT_COLORS.length];
        for (const p of (t.projects || [])) {
          if (!map[p.id]) map[p.id] = [];
          map[p.id].push({ id: t.id, name: t.name, color });
        }
      }
      return map;
    };

    const loadTeamMap = async () => {
      if (!user?.id) {
        if (active) setTeamsByProject(buildMap(loadFromLocal()));
        return;
      }
      try {
        const { data, error } = await supabase
          .from("team_spaces")
          .select("id, name, projects")
          .eq("owner_id", user.id);
        if (!active) return;
        if (error || !data || data.length === 0) {
          setTeamsByProject(buildMap(loadFromLocal()));
          return;
        }
        setTeamsByProject(buildMap(data));
      } catch {
        if (active) setTeamsByProject(buildMap(loadFromLocal()));
      }
    };
    loadTeamMap();
    return () => { active = false; };
  }, [user?.id, projects]);

  const handleCreateProject = async () => {
    if (!user || isCreatingProject) return;
    setIsCreatingProject(true);
    try {
      const { data: project } = await supabase
        .from("omnia_projects")
        .insert({ user_id: user.id, name: "New Project" })
        .select("id, name, created_at, updated_at")
        .single();
      const projectId = project?.id;
      if (!projectId) {
        return;
      }
      await fetchProjects(user.id);
      window.dispatchEvent(new CustomEvent(PROJECTS_CHANGED_EVENT));
      nav(`/project/${projectId}`);
    } finally {
      setIsCreatingProject(false);
    }
  };

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
      // Keep the card open if saving fails.
    } finally {
      setIsQuickNoteSaving(false);
    }
  };

  const hasNoProjects = projects.length === 0;

  const [setupDismissed, setSetupDismissed] = useState(() => {
    try { return localStorage.getItem("lykinsai_setup_dismissed") === "1"; } catch { return false; }
  });
  const [setupConfirmingSkip, setSetupConfirmingSkip] = useState(false);
  const [calendarVisited, setCalendarVisited] = useState(() => {
    try { return localStorage.getItem("lykinsai_calendar_visited") === "1"; } catch { return false; }
  });
  const showSetup = !setupDismissed;

  const dismissSetup = () => {
    setSetupDismissed(true);
    setSetupConfirmingSkip(false);
    try { localStorage.setItem("lykinsai_setup_dismissed", "1"); } catch {}
  };

  const handleCalendarNav = () => {
    try { localStorage.setItem("lykinsai_calendar_visited", "1"); } catch {}
    setCalendarVisited(true);
    nav("/calendar");
  };

  return (
      <div
        className="min-h-screen bg-transparent text-black relative overflow-x-hidden"
      >
        <div className="fixed top-3 left-0 right-0 z-[70] px-3 flex items-center justify-end pointer-events-none">
          <div className="pointer-events-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => setTopPanelOpen((v) => !v)}
              className="rounded-full w-8 h-8 glass-control hover:opacity-90 touch-manipulation flex items-center justify-center"
              title={topPanelOpen ? "Hide panel" : "Show panel"}
            >
              {topPanelOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              <span className="sr-only">{topPanelOpen ? "Hide panel" : "Show panel"}</span>
            </button>

            {topPanelOpen && (
              <div className="flex h-9 items-center gap-1 p-0.5 rounded-full glass-control flex-wrap">
                <Select
                  value={selectedModel}
                  onValueChange={(value) => {
                    setSelectedModel(value);
                    try {
                      const saved = localStorage.getItem("lykinsai_settings");
                      const settings = saved ? JSON.parse(saved) : {};
                      settings.aiModel = value;
                      localStorage.setItem("lykinsai_settings", JSON.stringify(settings));
                      window.dispatchEvent(new CustomEvent("lykinsai_settings_changed"));
                    } catch {
                      // ignore
                    }
                  }}
                >
                  <SelectTrigger className="w-[7.75rem] !h-7 rounded-full glass-control hover:opacity-90 text-[0.6875rem] font-medium px-2">
                    <SelectValue placeholder="Model" />
                  </SelectTrigger>
                  <SelectContent
                    align="end"
                    className="glass-control border border-white/25 dark:border-white/10 bg-white/35 dark:bg-white/10 backdrop-blur-xl shadow-lg overflow-hidden"
                  >
                    <SelectItem value="gpt-5.2">GPT-5.2 (Latest)</SelectItem>
                    <SelectItem value="gpt-5.1">GPT-5.1</SelectItem>
                    <SelectItem value="gpt-5">GPT-5</SelectItem>
                    <SelectItem value="gpt-4o">GPT-4o</SelectItem>
                    <SelectItem value="gpt-4o-mini">GPT-4o Mini</SelectItem>
                    <SelectItem value="gpt-4-turbo">GPT-4 Turbo</SelectItem>
                    <SelectItem value="gpt-4">GPT-4</SelectItem>
                    <SelectItem value="gpt-3.5-turbo">GPT-3.5 Turbo</SelectItem>
                    <SelectItem value="claude-opus-4-1-20250805">Claude Opus 4.1</SelectItem>
                    <SelectItem value="claude-opus-4-20250514">Claude Opus 4</SelectItem>
                    <SelectItem value="claude-sonnet-4-20250514">Claude Sonnet 4</SelectItem>
                    <SelectItem value="claude-haiku-4-5-20251001">Claude Haiku 4.5</SelectItem>
                    <SelectItem value="gemini-3.1-pro-preview">Gemini 3.1 Pro (Preview)</SelectItem>
                    <SelectItem value="gemini-3-pro-preview">Gemini 3 Pro (Preview)</SelectItem>
                    <SelectItem value="gemini-3-flash-preview">Gemini 3 Flash (Preview)</SelectItem>
                    <SelectItem value="gemini-2.5-pro">Gemini 2.5 Pro</SelectItem>
                    <SelectItem value="gemini-2.5-flash">Gemini 2.5 Flash</SelectItem>
                    <SelectItem value="gemini-2.5-flash-lite">Gemini 2.5 Flash-Lite</SelectItem>
                    <SelectItem value="gemini-2.5-flash-image-preview">Gemini 2.5 Flash Image</SelectItem>
                    <SelectItem value="gemini-2.5-flash-live-preview">Gemini 2.5 Flash Live</SelectItem>
                    <SelectItem value="gemini-2.0-flash">Gemini 2.0 Flash</SelectItem>
                    <SelectItem value="gemini-2.0-flash-lite">Gemini 2.0 Flash-Lite</SelectItem>
                    <SelectItem value="grok-4-1-fast-reasoning">Grok 4.1 Fast Reasoning</SelectItem>
                    <SelectItem value="grok-4-1-fast-non-reasoning">Grok 4.1 Fast Non-Reasoning</SelectItem>
                    <SelectItem value="grok-code-fast-1">Grok Code Fast 1</SelectItem>
                    <SelectItem value="grok-4-fast-reasoning">Grok 4 Fast Reasoning</SelectItem>
                    <SelectItem value="grok-4-fast-non-reasoning">Grok 4 Fast Non-Reasoning</SelectItem>
                    <SelectItem value="grok-4-0709">Grok 4 0709</SelectItem>
                    <SelectItem value="grok-3-mini">Grok 3 Mini</SelectItem>
                    <SelectItem value="grok-3">Grok 3</SelectItem>
                    <SelectItem value="grok-2-vision-1212">Grok 2 Vision 1212</SelectItem>
                    <SelectItem value="grok-imagine-image-pro">Grok Imagine Image Pro</SelectItem>
                    <SelectItem value="grok-imagine-image">Grok Imagine Image</SelectItem>
                    <SelectItem value="grok-2-image-1212">Grok 2 Image 1212</SelectItem>
                    <SelectItem value="grok-imagine-video">Grok Imagine Video</SelectItem>
                    <SelectItem value="unified-auto">Unified AI (Auto)</SelectItem>
                  </SelectContent>
                </Select>

                
              </div>
            )}
          </div>
        </div>

        <main className="relative z-20 mx-auto max-w-6xl px-6 pt-24 pb-16">
          <section className="flex items-start gap-4 flex-wrap">
            <div className="flex-1 min-w-[15rem] space-y-2">
              <h1 className="text-3xl font-semibold">Welcome back, {greetingName}</h1>
              <p className="text-black/60">Your creative workspace is ready.</p>
              <button
                type="button"
                onClick={handleCreateProject}
                disabled={isCreatingProject}
                className="mt-4 inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold text-white hover:opacity-90 transition-all"
                style={{ background: "#3b82f6", boxShadow: "0 1px 3px rgba(59,130,246,0.3)" }}
                aria-label="Create new project"
              >
                <Plus className="w-4 h-4" />
                {isCreatingProject ? "Creating..." : "Create New Project"}
              </button>
            </div>
            {calendarVisited && !hasNoProjects && (
              <div className="w-full sm:w-auto sm:min-w-[21.25rem] sm:max-w-[26.25rem]">
                <CalendarDayInfo />
              </div>
            )}
          </section>

          {showSetup && (
            <section className="mt-6 space-y-3">
              <div className="relative rounded-2xl border border-white/30 bg-white/35 dark:bg-white/5 backdrop-blur-xl shadow-md p-6 sm:p-8">
                {setupConfirmingSkip ? (
                  <div className="absolute top-4 right-4 flex items-center gap-2 rounded-xl bg-white/60 dark:bg-black/40 backdrop-blur-md border border-white/40 dark:border-white/10 px-3 py-2 shadow-lg z-10">
                    <span className="text-xs font-medium text-black/70 dark:text-white/70">Skip setup?</span>
                    <button
                      type="button"
                      onClick={dismissSetup}
                      className="text-xs font-semibold text-red-500 hover:text-red-600 px-2 py-0.5 rounded-md hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors"
                    >
                      Yes, skip
                    </button>
                    <button
                      type="button"
                      onClick={() => setSetupConfirmingSkip(false)}
                      className="text-xs font-semibold text-black/50 dark:text-white/50 hover:text-black/70 dark:hover:text-white/70 px-2 py-0.5 rounded-md hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setSetupConfirmingSkip(true)}
                    className="absolute top-4 right-4 text-xs font-medium text-black/35 dark:text-white/35 hover:text-black/60 dark:hover:text-white/60 px-2 py-1 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                  >
                    Skip setup
                  </button>
                )}
                <div className="inline-flex items-center gap-2 rounded-full bg-blue-500/10 text-blue-600 px-3 py-1 text-xs font-semibold">
                  <Sparkles className="w-3.5 h-3.5" />
                  First-Time Setup
                </div>
                <h2 className="mt-4 text-2xl sm:text-3xl font-semibold text-black/85 dark:text-white/85">
                  Let&apos;s set up your LYKN workspace
                </h2>
                <p className="mt-2 text-sm sm:text-base text-black/60 dark:text-white/60 max-w-2xl">
                  Create your foundation, bring in your content, and connect your workflow.
                  <br />
                  <span className="text-black/45 dark:text-white/45">Takes less than 2 minutes.</span>
                </p>

                <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={handleCreateProject}
                    disabled={isCreatingProject}
                    className={`rounded-xl border p-4 text-left transition-all ${!hasNoProjects ? "border-green-400/40 bg-green-50/40 dark:bg-green-900/10" : "border-white/40 bg-white/45 dark:bg-white/10 hover:bg-white/60"}`}
                  >
                    <div className="flex items-center gap-2 text-sm font-semibold text-black/80 dark:text-white/80">
                      <span className={`flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold shrink-0 ${!hasNoProjects ? "bg-green-500/20 text-green-600" : "bg-blue-500/10 text-blue-600"}`}>
                        {!hasNoProjects ? "\u2713" : "1"}
                      </span>
                      Create Your First Project
                    </div>
                    <p className="mt-2 text-xs text-black/55 dark:text-white/55 pl-8">Start a workspace for your notes, docs, and AI collaboration.</p>
                  </button>
                  <button
                    type="button"
                    onClick={() => nav("/memory")}
                    className="rounded-xl border border-white/40 bg-white/45 dark:bg-white/10 p-4 text-left hover:bg-white/60 transition-all"
                  >
                    <div className="flex items-center gap-2 text-sm font-semibold text-black/80 dark:text-white/80">
                      <span className="flex items-center justify-center w-6 h-6 rounded-full bg-blue-500/10 text-blue-600 text-xs font-bold shrink-0">2</span>
                      Add Files &amp; Media
                    </div>
                    <p className="mt-2 text-xs text-black/55 dark:text-white/55 pl-8">Drag and drop documents, links, or media to bring your work into LYKN.</p>
                  </button>
                  <button
                    type="button"
                    onClick={handleCalendarNav}
                    className={`rounded-xl border p-4 text-left transition-all ${calendarVisited ? "border-green-400/40 bg-green-50/40 dark:bg-green-900/10" : "border-white/40 bg-white/45 dark:bg-white/10 hover:bg-white/60"}`}
                  >
                    <div className="flex items-center gap-2 text-sm font-semibold text-black/80 dark:text-white/80">
                      <span className={`flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold shrink-0 ${calendarVisited ? "bg-green-500/20 text-green-600" : "bg-blue-500/10 text-blue-600"}`}>
                        {calendarVisited ? "\u2713" : "3"}
                      </span>
                      Connect Your Calendar
                    </div>
                    <p className="mt-2 text-xs text-black/55 dark:text-white/55 pl-8">Sync your schedule so LYKN can suggest focused work sessions.</p>
                  </button>
                  <button
                    type="button"
                    onClick={() => nav("/teamspaces")}
                    className="rounded-xl border border-white/40 bg-white/45 dark:bg-white/10 p-4 text-left hover:bg-white/60 transition-all"
                  >
                    <div className="flex items-center gap-2 text-sm font-semibold text-black/80 dark:text-white/80">
                      <span className="flex items-center justify-center w-6 h-6 rounded-full bg-blue-500/10 text-blue-600 text-xs font-bold shrink-0">4</span>
                      Invite Your Team
                      <span className="text-xs font-normal text-black/40 dark:text-white/40">(Optional)</span>
                    </div>
                    <p className="mt-2 text-xs text-black/55 dark:text-white/55 pl-8">Create shared spaces and collaborate in real time.</p>
                  </button>
                </div>
              </div>
            </section>
          )}

          {!hasNoProjects && (
            <section className="mt-6 space-y-3">
              <h2 className="text-lg font-semibold">Your Projects</h2>
              <div className="flex gap-4 items-start">
                <div className="flex-1 min-w-0">
                  <ProjectGrid
                    projects={projects}
                    onSelect={(project) => nav(`/project/${project.id}`)}
                    onRename={handleRenameProject}
                    onDelete={handleDeleteProject}
                    fallbackInitials={userInitials}
                    teamsByProject={teamsByProject}
                    onCreateNew={handleCreateProject}
                    onAddTeamMembers={(project) => nav(`/project/${project.id}?team=1`)}
                  />
                </div>
                <AISuggestionsPanel projects={projects} events={aiEvents} model={selectedModel} />
              </div>
            </section>
          )}
        </main>

        {!hasNoProjects && (
          <CalendarReminders />
        )}
        {showChat && (
          <DraggableChat
            messages={chatMessages}
            input={chatInput}
            setInput={setChatInput}
            onSend={handleChatSend}
            isLoading={isChatLoading}
            onClose={() => setShowChat(false)}
            onNoteClick={() => {}}
          />
        )}
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
