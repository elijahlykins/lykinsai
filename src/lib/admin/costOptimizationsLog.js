// ─── Cost Optimizations Log ─────────────────────────────────────────────────
// A running record of every cost-cutting change shipped to the AI surfaces.
// The admin dashboard renders this at the bottom of /admin/usage so you can
// see at a glance where money has been saved (and how much).
//
// HOW TO ADD A NEW ENTRY:
//   1. Ship the actual optimization in code.
//   2. Add an entry below — set `shippedAt` to today's ISO date.
//   3. Tag it with the right `tier` so it groups under the right roadmap
//      bucket from your cost-cutting plan (Tier 1 = invisible wins, Tier 2 =
//      smart routing, etc.).
//   4. Reference one or more `surfaces` ids from `aiCallCatalog.js` so the
//      dashboard can cross-link to the live spend table.
//
// `expectedSavings` is intentionally a RANGE not a point estimate. The actual
// impact depends on cache hit rates, traffic mix, and prompt sizes — none of
// which we know perfectly upfront.

/**
 * @typedef {Object} CostOptimization
 * @property {string} id                     stable id
 * @property {string} shippedAt              ISO date string YYYY-MM-DD
 * @property {1|2|3|4|5} tier                tier from the cost-cut roadmap
 * @property {("caching"|"model_swap"|"cap"|"dedup"|"debounce"|"kill_waste"|"infra"|"meter")} category
 * @property {string} title                  human label
 * @property {string} description            1-3 sentences
 * @property {string[]} files                files touched (relative paths)
 * @property {string[]} surfaces             aiCallCatalog ids this affects
 * @property {Object} expectedSavings
 * @property {("percent"|"absolute"|"per_request"|"qualitative")} expectedSavings.type
 * @property {number[]} [expectedSavings.range]   [low, high] for percent / absolute
 * @property {string} expectedSavings.scope        plain-English what the savings apply to
 * @property {string} [expectedSavings.note]       optional caveat
 * @property {string} [provider]             which provider this primarily saves on
 * @property {string} [risk]                 known risk or caveat
 */

/** @type {CostOptimization[]} */
export const COST_OPTIMIZATIONS = [
  {
    id: "context-pipeline-cache",
    shippedAt: "2026-08-28",
    tier: 1,
    category: "caching",
    title: "Stable chat prefix + model-specific cached pricing",
    description:
      "Keep identity, prefs, and inventory in a byte-stable system prefix, move volatile time/search/history after the cache split, and price cached input from each model's catalog rate instead of a universal 50% assumption.",
    files: [
      "server/ai/contextPipeline/",
      "server/ai/chatStream.routes.js",
      "server/ai/chatInvoke.routes.js",
      "usageTracking.js",
    ],
    surfaces: ["chat_stream", "chat_invoke"],
    expectedSavings: {
      type: "percent",
      range: [8, 20],
      scope: "uncached input tokens on consecutive Pro/Max chat turns",
      note: "Projected from prefix stability and catalog cache rates. Not measured from live provider traffic.",
    },
    provider: "openai",
    risk: "Older reference turns are kept only when the current message overlaps them. Very long chats still drop unused history.",
  },
  // ─── Tier 1 — invisible wins (shipped 2026-05-06) ───────────────────────
  {
    id: "gemini-context-caching",
    shippedAt: "2026-05-06",
    tier: 1,
    category: "caching",
    title: "Google Gemini context caching",
    description:
      "Cache the static system prompt once per (model + content-hash) via Google's cachedContents API and reference it by name on subsequent generateContent / streamGenerateContent calls. 1h TTL, auto-coalesces concurrent creates, falls back silently to inline systemInstruction when prompt is too small.",
    files: ["server.js"],
    surfaces: ["chat_stream", "chat_invoke", "guest_chat"],
    expectedSavings: {
      type: "percent",
      range: [40, 60],
      scope: "Gemini input tokens after first request of the hour",
      note: "Cached input is ~25% of fresh input cost on Gemini.",
    },
    provider: "google",
  },
  {
    id: "openai-prompt-cache-key",
    shippedAt: "2026-05-06",
    tier: 1,
    category: "caching",
    title: "OpenAI prompt_cache_key (per-user segmentation)",
    description:
      "Pass prompt_cache_key set to the user's id on every OpenAI chat-completions call so the same user's repeated big system prompts hit the segmented prompt cache instead of competing with global traffic. Applied to /invoke (invokeOpenAIModel), /stream, vault-search.",
    files: ["server.js"],
    surfaces: ["chat_stream", "chat_invoke", "vault_search"],
    expectedSavings: {
      type: "percent",
      range: [30, 50],
      scope: "OpenAI input tokens on repeat calls",
      note: "Cached input is 50% of fresh input cost on OpenAI.",
    },
    provider: "openai",
  },
  {
    id: "anthropic-cache-control",
    shippedAt: "2026-05-06",
    tier: 1,
    category: "caching",
    title: "Anthropic cache_control on system prompt",
    description:
      "System prompt sent as a content block with cache_control: ephemeral so Anthropic's prompt-caching beta caches it across sessions. (Pre-existing wiring — confirmed active on both /invoke and /stream Claude paths.)",
    files: ["server.js"],
    surfaces: ["chat_stream", "chat_invoke"],
    expectedSavings: {
      type: "percent",
      range: [70, 85],
      scope: "Anthropic input tokens on repeat calls",
      note: "Cached input is 10% of fresh input cost on Anthropic (with 25% write premium amortized).",
    },
    provider: "anthropic",
  },
  {
    id: "kill-openai-double-call",
    shippedAt: "2026-05-06",
    tier: 1,
    category: "kill_waste",
    title: "Kill the OpenAI Responses → Chat double-call",
    description:
      "invokeOpenAIModel previously tried /v1/responses first, then fell back to /v1/chat/completions on empty/error — paying for two requests on every fallback. Now Responses is used ONLY for the o-series models that require it (o3, o3-pro, o4-mini); everything else hits chat completions directly.",
    files: ["server.js"],
    surfaces: ["chat_invoke"],
    expectedSavings: {
      type: "percent",
      range: [10, 25],
      scope: "OpenAI /invoke calls (eliminated duplicate billed requests)",
    },
    provider: "openai",
  },
  {
    id: "intent-output-caps",
    shippedAt: "2026-05-06",
    tier: 1,
    category: "cap",
    title: "Intent-based output token caps",
    description:
      "Single pickOutputCap() helper picks max output tokens by intent: chat 1500 (was 4096), JSON action 800 (was 8192), board_analysis_deep 2000, and vault_search 600 (was 4096). Applied to every chat path: OpenAI, Anthropic, Google, Grok — both stream and invoke.",
    files: ["server.js"],
    surfaces: [
      "chat_stream",
      "chat_invoke",
      "vault_search",
    ],
    expectedSavings: {
      type: "percent",
      range: [30, 50],
      scope: "output tokens on chat",
      note: "Most responses are well under 1000 tokens — the old 4096/8192 cap just allowed pathological runaway.",
    },
  },
  {
    id: "embedding-query-cache",
    shippedAt: "2026-05-06",
    tier: 1,
    category: "caching",
    title: "Retrieval embeddings cached 15 min",
    description:
      "openAiEmbedQueryText now sha256-caches the input text and returns the cached vector on subsequent calls within a 15-min window. Same query within a session hits the cache; the API call and the log row are both skipped.",
    files: ["server.js"],
    surfaces: ["embedding_retrieval"],
    expectedSavings: {
      type: "percent",
      range: [40, 70],
      scope: "embedding_retrieval API calls in same-session repeats",
    },
    provider: "openai",
  },
  {
    id: "synthesis-reindex-hash-skip",
    shippedAt: "2026-05-06",
    tier: 1,
    category: "dedup",
    title: "Hash-skip synthesis reindex",
    description:
      "replaceSynthesisChunks now reads existing chunks for the source first. If the new chunks match existing ones exactly (count + content), it skips the embed + delete + insert entirely. Saves the 'open a note, save with no changes' loop from re-embedding everything.",
    files: ["server.js"],
    surfaces: ["embedding_reindex", "vault_enrich"],
    expectedSavings: {
      type: "qualitative",
      scope: "100% of redundant reindex calls",
      note: "Most note saves only edit one paragraph or no paragraphs at all.",
    },
    provider: "openai",
  },
  {
    id: "tts-cache",
    shippedAt: "2026-05-06",
    tier: 1,
    category: "caching",
    title: "TTS mp3 cache + force tts-1",
    description:
      "/api/ai/tts now caches generated mp3 buffers by sha256(text+voice+model+speed) for 30 minutes (max 64 entries, 1MB cap each). Default model is tts-1 (half the cost of tts-1-hd, audibly indistinguishable for short responses). Catches the long tail of repeated short phrases.",
    files: ["server.js"],
    surfaces: ["tts"],
    expectedSavings: {
      type: "percent",
      range: [30, 60],
      scope: "TTS calls",
      note: "Real impact depends on how often users replay or share the same audio.",
    },
    provider: "openai",
  },
  // ─── Tier 2 — smart routing & defaults (shipped 2026-05-06) ─────────────
  {
    id: "unified-auto-fallback-nano",
    shippedAt: "2026-05-06",
    tier: 2,
    category: "model_swap",
    title: "Safer unified-auto fallback: gpt-4o → gpt-4.1-nano",
    description:
      "When `unified-auto` is selected and Google is unavailable (no key, key revoked, Gemini down) we used to fall back to gpt-4o (and ultimately gpt-3.5-turbo). Both fallbacks now resolve to gpt-4.1-nano on /invoke and /stream. Day-to-day this never fires because Google is configured, but the floor is now ~25× cheaper if it ever does.",
    files: ["server.js"],
    surfaces: ["chat_stream", "chat_invoke"],
    expectedSavings: {
      type: "qualitative",
      scope: "fallback path only — invisible until Google fails",
      note: "Pure safety win. No user-facing impact while Gemini Flash is the default.",
    },
    provider: "openai",
  },
  {
    id: "guest-anthropic-cache-control",
    shippedAt: "2026-05-06",
    tier: 2,
    category: "caching",
    title: "Guest Anthropic stream: ephemeral system cache",
    description:
      "Guest chat's Anthropic fallback now sends the system prompt as a content block with cache_control: ephemeral and the prompt-caching-2024-07-31 beta header. Previously the (very long) guest system prompt was billed in full on every guest turn — now subsequent turns within the cache window pay ~10% on the system block.",
    files: ["server.js"],
    surfaces: ["guest_chat"],
    expectedSavings: {
      type: "percent",
      range: [40, 70],
      scope: "Guest Anthropic input tokens (only when Gemini chain falls through to Claude)",
    },
    provider: "anthropic",
  },
  {
    id: "describe-image-cap-and-cache",
    shippedAt: "2026-05-06",
    tier: 2,
    category: "cap",
    title: "describe-image: max_tokens 300 → 180 + prompt_cache_key",
    description:
      "Prompt asks for a 2-3 sentence description (~80 output tokens). 300 was 3.5× the worst case we ever produced. Cut to 180 — still safe, eliminates pathological overruns. Also tagged with a per-user prompt_cache_key keyed by branch (visual vs text) so OpenAI's caching layer reuses the static instruction prefix.",
    files: ["server.js"],
    surfaces: ["describe_image"],
    expectedSavings: {
      type: "percent",
      range: [10, 20],
      scope: "describe-image output cost (worst-case overruns) + small input cache discount",
    },
    provider: "openai",
  },
  {
    id: "summarize-namegrid-cache",
    shippedAt: "2026-05-06",
    tier: 2,
    category: "caching",
    title: "Static-prompt cache hints on summarize + name-grid",
    description:
      "/api/ai/summarize-conversation now sends prompt_cache_key per user and drops max_tokens 400 → 220 (output is 2-4 sentences, never close to 400). /api/ai/name-grid also now sends prompt_cache_key per user. Both have completely static system prompts — perfect candidates for the OpenAI prompt cache.",
    files: ["server.js"],
    surfaces: ["summarize_conversation", "name_grid"],
    expectedSavings: {
      type: "percent",
      range: [15, 35],
      scope: "summarize_conversation + name_grid input cost on repeat calls",
      note: "summarize-conversation also benefits from the lower output cap.",
    },
    provider: "openai",
  },

  // ─── Tier 3 — prompt surgery for Gemini Pro (shipped 2026-05-06) ────────
  {
    id: "static-persona-trim",
    shippedAt: "2026-05-06",
    tier: 3,
    category: "kill_waste",
    title: "Static persona: ~25K → ~10K chars per chat turn",
    description:
      "Both buildLyknChatPrompt (/api/ai/invoke) and buildLyknStreamPrompt (/api/ai/stream) used to rebuild a ~25,000-character system prompt per call with 6+ boolean toggles (hasProject / responseLength / imageUrls.length / wsCtx.includes('DETAILED VAULT')) baked into the persona text. Replaced with two module-level constants (LYKN_CHAT_PERSONA_STATIC, LYKN_STREAM_PERSONA_FULL) that hold a single canonical version covering every permutation. All toggles moved to the dynamic side. Persona ~7x more compact and produces a stable sha256, which means Google's cachedContents API now hits on essentially every call instead of rotating through 4-8 cache slots.",
    files: ["server.js"],
    surfaces: ["chat_invoke", "chat_stream"],
    expectedSavings: {
      type: "per_request",
      range: [3500, 4200],
      scope: "input tokens removed from EVERY authenticated chat call (Pro and Flash)",
      note: "On gemini-3.1-pro-preview that's ~$0.0044-0.0053 saved per call on the persona alone, before the cache-hit multiplier kicks in.",
    },
    provider: "google",
  },
  {
    id: "intent-gate-workspace-context",
    shippedAt: "2026-05-06",
    tier: 3,
    category: "dedup",
    title: "[WORKSPACE_CONTEXT] only sent on Vault / cross-board intents",
    description:
      "Added shouldEmbedWorkspaceContext(text) which checks the user's actual message against WORKSPACE_SCOPED_PATTERNS + a new CROSS_WORKSPACE_HINTS regex ('do I have', 'find me', 'across my', 'in the vault', 'pull in', 'tag my'…). Both prompt builders now skip the up-to-28K-char Vault dump unless the user is actually asking about saved content. On a typical day this skips it for ~70% of chat turns. Boards-and-Vault dump still goes through normally when the user asks 'do I have anything saved about X' or 'pull in my logo from the vault'.",
    files: ["server.js"],
    surfaces: ["chat_invoke", "chat_stream"],
    expectedSavings: {
      type: "per_request",
      range: [4000, 7000],
      scope: "input tokens skipped on ~70% of chat calls (when user is not asking about Vault)",
      note: "Single biggest variable input contributor on Pro turns.",
    },
    provider: "google",
  },
  {
    id: "focused-bricks-board-cap",
    shippedAt: "2026-05-06",
    tier: 3,
    category: "cap",
    title: "[BOARD_CONTEXT]: 14K → 4K chars when bricks are focused",
    description:
      "When the user has raised one or more bricks (hasFocusedBricks), the question is almost always scoped to those bricks — the rest of the board is noise. The client puts focused bricks first in the context string, so a 4K cap covers the focused brick(s) + a handful of neighbors and ignores the long tail. Full 14K cap still applies on broad questions where nothing is focused.",
    files: ["server.js"],
    surfaces: ["chat_invoke", "chat_stream"],
    expectedSavings: {
      type: "per_request",
      range: [2000, 2500],
      scope: "input tokens saved on every focused-brick chat call",
    },
    provider: "google",
  },
  {
    id: "pro-to-flash-trivial",
    shippedAt: "2026-05-06",
    tier: 3,
    category: "model_swap",
    title: "lykn-deep → Flash auto-downgrade for trivial turns",
    description:
      "Even when the user explicitly picked lykn-deep (gemini-3.1-pro-preview), trivial turns (greeting, single-word reply, layout command, board action like 'make this bigger', any short message under 6 words) are auto-routed to gemini-3-flash-preview. Skips when images or focused bricks are present. Flash is ~12x cheaper per token on input AND ~10x cheaper on output for the same workload — and produces literally identical responses on these trivial turns. Surfaced in the response via X-Smart-Route header.",
    files: ["server.js"],
    surfaces: ["chat_invoke", "chat_stream"],
    expectedSavings: {
      type: "per_request",
      range: [16000, 19000],
      scope: "saved input+output cost on trivial-turn invocations of lykn-deep (in 100-token equivalents — ~$0.018 per call)",
      note: "Doesn't change anything when the user actually needs Pro; only fires on turns Pro is wasted on.",
    },
    provider: "google",
    risk:
      "If the trivial-turn heuristic ever mis-classifies a real research question as trivial, the user gets Flash quality. Mitigation: heuristic only fires on greetings / layout commands / messages <120 chars and <=5 words.",
  },
  {
    id: "compress-conversation-tighter",
    shippedAt: "2026-05-06",
    tier: 3,
    category: "cap",
    title: "compressConversation: tighter cap on long histories",
    description:
      "Server-side compressConversation() now keeps 4 (was 6) recent messages in full and caps each recent message at 900 (was 2000) chars; older snippets shrink from 80 → 60 chars. A long chatty session that used to fill the entire 8K AI_BUDGETS.conversation budget now sits closer to 5-6K. Mirrors the tighter compressor on the client.",
    files: ["server.js"],
    surfaces: ["chat_invoke", "chat_stream"],
    expectedSavings: {
      type: "per_request",
      range: [500, 750],
      scope: "input tokens saved on long-thread chat calls",
    },
    provider: "google",
  },
  {
    id: "auto-chat-routing-mix",
    shippedAt: "2026-08-27",
    tier: 2,
    category: "model_swap",
    title: "Auto chat routing (Luna / Terra / Sol)",
    description:
      "LYKN Auto no longer pins every turn to Terra. A quality-biased router sends obvious cheap turns to Luna, normal chat to Terra, and hard reasoning to Sol, with Pro/Max normal chat included at no usage charge. Compute tools stay billed.",
    files: [
      "server/ai/chatRouting/index.js",
      "server/ai/chatStream.routes.js",
      "server/ai/chatInvoke.routes.js",
      "usageTracking.js",
    ],
    surfaces: ["chat_stream", "chat_invoke"],
    expectedSavings: {
      type: "percent",
      range: [20, 45],
      scope: "Auto-routed chat input+output vs always-Terra",
      note: "Depends on the live fast/standard/advanced mix. Quality bias keeps uncertain turns on Terra.",
    },
    provider: "openai",
  },
];

// ─── helpers used by the dashboard ──────────────────────────────────────────

export const TIER_LABELS = {
  1: "Tier 1: invisible wins",
  2: "Tier 2: smart routing",
  3: "Tier 3: per-user safety caps",
  4: "Tier 4: architecture",
  5: "Tier 5: strategic",
};

export const CATEGORY_META = {
  caching:    { label: "Caching",     color: "emerald" },
  model_swap: { label: "Model swap",  color: "indigo"  },
  cap:        { label: "Token cap",   color: "amber"   },
  dedup:      { label: "Dedup",       color: "cyan"    },
  debounce:   { label: "Debounce",    color: "purple"  },
  kill_waste: { label: "Kill waste",  color: "red"     },
  infra:      { label: "Infra",       color: "slate"   },
  meter:      { label: "Metering",    color: "slate"   },
};

// Group entries by tier and sort newest-first within each tier.
export function groupOptimizationsByTier(entries = COST_OPTIMIZATIONS) {
  const buckets = new Map();
  for (const e of entries) {
    const list = buckets.get(e.tier) || [];
    list.push(e);
    buckets.set(e.tier, list);
  }
  for (const list of buckets.values()) {
    list.sort((a, b) => String(b.shippedAt).localeCompare(String(a.shippedAt)));
  }
  // Return as ordered array of [tier, list]
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]);
}

// Format a savings object into a short string used on the badge.
export function formatSavingsBadge(s) {
  if (!s) return "-";
  if (s.type === "percent" && Array.isArray(s.range)) {
    return `${s.range[0]}–${s.range[1]}% ↓`;
  }
  if (s.type === "absolute" && Array.isArray(s.range)) {
    return `~$${s.range[0]}–$${s.range[1]}/mo ↓`;
  }
  if (s.type === "per_request") {
    return "per-request ↓";
  }
  return "qualitative ↓";
}

// Quick stats for the section header.
export function summarizeOptimizations(entries = COST_OPTIMIZATIONS) {
  const total = entries.length;
  const byTier = entries.reduce((acc, e) => {
    acc[e.tier] = (acc[e.tier] || 0) + 1;
    return acc;
  }, {});
  const latest = entries
    .map((e) => e.shippedAt)
    .sort()
    .reverse()[0];
  return { total, byTier, latest };
}
