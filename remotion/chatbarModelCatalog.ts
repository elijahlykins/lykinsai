// Provider marks: @lobehub/icons-static-svg 1.95.0, stored locally for deterministic renders.
export const MODEL_NAMES = [
  "GPT-6", "Claude Fable 5.1", "Grok 4.6", "Gemini 2.5 Pro",
  "GPT-4.1", "Claude Sonnet 4", "Grok 3",
  "GPT-4o", "Claude Opus 4", "Grok 3 Mini", "Gemini 2.5 Flash",
  "OpenAI o3", "Claude 3.7 Sonnet", "GPT-4.1 Mini", "Gemini 2.0 Flash",
  "OpenAI o4-mini", "Claude 3.5 Haiku", "GPT-4.1 Nano", "DeepSeek R1",
  "Llama 4 Maverick", "Qwen3-235B", "Mistral Small 3.1", "Gemma 3 27B",
  "DeepSeek V3", "Llama 4 Scout", "Qwen3-32B", "Phi-4",
  "Command A", "Mixtral 8x22B", "GPT-4o Mini", "OpenAI o1",
  "Claude 3 Opus", "Grok 2", "Gemini 1.5 Pro", "Llama 3.3 70B",
  "QwQ-32B", "Mistral Large 2", "Gemma 2 9B", "Phi-4 Mini",
  "Command R+", "OLMo 2 32B", "Falcon 3 10B", "Qwen2.5-Coder 32B",
  "DeepSeek V2.5", "Llama 3.1 405B", "Gemma 3 12B", "Mixtral 8x7B",
  "GPT-4 Turbo", "Claude 3.5 Sonnet", "Grok 2 Mini", "Gemini 2.0 Flash Lite",
  "OpenAI o1 Mini", "Claude 3 Haiku", "Qwen3-14B", "Llama 3.1 70B",
  "GPT-4", "Claude 3 Sonnet", "Gemini 1.5 Flash", "DeepSeek Coder V2",
  "OpenAI o1 Pro", "Qwen3-8B", "Mistral Nemo", "Gemma 3 4B",
  "GPT-3.5 Turbo", "Claude 2.1", "Grok 1", "Gemini 1.5 Flash 8B",
  "OpenAI o3 Mini", "Qwen3-4B", "Llama 3.1 8B", "Phi-3 Medium",
  "Command R", "DeepSeek R1 Zero", "Codestral", "Gemma 2 27B",
  "OpenAI o1 Preview", "Claude 2", "Qwen2.5-72B", "Llama 3 70B",
  "Gemini 1.0 Pro", "Phi-3.5 Mini", "Mistral 7B", "OLMo 2 13B",
  "Qwen2.5-32B", "DeepSeek V2", "Llama 3 8B", "Falcon 3 7B",
  "Qwen2.5-14B", "Gemma 2 2B", "Mistral Large", "Phi-3 Mini",
  "Qwen2.5-7B", "Llama 3.2 90B", "Pixtral 12B", "OLMo 2 7B",
  "Qwen2.5-Coder 14B", "Gemma 3 1B", "Falcon 3 3B", "Phi-3 Small",
  "Qwen2.5-Coder 7B", "Llama 3.2 11B", "Mistral Small", "Falcon 3 1B",
  "Qwen2.5-Math 72B", "Gemma 7B", "Llama 3.2 3B", "Phi-2",
  "Qwen2.5-VL 72B", "Gemma 2B", "Llama 3.2 1B", "Pixtral Large",
  "Qwen2.5-VL 7B", "Falcon 180B", "Llama 2 70B", "Mathstral 7B",
  "Qwen2.5-VL 3B", "Falcon 40B", "Llama 2 13B", "Codestral Mamba",
  "Qwen2-72B", "Falcon 7B", "Llama 2 7B", "OpenChat 3.5",
  "Kimi K2", "GLM-4-32B", "Jamba 1.5 Large", "Nemotron 70B",
  "Kimi K1.5", "GLM-4-9B", "Jamba 1.5 Mini", "Granite 3.3 8B",
  "Sonar Pro", "Yi 1.5 34B", "InternLM2.5 20B", "Baichuan 2 13B",
  "Sonar Reasoning", "Yi 1.5 9B", "InternLM2.5 7B", "Granite 3.3 2B",
  "Sonar", "Yi 1.5 6B", "DBRX Instruct", "Arctic Instruct",
];

// One pass only: readable headline models, then a continuous full-speed finish.
export const MODEL_SEQUENCE = [...MODEL_NAMES, "Any Model"];

export const modelLogo = (name: string): string => {
  if (/^(GPT|OpenAI)/.test(name)) return "openai";
  if (name.startsWith("Claude")) return "claude";
  if (name.startsWith("Grok")) return "xai";
  if (name.startsWith("Gemini")) return "gemini";
  if (name.startsWith("Gemma")) return "gemma";
  if (name.startsWith("DeepSeek")) return "deepseek";
  if (name.startsWith("Llama")) return "meta";
  if (/^(Qwen|QwQ)/.test(name)) return "qwen";
  if (/^(Mistral|Mixtral|Codestral|Pixtral|Mathstral)/.test(name)) return "mistral";
  if (name.startsWith("Phi")) return "microsoft";
  if (name.startsWith("Command")) return "cohere";
  if (name.startsWith("OLMo")) return "ai2";
  if (name.startsWith("Falcon")) return "tii";
  if (name.startsWith("Kimi")) return "moonshot";
  if (name.startsWith("GLM")) return "zhipu";
  if (name.startsWith("Jamba")) return "ai21";
  if (name.startsWith("Nemotron")) return "nvidia";
  if (name.startsWith("Granite")) return "ibm";
  if (name.startsWith("Sonar")) return "perplexity";
  if (name.startsWith("Yi")) return "yi";
  if (name.startsWith("InternLM")) return "internlm";
  if (name.startsWith("Baichuan")) return "baichuan";
  if (name.startsWith("DBRX")) return "dbrx";
  if (name.startsWith("Arctic")) return "snowflake";
  if (name.startsWith("OpenChat")) return "openchat";
  throw new Error(`Missing model logo for ${name}`);
};
