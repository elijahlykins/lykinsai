/**
 * Picker display names and trailing tags (Cheap, Fast, Top tier, …).
 *
 * OpenRouter ships some rows as "(free)". That is their rate-limited $0
 * variant, not LYKN's Free plan - strip it, then label the model by cost,
 * speed, and capability so the row is actually useful.
 */

import { MODEL_PRICING } from '../../../lib/models/pricingTable.js';
import { LYKN_ID, MY_SETUP_ID } from '../modelCatalog.js';

const FREE_MARK = /\s*[\(\[]\s*free\s*[\)\]]/gi;
const FREE_SUFFIX = /\s*:free\b/gi;
const FREE_WORD = /\s+\bfree\b/gi;

export function cleanModelLabel(raw) {
  let text = String(raw || "").trim();
  if (!text) return "";
  text = text.replace(FREE_SUFFIX, "");
  text = text.replace(FREE_MARK, "");
  text = text.replace(/^[^:]+:\s*/, "");
  text = text.replace(FREE_WORD, "");
  text = text.replace(/^\bfree\b|\bfree\b$/gi, "");
  return text.replace(/\s{2,}/g, " ").trim();
}

function outputsOf(model) {
  const out = model?.modalities?.output;
  if (!Array.isArray(out) || out.length === 0) return [];
  return out.map((item) => String(item).toLowerCase());
}

function slugOf(id) {
  const raw = String(id || "").trim();
  const noVariant = raw.replace(/:(free|nitro|extended|thinking)$/i, "");
  if (!noVariant.includes("/")) return noVariant;
  return noVariant.slice(noVariant.lastIndexOf("/") + 1);
}

function pricingOf(model) {
  const direct = model?.pricing;
  if (direct && Number.isFinite(Number(direct.output))) {
    return {
      input: Number(direct.input) || 0,
      output: Number(direct.output) || 0,
    };
  }
  const id = String(model?.id || model?.value || "").trim();
  if (MODEL_PRICING[id]) return MODEL_PRICING[id];
  const slug = slugOf(id);
  if (slug && MODEL_PRICING[slug]) return MODEL_PRICING[slug];
  return null;
}

function costBandFromId(id) {
  const m = String(id || "").toLowerCase();
  if (/nano|mini|lite|haiku|luna/.test(m)) return "Cheap";
  if (/flash/.test(m) && !/pro/.test(m)) return "Low";
  if (/fable|astra|o3-pro|sora-2-pro|kling.*pro/.test(m)) return "Top tier";
  if (/\bo3\b|opus|\bsol\b|gpt-5-pro|gpt-5\.\d-pro/.test(m)) return "Expensive";
  return "Standard";
}

/** USD per 1K output tokens → a short cost label. $0 OpenRouter rows are Cheap. */
export function costBandForModel(model) {
  const pricing = pricingOf(model);
  if (pricing) {
    const out = Number(pricing.output) || 0;
    const inn = Number(pricing.input) || 0;
    if (out <= 0 && inn <= 0) return "Cheap";
    if (out <= 0.002) return "Cheap";
    if (out <= 0.006) return "Low";
    if (out <= 0.015) return "Standard";
    if (out <= 0.03) return "Expensive";
    return "Top tier";
  }
  return costBandFromId(model?.id || model?.value || model?.label || "");
}

export function isFastModel(id, label = "") {
  const hay = `${id} ${label}`.toLowerCase();
  return /nano|mini|lite|flash|haiku|luna|\bfast\b/.test(hay);
}

function isReasoningModel(model) {
  const id = String(model?.id || model?.value || "").toLowerCase();
  if (/^o3\b|^o4-mini\b|[:/]r1\b|\br1\b|thinking/.test(id)) return true;
  if (model?.capabilities?.reasoning && /r1|reason|thinking|o3|o4/.test(id)) return true;
  return false;
}

function mediaTag(model) {
  const out = outputsOf(model);
  if (out.includes("video")) return "Video";
  if (out.includes("image") && !out.includes("text")) return "Image";
  return "";
}

/**
 * Trailing picker hint. Groups already name the lab, so this is cost / speed
 * / capability only. Auto is left to the caller (it names the resolved model).
 */
export function modelPickerHint(model = {}) {
  const id = String(model.id || model.value || "").trim();
  if (!id || id === "auto") return "";
  if (id === LYKN_ID) return "Everyday";
  if (id === MY_SETUP_ID) return "Your routing";

  const label = String(model.label || "");
  const tags = [];
  const cost = costBandForModel({ ...model, id });
  if (cost) tags.push(cost);
  if (isFastModel(id, label)) tags.push("Fast");
  if (isReasoningModel(model)) tags.push("Reasoning");
  if (/grok-build/.test(id)) tags.push("Coding");
  const media = mediaTag(model);
  if (media) tags.push(media);
  return tags.join(" · ");
}

export function displayModelLabel(model = {}) {
  const id = String(model.id || model.value || "").trim();
  if (id === LYKN_ID) return "LYKN";
  if (id === MY_SETUP_ID) return "My Setup";
  if (id === "auto") return "Auto";
  return cleanModelLabel(model.label || id) || id;
}
