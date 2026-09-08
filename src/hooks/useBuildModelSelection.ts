// Owns per-mode Studio model picks (Build / Research / Imagine) and the
// send-time refs useChatEngine reads. Chat's pick stays in
// useChatModelSelection (the global preference). Split on purpose: a Build
// model must never write back into lykinsai_settings.aiModel.
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { useQuery } from "@tanstack/react-query";

import { fetchModelCatalog } from "@/lib/models/modelPlatformClient";
import type { StudioView } from "@/components/lyknChat/StudioChatChrome";
import {
  STUDIO_MODEL_AUTO,
  catalogFromPickerGroups,
  loadStudioModeModel,
  normalizeStudioModeModel,
  peekStudioSendModels,
  saveStudioModeModel,
  studioModelChangedEvent,
  type CatalogModel,
} from "@/lib/ai/studioModeModels";

export interface UseBuildModelSelectionReturn {
  catalog: CatalogModel[];
  buildModel: string;
  setBuildModel: (value: string) => void;
  researchModel: string;
  setResearchModel: (value: string) => void;
  imagineModel: string;
  setImagineModel: (value: string) => void;
  /** LLM override for Research / Build, or "" for no override. */
  buildTurnModelRef: MutableRefObject<string>;
  /** Imagine image/video generator id, or "". */
  imagineModelRef: MutableRefObject<string>;
  /** Read the picker's stored ids at send time so Home-bar and page
   *  copies cannot drift. Also points the send refs at that result. */
  resolveSendModels: (view?: StudioView) => { llmOverride: string; imageModel: string };
  syncStudioTurnModel: (view: StudioView, active: boolean) => void;
  /** @deprecated use syncStudioTurnModel */
  syncBuildTurnModel: (inBuildMode: boolean) => void;
}

export function useBuildModelSelection({
  modelTier,
  planLoading,
  customModelId,
}: {
  modelTier: string;
  planLoading: boolean;
  customModelId?: string | null;
}): UseBuildModelSelectionReturn {
  const catalogQuery = useQuery({
    queryKey: ["studio-model-catalog"],
    queryFn: async () => {
      const data = await fetchModelCatalog();
      return Array.isArray(data?.models) ? (data.models as CatalogModel[]) : [];
    },
    staleTime: 10 * 60_000,
    retry: 1,
  });
  const catalog = useMemo<CatalogModel[]>(
    () => (catalogQuery.data?.length ? catalogQuery.data : catalogFromPickerGroups()),
    [catalogQuery.data],
  );

  const [buildModel, setBuildModelState] = useState<string>(() =>
    loadStudioModeModel("build", catalogFromPickerGroups()),
  );
  const [researchModel, setResearchModelState] = useState<string>(() =>
    loadStudioModeModel("research", catalogFromPickerGroups()),
  );
  const [imagineModel, setImagineModelState] = useState<string>(() =>
    loadStudioModeModel("imagine", catalogFromPickerGroups()),
  );

  const buildTurnModelRef = useRef("");
  const imagineModelRef = useRef("");
  const viewRef = useRef<StudioView>("chat");
  const activeRef = useRef(false);
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;
  const modelTierRef = useRef(modelTier);
  modelTierRef.current = modelTier;
  const customModelIdRef = useRef(customModelId);
  customModelIdRef.current = customModelId;

  const setBuildModel = useCallback(
    (value: string) => {
      setBuildModelState(saveStudioModeModel("build", value, catalog, modelTier));
    },
    [catalog, modelTier],
  );
  const setResearchModel = useCallback(
    (value: string) => {
      setResearchModelState(saveStudioModeModel("research", value, catalog, modelTier));
    },
    [catalog, modelTier],
  );
  const setImagineModel = useCallback(
    (value: string) => {
      setImagineModelState(saveStudioModeModel("imagine", value, catalog, modelTier));
    },
    [catalog, modelTier],
  );

  const resolveSendModels = useCallback((view?: StudioView) => {
    const mode = view || (activeRef.current ? viewRef.current : "chat");
    const peeked = peekStudioSendModels({
      mode,
      catalog: catalogRef.current,
      modelTier: modelTierRef.current,
      customModelId: customModelIdRef.current,
    });
    buildTurnModelRef.current = peeked.llmOverride;
    imagineModelRef.current = peeked.imageModel;
    return peeked;
  }, []);

  const syncStudioTurnModel = useCallback(
    (view: StudioView, active: boolean) => {
      viewRef.current = view;
      activeRef.current = active;
      resolveSendModels(active ? view : "chat");
    },
    [resolveSendModels],
  );

  const syncBuildTurnModel = useCallback(
    (inBuildMode: boolean) => {
      syncStudioTurnModel(inBuildMode ? "build" : viewRef.current, inBuildMode || activeRef.current);
    },
    [syncStudioTurnModel],
  );

  useEffect(() => {
    syncStudioTurnModel(viewRef.current, activeRef.current);
  }, [syncStudioTurnModel]);

  useEffect(() => {
    if (planLoading) return;
    // Don't bounce a live catalog pick against the fallback list — that
    // used to rewrite storage back to Auto before /api/models returned.
    if (!catalogQuery.data?.length) return;
    const nextBuild = normalizeStudioModeModel("build", buildModel, catalog, modelTier);
    if (nextBuild !== buildModel) setBuildModelState(saveStudioModeModel("build", nextBuild, catalog, modelTier));
    const nextResearch = normalizeStudioModeModel("research", researchModel, catalog, modelTier);
    if (nextResearch !== researchModel) {
      setResearchModelState(saveStudioModeModel("research", nextResearch, catalog, modelTier));
    }
    const nextImagine = normalizeStudioModeModel("imagine", imagineModel, catalog, modelTier);
    if (nextImagine !== imagineModel) {
      setImagineModelState(saveStudioModeModel("imagine", nextImagine, catalog, modelTier));
    }
  }, [buildModel, researchModel, imagineModel, catalog, modelTier, planLoading, catalogQuery.data]);

  useEffect(() => {
    const syncBuild = () => setBuildModelState(loadStudioModeModel("build", catalog, modelTier));
    const syncResearch = () =>
      setResearchModelState(loadStudioModeModel("research", catalog, modelTier));
    const syncImagine = () =>
      setImagineModelState(loadStudioModeModel("imagine", catalog, modelTier));
    window.addEventListener(studioModelChangedEvent("build"), syncBuild);
    window.addEventListener(studioModelChangedEvent("research"), syncResearch);
    window.addEventListener(studioModelChangedEvent("imagine"), syncImagine);
    window.addEventListener("storage", syncBuild);
    window.addEventListener("storage", syncResearch);
    window.addEventListener("storage", syncImagine);
    return () => {
      window.removeEventListener(studioModelChangedEvent("build"), syncBuild);
      window.removeEventListener(studioModelChangedEvent("research"), syncResearch);
      window.removeEventListener(studioModelChangedEvent("imagine"), syncImagine);
      window.removeEventListener("storage", syncBuild);
      window.removeEventListener("storage", syncResearch);
      window.removeEventListener("storage", syncImagine);
    };
  }, [catalog, modelTier]);

  return {
    catalog,
    buildModel: buildModel || STUDIO_MODEL_AUTO,
    setBuildModel,
    researchModel: researchModel || STUDIO_MODEL_AUTO,
    setResearchModel,
    imagineModel: imagineModel || STUDIO_MODEL_AUTO,
    setImagineModel,
    buildTurnModelRef,
    imagineModelRef,
    resolveSendModels,
    syncStudioTurnModel,
    syncBuildTurnModel,
  };
}
