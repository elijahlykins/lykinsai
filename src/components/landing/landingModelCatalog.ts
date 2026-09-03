/** Popular OpenRouter models for the landing ticker's first paint. Live catalog from `/api/public/models` replaces this once it loads. */
export type LandingModel = {
  id: string;
  name: string;
  logoUrl: string;
};

export const MODELS_DEV_LOGO_PREFIX = "https://models.dev/logos/";
const ID_RE = /^[a-z0-9_./:-]{1,96}$/i;

function logoUrlFor(slug: string) {
  return `${MODELS_DEV_LOGO_PREFIX}${encodeURIComponent(slug)}.svg`;
}

const FALLBACK_MODELS: { id: string; name: string; logo: string }[] = [
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", logo: "openai" },
  { id: "claude-fable-5", name: "Claude Fable 5", logo: "anthropic" },
  { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro", logo: "gemini" },
  { id: "grok-4.6", name: "Grok 4.6", logo: "xai" },
  { id: "meta-llama/llama-4-maverick", name: "Llama 4 Maverick", logo: "meta" },
  { id: "deepseek/deepseek-r1", name: "DeepSeek R1", logo: "deepseek" },
  { id: "mistralai/mistral-large", name: "Mistral Large", logo: "mistral" },
  { id: "qwen/qwen3-235b-a22b", name: "Qwen3", logo: "qwen" },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", logo: "openai" },
  { id: "claude-opus-5", name: "Claude Opus 5", logo: "anthropic" },
  { id: "gemini-3.6-flash", name: "Gemini 3.6 Flash", logo: "gemini" },
  { id: "moonshotai/kimi-k2", name: "Kimi K2", logo: "moonshot" },
  { id: "cohere/command-a", name: "Command A", logo: "cohere" },
  { id: "z-ai/glm-4.5", name: "GLM 4.5", logo: "zhipu" },
  { id: "amazon/nova-pro-v1", name: "Amazon Nova", logo: "amazon" },
  { id: "nvidia/llama-nemotron", name: "NVIDIA Nemotron", logo: "nvidia" },
  { id: "perplexity/sonar-pro", name: "Sonar Pro", logo: "perplexity" },
  { id: "minimax/minimax-m1", name: "MiniMax", logo: "minimax" },
  { id: "microsoft/phi-4", name: "Phi-4", logo: "microsoft" },
  { id: "ai21/jamba-large", name: "Jamba", logo: "ai21" },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", logo: "anthropic" },
  { id: "grok-build-0.1", name: "Grok Build", logo: "xai" },
  { id: "inflection/inflection-3", name: "Inflection 3", logo: "inflection" },
  { id: "liquid/lfm-2", name: "LFM 2", logo: "liquid" },
  { id: "nousresearch/hermes-4", name: "Hermes 4", logo: "nousresearch" },
  { id: "deepseek/deepseek-chat", name: "DeepSeek V3", logo: "deepseek" },
  { id: "mistralai/mixtral-8x22b", name: "Mixtral", logo: "mistral" },
  { id: "alibaba/qwen-max", name: "Qwen Max", logo: "alibaba" },
];

export const FALLBACK_LANDING_MODELS: LandingModel[] = FALLBACK_MODELS.map(
  (model) => ({
    id: model.id,
    name: model.name,
    logoUrl: logoUrlFor(model.logo),
  }),
);

export function sanitizeLandingModel(value: unknown): LandingModel | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const id = String(row.id || "").trim();
  if (!ID_RE.test(id)) return null;
  const name = String(row.name || id).trim().slice(0, 80);
  const logoUrl = String(row.logoUrl || "").trim();
  if (!name || !logoUrl.startsWith(MODELS_DEV_LOGO_PREFIX)) return null;
  if (!logoUrl.endsWith(".svg")) return null;
  return { id, name, logoUrl };
}
