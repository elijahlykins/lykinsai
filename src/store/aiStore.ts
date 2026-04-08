import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { getProjectKnowledgeBase, projectSummaryForAI } from "@/lib/projectKnowledgeBase";
import { getSelectedAiModel } from "@/lib/ai-model";
import { getAiPrefs } from "@/lib/ai-prefs";
import type { WorkspaceSummary } from "@/lib/workspaceContext";

export type AiSuggestion = {
  id: string;
  text: string;
  actions?: any[];
};

const KB_TTL_MS = 5 * 60 * 1000; // 5 minutes

type AiState = {
  projectKnowledgeBase: any | null;
  projectKnowledgeBaseText: string | null;
  knowledgeBaseProjectId: string | null;
  knowledgeBaseUpdatedAt: number | null;
  knowledgeBaseDirty: boolean;

  workspaceSummary: WorkspaceSummary | null;
  workspaceSummaryUserId: string | null;
  workspaceSummaryExcludeBoardId: string | null;
  workspaceSummaryUpdatedAt: number | null;

  aiSuggestions: AiSuggestion[];
  projectSummary: string | null;
  isOrganizing: boolean;
  isRefreshing: boolean;
  lastError: string | null;

  refreshKnowledgeBase: (projectId: string, opts?: { force?: boolean }) => Promise<string | null>;
  getCachedKbText: () => string;
  refreshWorkspaceSummary: (userId: string, excludeBoardId?: string, opts?: { force?: boolean }) => Promise<WorkspaceSummary | null>;
  getCachedWorkspaceSummary: () => WorkspaceSummary | null;
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
  return ageMs < KB_TTL_MS && !state.knowledgeBaseDirty;
};

const getWsFresh = (state: AiState) => {
  if (!state.workspaceSummaryUpdatedAt) return false;
  return Date.now() - state.workspaceSummaryUpdatedAt < KB_TTL_MS;
};

export const useAiStore = create<AiState>()(
  immer((set, get) => ({
    projectKnowledgeBase: null,
    projectKnowledgeBaseText: null,
    knowledgeBaseProjectId: null,
    knowledgeBaseUpdatedAt: null,
    knowledgeBaseDirty: false,

    workspaceSummary: null,
    workspaceSummaryUserId: null,
    workspaceSummaryExcludeBoardId: null,
    workspaceSummaryUpdatedAt: null,

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
        const kbText = projectSummaryForAI(kb);
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

    getCachedKbText: () => {
      return get().projectKnowledgeBaseText || "";
    },

    refreshWorkspaceSummary: async (userId, excludeBoardId, opts) => {
      if (!userId) return null;
      const state = get();
      if (
        !opts?.force &&
        state.workspaceSummaryUserId === userId &&
        state.workspaceSummaryExcludeBoardId === (excludeBoardId ?? null) &&
        getWsFresh(state)
      ) {
        return state.workspaceSummary;
      }
      try {
        const { fetchWorkspaceSummaries } = await import("@/lib/workspaceContext");
        const ws = await fetchWorkspaceSummaries(userId, excludeBoardId);
        set((s) => {
          s.workspaceSummary = ws;
          s.workspaceSummaryUserId = userId;
          s.workspaceSummaryExcludeBoardId = excludeBoardId ?? null;
          s.workspaceSummaryUpdatedAt = Date.now();
        });
        return ws;
      } catch (error: any) {
        console.error("Workspace summary refresh failed:", error);
        return null;
      }
    },

    getCachedWorkspaceSummary: () => {
      return get().workspaceSummary;
    },

    markProjectDirty: (projectId) => {
      set((s) => {
        if (s.knowledgeBaseProjectId !== projectId) return;
        s.knowledgeBaseDirty = true;
      });
    },

    getAISuggestions: async (projectId, prompt) => {
      const kbText = get().getCachedKbText();
      const { API_BASE_URL } = await import("@/lib/api-config");
      const body = {
        model: getSelectedAiModel(),
        prompt: `Based on project context, suggest 3-5 improvements for: ${prompt}`,
        intent: "suggest",
        knowledgeBase: kbText || "",
        projectId,
        ...getAiPrefs(),
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
      const kbText = get().getCachedKbText();
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
            ...getAiPrefs(),
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
      const kbText = get().getCachedKbText();
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
          ...getAiPrefs(),
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
