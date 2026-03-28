import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Plus, Sparkles, StickyNote } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/SupabaseAuth";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import ProjectGrid from "@/components/ProjectGrid";
import DraggableChat from "@/components/notes/DraggableChat";
import DraggableQuickNote from "@/components/notes/DraggableQuickNote";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
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

const PROJECTS_CHANGED_EVENT = "lykinsai_projects_changed";

function AISuggestions({ projects, model }: { projects: Project[]; model: string }) {
  const [tips, setTips] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const didFetch = useRef(false);

  useEffect(() => {
    if (didFetch.current) return;
    didFetch.current = true;

    const todayKey = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}-${String(new Date().getDate()).padStart(2, "0")}`;
    const projectNames = projects.slice(0, 8).map((p) => p.name);
    const recentProject = [...projects].sort((a, b) => (b.updated_at || b.created_at || "").localeCompare(a.updated_at || a.created_at || ""))[0];

    const prompt = `You are a productivity AI assistant inside a creative workspace app. Based on the user's current context, give exactly 5 short, actionable suggestions (1 sentence each). Be specific and personal — reference their actual projects by name.

Context:
- Date: ${todayKey} (${new Date().toLocaleDateString("en-US", { weekday: "long" })})
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
          "Focus on your most recent project first",
          "Review and organize your project notes",
          "Set priorities for your active projects",
          "Break large tasks into smaller milestones",
          "Plan tomorrow's priorities before end of day",
        ]);
        setLoading(false);
      }
    })();
  }, [projects, model]);

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

function AISuggestionsPanel({ projects, model }: { projects: Project[]; model: string }) {
  return (
    <div className="hidden lg:block w-[15.625rem] shrink-0 sticky top-24">
      <AISuggestions projects={projects} model={model} />
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
  const dashboardQueryClient = useQueryClient();
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
    return "claude-sonnet-4-6";
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
          if (next[idx]) next[idx] = { ...next[idx], content: "This model isn\u2019t working properly right now \u2014 try another model." };
          return next;
        });
      }
    } finally {
      setIsChatLoading(false);
    }
  };

  const { data: projects = [] } = useQuery<Project[]>({
    queryKey: ["projects", user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      const imageMap = loadProjectCardImages();
      const { data } = await supabase
        .from("omnia_projects")
        .select("id, name, created_at, updated_at")
        .eq("user_id", user.id)
        .order("updated_at", { ascending: false })
        .limit(100);
      return ((data as Project[]) || []).map((project) => ({
        ...project,
        image: imageMap[project.id] || project.image || null,
      }));
    },
    enabled: !!user?.id && !loading,
  });

  const invalidateProjects = () => {
    dashboardQueryClient.invalidateQueries({ queryKey: ["projects", user?.id] });
    window.dispatchEvent(new CustomEvent(PROJECTS_CHANGED_EVENT));
  };

  const handleRenameProject = async (project: Project, name: string) => {
    if (!user?.id) return;
    await supabase
      .from("omnia_projects")
      .update({ name })
      .eq("id", project.id)
      .eq("user_id", user.id);
    invalidateProjects();
  };

  const handleDeleteProject = async (project: Project) => {
    if (!user?.id) return;
    await supabase
      .from("omnia_projects")
      .delete()
      .eq("id", project.id)
      .eq("user_id", user.id);
    invalidateProjects();
  };

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
      invalidateProjects();
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
  const showSetup = !setupDismissed;

  const dismissSetup = () => {
    setSetupDismissed(true);
    setSetupConfirmingSkip(false);
    try { localStorage.setItem("lykinsai_setup_dismissed", "1"); } catch {}
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
                    <SelectGroup>
                      <SelectLabel>Latest</SelectLabel>
                      <SelectItem value="claude-sonnet-4-6" hint="Anthropic flagship">Claude Sonnet 4.6</SelectItem>
                      <SelectItem value="gpt-5.4" hint="OpenAI flagship">GPT-5.4</SelectItem>
                      <SelectItem value="gemini-3.1-pro-preview" hint="Google flagship">Gemini 3.1 Pro</SelectItem>
                      <SelectItem value="grok-4-1-fast-reasoning" hint="xAI flagship">Grok 4.1 Fast Reasoning</SelectItem>
                    </SelectGroup>
                    <SelectSeparator />
                    <SelectGroup>
                      <SelectLabel>Fastest</SelectLabel>
                      <SelectItem value="gemini-3-flash-preview" hint="Google, ultra-fast">Gemini 3 Flash</SelectItem>
                      <SelectItem value="gemini-3.1-flash-lite-preview" hint="Google, cheapest">Gemini 3.1 Flash-Lite</SelectItem>
                      <SelectItem value="gemini-2.5-flash" hint="Google, balanced">Gemini 2.5 Flash</SelectItem>
                      <SelectItem value="gpt-4.1-nano" hint="OpenAI, smallest">GPT-4.1 Nano</SelectItem>
                      <SelectItem value="gpt-4.1-mini" hint="OpenAI, fast + smart">GPT-4.1 Mini</SelectItem>
                      <SelectItem value="gpt-5-mini" hint="OpenAI, near-frontier">GPT-5 Mini</SelectItem>
                      <SelectItem value="claude-haiku-4-5-20251001" hint="Anthropic, fast">Claude Haiku 4.5</SelectItem>
                      <SelectItem value="grok-4-1-fast-non-reasoning" hint="xAI, low latency">Grok 4.1 Fast Non-Reasoning</SelectItem>
                    </SelectGroup>
                    <SelectSeparator />
                    <SelectGroup>
                      <SelectLabel>Cheap</SelectLabel>
                      <SelectItem value="gpt-4o-mini" hint="OpenAI, budget">GPT-4o Mini</SelectItem>
                      <SelectItem value="o4-mini" hint="OpenAI, cheap reasoning">o4 Mini</SelectItem>
                      <SelectItem value="grok-3-mini" hint="xAI, budget">Grok 3 Mini</SelectItem>
                    </SelectGroup>
                    <SelectSeparator />
                    <SelectGroup>
                      <SelectLabel>Image Gen</SelectLabel>
                      <SelectItem value="gpt-image-1.5" hint="OpenAI, images">GPT Image 1.5</SelectItem>
                      <SelectItem value="gemini-3.1-flash-image-preview" hint="Google, images">Nano Banana 2</SelectItem>
                      <SelectItem value="grok-imagine-image-pro" hint="xAI, pro images">Grok Imagine Image Pro</SelectItem>
                      <SelectItem value="grok-imagine-image" hint="xAI, images">Grok Imagine Image</SelectItem>
                      <SelectItem value="grok-2-image-1212" hint="xAI, images">Grok 2 Image</SelectItem>
                      <SelectItem value="dall-e-3" hint="OpenAI, images">DALL-E 3</SelectItem>
                    </SelectGroup>
                    <SelectSeparator />
                    <SelectGroup>
                      <SelectLabel>Deep Thinking</SelectLabel>
                      <SelectItem value="o3" hint="OpenAI, reasoning">o3</SelectItem>
                      <SelectItem value="o3-pro" hint="OpenAI, max reasoning">o3 Pro</SelectItem>
                      <SelectItem value="gpt-5.4-pro" hint="OpenAI, extended">GPT-5.4 Pro</SelectItem>
                      <SelectItem value="claude-opus-4-1-20250805" hint="Anthropic, deep">Claude Opus 4.1</SelectItem>
                      <SelectItem value="claude-opus-4-20250514" hint="Anthropic, deep">Claude Opus 4</SelectItem>
                      <SelectItem value="gemini-2.5-pro" hint="Google, reasoning">Gemini 2.5 Pro</SelectItem>
                      <SelectItem value="grok-4-fast-reasoning" hint="xAI, reasoning">Grok 4 Fast Reasoning</SelectItem>
                    </SelectGroup>
                    <SelectSeparator />
                    <SelectGroup>
                      <SelectLabel>Code</SelectLabel>
                      <SelectItem value="claude-opus-4-6-code" hint="Anthropic, top coder">Claude Opus 4.6</SelectItem>
                      <SelectItem value="gpt-5.3-codex" hint="OpenAI, agentic code">Codex 5.3</SelectItem>
                      <SelectItem value="gpt-4.1" hint="OpenAI, 1M ctx code">GPT-4.1</SelectItem>
                      <SelectItem value="grok-code-fast-1" hint="xAI, code">Grok Code Fast 1</SelectItem>
                    </SelectGroup>
                    <SelectSeparator />
                    <SelectGroup>
                      <SelectLabel>General</SelectLabel>
                      <SelectItem value="gpt-5.2" hint="OpenAI, previous gen">GPT-5.2</SelectItem>
                      <SelectItem value="gpt-5.1" hint="OpenAI, previous gen">GPT-5.1</SelectItem>
                      <SelectItem value="gpt-5" hint="OpenAI, previous gen">GPT-5</SelectItem>
                      <SelectItem value="gpt-4o" hint="OpenAI, versatile">GPT-4o</SelectItem>
                      <SelectItem value="claude-sonnet-4-20250514" hint="Anthropic, balanced">Claude Sonnet 4</SelectItem>
                      <SelectItem value="grok-4-fast-non-reasoning" hint="xAI, general">Grok 4 Fast Non-Reasoning</SelectItem>
                      <SelectItem value="grok-4-0709" hint="xAI, general">Grok 4 0709</SelectItem>
                      <SelectItem value="grok-3" hint="xAI, previous gen">Grok 3</SelectItem>
                      <SelectItem value="grok-2-vision-1212" hint="xAI, vision">Grok 2 Vision</SelectItem>
                      <SelectItem value="unified-auto" hint="Auto-picks best">Unified AI (Auto)</SelectItem>
                    </SelectGroup>
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
                    onCreateNew={handleCreateProject}
                  />
                </div>
                <AISuggestionsPanel projects={projects} model={selectedModel} />
              </div>
            </section>
          )}
        </main>

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
