/**
 * `/model` in the Glass composer. Keep in lockstep with
 * src/lib/chat/slashModelQuery.ts — that file is the tested copy.
 */

import { slashNameMatchRank } from "./slashPathQuery.js";

const LIST_CAP = 80;
const MODEL_FAMILY =
  /^(gpt|chatgpt|claude|anthropic|grok|gemini|llama|mistral|deepseek|qwen|sonnet|opus|haiku|o[1-4]|lykn|sol|luna|terra|dall-?e|flux|sora|imagen|kimi|glm)\b/i;

export function looksLikeModelShortcut(query) {
  const q = String(query || "").trim();
  if (!q || /^model$/i.test(q)) return false;
  if (/\d/.test(q)) return true;
  if (q.includes("-") && q.length >= 3) return true;
  return MODEL_FAMILY.test(q);
}

export function findSlashModelToken(text, cursor) {
  const pos = Math.max(0, Math.min(Number(cursor) || 0, String(text || "").length));
  const before = String(text || "").slice(0, pos);
  const picker = /(?:^|[\s])(\/model\s*)$/i.exec(before);
  if (picker) {
    const raw = picker[1];
    const start = before.length - raw.length;
    return { start, end: pos, raw, query: "", kind: "picker" };
  }
  const match = /(?:^|[\s])(\/[^\s/]+)$/.exec(before);
  if (!match) return null;
  const raw = match[1];
  if (raw.startsWith("//")) return null;
  const query = raw.slice(1);
  if (!looksLikeModelShortcut(query)) return null;
  const start = before.length - raw.length;
  return { start, end: pos, raw, query, kind: "search" };
}

function optionRank(option, q) {
  const parts = [
    String(option.label || ""),
    String(option.value || "").split("/").pop() || "",
    String(option.value || ""),
    String(option.hint || ""),
    String(option.group || ""),
  ];
  let best = -1;
  for (const part of parts) {
    const rank = slashNameMatchRank(part.toLowerCase(), q);
    if (rank < 0) continue;
    if (best < 0 || rank < best) best = rank;
  }
  return best;
}

export function rankSlashModelOptions(options, query) {
  const q = String(query || "").toLowerCase();
  const rows = (Array.isArray(options) ? options : [])
    .map((option, index) => ({
      option,
      index,
      rank: q ? optionRank(option, q) : 0,
      label: String(option.label || "").toLowerCase(),
    }))
    .filter((row) => row.rank >= 0);
  rows.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    const lock = Number(!!a.option.locked) - Number(!!b.option.locked);
    if (lock) return lock;
    if (!q && a.index !== b.index) return a.index - b.index;
    if (a.label.length !== b.label.length) return a.label.length - b.label.length;
    const alpha = a.label.localeCompare(b.label);
    if (alpha) return alpha;
    return a.index - b.index;
  });
  return rows.slice(0, LIST_CAP).map((row) => row.option);
}

const MODELS_DEV_LOGO_PREFIX = "https://models.dev/logos/";

const LAB_SLUG_REMAP = {
  gemini: "google",
  qwen: "alibaba",
  moonshot: "moonshotai",
  zhipu: "zai",
  "z-ai": "zai",
  amazon: "amazon-bedrock",
  microsoft: "azure",
  grok: "xai",
  "x-ai": "xai",
  "meta-llama": "meta",
  llama: "meta",
  mistralai: "mistral",
};

const KNOWN_LAB_SLUGS = new Set([
  "openai",
  "anthropic",
  "google",
  "xai",
  "meta",
  "deepseek",
  "mistral",
  "alibaba",
  "moonshotai",
  "cohere",
  "zai",
  "amazon-bedrock",
  "nvidia",
  "perplexity",
  "minimax",
  "azure",
]);

function remapLabSlug(slug) {
  const key = String(slug || "").trim().toLowerCase();
  if (!key) return "";
  const mapped = LAB_SLUG_REMAP[key] || key;
  return KNOWN_LAB_SLUGS.has(mapped) ? mapped : "";
}

export function modelLabLogoSlug(option) {
  const id = String(option?.value || "").trim().toLowerCase();
  if (!id || id === "lykn" || id === "auto" || id === "lykn-setup" || id.startsWith("custom:")) {
    return "";
  }
  if (id.includes("/")) {
    const fromProvider = remapLabSlug(id.slice(0, id.indexOf("/")));
    if (fromProvider) return fromProvider;
  }
  const hay = [id, option?.label, option?.hint, option?.group]
    .map((part) => String(part || "").toLowerCase())
    .join(" ");
  if (/\b(openai|chatgpt|dall-?e|sora)\b/.test(hay) || /\bgpt\b/.test(hay) || /^o[1-4]\b/.test(id)) {
    return "openai";
  }
  if (/\b(anthropic|claude|sonnet|opus|haiku)\b/.test(hay)) return "anthropic";
  if (/\b(xai|x-ai|grok)\b/.test(hay)) return "xai";
  if (/\b(gemini|google|imagen)\b/.test(hay)) return "google";
  if (/\b(llama|meta)\b/.test(hay)) return "meta";
  if (/\b(mistral|mixtral)\b/.test(hay)) return "mistral";
  if (/\bdeepseek\b/.test(hay)) return "deepseek";
  if (/\b(qwen|alibaba)\b/.test(hay)) return "alibaba";
  if (/\b(kimi|moonshot)\b/.test(hay)) return "moonshotai";
  if (/\b(glm|zhipu|z\.ai)\b/.test(hay)) return "zai";
  if (/\b(cohere|command)\b/.test(hay)) return "cohere";
  if (/\bnvidia\b/.test(hay)) return "nvidia";
  if (/\bperplexity\b/.test(hay)) return "perplexity";
  if (/\bminimax\b/.test(hay)) return "minimax";
  if (/\b(azure|microsoft|phi)\b/.test(hay)) return "azure";
  if (/\b(amazon|nova|bedrock)\b/.test(hay)) return "amazon-bedrock";
  return "";
}

export function modelLabLogoUrl(option) {
  const slug = modelLabLogoSlug(option);
  if (!slug) return "";
  return `${MODELS_DEV_LOGO_PREFIX}${encodeURIComponent(slug)}.svg`;
}
