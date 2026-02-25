import React, { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, MessageSquare, Plus, Zap } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/SupabaseAuth";
import ProjectModal from "@/components/ProjectModal";
import ProjectGrid from "@/components/ProjectGrid";
import DraggableChat from "@/components/notes/DraggableChat";
import DraggableQuickNote from "@/components/notes/DraggableQuickNote";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import createButtonBackground from "@/assets/Colored.jpg";

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
  const [openModal, setOpenModal] = useState(false);
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
        body: JSON.stringify({ model: selectedModel, prompt }),
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
  };

  const handleDeleteProject = async (project: Project) => {
    if (!user?.id) return;
    await supabase
      .from("omnia_projects")
      .delete()
      .eq("id", project.id)
      .eq("user_id", user.id);
    await fetchProjects(user.id);
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

  const handleCreateProject = async (args: { name: string; mode: "blank" | "files" }) => {
    if (!user) return;
    const { data: project } = await supabase
      .from("omnia_projects")
      .insert({ user_id: user.id, name: args.name })
      .select("id, name, created_at, updated_at")
      .single();
    const projectId = project?.id;
    if (!projectId) return;
    setOpenModal(false);
    await fetchProjects(user.id);
    if (args.mode === "files") {
      nav(`/project/${projectId}`);
      return;
    }
    const { data: board } = await supabase
      .from("omnia_boards")
      .insert({ user_id: user.id, title: args.name })
      .select("id")
      .single();
    if (board?.id) {
      localStorage.setItem("omnia_board_id", board.id);
      nav(`/canvas/${board.id}`);
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
                  <SelectTrigger className="w-[124px] !h-7 rounded-full glass-control hover:opacity-90 text-[11px] font-medium px-2">
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

                <div className="w-px h-3 bg-black/10 dark:bg-white/10 mx-0.5" />

                <button
                  type="button"
                  onClick={() => {
                    const next = !liveAIMode;
                    setLiveAIMode(next);
                    try {
                      const saved = localStorage.getItem("lykinsai_settings");
                      const settings = saved ? JSON.parse(saved) : {};
                      settings.liveAIMode = next;
                      localStorage.setItem("lykinsai_settings", JSON.stringify(settings));
                      window.dispatchEvent(new CustomEvent("lykinsai_settings_changed"));
                    } catch {
                      // ignore
                    }
                  }}
                  className={`rounded-full px-1.5 h-7 gap-1 text-[11px] glass-control hover:opacity-90 touch-manipulation flex items-center ${
                    liveAIMode ? "ring-1 ring-white/40 dark:ring-white/20" : ""
                  }`}
                  title="Live AI"
                >
                  <Zap className={`w-3 h-3 ${liveAIMode ? "text-yellow-500" : "text-black"}`} />
                  <span>Live AI</span>
                </button>

                <div className="w-px h-3 bg-black/10 dark:bg-white/10 mx-0.5" />

                <button
                  type="button"
                  onClick={() => setShowChat((v) => !v)}
                  className="rounded-full px-1.5 h-7 text-[11px] glass-control hover:opacity-90 touch-manipulation flex items-center gap-1"
                  title="Chat with AI"
                >
                  <span className="hidden md:inline">Chat</span>
                  <MessageSquare className="w-3 h-3 md:hidden" />
                </button>
              </div>
            )}
          </div>
        </div>

        <main className="relative z-20 mx-auto max-w-6xl px-6 pt-24 pb-16">
          <section className="space-y-2">
            <h1 className="text-3xl font-semibold">Welcome back, {greetingName}</h1>
            <p className="text-black/60">Your creative workspace is ready.</p>
            <button
              type="button"
              onClick={() => setOpenModal(true)}
              className="mt-4 relative inline-flex items-center gap-2 rounded-xl border border-white/55 bg-white/10 backdrop-blur-md shadow-lg shadow-white/15 px-4 py-2 text-sm font-semibold text-black transition-transform hover:scale-[1.01] hover:shadow-xl overflow-hidden"
              aria-label="Create new project"
            >
              <span className="absolute inset-0 pointer-events-none">
                <span
                  className="absolute inset-0 bg-cover bg-center opacity-52"
                  style={{ backgroundImage: `url(${createButtonBackground})` }}
                />
                <span className="absolute inset-0 bg-white/6" />
              </span>
              <Plus className="relative z-10 w-4 h-4" />
              <span className="relative z-10">Create New Project</span>
            </button>
          </section>

          <section className="mt-8 space-y-4">
            <h2 className="text-lg font-semibold">Your Projects</h2>
            <ProjectGrid
              projects={projects}
              onSelect={(project) => nav(`/project/${project.id}`)}
              onRename={handleRenameProject}
              onDelete={handleDeleteProject}
              fallbackInitials={userInitials}
            />
          </section>
        </main>

        <ProjectModal open={openModal} onOpenChange={setOpenModal} onCreate={handleCreateProject} />
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
          <Plus className="w-6 h-6" />
        </button>
      </div>
  );
}
