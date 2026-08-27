// useChatModelSelection owns the chat model picker and custom-model hydration:
// selected model, active custom-model id, published custom models, the
// persisted chat-model key, and the settings/plan sync that keeps the picker
// honest. Extracted verbatim from src/pages/LyknChat.tsx (LyknChat
// decomposition). liveAIMode is intentionally not carried over — it was
// write-only on the page.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { toast } from "@/components/ui/use-toast";
import { isModelAllowedForPlan, defaultModelForTier } from "@/lib/modelTiers";
import { useAssistantName } from "@/hooks/useAssistantName";
import { fetchPublishedCustomModels } from "@/lib/modelBuilder/customModelsClient";
import { loadActiveCustomModelId, saveActiveCustomModelId } from "@/lib/modelBuilder/activeCustomModelStorage";
import { customModelSelectValue, parseCustomModelSelectValue } from "@/lib/modelBuilder/customModelSelect";
import { CUSTOM_MODELS_ENABLED } from "@/lib/customModelsEnabled";
import { fromChatModelKey, toChatModelKey } from "@/lib/lyknChat/chatModelKey";
import { LyknChatModelSelectMenuBody } from "@/components/lyknChat/ChatBarToolbar";

export interface UseChatModelSelectionReturn {
  selectedModel: string;
  activeCustomModelId: string | null;
  publishedCustomModels: { id: string; name: string; baseModelId?: string }[];
  chatModelKeyRef: React.MutableRefObject<string | null>;
  applyingChatModelKeyRef: React.MutableRefObject<boolean>;
  onChatModelKeyHydrated: (key: string | null) => void;
  refreshPublishedCustomModels: () => Promise<void>;
  persistSelectedModel: (value: string) => void;
  modelSelectValue: string;
  isMainAgentChat: boolean;
  modelSelectMenu: React.ReactNode;
  assistantName: string;
}

export function useChatModelSelection({
  userId,
  modelTier,
  planLoading,
  isGuest,
  nav,
}: {
  userId: string | undefined;
  modelTier: string;
  planLoading: boolean;
  isGuest: boolean;
  nav: (to: string) => void;
}): UseChatModelSelectionReturn {
  const [selectedModel, setSelectedModel] = useState(() => {
    try {
      const saved = localStorage.getItem("lykinsai_settings");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.aiModel) return parsed.aiModel;
      }
    } catch {
      // ignore
    }
    return "lykn";
  });
  const [activeCustomModelId, setActiveCustomModelId] = useState<string | null>(() =>
    loadActiveCustomModelId(),
  );
  const chatModelKeyRef = useRef<string | null>(
    toChatModelKey(
      (() => {
        try {
          const saved = localStorage.getItem("lykinsai_settings");
          if (saved) {
            const parsed = JSON.parse(saved);
            if (parsed.aiModel) return parsed.aiModel;
          }
        } catch {
          // ignore
        }
        return "lykn";
      })(),
      loadActiveCustomModelId(),
    ),
  );
  // When true, ignore global settings → picker sync so a hydrated board key
  // isn't immediately overwritten by localStorage / cross-tab events.
  const applyingChatModelKeyRef = useRef(false);
  // Must be declared BEFORE useLyknChatPersistence — passing it in the
  // persistence args below would hit the const TDZ and crash /app for everyone.
  const onChatModelKeyHydrated = useCallback((key: string | null) => {
    if (!key) return;
    const { selectedModel: nextModel, customModelId } = fromChatModelKey(key);
    applyingChatModelKeyRef.current = true;
    chatModelKeyRef.current = key;
    if (customModelId) {
      setActiveCustomModelId(customModelId);
      setSelectedModel(nextModel || "lykn");
    } else {
      setActiveCustomModelId(null);
      setSelectedModel(nextModel || "lykn");
    }
    // Release after paint so the selectedModel effect doesn't clobber the
    // hydrated key, and later user/settings changes resume normal sync.
    requestAnimationFrame(() => {
      applyingChatModelKeyRef.current = false;
    });
  }, []);
  const [publishedCustomModels, setPublishedCustomModels] = useState<
    { id: string; name: string; baseModelId?: string }[]
  >([]);
  const refreshPublishedCustomModels = useCallback(async () => {
    if (!CUSTOM_MODELS_ENABLED || !userId) {
      setPublishedCustomModels([]);
      if (!CUSTOM_MODELS_ENABLED) {
        saveActiveCustomModelId(null);
        setActiveCustomModelId(null);
      }
      return;
    }
    try {
      const list = await fetchPublishedCustomModels();
      setPublishedCustomModels(list || []);
      const stored = loadActiveCustomModelId();
      if (stored && !(list || []).some((m) => m.id === stored)) {
        saveActiveCustomModelId(null);
        setActiveCustomModelId(null);
      }
    } catch {
      setPublishedCustomModels([]);
    }
  }, [userId]);
  useEffect(() => {
    void refreshPublishedCustomModels();
  }, [refreshPublishedCustomModels]);
  useEffect(() => {
    if (!CUSTOM_MODELS_ENABLED) return undefined;
    const onRefresh = () => void refreshPublishedCustomModels();
    window.addEventListener("lykn_custom_models_changed", onRefresh);
    window.addEventListener("lykn_active_custom_model_changed", onRefresh);
    return () => {
      window.removeEventListener("lykn_custom_models_changed", onRefresh);
      window.removeEventListener("lykn_active_custom_model_changed", onRefresh);
    };
  }, [refreshPublishedCustomModels]);
  const assistantName = useAssistantName();
  const modelSelectValue = useMemo(
    () =>
      activeCustomModelId
        ? customModelSelectValue(activeCustomModelId)
        : selectedModel,
    [activeCustomModelId, selectedModel],
  );
  const isMainAgentChat = useMemo(() => {
    if (!activeCustomModelId) return false;
    const model = publishedCustomModels.find((m) => m.id === activeCustomModelId);
    return !!(model as { isMainAgent?: boolean } | undefined)?.isMainAgent;
  }, [activeCustomModelId, publishedCustomModels]);
  const modelSelectMenu = useMemo(
    () => (
      <LyknChatModelSelectMenuBody
        modelTier={modelTier}
        publishedCustomModels={publishedCustomModels}
        lyknLabel={assistantName}
      />
    ),
    [modelTier, publishedCustomModels, assistantName],
  );
  const persistSelectedModel = useCallback((value: string) => {
    const customId = parseCustomModelSelectValue(value);
    if (customId) {
      saveActiveCustomModelId(customId);
      setActiveCustomModelId(customId);
      const custom = publishedCustomModels.find((m) => m.id === customId);
      const base = custom?.baseModelId;
      if (base && isModelAllowedForPlan(base, modelTier)) {
        setSelectedModel(base);
      }
      chatModelKeyRef.current = toChatModelKey(base || selectedModel || "lykn", customId);
      return;
    }
    saveActiveCustomModelId(null);
    setActiveCustomModelId(null);
    // Refuse to persist a model the current plan can't use. Radix will already
    // prevent selection of disabled items, but this guards against stale saved
    // preferences and any programmatic callers.
    if (!isModelAllowedForPlan(value, modelTier)) {
      toast({
        title: "Upgrade required",
        description: "That model isn't available on your current plan.",
        action: (
          <button
            type="button"
            onClick={() => nav(isGuest ? "/login" : "/billing")}
            className="inline-flex items-center rounded-md bg-white text-black text-[12px] font-semibold px-3 py-1.5 hover:bg-white/90"
          >
            {isGuest ? "Sign in" : "Upgrade"}
          </button>
        ),
      });
      return;
    }
    setSelectedModel(value);
    chatModelKeyRef.current = toChatModelKey(value, null);
    try {
      const saved = localStorage.getItem("lykinsai_settings");
      const settings = saved ? JSON.parse(saved) : {};
      settings.aiModel = value;
      localStorage.setItem("lykinsai_settings", JSON.stringify(settings));
      window.dispatchEvent(new CustomEvent("lykinsai_settings_changed"));
    } catch {
      /* ignore */
    }
  }, [modelTier, nav, isGuest, publishedCustomModels, selectedModel]);

  // Auto-downgrade the saved model once the plan resolves. Keeps behaviour
  // deterministic for users who had a premium model picked before downgrading.
  useEffect(() => {
    if (planLoading) return;
    if (activeCustomModelId) return;
    if (isModelAllowedForPlan(selectedModel, modelTier)) return;
    const fallback = defaultModelForTier(modelTier);
    setSelectedModel(fallback);
    try {
      const saved = localStorage.getItem("lykinsai_settings");
      const settings = saved ? JSON.parse(saved) : {};
      settings.aiModel = fallback;
      localStorage.setItem("lykinsai_settings", JSON.stringify(settings));
    } catch { /* ignore */ }
  }, [modelTier, planLoading, selectedModel, activeCustomModelId]);

  useEffect(() => {
    const sync = () => {
      if (applyingChatModelKeyRef.current) return;
      setActiveCustomModelId(loadActiveCustomModelId());
    };
    window.addEventListener("lykn_active_custom_model_changed", sync);
    return () => window.removeEventListener("lykn_active_custom_model_changed", sync);
  }, []);
  useEffect(() => {
    if (applyingChatModelKeyRef.current) return;
    chatModelKeyRef.current = toChatModelKey(selectedModel, activeCustomModelId);
  }, [selectedModel, activeCustomModelId]);

  // Sync model picker with settings changes (same-tab + cross-tab), like the old Create panel.
  // Skip while applying a per-chat hydrated key so reopen doesn't snap back to global.
  useEffect(() => {
    const sync = () => {
      if (applyingChatModelKeyRef.current) return;
      try {
        const saved = localStorage.getItem("lykinsai_settings");
        if (!saved) return;
        const parsed = JSON.parse(saved);
        if (parsed.aiModel) setSelectedModel(parsed.aiModel);
      } catch {
        // ignore
      }
    };
    window.addEventListener("lykinsai_settings_changed", sync as any);
    window.addEventListener("storage", sync as any);
    return () => {
      window.removeEventListener("lykinsai_settings_changed", sync as any);
      window.removeEventListener("storage", sync as any);
    };
  }, []);

  return {
    selectedModel,
    activeCustomModelId,
    publishedCustomModels,
    chatModelKeyRef,
    applyingChatModelKeyRef,
    onChatModelKeyHydrated,
    refreshPublishedCustomModels,
    persistSelectedModel,
    modelSelectValue,
    isMainAgentChat,
    modelSelectMenu,
    assistantName,
  };
}
