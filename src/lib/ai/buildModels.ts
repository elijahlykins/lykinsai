// Build-mode coding model persistence. The under-bar picker itself is shared
// across Studio modes (see studioModeModels.ts); this module keeps the
// Build-only storage key and the send-time override helpers that
// useBuildModelSelection / older tests import.
import {
  STUDIO_MODEL_AUTO,
  catalogFromPickerGroups,
  isStudioModelAllowed,
  loadStudioModeModel,
  normalizeStudioModeModel,
  optionsForStudioMode,
  saveStudioModeModel,
  studioLlmOverride,
  studioModelLabel,
  type CatalogModel,
} from "@/lib/ai/studioModeModels";

export const BUILD_MODEL_AUTO = STUDIO_MODEL_AUTO;
export const BUILD_MODEL_STORAGE_KEY = "lykn_build_model";
export const BUILD_MODEL_CHANGED_EVENT = "lykn_build_model_changed";

export interface BuildModelOption {
  value: string;
  label: string;
  hint: string;
}

const FALLBACK_CATALOG: CatalogModel[] = catalogFromPickerGroups();

/** Full text-model list (closed + whatever the catalog fallback has). */
export const BUILD_MODEL_OPTIONS: BuildModelOption[] = optionsForStudioMode(
  "build",
  FALLBACK_CATALOG,
);

const BUILD_MODEL_IDS = new Set(BUILD_MODEL_OPTIONS.map((o) => o.value));

export function isBuildModelId(value: unknown): boolean {
  return BUILD_MODEL_IDS.has(String(value || "").trim());
}

export function buildModelLabel(value: string): string {
  return studioModelLabel("build", value, FALLBACK_CATALOG);
}

export function isBuildModelAllowed(value: string, modelTier: string): boolean {
  return isStudioModelAllowed(value, modelTier);
}

export function normalizeBuildModel(value: unknown, modelTier?: string): string {
  return normalizeStudioModeModel("build", value, FALLBACK_CATALOG, modelTier);
}

export function loadBuildModel(modelTier?: string): string {
  return loadStudioModeModel("build", FALLBACK_CATALOG, modelTier);
}

export function saveBuildModel(value: string, modelTier?: string): string {
  return saveStudioModeModel("build", value, FALLBACK_CATALOG, modelTier);
}

export function buildTurnModelOverride({
  buildModel,
  inBuildMode,
  customModelId,
  modelTier,
}: {
  buildModel: string;
  inBuildMode: boolean;
  customModelId?: string | null;
  modelTier?: string;
}): string {
  if (!inBuildMode) return "";
  return studioLlmOverride({
    mode: "build",
    value: buildModel,
    customModelId,
    catalog: FALLBACK_CATALOG,
    modelTier,
  });
}
