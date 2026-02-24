import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { getProjectKnowledgeBase, projectKnowledgeBaseToText } from "@/lib/projectKnowledgeBase";
import { getSelectedAiModel } from "@/lib/ai-model";

export type AiSuggestion = {
  id: string;
  text: string;
  actions?: any[];
};

type AiState = {
  projectKnowledgeBase: any | null;
  projectKnowledgeBaseText: string | null;
  knowledgeBaseProjectId: string | null;
  knowledgeBaseUpdatedAt: number | null;
  knowledgeBaseDirty: boolean;
  aiSuggestions: AiSuggestion[];
  projectSummary: string | null;
  isOrganizing: boolean;
  isRefreshing: boolean;
  lastError: string | null;

  refreshKnowledgeBase: (projectId: string, opts?: { force?: boolean }) => Promise<string | null>;
  markProjectDirty: (projectId: string) => void;
  getAISuggestions: (projectId: string, prompt: string) => Promise<AiSuggestion[]>;
  organizeIdeas: (projectId: string, intent: string) => Promise<{ actions: any[]; response: string }>;
  generateProjectSummary: (projectId: string) => Promise<string | null>;
};

const makeId = () => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `ai-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
};

const getKbIsFresh = (state: AiState) => {
  if (!state.knowledgeBaseUpdatedAt) return false;
  const ageMs = Date.now() - state.knowledgeBaseUpdatedAt;
  return ageMs < 60_000 && !state.knowledgeBaseDirty;
};

export const useAiStore = create<AiState>()(
  immer((set, get) => ({
    projectKnowledgeBase: null,
    projectKnowledgeBaseText: null,
    knowledgeBaseProjectId: null,
    knowledgeBaseUpdatedAt: null,
    knowledgeBaseDirty: false,
    aiSuggestions: [],
    projectSummary: null,
    isOrganizing: false,
    isRefreshing: false,
    lastError: null,

    refreshKnowledgeBase: async (projectId, opts) => {
      if (!projectId) return null;
      const state = get();
      if (!opts?.force && state.knowledgeBaseProjectId === projectId && getKbIsFresh(state)) {
        return state.projectKnowledgeBaseText;
      }
      set((s) => {
        s.isRefreshing = true;
        s.lastError = null;
      });
      try {
        const kb = await getProjectKnowledgeBase(projectId);
        const kbText = projectKnowledgeBaseToText(kb);
        set((s) => {
          s.projectKnowledgeBase = kb;
          s.projectKnowledgeBaseText = kbText;
          s.knowledgeBaseProjectId = projectId;
          s.knowledgeBaseUpdatedAt = Date.now();
          s.knowledgeBaseDirty = false;
          s.isRefreshing = false;
        });
        return kbText;
      } catch (error: any) {
        console.error("KB refresh failed:", error);
        set((s) => {
          s.isRefreshing = false;
          s.lastError = error?.message || "Failed to refresh knowledge base";
        });
        return null;
      }
    },

    markProjectDirty: (projectId) => {
      set((s) => {
        if (s.knowledgeBaseProjectId !== projectId) return;
        s.knowledgeBaseDirty = true;
      });
    },

    getAISuggestions: async (projectId, prompt) => {
      const kbText = await get().refreshKnowledgeBase(projectId);
      const { API_BASE_URL } = await import("@/lib/api-config");
      const body = {
        model: getSelectedAiModel(),
        prompt: `Based on project context, suggest 3-5 improvements for: ${prompt}`,
        intent: "suggest",
        knowledgeBase: kbText || "",
        projectId,
      };
      const res = await fetch(`${API_BASE_URL}/api/ai/invoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || res.statusText);
      }
      const data = await res.json();
      const text = String(data.response || "").trim();
      const lines = text
        .split("\n")
        .map((l: string) => l.replace(/^[-*\d.]+\s*/, "").trim())
        .filter(Boolean)
        .slice(0, 6);
      const suggestions = lines.length
        ? lines.map((line) => ({ id: makeId(), text: line }))
        : [{ id: makeId(), text }];
      set((s) => {
        s.aiSuggestions = suggestions;
      });
      return suggestions;
    },

    organizeIdeas: async (projectId, intent) => {
      const kbText = await get().refreshKnowledgeBase(projectId);
      set((s) => {
        s.isOrganizing = true;
        s.lastError = null;
      });
      try {
        const { API_BASE_URL } = await import("@/lib/api-config");
        const res = await fetch(`${API_BASE_URL}/api/ai/invoke`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: getSelectedAiModel(),
            prompt: `Organize these ideas based on the intent: ${intent}. Return actions.`,
            intent: "organize",
            returnActions: true,
            knowledgeBase: kbText || "",
            projectId,
          }),
        });
        if (!res.ok) {
          const errorData = await res.json().catch(() => ({}));
          throw new Error(errorData.error || res.statusText);
        }
        const data = await res.json();
        const actions = Array.isArray(data.actions) ? data.actions : [];
        const response = String(data.response || "").trim();
        set((s) => {
          s.isOrganizing = false;
        });
        return { actions, response };
      } catch (error: any) {
        console.error("Organize ideas failed:", error);
        set((s) => {
          s.isOrganizing = false;
          s.lastError = error?.message || "Failed to organize ideas";
        });
        return { actions: [], response: "" };
      }
    },

    generateProjectSummary: async (projectId) => {
      const kbText = await get().refreshKnowledgeBase(projectId);
      const { API_BASE_URL } = await import("@/lib/api-config");
      const res = await fetch(`${API_BASE_URL}/api/ai/invoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: getSelectedAiModel(),
          prompt: "Create a concise summary of this project.",
          intent: "summarize",
          knowledgeBase: kbText || "",
          projectId,
        }),
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || res.statusText);
      }
      const data = await res.json();
      const summary = String(data.response || "").trim();
      set((s) => {
        s.projectSummary = summary;
      });
      return summary;
    },
  }))
);
