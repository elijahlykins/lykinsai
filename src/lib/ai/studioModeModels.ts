// Per-Studio-mode model menus for the under-bar picker.
//
// Chat / Research / Build pick an LLM. Imagine picks an image or video
// generator. Lists come from the live `/api/models` catalog (curated closed
// models plus the OpenRouter sync: open-source, cheap, expensive) with a
// MODEL_GROUPS fallback when the catalog has not loaded yet.
//
// Persistence is per mode so switching Chat → Build does not rewrite the
// global chat preference. Chat is the exception: it writes the existing
// `lykinsai_settings.aiModel` key via useChatModelSelection.

import {
  LYKN_CODING_MODEL_ID,
  LYKN_ID,
  MODEL_GROUPS,
  MY_SETUP_ID,
} from "@/lib/modelCatalog";
import {
  displayModelLabel,
  modelPickerHint,
} from "@/lib/models/modelPickerMeta";
import { isModelAllowedForPlan } from "@/lib/modelTiers";
import type { StudioView } from "@/components/lyknChat/StudioChatChrome";

export const STUDIO_MODEL_AUTO = "auto";

export type StudioPickerMode = StudioView;

export type CatalogModel = {
  id: string;
  label: string;
  provider?: string;
  family?: string;
  recommended?: boolean;
  visibility?: string;
  capabilities?: {
    tools?: boolean;
    vision?: boolean;
    reasoning?: boolean;
  };
  modalities?: {
    input?: string[];
    output?: string[];
  };
  pricing?: {
    input?: number;
    output?: number;
    cachedInput?: number;
  } | null;
};

export type StudioModelOption = {
  value: string;
  label: string;
  hint: string;
  group: string;
};

/** Image / video generators we can actually run, plus well-known video ids
 *  that the OpenRouter catalog may also surface.
 *
 *  Auto's committed defaults: GPT Image 2 for images (server chain tries
 *  OpenAI first, Gemini fallback — lib/exterior/generateImage.js) and
 *  Veo 3.1 Fast for video (lib/exterior/generateVideo.js) — chosen for
 *  native audio, first-frame image-to-video, and a per-clip cost that fits
 *  the video_gen pricing assumption. Flagship tiers (Kling 3 Pro, Sora 2
 *  Pro) stay explicit picks. */
function imagineOption(
  value: string,
  label: string,
  group: "Image" | "Video",
): StudioModelOption {
  return {
    value,
    label,
    hint: modelPickerHint({
      id: value,
      label,
      modalities: { output: [group.toLowerCase()] },
    }),
    group,
  };
}

export const IMAGINE_CURATED_MODELS: StudioModelOption[] = [
  { value: STUDIO_MODEL_AUTO, label: "Auto", hint: "GPT Image 2 · Veo 3.1 Fast", group: "" },
  imagineOption("gpt-image-2", "GPT Image 2", "Image"),
  imagineOption("dall-e-3", "DALL·E 3", "Image"),
  imagineOption("gemini-2.5-flash-image", "Gemini 2.5 Flash Image", "Image"),
  imagineOption("gemini-3.1-flash-image", "Gemini 3.1 Flash Image", "Image"),
  imagineOption("google/veo-3.1-fast", "Veo 3.1 Fast", "Video"),
  imagineOption("google/veo-3.1", "Veo 3.1", "Video"),
  imagineOption("kwaivgi/kling-v3.0-pro", "Kling 3.0 Pro", "Video"),
  imagineOption("bytedance/seedance-2.0", "Seedance 2.0", "Video"),
  imagineOption("openai/sora-2-pro", "Sora 2 Pro", "Video"),
];

export const IMAGINE_CURATED_IDS = new Set(
  IMAGINE_CURATED_MODELS.map((o) => o.value).filter((v) => v !== STUDIO_MODEL_AUTO),
);

const IMAGINE_VIDEO_MODEL_IDS = new Set(
  IMAGINE_CURATED_MODELS.filter((o) => o.group === "Video").map((o) => o.value),
);

/** LYKN's committed lane defaults — what Auto actually runs, and where an
 *  automatic lane switch lands when the user has no preference of their own. */
export const LYKN_DEFAULT_IMAGE_MODEL = "gpt-image-2";
export const LYKN_DEFAULT_VIDEO_MODEL = "google/veo-3.1-fast";

export type ImagineLane = "image" | "video";

/** Is this Imagine pick a VIDEO generator? Decides which lane a picked model
 *  is forwarded to — an image model must never reach /api/ai/imagine-video
 *  and vice versa; the other lane falls back to its Auto default. */
export function isImagineVideoModelId(id: unknown): boolean {
  return IMAGINE_VIDEO_MODEL_IDS.has(String(id || "").trim());
}

export function imagineLaneOf(id: unknown): ImagineLane {
  return isImagineVideoModelId(id) ? "video" : "image";
}

const PROVIDER_LABEL: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  gemini: "Google",
  xai: "xAI",
  "x-ai": "xAI",
  grok: "xAI",
  "meta-llama": "Meta",
  meta: "Meta",
  llama: "Meta",
  deepseek: "DeepSeek",
  mistralai: "Mistral",
  mistral: "Mistral",
  qwen: "Qwen",
  alibaba: "Qwen",
  moonshotai: "Moonshot",
  moonshot: "Moonshot",
  cohere: "Cohere",
  amazon: "Amazon",
  nvidia: "NVIDIA",
  perplexity: "Perplexity",
  minimax: "MiniMax",
  microsoft: "Microsoft",
  ai21: "AI21",
  "z-ai": "Zhipu",
  zhipu: "Zhipu",
  nousresearch: "Nous",
  liquid: "Liquid",
  inflection: "Inflection",
};

function providerOf(model: CatalogModel): string {
  const raw = String(model.provider || "").trim();
  if (raw) return raw;
  const id = String(model.id || "");
  if (id.includes("/")) return id.slice(0, id.indexOf("/"));
  return "other";
}

export function providerGroupLabel(provider: string): string {
  const key = String(provider || "").toLowerCase();
  return PROVIDER_LABEL[key] || (provider ? provider : "Other");
}

function outputsOf(model: CatalogModel): string[] {
  const out = model.modalities?.output;
  if (!Array.isArray(out) || out.length === 0) return ["text"];
  return out.map((m) => String(m).toLowerCase());
}

/** Chat / Research / Build: anything that can answer in text. Image-only
 *  and video-only generators stay on Imagine. */
export function isTextCatalogModel(model: CatalogModel): boolean {
  const id = String(model.id || "").trim();
  if (!id || id === LYKN_ID || id === MY_SETUP_ID) return false;
  if (IMAGINE_CURATED_IDS.has(id)) return false;
  return outputsOf(model).includes("text");
}

export function isImagineCatalogModel(model: CatalogModel): boolean {
  const id = String(model.id || "").trim();
  if (!id) return false;
  if (IMAGINE_CURATED_IDS.has(id)) return true;
  const out = outputsOf(model);
  return out.includes("image") || out.includes("video");
}

export function catalogFromPickerGroups(): CatalogModel[] {
  const out: CatalogModel[] = [];
  const seen = new Set<string>();
  for (const group of MODEL_GROUPS) {
    for (const item of group.items) {
      if (seen.has(item.value)) continue;
      seen.add(item.value);
      out.push({
        id: item.value,
        label: item.label,
        provider: group.id === "lykn" ? "lykn" : group.id,
        recommended: group.id === "frontier",
        visibility: "primary",
        capabilities: { tools: true },
        modalities: { input: ["text"], output: ["text"] },
      });
    }
  }
  return out;
}

function optionFromCatalog(model: CatalogModel): StudioModelOption {
  const provider = providerOf(model);
  return {
    value: model.id,
    label: displayModelLabel(model),
    hint: modelPickerHint(model),
    group: providerGroupLabel(provider),
  };
}

function imagineKind(model: CatalogModel): "Image" | "Video" {
  return outputsOf(model).includes("video") ? "Video" : "Image";
}

/**
 * Grouped options for one Studio mode. Auto / LYKN sit in an unlabeled
 * first group; the rest are grouped by lab (or Image / Video on Imagine).
 */
export function optionsForStudioMode(
  mode: StudioPickerMode,
  catalog: CatalogModel[],
): StudioModelOption[] {
  const rows = catalog.length ? catalog : catalogFromPickerGroups();
  if (mode === "imagine") {
    const seen = new Set<string>([STUDIO_MODEL_AUTO]);
    const out: StudioModelOption[] = [...IMAGINE_CURATED_MODELS];
    for (const model of rows) {
      if (!isImagineCatalogModel(model)) continue;
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      const kind = imagineKind(model);
      out.push({
        value: model.id,
        label: displayModelLabel(model),
        hint: modelPickerHint({
          ...model,
          modalities: { output: [kind.toLowerCase()] },
        }),
        group: kind,
      });
    }
    return out;
  }

  const out: StudioModelOption[] = [];
  if (mode === "chat") {
    out.push(
      { value: LYKN_ID, label: "LYKN", hint: modelPickerHint({ id: LYKN_ID }), group: "" },
      { value: MY_SETUP_ID, label: "My Setup", hint: modelPickerHint({ id: MY_SETUP_ID }), group: "" },
    );
  } else {
    out.push({
      value: STUDIO_MODEL_AUTO,
      label: "Auto",
      hint: "LYKN picks",
      group: "",
    });
  }

  const seen = new Set(out.map((o) => o.value));
  const text = rows.filter(isTextCatalogModel);
  const recommended = text.filter((m) => m.recommended && !seen.has(m.id));
  if (recommended.length) {
    for (const model of recommended) {
      seen.add(model.id);
      out.push({ ...optionFromCatalog(model), group: "Top models" });
    }
  }
  for (const model of text) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    out.push(optionFromCatalog(model));
  }
  return out;
}

export function studioModelLabel(
  mode: StudioPickerMode,
  value: string,
  catalog: CatalogModel[],
): string {
  const id = String(value || "").trim();
  if (!id || id === STUDIO_MODEL_AUTO) {
    return mode === "chat" ? "LYKN" : "Auto";
  }
  if (id === LYKN_ID) return "LYKN";
  if (id === MY_SETUP_ID) return "My Setup";
  const curated = IMAGINE_CURATED_MODELS.find((o) => o.value === id);
  if (curated) return curated.label;
  const hit = catalog.find((m) => m.id === id);
  if (hit?.label) return displayModelLabel(hit);
  for (const group of MODEL_GROUPS) {
    const item = group.items.find((i) => i.value === id);
    if (item) return item.label;
  }
  return mode === "chat" ? "LYKN" : "Auto";
}

/**
 * What "Auto" will actually run, so the row isn't a mystery.
 *
 * Auto means "send no override", so the turn follows whatever the chat-bar
 * picker resolved. Build is the one mode where that isn't the whole story:
 * when the chat model is LYKN's own routing, a coded turn is handed to LYKN's
 * default coding model (LYKN_CODING_MODEL_ID) rather than the chat model —
 * see upgradeModelForCodedArtifact in server/ai/modelInvoke.js. When the user
 * picked a specific chat model, that model builds, and nothing reroutes it.
 */
export function autoStudioModelHint(
  mode: StudioPickerMode,
  chatModelId: string,
  catalog: CatalogModel[] = [],
): string {
  const id = String(chatModelId || "").trim();
  const usingLyknRouting = !id || id === LYKN_ID || id === MY_SETUP_ID;
  if (mode !== "build") return usingLyknRouting ? "LYKN picks" : studioModelLabel(mode, id, catalog);
  return usingLyknRouting
    ? studioModelLabel(mode, LYKN_CODING_MODEL_ID, catalog)
    : studioModelLabel(mode, id, catalog);
}

export function isStudioModelAllowed(value: string, modelTier: string): boolean {
  const id = String(value || "").trim();
  if (!id || id === STUDIO_MODEL_AUTO || id === LYKN_ID || id === MY_SETUP_ID) {
    return true;
  }
  return isModelAllowedForPlan(id, modelTier);
}

const STORAGE: Record<Exclude<StudioPickerMode, "chat">, string> = {
  build: "lykn_build_model",
  research: "lykn_research_model",
  imagine: "lykn_imagine_model",
};

const CHANGED: Record<Exclude<StudioPickerMode, "chat">, string> = {
  build: "lykn_build_model_changed",
  research: "lykn_research_model_changed",
  imagine: "lykn_imagine_model_changed",
};

/** Last explicit pick per Imagine lane — the "preference" an automatic lane
 *  switch restores. Written only by explicit picker picks, never by the
 *  switch itself, so hopping to the video lane and back cannot erase the
 *  model the user actually chose for images (or vice versa). */
const IMAGINE_LANE_PREF: Record<ImagineLane, string> = {
  image: "lykn_imagine_image_model",
  video: "lykn_imagine_video_model",
};

export function studioModelChangedEvent(mode: Exclude<StudioPickerMode, "chat">): string {
  return CHANGED[mode];
}

export function normalizeStudioModeModel(
  mode: StudioPickerMode,
  value: unknown,
  catalog: CatalogModel[],
  modelTier?: string,
): string {
  const id = String(value || "").trim();
  if (mode === "chat") {
    if (!id) return LYKN_ID;
    if (id === STUDIO_MODEL_AUTO) return LYKN_ID;
    if (modelTier && !isStudioModelAllowed(id, modelTier)) return LYKN_ID;
    return id;
  }
  if (!id || id === STUDIO_MODEL_AUTO) return STUDIO_MODEL_AUTO;
  const options = optionsForStudioMode(mode, catalog);
  if (!options.some((o) => o.value === id)) return STUDIO_MODEL_AUTO;
  if (modelTier && !isStudioModelAllowed(id, modelTier)) return STUDIO_MODEL_AUTO;
  return id;
}

export function loadStudioModeModel(
  mode: Exclude<StudioPickerMode, "chat">,
  catalog: CatalogModel[],
  modelTier?: string,
): string {
  try {
    return normalizeStudioModeModel(
      mode,
      localStorage.getItem(STORAGE[mode]),
      catalog,
      modelTier,
    );
  } catch {
    return STUDIO_MODEL_AUTO;
  }
}

export function saveStudioModeModel(
  mode: Exclude<StudioPickerMode, "chat">,
  value: string,
  catalog: CatalogModel[],
  modelTier?: string,
): string {
  const next = normalizeStudioModeModel(mode, value, catalog, modelTier);
  try {
    if (next === STUDIO_MODEL_AUTO) localStorage.removeItem(STORAGE[mode]);
    else {
      localStorage.setItem(STORAGE[mode], next);
      // An explicit Imagine pick doubles as that lane's preference: it is
      // what "make me a video / an image" auto-switches back to later.
      if (mode === "imagine") localStorage.setItem(IMAGINE_LANE_PREF[imagineLaneOf(next)], next);
    }
    window.dispatchEvent(new CustomEvent(CHANGED[mode]));
  } catch {
    /* private mode / storage disabled */
  }
  return next;
}

/** Where an automatic Imagine lane switch lands: the user's last explicit
 *  pick in that lane, or the LYKN default (GPT Image 2 / Veo 3.1 Fast). */
export function preferredImagineModel(lane: ImagineLane): string {
  try {
    const saved = String(localStorage.getItem(IMAGINE_LANE_PREF[lane]) || "").trim();
    if (saved && imagineLaneOf(saved) === lane) return saved;
  } catch {
    /* private mode / storage disabled */
  }
  return lane === "video" ? LYKN_DEFAULT_VIDEO_MODEL : LYKN_DEFAULT_IMAGE_MODEL;
}

/**
 * Automatic lane switch: the prompt asked for the other medium — "make me a
 * video of X" while an image model is picked, or an image ask while a video
 * model is picked. The active Imagine pick moves to `preferredImagineModel`
 * for the asked lane and the change event keeps every picker copy and the
 * composer toggle in sync. Written raw (not re-normalized) so a catalog-only
 * preference survives even before /api/models has loaded; send-time tier
 * gating still applies in `studioImagineOverride`. Lane preferences are
 * deliberately untouched — only explicit picks define them.
 */
export function switchImagineLaneModel(lane: ImagineLane): string {
  const next = preferredImagineModel(lane);
  try {
    localStorage.setItem(STORAGE.imagine, next);
    window.dispatchEvent(new CustomEvent(CHANGED.imagine));
  } catch {
    /* private mode / storage disabled */
  }
  return next;
}

function sendableModelId(value: unknown, modelTier?: string): string {
  const id = String(value || "").trim();
  if (!id || id === STUDIO_MODEL_AUTO) return "";
  if (modelTier && !isStudioModelAllowed(id, modelTier)) return "";
  return id;
}

/** LLM override for the current Studio view. Empty = LYKN auto-routing
 *  (or a Model Builder persona's own base model). Chat explicit picks are
 *  overrides too: the under-bar name is the model the turn must run. */
export function studioLlmOverride({
  mode,
  value,
  customModelId,
  modelTier,
}: {
  mode: StudioPickerMode;
  value: string;
  customModelId?: string | null;
  catalog?: CatalogModel[];
  modelTier?: string;
}): string {
  if (mode === "imagine") return "";
  if (customModelId) return "";
  const id = sendableModelId(value, modelTier);
  if (mode === "chat") {
    if (!id || id === LYKN_ID || id === MY_SETUP_ID) return "";
    return id;
  }
  return id;
}

/** Image/video generator id for Imagine, or "" for the default chain. */
export function studioImagineOverride({
  mode,
  value,
  modelTier,
}: {
  mode: StudioPickerMode;
  value: string;
  catalog?: CatalogModel[];
  modelTier?: string;
}): string {
  if (mode !== "imagine") return "";
  return sendableModelId(value, modelTier);
}

export function readSavedChatModel(): string {
  try {
    const saved = localStorage.getItem("lykinsai_settings");
    if (!saved) return LYKN_ID;
    const parsed = JSON.parse(saved);
    return String(parsed?.aiModel || "").trim() || LYKN_ID;
  } catch {
    return LYKN_ID;
  }
}

/** Raw stored pick, not bounced against the in-memory option list. Send
 *  reads this so a catalog row the fallback list doesn't know yet still
 *  reaches the server. */
export function readStudioModeModelRaw(mode: Exclude<StudioPickerMode, "chat">): string {
  try {
    return String(localStorage.getItem(STORAGE[mode]) || "").trim() || STUDIO_MODEL_AUTO;
  } catch {
    return STUDIO_MODEL_AUTO;
  }
}

/** Send-time model ids, always from storage (the picker the user sees). */
export function peekStudioSendModels({
  mode,
  modelTier,
  customModelId,
  chatModelId,
}: {
  mode: StudioPickerMode;
  catalog?: CatalogModel[];
  modelTier?: string;
  customModelId?: string | null;
  chatModelId?: string;
}): { llmOverride: string; imageModel: string } {
  if (mode === "imagine") {
    return {
      llmOverride: "",
      imageModel: studioImagineOverride({
        mode: "imagine",
        value: readStudioModeModelRaw("imagine"),
        modelTier,
      }),
    };
  }
  const value =
    mode === "chat"
      ? String(chatModelId || "").trim() || readSavedChatModel()
      : readStudioModeModelRaw(mode);
  return {
    llmOverride: studioLlmOverride({
      mode,
      value,
      customModelId,
      modelTier,
    }),
    imageModel: "",
  };
}

export function groupStudioOptions(
  options: StudioModelOption[],
): { label: string; items: StudioModelOption[] }[] {
  const order: string[] = [];
  const map = new Map<string, StudioModelOption[]>();
  for (const option of options) {
    const label = option.group || "";
    if (!map.has(label)) {
      map.set(label, []);
      order.push(label);
    }
    map.get(label)!.push(option);
  }
  return order.map((label) => ({ label, items: map.get(label)! }));
}
