// Studio `/model` slash command: searchable picker over the same catalog
// the under-bar model name uses, then persist the pick for this mode.
import { useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/SupabaseAuth";
import { useUserPlan } from "@/lib/useUserPlan";
import { useChatModelSelection } from "@/hooks/useChatModelSelection";
import { useBuildModelSelection } from "@/hooks/useBuildModelSelection";
import { useSlashModelMention } from "@/hooks/useSlashModelMention";
import {
  isStudioModelAllowed,
  optionsForStudioMode,
  type StudioPickerMode,
} from "@/lib/ai/studioModeModels";
import { customModelSelectValue } from "@/lib/modelBuilder/customModelSelect";
import type { SlashModelOption } from "@/lib/chat/slashModelQuery";

function asStudioMode(mode: string): StudioPickerMode {
  if (mode === "build" || mode === "imagine" || mode === "research") return mode;
  return "chat";
}

export function useStudioSlashModel({
  mode,
  enabled,
  onValue,
}: {
  mode: string;
  enabled: boolean;
  onValue: (value: string) => void;
}) {
  const nav = useNavigate();
  const { user } = useAuth();
  const { modelTier, loading: planLoading, isGuest } = useUserPlan();
  const { persistSelectedModel, publishedCustomModels } = useChatModelSelection({
    userId: user?.id,
    modelTier,
    planLoading,
    isGuest,
    nav,
  });
  const { catalog, setBuildModel, setResearchModel, setImagineModel } = useBuildModelSelection({
    modelTier,
    planLoading,
  });

  const pickerMode = asStudioMode(mode);
  const options = useMemo<SlashModelOption[]>(() => {
    const rows = optionsForStudioMode(pickerMode, catalog).map((option) => ({
      value: option.value,
      label: option.label,
      hint: option.hint,
      group: option.group,
      locked: !isStudioModelAllowed(option.value, modelTier),
    }));
    if (pickerMode !== "chat") return rows;
    const customs = (publishedCustomModels || []).map((model) => ({
      value: customModelSelectValue(model.id),
      label: String(model.name || "Custom model"),
      hint: "Model Builder",
      group: "Your models",
      locked: false,
    }));
    return customs.concat(rows);
  }, [catalog, modelTier, pickerMode, publishedCustomModels]);

  const onSelect = useCallback(
    (value: string) => {
      if (pickerMode === "chat") persistSelectedModel(value);
      else if (pickerMode === "research") setResearchModel(value);
      else if (pickerMode === "imagine") setImagineModel(value);
      else setBuildModel(value);
    },
    [pickerMode, persistSelectedModel, setBuildModel, setImagineModel, setResearchModel],
  );

  return useSlashModelMention({
    enabled,
    onValue,
    onSelect,
    options,
  });
}
