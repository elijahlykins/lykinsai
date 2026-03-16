import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, ChevronRight, Layers, Loader2, Network, RefreshCw, Search, Sparkles, X } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/SupabaseAuth";
import { API_BASE_URL } from "@/lib/api-config";
import { getAiPrefs } from "@/lib/ai-prefs";

type Note = {
  id: string;
  title: string;
  content: string;
  source?: string;
  created_at?: string;
  updated_at?: string;
};

type Cluster = {
  id: string;
  theme: string;
  description: string;
  noteIds: string[];
  color: string;
};

const CLUSTER_COLORS = [
  "rgba(59,130,246,0.12)",
  "rgba(22,163,74,0.12)",
  "rgba(217,119,6,0.12)",
  "rgba(220,38,38,0.12)",
  "rgba(124,58,237,0.12)",
  "rgba(219,39,119,0.12)",
  "rgba(15,118,110,0.12)",
];

const CLUSTER_BORDER_COLORS = [
  "rgba(59,130,246,0.30)",
  "rgba(22,163,74,0.30)",
  "rgba(217,119,6,0.30)",
  "rgba(220,38,38,0.30)",
  "rgba(124,58,237,0.30)",
  "rgba(219,39,119,0.30)",
  "rgba(15,118,110,0.30)",
];

const CLUSTER_TEXT_COLORS = [
  "#3B82F6", "#16A34A", "#D97706", "#DC2626", "#7C3AED", "#DB2777", "#0F766E",
];

function clusterNotesLocally(notes: Note[]): Cluster[] {
  if (notes.length === 0) return [];

  const keywords: Record<string, string[]> = {
    "AI & Technology": ["ai", "machine learning", "gpt", "llm", "neural", "algorithm", "model", "automation", "tech", "software", "api", "data", "compute", "robot", "intelligence"],
    "Startups & Business": ["startup", "founder", "revenue", "customer", "market", "pitch", "investor", "saas", "business", "company", "funding", "growth", "scale", "mvp", "product"],
    "Health & Wellness": ["health", "fitness", "diet", "sleep", "mental", "exercise", "meditation", "wellness", "therapy", "nutrition", "mindful", "stress", "workout", "habit"],
    "Creative & Content": ["design", "creative", "content", "video", "write", "blog", "podcast", "story", "art", "brand", "social media", "creator", "youtube", "newsletter"],
    "Productivity & Tools": ["productivity", "tool", "workflow", "organize", "automate", "schedule", "task", "project", "notion", "template", "system", "efficiency", "process", "optimize"],
    "Education & Learning": ["learn", "course", "book", "study", "research", "knowledge", "teach", "education", "skill", "tutorial", "lesson", "read", "university", "school"],
    "Finance & Investing": ["finance", "invest", "money", "budget", "crypto", "stock", "savings", "income", "expense", "portfolio", "trading", "wealth", "passive income", "real estate"],
  };

  const clusters: Cluster[] = [];
  const assignedNoteIds = new Set<string>();

  Object.entries(keywords).forEach(([theme, words], idx) => {
    const matched = notes.filter((note) => {
      if (assignedNoteIds.has(note.id)) return false;
      const text = `${note.title || ""} ${note.content || ""}`.toLowerCase();
      return words.some((w) => text.includes(w));
    });
    if (matched.length > 0) {
      matched.forEach((n) => assignedNoteIds.add(n.id));
      clusters.push({
        id: `cluster-${idx}`,
        theme,
        description: `${matched.length} connected idea${matched.length !== 1 ? "s" : ""}`,
        noteIds: matched.map((n) => n.id),
        color: CLUSTER_COLORS[idx % CLUSTER_COLORS.length],
      });
    }
  });

  const unmatched = notes.filter((n) => !assignedNoteIds.has(n.id));
  if (unmatched.length > 0) {
    clusters.push({
      id: "cluster-other",
      theme: "Uncategorized Ideas",
      description: `${unmatched.length} idea${unmatched.length !== 1 ? "s" : ""} to explore`,
      noteIds: unmatched.map((n) => n.id),
      color: CLUSTER_COLORS[clusters.length % CLUSTER_COLORS.length],
    });
  }

  return clusters.sort((a, b) => b.noteIds.length - a.noteIds.length);
}

async function clusterNotesWithAI(notes: Note[]): Promise<Cluster[] | null> {
  if (notes.length === 0) return [];
  const summaries = notes.slice(0, 100).map((n) => ({
    id: n.id,
    title: n.title || "(untitled)",
    snippet: (n.content || "").slice(0, 200),
  }));

  const systemPrompt = `You are an idea-clustering assistant. Given a list of user notes (id, title, snippet), group them into thematic clusters. Return ONLY valid JSON — an array of objects with: { "theme": string, "description": string (short), "noteIds": string[] }. Aim for 3-8 clusters. Every noteId must appear in exactly one cluster.`;
  const userMsg = JSON.stringify(summaries);

  try {
    const res = await fetch(`${API_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMsg },
        ],
        model: "gpt-4o-mini",
        ...getAiPrefs(),
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || data?.reply || data?.content || "";
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]) as { theme: string; description: string; noteIds: string[] }[];
    return parsed.map((c, i) => ({
      id: `ai-cluster-${i}`,
      theme: c.theme,
      description: c.description,
      noteIds: c.noteIds,
      color: CLUSTER_COLORS[i % CLUSTER_COLORS.length],
    }));
  } catch {
    return null;
  }
}

export default function Connections() {
  const nav = useNavigate();
  const { user } = useAuth();
  const [notes, setNotes] = useState<Note[]>([]);
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [loading, setLoading] = useState(true);
  const [aiClustering, setAiClustering] = useState(false);
  const [expandedCluster, setExpandedCluster] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [clusterMode, setClusterMode] = useState<"local" | "ai">("local");

  const loadNotes = useCallback(async () => {
    if (!user?.id) { setNotes([]); setLoading(false); return; }
    setLoading(true);
    try {
      const { data } = await supabase
        .from("notes")
        .select("id, title, source, created_at, updated_at")
        .eq("user_id", user.id)
        .order("updated_at", { ascending: false })
        .limit(50);
      setNotes(data || []);
    } catch {
      setNotes([]);
    } finally {
      setLoading(false);
    }
  }, [user?.id]);

  useEffect(() => { loadNotes(); }, [loadNotes]);

  useEffect(() => {
    if (notes.length === 0) { setClusters([]); return; }
    setClusters(clusterNotesLocally(notes));
    setClusterMode("local");
  }, [notes]);

  const runAiClustering = useCallback(async () => {
    if (notes.length === 0) return;
    setAiClustering(true);
    const result = await clusterNotesWithAI(notes);
    if (result) {
      setClusters(result);
      setClusterMode("ai");
    }
    setAiClustering(false);
  }, [notes]);

  const notesById = useMemo(() => {
    const map: Record<string, Note> = {};
    notes.forEach((n) => { map[n.id] = n; });
    return map;
  }, [notes]);

  const filteredClusters = useMemo(() => {
    if (!searchQuery.trim()) return clusters;
    const q = searchQuery.toLowerCase();
    return clusters
      .map((c) => {
        if (c.theme.toLowerCase().includes(q)) return c;
        const matchedIds = c.noteIds.filter((id) => {
          const n = notesById[id];
          if (!n) return false;
          return (n.title || "").toLowerCase().includes(q) || (n.content || "").toLowerCase().includes(q);
        });
        if (matchedIds.length === 0) return null;
        return { ...c, noteIds: matchedIds, description: `${matchedIds.length} match${matchedIds.length !== 1 ? "es" : ""}` };
      })
      .filter(Boolean) as Cluster[];
  }, [clusters, searchQuery, notesById]);

  const expandedNotes = useMemo(() => {
    if (!expandedCluster) return [];
    const cluster = clusters.find((c) => c.id === expandedCluster);
    if (!cluster) return [];
    return cluster.noteIds.map((id) => notesById[id]).filter(Boolean);
  }, [expandedCluster, clusters, notesById]);

  const expandedClusterData = clusters.find((c) => c.id === expandedCluster);

  const totalIdeas = notes.length;
  const totalClusters = clusters.length;
  const avgPerCluster = totalClusters > 0 ? Math.round(totalIdeas / totalClusters) : 0;

  return (
    <div className="min-h-screen bg-transparent text-black relative overflow-x-hidden">
      <div className="fixed top-3 left-0 right-0 z-[70] px-3 flex items-center justify-end pointer-events-none">
        <div className="pointer-events-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => nav(-1)}
            className="rounded-full w-9 h-9 hover:bg-black/10 transition-colors flex items-center justify-center"
            title="Back"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-6 pt-20 pb-16">
        <div className="flex items-center gap-3 mb-2">
          <Network className="w-6 h-6 text-black/50" />
          <h1 className="text-2xl font-semibold tracking-tight">Connections</h1>
        </div>
        <p className="text-sm text-black/50 mb-8">Your thinking map — ideas grouped by themes, patterns surfaced automatically.</p>

        {/* Stats bar */}
        <div className="flex items-center gap-6 mb-6">
          <div className="flex items-center gap-2">
            <span className="text-2xl font-bold tabular-nums">{totalIdeas}</span>
            <span className="text-xs text-black/50">ideas</span>
          </div>
          <div className="w-px h-5 bg-black/10" />
          <div className="flex items-center gap-2">
            <span className="text-2xl font-bold tabular-nums">{totalClusters}</span>
            <span className="text-xs text-black/50">clusters</span>
          </div>
          <div className="w-px h-5 bg-black/10" />
          <div className="flex items-center gap-2">
            <span className="text-2xl font-bold tabular-nums">~{avgPerCluster}</span>
            <span className="text-xs text-black/50">per cluster</span>
          </div>

          <div className="flex-1" />

          <button
            type="button"
            onClick={runAiClustering}
            disabled={aiClustering || notes.length === 0}
            className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full border border-black/10 hover:bg-black/5 transition-colors disabled:opacity-40"
          >
            {aiClustering ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            {aiClustering ? "Clustering..." : clusterMode === "ai" ? "Re-cluster with AI" : "Cluster with AI"}
          </button>
          <button
            type="button"
            onClick={loadNotes}
            className="rounded-full w-8 h-8 hover:bg-black/8 transition-colors flex items-center justify-center"
            title="Refresh"
          >
            <RefreshCw className="w-3.5 h-3.5 text-black/50" />
          </button>
        </div>

        {/* Search */}
        <div className="relative mb-8">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-black/30" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search ideas and clusters..."
            className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-black/10 bg-white/40 backdrop-blur-sm text-sm outline-none focus:border-black/20 transition-colors placeholder:text-black/30"
          />
          {searchQuery && (
            <button type="button" onClick={() => setSearchQuery("")} className="absolute right-3 top-1/2 -translate-y-1/2">
              <X className="w-3.5 h-3.5 text-black/30 hover:text-black/60" />
            </button>
          )}
        </div>

        {loading ? (
          <div className="flex flex-col items-center justify-center py-24 gap-3">
            <Loader2 className="w-6 h-6 animate-spin text-black/30" />
            <span className="text-sm text-black/40">Loading your ideas...</span>
          </div>
        ) : notes.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 gap-4 text-center">
            <div className="w-16 h-16 rounded-2xl bg-black/5 flex items-center justify-center">
              <Layers className="w-7 h-7 text-black/25" />
            </div>
            <div>
              <p className="text-sm font-medium text-black/60">No ideas yet</p>
              <p className="text-xs text-black/40 mt-1">Add notes in Media to start building your thinking map.</p>
            </div>
          </div>
        ) : (
          <>
            {/* Cluster detail overlay */}
            {expandedCluster && expandedClusterData && (
              <div className="mb-8 rounded-2xl border border-black/10 bg-white/50 backdrop-blur-sm overflow-hidden">
                <div className="px-5 py-4 flex items-center justify-between border-b border-black/8" style={{ background: expandedClusterData.color }}>
                  <div>
                    <h2 className="text-base font-semibold">{expandedClusterData.theme}</h2>
                    <p className="text-xs text-black/50 mt-0.5">{expandedClusterData.noteIds.length} connected idea{expandedClusterData.noteIds.length !== 1 ? "s" : ""}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setExpandedCluster(null)}
                    className="rounded-full w-8 h-8 hover:bg-black/8 transition-colors flex items-center justify-center"
                  >
                    <X className="w-4 h-4 text-black/50" />
                  </button>
                </div>
                <div className="divide-y divide-black/5">
                  {expandedNotes.map((note) => (
                    <div key={note.id} className="px-5 py-3 hover:bg-black/3 transition-colors">
                      <p className="text-sm font-medium text-black/80 truncate">{note.title || "Untitled"}</p>
                      <p className="text-xs text-black/45 mt-0.5 line-clamp-2">{note.content || ""}</p>
                      {note.created_at && (
                        <p className="text-[10px] text-black/30 mt-1.5">
                          {new Date(note.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Cluster grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {filteredClusters.map((cluster, idx) => {
                const clusterIdx = clusters.indexOf(cluster);
                const colorIdx = clusterIdx >= 0 ? clusterIdx : idx;
                return (
                  <button
                    key={cluster.id}
                    type="button"
                    onClick={() => setExpandedCluster(expandedCluster === cluster.id ? null : cluster.id)}
                    className={`text-left rounded-2xl border p-5 transition-all hover:shadow-md group ${
                      expandedCluster === cluster.id
                        ? "ring-2 ring-black/15 shadow-md"
                        : "hover:scale-[1.01]"
                    }`}
                    style={{
                      background: cluster.color,
                      borderColor: CLUSTER_BORDER_COLORS[colorIdx % CLUSTER_BORDER_COLORS.length],
                    }}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span
                            className="inline-flex items-center justify-center w-6 h-6 rounded-lg text-[10px] font-bold text-white"
                            style={{ background: CLUSTER_TEXT_COLORS[colorIdx % CLUSTER_TEXT_COLORS.length] }}
                          >
                            {cluster.noteIds.length}
                          </span>
                          <h3 className="text-sm font-semibold text-black/80 truncate">{cluster.theme}</h3>
                        </div>
                        <p className="text-xs text-black/45">{cluster.description}</p>
                        <div className="flex flex-wrap gap-1 mt-3">
                          {cluster.noteIds.slice(0, 3).map((id) => {
                            const n = notesById[id];
                            if (!n) return null;
                            return (
                              <span key={id} className="inline-block text-[10px] text-black/50 bg-white/60 rounded-full px-2 py-0.5 truncate max-w-[10rem]">
                                {n.title || "Untitled"}
                              </span>
                            );
                          })}
                          {cluster.noteIds.length > 3 && (
                            <span className="text-[10px] text-black/35">+{cluster.noteIds.length - 3} more</span>
                          )}
                        </div>
                      </div>
                      <ChevronRight className={`w-4 h-4 text-black/25 shrink-0 mt-1 transition-transform ${expandedCluster === cluster.id ? "rotate-90" : "group-hover:translate-x-0.5"}`} />
                    </div>
                  </button>
                );
              })}
            </div>

            {filteredClusters.length === 0 && searchQuery && (
              <div className="text-center py-12">
                <p className="text-sm text-black/40">No clusters match "{searchQuery}"</p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
