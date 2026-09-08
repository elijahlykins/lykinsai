// Model name under the Home desktop chat bar. The page composer is hidden
// on Home, so this is the picker the user actually sees — including idle
// Chat, before a conversation exists, and it rides the bar when it docks.
import React from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/SupabaseAuth";
import { useUserPlan } from "@/lib/useUserPlan";
import { useChatModelSelection } from "@/hooks/useChatModelSelection";
import { useBuildModelSelection } from "@/hooks/useBuildModelSelection";
import BuildModelSelect from "@/components/lyknChat/BuildModelSelect";
import type { StudioView } from "@/components/lyknChat/StudioChatChrome";

function asStudioView(mode: string): StudioView {
  if (mode === "build" || mode === "imagine" || mode === "research") return mode;
  return "chat";
}

export default function HomeBarStudioModelSelect({
  mode,
  docked = false,
}: {
  mode: string;
  docked?: boolean;
}) {
  const nav = useNavigate();
  const { user } = useAuth();
  const { modelTier, loading: planLoading, isGuest } = useUserPlan();
  const { modelSelectValue, persistSelectedModel } = useChatModelSelection({
    userId: user?.id,
    modelTier,
    planLoading,
    isGuest,
    nav,
  });
  const {
    catalog,
    buildModel,
    setBuildModel,
    researchModel,
    setResearchModel,
    imagineModel,
    setImagineModel,
  } = useBuildModelSelection({
    modelTier,
    planLoading,
  });

  const pickerMode = asStudioView(mode);
  const value =
    pickerMode === "chat"
      ? modelSelectValue
      : pickerMode === "research"
        ? researchModel
        : pickerMode === "imagine"
          ? imagineModel
          : buildModel;
  const onChange =
    pickerMode === "chat"
      ? persistSelectedModel
      : pickerMode === "research"
        ? setResearchModel
        : pickerMode === "imagine"
          ? setImagineModel
          : setBuildModel;

  return (
    <BuildModelSelect
      mode={pickerMode}
      value={value}
      onChange={onChange}
      catalog={catalog}
      modelTier={modelTier}
      chatModelId={modelSelectValue}
      menuSide={docked ? "top" : "bottom"}
    />
  );
}
