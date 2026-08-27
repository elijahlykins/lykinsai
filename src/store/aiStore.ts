import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { getProjectKnowledgeBase, projectSummaryForAI } from "@/lib/projectKnowledgeBase";
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
  workspaceSummaryExcludeChatId: string | null;
  workspaceSummaryUpdatedAt: number | null;

  aiSuggestions: AiSuggestion[];
  projectSummary: string | null;
  isOrganizing: boolean;
  isRefreshing: boolean;
  lastError: string | null;

  refreshKnowledgeBase: (projectId: string, opts?: { force?: boolean; excludeChatId?: string }) => Promise<string | null>;
  getCachedKbText: () => string;
  refreshWorkspaceSummary: (userId: string, excludeChatId?: string, opts?: { force?: boolean }) => Promise<WorkspaceSummary | null>;
  getCachedWorkspaceSummary: () => WorkspaceSummary | null;
  markProjectDirty: (projectId: string) => void;
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
    workspaceSummaryExcludeChatId: null,
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
        const kbText = projectSummaryForAI(kb, {
          maxChars: 4000,
          excludeChatId: opts?.excludeChatId,
        });
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
        if (import.meta.env.DEV) console.error("KB refresh failed:", error);
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

    refreshWorkspaceSummary: async (userId, excludeChatId, opts) => {
      if (!userId) return null;
      const state = get();
      if (
        !opts?.force &&
        state.workspaceSummaryUserId === userId &&
        state.workspaceSummaryExcludeChatId === (excludeChatId ?? null) &&
        getWsFresh(state)
      ) {
        return state.workspaceSummary;
      }
      try {
        const { fetchWorkspaceSummaries } = await import("@/lib/workspaceContext");
        const ws = await fetchWorkspaceSummaries(userId, excludeChatId);
        set((s) => {
          s.workspaceSummary = ws;
          s.workspaceSummaryUserId = userId;
          s.workspaceSummaryExcludeChatId = excludeChatId ?? null;
          s.workspaceSummaryUpdatedAt = Date.now();
        });
        return ws;
      } catch (error: any) {
        if (import.meta.env.DEV) console.error("Workspace summary refresh failed:", error);
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
  }))
);
